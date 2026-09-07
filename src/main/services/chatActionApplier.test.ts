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

test("only action events are handled, and a malformed payload is not", () => {
  const applier = new ChatActionApplier();
  assert.equal(applier.handles(event("artifact.signature.added", signature())), true);
  assert.equal(applier.handles(event("message.created", signature())), false);
  assert.equal(applier.handles(event("artifact.signature.added", {} as ChatActionPayload)), false);
});
