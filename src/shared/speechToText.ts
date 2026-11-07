/**
 * Speech to text: what the desktop records, what it sends to the engine, and
 * how the recognized text goes into the message being written.
 */

/** Whisper large-v3-turbo, the multilingual model, at a pinned revision. */
export const SPEECH_MODEL_FILE = "ggml-large-v3-turbo.bin";
export const SPEECH_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo.bin";
export const SPEECH_MODEL_BYTES = 1_624_555_275;
export const SPEECH_MODEL_SHA256 = "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69";

/** The engine reads 16 kHz mono 16-bit PCM. */
export const SPEECH_SAMPLE_RATE = 16_000;
/** Shorter than this is a click, not speech: nothing is sent. */
export const SPEECH_MIN_SECONDS = 0.4;
/** One recording's limit; longer ones are refused rather than cut. */
export const SPEECH_MAX_SECONDS = 30 * 60;
/**
 * A long recording is recognized in pieces while she speaks: once this much
 * is waiting, a piece is cut at the quietest moment between the two marks
 * and sent, so after she stops only the last piece is still to come. The
 * engine reads 30 s at a time, so a piece never needs more than one pass.
 */
export const SPEECH_PIECE_MAX_SECONDS = 28;
export const SPEECH_PIECE_MIN_SECONDS = 18;
/** Previous text given to the engine with the next piece, for continuity. */
const SPEECH_PROMPT_CHARS = 200;

/** The key held to dictate, in the app only. fn never reaches web content. */
export type SpeechHoldKey = "option" | "right-option" | "off";
export const SPEECH_HOLD_KEYS: readonly SpeechHoldKey[] = ["option", "right-option", "off"];
export const DEFAULT_SPEECH_HOLD_KEY: SpeechHoldKey = "option";

export function isSpeechHoldKey(value: unknown): value is SpeechHoldKey {
  return typeof value === "string" && (SPEECH_HOLD_KEYS as readonly string[]).includes(value);
}

/** Whether a key event is the chosen hold key, pressed or released. */
export function isHoldKeyEvent(holdKey: SpeechHoldKey, event: { key: string; code: string }): boolean {
  if (holdKey === "off" || event.key !== "Alt") return false;
  return holdKey === "option" || event.code === "AltRight";
}
const WAV_HEADER_BYTES = 44;

/** "1.6 GB" for a byte count, in the units macOS shows. */
export function formatSpeechBytes(bytes: number): string {
  // Rounded the way it is shown, so 999.6 MB reads "1.0 GB", not "1000 MB".
  if (bytes >= 999_500_000) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 999_500) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

/** A WAV file of 16-bit PCM from samples in [-1, 1]. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number = SPEECH_SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  // WAV is little-endian, like every computer the desktop runs on; a typed
  // view writes a half-hour recording far faster than one call per sample.
  const pcm = new Int16Array(bytes.buffer, WAV_HEADER_BYTES, samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return bytes;
}

/**
 * The length in seconds of a WAV made by encodeWavPcm16, or a reason it is
 * not one. The engine only ever gets what the desktop itself recorded.
 */
export function speechWavSeconds(bytes: Uint8Array): { seconds: number } | { error: string } {
  if (bytes.byteLength < WAV_HEADER_BYTES) return { error: "The recording is empty." };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE" || ascii(12, 4) !== "fmt " || ascii(36, 4) !== "data") {
    return { error: "The recording is not in the expected format." };
  }
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  if (format !== 1 || channels !== 1 || sampleRate !== SPEECH_SAMPLE_RATE || bits !== 16) {
    return { error: "The recording is not in the expected format." };
  }
  if (dataBytes !== bytes.byteLength - WAV_HEADER_BYTES) {
    return { error: "The recording is incomplete." };
  }
  return { seconds: dataBytes / 2 / SPEECH_SAMPLE_RATE };
}

/**
 * True when a recording made by encodeWavPcm16 holds no sound at all (a muted
 * or disconnected microphone). Whisper invents words for pure silence
 * ("you", "Thank you."), so such a recording is not sent to it.
 */
export function speechWavIsSilent(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = WAV_HEADER_BYTES; offset + 1 < bytes.byteLength; offset += 2) {
    if (Math.abs(view.getInt16(offset, true)) > SILENCE_PEAK) return false;
  }
  return true;
}

/** About -50 dBFS: below anything a working microphone picks up in a room. */
const SILENCE_PEAK = 100;

/**
 * The engine's text as one paragraph: its lines joined, and the markers it
 * writes for silence or sounds ("[BLANK_AUDIO]", "[Music]", "(music)") left out.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\[[^\]]*\]/g, " ").replace(/^\s*\([^)]*\)\s*$/, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * The index where a piece of a long recording ends: the middle of the
 * quietest 300 ms between the two marks (a pause between words, not the
 * middle of one). Before the first mark there is nothing to cut.
 */
export function quietestCut(samples: Float32Array, sampleRate: number, fromSeconds: number, toSeconds: number): number {
  const windowSize = Math.max(1, Math.round(sampleRate * 0.3));
  const step = Math.max(1, Math.round(sampleRate * 0.05));
  const from = Math.min(samples.length, Math.round(fromSeconds * sampleRate));
  const to = Math.min(samples.length, Math.round(toSeconds * sampleRate));
  if (to - from < windowSize) return to;
  let best = from;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let start = from; start + windowSize <= to; start += step) {
    let energy = 0;
    for (let index = start; index < start + windowSize; index += 1) {
      const sample = samples[index] ?? 0;
      energy += sample * sample;
    }
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = start;
    }
  }
  return best + Math.floor(windowSize / 2);
}

/**
 * Collects a recording as it arrives and hands out pieces of a long one to
 * recognize while she still speaks; what is left goes when she stops.
 */
export class SpeechPieces {
  private parts: Float32Array[] = [];
  private length = 0;

  constructor(private readonly sampleRate: number = SPEECH_SAMPLE_RATE) {}

  /** Adds samples; returns a piece when one is ready. */
  push(samples: Float32Array): Float32Array | undefined {
    this.parts.push(samples);
    this.length += samples.length;
    if (this.length < SPEECH_PIECE_MAX_SECONDS * this.sampleRate) return undefined;
    const waiting = this.take();
    const cut = quietestCut(waiting, this.sampleRate, SPEECH_PIECE_MIN_SECONDS, SPEECH_PIECE_MAX_SECONDS);
    const rest = waiting.slice(cut);
    this.parts = rest.length ? [rest] : [];
    this.length = rest.length;
    return waiting.slice(0, cut);
  }

  /** Everything not handed out yet. */
  finish(): Float32Array {
    const rest = this.take();
    this.parts = [];
    this.length = 0;
    return rest;
  }

  private take(): Float32Array {
    const all = new Float32Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      all.set(part, offset);
      offset += part.length;
    }
    return all;
  }
}

/** The pieces' text as one paragraph. */
export function joinTranscripts(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(" ");
}

/** The end of what was recognized so far, given with the next piece. */
export function speechPromptFrom(text: string): string | undefined {
  const tail = text.trim().slice(-SPEECH_PROMPT_CHARS);
  return tail || undefined;
}

/** Dictated text spaced from the words before and after where it goes. */
export function spacedDictation(before: string, after: string, text: string): string {
  const insert = text.trim();
  if (!insert) return "";
  const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trailing = after.length > 0 && !/^[\s.,!?;:)\]}»"']/.test(after) ? " " : "";
  return `${leading}${insert}${trailing}`;
}

/**
 * The draft with dictated text put where the caret is (replacing a
 * selection), spaced from the words around it, and where the caret goes next.
 */
export function insertDictatedText(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  text: string
): { value: string; caret: number } {
  const start = clampIndex(Math.min(selectionStart, selectionEnd), draft.length);
  const end = clampIndex(Math.max(selectionStart, selectionEnd), draft.length);
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const insert = spacedDictation(before, after, text);
  if (!insert) return { value: draft, caret: end };
  return { value: `${before}${insert}${after}`, caret: before.length + insert.length };
}

function clampIndex(index: number, length: number): number {
  return Number.isFinite(index) ? Math.max(0, Math.min(length, Math.trunc(index))) : length;
}
