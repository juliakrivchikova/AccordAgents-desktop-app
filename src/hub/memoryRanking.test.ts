import assert from "node:assert/strict";
import test from "node:test";
import { memoryProjectName, memoryProjectsNamed } from "../shared/memory";
import { NEAR_MEANING_LEAD, NEAR_WORDS_FACTOR, nearFirst, pickedNearFirst } from "./memoryRanking";

const entry = (item: string, score: number, near: boolean) => ({ item, score, near });

test("the chat's own notes come first at similar scores, a clearly better global one still leads, and equal ones keep their order", () => {
  assert.deepEqual(nearFirst([entry("global", 0.5, false), entry("own", 0.5 - NEAR_MEANING_LEAD + 0.001, true)], "meaning"), ["own", "global"]);
  assert.deepEqual(nearFirst([entry("global", 0.5, false), entry("own", 0.5 - NEAR_MEANING_LEAD - 0.01, true)], "meaning"), ["global", "own"]);
  assert.deepEqual(nearFirst([entry("global", 10, false), entry("own", 10 / NEAR_WORDS_FACTOR + 0.01, true)], "words"), ["own", "global"]);
  assert.deepEqual(nearFirst([entry("global", 10, false), entry("own", 10 / NEAR_WORDS_FACTOR - 0.5, true)], "words"), ["global", "own"]);
  assert.deepEqual(nearFirst([entry("a", 0.3, false), entry("b", 0.3, false), entry("c", 0.3, false)], "meaning"), ["a", "b", "c"]);
  assert.deepEqual(nearFirst([], "words"), []);
});

test("picks: each close enough by itself, near the best once the chat's own lead, at most a few, the ones given already left out", () => {
  const rule = { min: 0.4, gap: 0.07, max: 2 };
  const picked = (scored: Array<ReturnType<typeof entry>>, skip?: (item: string) => boolean) => pickedNearFirst(scored, rule, skip).map((item) => item.item);
  assert.deepEqual(picked([entry("global", 0.47, false), entry("own", 0.45, true)]), ["own", "global"]);
  // Never below the bar for the chat's own.
  assert.deepEqual(picked([entry("global", 0.41, false), entry("own", 0.39, true)]), ["global"]);
  // A clearly closer global note leaves a far one of the chat's out.
  assert.deepEqual(picked([entry("global", 0.62, false), entry("own", 0.45, true)]), ["global"]);
  assert.deepEqual(picked([entry("a", 0.5, true), entry("b", 0.5, true), entry("c", 0.5, true)]), ["a", "b"]);
  // One given already still counts as the best: no farther one comes instead.
  assert.deepEqual(picked([entry("shown", 0.6, true), entry("far", 0.45, true)], (item) => item === "shown"), []);
  assert.deepEqual(picked([]), []);
});

test("a project named for a note is one of the User's: that very path, else every folder of that name", () => {
  const projects = ["/work/accord", "/work/other", "/elsewhere/other", "C:\\code\\Win"];
  assert.deepEqual(memoryProjectsNamed("/work/accord/", projects), ["/work/accord"]);
  assert.deepEqual(memoryProjectsNamed("ACCORD", projects), ["/work/accord"]);
  assert.deepEqual(memoryProjectsNamed("other", projects), ["/work/other", "/elsewhere/other"]);
  assert.deepEqual(memoryProjectsNamed("/elsewhere/other", projects), ["/elsewhere/other"]);
  assert.deepEqual(memoryProjectsNamed("win", projects), ["C:\\code\\Win"]);
  assert.deepEqual(memoryProjectsNamed("mctb", projects), []);
  assert.deepEqual(memoryProjectsNamed("  ", projects), []);
  assert.equal(memoryProjectName("/Users/me/IdeaProjects/mctb-all/"), "mctb-all");
});
