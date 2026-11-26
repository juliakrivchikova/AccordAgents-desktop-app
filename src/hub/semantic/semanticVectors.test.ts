import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../../shared/types";
import {
  MESSAGE_MAX_PASSAGES, MESSAGE_PASSAGE_CHARS, PrintArena, decodePrint, encodePrint, messagePassages, notePassages, passageRanges, printableText,
  queryPrint, shortenPrint
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
    const arena = new PrintArena(dims, 4);
    const slot = arena.add(decodePrint(encodePrint(shortenPrint(b, dims)), dims)!);
    assert.ok(Math.abs(arena.closeness(queryPrint(a, dims), slot) - cosine(a, b, dims)) < 0.01);
  }
  assert.equal(decodePrint(encodePrint(shortenPrint(random(2), 512)), 1536), undefined);
  const arena = new PrintArena(512, 4);
  assert.equal(arena.closeness(queryPrint(random(3), 512), arena.add(new Int8Array(512))), 0);
});

test("prints share big blocks: a freed slot is used again, and a sparse arena copies its live prints into a fresh one", () => {
  const dims = 8;
  const arena = new PrintArena(dims, 4);
  const print = (seed: number) => Int8Array.from({ length: dims }, (_, index) => ((seed * 31 + index * 7) % 200) - 100);
  const slots = Array.from({ length: 10 }, (_, index) => arena.add(print(index)));
  assert.equal(arena.size, 10);
  assert.equal(arena.capacity, 12);
  const query = queryPrint(Array.from(print(2)), dims);
  const before = arena.closeness(query, slots[2]);
  assert.ok(before > 0.99);
  for (const slot of slots.slice(3)) arena.release(slot);
  assert.equal(arena.size, 3);
  assert.equal(arena.add(print(42)), slots[9], "the last freed slot is used first");
  arena.release(slots[9]);
  assert.ok(arena.sparse());
  const fresh = new PrintArena(dims, 4);
  const moved = slots.slice(0, 3).map((slot) => arena.copyTo(slot, fresh));
  assert.equal(fresh.size, 3);
  assert.equal(fresh.capacity, 4);
  assert.ok(Math.abs(fresh.closeness(query, moved[2]) - before) < 1e-6);
  assert.ok(!fresh.sparse());
  // A slot that is no slot (a hole in a print missing a passage) is ignored.
  fresh.release(undefined as unknown as number);
  fresh.release(99);
  assert.equal(fresh.size, 3);
});

test("only a message the chat shows, with text, is printed: the User's, or a member's finished reply with its posts", () => {
  const message = (fields: Partial<ChatMessage> & { status?: string }) => ({ role: "user" as ChatMessage["role"], content: "", ...fields });
  assert.equal(printableText(message({ content: "Deploy it" })), "Deploy it");
  assert.equal(printableText(message({ role: "participant", status: "done", content: "Done." })), "Done.");
  assert.equal(printableText(message({ role: "participant", status: "pending", content: "Working" })), undefined);
  assert.equal(printableText(message({ role: "participant", status: "error", content: "Failed" })), undefined);
  assert.equal(printableText(message({ role: "system", content: "Chat started." })), undefined);
  assert.equal(printableText(message({ content: "ok go", metadata: { hiddenFromTimeline: true } as ChatMessage["metadata"] })), undefined);
  assert.equal(printableText(message({ content: " " })), undefined);
  // What the chat hides: a member's line waiting for approval, a request written for another member.
  assert.equal(printableText(message({ role: "participant", status: "done", content: "Waiting for user approval." })), undefined);
  assert.equal(printableText(message({ content: "Check the deploy", metadata: { participantRequest: { source: "inferred" } } as unknown as ChatMessage["metadata"] })), undefined);
  // A member's posts during its turn are shown with the reply, and found with it.
  const posts = [{ id: "p1", content: "Found the cause: the token expired.", createdAt: "2026-11-26T10:00:00.000Z" }];
  const text = printableText(message({ role: "participant", status: "done", content: "Fixed.", metadata: { interimPosts: posts } as unknown as ChatMessage["metadata"] }));
  assert.match(text ?? "", /token expired[\s\S]*Fixed\./);
});
