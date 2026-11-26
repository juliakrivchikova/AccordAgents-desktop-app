import assert from "node:assert/strict";
import test from "node:test";
import {
  MESSAGE_MAX_PASSAGES, MESSAGE_PASSAGE_CHARS, closeness, decodePrint, encodePrint, messagePassages, notePassages, passageRanges, printableMessage,
  queryPrint, shortenPrint, storedPrint
} from "./semanticVectors";

test("text is cut into passages at a line or a space, never inside a character, and covers it all", () => {
  const text = `${"word ".repeat(300)}\n${"слово ".repeat(300)}`;
  const ranges = passageRanges(text, 1000);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[ranges.length - 1].end, text.length);
  for (let index = 1; index < ranges.length; index += 1) assert.equal(ranges[index].start, ranges[index - 1].end);
  for (const range of ranges) {
    assert.ok(range.end - range.start <= 1000);
    // Ends after a space or a line (the last one ends with the text).
    if (range.end < text.length) assert.match(text[range.end - 1], /\s/);
  }
  const emoji = "😀".repeat(800);
  for (const range of passageRanges(emoji, 1001)) assert.equal((range.end - range.start) % 2, 0);
  assert.deepEqual(passageRanges("", 100), [{ start: 0, end: 0 }]);
});

test("a long message is printed only so far; empty passages are left out; a note's passages carry its title and tags", () => {
  const long = "x ".repeat(MESSAGE_PASSAGE_CHARS * (MESSAGE_MAX_PASSAGES + 3));
  assert.equal(messagePassages(long).texts.length, MESSAGE_MAX_PASSAGES);
  assert.deepEqual(messagePassages("   ").texts, []);
  const note = notePassages({ title: "Release", tags: ["beta", "ci"], body: "Run the workflow." });
  assert.deepEqual(note.texts, ["Release\nbeta ci\nRun the workflow."]);
});

test("a shortened print of one byte per number keeps the closeness of the whole one", () => {
  const random = (seed: number) => Array.from({ length: 1536 }, (_, index) => Math.sin(seed * 1000 + index * 7.3));
  const cosine = (left: number[], right: number[], dims: number) => {
    let dot = 0; let l = 0; let r = 0;
    for (let index = 0; index < dims; index += 1) { dot += left[index] * right[index]; l += left[index] ** 2; r += right[index] ** 2; }
    return dot / Math.sqrt(l * r);
  };
  for (const dims of [1536, 512]) {
    const [a, b] = [random(1), random(1.0004)];
    const kept = storedPrint(decodePrint(encodePrint(shortenPrint(b, dims)), dims)!);
    assert.ok(Math.abs(closeness(queryPrint(a, dims), kept) - cosine(a, b, dims)) < 0.01);
  }
  assert.equal(decodePrint(encodePrint(shortenPrint(random(2), 512)), 1536), undefined);
  assert.equal(closeness(queryPrint(random(3), 512), storedPrint(new Int8Array(512))), 0);
});

test("only a shown message with text is printed: the User's, or a member's finished reply", () => {
  assert.ok(printableMessage({ role: "user", content: "Deploy it" }));
  assert.ok(printableMessage({ role: "participant", status: "done", content: "Done." }));
  assert.ok(!printableMessage({ role: "participant", status: "pending", content: "Working" }));
  assert.ok(!printableMessage({ role: "participant", status: "error", content: "Failed" }));
  assert.ok(!printableMessage({ role: "system", content: "Chat started." }));
  assert.ok(!printableMessage({ role: "user", content: "ok", metadata: { hiddenFromTimeline: true } }));
  assert.ok(!printableMessage({ role: "user", content: " " }));
});
