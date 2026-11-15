import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../../shared/types";
import { choiceAskedAtMs, choiceExpiryPlan, choicesClosedByMessage } from "./chatChoiceExpiry";

/**
 * Which member choices close (the User, 2026-11-15): as soon as a message of
 * hers written after the card started a new turn of the member that asked —
 * she wrote instead of choosing. (Until then a card waited an hour.)
 */

const T0 = Date.parse("2026-11-01T08:00:00.000Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const all = () => true;

function card(id: string, participantId: string, askedAtMinutes: number, extra: Partial<NonNullable<ChatMessage["metadata"]>> = {}): ChatMessage {
  return {
    id, role: "participant", participantId, participantLabel: `@${participantId}`, content: "Pick one.", status: "done", createdAt: iso(askedAtMinutes - 2),
    metadata: { pendingChoice: { id: `choice-${id}`, title: `Which ${id}?`, question: "Which one?", options: [{ id: "a", label: "A" }], status: "pending",
      askedAt: iso(askedAtMinutes) }, ...extra }
  };
}

function user(id: string, minutes: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "user", content: "next", createdAt: iso(minutes), status: "done", ...extra };
}

function turn(id: string, participantId: string, triggerId: string, minutes: number): ChatMessage {
  return { id, role: "participant", participantId, content: "ok", createdAt: iso(minutes), status: "done", metadata: { sourceMessageId: triggerId, parentMessageId: triggerId } };
}

test("a choice closes as soon as the User's next message starts a turn of its member", () => {
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0), user("u1", 1), turn("t1", "taylor", "u1", 1)], all), { due: ["ask"] },
    "a minute later: no hour to wait");
  // The turn is what counts: her message alone, before its member took it, does not close it yet.
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0), user("u1", 1)], all), { due: [] });
});

test("a choice does not close without a later turn of its member started by the User", () => {
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0)], all), { due: [] }, "nothing after it");
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0), user("u1", 10), turn("t1", "drew", "u1", 10)], all), { due: [] },
    "her message started another member");
  const request: ChatMessage = { id: "req", role: "participant", participantId: "drew", content: "@taylor please", createdAt: iso(10), status: "done" };
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0), request, turn("t1", "taylor", "req", 11)], all), { due: [] },
    "another member asked for the turn");
  const script: ChatMessage = { id: "s1", role: "script", content: "feed changed", createdAt: iso(10), status: "done" };
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0), script, turn("t1", "taylor", "s1", 11)], all), { due: [] },
    "a scheduled script woke it");
  // Her message was written before the card appeared (queued behind the
  // reply that asked it): she had not seen the card.
  assert.deepEqual(choiceExpiryPlan([user("u0", -1), card("ask", "taylor", 0), turn("t1", "taylor", "u0", 1)], all), { due: [] },
    "her message came before the card");
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0), user("u1", 10), turn("t1", "taylor", "u1", 10)], () => false), { due: [] },
    "a card this device does not close");
});

test("an answer to another of the member's cards closes the older one, never the card it answers", () => {
  const answer = user("answer", 20, { metadata: { hiddenFromTimeline: true, sourceMessageId: "other" } });
  const messages = [card("ask", "taylor", 0), card("other", "taylor", 5), answer, turn("t1", "taylor", "answer", 20)];
  assert.deepEqual(choiceExpiryPlan(messages, all), { due: ["ask"] }, "while its own selection is still being applied");
  messages[1].metadata!.pendingChoice!.status = "selected";
  assert.deepEqual(choiceExpiryPlan(messages, all), { due: ["ask"] });
});

test("only waiting choices close, each member's by its own turns", () => {
  const answered = card("answered", "taylor", 0);
  answered.metadata!.pendingChoice!.status = "selected";
  const cancelled = card("cancelled", "taylor", 0);
  cancelled.metadata!.pendingChoice!.status = "cancelled";
  const messages = [answered, cancelled, card("taylors", "taylor", 0), card("drews", "drew", 0), user("u1", 10), turn("t1", "taylor", "u1", 10)];
  assert.deepEqual(choiceExpiryPlan(messages, all), { due: ["taylors"] });
});

test("a choice saved before its asking time was kept is timed from the end of its reply", () => {
  const legacy = card("ask", "taylor", 0);
  delete legacy.metadata!.pendingChoice!.askedAt;
  legacy.createdAt = iso(0);
  legacy.metadata!.workedMs = 5 * 60_000;
  assert.equal(choiceAskedAtMs(legacy), T0 + 5 * 60_000);
  delete legacy.metadata!.workedMs;
  assert.equal(choiceAskedAtMs(legacy), T0, "or from the reply itself");
  // A message of hers written while that reply ran does not count.
  const messages = [legacy, user("u1", 3), turn("t1", "taylor", "u1", 6)];
  legacy.metadata!.workedMs = 5 * 60_000;
  assert.deepEqual(choiceExpiryPlan(messages, all), { due: [] });
  messages.push(user("u2", 7), turn("t2", "taylor", "u2", 7));
  assert.deepEqual(choiceExpiryPlan(messages, all), { due: ["ask"] });
});

test("the member's turn is told which of its cards the User's message closed, once", () => {
  const u1 = user("u1", 10);
  const messages = [card("ask", "taylor", 0), card("drews", "drew", 0), u1, turn("t1", "taylor", "u1", 10)];
  assert.deepEqual(choicesClosedByMessage(messages, "taylor", u1).map((choice) => choice.title), ["Which ask?"], "still waiting, about to close");
  messages[0].metadata!.pendingChoice = { ...messages[0].metadata!.pendingChoice!, status: "cancelled", cancelledAt: iso(10), expiredAt: iso(10) };
  assert.deepEqual(choicesClosedByMessage(messages, "taylor", u1).map((choice) => choice.title), ["Which ask?"], "or closed by it already");
  // Drew's card is not taylor's to be told about (the first answer lists only taylor's).
  // Asked as the turn on her message starts, before its reply is saved.
  assert.deepEqual(choicesClosedByMessage(messages.slice(0, 3), "taylor", u1).map((choice) => choice.title), ["Which ask?"],
    "the turn being started is the one on her message");
  // Her next message closed nothing more: the card closed by the first one is not news.
  const u2 = user("u2", 20);
  messages.push(u2, turn("t2", "taylor", "u2", 20));
  assert.deepEqual(choicesClosedByMessage(messages, "taylor", u2), []);
});

test("a card the User answered or cancelled herself is never reported as closed unanswered", () => {
  const answered = card("ask", "taylor", 0);
  answered.metadata!.pendingChoice!.status = "selected";
  const cancelled = card("cancelled", "taylor", 0);
  cancelled.metadata!.pendingChoice!.status = "cancelled";
  const u1 = user("u1", 10);
  const messages = [answered, cancelled, u1, turn("t1", "taylor", "u1", 10)];
  assert.deepEqual(choicesClosedByMessage(messages, "taylor", u1), []);
  // Her answer to a card is not writing instead of choosing.
  const waiting = card("waiting", "taylor", 0);
  const answer = user("answer", 5, { metadata: { hiddenFromTimeline: true, sourceMessageId: "waiting" } });
  assert.deepEqual(choicesClosedByMessage([waiting, answer, turn("t2", "taylor", "answer", 5)], "taylor", answer), []);
  // Nor is a message of a member or a script.
  const request: ChatMessage = { id: "req", role: "participant", participantId: "drew", content: "@taylor please", createdAt: iso(10), status: "done" };
  assert.deepEqual(choicesClosedByMessage([card("x", "taylor", 0), request, turn("t3", "taylor", "req", 10)], "taylor", request), []);
});

test("a message still queued behind the member's running turn closes nothing until its turn starts", () => {
  const queued: ChatMessage = { ...turn("t1", "taylor", "u1", 10), status: "pending", metadata: { sourceMessageId: "u1", parentMessageId: "u1", queuedBehind: { handle: "taylor" } } };
  const messages = [card("ask", "taylor", 0), user("u1", 10), queued];
  assert.deepEqual(choiceExpiryPlan(messages, all), { due: [] }, "queued: not started");
  messages[2] = { ...queued, metadata: { sourceMessageId: "u1", parentMessageId: "u1" } };
  assert.deepEqual(choiceExpiryPlan(messages, all), { due: ["ask"] }, "started");
});

