import http from "node:http";
import type { AddressInfo } from "node:net";
import { APP_MCP_WAITING_PROGRESS_MS } from "./constants";
import { initializeResult, isWaitingToolCall, readJsonBody, rpcError, rpcResult, toolsForActor, writeHttp, writeJson } from "./protocol";
import type { AppMcpActor, JsonRpcRequest, JsonRpcResponse } from "./types";
import type { AppMcpModules } from "./modules";
import type { AppMcpDependencies } from "./dependencies";

/** The local server members' CLIs reach the app tools through. */
export class McpServer {
  private server?: http.Server;
  url?: string;
  /** How often a waiting tool call reports progress (tests shorten it). */
  waitingProgressMs = APP_MCP_WAITING_PROGRESS_MS;
  /** Calls that wait for the User, by their member's grant and request id:
   *  a `notifications/cancelled` for one ends its wait. */
  private readonly waitingCalls = new WeakMap<AppMcpActor, Map<string, AbortController>>();

  constructor(
    private readonly mcp: Pick<AppMcpModules, "accessTokens" | "clientStates" | "toolCalls" | "toolHandlers">,
    private readonly deps: Pick<AppMcpDependencies, "debugLogs">
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.server = http.createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => {
        this.server?.off("error", reject);
        const address = this.server?.address() as AddressInfo | null;
        if (!address) {
          reject(new Error("App MCP server did not expose a listen address."));
          return;
        }
        this.url = `http://127.0.0.1:${address.port}/mcp`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.url = undefined;
    this.mcp.accessTokens.tokens.clear();
    this.mcp.accessTokens.scriptTokens.clear();
    this.mcp.clientStates.states.clear();
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const pathname = request.url?.split("?")[0];
    if (request.method === "POST" && pathname === "/script-api/messages") {
      await this.handleScriptApiRequest(request, response, "messages");
      return;
    }
    if (request.method !== "POST" || pathname !== "/mcp") {
      writeHttp(response, 404, "text/plain", "Not found");
      return;
    }

    const actor = this.mcp.accessTokens.actorFromRequest(request);
    if (!actor) {
      writeHttp(response, 401, "application/json", JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let payload: unknown;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, rpcError(null, -32700, message));
      return;
    }

    if (isWaitingToolCall(payload) && /text\/event-stream/i.test(String(request.headers.accept ?? ""))) {
      await this.streamWaitingToolCall(actor, payload as JsonRpcRequest, response);
      return;
    }

    const requests = Array.isArray(payload) ? payload : [payload];
    const results: JsonRpcResponse[] = [];
    for (const item of requests) {
      const result = await this.handleRpcRequest(actor, item);
      if (result) {
        results.push(result);
      }
    }
    if (results.length === 0) {
      response.writeHead(202);
      response.end();
      return;
    }
    writeJson(response, Array.isArray(payload) ? results : results[0]);
  }

  private async handleRpcRequest(actor: AppMcpActor, raw: unknown): Promise<JsonRpcResponse | undefined> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return rpcError(null, -32600, "Invalid JSON-RPC request.");
    }
    const request = raw as JsonRpcRequest;
    const id = request.id;
    const method = typeof request.method === "string" ? request.method : "";
    const isNotification = id === undefined;

    try {
      if (method === "initialize") {
        this.mcp.clientStates.markClientInitialized(actor);
        return isNotification ? undefined : rpcResult(id, initializeResult());
      }
      if (method === "notifications/initialized") {
        return undefined;
      }
      if (method === "notifications/cancelled") {
        // The CLI gave up on a call that waits for the User without closing
        // its stream: the wait ends as if it had (its card is expired).
        const params = request.params && typeof request.params === "object" ? request.params as { requestId?: unknown } : {};
        if (typeof params.requestId === "string" || typeof params.requestId === "number") {
          this.waitingCalls.get(actor)?.get(String(params.requestId))?.abort();
        }
        return undefined;
      }
      if (method === "tools/list") {
        const tools = toolsForActor(actor);
        this.mcp.clientStates.markClientToolsListed(actor, tools);
        return isNotification ? undefined : rpcResult(id, { tools });
      }
      if (method === "tools/call") {
        return isNotification ? undefined : rpcResult(id, await this.mcp.toolCalls.callTool(actor, request.params));
      }
      return isNotification ? undefined : rpcError(id, -32601, `Unsupported MCP method: ${method || "unknown"}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (method === "initialize" || method === "tools/list") {
        this.mcp.clientStates.markClientError(actor, message);
      }
      return isNotification ? undefined : rpcError(id, -32603, message);
    }
  }

  private async handleScriptApiRequest(request: http.IncomingMessage, response: http.ServerResponse, route: "messages"): Promise<void> {
    const context = this.mcp.accessTokens.scriptContextFromRequest(request);
    if (!context) {
      writeHttp(response, 401, "application/json", JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }
    const handler = this.mcp.toolHandlers.scriptApiHandler;
    if (!handler) {
      writeHttp(response, 503, "application/json", JSON.stringify({ ok: false, error: "Scheduled scripts are not available on this host." }));
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      writeHttp(response, 400, "application/json", JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    try {
      const result = await handler(context, route, body);
      writeJson(response, result);
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
      const message = error instanceof Error ? error.message : String(error);
      void this.deps.debugLogs?.write("app-mcp.script-api.error", { scriptId: context.scriptId, runId: context.runId, status, message }).catch(() => undefined);
      writeHttp(response, status, "application/json", JSON.stringify({ ok: false, error: message }));
    }
  }

  /** Answers a waiting tool call as an event stream (MCP Streamable HTTP):
   *  progress while the User decides, then the result. When the CLI gives up
   *  on the call (the connection closes first) the wait is aborted, so its
   *  card does not stay open for an answer nobody reads. */
  private async streamWaitingToolCall(actor: AppMcpActor, request: JsonRpcRequest, response: http.ServerResponse): Promise<void> {
    const abandoned = new AbortController();
    let finished = false;
    response.on("close", () => {
      if (!finished) abandoned.abort();
    });
    const callKey = String(request.id);
    const calls = this.waitingCalls.get(actor) ?? new Map<string, AbortController>();
    calls.set(callKey, abandoned);
    this.waitingCalls.set(actor, calls);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.flushHeaders();
    const send = (message: unknown): void => {
      if (!response.writableEnded && !response.destroyed) response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    };
    const meta = request.params && typeof request.params === "object" ? (request.params as { _meta?: { progressToken?: unknown } })._meta : undefined;
    const progressToken = typeof meta?.progressToken === "string" || typeof meta?.progressToken === "number" ? meta.progressToken : undefined;
    let progress = 0;
    const ticker = setInterval(() => {
      progress++;
      if (progressToken !== undefined) {
        send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress, message: "Waiting for the User." } });
      } else if (!response.writableEnded && !response.destroyed) {
        response.write(": waiting\n\n");
      }
    }, this.waitingProgressMs);
    ticker.unref();
    let answer: JsonRpcResponse;
    try {
      answer = rpcResult(request.id, await this.mcp.toolCalls.callTool(actor, request.params, abandoned.signal));
    } catch (error) {
      answer = rpcError(request.id, -32603, error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(ticker);
      if (calls.get(callKey) === abandoned) calls.delete(callKey);
    }
    finished = true;
    send(answer);
    if (!response.writableEnded) response.end();
  }
}
