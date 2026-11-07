import assert from "node:assert/strict";
import test from "node:test";

import {
  SPEECH_PIECE_MAX_SECONDS,
  SPEECH_PIECE_MIN_SECONDS,
  SPEECH_SAMPLE_RATE,
  SpeechPieces,
  isHoldKeyEvent,
  joinTranscripts,
  quietestCut,
  spacedDictation,
  speechPromptFrom,
  cleanTranscript,
  encodeWavPcm16,
  formatSpeechBytes,
  insertDictatedText,
  speechWavIsSilent,
  speechWavSeconds
} from "./speechToText";

test("a recording encodes to a WAV the engine accepts, with its length", () => {
  const samples = new Float32Array(SPEECH_SAMPLE_RATE * 2).map((_, index) => Math.sin(index / 10));
  const wav = encodeWavPcm16(samples);
  assert.equal(wav.byteLength, 44 + samples.length * 2);
  assert.deepEqual(speechWavSeconds(wav), { seconds: 2 });
});

test("samples outside [-1, 1] are clipped instead of wrapping around", () => {
  const wav = encodeWavPcm16(new Float32Array([2, -2, 0.5]));
  const view = new DataView(wav.buffer);
  assert.equal(view.getInt16(44, true), 0x7fff);
  assert.equal(view.getInt16(46, true), -0x8000);
  assert.equal(view.getInt16(48, true), Math.trunc(0.5 * 0x7fff));
});

test("anything but the desktop's own recording format is refused", () => {
  assert.ok("error" in speechWavSeconds(new Uint8Array(10)));
  const wrongRate = encodeWavPcm16(new Float32Array(100), 44_100);
  assert.ok("error" in speechWavSeconds(wrongRate));
  const truncated = encodeWavPcm16(new Float32Array(100)).subarray(0, 100);
  assert.ok("error" in speechWavSeconds(truncated));
  const notWav = encodeWavPcm16(new Float32Array(100));
  notWav[0] = "X".charCodeAt(0);
  assert.ok("error" in speechWavSeconds(notWav));
});

test("the engine's markers for silence and sounds are left out, lines become one paragraph", () => {
  assert.equal(cleanTranscript(" [BLANK_AUDIO]\n"), "");
  assert.equal(cleanTranscript(" Привет, это проверка.\n And a second line.\n"), "Привет, это проверка. And a second line.");
  assert.equal(cleanTranscript("[Music]\n(music)\n Hello [ Silence ] world\n"), "Hello world");
  assert.equal(cleanTranscript("Use the (beta) build"), "Use the (beta) build");
});

test("dictated text goes where the caret is, spaced from the words around it", () => {
  assert.deepEqual(insertDictatedText("", 0, 0, " Привет "), { value: "Привет", caret: 6 });
  assert.deepEqual(insertDictatedText("Hello", 5, 5, "world"), { value: "Hello world", caret: 11 });
  assert.deepEqual(insertDictatedText("Hello ", 6, 6, "world"), { value: "Hello world", caret: 11 });
  assert.deepEqual(insertDictatedText("Hello.", 5, 5, "world"), { value: "Hello world.", caret: 11 });
  assert.deepEqual(insertDictatedText("ab", 1, 1, "X"), { value: "a X b", caret: 4 });
  assert.deepEqual(insertDictatedText("say WORD now", 4, 8, "this"), { value: "say this now", caret: 8 });
  assert.deepEqual(insertDictatedText("draft", 99, 99, "end"), { value: "draft end", caret: 9 });
  assert.deepEqual(insertDictatedText("draft", 2, 2, "   "), { value: "draft", caret: 2 });
});

test("sizes read the way macOS shows them", () => {
  assert.equal(formatSpeechBytes(1_624_555_275), "1.6 GB");
  assert.equal(formatSpeechBytes(512_000_000), "512 MB");
  assert.equal(formatSpeechBytes(1_500), "2 KB");
  assert.equal(formatSpeechBytes(999_600_000), "1.0 GB");
});

test("a recording with no sound at all is told apart from a quiet one", () => {
  assert.equal(speechWavIsSilent(encodeWavPcm16(new Float32Array(16_000))), true);
  assert.equal(speechWavIsSilent(encodeWavPcm16(new Float32Array(16_000).fill(0.001))), true);
  const quiet = new Float32Array(16_000);
  quiet[8_000] = 0.01;
  assert.equal(speechWavIsSilent(encodeWavPcm16(quiet)), false);
});

/** Speech-like sound with a pause of the given length at the given second. */
function speechWithPause(seconds: number, pauseAt: number, pauseSeconds = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(seconds * SPEECH_SAMPLE_RATE));
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / SPEECH_SAMPLE_RATE;
    samples[index] = time >= pauseAt && time < pauseAt + pauseSeconds ? 0 : 0.3 * Math.sin(index / 7);
  }
  return samples;
}

test("a long recording is cut in a pause between the marks, not in a word", () => {
  const samples = speechWithPause(30, 23);
  const cut = quietestCut(samples, SPEECH_SAMPLE_RATE, SPEECH_PIECE_MIN_SECONDS, SPEECH_PIECE_MAX_SECONDS);
  const second = cut / SPEECH_SAMPLE_RATE;
  assert.ok(second > 23 && second < 23.5, `cut at ${second}s`);
});

test("pieces come out while recording, each under the engine's 30 s, and the rest at the end", () => {
  const pieces = new SpeechPieces();
  const recording = speechWithPause(70, 21);
  const out: Float32Array[] = [];
  // As the microphone delivers it: 100 ms at a time.
  for (let offset = 0; offset < recording.length; offset += 1_600) {
    const piece = pieces.push(recording.slice(offset, offset + 1_600));
    if (piece) out.push(piece);
  }
  const rest = pieces.finish();
  assert.ok(out.length >= 2, `${out.length} pieces during the recording`);
  for (const piece of out) assert.ok(piece.length <= SPEECH_PIECE_MAX_SECONDS * SPEECH_SAMPLE_RATE);
  assert.ok(Math.abs(out[0]!.length / SPEECH_SAMPLE_RATE - 21.25) < 0.3, "the first cut is in the pause");
  assert.equal(out.reduce((sum, piece) => sum + piece.length, 0) + rest.length, recording.length, "nothing lost or doubled");
  assert.ok(rest.length < SPEECH_PIECE_MAX_SECONDS * SPEECH_SAMPLE_RATE);
  assert.equal(pieces.finish().length, 0);
});

test("a short recording is one piece, handed over only when she stops", () => {
  const pieces = new SpeechPieces();
  assert.equal(pieces.push(new Float32Array(SPEECH_SAMPLE_RATE * 5)), undefined);
  assert.equal(pieces.finish().length, SPEECH_SAMPLE_RATE * 5);
});

test("pieces' text joins into one paragraph, and the next piece gets the end of it", () => {
  assert.equal(joinTranscripts([" Первая часть.", "", " Second part. "]), "Первая часть. Second part.");
  assert.equal(speechPromptFrom(""), undefined);
  assert.equal(speechPromptFrom("x".repeat(500))!.length, 200);
});

test("the hold key: Option is either side, right Option only the right one, off is nothing", () => {
  const left = { key: "Alt", code: "AltLeft" };
  const right = { key: "Alt", code: "AltRight" };
  assert.equal(isHoldKeyEvent("option", left), true);
  assert.equal(isHoldKeyEvent("option", right), true);
  assert.equal(isHoldKeyEvent("right-option", left), false);
  assert.equal(isHoldKeyEvent("right-option", right), true);
  assert.equal(isHoldKeyEvent("off", left), false);
  assert.equal(isHoldKeyEvent("option", { key: "Meta", code: "MetaLeft" }), false);
});

test("dictated text is spaced from the words around it", () => {
  assert.equal(spacedDictation("Hello", "", "world"), " world");
  assert.equal(spacedDictation("Hello ", ". Next", "world"), "world");
  assert.equal(spacedDictation("", "rest", "Start"), "Start ");
  assert.equal(spacedDictation("a", "b", "   "), "");
});
