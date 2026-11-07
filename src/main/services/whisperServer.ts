import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

/** What recognizes speech: kept loaded between dictations, stopped when idle. */
export interface SpeechEngine {
  /** Loads the model unless it is loaded or loading; resolves when ready. */
  prepare(): Promise<void>;
  /** The engine's text for one 16 kHz mono WAV, and the language it heard.
   *  A piece of a longer recording comes with the text before it and the
   *  language found in its first piece. */
  transcribe(wav: Uint8Array, timeoutMs: number, context?: SpeechPieceContext): Promise<{ text: string; language?: string }>;
  stop(reason: string): Promise<void>;
  /** Whether the model is loaded and answering now (for the log). */
  isWarm(): boolean;
}

export type SpeechEngineInput = Pick<WhisperServerEngineOptions, "serverPath" | "modelPath" | "idleMs">;

export interface SpeechPieceContext {
  prompt?: string;
  language?: string;
}

export interface WhisperServerEngineOptions {
  serverPath: string;
  modelPath: string;
  /** Stopped this long after the last use, which frees its memory. */
  idleMs: number;
  /** Longest wait for the model to load. */
  readyTimeoutMs?: number;
  /** After asking it to stop, how long before it is killed outright. */
  stopGraceMs?: number;
  log?: (event: string, payload: Record<string, unknown>) => void;
}

interface Running {
  /** Set once the shell is spawned (its folder is made first). */
  child?: ChildProcess;
  dir?: string;
  socket?: string;
  ready: Promise<void>;
  loaded: boolean;
  exited: boolean;
  /** Resolves once the process is gone (or could not start). */
  gone: Promise<void>;
  startedAt: number;
}

export const ENGINE_DIR_PREFIX = "accordagents-speech-engine-";
const DEFAULT_READY_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_STOP_GRACE_MS = 3_000;
const HEALTH_POLL_MS = 150;
const HEALTH_TIMEOUT_MS = 2_000;
const STDERR_TAIL_CHARS = 4_000;
const ERROR_BODY_CHARS = 200;

/**
 * whisper.cpp's server, run with the model loaded so a phrase is recognized
 * without loading 1.6 GB again. It listens on a Unix socket in a folder only
 * her user can open (the build adds that option to the server), so no other
 * account, and no web page, can reach it or take its place.
 *
 * It runs under a small shell that reads from the app: when the app goes
 * away, even by a crash, that read ends and the server is stopped (killed if
 * it does not stop), so a model never stays in memory without the app.
 */
export class WhisperServerEngine implements SpeechEngine {
  private running?: Running;
  /** The engine being stopped: a new one starts only after it is gone. */
  private stopping?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  /** Dictations being recognized now: the engine is not idle meanwhile. */
  private inFlight = 0;

  constructor(private readonly options: WhisperServerEngineOptions) {}

  isWarm(): boolean {
    return Boolean(this.running?.loaded && !this.running.exited);
  }

  async prepare(): Promise<void> {
    this.touch();
    if (!this.running || this.running.exited) {
      // Never two models in memory: the one being stopped goes first.
      if (this.stopping) await this.stopping;
      if (!this.running || this.running.exited) this.running = this.start();
    }
    return this.running.ready;
  }

  async transcribe(wav: Uint8Array, timeoutMs: number, context: SpeechPieceContext = {}): Promise<{ text: string; language?: string }> {
    this.inFlight += 1;
    try {
      return await this.transcribeNow(wav, timeoutMs, context);
    } finally {
      this.inFlight -= 1;
      this.touch();
    }
  }

  private async transcribeNow(wav: Uint8Array, timeoutMs: number, context: SpeechPieceContext): Promise<{ text: string; language?: string }> {
    await this.prepare();
    const running = this.running;
    if (!running?.socket || running.exited) throw new Error("The speech engine stopped while loading.");
    let response: { status: number; body: string };
    try {
      response = await unixRequest(running.socket, "POST", "/inference", multipart(wav, context), timeoutMs);
    } catch (error) {
      // No answer in time, or the connection broke: a hung or broken engine
      // is not reused for the next dictation.
      await this.stopRunning(running, "failed");
      throw error;
    }
    if (response.status >= 500) await this.stopRunning(running, "failed");
    if (response.status !== 200) {
      throw new Error(`The speech engine answered ${response.status}: ${response.body.slice(0, ERROR_BODY_CHARS)}`);
    }
    const parsed = JSON.parse(response.body) as { text?: unknown; language?: unknown };
    if (typeof parsed.text !== "string") {
      throw new Error(`The speech engine gave no text: ${response.body.slice(0, ERROR_BODY_CHARS)}`);
    }
    return { text: parsed.text, ...(typeof parsed.language === "string" ? { language: parsed.language } : {}) };
  }

  async stop(reason: string): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const running = this.running;
    if (running) await this.stopRunning(running, reason);
    else if (this.stopping) await this.stopping;
  }

  /** Stops this engine (and no other): asks, then kills it if it lingers. */
  private async stopRunning(running: Running, reason: string): Promise<void> {
    if (this.running === running) this.running = undefined;
    if (running.exited) {
      await running.gone;
      return;
    }
    running.exited = true;
    const child = running.child;
    const stopped = (async () => {
      if (child) {
        // Closing its input is what the shell waits for: it stops the server.
        child.stdin?.end();
        const grace = this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
        const killer = setTimeout(() => killGroup(child, "SIGKILL"), grace);
        // A process stuck even after being killed must not hold up the app.
        await Promise.race([running.gone, new Promise((resolve) => setTimeout(resolve, grace * 2))]);
        clearTimeout(killer);
      }
      this.options.log?.("speech.engine-stopped", { reason, seconds: Math.round((performance.now() - running.startedAt) / 1000) });
    })();
    this.stopping = stopped;
    try {
      await stopped;
    } finally {
      if (this.stopping === stopped) this.stopping = undefined;
    }
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
    const startedAt = performance.now();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Nothing waits on it when the microphone starts it; the dictation does.
    ready.catch(() => undefined);
    let markGone!: () => void;
    const gone = new Promise<void>((resolve) => {
      markGone = resolve;
    });
    const running: Running = { ready, loaded: false, exited: false, gone, startedAt };
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) rejectReady(error);
      else resolveReady();
    };
    void (async () => {
      // mkdtemp makes the folder readable by her user only.
      const dir = await mkdtemp(path.join(os.tmpdir(), ENGINE_DIR_PREFIX));
      running.dir = dir;
      running.socket = path.join(dir, "s");
      if (running.exited) throw new Error("The speech engine was stopped before it started.");
      const threads = String(Math.max(2, Math.min(8, os.cpus().length)));
      const child = spawn("/bin/sh", [
        "-c",
        // The server reads nothing. A reader beside it waits for the app to
        // close this shell's input (or to go away), asks the server to stop,
        // and three seconds later kills whatever is left of this process
        // group. The shell itself ends when the server does.
        'server="$1"; shift; exec 3<&0; "$server" "$@" </dev/null 3<&- & child=$!; '
          + '{ read -r _ <&3; kill "$child" 2>/dev/null; sleep 3; kill -9 0 2>/dev/null; } & wait "$child"',
        "accordagents-speech",
        this.options.serverPath,
        "-m", this.options.modelPath,
        "-l", "auto",
        "-t", threads,
        // The same decoding whisper-cli used: beam search over 5 candidates.
        "-bs", "5",
        "-bo", "5",
        "-nt",
        "-sns",
        "--host", `unix:${running.socket}`
      ], { stdio: ["pipe", "ignore", "pipe"], detached: true });
      running.child = child;
      let errors = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        errors = `${errors}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_CHARS);
      });
      child.stdin?.on("error", () => undefined);
      let finished = false;
      const finish = (failure: Error): void => {
        if (finished) return;
        finished = true;
        running.exited = true;
        child.stdin?.destroy();
        if (this.running === running) this.running = undefined;
        if (!settled) {
          const detail = errors.trim().split(/\r?\n/).slice(-3).join(" ");
          this.options.log?.("speech.engine-failed", { message: failure.message, detail });
          settle(failure);
        }
        void rm(dir, { recursive: true, force: true }).catch(() => undefined).finally(markGone);
      };
      child.once("error", (error) => finish(error));
      child.once("exit", (code, signal) => finish(new Error(`The speech engine stopped while loading (${code ?? signal}).`)));
      // The server listens only once the model is loaded.
      const deadline = startedAt + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
      while (!settled && !running.exited) {
        if (performance.now() > deadline) {
          settle(new Error("The speech model took too long to load."));
          void this.stopRunning(running, "load-timeout");
          return;
        }
        if (await healthy(running.socket)) {
          running.loaded = true;
          this.options.log?.("speech.engine-ready", { loadMs: Math.round(performance.now() - startedAt) });
          settle();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
      }
    })().catch((error: unknown) => {
      running.exited = true;
      settle(error instanceof Error ? error : new Error(String(error)));
      if (!running.child) {
        const dir = running.dir;
        void (dir ? rm(dir, { recursive: true, force: true }).catch(() => undefined) : Promise.resolve()).finally(markGone);
      }
    });
    return running;
  }
}

async function healthy(socket: string): Promise<boolean> {
  try {
    const response = await unixRequest(socket, "GET", "/health", undefined, HEALTH_TIMEOUT_MS);
    return response.status === 200 && /"ok"/.test(response.body);
  } catch {
    return false;
  }
}

/** One HTTP request over the engine's Unix socket. */
function unixRequest(
  socketPath: string,
  method: string,
  requestPath: string,
  body: { type: string; data: Buffer } | undefined,
  timeoutMs: number
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method,
      path: requestPath,
      headers: body ? { "content-type": body.type, "content-length": String(body.data.byteLength) } : undefined
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`The speech engine did not answer in ${Math.round(timeoutMs / 1000)} s.`)));
    request.on("error", reject);
    request.end(body?.data);
  });
}

function multipart(wav: Uint8Array, context: SpeechPieceContext): { type: string; data: Buffer } {
  const boundary = `accordagents-${randomBytes(12).toString("hex")}`;
  const field = (name: string, value: string): string =>
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
  // The boundary is random per request, so text cannot end a field early.
  // verbose_json reports the language heard; its probabilities cost a second
  // pass and are not needed.
  const fields = [
    field("response_format", "verbose_json"),
    field("no_language_probabilities", "true"),
    context.prompt ? field("prompt", context.prompt) : "",
    context.language ? field("language", context.language) : ""
  ].join("");
  const tail = `${fields}\r\n--${boundary}--\r\n`;
  return {
    type: `multipart/form-data; boundary=${boundary}`,
    data: Buffer.concat([Buffer.from(head), Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength), Buffer.from(tail)])
  };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}
