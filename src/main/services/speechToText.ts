import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
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
import { ENGINE_DIR_PREFIX, WhisperServerEngine, type SpeechEngine, type SpeechEngineInput } from "./whisperServer";

type SpeechFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
type CreateEngine = (input: SpeechEngineInput) => SpeechEngine;

export interface SpeechToTextServiceOptions {
  /** Where the model and the on/off choice live (userData/speech-to-text). */
  dir: string;
  /** The engine program, or why there is none on this computer. */
  engine: () => { path: string } | { unavailable: string };
  fetch: SpeechFetch;
  model?: { url: string; bytes: number; sha256: string };
  freeBytes?: (dir: string) => Promise<number>;
  createEngine?: CreateEngine;
  /** The model leaves memory this long after the last dictation. */
  idleMs?: number;
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
const DEFAULT_STALL_MS = 60_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 250;
/** Recordings an earlier version left in the temporary folder by a crash. */
const STALE_RECORDING_MS = 60 * 60 * 1000;
const TEMP_PREFIX = "accordagents-speech-";
/** She chose: loaded when she presses the microphone, gone 10 minutes after
 *  the last dictation. */
const DEFAULT_ENGINE_IDLE_MS = 10 * 60 * 1000;

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
  private engine?: SpeechEngine;
  /** Turning off is under way: nothing may start the engine again. */
  private turningOff = false;
  /** Turning on and off run one at a time, so a quick on-off-on never
   *  removes a download another action has just started. */
  private actions: Promise<unknown> = Promise.resolve();

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

  /** Whether the microphone may be used now. Answers from what is loaded,
   *  for checks that cannot wait. */
  isReadyNow(): boolean {
    return !this.turningOff && this.snapshot().status === "ready";
  }

  enable(): Promise<SpeechToTextState> {
    return this.serialize(async () => {
      const engine = this.options.engine();
      if ("unavailable" in engine) return this.snapshot();
      if (!this.enabled) await this.saveChoice(true);
      if (!this.modelInstalled && !this.download) {
        this.startDownload();
      }
      this.emit();
      return this.snapshot();
    });
  }

  /** Stops a download and removes what arrived. A model that finished in
   *  the meantime is kept: nothing she downloaded is thrown away by a race. */
  cancelDownload(): Promise<SpeechToTextState> {
    return this.serialize(() => this.turnOff(false));
  }

  disable(request: { deleteModel: boolean }): Promise<SpeechToTextState> {
    return this.serialize(() => this.turnOff(request.deleteModel));
  }

  /**
   * Starts loading the model when she presses the microphone, so it is
   * ready, or nearly, by the time she stops speaking. Returns at once.
   */
  async prepare(): Promise<void> {
    await this.load();
    const engine = this.options.engine();
    if ("unavailable" in engine || !this.isReadyNow()) return;
    this.engineFor(engine.path).prepare().catch((error: unknown) => {
      this.options.log?.("speech.prepare-failed", { message: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Frees the model's memory now (the app is quitting). */
  shutdown(): Promise<void> {
    return this.stopEngine("app-quit");
  }

  /** One engine for the app's life (its program does not move meanwhile). */
  private engineFor(serverPath: string): SpeechEngine {
    if (!this.engine) {
      const create = this.options.createEngine ?? ((input) => new WhisperServerEngine({ ...input, log: this.options.log }));
      this.engine = create({ serverPath, modelPath: this.modelPath, idleMs: this.options.idleMs ?? DEFAULT_ENGINE_IDLE_MS });
    }
    return this.engine;
  }

  private async stopEngine(reason: string): Promise<void> {
    await this.engine?.stop(reason);
  }

  private async turnOff(deleteModel: boolean): Promise<SpeechToTextState> {
    // Before anything is awaited: a dictation or microphone press arriving
    // meanwhile must not load the model again.
    this.turningOff = true;
    try {
      return await this.turnOffNow(deleteModel);
    } finally {
      this.turningOff = false;
    }
  }

  private async turnOffNow(deleteModel: boolean): Promise<SpeechToTextState> {
    await this.stopEngine("turned-off");
    await this.stopDownload();
    await rm(this.partialPath, { force: true });
    this.downloadedBytes = 0;
    if (deleteModel) {
      await rm(this.modelPath, { force: true });
      this.modelInstalled = false;
    }
    this.error = undefined;
    await this.saveChoice(false);
    this.options.log?.("speech.disabled", { deleteModel });
    this.emit();
    return this.snapshot();
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const run = this.actions.then(async () => {
      await this.load();
      return action();
    });
    this.actions = run.catch(() => undefined);
    return run;
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
    if (!this.enabled || !this.modelInstalled || this.turningOff) {
      throw new Error("Speech to text is not ready. Turn it on in Settings › General.");
    }
    const length = speechWavSeconds(audio);
    if ("error" in length) throw new Error(length.error);
    if (length.seconds < SPEECH_MIN_SECONDS || speechWavIsSilent(audio)) return { text: "" };
    if (length.seconds > SPEECH_MAX_SECONDS + 5) {
      throw new Error(`The recording is longer than ${SPEECH_MAX_SECONDS / 60} minutes. Record it in parts.`);
    }
    if (await this.fileSize(this.modelPath) !== this.model.bytes) {
      // Removed outside the app: say so instead of failing every dictation.
      this.modelInstalled = false;
      await this.stopEngine("model-missing");
      this.emit();
      throw new Error("The speech model is missing. Turn speech to text off and on in Settings › General to download it again.");
    }
    const startedAt = Date.now();
    const speechEngine = this.engineFor(engine.path);
    const warm = speechEngine.isWarm();
    try {
      // For recognition once the model is loaded (loading has its own limit):
      // several times slower than real time is already broken, and a hung
      // engine must not hold every later recording in the queue for long.
      const timeoutMs = 2 * 60 * 1000 + Math.ceil(length.seconds) * 1000;
      const text = cleanTranscript(await speechEngine.transcribe(audio, timeoutMs));
      this.options.log?.("speech.transcribed", {
        seconds: Math.round(length.seconds * 10) / 10,
        ms: Date.now() - startedAt,
        warm,
        characters: text.length
      });
      return { text };
    } catch (error) {
      this.options.log?.("speech.transcribe-failed", { message: error instanceof Error ? error.message : String(error) });
      throw new Error("Speech could not be recognized. Try again.");
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
      await removeStaleRecordings();
    })();
    return this.loaded;
  }

  /** Saved first, then applied: a failed save leaves the app as it was. */
  private async saveChoice(enabled: boolean): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const stored: StoredChoice = { enabled };
    await writeFile(this.choicePath, `${JSON.stringify(stored)}\n`);
    this.enabled = enabled;
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
      }, this.options.stallMs ?? DEFAULT_STALL_MS);
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
          if (response.status === 206 || response.status === 416) {
            // It did not continue where this download stopped: start over next time.
            await rm(this.partialPath, { force: true });
            this.downloadedBytes = 0;
          }
          throw new SpeechError(`The download failed: the server answered ${response.status}. Try again.`);
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
            if (now - lastProgressAt >= (this.options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS)) {
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
        ? "The download stopped: no data was arriving. Check the connection and resume."
        : error instanceof SpeechError
          ? error.message
          : (error as NodeJS.ErrnoException)?.code === "ENOSPC"
            ? "The disk is full. Free some space and resume the download."
            : "The download stopped. Resume continues from where it stopped.";
      this.options.log?.("speech.download-failed", {
        message: this.error,
        cause: error instanceof Error ? error.message : String(error),
        downloadedBytes: this.downloadedBytes
      });
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
  // A signed app never runs another program picked by its environment.
  const candidate = (input.packaged ? undefined : input.override?.trim())
    || (input.packaged
      ? path.join(input.resourcesPath, "whisper", "whisper-server")
      : path.join(input.appPath, "dist", "whisper", "whisper-server"));
  if (!existsSync(candidate)) {
    return { unavailable: "Speech to text is not included in this build of the app." };
  }
  return { path: candidate };
}

/**
 * Left in the temporary folder by a crash: recordings from versions that ran
 * whisper-cli, and engine socket folders. Removed when the app starts.
 */
async function removeStaleRecordings(): Promise<void> {
  const dir = os.tmpdir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX) && !name.startsWith(ENGINE_DIR_PREFIX)) continue;
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => undefined);
    if (info && now - info.mtimeMs > STALE_RECORDING_MS) await rm(file, { recursive: true, force: true }).catch(() => undefined);
  }
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
