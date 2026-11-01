import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { buildChatActivityItems } from "../../shared/chatActivity";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { choiceCardId } from "../../shared/hubCards";
import type { ChatMessage, ChatParticipant, ChatRoleConfig, Conversation, ParticipantConfig } from "../../shared/types";
import { ChatService } from "./chat";
import { CHAT_CHOICE_EXPIRY_MS } from "./chatChoiceExpiry";

/**
 * A member's choice card expires (the User, 2026-11-01): an hour after it
 * was asked, once a message of hers written after it started a newer turn
 * of that member. Driven through the real send, turn and choice paths, with
 * the members' CLIs played by the test.
 */

const NOW = "2026-01-01T00:00:00.000Z";
const ROLE: ChatRoleConfig = { id: "generic-participant", label: "Generic participant", instructions: "Answer directly.", version: 1, updatedAt: NOW };
const HOUR = CHAT_CHOICE_EXPIRY_MS;
const ASKING = ["Which store should I use?", "", "User choice:", "T: Store", "Q: Which store?", "O1: SQLite | fast", "O2: Files", "R: O1"].join("\n");

function member(id: string, handle: string): ChatParticipant {
  return { id, handle, roleConfigId: ROLE.id, kind: "codex-cli", agentMode: "default", permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions()) };
}
const taylor = member("taylor-id", "taylor");
const drew = member("drew-id", "drew");

function conversation(messages: ChatMessage[] = []): Conversation {
  return { id: "chat-expiry", title: "Plans", kind: "chat", createdAt: NOW, updatedAt: NOW, messages, findings: [],
    metadata: { participants: [taylor, drew], participantSessions: [] } };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Each member's replies, in order; a member with none left says "ok". */
function harness(initial: Conversation, replies: Record<string, string[]> = {}) {
  const storage = {
    current: clone(initial),
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(saved: Conversation): Promise<void> {
      this.current = clone(saved);
    },
    async conversationIdsWithPendingChoices(): Promise<string[]> {
      return this.current.messages.some((message) => message.metadata?.pendingChoice?.status === "pending") ? [this.current.id] : [];
    }
  };
  const settings = {
    async getPublicSettings() {
      return { chatRoleConfigs: [ROLE], chatBehaviorRules: [], providers: [{ kind: "codex-cli", enabled: true }], chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT };
    }
  };
  const runs: string[] = [];
  const cliRunner = {
    async detectAgents() { return [{ kind: "codex-cli", label: "Codex CLI", installed: true }]; },
    async run(participant: ParticipantConfig) {
      runs.push(participant.id);
      const content = replies[participant.id]?.shift() ?? "ok";
      return { participant, ok: true, content, durationMs: 1 };
    }
  };
  const events: string[] = [];
  const service = new ChatService(storage as never, settings as never, cliRunner as never, { async write(event: string) { events.push(event); } } as never);
  const internals = service as unknown as {
    ensureHistoryFiles: () => Promise<string>;
    choiceExpiryNow: () => number;
    choiceExpiryTimers: Map<string, { atMs: number; timer: NodeJS.Timeout }>;
    sweepChoiceExpiry(conversationId: string): Promise<void>;
    withChatMutation(conversation: Conversation, mutate: () => Promise<void>): Promise<void>;
    saveConversation(conversation: Conversation): Promise<void>;
    serverLink?: unknown;
    serverCards: { reconciled: boolean; noteServer(card: unknown, seq: number): boolean };
  };
  internals.ensureHistoryFiles = async () => tmpdir();
  let offsetMs = 0;
  internals.choiceExpiryNow = () => Date.now() + offsetMs;
  const advance = (ms: number) => { offsetMs += ms; };
  const stored = () => storage.current;
  const choiceOf = (messageId: string) => stored().messages.find((message) => message.id === messageId)?.metadata?.pendingChoice;
  const settle = async () => {
    await until(() => !stored().messages.some((message) => message.status === "pending") && stored().metadata.running !== true);
    await service.settleChatSaves();
  };
  /** Sends as the User does, and waits for the member's reply to it. */
  const send = async (content: string) => {
    await service.sendMessage({ conversationId: initial.id, content });
    const sent = [...stored().messages].reverse().find((message) => message.role === "user" && message.content === content);
    assert.ok(sent, "the message was taken");
    await until(() => stored().messages.some((message) => message.role === "participant" && message.metadata?.sourceMessageId === sent!.id &&
      message.status !== "pending"));
    await settle();
  };
  const askingMessage = () => stored().messages.find((message) => message.metadata?.pendingChoice)!;
  return { service, internals, storage, runs, events, advance, stored, choiceOf, send, settle, askingMessage,
    stopTimers: () => { for (const { timer } of internals.choiceExpiryTimers.values()) clearTimeout(timer); internals.choiceExpiryTimers.clear(); } };
}

async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const pendingChoiceItems = (saved: Conversation) => buildChatActivityItems(saved).filter((item) => item.kind === "choice" && item.status === "pending");

test("a member's choice expires when the User goes on with that member after the hour: closed everywhere, shown as expired", async (t) => {
  const h = harness(conversation(), { [taylor.id]: [ASKING] });
  t.after(h.stopTimers);
  await h.send("@taylor which store?");
  const asking = h.askingMessage();
  assert.equal(asking.metadata?.pendingChoice?.status, "pending");
  assert.ok(asking.metadata?.pendingChoice?.askedAt, "the card keeps when it was asked");
  assert.equal(pendingChoiceItems(h.stored()).length, 1, "listed under Pending");

  h.advance(2 * HOUR);
  await h.send("@taylor let's do something else first");
  await until(() => Boolean(h.choiceOf(asking.id)?.expiredAt));
  const choice = h.choiceOf(asking.id);
  assert.equal(choice?.status, "cancelled", "closed as a cancelled card is, on every surface");
  assert.equal(choice?.cancelledAt, choice?.expiredAt);
  assert.equal(pendingChoiceItems(h.stored()).length, 0, "gone from Pending");
  assert.equal(buildChatActivityItems(h.stored()).some((item) => item.target?.messageId === asking.id), false, "nor listed as finished");
  // An answer she gave while the card still waited on her screen, arriving
  // after it expired: taken, and the member goes on with it.
  const runsBefore = h.runs.length;
  await h.service.respondToChoice({ conversationId: "chat-expiry", sourceMessageId: asking.id, choiceId: choice!.id, selectedOptionId: choice!.options[1].id });
  await h.settle();
  const answered = h.choiceOf(asking.id);
  assert.deepEqual([answered?.status, answered?.selectedOptionId, answered?.expiredAt, answered?.cancelledAt], ["selected", choice!.options[1].id, undefined, undefined]);
  await until(() => h.runs.length === runsBefore + 1);
});

test("gone on with within the hour, the choice expires at the hour; a copy read before does not bring it back", async (t) => {
  const h = harness(conversation(), { [taylor.id]: [ASKING] });
  t.after(h.stopTimers);
  await h.send("@taylor which store?");
  const asking = h.askingMessage();
  const askedAtMs = Date.parse(asking.metadata!.pendingChoice!.askedAt!);
  await h.send("@taylor actually, one more thing");
  assert.equal(h.choiceOf(asking.id)?.status, "pending", "not before the hour");
  assert.equal(h.internals.choiceExpiryTimers.get("chat-expiry")?.atMs, askedAtMs + HOUR, "a timer waits for the hour");

  const stale = clone(h.stored());
  h.advance(HOUR);
  await h.internals.sweepChoiceExpiry("chat-expiry");
  assert.ok(h.choiceOf(asking.id)?.expiredAt, "expired when the timer fired");
  assert.equal(h.internals.choiceExpiryTimers.has("chat-expiry"), false, "nothing more to wait for");
  // A longer flow saves the copy it read while the card still waited.
  await h.internals.withChatMutation(stale, async () => {
    stale.updatedAt = new Date().toISOString();
    await h.internals.saveConversation(stale);
  });
  assert.ok(h.choiceOf(asking.id)?.expiredAt, "still expired");
});

test("a choice does not expire when the User only wrote to another member, or never went on", async (t) => {
  const h = harness(conversation(), { [taylor.id]: [ASKING] });
  t.after(h.stopTimers);
  await h.send("@taylor which store?");
  const asking = h.askingMessage();
  h.advance(3 * HOUR);
  await h.internals.sweepChoiceExpiry("chat-expiry");
  assert.equal(h.choiceOf(asking.id)?.status, "pending", "nobody was asked after it");
  await h.send("@drew what do you think?");
  await h.internals.sweepChoiceExpiry("chat-expiry");
  assert.equal(h.choiceOf(asking.id)?.status, "pending", "she went on with another member");
  assert.equal(h.internals.choiceExpiryTimers.size, 0);
});

test("answering another of the member's cards goes on with it: the older card expires", async (t) => {
  const h = harness(conversation(), { [taylor.id]: [ASKING] });
  t.after(h.stopTimers);
  await h.send("@taylor which store?");
  const older = h.askingMessage();
  // A newer card of the same member, asked by a turn the User did not start.
  const newer: ChatMessage = {
    id: "newer-card", role: "participant", participantId: taylor.id, participantLabel: "@taylor", content: "And the format?", status: "done",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    metadata: { pendingChoice: { id: "choice-newer", title: "Format", question: "Which format?", status: "pending", askedAt: new Date(Date.now() + 2_000).toISOString(),
      options: [{ id: "json", label: "JSON" }, { id: "csv", label: "CSV" }] } }
  };
  h.storage.current.messages.push(newer);
  h.advance(2 * HOUR);
  await h.service.respondToChoice({ conversationId: "chat-expiry", sourceMessageId: newer.id, choiceId: "choice-newer", selectedOptionId: "json" });
  await h.settle();
  assert.equal(h.choiceOf(newer.id)?.status, "selected", "the answered card is answered");
  await until(() => Boolean(h.choiceOf(older.id)?.expiredAt));
  assert.equal(h.choiceOf(older.id)?.status, "cancelled", "the older card expired with the turn the answer started");
});

test("at a start, choices that expired while the app was closed are closed, never over an answer waiting on the User's server", async (t) => {
  const askedAt = new Date(Date.now() - 3 * HOUR).toISOString();
  const wentOn = new Date(Date.now() - 2 * HOUR).toISOString();
  const initial = conversation([
    { id: "ask", role: "participant", participantId: taylor.id, participantLabel: "@taylor", content: "Which?", status: "done", createdAt: askedAt,
      metadata: { pendingChoice: { id: "choice-1", title: "Store", question: "Which store?", status: "pending", options: [{ id: "a", label: "A" }] } } },
    { id: "u1", role: "user", content: "@taylor never mind", status: "done", createdAt: wentOn },
    { id: "t1", role: "participant", participantId: taylor.id, content: "ok", status: "done", createdAt: wentOn, metadata: { sourceMessageId: "u1", parentMessageId: "u1" } }
  ]);
  const h = harness(initial);
  t.after(h.stopTimers);
  const cardId = choiceCardId("ask");
  // Linked to the User's server, which holds an answer to the card that
  // this device has not heard of yet (it was off, or out of reach).
  let serverState: "pending" | "answered" = "answered";
  let reads = 0;
  h.internals.serverLink = { deviceId: () => "this-device", openCards: async () => {
    reads += 1;
    return { cards: [{ cardId, conversationId: "chat-expiry", cardKind: "choice", state: serverState, card: {} }], head: 1 };
  } };
  await h.service.resumeChoiceExpiry(["chat-expiry"]);
  assert.equal(h.choiceOf("ask")?.status, "pending", "not before the server's open cards were read");
  assert.equal(reads, 0);
  h.internals.serverCards.reconciled = true;
  await h.service.resumeChoiceExpiry(["chat-expiry"]);
  assert.equal(h.choiceOf("ask")?.status, "pending", "the server holds an answer: left to it");
  assert.equal(reads, 1, "the server was asked");
  assert.equal(h.events.includes("chat.choice.expired"), false, "not closed, not even unsaved");
  assert.ok(h.internals.choiceExpiryTimers.has("chat-expiry"), "looked at again later");
  // This device heard of the answer (it is being applied): left to it too,
  // whatever the server's list said.
  serverState = "pending";
  h.internals.serverCards.noteServer({ cardId, conversationId: "chat-expiry", cardKind: "choice", state: "answered", card: {} }, 1);
  await h.service.resumeChoiceExpiry(["chat-expiry"]);
  assert.equal(h.choiceOf("ask")?.status, "pending");
  // The server cannot be asked: nothing is closed.
  h.internals.serverCards.noteServer({ cardId, conversationId: "chat-expiry", cardKind: "choice", state: "pending", card: {} }, 2);
  h.internals.serverLink = { deviceId: () => "this-device", openCards: async () => { throw new Error("The hub could not be reached."); } };
  await h.service.resumeChoiceExpiry(["chat-expiry"]);
  assert.equal(h.choiceOf("ask")?.status, "pending", "unreachable: not decided");
  assert.ok(h.events.includes("chat.choice.expiry-error"));
  // Between two links (one stopped, the next not installed yet): not decided.
  h.service.setServerLink(undefined);
  (h.service as unknown as { serverLinkInstalled: boolean }).serverLinkInstalled = true;
  await h.internals.sweepChoiceExpiry("chat-expiry");
  assert.equal(h.choiceOf("ask")?.status, "pending", "between links: not decided");
  // A device that never had a server (only in tests: the desktop always
  // runs one, its own when the User has none). Expired, from its reply's time.
  (h.service as unknown as { serverLinkInstalled: boolean }).serverLinkInstalled = false;
  await h.internals.sweepChoiceExpiry("chat-expiry");
  assert.ok(h.choiceOf("ask")?.expiredAt, "a card saved before its asking time was kept expires as well");
});

test("a far-off expiry time does not overflow the chat's timer", async (t) => {
  const h = harness(conversation());
  t.after(h.stopTimers);
  const schedule = (h.service as unknown as { scheduleChoiceExpiry(id: string, atMs: number | undefined, options?: { replace?: boolean }): void }).scheduleChoiceExpiry
    .bind(h.service);
  schedule("chat-expiry", Date.now() + 40 * 24 * HOUR, { replace: true });
  const entry = h.internals.choiceExpiryTimers.get("chat-expiry");
  assert.ok(entry);
  assert.ok((entry!.timer as unknown as { _idleTimeout: number })._idleTimeout <= HOUR + 1_000, "fires within the hour and looks again");
  schedule("chat-expiry", undefined, { replace: true });
  assert.equal(h.internals.choiceExpiryTimers.has("chat-expiry"), false, "none when nothing waits");
});

test("a cancel that crosses the expiry is the User's: the card says Cancelled", async (t) => {
  const askedAt = new Date(Date.now() - 3 * HOUR).toISOString();
  const h = harness(conversation([
    { id: "ask", role: "participant", participantId: taylor.id, participantLabel: "@taylor", content: "Which?", status: "done", createdAt: askedAt,
      metadata: { pendingChoice: { id: "choice-1", title: "Store", question: "Which store?", status: "cancelled", askedAt, cancelledAt: askedAt, expiredAt: askedAt,
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } } }
  ]));
  t.after(h.stopTimers);
  await h.service.respondToChoice({ conversationId: "chat-expiry", sourceMessageId: "ask", choiceId: "choice-1", cancel: true });
  const choice = h.choiceOf("ask");
  assert.equal(choice?.status, "cancelled");
  assert.equal(choice?.expiredAt, undefined, "shown as her cancel, not as expired");
  assert.equal(h.runs.length, 0, "nobody is started");
});

test("an expired choice the User answered on the server stays open there until her answer is applied, never settled as if it had been", async (t) => {
  const askedAt = new Date(Date.now() - 3 * HOUR).toISOString();
  const expired: ChatMessage = {
    id: "ask", role: "participant", participantId: taylor.id, participantLabel: "@taylor", content: "Which?", status: "done", createdAt: askedAt,
    metadata: { pendingChoice: { id: "choice-1", title: "Store", question: "Which store?", status: "cancelled", askedAt, cancelledAt: askedAt, expiredAt: askedAt,
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } }
  };
  const h = harness(conversation([expired]));
  t.after(h.stopTimers);
  const cardId = choiceCardId("ask");
  h.internals.serverLink = { deviceId: () => "this-device" };
  h.internals.serverCards.reconciled = true;
  const opsFor = () => (h.service as unknown as { serverCardOpsFor(c: Conversation): { ops: Array<{ kind: string; cardId?: string }> } })
    .serverCardOpsFor(clone(h.stored())).ops.filter((op) => op.cardId === cardId);
  // Known open and unanswered here: closed, saying nobody answered it.
  h.internals.serverCards.noteServer({ cardId, conversationId: "chat-expiry", cardKind: "choice", state: "pending", raisedBy: "this-device", card: {} }, 1);
  const closing = opsFor();
  assert.deepEqual(closing.map((op) => op.kind), ["card.settle"]);
  assert.equal(((closing[0] as unknown as { outcome: { result: string; unanswered?: boolean } }).outcome).unanswered, true, "only while nobody answered it");
  // Answered on the server (her answer crossed the expiry): kept open for it.
  h.internals.serverCards.noteServer({ cardId, conversationId: "chat-expiry", cardKind: "choice", state: "answered", raisedBy: "this-device", card: {} }, 2);
  assert.deepEqual(opsFor(), [], "not settled as applied before her answer is");
});

