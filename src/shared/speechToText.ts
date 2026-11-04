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
  const insert = text.trim();
  if (!insert) return { value: draft, caret: end };
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trailing = after.length > 0 && !/^[\s.,!?;:)\]}»"']/.test(after) ? " " : "";
  const value = `${before}${leading}${insert}${trailing}${after}`;
  return { value, caret: before.length + leading.length + insert.length + trailing.length };
}

function clampIndex(index: number, length: number): number {
  return Number.isFinite(index) ? Math.max(0, Math.min(length, Math.trunc(index))) : length;
}
