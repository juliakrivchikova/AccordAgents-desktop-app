import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_UPDATE_TAIL_SIZE,
  applyConversationUpdate,
  chatActivityItemsForUnknownMessages,
  conversationFromUpdate,
  fullListMessagePageInfo,
  messagePageAfterUpdate
} from "./conversationUpdates";
import type { ChatActivityItem, ChatMessage, Conversation, ConversationSummary, ConversationUpdate } from "./types";
import { reconcileConversationSummaryRefresh } from "./conversationSummary";

test("a startup or approval refresh cannot overwrite newer pushed chat outcomes or archive state", () => {
  const summary = (id: string, patch: Partial<ConversationSummary> = {}): ConversationSummary => ({
    id, title: id, kind: "chat", createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z", ...patch
  });
  const result = reconcileConversationSummaryRefresh(
    [summary("done", { running: false }), summary("archived", { archived: true }), summary("new"), summary("unchanged")],
    [summary("done", { running: true }), summary("archived", { archived: false }), summary("deleted"), summary("unchanged", { title: "fresh title" })],
    { done: 1 }, { done: 2, archived: 1, deleted: 1, new: 1 }
  );
  assert.equal(result.find(item => item.id === "done")?.running, false);
  assert.equal(result.find(item => item.id === "archived")?.archived, true);
  assert.ok(result.some(item => item.id === "new"));
  assert.ok(!result.some(item => item.id === "deleted"));
  assert.equal(result.find(item => item.id === "unchanged")?.title, "fresh title");
});

function message(id: string, content: string, index: number): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    metadata: {}
  };
}

function conversation(messages: ChatMessage[], id = "chat-1", kind: Conversation["kind"] = "chat"): Conversation {
  return {
    id,
    title: "Chat",
    kind,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages,
    findings: [],
    metadata: {}
  } as unknown as Conversation;
}

function ids(conv: Conversation): string[] {
  return conv.messages.map((item) => item.id);
}

function range(from: number, to: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let index = from; index <= to; index += 1) {
    out.push(message(`m${index}`, `text ${index}`, index));
  }
  return out;
}

test("a full update on a small chat replaces the loaded messages and reports a complete page", () => {
  const current = conversation([message("old", "old", 1)]);
  const update: ConversationUpdate = conversation([message("a", "a", 1), message("b", "b", 2)]);
  const applied = applyConversationUpdate(current, update);
  assert.deepEqual(ids(applied.conversation), ["a", "b"]);
  assert.equal(applied.source, "full");
  assert.deepEqual(messagePageAfterUpdate(undefined, applied), { oldestSequence: 0, newestSequence: 1, hasMoreBefore: false, totalMessages: 2 });
});

test("a full update on a chat whose window is a partial page keeps only the newest messages", () => {
  const all = range(1, 300);
  const current = conversation(all.slice(-CONVERSATION_UPDATE_TAIL_SIZE));
  const applied = applyConversationUpdate(current, conversation([...all, message("m301", "new", 301)]));
  assert.equal(applied.source, "trimmed");
  assert.equal(applied.conversation.messages.length, CONVERSATION_UPDATE_TAIL_SIZE);
  assert.equal(applied.conversation.messages.at(-1)?.id, "m301");
  assert.equal(applied.totalMessages, 301);
  const previous = { totalMessages: 300, oldestSequence: 220, newestSequence: 299, hasMoreBefore: true };
  assert.deepEqual(messagePageAfterUpdate(previous, applied), { totalMessages: 301, hasMoreBefore: true, oldestSequence: 221, newestSequence: 300 });
});

test("a full update keeps a larger window the user scrolled into, and never trims below one page", () => {
  const all = range(1, 300);
  const scrolled = applyConversationUpdate(conversation(all.slice(-150)), conversation(all));
  assert.equal(scrolled.conversation.messages.length, 150);
  const tiny = applyConversationUpdate(conversation(all.slice(-5)), conversation(all));
  assert.equal(tiny.conversation.messages.length, CONVERSATION_UPDATE_TAIL_SIZE);
  const complete = applyConversationUpdate(conversation(range(1, 30)), conversation(range(1, 31)));
  assert.equal(complete.source, "full");
  assert.equal(complete.conversation.messages.length, 31);
});

test("a full update on a non-chat conversation is never trimmed", () => {
  const applied = applyConversationUpdate(conversation(range(1, 10), "review-1", "code-review"), conversation(range(1, 200), "review-1", "code-review"));
  assert.equal(applied.source, "full");
  assert.equal(applied.conversation.messages.length, 200);
});

test("a delta replaces changed messages in place, drops removed ones and re-anchors the window", () => {
  const current = conversation([message("m3", "three", 3), message("m4", "four", 4), message("m5", "five", 5), message("m6", "six", 6)]);
  const update: ConversationUpdate = {
    ...conversation([message("m4", "four edited", 4), message("m6", "six", 6), message("m7", "seven", 7)]),
    messageDelta: { totalMessages: 6, tailCount: 2, removedIds: ["m5"] }
  };
  const applied = applyConversationUpdate(current, update);
  assert.deepEqual(ids(applied.conversation), ["m3", "m4", "m6", "m7"]);
  assert.equal(applied.conversation.messages[1].content, "four edited");
  assert.equal(applied.conversation.messages[0], current.messages[0], "untouched messages keep their identity");
  assert.equal(applied.source, "delta");
  const previous = { totalMessages: 6, oldestSequence: 2, newestSequence: 5, hasMoreBefore: true };
  assert.deepEqual(messagePageAfterUpdate(previous, applied), { totalMessages: 6, hasMoreBefore: true, oldestSequence: 2, newestSequence: 5 });
});

test("a delta keeps the window's oldest loaded sequence rather than recounting from the tail", () => {
  // Window loaded from an activity target: sequences 10..12 plus the newest 2.
  const current = conversation([...range(10, 12), ...range(99, 100)]);
  const update: ConversationUpdate = {
    ...conversation(range(100, 101)),
    messageDelta: { totalMessages: 102, tailCount: 2, removedIds: [] }
  };
  const applied = applyConversationUpdate(current, update);
  assert.deepEqual(ids(applied.conversation), ["m10", "m11", "m12", "m99", "m100", "m101"]);
  const previous = { totalMessages: 101, oldestSequence: 9, newestSequence: 100, hasMoreBefore: true };
  assert.deepEqual(messagePageAfterUpdate(previous, applied), { totalMessages: 102, hasMoreBefore: true, oldestSequence: 9, newestSequence: 101 });
});

test("a delta onto a window that already holds everything reports a complete page", () => {
  const current = conversation([message("m1", "one", 1), message("m2", "two", 2)]);
  const update: ConversationUpdate = {
    ...conversation([message("m2", "two", 2), message("m3", "three", 3)]),
    messageDelta: { totalMessages: 3, tailCount: 2, removedIds: [] }
  };
  const applied = applyConversationUpdate(current, update);
  assert.deepEqual(ids(applied.conversation), ["m1", "m2", "m3"]);
  assert.deepEqual(messagePageAfterUpdate({ totalMessages: 2, oldestSequence: 0, newestSequence: 1, hasMoreBefore: false }, applied), fullListMessagePageInfo(3));
});

test("a changed message older than the loaded window is left to paging, one inside a gap is placed by time", () => {
  const current = conversation([message("m5", "five", 5), message("m7", "seven", 7), message("m9", "nine", 9)]);
  const update: ConversationUpdate = {
    ...conversation([message("m1", "one edited", 1), message("m6", "six", 6), message("m9", "nine", 9), message("m10", "ten", 10)]),
    messageDelta: { totalMessages: 10, tailCount: 2, removedIds: [] }
  };
  const applied = applyConversationUpdate(current, update);
  assert.deepEqual(ids(applied.conversation), ["m5", "m6", "m7", "m9", "m10"]);
  const previous = { totalMessages: 9, oldestSequence: 4, newestSequence: 8, hasMoreBefore: true };
  assert.deepEqual(messagePageAfterUpdate(previous, applied), { totalMessages: 10, hasMoreBefore: true, oldestSequence: 4, newestSequence: 9 });
});

test("boundary deltas: empty tail, oversized tail count, removed id also in the tail, empty window", () => {
  const current = conversation(range(1, 3));
  const emptyTail = applyConversationUpdate(current, { ...conversation([message("m2", "two edited", 2)]), messageDelta: { totalMessages: 3, tailCount: 0, removedIds: [] } });
  assert.deepEqual(ids(emptyTail.conversation), ["m1", "m2", "m3"]);
  assert.equal(emptyTail.conversation.messages[1].content, "two edited");
  const oversized = applyConversationUpdate(current, { ...conversation(range(2, 4)), messageDelta: { totalMessages: 4, tailCount: 10, removedIds: [] } });
  assert.deepEqual(ids(oversized.conversation), ["m1", "m2", "m3", "m4"]);
  const removedInTail = applyConversationUpdate(current, { ...conversation(range(3, 4)), messageDelta: { totalMessages: 4, tailCount: 2, removedIds: ["m3"] } });
  assert.deepEqual(ids(removedInTail.conversation), ["m1", "m2", "m3", "m4"], "the carried tail wins over a stale removal");
  const emptyWindow = applyConversationUpdate(conversation([]), { ...conversation(range(8, 9)), messageDelta: { totalMessages: 9, tailCount: 2, removedIds: [] } });
  assert.deepEqual(ids(emptyWindow.conversation), ["m8", "m9"]);
  assert.deepEqual(messagePageAfterUpdate(undefined, emptyWindow), { totalMessages: 9, hasMoreBefore: true, oldestSequence: 7, newestSequence: 8 });
});

test("a delta for a different conversation falls back to the carried messages and reports a partial page", () => {
  const update: ConversationUpdate = {
    ...conversation([message("m8", "eight", 8), message("m9", "nine", 9)]),
    messageDelta: { totalMessages: 9, tailCount: 2, removedIds: [] }
  };
  const other = applyConversationUpdate(conversation([message("x", "x", 1)], "chat-2"), update);
  assert.deepEqual(ids(other.conversation), ["m8", "m9"]);
  assert.equal(other.conversation.id, "chat-1");
  assert.deepEqual(messagePageAfterUpdate(undefined, other), { totalMessages: 9, hasMoreBefore: true, oldestSequence: 7, newestSequence: 8 });
});

test("the delta descriptor never leaks into the conversation handed to consumers", () => {
  const update: ConversationUpdate = {
    ...conversation([message("m1", "one", 1)]),
    messageDelta: { totalMessages: 1, tailCount: 1, removedIds: [] }
  };
  assert.equal("messageDelta" in conversationFromUpdate(update), false);
  assert.equal("messageDelta" in applyConversationUpdate(conversation([]), update).conversation, false);
  assert.equal("messageDelta" in applyConversationUpdate(conversation([message("m1", "one", 1)]), update).conversation, false);
});

test("activity items for messages a delta did not carry are kept; run, approval and removed ones are not", () => {
  const item = (id: string, kind: ChatActivityItem["kind"], messageId?: string, conversationId = "chat-1"): ChatActivityItem => ({
    id,
    conversationId,
    conversationTitle: "Chat",
    status: "pending",
    kind,
    title: id,
    preview: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    target: { messageId }
  });
  const items = [
    item("keep-unknown", "mention", "m1"),
    item("drop-known", "mention", "m2"),
    item("drop-removed", "message", "m3"),
    item("drop-run", "run", "m1"),
    item("drop-approval", "approval", "m1"),
    item("drop-no-message", "message", undefined),
    item("drop-other-chat", "mention", "m1", "chat-2")
  ];
  assert.deepEqual(
    chatActivityItemsForUnknownMessages(items, "chat-1", new Set(["m2"]), ["m3"]).map((entry) => entry.id),
    ["keep-unknown"]
  );
});
