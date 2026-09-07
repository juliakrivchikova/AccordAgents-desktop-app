import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createNativeTargetClaims } from "./chatActionNativeClaims";
import { createChatActionEffects } from "./chatActionEffects";
import { ChatActionApplier } from "./chatActionApplier";
import { chatActionReceiptEventId } from "./chatActionEmitter";
import { StorageService } from "./storage";
import { ChatEventLogService } from "./chatEventLog";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { Conversation } from "../../shared/types";

const CONVERSATION = "choice-chat";
const CHOICE = "choice-7";
const TARGET = `choice:${CHOICE}`;

/**
 * A choice used to be admitted by asking whether a receipt event existed.
 * That is a read, not a claim: two answers arriving together both saw no
 * receipt and both told the provider, and a crash between telling it and
 * writing the receipt told it again on the next start.
 */
async function box() {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-choice-claim-"));
  const storage = new StorageService({ dbPath: path.join(dir, "state.sqlite3") });
  const eventLog = new ChatEventLogService(storage);
  const answered: string[] = [];
  const conversation: Conversation = {
    id: CONVERSATION, kind: "chat", title: "Choice", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{
      id: "m1", role: "participant", participantId: "p1", participantLabel: "@one",
      content: "Which one?", createdAt: new Date().toISOString(), status: "done",
      metadata: { runId: "run-1", pendingChoice: { id: CHOICE, status: "pending", options: [{ id: "a", label: "A" }] } }
    }],
    findings: [], metadata: {}
  } as unknown as Conversation;

  const owner = { runtimeId: "runtime-a", pid: 4321, startedAt: "synthetic-start" };
  const build = (options: { runtimeId?: string; canApply?: () => boolean } = {}) => createChatActionEffects({
    chat: {
      respondToAppToolApproval: async () => conversation,
      respondToChoice: async (request) => { answered.push(`${request.choiceId}:${request.selectedOptionId ?? ""}`); },
      cancelRun: () => true,
      conversationIdForRun: (runId) => (runId === "run-1" ? CONVERSATION : undefined)
    },
    emitter: {
      beginExecution: async (targetKey) => !(await storage.getChatEvent(chatActionReceiptEventId(targetKey))),
      recordExecution: async (request) => {
        await eventLog.appendLocalEvent({
          conversationId: request.conversationId, logScopeId: "chat:actions", kind: "execution.receipt",
          eventId: chatActionReceiptEventId(request.targetKey),
          payload: { operationId: `receipt:${request.targetKey}`, targetKey: request.targetKey, stateId: "done" }
        });
      }
    },
    storage: { getConversation: async () => conversation },
    nativeClaims: createNativeTargetClaims({
      storage,
      runtimeIdentity: async () => ({ ...owner, ...(options.runtimeId ? { runtimeId: options.runtimeId } : {}) }),
      ...(options.canApply ? { canApply: options.canApply } : {})
    })
  });

  /** A real signed answer, so the claim's SQL can find its event. */
  const answer = async (optionId: string) => {
    const { event } = await eventLog.appendLocalEvent({
      conversationId: CONVERSATION, logScopeId: "chat:actions", kind: "choice.answered",
      payload: { operationId: `choice:${CHOICE}:${optionId}`, targetKey: TARGET, stateId: optionId,
        detail: { sourceMessageId: "m1", selectedOptionId: optionId } }
    });
    return event as ChatEventEnvelope;
  };

  return {
    storage, eventLog, answered, conversation, build, answer,
    cleanup: async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  };
}

test("two answers to the same choice tell the provider once", async () => {
  const held = await box();
  try {
    const applier = new ChatActionApplier({ effects: held.build() });
    const first = await held.answer("a");
    const second = await held.answer("b");
    const [one, two] = await Promise.all([applier.apply(first), applier.apply(second)]);
    assert.equal(one.status, "applied");
    assert.equal(two.status, "applied");
    assert.equal(held.answered.length, 1, `the provider is told once: ${JSON.stringify(held.answered)}`);
    // The one that lost says so rather than claiming it was carried out.
    const loser = [one, two].find((result) => !/answered the choice/.test(result.detail ?? ""));
    assert.ok(loser, "one of the two answers must state that it did not act");
    assert.match(loser.detail ?? "", /already acted on here|not repeated/);
  } finally { await held.cleanup(); }
});

test("a crash between telling the provider and writing the receipt does not tell it again", async () => {
  const held = await box();
  try {
    const answer = await held.answer("a");
    // The claim is on disk and the receipt is not: exactly the state a process
    // that died inside the effect leaves behind.
    const claimed = await held.storage.nativeCommands().claimTarget({
      runtimeId: "runtime-gone", pid: 999, startedAt: "gone",
      eventId: answer.eventId, conversationId: CONVERSATION, targetKey: TARGET, participantId: "p1"
    });
    assert.equal(claimed, true);

    const result = await new ChatActionApplier({ effects: held.build() }).apply(answer);
    assert.equal(result.status, "applied");
    assert.deepEqual(held.answered, [], "the provider must not be told a second time");
    assert.match(result.detail ?? "", /not repeated/,
      "and the answer says its delivery was never confirmed, rather than claiming success");
  } finally { await held.cleanup(); }
});

test("an answer already carried out here is not carried out again after a restart", async () => {
  const held = await box();
  try {
    const answer = await held.answer("a");
    const first = await new ChatActionApplier({ effects: held.build() }).apply(answer);
    assert.equal(first.status, "applied");
    assert.deepEqual(held.answered, [`${CHOICE}:a`]);

    // A new runtime over the same disk, replaying the same signed answer.
    const again = await new ChatActionApplier({ effects: held.build({ runtimeId: "runtime-b" }) }).apply(answer);
    assert.equal(again.status, "applied");
    assert.equal(held.answered.length, 1, "a restart replays the event, not the effect");
    assert.match(again.detail ?? "", /already acted on here/);
  } finally { await held.cleanup(); }
});

test("a runtime that is shutting down keeps the answer instead of half-applying it", async () => {
  const held = await box();
  try {
    const answer = await held.answer("a");
    const result = await new ChatActionApplier({ effects: held.build({ canApply: () => false }) }).apply(answer);
    assert.equal(result.status, "deferred", "the answer is kept for a runtime that can carry it out");
    assert.deepEqual(held.answered, []);
    assert.equal(await held.storage.nativeCommands().targetEffect(CONVERSATION, TARGET), undefined,
      "and nothing was claimed on the way out");
  } finally { await held.cleanup(); }
});

test("a copy that is not running the turn does not answer its choice", async () => {
  const held = await box();
  try {
    // The same replicated conversation on a peer that owns no run for it. Any
    // active run in the chat used to be enough to claim ownership.
    const effects = createChatActionEffects({
      chat: {
        respondToAppToolApproval: async () => held.conversation,
        respondToChoice: async () => { held.answered.push("wrong-peer"); },
        cancelRun: () => true,
        conversationIdForRun: () => undefined
      },
      emitter: { beginExecution: async () => true, recordExecution: async () => undefined },
      storage: { getConversation: async () => held.conversation },
      nativeClaims: createNativeTargetClaims({ storage: held.storage, runtimeIdentity: async () => ({ runtimeId: "r", pid: 1, startedAt: "s" }) })
    });
    const result = await new ChatActionApplier({ effects }).apply(await held.answer("a"));
    assert.equal(result.status, "applied");
    assert.deepEqual(held.answered, [], "a peer that does not run the turn records the answer without acting");
  } finally { await held.cleanup(); }
});

test("an answer whose request has not arrived yet waits for it", async () => {
  const held = await box();
  try {
    const empty = { ...held.conversation, messages: [] } as Conversation;
    const effects = createChatActionEffects({
      chat: {
        respondToAppToolApproval: async () => empty,
        respondToChoice: async () => { held.answered.push("too-early"); },
        cancelRun: () => true,
        conversationIdForRun: () => CONVERSATION
      },
      emitter: { beginExecution: async () => true, recordExecution: async () => undefined },
      storage: { getConversation: async () => empty },
      nativeClaims: createNativeTargetClaims({ storage: held.storage, runtimeIdentity: async () => ({ runtimeId: "r", pid: 1, startedAt: "s" }) })
    });
    const result = await new ChatActionApplier({ effects }).apply(await held.answer("a"));
    assert.equal(result.status, "deferred");
    assert.deepEqual(held.answered, []);
  } finally { await held.cleanup(); }
});

test("a disk that refuses the claim keeps the answer instead of acting without one", async () => {
  const held = await box();
  try {
    const answer = await held.answer("a");
    // The claim is the admission. A disk that cannot record it has not
    // admitted anything, and acting anyway is exactly the double effect the
    // row exists to prevent.
    const broken = {
      getChatEvent: (id: string) => held.storage.getChatEvent(id),
      nativeCommands: () => ({
        ...held.storage.nativeCommands(),
        claimTarget: async () => { throw new Error("SQLITE_FULL: database or disk is full"); }
      })
    } as unknown as Parameters<typeof createNativeTargetClaims>[0]["storage"];
    const effects = createChatActionEffects({
      chat: {
        respondToAppToolApproval: async () => held.conversation,
        respondToChoice: async () => { held.answered.push("acted-without-a-claim"); },
        cancelRun: () => true,
        conversationIdForRun: () => CONVERSATION
      },
      emitter: { beginExecution: async () => true, recordExecution: async () => undefined },
      storage: { getConversation: async () => held.conversation },
      nativeClaims: createNativeTargetClaims({ storage: broken, runtimeIdentity: async () => ({ runtimeId: "r", pid: 1, startedAt: "s" }) })
    });
    const result = await new ChatActionApplier({ effects }).apply(answer);
    assert.equal(result.status, "deferred", "a real decision is kept for a runtime that can record it");
    assert.deepEqual(held.answered, [], "and nothing is told to the provider without an admission");

    // The disk recovers and the same signed answer is delivered again.
    const recovered = await new ChatActionApplier({ effects: held.build() }).apply(answer);
    assert.equal(recovered.status, "applied");
    assert.deepEqual(held.answered, [`${CHOICE}:a`], "the answer is carried out once, when it can be");
  } finally { await held.cleanup(); }
});

test("a receipt that cannot be written does not make the answer repeatable", async () => {
  const held = await box();
  try {
    const answer = await held.answer("a");
    // The effect happened; recording it failed. The claim row is the only
    // thing standing between that and telling the provider a second time.
    const effects = createChatActionEffects({
      chat: {
        respondToAppToolApproval: async () => held.conversation,
        respondToChoice: async (request) => { held.answered.push(`${request.choiceId}:${request.selectedOptionId ?? ""}`); },
        cancelRun: () => true,
        conversationIdForRun: () => CONVERSATION
      },
      emitter: {
        beginExecution: async () => true,
        recordExecution: async () => { throw new Error("SQLITE_FULL: database or disk is full"); }
      },
      storage: { getConversation: async () => held.conversation },
      nativeClaims: createNativeTargetClaims({ storage: held.storage, runtimeIdentity: async () => ({ runtimeId: "r", pid: 1, startedAt: "s" }) })
    });
    await assert.rejects(() => new ChatActionApplier({ effects }).apply(answer));
    assert.deepEqual(held.answered, [`${CHOICE}:a`]);

    // Redelivered after a restart, with the disk working again.
    const again = await new ChatActionApplier({ effects: held.build({ runtimeId: "runtime-c" }) }).apply(answer);
    assert.equal(again.status, "applied");
    assert.equal(held.answered.length, 1, "a receipt this device could not write is not permission to act again");
    assert.match(again.detail ?? "", /not repeated/);
  } finally { await held.cleanup(); }
});

test("an answer whose request names no member is kept, not called already answered", async () => {
  const held = await box();
  try {
    const anonymous = {
      ...held.conversation,
      messages: [{ ...held.conversation.messages[0], participantId: undefined }]
    } as unknown as Conversation;
    const effects = createChatActionEffects({
      chat: {
        respondToAppToolApproval: async () => anonymous,
        respondToChoice: async () => { held.answered.push("claimed-against-nobody"); },
        cancelRun: () => true,
        conversationIdForRun: () => CONVERSATION
      },
      emitter: { beginExecution: async () => true, recordExecution: async () => undefined },
      storage: { getConversation: async () => anonymous },
      nativeClaims: createNativeTargetClaims({ storage: held.storage, runtimeIdentity: async () => ({ runtimeId: "r", pid: 1, startedAt: "s" }) })
    });
    const result = await new ChatActionApplier({ effects }).apply(await held.answer("a"));
    assert.equal(result.status, "deferred");
    assert.doesNotMatch(result.detail ?? "", /already acted on/,
      "not knowing who to claim against is not the same as it having been answered");
    assert.deepEqual(held.answered, []);
  } finally { await held.cleanup(); }
});
