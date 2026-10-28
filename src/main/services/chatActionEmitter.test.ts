import assert from "node:assert/strict";
import test from "node:test";
import { ChatActionEmitter, chatActionEventId, type ChatActionEmission } from "./chatActionEmitter";
import { foldChatActionEvents } from "../../shared/chatActionEvents";
import type { ChatEventEnvelope } from "../../shared/chatEvents";

/**
 * What remains of chat actions emitted here: a member request's lifecycle.
 * Answers to the cards a member waits on and Stop are operations on the
 * User's server (chat.cards.test, chat.machineServer.test).
 */

function harness(options: { failPublish?: boolean } = {}) {
  const published: ChatActionEmission[] = [];
  const logged: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const emitter = new ChatActionEmitter({
    logger: (event, payload) => logged.push({ event, payload }),
    publish: async (action) => {
      if (options.failPublish) throw new Error("SQLITE_FULL");
      published.push(action);
    }
  });
  return { emitter, published, logged };
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

test("a participant request opened and answered folds to answered", async () => {
  const h = harness();
  const opened = await h.emitter.participantRequestOpened({
    conversationId: "chat", requestId: "r-1", from: "user", to: "drew"
  });
  const answered = await h.emitter.participantRequestAnswered({ conversationId: "chat", requestId: "r-1", by: "drew" });
  assert.equal(opened, answered);
  assert.equal(opened, "request:r-1");
  assert.deepEqual(h.published[1].payload.precondition, { expectedStateId: "open" });

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

test("a failed publish is reported and never pretends the action was recorded", async () => {
  const h = harness({ failPublish: true });
  await assert.rejects(h.emitter.participantRequestOpened({ conversationId: "chat", requestId: "r-3", from: "user", to: "drew" }), /SQLITE_FULL/);
  assert.deepEqual(h.published, []);
  assert.ok(h.logged.some((entry) => entry.event === "chat.action.emit-failed"));
});
