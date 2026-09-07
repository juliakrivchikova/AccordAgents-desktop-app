import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactService, artifactActionTarget, type ArtifactActionEmission } from "./artifacts";
import { ArtifactStore } from "./artifactStore";
import { foldChatActionEvents, CHAT_ACTION_LOG_SCOPE } from "../../shared/chatActionEvents";
import type { ChatEventEnvelope } from "../../shared/chatEvents";

const members = ["user", "drew", "gera"];

async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-artifact-actions-"));
  const store = new ArtifactStore(path.join(dir, "accordagents.sqlite3"), "sqlite3");
  const emitted: ArtifactActionEmission[] = [];
  const service = new ArtifactService({
    store,
    getMembers: async () => members,
    emitAction: async (action) => { emitted.push(action); }
  });
  return { service, emitted, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** The envelope the desktop appends for an emitted action. Sequences are per
 *  origin and start at 1, as a real emitter's do: a run that started at 4 would
 *  read as a gap and nothing would be applied. */
const seqByOrigin = new Map<string, number>();
let unique = 0;
function envelope(action: ArtifactActionEmission, origin: string, ts: string): ChatEventEnvelope {
  const seq = (seqByOrigin.get(origin) ?? 0) + 1;
  seqByOrigin.set(origin, seq);
  unique += 1;
  return {
    eventId: `chat-action:${action.payload.operationId}`,
    conversationId: action.conversationId,
    logScopeId: CHAT_ACTION_LOG_SCOPE,
    originId: origin,
    originSeq: seq,
    logicalTs: ts,
    kind: action.kind,
    payload: action.payload,
    payloadHash: `p${unique}`,
    eventHash: `h${unique}`,
    createdAt: "2026-09-07T00:00:00.000Z"
  };
}

test("signing and revising a real artifact emit canonical actions that fold to the same state", async () => {
  const h = await harness();
  try {
    const created = await h.service.create("user", {
      conversationId: "chat", name: "plan", content: "v1", requiredSigners: ["drew"]
    });
    assert.equal(created.ok, true, created.ok ? "" : created.error.message);
    const artifactId = created.ok ? created.value.summary.id : "";

    const signed = await h.service.sign("drew", { conversationId: "chat", artifactId });
    assert.equal(signed.ok, true, signed.ok ? "" : signed.error.message);
    const revised = await h.service.revise("user", { conversationId: "chat", artifactId, baseVersion: 1, content: "v2" });
    assert.equal(revised.ok, true, revised.ok ? "" : revised.error.message);

    // A user action really produced events; the module is not dead code.
    // Creating establishes the target's first state, so a peer folding the log
    // has something for the first revision's precondition to match.
    assert.deepEqual(h.emitted.map((action) => action.kind),
      ["artifact.revision.created", "artifact.signature.added", "artifact.revision.created"]);

    const signature = h.emitted[1].payload as unknown as { signedStateId: string; signedContentHash: string; signer: string };
    const revision = h.emitted[2].payload;
    assert.equal(h.emitted[0].payload.stateId, signature.signedStateId, "v1 is the state the signer read");
    assert.equal(h.emitted[0].payload.precondition, undefined, "the first state is unconditional");
    assert.equal(signature.signer, "drew");
    assert.ok(signature.signedStateId, "a signature names the revision it read");
    assert.ok(signature.signedContentHash);
    assert.equal(revision.precondition?.expectedStateId, signature.signedStateId,
      "the revision states the base its author actually read");
    assert.equal(h.emitted.every((action) => action.payload.targetKey === artifactActionTarget(artifactId)), true);

    // Folding those same events on any peer reproduces the outcome, and the
    // signature made on v1 does not follow the artifact to v2.
    const folded = foldChatActionEvents([
      envelope(h.emitted[0], "mac", "100"),
      envelope(h.emitted[1], "mac", "200"),
      envelope(h.emitted[2], "mac", "300")
    ]);
    const target = folded.targets[0];
    assert.equal(target.stateId, revision.stateId);
    assert.equal(target.signatures.length, 1);
    assert.equal(target.signatures[0].countsTowardCurrent, false,
      "a signature on v1 must not count toward v2");
    assert.deepEqual(folded.superseded, []);
  } finally { await h.cleanup(); }
});

test("a second machine revising the same base is folded as superseded, not as an overwrite", async () => {
  const h = await harness();
  try {
    const created = await h.service.create("user", { conversationId: "chat", name: "plan", content: "v1" });
    const artifactId = created.ok ? created.value.summary.id : "";
    await h.service.revise("user", { conversationId: "chat", artifactId, baseVersion: 1, content: "v2-mac" });
    const first = h.emitted[0];
    const mine = h.emitted.at(-1);
    assert.ok(mine && first);

    // The other machine revised the SAME base while disconnected.
    const theirs: ArtifactActionEmission = {
      conversationId: "chat",
      kind: "artifact.revision.created",
      payload: {
        operationId: `artifact-revision:${artifactId}:other-rev`,
        targetKey: artifactActionTarget(artifactId),
        stateId: "other-rev",
        contentHash: "other-hash",
        precondition: mine.payload.precondition
      }
    };

    const folded = foldChatActionEvents([
      envelope(first, "aaa-mac", "050"),
      envelope(mine, "aaa-mac", "100"),
      envelope(theirs, "zzz-box", "200")
    ]);
    assert.equal(folded.targets[0].stateId, mine.payload.stateId, "the earlier-sorted revision wins");
    assert.equal(folded.superseded.length, 1);
    assert.equal(folded.superseded[0].reason, "state-changed");
    assert.equal(folded.superseded[0].targetKey, artifactActionTarget(artifactId));
  } finally { await h.cleanup(); }
});

test("a failing emitter never undoes a change the User already made", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-artifact-emit-fail-"));
  try {
    const store = new ArtifactStore(path.join(dir, "accordagents.sqlite3"), "sqlite3");
    const logged: string[] = [];
    const service = new ArtifactService({
      store,
      getMembers: async () => members,
      logger: (event) => logged.push(event),
      emitAction: async () => { throw new Error("outbox write failed"); }
    });
    const created = await service.create("user", { conversationId: "chat", name: "plan", content: "v1" });
    const artifactId = created.ok ? created.value.summary.id : "";
    const revised = await service.revise("user", { conversationId: "chat", artifactId, baseVersion: 1, content: "v2" });
    assert.equal(revised.ok, true, "the revision stands even though its event could not be emitted");
    assert.ok(logged.includes("artifact.action.emit-failed"), "and the failure is reported, not swallowed");
    const read = await service.read("user", { conversationId: "chat", artifactId });
    assert.equal(read.ok && read.value.lifecycle === "published" && read.value.version.content, "v2");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
