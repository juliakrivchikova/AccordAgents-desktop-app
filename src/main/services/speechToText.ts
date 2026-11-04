import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SPEECH_MAX_SECONDS,
  SPEECH_MIN_SECONDS,
  SPEECH_MODEL_BYTES,
  SPEECH_MODEL_FILE,
  SPEECH_MODEL_SHA256,
  SPEECH_MODEL_URL,
  cleanTranscript,
  formatSpeechBytes,
  speechWavIsSilent,
  speechWavSeconds
} from "../../shared/speechToText";
import type { SpeechToTextState, TranscribeSpeechResult } from "../../shared/types";
import { CommandError, runCommand } from "./command";

type SpeechFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
type RunEngine = (enginePath: string, args: string[]) => Promise<void>;

export interface SpeechToTextServiceOptions {
  /** Where the model and the on/off choice live (userData/speech-to-text). */
  dir: string;
  /** The engine program, or why there is none on this computer. */
  engine: () => { path: string } | { unavailable: string };
  fetch: SpeechFetch;
  model?: { url: string; bytes: number; sha256: string };
  freeBytes?: (dir: string) => Promise<number>;
  runEngine?: RunEngine;
  /** A download that gets no bytes for this long is stopped. */
  stallMs?: number;
  progressIntervalMs?: number;
  log?: (event: string, payload: Record<string, unknown>) => void;
}

interface StoredChoice {
  enabled: boolean;
}

/** An error whose message is already a sentence for the User. */
class SpeechError extends Error {}

const DISK_MARGIN_BYTES = 200 * 1024 * 1024;
const ENGINE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Speech to text on this computer: the User's on/off choice, the Whisper
 * model download (resumable, checked before use), and recognition of one
 * recording at a time by the engine program the app ships.
 */
export class SpeechToTextService {
  private readonly modelPath: string;
  private readonly partialPath: string;
  private readonly choicePath: string;
  private readonly model: { url: string; bytes: number; sha256: string };
  private readonly listeners = new Set<(state: SpeechToTextState) => void>();
  private loaded?: Promise<void>;
  private enabled = false;
  private modelInstalled = false;
  private phase: "idle" | "downloading" | "verifying" = "idle";
  private downloadedBytes = 0;
  private error?: string;
  private download?: { controller: AbortController; done: Promise<void> };
  private transcriptions: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SpeechToTextServiceOptions) {
    this.model = options.model ?? { url: SPEECH_MODEL_URL, bytes: SPEECH_MODEL_BYTES, sha256: SPEECH_MODEL_SHA256 };
    this.modelPath = path.join(options.dir, SPEECH_MODEL_FILE);
    this.partialPath = `${this.modelPath}.partial`;
    this.choicePath = path.join(options.dir, "settings.json");
  }

  onState(listener: (state: SpeechToTextState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getState(): Promise<SpeechToTextState> {
    await this.load();
    return this.snapshot();
  }

  async enable(): Promise<SpeechToTextState> {
    await this.load();
    const engine = this.options.engine();
    if ("unavailable" in engine) return this.snapshot();
    if (!this.enabled) {
      this.enabled = true;
      await this.saveChoice();
    }
    if (!this.modelInstalled && !this.download) {
      this.startDownload();
    }
    this.emit();
    return this.snapshot();
  }

  async cancelDownload(): Promise<SpeechToTextState> {
    await this.load();
    await this.stopDownload();
    await rm(this.partialPath, { force: true });
    this.downloadedBytes = 0;
    this.error = undefined;
    this.enabled = false;
    await this.saveChoice();
    this.emit();
    return this.snapshot();
  }

  async disable(request: { deleteModel: boolean }): Promise<SpeechToTextState> {
    await this.load();
    await this.stopDownload();
    await rm(this.partialPath, { force: true });
    this.downloadedBytes = 0;
    if (request.deleteModel === true) {
      await rm(this.modelPath, { force: true });
      this.modelInstalled = false;
    }
    this.error = undefined;
    this.enabled = false;
    await this.saveChoice();
    this.options.log?.("speech.disabled", { deleteModel: request.deleteModel === true });
    this.emit();
    return this.snapshot();
  }

  /** Recognizes one recording. Recordings wait for each other: one engine
   *  at a time holds the model in memory. */
  async transcribe(audio: Uint8Array): Promise<TranscribeSpeechResult> {
    await this.load();
    const run = this.transcriptions.then(() => this.transcribeNow(audio), () => this.transcribeNow(audio));
    this.transcriptions = run.catch(() => undefined);
    return run;
  }

  private async transcribeNow(audio: Uint8Array): Promise<TranscribeSpeechResult> {
    const engine = this.options.engine();
    if ("unavailable" in engine) throw new Error(engine.unavailable);
    if (!this.enabled || !this.modelInstalled) {
      throw new Error("Speech to text is not ready. Turn it on in Settings › General.");
    }
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio as ArrayBuffer);
    const length = speechWavSeconds(bytes);
    if ("error" in length) throw new Error(length.error);
    if (length.seconds < SPEECH_MIN_SECONDS || speechWavIsSilent(bytes)) return { text: "" };
    if (length.seconds > SPEECH_MAX_SECONDS) {
      throw new Error(`The recording is longer than ${SPEECH_MAX_SECONDS / 60} minutes. Record it in parts.`);
    }
    const base = path.join(os.tmpdir(), `accordagents-speech-${randomUUID()}`);
    const wavPath = `${base}.wav`;
    const textPath = `${base}.txt`;
    const startedAt = Date.now();
    try {
      await writeFile(wavPath, bytes, { mode: 0o600 });
      const threads = String(Math.max(2, Math.min(8, os.cpus().length)));
      await this.runEngine(engine.path, [
        "-m", this.modelPath,
        "-f", wavPath,
        "-l", "auto",
        "-t", threads,
        "-np",
        "-nt",
        "-sns",
        "-otxt",
        "-of", base
      ]);
      const text = cleanTranscript(await readFile(textPath, "utf8"));
      this.options.log?.("speech.transcribed", {
        seconds: Math.round(length.seconds * 10) / 10,
        ms: Date.now() - startedAt,
        characters: text.length
      });
      return { text };
    } catch (error) {
      this.options.log?.("speech.transcribe-failed", { message: error instanceof Error ? error.message : String(error) });
      throw new Error("Speech could not be recognized. Try again.");
    } finally {
      await rm(wavPath, { force: true });
      await rm(textPath, { force: true });
    }
  }

  private async runEngine(enginePath: string, args: string[]): Promise<void> {
    if (this.options.runEngine) {
      await this.options.runEngine(enginePath, args);
      return;
    }
    try {
      await runCommand(enginePath, args, {
        timeoutMs: ENGINE_TIMEOUT_MS,
        primeLoginShellEnv: false,
        maxOutputChars: 8_000
      });
    } catch (error) {
      if (error instanceof CommandError) {
        const detail = error.result.stderr.trim().split(/\r?\n/).slice(-3).join(" ");
        throw new Error(`${error.message}${detail ? `: ${detail}` : ""}`);
      }
      throw error;
    }
  }

  private snapshot(): SpeechToTextState {
    const engine = this.options.engine();
    const base = {
      modelInstalled: this.modelInstalled,
      downloadedBytes: this.modelInstalled && this.phase === "idle" ? this.model.bytes : this.downloadedBytes,
      totalBytes: this.model.bytes
    };
    if ("unavailable" in engine) return { ...base, status: "unavailable", error: engine.unavailable };
    if (this.phase === "downloading") return { ...base, status: "downloading" };
    if (this.phase === "verifying") return { ...base, status: "verifying" };
    if (!this.enabled) return { ...base, status: "off" };
    if (this.modelInstalled) return { ...base, status: "ready" };
    return { ...base, status: "interrupted", error: this.error ?? "The download was interrupted." };
  }

  private emit(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A closed window must not stop the others from hearing.
      }
    }
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const stored = JSON.parse(await readFile(this.choicePath, "utf8")) as Partial<StoredChoice>;
        this.enabled = stored.enabled === true;
      } catch {
        this.enabled = false;
      }
      this.modelInstalled = await this.fileSize(this.modelPath) === this.model.bytes;
      this.downloadedBytes = this.modelInstalled ? this.model.bytes : await this.fileSize(this.partialPath) ?? 0;
    })();
    return this.loaded;
  }

  private async saveChoice(): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const stored: StoredChoice = { enabled: this.enabled };
    await writeFile(this.choicePath, `${JSON.stringify(stored)}\n`);
  }

  private async fileSize(file: string): Promise<number | undefined> {
    try {
      return (await stat(file)).size;
    } catch {
      return undefined;
    }
  }

  private startDownload(): void {
    const controller = new AbortController();
    this.phase = "downloading";
    this.error = undefined;
    const done = this.runDownload(controller).finally(() => {
      if (this.download?.controller === controller) this.download = undefined;
      this.phase = "idle";
      this.emit();
    });
    this.download = { controller, done };
  }

  private async stopDownload(): Promise<void> {
    const download = this.download;
    if (!download) return;
    download.controller.abort(new Error("cancelled"));
    await download.done;
  }

  private async runDownload(controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const startedAt = Date.now();
    let stalled = false;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStallTimer = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        controller.abort(new Error("stalled"));
      }, this.options.stallMs ?? 60_000);
    };
    try {
      await mkdir(this.options.dir, { recursive: true });
      let have = await this.fileSize(this.partialPath) ?? 0;
      if (have > this.model.bytes) {
        await rm(this.partialPath, { force: true });
        have = 0;
      }
      this.downloadedBytes = have;
      const free = await (this.options.freeBytes ?? diskFreeBytes)(this.options.dir);
      const needed = this.model.bytes - have + DISK_MARGIN_BYTES;
      if (free < needed) {
        throw new SpeechError(`Not enough free disk space: the speech model needs ${formatSpeechBytes(needed)} free, and ${formatSpeechBytes(free)} is free.`);
      }
      this.options.log?.("speech.download-started", { resumeFrom: have });
      this.emit();
      if (have < this.model.bytes) {
        armStallTimer();
        const response = await this.options.fetch(this.model.url, {
          headers: have > 0 ? { Range: `bytes=${have}-` } : {},
          signal
        });
        let append = false;
        if (response.status === 206 && have > 0 && contentRangeStart(response.headers.get("content-range")) === have) {
          append = true;
        } else if (response.status === 200) {
          have = 0;
        } else {
          await response.body?.cancel().catch(() => undefined);
          throw new SpeechError(`The download failed: the server answered ${response.status}.`);
        }
        if (!response.body) throw new SpeechError("The download failed: the server sent nothing.");
        const file = await open(this.partialPath, append ? "a" : "w");
        this.downloadedBytes = have;
        let lastProgressAt = 0;
        try {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            armStallTimer();
            have += value.byteLength;
            if (have > this.model.bytes) throw new SpeechError("The download failed: the file is larger than expected.");
            await file.write(value);
            this.downloadedBytes = have;
            const now = Date.now();
            if (now - lastProgressAt >= (this.options.progressIntervalMs ?? 250)) {
              lastProgressAt = now;
              this.emit();
            }
          }
        } finally {
          await file.close();
        }
        if (stallTimer) clearTimeout(stallTimer);
        if (have !== this.model.bytes) {
          throw new SpeechError("The download stopped before it finished.");
        }
      }
      this.phase = "verifying";
      this.emit();
      const digest = await sha256File(this.partialPath, signal);
      if (digest !== this.model.sha256) {
        await rm(this.partialPath, { force: true });
        this.downloadedBytes = 0;
        throw new SpeechError("The downloaded model is damaged and was removed. Try again.");
      }
      await rename(this.partialPath, this.modelPath);
      this.modelInstalled = true;
      this.downloadedBytes = this.model.bytes;
      this.options.log?.("speech.download-finished", { seconds: Math.round((Date.now() - startedAt) / 1000) });
    } catch (error) {
      if (signal.aborted && !stalled) {
        this.options.log?.("speech.download-cancelled", { downloadedBytes: this.downloadedBytes });
        return;
      }
      this.error = stalled
        ? "The download stopped: no data arrived for a minute. Check the connection and resume."
        : error instanceof SpeechError
          ? error.message
          : `The download stopped: ${error instanceof Error ? error.message : String(error)}. Resume continues from where it stopped.`;
      this.options.log?.("speech.download-failed", { message: this.error, downloadedBytes: this.downloadedBytes });
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  }
}

/** Where the engine program is: beside the asar in the app, dist/whisper in
 *  a checkout. Only Apple Silicon Macs have one. */
export function resolveSpeechEngine(input: {
  platform: NodeJS.Platform;
  arch: string;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  override?: string;
}): { path: string } | { unavailable: string } {
  if (input.platform !== "darwin" || input.arch !== "arm64") {
    return { unavailable: "Speech to text works on Macs with Apple silicon." };
  }
  const candidate = input.override?.trim()
    || (input.packaged
      ? path.join(input.resourcesPath, "whisper", "whisper-cli")
      : path.join(input.appPath, "dist", "whisper", "whisper-cli"));
  if (!existsSync(candidate)) {
    return { unavailable: "Speech to text is not included in this build of the app." };
  }
  return { path: candidate };
}

function contentRangeStart(header: string | null): number | undefined {
  const match = /^bytes (\d+)-\d+\/\d+$/.exec(header?.trim() ?? "");
  return match ? Number(match[1]) : undefined;
}

async function diskFreeBytes(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

function sha256File(file: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file, { signal });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
