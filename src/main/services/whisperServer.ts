import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";

/** What recognizes speech: kept warm between dictations, stopped when idle. */
export interface SpeechEngine {
  /** Loads the model unless it is loaded or loading; resolves when ready. */
  prepare(): Promise<void>;
  /** The engine's text for one 16 kHz mono WAV. */
  transcribe(wav: Uint8Array, timeoutMs: number): Promise<string>;
  stop(reason: string): Promise<void>;
  /** Whether the model is in memory now (for the log). */
  isWarm(): boolean;
}

export interface WhisperServerEngineOptions {
  serverPath: string;
  modelPath: string;
  /** Stopped this long after the last dictation, which frees its memory. */
  idleMs: number;
  /** Longest wait for the model to load. */
  readyTimeoutMs?: number;
  log?: (event: string, payload: Record<string, unknown>) => void;
}

interface Running {
  /** Set once the shell is spawned (a free port is found first). */
  child?: ChildProcess;
  origin: string;
  ready: Promise<void>;
  loaded: boolean;
  exited: boolean;
  startedAt: number;
}

const DEFAULT_READY_TIMEOUT_MS = 2 * 60 * 1000;
const STOP_GRACE_MS = 3_000;

/**
 * whisper.cpp's server, run with the model loaded so a phrase is recognized
 * without loading 1.6 GB again. It listens only on this computer, under a
 * random path that works as its password: the server answers web pages from
 * any origin, so its address must not be guessable.
 *
 * It runs under a small shell that reads from the app: when the app goes
 * away, even by a crash, that read ends and the server is stopped, so a
 * model never stays in memory without the app.
 */
export class WhisperServerEngine implements SpeechEngine {
  private running?: Running;
  private idleTimer?: NodeJS.Timeout;
  /** Dictations being recognized now: the engine is not idle meanwhile. */
  private inFlight = 0;

  constructor(private readonly options: WhisperServerEngineOptions) {}

  isWarm(): boolean {
    return Boolean(this.running && !this.running.exited);
  }

  prepare(): Promise<void> {
    this.touch();
    if (!this.running || this.running.exited) this.running = this.start();
    return this.running.ready;
  }

  async transcribe(wav: Uint8Array, timeoutMs: number): Promise<string> {
    this.inFlight += 1;
    try {
      return await this.transcribeNow(wav, timeoutMs);
    } finally {
      this.inFlight -= 1;
      this.touch();
    }
  }

  private async transcribeNow(wav: Uint8Array, timeoutMs: number): Promise<string> {
    await this.prepare();
    const running = this.running;
    if (!running || running.exited) throw new Error("The speech engine stopped while loading.");
    try {
      const form = new FormData();
      form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
      form.append("response_format", "json");
      const response = await fetch(`${running.origin}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`The speech engine answered ${response.status}: ${body.slice(0, 200)}`);
      const parsed = JSON.parse(body) as { text?: unknown; error?: unknown };
      if (typeof parsed.text !== "string") throw new Error(`The speech engine gave no text: ${body.slice(0, 200)}`);
      return parsed.text;
    } catch (error) {
      // A hung or broken engine is not reused for the next dictation.
      if (this.running === running) await this.stop("failed");
      throw error;
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const running = this.running;
    this.running = undefined;
    if (!running || running.exited) return;
    const child = running.child;
    if (!child) {
      // Still finding a port: it gives up before spawning.
      running.exited = true;
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // Closing its input is what the shell waits for: it stops the server.
    child.stdin?.end();
    const timer = setTimeout(() => killGroup(child, "SIGKILL"), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
    this.options.log?.("speech.engine-stopped", { reason, seconds: Math.round((Date.now() - running.startedAt) / 1000) });
  }

  /** The idle countdown starts again; it never ends a load or a dictation. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.inFlight > 0 || (this.running && !this.running.loaded && !this.running.exited)) {
        this.touch();
        return;
      }
      void this.stop("idle");
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  private start(): Running {
    const startedAt = Date.now();
    const token = `/${randomBytes(24).toString("hex")}`;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Nothing waits on it when the microphone starts it; the dictation does.
    ready.catch(() => undefined);
    const running: Running = { origin: "", ready, loaded: false, exited: false, startedAt };
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) rejectReady(error);
      else resolveReady();
    };
    void (async () => {
      const port = await freePort();
      running.origin = `http://127.0.0.1:${port}${token}`;
      if (running.exited) throw new Error("The speech engine was stopped before it started.");
      const threads = String(Math.max(2, Math.min(8, os.cpus().length)));
      const child = spawn("/bin/sh", [
        "-c",
        // The server reads nothing. A reader beside it waits for the app to
        // close this shell's input (or to go away) and then stops the server;
        // the shell itself ends when the server does.
        'server="$1"; shift; exec 3<&0; "$server" "$@" </dev/null 3<&- & child=$!; '
          + '{ read -r _ <&3; kill "$child" 2>/dev/null; } & wait "$child"',
        "accordagents-speech",
        this.options.serverPath,
        "-m", this.options.modelPath,
        "-l", "auto",
        "-t", threads,
        "-nt",
        "-sns",
        "--host", "127.0.0.1",
        "--port", String(port),
        "--request-path", token,
        "--inference-path", "/inference"
      ], { stdio: ["pipe", "ignore", "pipe"], detached: true });
      running.child = child;
      let errors = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        errors = `${errors}${chunk.toString("utf8")}`.slice(-4_000);
      });
      child.stdin?.on("error", () => undefined);
      child.on("error", (error) => {
        running.exited = true;
        settle(error);
      });
      child.on("exit", (code, signal) => {
        running.exited = true;
        child.stdin?.destroy();
        if (this.running === running) this.running = undefined;
        if (!settled) {
          const detail = errors.trim().split(/\r?\n/).slice(-3).join(" ");
          this.options.log?.("speech.engine-failed", { code, signal, detail });
          settle(new Error(`The speech engine stopped while loading (${code ?? signal}).`));
        }
      });
      // The server listens only once the model is loaded.
      const deadline = startedAt + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
      while (!settled && !running.exited) {
        if (Date.now() > deadline) {
          settle(new Error("The speech model took too long to load."));
          void this.stop("load-timeout");
          return;
        }
        if (await healthy(running.origin)) {
          this.options.log?.("speech.engine-ready", { loadMs: Date.now() - startedAt });
          running.loaded = true;
          settle();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    })().catch((error: unknown) => {
      running.exited = true;
      settle(error instanceof Error ? error : new Error(String(error)));
    });
    return running;
  }
}

async function healthy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) });
    const body = await response.text();
    return response.ok && /"ok"/.test(body);
  } catch {
    return false;
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

/** A port nothing on this computer listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("No free port for the speech engine."))));
    });
  });
}
