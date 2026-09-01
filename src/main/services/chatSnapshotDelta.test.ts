import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildConversationSnapshot, cloneConversationBody, snapshotRowsBytes } from "./chatSnapshotDelta";
import type { ChatMessage, Conversation } from "../../shared/types";

function message(id: string, content: string, index: number): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    metadata: { runId: `run-${id}` }
  };
}

function conversation(messages: ChatMessage[]): Conversation {
  return {
    id: "chat-1",
    title: "Chat",
    kind: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages,
    findings: [],
    metadata: { participants: [] }
  } as unknown as Conversation;
}

test("the first snapshot of a conversation is a full update and a deep copy", () => {
  const live = conversation([message("m1", "one", 1), message("m2", "two", 2)]);
  const built = buildConversationSnapshot(live, undefined, 1);
  assert.equal(built.update.messageDelta, undefined);
  assert.deepEqual(built.update.messages.map((item) => item.id), ["m1", "m2"]);
  assert.deepEqual(built.changedMessageIds, ["m1", "m2"]);
  assert.deepEqual(built.removedMessageIds, []);
  assert.notEqual(built.snapshot.messages[0], live.messages[0]);
  assert.deepEqual(built.snapshot.messages[0], live.messages[0]);
  live.messages[0].content = "edited after the build";
  assert.equal(built.snapshot.messages[0].content, "one");
  assert.equal(built.snapshot.metadata, built.snapshot.metadata);
  assert.notEqual(built.snapshot.metadata, live.metadata);
});

test("the next snapshot reuses unchanged rows and describes the delta", () => {
  const first = buildConversationSnapshot(conversation([message("m1", "one", 1), message("m2", "two", 2), message("m3", "three", 3)]), undefined, 2);
  const next = conversation([message("m1", "one", 1), message("m2", "two changed", 2), message("m4", "four", 4)]);
  const built = buildConversationSnapshot(next, first.rows, 2);
  assert.equal(built.rows[0], first.rows[0], "unchanged row object is reused");
  assert.equal(built.snapshot.messages[0], first.snapshot.messages[0], "unchanged parsed message is shared");
  assert.notEqual(built.snapshot.messages[1], first.snapshot.messages[1]);
  assert.deepEqual(built.changedMessageIds, ["m2", "m4"]);
  assert.deepEqual(built.removedMessageIds, ["m3"]);
  assert.deepEqual(built.update.messageDelta, { totalMessages: 3, tailCount: 2, removedIds: ["m3"] });
  assert.deepEqual(built.update.messages.map((item) => item.id), ["m2", "m4"]);
  assert.deepEqual(built.snapshot.messages.map((item) => item.id), ["m1", "m2", "m4"]);
});

test("a changed message outside the newest window travels ahead of the window", () => {
  const messages = [1, 2, 3, 4, 5].map((index) => message(`m${index}`, `text ${index}`, index));
  const first = buildConversationSnapshot(conversation(messages), undefined, 2);
  const next = conversation(messages.map((item) => item.id === "m1" ? { ...item, content: "text 1 edited" } : item));
  const built = buildConversationSnapshot(next, first.rows, 2);
  assert.deepEqual(built.update.messages.map((item) => item.id), ["m1", "m4", "m5"]);
  assert.deepEqual(built.update.messageDelta, { totalMessages: 5, tailCount: 2, removedIds: [] });
  assert.deepEqual(built.changedMessageIds, ["m1"]);
});

test("a body-only change still emits the newest window so the receiver re-anchors", () => {
  const messages = [1, 2, 3].map((index) => message(`m${index}`, `text ${index}`, index));
  const first = buildConversationSnapshot(conversation(messages), undefined, 2);
  const next = { ...conversation(messages), title: "Renamed" };
  const built = buildConversationSnapshot(next, first.rows, 2);
  assert.equal(built.update.title, "Renamed");
  assert.deepEqual(built.update.messages.map((item) => item.id), ["m2", "m3"]);
  assert.deepEqual(built.changedMessageIds, []);
  assert.equal(built.rows[0], first.rows[0]);
});

test("rows carry the json and sha1 storage would compute itself", () => {
  const live = conversation([message("m1", "one", 1)]);
  const built = buildConversationSnapshot(live, undefined);
  const json = JSON.stringify(live.messages[0]);
  assert.equal(built.rows[0].json, json);
  assert.equal(built.rows[0].hash, createHash("sha1").update(json).digest("hex"));
  assert.equal(JSON.stringify(built.snapshot.messages[0]), json, "the parsed copy re-serializes identically");
});

test("an insertion ahead of unchanged messages shifts their index but keeps their rows", () => {
  const first = buildConversationSnapshot(conversation([message("m1", "one", 1), message("m2", "two", 2)]), undefined, 5);
  const next = conversation([message("m0", "zero", 0), message("m1", "one", 1), message("m2", "two", 2)]);
  const built = buildConversationSnapshot(next, first.rows, 5);
  assert.deepEqual(built.rows.map((row) => [row.id, row.index]), [["m0", 0], ["m1", 1], ["m2", 2]]);
  assert.equal(built.rows[1].hash, first.rows[0].hash);
  assert.equal(built.rows[1].message, first.rows[0].message);
  assert.deepEqual(built.changedMessageIds, ["m0"]);
  assert.deepEqual(built.update.messages.map((item) => item.id), ["m0", "m1", "m2"]);
});

test("edge cases: an empty conversation, an empty previous row set, and every message removed", () => {
  const empty = buildConversationSnapshot(conversation([]), undefined);
  assert.deepEqual(empty.update.messages, []);
  assert.equal(empty.update.messageDelta, undefined);
  const fromEmptyRows = buildConversationSnapshot(conversation([message("m1", "one", 1)]), []);
  assert.deepEqual(fromEmptyRows.update.messageDelta, { totalMessages: 1, tailCount: 1, removedIds: [] });
  assert.deepEqual(fromEmptyRows.changedMessageIds, ["m1"]);
  const allRemoved = buildConversationSnapshot(conversation([]), fromEmptyRows.rows);
  assert.deepEqual(allRemoved.update.messageDelta, { totalMessages: 0, tailCount: 0, removedIds: ["m1"] });
  assert.deepEqual(allRemoved.update.messages, []);
  assert.equal(snapshotRowsBytes(fromEmptyRows.rows), fromEmptyRows.rows[0].json.length);
  const body = cloneConversationBody(conversation([message("m1", "one", 1)]));
  assert.deepEqual(body.messages, []);
  assert.equal(body.title, "Chat");
});
