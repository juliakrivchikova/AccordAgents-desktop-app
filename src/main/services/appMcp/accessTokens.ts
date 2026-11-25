import { randomUUID } from "node:crypto";
import http from "node:http";
import { actorFromGrant } from "./protocol";
import type { AppMcpActor, AppMcpConnection, AppMcpTokenGrant, ScriptApiContext } from "./types";
import type { AppMcpModules } from "./modules";

/** The tokens members and scripts call the app with. */
export class AccessTokens {
  readonly tokens = new Map<string, AppMcpActor>();
  /** Script tokens live apart from agent tokens: a script token opens only
   *  the script API, and an agent token never opens it. */
  readonly scriptTokens = new Map<string, ScriptApiContext>();

  constructor(private readonly mcp: Pick<AppMcpModules, "clientStates" | "mcpServer">) {}

  /** Base URL of the script API, e.g. http://127.0.0.1:PORT/script-api. */
  scriptApiUrl(): string | undefined {
    return this.mcp.mcpServer.url ? this.mcp.mcpServer.url.replace(/\/mcp$/, "/script-api") : undefined;
  }

  issueScriptToken(context: ScriptApiContext): string {
    const token = randomUUID();
    this.scriptTokens.set(token, { ...context });
    return token;
  }

  revokeScriptToken(token: string): void {
    this.scriptTokens.delete(token);
  }

  issueToken(grant: AppMcpTokenGrant): AppMcpConnection | undefined {
    if (!this.mcp.mcpServer.url) {
      return undefined;
    }
    const token = randomUUID();
    const actor = actorFromGrant(grant);
    this.tokens.set(token, actor);
    this.mcp.clientStates.ensureClientState(actor);
    return { url: this.mcp.mcpServer.url, token };
  }

  updateToken(token: string, grant: AppMcpTokenGrant): AppMcpConnection | undefined {
    if (!this.mcp.mcpServer.url || !this.tokens.has(token)) {
      return undefined;
    }
    const actor = actorFromGrant(grant);
    this.tokens.set(token, actor);
    this.mcp.clientStates.ensureClientState(actor);
    return { url: this.mcp.mcpServer.url, token };
  }

  scriptContextFromRequest(request: http.IncomingMessage): ScriptApiContext | undefined {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return undefined;
    }
    return this.scriptTokens.get(match[1].trim());
  }

  actorFromRequest(request: http.IncomingMessage): AppMcpActor | undefined {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return undefined;
    }
    return this.tokens.get(match[1].trim());
  }
}
