import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatActionEmitter,
  approvalTarget,
  chatActionEventId,
  chatActionReceiptEventId,
  type ChatActionEmission
} from "./chatActionEmitter";
import { foldChatActionEvents } from "../../shared/chatActionEvents";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { ChatActionApplier } from "./chatActionApplier";
import { createChatActionEffects } from "./chatActionEffects";
import type { Conversation, RespondToChatAppToolApprovalRequest } from "../../shared/types";

function harness(options: { failPublish?: boolean } = {}) {
  const published: ChatActionEmission[] = [];
  const logged: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const ids = new Set<string>();
  const emitter = new ChatActionEmitter({
    executedBy: "cloud-box",
    now: () => "2026-09-07T09:00:00.000Z",
    logger: (event, payload) => logged.push({ event, payload }),
    hasEvent: async (eventId) => ids.has(eventId),
    publish: async (action) => {
      if (options.failPublish) throw new Error("SQLITE_FULL");
      published.push(action);
      ids.add(chatActionEventId(action.payload.operationId));
    }
  });
  return { emitter, published, logged, ids };
}

/** One origin's contiguous run, as a real emitter produces: sequences start at
 *  1, or the fold reads a gap and applies nothing. */
function envelopes(actions: ChatActionEmission[], origin = "desktop"): ChatEventEnvelope[] {
  return actions.map((action, index) => ({
    eventId: chatActionEventId(action.payload.operationId),
    conversationId: action.conversationId,
    logScopeId: "chat:actions",
    originId: origin,
    originSeq: index + 1,
    logicalTs: `hlc:000000000${String(100 + index).padStart(4, "0")}:000000:${origin}`,
    kind: action.kind,
    payload: action.payload,
    payloadHash: `p${index}`,
    eventHash: `h${index}`,
    createdAt: "2026-09-07T09:00:00.000Z"
  }));
}

test("a permission answer is recorded before the provider is told, and the provider is told once", async () => {
  const h = harness();
  const target = await h.emitter.permissionDecided({
    conversationId: "chat", approvalId: "card-1", approve: true, scope: "session", decisionId: "native-7"
  });
  assert.equal(target, approvalTarget("card-1"));
  assert.equal(h.published[0].kind, "permission.decided");
  assert.deepEqual(h.published[0].payload.detail, { approve: true, scope: "session", codexDecisionId: "native-7" });

  assert.equal(await h.emitter.beginExecution(target), true, "nothing has been executed yet");
  await h.emitter.recordExecution({ conversationId: "chat", targetKey: target, effect: "answered the provider" });
  assert.equal(h.published[1].kind, "execution.receipt");

  // The opposite answer from another device: recorded, but the provider has
  // already been told and must not be told again.
  await h.emitter.permissionDecided({ conversationId: "chat", approvalId: "card-1", approve: false });
  assert.equal(await h.emitter.beginExecution(target), false);
  assert.ok(h.logged.some((entry) => entry.event === "chat.action.execution-skipped"));

  const folded = foldChatActionEvents(envelopes(h.published));
  const card = folded.targets.find((entry) => entry.targetKey === target);
  assert.equal(card?.receipts.length, 1, "one receipt: the effect happened once");
  assert.equal(folded.conflicts.length >= 1, true, "both answers stay visible beside it");
});

test("the once-only guard survives a restart, because it is the log that decides", async () => {
  const h = harness();
  const target = await h.emitter.permissionDecided({ conversationId: "chat", approvalId: "card-2", approve: true });
  await h.emitter.recordExecution({ conversationId: "chat", targetKey: target, effect: "answered" });

  // A fresh emitter over the same log, as after a restart.
  const restarted = new ChatActionEmitter({
    executedBy: "cloud-box", hasEvent: async (eventId) => h.ids.has(eventId), publish: async () => undefined
  });
  assert.equal(await restarted.beginExecution(target), false);
  assert.equal(await restarted.beginExecution(approvalTarget("card-never-answered")), true);
  assert.equal(chatActionReceiptEventId(target), `chat-action:receipt:${target}`);
});

test("an uncertain effect is recorded as uncertain, never as success or as absent", async () => {
  const h = harness();
  const target = await h.emitter.stopRequested({ conversationId: "chat", runId: "run-1", by: "user" });
  await h.emitter.recordExecution({
    conversationId: "chat", targetKey: target, effect: "asked the machine to stop", uncertain: true
  });
  const receipt = h.published[1].payload as unknown as { uncertain?: boolean; executedBy: string };
  assert.equal(receipt.uncertain, true);
  assert.equal(receipt.executedBy, "cloud-box");
  assert.equal(await h.emitter.beginExecution(target), false, "an uncertain effect still counts as told");
});

test("the same answer twice is one operation; opposite answers are two", async () => {
  const h = harness();
  await h.emitter.permissionDecided({ conversationId: "chat", approvalId: "card-3", approve: true });
  await h.emitter.permissionDecided({ conversationId: "chat", approvalId: "card-3", approve: true });
  await h.emitter.permissionDecided({ conversationId: "chat", approvalId: "card-3", approve: false });
  const operations = h.published.map((action) => action.payload.operationId);
  assert.deepEqual(operations, [
    "permission:card-3:allow", "permission:card-3:allow", "permission:card-3:deny"
  ]);
  const folded = foldChatActionEvents(envelopes(h.published));
  assert.equal(folded.duplicates.length, 1, "the retry folds once");
  assert.equal(folded.targets[0].stateId, "denied", "the later answer is the projected one");
});

test("answering a choice and a participant request produce their own targets", async () => {
  const h = harness();
  const choice = await h.emitter.choiceAnswered({
    conversationId: "chat", choiceId: "c-1", sourceMessageId: "m-1", selectedOptionId: "opt-2"
  });
  assert.equal(choice, "choice:c-1");
  assert.equal(h.published[0].payload.stateId, "opt-2");

  const opened = await h.emitter.participantRequestOpened({
    conversationId: "chat", requestId: "r-1", from: "user", to: "drew"
  });
  const answered = await h.emitter.participantRequestAnswered({ conversationId: "chat", requestId: "r-1", by: "drew" });
  assert.equal(opened, answered);
  assert.deepEqual(h.published[2].payload.precondition, { expectedStateId: "open" });

  const folded = foldChatActionEvents(envelopes(h.published));
  const request = folded.targets.find((entry) => entry.targetKey === "request:r-1");
  assert.equal(request?.stateId, "answered");
});

test("an answer to a request this peer never saw opened is superseded, not invented", async () => {
  const h = harness();
  await h.emitter.participantRequestAnswered({ conversationId: "chat", requestId: "r-2", by: "drew" });
  const folded = foldChatActionEvents(envelopes(h.published));
  assert.equal(folded.superseded.length, 1);
  assert.equal(folded.superseded[0].reason, "state-changed");
});

test("a failed publish is reported and never pretends the decision was recorded", async () => {
  const h = harness({ failPublish: true });
  let providerCalled = false;
  await assert.rejects(async () => {
    await h.emitter.permissionDecided({ conversationId: "chat", approvalId: "card-4", approve: true });
    providerCalled = true;
  }, /SQLITE_FULL/);
  assert.deepEqual(h.published, []);
  assert.equal(providerCalled, false);
  assert.ok(h.logged.some((entry) => entry.event === "chat.action.emit-failed"));
  await assert.rejects(h.emitter.recordExecution({ conversationId: "chat", targetKey: "approval:card-4", effect: "answered" }), /SQLITE_FULL/);
});

test("an emitted answer reaches the receiving owner with the full native decision and custom text", async () => {
  const h = harness();
  const approvals: RespondToChatAppToolApprovalRequest[] = [];
  const choices: Array<Record<string, unknown>> = [];
  const conversation = { id: "chat", metadata: { pendingAppToolApprovals: [{ id: "card", status: "pending" }], activeRunIds: ["run"] } } as unknown as Conversation;
  const effects = createChatActionEffects({
    emitter: h.emitter,
    storage: { getConversation: async () => conversation },
    chat: {
      respondToAppToolApproval: async (request) => { approvals.push(request); return conversation; },
      respondToChoice: async (request) => { choices.push(request); },
      cancelRun: () => true,
      conversationIdForRun: () => "chat"
    }
  });
  const applier = new ChatActionApplier({ effects });
  const draft = { tool: "command", proposed: "echo amended" } as unknown as NonNullable<RespondToChatAppToolApprovalRequest["draftOverride"]>;
  await h.emitter.permissionDecided({ conversationId: "chat", approvalId: "card", approve: true, scope: "chat", decisionId: "native-allow", draftOverride: draft });
  await applier.apply(envelopes(h.published)[0]);
  assert.deepEqual(approvals, [{ conversationId: "chat", approvalId: "card", approve: true, scope: "chat", codexDecisionId: "native-allow", draftOverride: draft }]);

  await h.emitter.choiceAnswered({ conversationId: "chat", choiceId: "choice", sourceMessageId: "message", selectedOptionId: "custom", customAnswer: "Первый ответ", note: "С пояснением" });
  const first = h.published.at(-1)!;
  await applier.apply(envelopes([first])[0]);
  assert.equal(choices[0].customAnswer, "Первый ответ");
  assert.equal(choices[0].note, "С пояснением");
  await h.emitter.choiceAnswered({ conversationId: "chat", choiceId: "choice", sourceMessageId: "message", selectedOptionId: "custom", customAnswer: "Другой ответ", note: "С пояснением" });
  assert.notEqual(h.published.at(-1)!.payload.operationId, first.payload.operationId, "different custom answers cannot collide in the immutable event log");

  await h.emitter.stopRequested({ conversationId: "chat", runId: "run" });
  await applier.apply(envelopes([h.published.at(-1)!])[0]);
  assert.equal((h.published.at(-1)!.payload as unknown as { effect: string }).effect, "requested the run to stop");
});
