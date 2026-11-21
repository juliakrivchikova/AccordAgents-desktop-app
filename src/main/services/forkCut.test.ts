import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeForkCut, codexForkCut, FORK_CUT_COMPACTED, FORK_CUT_NO_TURN_BY_THEN, FORK_CUT_NOT_IN_SESSION, isForkCutMissingError, uuidV7Ms
} from "./forkCut";

// Fork to new chat: the copy ends with the turn of the reply the User saw
// last (docs/main-session.md). Transcript lines are shaped as Claude Code
// 2.1.329 writes them (checked on a throwaway session, 2026-11-21).

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

const user = (uuid: string, timestamp: string, text: string, extra: Record<string, unknown> = {}) =>
  line({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: text }, uuid, timestamp, ...extra });
const assistant = (uuid: string, timestamp: string, text: string, extra: Record<string, unknown> = {}) =>
  line({ parentUuid: "p", isSidechain: false, type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, uuid, timestamp, ...extra });
const attachment = (uuid: string, timestamp: string) => line({ parentUuid: "p", isSidechain: false, type: "attachment", uuid, timestamp });
const compact = (uuid: string, timestamp: string) => line({ parentUuid: null, type: "system", subtype: "compact_boundary", uuid, timestamp });

/** Two turns: "remember APPLE" (its assistant message a1), then "remember BANANA" (a2). */
function twoTurns(): string[] {
  return [
    line({ type: "queue-operation", timestamp: "2026-11-21T16:23:41.166Z" }),
    user("u1", "2026-11-21T16:23:41.220Z", "Remember the code word APPLE."),
    attachment("x1", "2026-11-21T16:23:41.241Z"),
    line({ type: "api-request", timestamp: "2026-11-21T16:23:41.279Z" }),
    assistant("a1", "2026-11-21T16:23:42.531Z", "OK"),
    attachment("x2", "2026-11-21T16:23:42.542Z"),
    line({ type: "last-prompt" }),
    user("u2", "2026-11-21T16:23:48.684Z", "Also remember the code word BANANA."),
    assistant("a2", "2026-11-21T16:23:49.905Z", "OK"),
    line({ type: "cost-state" })
  ];
}

test("claude: the copy ends at the reply's recorded assistant message when the member went on after it", () => {
  assert.deepEqual(claudeForkCut(twoTurns().join("\n"), { at: "a1" }), { kind: "cut", at: "a1" });
});

test("claude: nothing of the conversation after that message: the point is given all the same (the copy is all of it, and a turn started meanwhile stays out)", () => {
  assert.deepEqual(claudeForkCut(twoTurns().join("\n"), { at: "a2" }), { kind: "cut", at: "a2" });
  // Trailing bookkeeping (attachments, costs) is not the conversation.
  assert.deepEqual(claudeForkCut([...twoTurns(), attachment("x3", "2026-11-21T16:23:50.000Z")].join("\n"), { at: "a2" }), { kind: "cut", at: "a2" });
});

test("claude: a reply from before the point was recorded is matched by its finish on the same clock", () => {
  // The first reply finished just after a1 was written; the second turn started later.
  assert.deepEqual(claudeForkCut(twoTurns().join("\n"), { finishedBy: "2026-11-21T16:23:42.700Z" }), { kind: "cut", at: "a1" });
  assert.deepEqual(claudeForkCut(twoTurns().join("\n"), { finishedBy: "2026-11-21T16:23:50.000Z" }), { kind: "cut", at: "a2" });
  assert.deepEqual(claudeForkCut(twoTurns().join("\n"), { finishedBy: "2026-11-21T16:23:40.000Z" }), { kind: "missed", reason: FORK_CUT_NO_TURN_BY_THEN });
});

test("claude: a compaction after the reply cannot be cut before (the CLI does not load it): the whole session, said", () => {
  const compacted = [...twoTurns(), compact("c1", "2026-11-21T16:30:00.000Z"), user("u3", "2026-11-21T16:30:00.100Z", "This session is being continued…")];
  assert.deepEqual(claudeForkCut(compacted.join("\n"), { at: "a1" }), { kind: "missed", reason: FORK_CUT_COMPACTED });
  // A compaction before the reply is no obstacle.
  const before = [compact("c0", "2026-11-21T16:00:00.000Z"), ...twoTurns()];
  assert.deepEqual(claudeForkCut(before.join("\n"), { at: "a1" }), { kind: "cut", at: "a1" });
});

test("claude: a point not in the session here, or nothing to go by, is said, never guessed", () => {
  assert.deepEqual(claudeForkCut(twoTurns().join("\n"), { at: "elsewhere" }), { kind: "missed", reason: FORK_CUT_NOT_IN_SESSION });
  assert.deepEqual(claudeForkCut(twoTurns().join("\n"), {}), { kind: "missed", reason: FORK_CUT_NO_TURN_BY_THEN });
  // A user message's uuid is not a point (the flag takes an assistant message).
  assert.deepEqual(claudeForkCut(twoTurns().join("\n"), { at: "u2" }), { kind: "missed", reason: FORK_CUT_NOT_IN_SESSION });
});

test("claude: a subagent's messages are not the conversation's", () => {
  const withSubagent = [...twoTurns(), assistant("sub", "2026-11-21T16:24:00.000Z", "sub work", { isSidechain: true })];
  assert.deepEqual(claudeForkCut(withSubagent.join("\n"), { at: "a2" }), { kind: "cut", at: "a2" });
  assert.deepEqual(claudeForkCut(withSubagent.join("\n"), { at: "sub" }), { kind: "missed", reason: FORK_CUT_NOT_IN_SESSION });
});

test("claude: lines that are not JSON are skipped", () => {
  assert.deepEqual(claudeForkCut(["{\"type\":\"user\" broken", ...twoTurns()].join("\n"), { at: "a1" }), { kind: "cut", at: "a1" });
});

// Turn ids as Codex 0.155.1 made them on a throwaway thread (2026-11-21):
// UUIDv7, made when the turn started.
const TURN_1 = "01a1feed-3311-7760-8525-235aaa841192"; // started 16:25:20.401Z, completed 16:25:25
const TURN_2 = "01a1feed-46a3-71b1-91a2-bdb954f85164"; // started 16:25:25.411Z, completed 16:25:27

test("codex: a turn id says when it started", () => {
  assert.equal(new Date(uuidV7Ms(TURN_1)!).toISOString(), "2026-11-21T16:25:20.401Z");
  assert.equal(uuidV7Ms("8c1f0a6e-5c1b-4a8e-9f00-1b2c3d4e5f60"), undefined, "a UUIDv4 does not");
  assert.equal(uuidV7Ms("turn-1"), undefined);
});

test("codex: a reply from before its turn was recorded ends with the last turn that started before it finished", () => {
  const turns = [
    { id: TURN_2, status: "completed", startedAt: 1795278325, completedAt: 1795278327 },
    { id: TURN_1, status: "completed", startedAt: 1795278320, completedAt: 1795278325 }
  ];
  // The first reply was written at 16:25:25.409, between turn 1's end and turn 2's start.
  assert.deepEqual(codexForkCut(turns, "2026-11-21T16:25:25.409Z", true), { kind: "cut", at: TURN_1 });
  assert.deepEqual(codexForkCut(turns, "2026-11-21T16:25:27.900Z", true), { kind: "cut", at: TURN_2 }, "the newest: given all the same, so a turn started meanwhile stays out");
  assert.deepEqual(codexForkCut(turns, "2026-11-21T16:25:00.000Z", true), { kind: "missed", reason: FORK_CUT_NO_TURN_BY_THEN });
  assert.equal(codexForkCut(turns, "2026-11-21T16:25:00.000Z", false), undefined, "older turns may still be listed");
});

test("codex: a turn still running is never the point, and ids that do not say when go by their completion", () => {
  const running = [{ id: "01a1fef0-0000-7000-8000-000000000000", status: "inProgress", startedAt: 1795278400, completedAt: null },
    { id: TURN_2, status: "completed", startedAt: 1795278325, completedAt: 1795278327 }];
  assert.deepEqual(codexForkCut(running, "2026-11-21T16:30:00.000Z", true), { kind: "cut", at: TURN_2 });
  const plain = [{ id: "t-2", status: "completed", startedAt: 1795278325, completedAt: 1795278327 },
    { id: "t-1", status: "failed", startedAt: 1795278320, completedAt: 1795278325 }];
  assert.deepEqual(codexForkCut(plain, "2026-11-21T16:25:25.409Z", true), { kind: "cut", at: "t-1" });
});

test("the CLIs refuse an unknown point in their own words, and only those count", () => {
  assert.equal(isForkCutMissingError("claude warm process exited with code 1: No message found with message.uuid of: 00000000-0000-4000-8000-000000000000"), true);
  assert.equal(isForkCutMissingError("{\"code\":-32600,\"message\":\"turn not found: 019a0000-0000-7000-8000-000000000000\"}"), true);
  for (const other of ["No conversation found with session ID: x", "Model not found", undefined]) {
    assert.equal(isForkCutMissingError(other), false, String(other));
  }
});
