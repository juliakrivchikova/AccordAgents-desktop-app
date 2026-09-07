import assert from "node:assert/strict";
import test from "node:test";
import type { ChatEventEnvelope } from "./chatEvents";
import {
  foldChatActionEvents,
  type ChatActionKind,
  type ChatActionPayload
} from "./chatActionEvents";

let counter = 0;

function event(options: {
  kind: ChatActionKind;
  origin: string;
  seq: number;
  ts: string;
  payload: ChatActionPayload;
  eventId?: string;
  conversationId?: string;
}): ChatEventEnvelope {
  counter += 1;
  const eventId = options.eventId ?? `e${counter}`;
  return {
    eventId,
    conversationId: options.conversationId ?? "chat",
    logScopeId: "actions",
    originId: options.origin,
    originSeq: options.seq,
    logicalTs: options.ts,
    kind: options.kind,
    payload: options.payload,
    payloadHash: `payload-${eventId}`,
    eventHash: `hash-${eventId}`,
    createdAt: "2026-09-07T00:00:00.000Z"
  };
}

// --- the two acceptance cases the signed resolution names -------------------

test("two offline machines both produce v2: one wins, the other is visibly superseded, and its signature stays with what it signed", () => {
  // Both machines read v1 and revised it while disconnected.
  const v1 = event({
    kind: "artifact.revision.created", origin: "mac", seq: 1, ts: "100",
    payload: { operationId: "op-v1", targetKey: "artifact:plan", stateId: "rev-1", contentHash: "hash-1" }
  });
  const winner = event({
    kind: "artifact.revision.created", origin: "aaa-machine", seq: 1, ts: "200", eventId: "winner",
    payload: {
      operationId: "op-a", targetKey: "artifact:plan", stateId: "rev-2a", contentHash: "hash-2a",
      precondition: { expectedStateId: "rev-1", expectedContentHash: "hash-1" }
    }
  });
  const loser = event({
    kind: "artifact.revision.created", origin: "zzz-machine", seq: 1, ts: "300", eventId: "loser",
    payload: {
      operationId: "op-b", targetKey: "artifact:plan", stateId: "rev-2b", contentHash: "hash-2b",
      precondition: { expectedStateId: "rev-1", expectedContentHash: "hash-1" }
    }
  });
  // gera signed the revision that lost; drew and the User signed the winner.
  const signedLoser = event({
    kind: "artifact.signature.added", origin: "zzz-machine", seq: 2, ts: "310", eventId: "sig-loser",
    payload: {
      operationId: "op-sig-loser", targetKey: "artifact:plan",
      signer: "gera", signedStateId: "rev-2b", signedContentHash: "hash-2b"
    } as ChatActionPayload
  });
  const signedWinner = event({
    kind: "artifact.signature.added", origin: "aaa-machine", seq: 2, ts: "320", eventId: "sig-winner",
    payload: {
      operationId: "op-sig-winner", targetKey: "artifact:plan",
      signer: "drew", signedStateId: "rev-2a", signedContentHash: "hash-2a"
    } as ChatActionPayload
  });
  const signedWinnerToo = event({
    kind: "artifact.signature.added", origin: "mac", seq: 2, ts: "330", eventId: "sig-winner-2",
    payload: {
      operationId: "op-sig-winner-2", targetKey: "artifact:plan",
      signer: "user", signedStateId: "rev-2a", signedContentHash: "hash-2a"
    } as ChatActionPayload
  });

  const result = foldChatActionEvents([signedWinnerToo, loser, v1, signedLoser, winner, signedWinner]);
  const plan = result.targets.find((target) => target.targetKey === "artifact:plan");
  assert.ok(plan);

  assert.equal(plan.stateId, "rev-2a", "the earlier-sorted revision is the one projected");
  const supersede = result.superseded.find((entry) => entry.eventId === "loser");
  assert.ok(supersede, "the later-sorted revision must be visibly superseded, not silently dropped");
  assert.equal(supersede.reason, "state-changed");
  assert.equal(supersede.supersededBy, "winner");
  assert.equal(supersede.expectedStateId, "rev-1");
  assert.equal(supersede.actualStateId, "rev-2a");

  const loserSignature = plan.signatures.find((entry) => entry.signer === "gera");
  assert.ok(loserSignature);
  assert.equal(loserSignature.signedStateId, "rev-2b", "a signature never moves to content it did not read");
  assert.equal(loserSignature.signedContentHash, "hash-2b");
  assert.equal(loserSignature.countsTowardCurrent, false, "it must not count toward the winning revision");

  const counting = plan.signatures.filter((entry) => entry.countsTowardCurrent).map((entry) => entry.signer).sort();
  assert.deepEqual(counting, ["drew", "user"], "signatures from different signers on the winner accumulate");
});

test("a denial that sorts before an executed approval cannot erase what already happened", () => {
  const approved = event({
    kind: "permission.decided", origin: "phone", seq: 1, ts: "100", eventId: "approve",
    payload: { operationId: "op-approve", targetKey: "approval:card-1", stateId: "approved", detail: { approve: true } }
  });
  const receipt = event({
    kind: "execution.receipt", origin: "machine", seq: 1, ts: "150", eventId: "receipt",
    payload: {
      operationId: "op-write", targetKey: "approval:card-1",
      effect: "wrote src/index.ts", executedBy: "cloud-box", executedAt: "2026-09-07T00:00:01.000Z"
    } as ChatActionPayload
  });
  // The desktop denied it while offline; its logical time sorts AFTER the
  // approval but it arrives last.
  const denied = event({
    kind: "permission.decided", origin: "desktop", seq: 1, ts: "200", eventId: "deny",
    payload: { operationId: "op-deny", targetKey: "approval:card-1", stateId: "denied", detail: { approve: false } }
  });

  const result = foldChatActionEvents([denied, receipt, approved]);
  const card = result.targets.find((target) => target.targetKey === "approval:card-1");
  assert.ok(card);
  assert.equal(card.receipts.length, 1, "the receipt is immutable and is never removed by re-projection");
  assert.equal(card.receipts[0].effect, "wrote src/index.ts");
  assert.equal(result.applied.filter((entry) => entry.eventId === "receipt").length, 1, "a receipt is folded once, never replayed");

  const conflict = result.conflicts.find((entry) => entry.conflictingEventId === "deny");
  assert.ok(conflict, "both decisions must be visible beside the executed effect");
  assert.equal(conflict.receiptEventId, "receipt");
  assert.match(conflict.detail, /already happened on cloud-box/);
  // Both answers stayed in the log; nothing was rewritten to hide one.
  assert.deepEqual(result.applied.filter((e) => e.targetKey === "approval:card-1" && e.kind === "permission.decided")
    .map((e) => e.eventId).sort(), ["approve", "deny"]);
});

// --- ordering, idempotency and repair ---------------------------------------

test("every peer folds the same events to the same result whatever order they arrived in", () => {
  const events = [
    event({ kind: "artifact.revision.created", origin: "a", seq: 1, ts: "100", eventId: "one",
      payload: { operationId: "op1", targetKey: "artifact:x", stateId: "s1", contentHash: "h1" } }),
    event({ kind: "artifact.revision.created", origin: "b", seq: 1, ts: "200", eventId: "two",
      payload: { operationId: "op2", targetKey: "artifact:x", stateId: "s2", contentHash: "h2", precondition: { expectedStateId: "s1" } } }),
    event({ kind: "artifact.revision.created", origin: "c", seq: 1, ts: "150", eventId: "three",
      payload: { operationId: "op3", targetKey: "artifact:x", stateId: "s3", contentHash: "h3", precondition: { expectedStateId: "s1" } } })
  ];
  const forward = foldChatActionEvents(events);
  const reversed = foldChatActionEvents([...events].reverse());
  assert.deepEqual(reversed, forward, "arrival order must not change what any peer projects");
  // Logical order is 100 (s1), 150 (s3), 200 (s2). "three" read s1 and still
  // held it, so it applies; "two" also read s1, but by then s3 holds.
  assert.equal(forward.targets[0].stateId, "s3");
  assert.deepEqual(forward.superseded.map((entry) => entry.eventId), ["two"]);
  assert.equal(forward.superseded[0].supersededBy, "three");
});

test("the same operation folded twice changes nothing and is reported as a duplicate", () => {
  const first = event({ kind: "choice.answered", origin: "phone", seq: 1, ts: "100", eventId: "answer",
    payload: { operationId: "op-answer", targetKey: "choice:m1", stateId: "answered-a" } });
  const retry = event({ kind: "choice.answered", origin: "phone", seq: 2, ts: "110", eventId: "answer-retry",
    payload: { operationId: "op-answer", targetKey: "choice:m1", stateId: "answered-a" } });
  const result = foldChatActionEvents([first, retry]);
  assert.deepEqual(result.duplicates, ["answer-retry"]);
  assert.deepEqual(result.superseded, [], "a retry of the same answer is not a conflict");
  assert.equal(result.targets[0].stateId, "answered-a");
});

test("a missing sequence stops that origin instead of applying across the hole", () => {
  const first = event({ kind: "participant.request.opened", origin: "mac", seq: 1, ts: "100", eventId: "open",
    payload: { operationId: "op-open", targetKey: "request:r1", stateId: "open" } });
  const afterGap = event({ kind: "participant.request.answered", origin: "mac", seq: 3, ts: "300", eventId: "answered",
    payload: { operationId: "op-answer", targetKey: "request:r1", stateId: "answered" } });
  const result = foldChatActionEvents([first, afterGap]);
  assert.equal(result.targets[0].stateId, "open", "an event after a gap must wait for repair");
  assert.deepEqual(result.gaps.map((gap) => [gap.originId, gap.fromSeq, gap.toSeq]), [["mac", 2, 2]]);
  assert.deepEqual(result.applied.map((entry) => entry.eventId), ["open"]);
});

test("an unconditional action always applies and a stop is never superseded", () => {
  const stop = event({ kind: "turn.stop.requested", origin: "phone", seq: 1, ts: "500", eventId: "stop",
    payload: { operationId: "op-stop", targetKey: "run:r1", stateId: "stop-requested" } });
  const result = foldChatActionEvents([stop]);
  assert.deepEqual(result.superseded, []);
  assert.equal(result.targets[0].stateId, "stop-requested");
});
