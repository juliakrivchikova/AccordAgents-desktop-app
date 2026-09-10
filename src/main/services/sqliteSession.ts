import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CommandError, commandEnvironment, spawnCommand } from "./command";

/** Reuse the CLI process, not its database connection. Each operation opens a
 * fresh connection and closes it before completion, preserving the old
 * transaction rollback, temporary-table and PRAGMA boundaries without a spawn
 * for every small event query. SQL and results always travel through pipes. */
export class SqliteSession {
  private child?: ChildProcessWithoutNullStreams;
  private queue: Promise<void> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;

  constructor(private readonly executable: string, private readonly dbPath: string, private readonly busyTimeoutMs: number) {}

  run(sql: string, mode: "json" | "list", timeoutMs: number): Promise<string> {
    const result = this.queue.then(() => this.perform(sql, mode, timeoutMs));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private perform(sql: string, mode: "json" | "list", timeoutMs: number): Promise<string> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    if (!this.child) {
      const started = spawnCommand(this.executable, ["-batch", "-bail", ":memory:"], { env: commandEnvironment(), stdio: "pipe", windowsHide: true });
      started.stdout.setEncoding("utf8");
      started.stderr.setEncoding("utf8");
      started.stdin.on("error", () => undefined); // Active writes also have the failure handler below.
      started.once("close", () => { if (this.child === started) this.child = undefined; });
      this.child = started;
    }
    const child = this.child;
    const marker = `accord_sqlite_${randomUUID().replaceAll("-", "")}`;
    return new Promise<string>((resolve, reject) => {
      const output: string[] = [];
      let outputLength = 0, tail = "", stderr = "";
      const endMarker = new RegExp(`(^|\\r?\\n)${marker}\\r?\\n$`);
      let failure: Error | undefined;
      let timedOut = false;
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onErrorData);
        child.stdin.off("error", stop);
        child.off("error", onError);
        child.off("close", onClose);
      };
      const stop = (error: Error): void => {
        failure ??= error;
        // Do not retry an operation whose COMMIT may already have happened.
        // Wait for exit before allowing the next operation to acquire a client.
        child.kill("SIGKILL");
      };
      const onData = (chunk: string): void => {
        output.push(chunk);
        outputLength += chunk.length;
        // Only the suffix can contain the closing marker. Scanning the whole
        // accumulated response on each chunk made large history reads quadratic.
        tail = (tail + chunk).slice(-(marker.length + 4));
        const matched = tail.match(endMarker);
        if (!matched) return;
        if (failure || settled) return;
        settled = true;
        cleanup();
        this.idle = setTimeout(() => {
          if (this.child !== child) return;
          this.child = undefined;
          child.stdin.end();
        }, 1000);
        resolve(output.join("").slice(0, outputLength - matched[0].length + matched[1].length));
      };
      const onErrorData = (chunk: string): void => { stderr = (stderr + chunk).slice(-8192); };
      const onError = (error: Error): void => { failure ??= error; };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.child === child) this.child = undefined;
        if (settled) return;
        settled = true;
        cleanup();
        reject(new CommandError(failure?.message ?? `SQLite operation failed (${signal ?? code ?? "closed"}): ${stderr.trim() || "process closed before confirming completion"}`, {
          command: this.executable, args: ["-batch", "-bail", ":memory:"], stdout: output.join(""),
          stderr: stderr || failure?.message || "", exitCode: code, timedOut
        }));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop(new Error(`SQLite operation timed out after ${timeoutMs} ms; its outcome must be verified before retry.`));
      }, timeoutMs);
      child.stdout.on("data", onData);
      child.stderr.on("data", onErrorData);
      child.stdin.on("error", stop);
      child.on("error", onError);
      child.on("close", onClose);
      // JSON quoting here is the sqlite shell's double-quoted argument syntax,
      // sent as stdin, never OS shell interpolation or a growing argv value.
      const input = `.open ${JSON.stringify(this.dbPath)}\n.bail on\n.timeout ${this.busyTimeoutMs}\n.mode ${mode}\n.headers off\npragma synchronous=normal;\n${sql}\n;\n.open :memory:\n.print ${marker}\n`;
      child.stdin.write(input, error => { if (error && !settled) stop(error); });
    });
  }
}
