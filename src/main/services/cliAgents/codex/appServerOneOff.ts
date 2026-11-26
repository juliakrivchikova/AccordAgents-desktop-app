import { spawnCommand } from "../../command";
import { errorText } from "../runs/outputText";
import { asRecord, stringField } from "../runs/records";
import type { CodexAppServerPendingRequest } from "../types";
import { codexAppServerMessageKind } from "./appServerErrors";

/** A short-lived `codex app-server` asked a few questions: its model list,
 *  the User's threads. Not a member's process: it runs no turn. */
export interface CodexAppServerOneOff {
  request: (method: string, params: unknown) => Promise<unknown>;
  /** What the server wrote to stderr, as ": …" for the end of an error (empty
   *  when it wrote nothing). */
  stderrNote: () => string;
}

export interface CodexAppServerOneOffLaunch {
  executable: string;
  env: NodeJS.ProcessEnv;
  /** Names it in its errors ("codex app-server model probe timed out"). */
  purpose: string;
  /** For the whole job, from the start of the process. */
  timeoutMs: number;
}

/** Starts `codex app-server`, initializes it, runs `job` with it and stops it,
 *  whatever the job ends with. */
export async function withCodexAppServerOneOff<T>(
  launch: CodexAppServerOneOffLaunch,
  job: (server: CodexAppServerOneOff) => Promise<T>
): Promise<T> {
  const child = spawnCommand(launch.executable, ["app-server", "--listen", "stdio://"], {
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let nextRequestId = 1;
  let stdoutBuffer = "";
  let stderr = "";
  let closed = false;
  const pendingRequests = new Map<number, CodexAppServerPendingRequest>();
  const stderrNote = (): string => stderr.trim() ? `: ${errorText(stderr)}` : "";

  const cleanup = (cause?: Error): void => {
    if (closed) {
      return;
    }
    closed = true;
    const error = cause ?? new Error(`codex app-server ${launch.purpose} ended before receiving a response${stderrNote()}`);
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  };

  const request = (method: string, params: unknown): Promise<unknown> => {
    if (closed || child.exitCode !== null || child.killed) {
      return Promise.reject(new Error("codex app-server process is not running"));
    }
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      pendingRequests.set(id, { method, resolve, reject });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (error) {
          pendingRequests.delete(id);
          reject(error);
        }
      });
    });
  };

  const writeServerMessage = (message: Record<string, unknown>): Promise<void> => new Promise<void>((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
  });

  const handleResponse = (record: Record<string, unknown>): void => {
    const id = typeof record.id === "number" ? record.id : undefined;
    if (id === undefined) {
      return;
    }
    const pending = pendingRequests.get(id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(id);
    const error = asRecord(record.error);
    if (error) {
      pending.reject(new Error(stringField(error, "message") ?? `${pending.method} failed`));
      return;
    }
    pending.resolve(record.result);
  };

  // It asks the client back only for the time and, against its contract, for
  // ChatGPT tokens: never given, Codex signs in on its own.
  const answerServerRequest = (record: Record<string, unknown>): void => {
    const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : undefined;
    const method = stringField(record, "method");
    if (id === undefined || !method) {
      return;
    }
    if (method === "currentTime/read") {
      void writeServerMessage({ id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } }).catch(cleanup);
      return;
    }
    const message = method === "account/chatgptAuthTokens/refresh"
      ? "AccordAgents uses Codex CLI-managed authentication here and never supplies external ChatGPT tokens. A refresh callback indicates an unsupported authentication contract."
      : `AccordAgents does not support the Codex client request ${method} here.`;
    void writeServerMessage({ id, error: { code: -32601, message } }).catch(cleanup);
  };

  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let lineBreak = stdoutBuffer.indexOf("\n");
    while (lineBreak >= 0) {
      const line = stdoutBuffer.slice(0, lineBreak).trim();
      stdoutBuffer = stdoutBuffer.slice(lineBreak + 1);
      if (line) {
        try {
          const record = asRecord(JSON.parse(line) as unknown);
          if (record) {
            const kind = codexAppServerMessageKind(record);
            if (kind === "server-request") {
              answerServerRequest(record);
            } else if (kind === "response") {
              handleResponse(record);
            }
          }
        } catch {
          // Ignore non-JSON status output.
        }
      }
      lineBreak = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("exit", (code) => {
    cleanup(new Error(`codex app-server ${launch.purpose} exited with code ${code ?? "unknown"}${stderrNote()}`));
  });
  // A launch that fails (the file went away) ends the job instead of the app.
  child.once("error", (error) => cleanup(error));

  const timeout = setTimeout(() => {
    cleanup(new Error(`codex app-server ${launch.purpose} timed out${stderrNote()}`));
  }, launch.timeoutMs);
  try {
    await request("initialize", {
      clientInfo: {
        name: "accordagents",
        title: "AccordAgents",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    });
    return await job({ request, stderrNote });
  } finally {
    clearTimeout(timeout);
    cleanup();
  }
}
