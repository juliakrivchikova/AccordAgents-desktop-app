import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { MachineChoiceExecutor, MachineMentionExecutor } from "./chatActionNativeClaims";
import { ChatChoicePersistenceError } from "./chat";
import { StorageService } from "./storage";
import { cardAnswerKey } from "./machineApprovalExecutor";
import type { HubCard } from "../../shared/hubOps";
import type { Conversation, RespondToChatChoiceRequest, RespondToChatMentionsRequest } from "../../shared/types";

const CONVERSATION = "choice-chat";
const CHOICE = "choice-7";
const SOURCE = "m1";
const TARGET = `choice:${CHOICE}`;

/**
 * Answering a choice wakes a member that is waiting, and that happens once.
 * The answer comes from the User's server (a card answered from any device);
 * the device the member runs on saves it before anything native is claimed,
 * claims inside `beforeApply`, and a disk that refuses the save is a
 * distinct failure from one that refuses the claim. These drive the real
 * executor against real SQLite; the chat is a stand-in for that contract.
 */
async function box(options: { failSave?: () => boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-choice-executor-"));
  const storage = new StorageService({ dbPath: path.join(dir, "state.sqlite3") });
  await storage.saveConversation({
    id: CONVERSATION, title: "Choice", kind: "chat", createdAt: "2026-10-28T08:00:00.000Z", updatedAt: "2026-10-28T08:00:00.000Z", findings: [],
    messages: [{ id: SOURCE, role: "participant", participantId: "p1", content: "Which one?", createdAt: "2026-10-28T08:00:00.000Z", status: "done",
      metadata: { pendingChoice: { id: CHOICE, title: "One", question: "Which one?", status: "pending", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
        pendingMentions: [{ targetParticipantId: "p2", targetHandle: "drew", status: "pending" }] } }],
    metadata: { participants: [], participantSessions: [], running: false, warnings: [] }
  } as unknown as Conversation);
  const continued: string[] = [];
  const asked: RespondToChatMentionsRequest[] = [];
  let saves = 0;

  const chat = {
    respondToChoice: async (
      request: RespondToChatChoiceRequest,
      _signal?: AbortSignal,
      _progress?: unknown,
      execution?: { decisionEventId: string; beforeApply(participantId: string): Promise<void> }
    ) => {
      // The order the real service uses: validate, save, then admit.
      if (options.failSave?.()) throw new ChatChoicePersistenceError("database or disk is full");
      saves += 1;
      await execution?.beforeApply("p1");
      continued.push(`${request.choiceId}:${request.selectedOptionId ?? ""}`);
      return { conversation: {} as Conversation, warnings: [] };
    },
    respondToMentions: async (request: RespondToChatMentionsRequest) => {
      asked.push(request);
      return { conversation: {} as Conversation, warnings: [] };
    }
  };

  const build = (settings: { runtimeId?: string; canApply?: () => boolean } = {}) => new MachineChoiceExecutor({
    storage, chat: chat as never,
    runtimeIdentity: async () => ({ runtimeId: settings.runtimeId ?? "runtime-a", pid: 4321, startedAt: "synthetic-start" }),
    ...(settings.canApply ? { canApply: settings.canApply } : {})
  });
  const mentions = (runtimeId = "runtime-a") => new MachineMentionExecutor({ storage, chat: chat as never,
    runtimeIdentity: async () => ({ runtimeId, pid: 4321, startedAt: "synthetic-start" }) });

  /** The card on the User's server, answered. */
  const answer = (optionId: string, answeredAt = "2026-10-28T08:01:00.000Z"): HubCard => ({
    cardId: `choice:${SOURCE}`, conversationId: CONVERSATION, cardKind: "choice", participantId: "p1", messageId: SOURCE, raisedBy: "device-home",
    raisedAt: "2026-10-28T08:00:00.000Z", card: {}, state: "answered", answer: { selectedOptionId: optionId }, answeredBy: "device-phone", answeredAt
  });

  return {
    storage, continued, asked, build, mentions, answer,
    saves: () => saves,
    cleanup: async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  };
}

test("the same answer read twice at once continues the member once", async () => {
  const h = await box();
  try {
    const executor = h.build();
    const card = h.answer("a");
    const [first, second] = await Promise.all([executor.apply(card, "op-1"), executor.apply(card, "op-1")]);
    assert.deepEqual([first, second], [{ kind: "applied" }, { kind: "applied" }]);
    assert.deepEqual(h.continued, [`${CHOICE}:a`]);
  } finally { await h.cleanup(); }
});

test("a crash between continuing the member and settling the card does not continue it again", async () => {
  const h = await box();
  try {
    const card = h.answer("a");
    assert.deepEqual(await h.build().apply(card), { kind: "applied" });
    assert.equal((await h.storage.nativeCommands().targetEffect(CONVERSATION, TARGET))?.eventId, cardAnswerKey(card));
    // The process dies before its settle reached the server; the next one
    // reads the same answer again.
    const restarted = h.build({ runtimeId: "runtime-b" });
    const again = await restarted.apply(card);
    assert.equal(again.kind, "uncertain");
    assert.deepEqual(h.continued, [`${CHOICE}:a`], "continued once");
    // A later answer (the card asked again) is not this choice's any more.
    assert.equal((await restarted.apply(h.answer("b", "2026-10-28T08:09:00.000Z"))).kind, "refused");
    assert.deepEqual(h.continued, [`${CHOICE}:a`]);
  } finally { await h.cleanup(); }
});

test("a runtime that is shutting down keeps the answer instead of half-applying it", async () => {
  const h = await box();
  try {
    const result = await h.build({ canApply: () => false }).apply(h.answer("a"));
    assert.equal(result.kind, "retry");
    assert.equal(h.saves(), 0);
    assert.equal(await h.storage.nativeCommands().targetEffect(CONVERSATION, TARGET), undefined);
  } finally { await h.cleanup(); }
});

test("a disk that cannot save the answer is a held answer, not a lost one", async () => {
  let failing = true;
  const h = await box({ failSave: () => failing });
  try {
    const card = h.answer("a");
    assert.equal((await h.build().apply(card)).kind, "retry");
    assert.equal(await h.storage.nativeCommands().targetEffect(CONVERSATION, TARGET), undefined, "nothing claimed");
    failing = false;
    assert.deepEqual(await h.build().apply(card), { kind: "applied" });
    assert.deepEqual(h.continued, [`${CHOICE}:a`]);
  } finally { await h.cleanup(); }
});

test("an answer to a choice that is not here is refused before anything is claimed", async () => {
  const h = await box();
  try {
    const result = await h.build().apply({ ...h.answer("a"), messageId: "not-here", cardId: "choice:not-here" });
    assert.equal(result.kind, "refused");
    assert.equal(await h.storage.nativeCommands().targetEffect(CONVERSATION, TARGET), undefined);
  } finally { await h.cleanup(); }
});

test("mentions waiting for approval are asked once per answer, at most", async () => {
  const h = await box();
  try {
    const card: HubCard = { ...h.answer("a"), cardId: `mention:${SOURCE}`, cardKind: "mention", answer: { approve: true, targetParticipantIds: ["p2"] } };
    const [first, second] = await Promise.all([h.mentions().apply(card), h.mentions().apply(card)]);
    assert.ok([first.kind, second.kind].includes("applied"));
    assert.equal(h.asked.length, 1, "asked once");
    assert.equal((await h.mentions("runtime-b").apply(card)).kind, "uncertain", "never twice, even after a restart");
    assert.equal(h.asked.length, 1);
    const none: HubCard = { ...card, answeredAt: "2026-10-28T08:09:00.000Z", answer: { approve: true, targetParticipantIds: ["someone-else"] } };
    assert.equal((await h.mentions().apply(none)).kind, "refused");
  } finally { await h.cleanup(); }
});
