import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { CapturedPosixProcess } from "./processTermination";
import type { NativeSupervisorStart } from "./nativeProcessSupervisor";

export class NativeProcessUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "NativeProcessUnavailableError"; }
}

interface SupervisorMessage {
  id: string;
  type: "ready" | "closed" | "error" | "data" | "inputAck" | "abandoned";
  provider?: CapturedPosixProcess;
  generation?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  message?: string;
  error?: string;
  stream?: "stdout" | "stderr";
  sequence?: number;
  data?: Buffer;
}

type Send = (message: object, callback?: (error: Error | null) => void) => void;
const supervised = new WeakMap<ChildProcessWithoutNullStreams, NativeProcessHandle>();
const guardians = new Map<string, NativeProcessGuardian>();

/** A pipe has at most one unacknowledged 64 KiB native chunk. The guardian
 * pauses that provider stream until the app consumes it, bounding IPC memory. */
class NativeOutput extends Readable {
  private pendingAck?: number;
  constructor(private readonly send: Send, private readonly stream: string) { super({ highWaterMark: 64 * 1024 }); }
  _read(): void {
    if (this.pendingAck !== undefined) {
      this.send({ type: "outputAck", stream: this.stream, sequence: this.pendingAck });
      this.pendingAck = undefined;
    }
  }
  receive(data: Buffer, sequence: number): void {
    this.pendingAck = sequence;
    if (this.push(data)) this._read();
  }
}

/** The handle names the real provider pid, with the same parsed stdin/stdout
 * bytes as the native CLI. All sessions share one guardian OS process. */
class NativeProcessHandle extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: NativeOutput;
  readonly stderr: NativeOutput;
  pid?: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private sequence = 0;
  private readonly inputCallbacks = new Map<number, (error?: Error | null) => void>();
  private resolveClosed!: () => void;
  private rejectClosed!: (error: Error) => void;
  readonly closed = new Promise<void>((resolve, reject) => { this.resolveClosed = resolve; this.rejectClosed = reject; });
  constructor(private readonly send: Send, endInputWithoutStopping = false) {
    super();
    void this.closed.catch(() => undefined);
    this.stdout = new NativeOutput(send, "stdout");
    this.stderr = new NativeOutput(send, "stderr");
    this.stdin = new Writable({
      highWaterMark: 64 * 1024,
      write: (data: Buffer, _encoding, callback) => {
        let offset = 0;
        const next = (error?: Error | null): void => {
          if (error || offset === data.length) { callback(error); return; }
          const chunk = data.subarray(offset, offset + 64 * 1024);
          offset += chunk.length;
          const sequence = ++this.sequence;
          this.inputCallbacks.set(sequence, next);
          send({ type: "input", sequence, data: chunk }, (sendError) => {
            if (sendError && this.inputCallbacks.delete(sequence)) next(sendError);
          });
        };
        next();
      },
      final: (callback) => {
        if (endInputWithoutStopping) send({ type: "inputEnd" }, callback);
        else { this.stop(); callback(); }
      }
    });
    this.stdin.on("error", () => undefined);
  }
  stop(): void { this.send({ type: "stop" }); }
  inputAck(sequence: number, error?: string): void {
    const callback = this.inputCallbacks.get(sequence);
    this.inputCallbacks.delete(sequence);
    callback?.(error ? new Error(error) : undefined);
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (!this.pid) return false;
    try { process.kill(this.pid, signal); this.killed = true; return true; } catch { return false; }
  }
  finish(message: SupervisorMessage): void {
    this.exitCode = message.exitCode ?? (message.signal ? null : 0);
    this.signalCode = message.signal ?? null;
    this.stdout.push(null); this.stderr.push(null);
    for (const sequence of this.inputCallbacks.keys()) this.inputAck(sequence, "The native process closed.");
    this.resolveClosed();
    this.emit("exit", this.exitCode, this.signalCode);
    this.emit("close", this.exitCode, this.signalCode);
  }
  fail(message: string, abandoned = false): void {
    const error = new NativeProcessUnavailableError(message);
    if (this.listenerCount("error")) this.emit("error", error);
    if (abandoned) {
      for (const sequence of this.inputCallbacks.keys()) this.inputAck(sequence, message);
      this.stdout.push(null); this.stderr.push(null);
      this.rejectClosed(error);
    }
  }
}

class NativeProcessGuardian {
  private readonly child: ChildProcess;
  private readonly sessions = new Map<string, {
    handle: NativeProcessHandle;
    ready: boolean;
    resolve: (handle: ChildProcessWithoutNullStreams) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  constructor(private readonly key: string) {
    const script = [path.join(__dirname, "nativeProcessSupervisor.js"), path.join(__dirname, "nativeProcessSupervisor.cjs")].find(existsSync);
    if (!script) throw new NativeProcessUnavailableError("The native process supervisor is missing from this app build.");
    this.child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true,
      serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    const abandoned = (): void => {
      if (guardians.get(this.key) === this) guardians.delete(this.key);
      for (const session of this.sessions.values()) {
        const message = "The native supervisor exited without a stored shutdown receipt.";
        clearTimeout(session.timer);
        session.reject(new NativeProcessUnavailableError(message));
        session.handle.fail(message, true);
      }
      this.sessions.clear();
    };
    this.child.on("error", abandoned);
    this.child.on("exit", abandoned);
    this.child.on("message", (message: SupervisorMessage) => {
      const session = this.sessions.get(message.id);
      if (!session) return;
      if (message.type === "ready" && message.provider) {
        clearTimeout(session.timer); session.ready = true;
        session.handle.pid = message.provider.pid;
        const handle = session.handle as unknown as ChildProcessWithoutNullStreams;
        supervised.set(handle, session.handle);
        session.resolve(handle);
      } else if (message.type === "data" && message.data && message.stream && typeof message.sequence === "number") {
        session.handle[message.stream].receive(message.data, message.sequence);
      } else if (message.type === "inputAck" && typeof message.sequence === "number") session.handle.inputAck(message.sequence, message.error);
      else if (message.type === "error") {
        if (!session.ready) { clearTimeout(session.timer); session.reject(new NativeProcessUnavailableError(message.message ?? "Native process supervision failed.")); }
        session.handle.fail(message.message ?? "Native process supervision failed.");
      } else if (message.type === "closed" || message.type === "abandoned") {
        clearTimeout(session.timer);
        if (!session.ready) session.reject(new NativeProcessUnavailableError("The native process closed before ownership was confirmed."));
        if (message.type === "closed") session.handle.finish(message);
        else session.handle.fail("Native process ownership could not be established.", true);
        this.sessions.delete(message.id);
        if (!this.sessions.size) { this.child.unref(); this.child.channel?.unref(); }
      }
    });
  }
  start(config: Omit<NativeSupervisorStart, "type" | "id"> & { env: NodeJS.ProcessEnv }): Promise<ChildProcessWithoutNullStreams> {
    const id = randomUUID();
    this.child.ref(); this.child.channel?.ref();
    const send: Send = (message, callback) => {
      if (!this.child.connected) { callback?.(new Error("The native supervisor is disconnected.")); return; }
      this.child.send({ id, ...message }, (error) => callback?.(error));
    };
    return new Promise((resolve, reject) => {
      const handle = new NativeProcessHandle(send, config.endInputWithoutStopping);
      const timer = setTimeout(() => { handle.stop(); reject(new NativeProcessUnavailableError("Native process ownership was not confirmed; no command was sent.")); }, 35_000);
      timer.unref();
      this.sessions.set(id, { handle, ready: false, resolve, reject, timer });
      send({ type: "start", ...config }, (error) => { if (error) { clearTimeout(timer); reject(error); this.sessions.delete(id); } });
    });
  }
}

export async function spawnNativeProcess(options: {
  scope: string; dbPath: string; command: string; args: string[];
  cwd?: string; env: NodeJS.ProcessEnv; sqliteExecutable?: string;
  /** Maintenance pipes end normally; resident provider stdin retains its Stop semantics. */
  endInputWithoutStopping?: boolean;
  maintenancePowerDbPath?: string;
}): Promise<ChildProcessWithoutNullStreams> {
  const key = path.resolve(options.dbPath);
  let guardian = guardians.get(key);
  if (!guardian) { guardian = new NativeProcessGuardian(key); guardians.set(key, guardian); }
  return guardian.start({ ...options, sqliteExecutable: options.sqliteExecutable ?? "sqlite3", electronRunAsNode: options.env.ELECTRON_RUN_AS_NODE });
}

export async function confirmNativeProcessClosed(child: ChildProcessWithoutNullStreams): Promise<void> {
  const control = supervised.get(child);
  if (control) { control.stop(); await control.closed; }
}
export function isSupervisedNativeProcess(child: ChildProcessWithoutNullStreams): boolean { return supervised.has(child); }
