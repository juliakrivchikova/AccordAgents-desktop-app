import { randomUUID, createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import type { CloudRunWorkerSetupProgress } from "../../shared/types";
import type { CloudRunSshExecRequest } from "./cloudRunDoctor";
import { shellQuotePosix } from "./cloudRunWorkers";

type Progress = (value: CloudRunWorkerSetupProgress) => void | Promise<unknown>;
interface PendingLogin {
  input: PassThrough;
  abort: AbortController;
  state?: string;
  submittedHash?: string;
}

/** The native CLI owns OAuth and credential storage. This only transports its
 * URL and the user's one-time reply, scoped to one live process and profile. */
export class CloudRunClaudeAuth {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly workers = new Set<string>();

  constructor(private readonly exec: (request: CloudRunSshExecRequest) => Promise<string>,
    private readonly openExternal?: (url: string) => void) {}

  isActive(requestId: string): boolean { return this.pending.has(requestId); }

  submit(requestId: string, value: string): void {
    const login = this.pending.get(requestId);
    if (!login || login.abort.signal.aborted) throw new Error("This sign-in expired or was interrupted. Start sign-in again.");
    const code = typeof value === "string" ? value.trim() : "";
    if (!/^[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/.test(code) || code.length > 4096) {
      throw new Error("Paste the complete sign-in code from the Claude page, including the part after #.");
    }
    if (!login.state || code.split("#")[1] !== login.state) throw new Error("This code belongs to another sign-in. Use the page opened for this request.");
    const hash = createHash("sha256").update(code).digest("hex");
    if (login.submittedHash === hash) return;
    if (login.submittedHash) throw new Error("Claude is already checking the submitted code. Wait for the result.");
    login.submittedHash = hash;
    login.input.write(`${code}\n`);
  }

  cancel(requestId: string): void { this.pending.get(requestId)?.abort.abort(); }

  async run(worker: CloudRunSshExecRequest["worker"], progress: Progress): Promise<void> {
    const key = JSON.stringify([worker.host, worker.port, worker.user, worker.profileHome]);
    if (this.workers.has(key)) throw new Error("Claude sign-in is already running for this environment. Complete or cancel it first.");
    const id = randomUUID();
    const login: PendingLogin = { input: new PassThrough(), abort: new AbortController() };
    this.workers.add(key);
    this.pending.set(id, login);
    let output = "";
    let opened = false;
    let unsupportedPage = false;
    let published: Promise<unknown> = Promise.resolve();
    let publishError: unknown;
    try {
      await progress({ stage: "claude-auth", message: "Starting Claude sign-in…" });
      await this.exec({ worker, command: claudeAuthCommand(worker.claudePath || "claude"),
        timeoutMs: 5 * 60_000, retryAttempts: 1, inputStream: login.input, signal: login.abort.signal,
        onStdout: chunk => {
          // Bound output and wait for a complete URL (chunks may split state).
          output = (output + chunk).slice(-32_768);
          if (opened) return;
          const visible = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
          const urls = [...visible.matchAll(/https:\/\/[^\s\u001b]+(?=[\s\u001b])/g)].flatMap(match => {
            try { return [new URL(match[0])]; } catch { return []; }
          });
          const url = urls.find(value => /\/(?:cai\/)?oauth\/authorize$/.test(value.pathname));
          if (!url) return;
          if (!["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"].includes(url.hostname)
            || url.username || url.password || (url.port && url.port !== "443") || !url.searchParams.get("state")) {
            unsupportedPage = true; login.abort.abort();
            return;
          }
          opened = true;
          login.state = url.searchParams.get("state")!;
          published = Promise.resolve().then(() => progress({ stage: "claude-auth",
            message: "Sign in to Claude in your browser, then paste the code here if prompted.",
            authProvider: "claude-code", authUrl: url.href, authRequestId: id })).then(() => {
              // Do not open an authorization page before its interaction is saved and visible.
              if (!login.abort.signal.aborted) { try { this.openExternal?.(url.href); } catch { /* UI can retry opening. */ } }
            }).catch(error => { publishError = error; login.abort.abort(); });
        }
      });
      await published;
      if (publishError) throw publishError;
      if (login.abort.signal.aborted) throw new Error("Claude sign-in was cancelled. Start setup again when ready.");
      await progress({ stage: "claude-auth", message: "Checking Claude sign-in…" });
    } catch {
      // Never forward raw native output: OAuth replies may contain secrets.
      throw new Error(unsupportedPage ? "Claude returned an unsupported sign-in page. Update Claude Code and try again."
        : publishError ? "The app could not save the Claude sign-in step. Start setup again."
        : login.abort.signal.aborted ? "Claude sign-in was cancelled. Start setup again when ready."
        : "Claude sign-in did not complete. Start setup again and use the new sign-in page.");
    } finally {
      await published;
      this.pending.delete(id);
      this.workers.delete(key);
      login.input.destroy();
    }
  }
}

/** EOF on SSH input, cancellation and timeout all terminate the native login;
 * a lost desktop must not leave a live authorization process on the worker. */
export function claudeAuthCommand(executable: string): string {
  const script = `
const { spawn } = require("node:child_process");
const child = spawn(${JSON.stringify(executable)}, ["auth", "login"], {
  stdio: ["pipe", "inherit", "inherit"], detached: true, env: { ...process.env, BROWSER: "true" }
});
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} process.exit(1); }, 1500);
}
process.stdin.pipe(child.stdin);
process.stdin.on("end", stop);
process.stdin.on("error", stop);
child.stdin.on("error", stop);
process.on("SIGTERM", stop); process.on("SIGHUP", stop); process.on("SIGINT", stop);
const timeout = setTimeout(stop, 290000);
child.on("error", () => { clearTimeout(timeout); process.exit(1); });
child.on("exit", code => { clearTimeout(timeout); if (!stopping) process.exit(code ?? 1); });
`;
  return `node -e ${shellQuotePosix(script)} 2>&1`;
}
