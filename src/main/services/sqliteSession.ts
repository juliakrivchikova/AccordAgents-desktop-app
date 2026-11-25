import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CommandError, commandEnvironment, spawnCommand } from "./command";

const OUTPUT_KEPT_FOR_ERRORS = 8192;
const QUOTE = 0x22, COMMA = 0x2c, OPEN_ARRAY = 0x5b, BACKSLASH = 0x5c, CLOSE_ARRAY = 0x5d, OPEN_ROW = 0x7b, CLOSE_ROW = 0x7d;

/** Reads what one operation prints, piece by piece. */
interface ResponseReader<T> {
  write(text: string): void;
  finish(): T;
}

/** Reuse the CLI process, not its database connection. Each operation opens a
 * fresh connection and closes it before completion, preserving the old
 * transaction rollback, temporary-table and PRAGMA boundaries without a spawn
 * for every small event query. SQL and results always travel through pipes. */
export class SqliteSession {
  private child?: ChildProcessWithoutNullStreams;
  private queue: Promise<void> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;

  constructor(private readonly executable: string, private readonly dbPath: string, private readonly busyTimeoutMs: number) {}

  /** The operation's output as text. */
  run(sql: string, timeoutMs: number): Promise<string> {
    const parts: string[] = [];
    return this.enqueue(sql, "list", timeoutMs, { write: (text) => { parts.push(text); }, finish: () => parts.join("") });
  }

  /** The rows of the operation's one result set, each parsed as it arrives:
   *  many chats read at once can be longer than the longest string V8 allows
   *  (about 512 MB), so the whole response is never one string. */
  rows<T>(sql: string, timeoutMs: number): Promise<T[]> {
    return this.enqueue(sql, "json", timeoutMs, new JsonRowsReader<T>());
  }

  private enqueue<T>(sql: string, mode: "json" | "list", timeoutMs: number, reader: ResponseReader<T>): Promise<T> {
    const result = this.queue.then(() => this.perform(sql, mode, timeoutMs, reader));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private perform<T>(sql: string, mode: "json" | "list", timeoutMs: number, reader: ResponseReader<T>): Promise<T> {
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
    return new Promise<T>((resolve, reject) => {
      // The end of what was printed, not read yet: it may be the closing marker.
      let unread = "", outputLength = 0, lastOutput = "", stderr = "";
      let readFailure: unknown;
      // A response that cannot be read is drained to its closing marker: the
      // process stays in step for the next operation. Nothing may throw out of
      // the stream's callback, where this operation would never settle and
      // hold every later one.
      const read = (text: string): void => {
        if (readFailure !== undefined) return;
        try {
          reader.write(text);
        } catch (error) {
          readFailure = error;
        }
      };
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
        outputLength += chunk.length;
        lastOutput = (lastOutput + chunk).slice(-OUTPUT_KEPT_FOR_ERRORS);
        unread += chunk;
        // Only the suffix can contain the closing marker. Scanning the whole
        // accumulated response on each chunk made large history reads quadratic.
        const suffix = unread.slice(-(marker.length + 4));
        const matched = suffix.match(endMarker);
        if (!matched) {
          if (unread.length > suffix.length) read(unread.slice(0, -suffix.length));
          unread = suffix;
          return;
        }
        if (failure || settled) return;
        settled = true;
        cleanup();
        this.idle = setTimeout(() => {
          if (this.child !== child) return;
          this.child = undefined;
          child.stdin.end();
        }, 1000);
        read(unread.slice(0, unread.length - matched[0].length + matched[1].length));
        try {
          if (readFailure !== undefined) throw readFailure;
          resolve(reader.finish());
        } catch (error) {
          reject(new Error(`SQLite operation finished, but its response (${outputLength} characters) could not be read: ${
            error instanceof Error ? error.message : String(error)}`, { cause: error }));
        }
      };
      const onErrorData = (chunk: string): void => { stderr = (stderr + chunk).slice(-OUTPUT_KEPT_FOR_ERRORS); };
      const onError = (error: Error): void => { failure ??= error; };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.child === child) this.child = undefined;
        if (settled) return;
        settled = true;
        cleanup();
        reject(new CommandError(failure?.message ?? `SQLite operation failed (${signal ?? code ?? "closed"}): ${stderr.trim() || "process closed before confirming completion"}`, {
          command: this.executable, args: ["-batch", "-bail", ":memory:"], stdout: lastOutput,
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

/** One JSON array of flat objects (the sqlite shell's json mode), read in
 *  pieces that may be cut anywhere, also inside a string or an escape. */
export class JsonRowsReader<T> implements ResponseReader<T[]> {
  private readonly rows: T[] = [];
  private place: "before" | "between" | "row" | "string" | "after" = "before";
  /** The row being read, while it spans pieces. */
  private row: string[] = [];
  /** The last piece ended inside a string on a backslash that escapes the next character. */
  private escaping = false;

  write(text: string): void {
    let rowStart = 0;
    for (let index = 0; index < text.length;) {
      if (this.place === "string") {
        // Payloads are long strings: go from quote to quote, not by character.
        const quote = text.indexOf("\"", index);
        const end = quote < 0 ? text.length : quote;
        let slashes = 0;
        while (end - slashes > index && text.charCodeAt(end - slashes - 1) === BACKSLASH) slashes += 1;
        const carried = this.escaping && end - slashes === index ? 1 : 0;
        const escapes = (slashes + carried) % 2 === 1;
        this.escaping = quote < 0 && escapes;
        if (quote >= 0 && !escapes) this.place = "row";
        index = end + 1;
        continue;
      }
      const code = text.charCodeAt(index);
      index += 1;
      if (this.place === "row") {
        if (code === QUOTE) {
          this.place = "string";
        } else if (code === CLOSE_ROW) {
          this.row.push(text.slice(rowStart, index));
          this.rows.push(JSON.parse(this.row.length === 1 ? this.row[0] : this.row.join("")) as T);
          this.row = [];
          this.place = "between";
        }
      } else if (this.place === "between" && code === OPEN_ROW) {
        rowStart = index - 1;
        this.place = "row";
      } else if (this.place === "between" && code === CLOSE_ARRAY) {
        this.place = "after";
      } else if (this.place === "before" && code === OPEN_ARRAY) {
        this.place = "between";
      } else if (!isJsonSpace(code) && !(this.place === "between" && code === COMMA)) {
        throw new Error(`Unexpected ${JSON.stringify(text[index - 1])} ${this.place === "after" ? "after" : "in"} the result set.`);
      }
    }
    if (this.place === "row" || this.place === "string") this.row.push(text.slice(rowStart));
  }

  finish(): T[] {
    if (this.place !== "before" && this.place !== "after") throw new Error("The result set is cut short.");
    return this.rows;
  }
}

function isJsonSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}
