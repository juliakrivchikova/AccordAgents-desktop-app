import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage } from "../../shared/types";
import { TIMELINE_ANCHOR_MAX_HOPS, visibleTimelineAnchor } from "./activity-timeline-anchor";

/**
 * Activity's "Open in chat" never aims at a message the chat draws no row
 * for: it goes on to what that message answers, loading it when needed.
 */

const at = "2026-11-04T19:00:00.000Z";
// The User's message the card answers; the card's threadId names it, and the pick copies that threadId.
const ask: ChatMessage = { id: "ask", role: "user", content: "@taylor which store?", createdAt: at, status: "done" };
const card: ChatMessage = { id: "card", role: "participant", participantId: "taylor", content: "Pick one.", createdAt: at, status: "done",
  metadata: { threadId: "ask", parentMessageId: "ask", sourceMessageId: "ask",
    pendingChoice: { id: "c", title: "Store", question: "Which?", options: [{ id: "a", label: "A" }], status: "selected" } } };
// As ChatService.respondToChoice writes the User's pick for a card on the main timeline.
const pick: ChatMessage = { id: "pick", role: "user", content: "Choice selected.", createdAt: at, status: "done",
  metadata: { threadId: "ask", parentMessageId: "card", sourceMessageId: "card", hiddenFromTimeline: true } };
const reply: ChatMessage = { id: "reply", role: "participant", participantId: "taylor", content: "Going with A.", createdAt: at, status: "done",
  metadata: { parentMessageId: "pick", sourceMessageId: "pick", approvedContinuation: true } };
// A Codex approval's control message, resumed inside that reply's turn.
const control: ChatMessage = { id: "control", role: "user", content: "approve", createdAt: at, status: "done",
  metadata: { threadId: "ask", parentMessageId: "pick", sourceMessageId: "pick", hiddenFromTimeline: true } };
// As ChatService writes an auto-watch trigger for a message on the main timeline.
const autoWatchTrigger: ChatMessage = { id: "trigger", role: "system", content: "New messages.", createdAt: at, status: "done",
  metadata: { threadId: "latest", parentMessageId: "latest", sourceMessageId: "latest", hiddenFromTimeline: true,
    autoWatchTrigger: { participantId: "taylor", reason: "message", messageIds: ["latest"] } } as ChatMessage["metadata"] };
const latest: ChatMessage = { id: "latest", role: "user", content: "hello", createdAt: at, status: "done" };

function pages(all: ChatMessage[]) {
  const loads: string[] = [];
  const load = async (messageId: string, messages: ChatMessage[]): Promise<ChatMessage[] | undefined> => {
    loads.push(messageId);
    const found = all.find((message) => message.id === messageId);
    return found ? [...messages, found] : undefined;
  };
  return { loads, load };
}

test("a shown message is opened as it is, nothing more is read", async () => {
  const { loads, load } = pages([]);
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [ask, card, pick, reply] }, messageId: "reply", load }), "reply");
  assert.deepEqual(loads, []);
});

test("the User's hidden pick opens at the card it answers", async () => {
  const { load } = pages([]);
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [ask, card, pick, reply] }, messageId: "pick", fallbackMessageId: "reply", load }), "card");
});

test("the card is read when it is not loaded yet", async () => {
  const { loads, load } = pages([card]);
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [ask, pick, reply] }, messageId: "pick", load }), "card");
  assert.deepEqual(loads, ["card"]);
});

test("two hidden messages in a row: an approval inside a choice answer still opens at the card", async () => {
  const { load } = pages([]);
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [ask, card, pick, control] }, messageId: "control", load }), "card");
});

test("a hidden app trigger opens at the message it follows", async () => {
  const { load } = pages([latest]);
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [autoWatchTrigger] }, messageId: "trigger", load }), "latest");
});

test("a chain that reaches nothing shown opens the Activity item's own message", async () => {
  const { load } = pages([reply]);
  const orphan: ChatMessage = { ...pick, metadata: { ...pick.metadata, parentMessageId: "gone", sourceMessageId: "gone" } };
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [orphan] }, messageId: "pick", fallbackMessageId: "reply", load }), "reply");
});

test("hidden messages pointing at each other end the walk instead of looping", async () => {
  const { load } = pages([]);
  const a: ChatMessage = { ...pick, id: "a", metadata: { hiddenFromTimeline: true, parentMessageId: "b" } };
  const b: ChatMessage = { ...pick, id: "b", metadata: { hiddenFromTimeline: true, parentMessageId: "a" } };
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [a, b] }, messageId: "a", load }), undefined);
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [a, b, reply] }, messageId: "a", fallbackMessageId: "reply", load }), "reply");
});

test("a message that cannot be read ends the walk without an error", async () => {
  const load = async (): Promise<ChatMessage[] | undefined> => undefined;
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [pick] }, messageId: "pick", load }), undefined);
});

test("a reply drawn only in a thread opens at the thread's root on the timeline", async () => {
  const { load } = pages([]);
  const root: ChatMessage = { ...latest, id: "root" };
  const threadReply: ChatMessage = { ...reply, id: "thread-reply", metadata: { chatThreadRootId: "root", parentMessageId: "root" } };
  const orphan: ChatMessage = { ...pick, metadata: { hiddenFromTimeline: true, parentMessageId: "gone" } };
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [root, threadReply] }, messageId: "thread-reply", load }), "root");
  // The fallback is walked the same way.
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [root, threadReply, orphan] }, messageId: "pick", fallbackMessageId: "thread-reply", load }), "root");
});

test("it goes past at most TIMELINE_ANCHOR_MAX_HOPS messages without a row", async () => {
  const { load } = pages([]);
  const chain = (length: number): ChatMessage[] => Array.from({ length }, (_, index): ChatMessage => ({
    ...pick, id: `h${index}`, metadata: { hiddenFromTimeline: true, parentMessageId: index === length - 1 ? "card" : `h${index + 1}` }
  }));
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [ask, card, ...chain(TIMELINE_ANCHOR_MAX_HOPS)] }, messageId: "h0", load }), "card");
  assert.equal(await visibleTimelineAnchor({ conversation: { messages: [ask, card, ...chain(TIMELINE_ANCHOR_MAX_HOPS + 1)] }, messageId: "h0", load }), undefined);
});
