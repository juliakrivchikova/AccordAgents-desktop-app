import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../../shared/types";
import { CHAT_CHOICE_EXPIRY_MS, choiceAskedAtMs, choiceExpiryPlan } from "./chatChoiceExpiry";

/**
 * Which member choices expire (the User, 2026-11-01): an hour after the card
 * was asked, once a message of hers written after it started a new turn of
 * the member that asked.
 */

const T0 = Date.parse("2026-11-01T08:00:00.000Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const all = () => true;

function card(id: string, participantId: string, askedAtMinutes: number, extra: Partial<NonNullable<ChatMessage["metadata"]>> = {}): ChatMessage {
  return {
    id, role: "participant", participantId, participantLabel: `@${participantId}`, content: "Pick one.", status: "done", createdAt: iso(askedAtMinutes - 2),
    metadata: { pendingChoice: { id: `choice-${id}`, title: "Which?", question: "Which one?", options: [{ id: "a", label: "A" }], status: "pending",
      askedAt: iso(askedAtMinutes) }, ...extra }
  };
}

function user(id: string, minutes: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "user", content: "next", createdAt: iso(minutes), status: "done", ...extra };
}

function turn(id: string, participantId: string, triggerId: string, minutes: number): ChatMessage {
  return { id, role: "participant", participantId, content: "ok", createdAt: iso(minutes), status: "done", metadata: { sourceMessageId: triggerId, parentMessageId: triggerId } };
}

test("a choice expires an hour after it was asked once the User started a newer turn of its member", () => {
  const messages = [card("ask", "taylor", 0), user("u1", 10), turn("t1", "taylor", "u1", 10)];
  assert.deepEqual(choiceExpiryPlan(messages, T0 + 30 * 60_000, all), { due: [], nextAtMs: T0 + CHAT_CHOICE_EXPIRY_MS },
    "not yet: it waits for the hour, and says when");
  assert.deepEqual(choiceExpiryPlan(messages, T0 + CHAT_CHOICE_EXPIRY_MS, all), { due: ["ask"] }, "due at the hour");
  // Gone on with only after the hour: due at once.
  const late = [card("ask", "taylor", 0), user("u1", 90), turn("t1", "taylor", "u1", 90)];
  assert.deepEqual(choiceExpiryPlan(late, T0 + 90 * 60_000, all), { due: ["ask"] });
});

test("a choice does not expire without a later turn of its member started by the User", () => {
  const now = T0 + 5 * CHAT_CHOICE_EXPIRY_MS;
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0)], now, all), { due: [] }, "nothing after it");
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0), user("u1", 10), turn("t1", "drew", "u1", 10)], now, all), { due: [] },
    "her message started another member");
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0), user("u1", 10)], now, all), { due: [] }, "her message started nobody");
  const request: ChatMessage = { id: "req", role: "participant", participantId: "drew", content: "@taylor please", createdAt: iso(10), status: "done" };
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0), request, turn("t1", "taylor", "req", 11)], now, all), { due: [] },
    "another member asked for the turn");
  const script: ChatMessage = { id: "s1", role: "script", content: "feed changed", createdAt: iso(10), status: "done" };
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0), script, turn("t1", "taylor", "s1", 11)], now, all), { due: [] },
    "a scheduled script woke it");
  // Her message was written before the card appeared (queued behind the
  // reply that asked it): she had not seen the card.
  assert.deepEqual(choiceExpiryPlan([user("u0", -1), card("ask", "taylor", 0), turn("t1", "taylor", "u0", 1)], now, all), { due: [] },
    "her message came before the card");
  assert.deepEqual(choiceExpiryPlan([card("ask", "taylor", 0), user("u1", 10), turn("t1", "taylor", "u1", 10)], now, () => false), { due: [] },
    "a card this device does not close");
});

test("an answer to another of the member's cards counts as going on with it", () => {
  const answer = user("answer", 20, { metadata: { hiddenFromTimeline: true, sourceMessageId: "other" } });
  const messages = [card("ask", "taylor", 0), card("other", "taylor", 5), answer, turn("t1", "taylor", "answer", 20)];
  messages[1].metadata!.pendingChoice!.status = "selected";
  assert.deepEqual(choiceExpiryPlan(messages, T0 + CHAT_CHOICE_EXPIRY_MS, all), { due: ["ask"] });
});

test("only waiting choices expire, each member's by its own turns", () => {
  const answered = card("answered", "taylor", 0);
  answered.metadata!.pendingChoice!.status = "selected";
  const cancelled = card("cancelled", "taylor", 0);
  cancelled.metadata!.pendingChoice!.status = "cancelled";
  const messages = [answered, cancelled, card("taylors", "taylor", 0), card("drews", "drew", 0), user("u1", 10), turn("t1", "taylor", "u1", 10)];
  assert.deepEqual(choiceExpiryPlan(messages, T0 + 2 * CHAT_CHOICE_EXPIRY_MS, all), { due: ["taylors"] });
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
  assert.deepEqual(choiceExpiryPlan(messages, T0 + 5 * CHAT_CHOICE_EXPIRY_MS, all), { due: [] });
  messages.push(user("u2", 7), turn("t2", "taylor", "u2", 7));
  assert.deepEqual(choiceExpiryPlan(messages, T0 + 5 * CHAT_CHOICE_EXPIRY_MS, all), { due: ["ask"] });
});
