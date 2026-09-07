import assert from "node:assert/strict";
import test from "node:test";
import { ChatActionApplier, type ChatActionArtifactPort } from "./chatActionApplier";
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

function artifacts(revisions: Record<string, { version: number; contentHash: string; superseded: boolean }>) {
  const inserted: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const port: ChatActionArtifactPort & { inserted: typeof inserted } = {
    inserted,
    async getRevision(_artifactId, versionEventId) { return revisions[versionEventId]; },
    async insertSignature(record) {
      const key = `${record.versionEventId}:${record.signer}`;
      if (seen.has(key)) return false;
      seen.add(key);
      inserted.push(record);
      return true;
    }
  };
  return port;
}

const signature = (overrides: Partial<ChatActionPayload> = {}): ChatActionPayload => ({
  operationId: "op-sig",
  targetKey: "artifact:plan",
  signer: "gera",
  signedStateId: "rev-1",
  signedContentHash: "hash-1",
  ...overrides
} as ChatActionPayload);

test("a signature made on another machine really lands on this one", async () => {
  const port = artifacts({ "rev-1": { version: 1, contentHash: "hash-1", superseded: false } });
  const applier = new ChatActionApplier({ artifacts: port });
  const result = await applier.apply(event("artifact.signature.added", signature()));
  assert.equal(result.status, "applied");
  assert.deepEqual(port.inserted, [{
    artifactId: "plan", version: 1, versionEventId: "rev-1", contentHash: "hash-1",
    signer: "gera", signedAt: "2026-09-07T08:00:00.000Z"
  }]);
});

test("re-delivering the same signature changes nothing", async () => {
  const port = artifacts({ "rev-1": { version: 1, contentHash: "hash-1", superseded: false } });
  const applier = new ChatActionApplier({ artifacts: port });
  await applier.apply(event("artifact.signature.added", signature()));
  const again = await applier.apply(event("artifact.signature.added", signature()));
  assert.equal(again.status, "duplicate");
  assert.equal(port.inserted.length, 1);
});

test("a signature for a revision this machine does not have is kept, not dropped", async () => {
  const port = artifacts({});
  const result = await new ChatActionApplier({ artifacts: port }).apply(
    event("artifact.signature.added", signature())
  );
  assert.equal(result.status, "deferred", "dropping it would lose a signature");
  assert.match(result.detail ?? "", /not on this machine yet/);
  assert.deepEqual(port.inserted, []);
});

test("a signature made on different content than this machine holds is refused, never re-pointed", async () => {
  const port = artifacts({ "rev-1": { version: 1, contentHash: "different-hash", superseded: false } });
  const result = await new ChatActionApplier({ artifacts: port }).apply(
    event("artifact.signature.added", signature())
  );
  assert.equal(result.status, "superseded");
  assert.match(result.detail ?? "", /signed different content/);
  assert.deepEqual(port.inserted, [], "it must not be attached to whatever the head happens to be");
});

test("a signature on a revision that lost a race is stored with it and said not to count", async () => {
  const port = artifacts({ "rev-1": { version: 1, contentHash: "hash-1", superseded: true } });
  const result = await new ChatActionApplier({ artifacts: port }).apply(
    event("artifact.signature.added", signature())
  );
  assert.equal(result.status, "applied");
  assert.match(result.detail ?? "", /does not count toward the current version/);
  assert.equal(port.inserted.length, 1, "it still belongs to the content its signer read");
});

test("a revision made on a base this machine has already replaced is shown as superseded", async () => {
  const port = artifacts({ "rev-1": { version: 1, contentHash: "hash-1", superseded: true } });
  const result = await new ChatActionApplier({ artifacts: port }).apply(event("artifact.revision.created", {
    operationId: "op-rev", targetKey: "artifact:plan", stateId: "rev-2b", contentHash: "hash-2b",
    precondition: { expectedStateId: "rev-1", expectedContentHash: "hash-1" }
  }));
  assert.equal(result.status, "superseded");
  assert.match(result.detail ?? "", /has since been replaced/);
});

test("a revision whose base is missing waits, and one already held is a duplicate", async () => {
  const missing = await new ChatActionApplier({ artifacts: artifacts({}) }).apply(event("artifact.revision.created", {
    operationId: "op-rev", targetKey: "artifact:plan", stateId: "rev-2", contentHash: "h2",
    precondition: { expectedStateId: "rev-1" }
  }));
  assert.equal(missing.status, "deferred");

  const held = await new ChatActionApplier({
    artifacts: artifacts({ "rev-2": { version: 2, contentHash: "h2", superseded: false } })
  }).apply(event("artifact.revision.created", {
    operationId: "op-rev", targetKey: "artifact:plan", stateId: "rev-2", contentHash: "h2",
    precondition: { expectedStateId: "rev-1" }
  }));
  assert.equal(held.status, "duplicate");
});

test("an execution receipt is applied as a fact and never repeated locally", async () => {
  const port = artifacts({});
  const result = await new ChatActionApplier({ artifacts: port }).apply(event("execution.receipt", {
    operationId: "op-receipt", targetKey: "approval:card-1",
    effect: "wrote src/index.ts", executedBy: "cloud-box", executedAt: "2026-09-07T08:00:00.000Z"
  } as ChatActionPayload));
  assert.equal(result.status, "applied");
  assert.deepEqual(port.inserted, [], "recording the fact is the whole application");
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
  assert.equal(applier.handles(event("artifact.signature.added", signature())), true);
  assert.equal(applier.handles(event("message.created", signature())), false);
  assert.equal(applier.handles(event("artifact.signature.added", {} as ChatActionPayload)), false);
});
