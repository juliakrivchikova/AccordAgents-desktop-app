import assert from "node:assert/strict";
import test from "node:test";
import { ChatActionApplier } from "./chatActionApplier";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { ChatActionPayload } from "../../shared/chatActionEvents";

function event(kind: string, payload: ChatActionPayload): ChatEventEnvelope {
  return {
    eventId: `chat-action:${payload.operationId}`,
    conversationId: "chat",
    logScopeId: "chat:actions",
    originId: "other-machine",
    originSeq: 1,
    logicalTs: "hlc:0000000000100:000000:other-machine",
    kind,
    payload,
    payloadHash: "p",
    eventHash: "h",
    createdAt: "2026-09-07T08:00:00.000Z"
  };
}

test("an answer arriving before its request remains pending, while a foreign owner's answer does not execute here", async () => {
  let owner: boolean | undefined;
  let applied = 0;
  const applier = new ChatActionApplier({ effects: {
    owns: async () => owner, claim: async () => { throw new Error("A receipt lookup is not admission"); },
    perform: async () => { throw new Error("Must use the native approval executor"); }, record: async () => {},
    applyApproval: async () => { applied++; return "allowed"; }
  } });
  const answer = event("permission.decided", { operationId: "answer", targetKey: "approval:card", detail: { approve: true } });
  assert.equal((await applier.apply(answer)).status, "deferred");
  owner = false;
  assert.equal((await applier.apply(answer)).status, "applied");
  assert.equal(applied, 0);
  owner = true;
  assert.equal((await applier.apply(answer)).status, "applied");
  assert.equal(applied, 1);
});

test("an execution receipt is applied as a fact and never repeated locally", async () => {
  const result = await new ChatActionApplier({}).apply(event("execution.receipt", {
    operationId: "op-receipt", targetKey: "approval:card-1",
    effect: "wrote src/index.ts", executedBy: "cloud-box", executedAt: "2026-09-07T08:00:00.000Z"
  } as ChatActionPayload));
  assert.equal(result.status, "applied", "recording the fact is the whole application");
});

function effects(options: { owns?: boolean; claimed?: Set<string>; fail?: boolean } = {}) {
  const claimed = options.claimed ?? new Set<string>();
  const performed: string[] = [];
  const recorded: Array<{ targetKey: string; effect: string }> = [];
  return {
    performed,
    recorded,
    claimed,
    port: {
      async owns() { return options.owns !== false; },
      async claim(targetKey: string) {
        if (claimed.has(targetKey)) return false;
        claimed.add(targetKey);
        return true;
      },
      async perform(request: { targetKey: string; kind: string }) {
        if (options.fail) throw new Error("provider is gone");
        performed.push(`${request.kind}:${request.targetKey}`);
        return `answered ${request.targetKey}`;
      },
      async record(request: { targetKey: string; effect: string }) { recorded.push(request); }
    }
  };
}

test("the peer that holds the request acts on a decision made elsewhere, exactly once", async () => {
  const port = effects();
  const applier = new ChatActionApplier({ effects: port.port });
  const decision = event("permission.decided", {
    operationId: "permission:card-1:allow", targetKey: "approval:card-1", stateId: "approved"
  });
  const first = await applier.apply(decision);
  assert.equal(first.status, "applied");
  assert.deepEqual(port.performed, ["permission.decided:approval:card-1"]);
  assert.equal(port.recorded.length, 1);

  // The opposite answer from a third device arrives afterwards.
  const opposite = await applier.apply(event("permission.decided", {
    operationId: "permission:card-1:deny", targetKey: "approval:card-1", stateId: "denied"
  }));
  assert.equal(opposite.status, "applied");
  assert.match(opposite.detail ?? "", /already acted on here/);
  assert.equal(port.performed.length, 1, "the provider is told once");
  assert.equal(port.recorded.length, 1);
});

test("a peer that does not hold the request records the decision without acting", async () => {
  const port = effects({ owns: false });
  const result = await new ChatActionApplier({ effects: port.port }).apply(event("permission.decided", {
    operationId: "permission:card-2:allow", targetKey: "approval:card-2", stateId: "approved"
  }));
  assert.equal(result.status, "applied");
  assert.deepEqual(port.performed, []);
  assert.deepEqual(port.recorded, []);
});

test("an effect that fails is kept for retry and never recorded as done", async () => {
  const port = effects({ fail: true });
  const logged: string[] = [];
  const result = await new ChatActionApplier({ effects: port.port, logger: (name) => logged.push(name) })
    .apply(event("turn.stop.requested", {
      operationId: "stop:run-1", targetKey: "run:run-1", stateId: "stop-requested"
    }));
  assert.equal(result.status, "deferred");
  assert.deepEqual(port.recorded, [], "nothing may claim the effect happened");
  assert.ok(logged.includes("chat.action.effect-failed"));
});

test("a choice answered elsewhere is acted on by the peer running the turn", async () => {
  const port = effects();
  const result = await new ChatActionApplier({ effects: port.port }).apply(event("choice.answered", {
    operationId: "choice:c-1:opt-2", targetKey: "choice:c-1", stateId: "opt-2"
  }));
  assert.equal(result.status, "applied");
  assert.deepEqual(port.performed, ["choice.answered:choice:c-1"]);
});

test("only action events are handled, and a malformed payload is not", () => {
  const applier = new ChatActionApplier();
  const answer = { operationId: "op-answer", targetKey: "approval:card", detail: { approve: true } } as ChatActionPayload;
  assert.equal(applier.handles(event("permission.decided", answer)), true);
  assert.equal(applier.handles(event("message.created", answer)), false);
  assert.equal(applier.handles(event("permission.decided", {} as ChatActionPayload)), false);
  // Documents are the server's (Д9): a document event of the old scheme is
  // not a chat action any more.
  assert.equal(applier.handles(event("artifact.signature.added", answer)), false);
});
