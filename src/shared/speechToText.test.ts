import assert from "node:assert/strict";
import test from "node:test";

import {
  SPEECH_SAMPLE_RATE,
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
});

test("a recording with no sound at all is told apart from a quiet one", () => {
  assert.equal(speechWavIsSilent(encodeWavPcm16(new Float32Array(16_000))), true);
  assert.equal(speechWavIsSilent(encodeWavPcm16(new Float32Array(16_000).fill(0.001))), true);
  const quiet = new Float32Array(16_000);
  quiet[8_000] = 0.01;
  assert.equal(speechWavIsSilent(encodeWavPcm16(quiet)), false);
});
