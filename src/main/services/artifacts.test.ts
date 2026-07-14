import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactService } from "./artifacts";
import { ArtifactStore } from "./artifactStore";
import type { ArtifactDraftRecord, ArtifactOperationRecord } from "./artifactStore";
import { runCommand } from "./command";
import { parseMarkdownInline } from "../../shared/markdownInline";
import { unifiedLineDiff } from "../../shared/artifactDiff";
import type { ArtifactError, ArtifactReadResult, ArtifactResult, PublishedArtifactReadResult } from "../../shared/types";

const CONVERSATION_ID = "chat-1";
const MEMBERS = ["user", "gera", "codex", "drew"];
const NOW_FOR_LEGACY = "2026-07-13T12:00:00.000Z";

interface Harness {
  dbPath: string;
  store: ArtifactStore;
  service: ArtifactService;
  notes: string[];
  changed: string[];
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), "artifact-service-"));
  const dbPath = path.join(dir, "artifacts.sqlite3");
  const { store, service, notes, changed } = attach(dbPath);
  return {
    dbPath,
    store,
    service,
    notes,
    changed,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

// A second attach() over the same dbPath simulates an app restart (or another
// writer that does not share the first service's in-memory mutation queue).
function attach(
  dbPath: string,
  getMembers: (conversationId: string) => Promise<string[] | undefined> = async (conversationId) => (
    conversationId === CONVERSATION_ID ? [...MEMBERS] : undefined
  )
): { store: ArtifactStore; service: ArtifactService; notes: string[]; changed: string[] } {
  const store = new ArtifactStore(dbPath);
  const notes: string[] = [];
  const changed: string[] = [];
  const service = new ArtifactService({
    store,
    getMembers,
    postNote: async (_conversationId, _eventId, content) => {
      notes.push(content);
    },
    onChanged: (conversationId) => {
      changed.push(conversationId);
    }
  });
  return { store, service, notes, changed };
}

function expectOk<T>(result: ArtifactResult<T>): T {
  assert.ok(result.ok, `expected ok result, got: ${result.ok ? "" : JSON.stringify(result.error)}`);
  return result.value;
}

function expectError<T>(result: ArtifactResult<T>, code: ArtifactError["code"]): ArtifactError {
  assert.ok(!result.ok, `expected ${code} error, got ok result`);
  assert.equal(result.error.code, code, `expected ${code}, got ${result.error.code}: ${result.error.message}`);
  return result.error;
}

function expectPublished(result: ArtifactReadResult): PublishedArtifactReadResult {
  assert.equal(result.lifecycle, "published", "expected a published artifact result");
  if (result.lifecycle !== "published") {
    throw new Error("Expected a published artifact result.");
  }
  return result;
}

test("create + read: every member reads the current version; non-members are rejected; list stays lean", async () => {
  const h = await harness();
  try {
    const created = expectPublished(expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Release Plan",
      content: "Step 1: ship it.",
      contributors: ["codex"],
      requiredSigners: ["user", "drew"],
      labels: ["plan"]
    })));
    assert.equal(created.summary.name, "Release Plan");
    assert.equal(created.summary.owner, "gera");
    assert.deepEqual(created.summary.contributors, ["codex"]);
    assert.equal(created.summary.headVersion, 1);
    assert.equal(created.version.content, "Step 1: ship it.");
    assert.equal(created.summary.approval.state, "unsigned");

    // Any member can read, by name or id, with "@" and case tolerated for actors.
    const readByUser = expectPublished(expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, name: "release plan" })));
    assert.equal(readByUser.version.content, "Step 1: ship it.");
    const readByDrew = expectOk(await h.service.read("@drew", { conversationId: CONVERSATION_ID, artifactId: created.summary.id }));
    assert.equal(readByDrew.summary.id, created.summary.id);

    // Not a chat member -> clean access_denied.
    expectError(await h.service.list("mallory", CONVERSATION_ID), "access_denied");
    expectError(await h.service.read("mallory", { conversationId: CONVERSATION_ID, name: "Release Plan" }), "access_denied");
    // Unknown chat -> not_found.
    expectError(await h.service.list("gera", "missing-chat"), "not_found");

    // Listing returns summaries without contents; plain read returns no history.
    const list = expectOk(await h.service.list("codex", CONVERSATION_ID));
    assert.equal(list.length, 1);
    assert.ok(!("content" in list[0]), "list summaries must not embed contents");
    assert.equal(readByUser.history, undefined, "read without includeHistory must not return history");

    // Duplicate name (case-insensitive) is rejected.
    expectError(await h.service.create("codex", {
      conversationId: CONVERSATION_ID,
      name: "  RELEASE   plan ",
      content: "other"
    }), "name_taken");
  } finally {
    await h.cleanup();
  }
});

test("revise advances the head; earlier versions and comparisons stay retrievable", async () => {
  const h = await harness();
  try {
    const created = expectPublished(expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "QA Cases",
      content: "case A\ncase B",
      contributors: ["codex"]
    })));
    const revised = expectPublished(expectOk(await h.service.revise("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      baseVersion: 1,
      content: "case A\ncase B\ncase C",
      note: "added case C"
    })));
    assert.equal(revised.summary.headVersion, 2);
    assert.equal(revised.version.version, 2);

    const v1 = expectPublished(expectOk(await h.service.read("drew", { conversationId: CONVERSATION_ID, artifactId: created.summary.id, version: 1 })));
    assert.equal(v1.version.content, "case A\ncase B");

    const withHistory = expectPublished(expectOk(await h.service.read("user", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      includeHistory: true
    })));
    assert.equal(withHistory.history?.length, 2);
    assert.ok(withHistory.history?.every((meta) => !("content" in meta)), "history must be metadata-only");
    assert.equal(withHistory.history?.[1]?.note, "added case C");

    const diff = expectOk(await h.service.diff("user", {
      conversationId: CONVERSATION_ID,
      name: "QA Cases",
      fromVersion: 1,
      toVersion: 2
    }));
    assert.ok(diff.diff.includes("+case C"), `diff should show the added line, got:\n${diff.diff}`);

    expectError(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: created.summary.id, version: 9 }), "not_found");
  } finally {
    await h.cleanup();
  }
});

// Done-means #3. Two members revise the same base version at the same time.
// This cannot be forced deterministically through the UI: two humans/agents
// would have to land IPC calls in the same few-millisecond window, and the
// per-conversation mutation queue in ArtifactService immediately serializes
// whatever interleaving the transport produced. Driving the service API with
// Promise.all reproduces the exact contended state deterministically: both
// calls enter with baseVersion 1, the queue admits them in order, the first
// wins, and the second is guaranteed to observe head=2 and get stale_version.
test("concurrent revisions of the same base: exactly one accepted, the other told it is stale and given the current version", async () => {
  const h = await harness();
  try {
    const created = expectPublished(expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Decision",
      content: "v1 text",
      contributors: ["codex", "drew"]
    })));
    const [first, second] = await Promise.all([
      h.service.revise("codex", { conversationId: CONVERSATION_ID, artifactId: created.summary.id, baseVersion: 1, content: "codex version" }),
      h.service.revise("drew", { conversationId: CONVERSATION_ID, artifactId: created.summary.id, baseVersion: 1, content: "drew version" })
    ]);
    const okResults = [first, second].filter((result) => result.ok);
    const staleResults = [first, second].filter((result) => !result.ok);
    assert.equal(okResults.length, 1, "exactly one concurrent revision must be accepted");
    assert.equal(staleResults.length, 1, "exactly one concurrent revision must be rejected as stale");

    const stale = staleResults[0];
    assert.ok(!stale.ok);
    assert.equal(stale.error.code, "stale_version");
    assert.equal(stale.error.currentVersion, 2);
    const winnerContent = okResults[0].ok ? expectPublished(okResults[0].value).version.content : "";
    assert.equal(stale.error.current?.content, winnerContent, "loser must be given the current version to redo its edit");

    // No lost update: head is exactly v2 with the winner's content, and v1 is intact.
    const head = expectPublished(expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: created.summary.id })));
    assert.equal(head.summary.headVersion, 2);
    assert.equal(head.version.content, winnerContent);
    const v1 = expectPublished(expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: created.summary.id, version: 1 })));
    assert.equal(v1.version.content, "v1 text");

    // The informed loser can redo the change on the current version.
    const redo = expectOk(await h.service.revise("drew", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      baseVersion: 2,
      content: `${winnerContent}\ndrew addition`
    }));
    assert.equal(redo.summary.headVersion, 3);
  } finally {
    await h.cleanup();
  }
});

// Defense in depth for writers that do not share one in-memory queue (e.g. a
// second process): the store's guarded append refuses a stale expected head.
test("store-level guard rejects an append based on a stale head across independent writers", async () => {
  const h = await harness();
  try {
    const created = expectPublished(expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Cross Process",
      content: "base"
    })));
    const other = attach(h.dbPath); // independent store over the same database
    const accepted = await other.store.appendVersion(
      { artifactId: created.summary.id, version: 2, content: "writer A", author: "gera", createdAt: new Date().toISOString() },
      1
    );
    assert.equal(accepted, true);
    const rejected = await h.store.appendVersion(
      { artifactId: created.summary.id, version: 2, content: "writer B", author: "gera", createdAt: new Date().toISOString() },
      1
    );
    assert.equal(rejected, false, "second writer with stale expected head must not win");
    const head = await h.store.getVersion(created.summary.id, 2);
    assert.equal(head?.content, "writer A");
    const record = await h.store.getById(created.summary.id);
    assert.equal(record?.headVersion, 2);
  } finally {
    await h.cleanup();
  }
});

// Done-means #4.
test("signatures bind to versions; a revision starts unsigned; fully approved needs every required signer on the current version", async () => {
  const h = await harness();
  try {
    const created = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Spec",
      content: "spec v1",
      requiredSigners: ["user", "drew"]
    }));
    const id = created.summary.id;

    // Non-required member cannot sign, and nothing changes.
    expectError(await h.service.sign("codex", { conversationId: CONVERSATION_ID, artifactId: id }), "access_denied");

    let summary = expectOk(await h.service.sign("drew", { conversationId: CONVERSATION_ID, artifactId: id }));
    assert.equal(summary.approval.state, "partially-signed");
    assert.deepEqual(summary.approval.signedCurrent, ["drew"]);

    summary = expectOk(await h.service.sign("user", { conversationId: CONVERSATION_ID, artifactId: id }));
    assert.equal(summary.approval.state, "approved");

    // Duplicate signing is idempotent.
    summary = expectOk(await h.service.sign("drew", { conversationId: CONVERSATION_ID, artifactId: id, version: 1 }));
    assert.equal(summary.approval.state, "approved");

    // Revising creates an unsigned new version; v1 signatures are preserved in history.
    const revised = expectPublished(expectOk(await h.service.revise("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: id,
      baseVersion: 1,
      content: "spec v2"
    })));
    assert.equal(revised.summary.approval.state, "unsigned");
    assert.equal(revised.version.signatures.length, 0);
    const v1 = expectPublished(expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: id, version: 1 })));
    assert.equal(v1.version.signatures.length, 2, "signatures on the earlier version must be preserved");

    // Approval turns on only when all required signers sign the CURRENT version.
    expectOk(await h.service.sign("drew", { conversationId: CONVERSATION_ID, artifactId: id }));
    const partial = expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: id }));
    assert.equal(partial.summary.approval.state, "partially-signed");
    const approved = expectOk(await h.service.sign("user", { conversationId: CONVERSATION_ID, artifactId: id }));
    assert.equal(approved.approval.state, "approved");
  } finally {
    await h.cleanup();
  }
});

// Done-means #5.
test("rename is label-only: identity, versions, and signatures survive; freed names never redirect old references", async () => {
  const h = await harness();
  try {
    const created = expectPublished(expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Plan A",
      content: "original plan",
      requiredSigners: ["user"]
    })));
    const id = created.summary.id;
    expectOk(await h.service.sign("user", { conversationId: CONVERSATION_ID, artifactId: id }));

    // Non-contributor cannot rename.
    expectError(await h.service.rename("drew", { conversationId: CONVERSATION_ID, artifactId: id, newName: "Hijack" }), "access_denied");

    const renamed = expectOk(await h.service.rename("gera", { conversationId: CONVERSATION_ID, artifactId: id, newName: "Plan B" }));
    assert.equal(renamed.id, id, "identity must be stable across renames");
    assert.equal(renamed.name, "Plan B");
    assert.equal(renamed.headVersion, 1, "rename must not create a version");
    assert.equal(renamed.approval.state, "approved", "signatures must survive a rename");

    // The freed name can be reassigned to a NEW artifact...
    const successor = expectOk(await h.service.create("codex", {
      conversationId: CONVERSATION_ID,
      name: "Plan A",
      content: "a different document"
    }));
    assert.notEqual(successor.summary.id, id);
    // ...and references by the old artifact's stable id still point at the original.
    const original = expectPublished(expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: id })));
    assert.equal(original.summary.name, "Plan B");
    assert.equal(original.version.content, "original plan");
    // Find-by-name resolves the new holder of the name.
    const byName = expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, name: "plan a" }));
    assert.equal(byName.summary.id, successor.summary.id);

    // Uniqueness still enforced, case-insensitively, for renames too.
    expectError(await h.service.rename("codex", { conversationId: CONVERSATION_ID, artifactId: successor.summary.id, newName: "PLAN B" }), "name_taken");
  } finally {
    await h.cleanup();
  }
});

test("rename and its outbox note commit or roll back together", async () => {
  const h = await harness();
  try {
    const created = expectPublished(expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Atomic rename",
      content: "body"
    })));
    await runCommand("sqlite3", [h.dbPath], {
      input: `
        create trigger fail_rename_note before insert on artifact_event_outbox
        when new.kind = 'rename_fail'
        begin select raise(abort, 'injected outbox failure'); end;
      `,
      primeLoginShellEnv: false
    });
    await assert.rejects(h.store.updateName(
      created.summary.id,
      "Must roll back",
      "must roll back",
      "2026-07-13T14:00:00.000Z",
      {
        id: "rename-failure-event",
        conversationId: CONVERSATION_ID,
        artifactId: created.summary.id,
        kind: "rename_fail",
        actor: "gera",
        content: "metadata only",
        createdAt: "2026-07-13T14:00:00.000Z"
      }
    ));
    assert.equal((await h.store.getById(created.summary.id))?.name, "Atomic rename");
  } finally {
    await h.cleanup();
  }
});

// Done-means #7 (plus owner-only management).
test("access control: denied operations change nothing; owner manages the sets", async () => {
  const h = await harness();
  try {
    const created = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Guarded",
      content: "v1",
      contributors: ["codex"]
    }));
    const id = created.summary.id;

    // Non-contributor revise -> clean rejection, no partial change.
    expectError(await h.service.revise("drew", { conversationId: CONVERSATION_ID, artifactId: id, baseVersion: 1, content: "sneaky" }), "access_denied");
    const after = expectPublished(expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: id, includeHistory: true })));
    assert.equal(after.summary.headVersion, 1);
    assert.equal(after.history?.length, 1);

    // Only the owner manages access.
    expectError(await h.service.updateAccess("codex", { conversationId: CONVERSATION_ID, artifactId: id, contributors: ["codex", "drew"] }), "access_denied");
    // Sets must be current chat members.
    expectError(await h.service.updateAccess("gera", { conversationId: CONVERSATION_ID, artifactId: id, requiredSigners: ["mallory"] }), "invalid_request");
    expectError(await h.service.create("gera", { conversationId: CONVERSATION_ID, name: "Bad Members", content: "x", contributors: ["mallory"] }), "invalid_request");

    const updated = expectOk(await h.service.updateAccess("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: id,
      contributors: ["codex", "drew"],
      requiredSigners: ["user"]
    }));
    assert.deepEqual(updated.contributors, ["codex", "drew"]);
    const revised = expectOk(await h.service.revise("drew", { conversationId: CONVERSATION_ID, artifactId: id, baseVersion: 1, content: "v2 by drew" }));
    assert.equal(revised.summary.headVersion, 2);

    // Ownership transfer: previous owner loses management rights.
    expectOk(await h.service.updateAccess("gera", { conversationId: CONVERSATION_ID, artifactId: id, owner: "codex" }));
    expectError(await h.service.updateAccess("gera", { conversationId: CONVERSATION_ID, artifactId: id, requiredSigners: [] }), "access_denied");
  } finally {
    await h.cleanup();
  }
});

// Done-means #8: restart simulation. A brand-new store + service over the same
// database file must see the full artifact state (nothing lives in memory or
// in conversation payloads).
test("artifacts, versions, and signatures survive a restart", async () => {
  const h = await harness();
  try {
    const created = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Durable",
      content: "v1",
      requiredSigners: ["user"]
    }));
    expectOk(await h.service.revise("gera", { conversationId: CONVERSATION_ID, artifactId: created.summary.id, baseVersion: 1, content: "v2" }));
    expectOk(await h.service.sign("user", { conversationId: CONVERSATION_ID, artifactId: created.summary.id }));

    const restarted = attach(h.dbPath);
    const list = expectOk(await restarted.service.list("user", CONVERSATION_ID));
    assert.equal(list.length, 1);
    assert.equal(list[0].headVersion, 2);
    assert.equal(list[0].approval.state, "approved");
    const detail = expectPublished(expectOk(await restarted.service.read("user", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      includeHistory: true
    })));
    assert.equal(detail.version.content, "v2");
    assert.equal(detail.history?.length, 2);
    assert.equal(detail.version.signatures.length, 1);
  } finally {
    await h.cleanup();
  }
});

// Done-means #6 (backend side): notes are brief links, never the body.
test("chat notes carry a stable-id link and never the artifact body", async () => {
  const h = await harness();
  try {
    const body = "SECRET-BODY-DO-NOT-EMBED";
    const created = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Linked",
      content: body,
      requiredSigners: ["user"]
    }));
    expectOk(await h.service.revise("gera", { conversationId: CONVERSATION_ID, artifactId: created.summary.id, baseVersion: 1, content: `${body} v2` }));
    expectOk(await h.service.sign("user", { conversationId: CONVERSATION_ID, artifactId: created.summary.id }));
    expectOk(await h.service.rename("gera", { conversationId: CONVERSATION_ID, artifactId: created.summary.id, newName: "Linked Renamed" }));

    assert.equal(h.notes.length, 4, "create, revise, sign, and rename each post one note");
    for (const note of h.notes) {
      assert.ok(note.includes(`(#artifact:${created.summary.id})`), `note must link the stable id: ${note}`);
      assert.ok(!note.includes(body), `note must never contain the artifact body: ${note}`);
    }
    assert.ok(h.notes[2].includes("fully approved"), "sign note reports approval state at a glance");
    assert.ok(h.changed.length >= 4, "every change notifies the renderer");
  } finally {
    await h.cleanup();
  }
});

test("artifact reference tokens parse into artifact links (rename-safe by id)", () => {
  const labeled = parseMarkdownInline("See [Release Plan](#artifact:0b9f3d3a-1) for details.");
  const link = labeled.find((node) => node.type === "artifactLink");
  assert.deepEqual(link, { type: "artifactLink", artifactId: "0b9f3d3a-1", label: "Release Plan" });

  const bare = parseMarkdownInline("ref #artifact:abc-123 end");
  const bareLink = bare.find((node) => node.type === "artifactLink");
  assert.deepEqual(bareLink, { type: "artifactLink", artifactId: "abc-123" });

  // Message links keep working unchanged.
  const message = parseMarkdownInline("see [msg](#msg:xyz)");
  assert.equal(message.find((node) => node.type === "messageLink") !== undefined, true);
});

test("unified line diff marks additions, deletions, and unchanged context", () => {
  const diff = unifiedLineDiff("a\nb\nc", "a\nB\nc\nd");
  assert.ok(diff.includes("-b"));
  assert.ok(diff.includes("+B"));
  assert.ok(diff.includes("+d"));
  assert.ok(diff.includes(" a"));
  const same = unifiedLineDiff("x", "x");
  assert.ok(same.includes("(no changes)"));
});

test("collecting lifecycle enforces draft ACLs, blocks early publication, and publishes v1 with provenance", async () => {
  const h = await harness();
  try {
    const created = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Draft collection",
      initialState: "collecting_drafts",
      contributors: ["codex", "drew"],
      allowedDraftAuthors: ["gera", "codex", "drew"],
      requiredDraftAuthors: ["gera", "codex", "drew"],
      audiencePolicyByAuthor: {
        gera: { allowedReaders: [], requiredReaders: [] },
        codex: { allowedReaders: ["gera"], requiredReaders: ["gera"] },
        drew: { allowedReaders: ["gera"], requiredReaders: ["gera"] }
      },
      operationId: "collection:thread-1:create"
    }));
    assert.equal(created.lifecycle, "collecting_drafts");
    assert.equal(created.summary.headVersion, 0);
    assert.equal(created.readyToPublish, false);
    expectError(await h.service.revise("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      baseVersion: 1,
      content: "too early"
    }), "invalid_request");
    expectError(await h.service.sign("user", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id
    }), "invalid_request");

    const ownerEditing = expectOk(await h.service.saveDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      expectedEditRevision: 0,
      content: "OWNER-PRIVATE",
      readers: [],
      operationId: "collection:thread-1:draft:gera:save:1"
    }));
    const peerBeforeSubmit = expectOk(await h.service.listDrafts("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id
    }));
    assert.equal(peerBeforeSubmit.length, 0, "an unauthorized editing draft must not disclose existence");
    expectError(await h.service.readDraft("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      draftId: ownerEditing.id
    }), "not_found");
    const userEditing = expectOk(await h.service.readDraft("user", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      draftId: ownerEditing.id
    }));
    assert.equal(userEditing.content, "OWNER-PRIVATE");
    assert.deepEqual(userEditing.effectiveReaders, ["user", "gera"]);

    const ownerSubmitted = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      draftId: ownerEditing.id,
      expectedEditRevision: ownerEditing.editRevision,
      operationId: "collection:thread-1:draft:gera:submit"
    }));
    const peerAfterSubmit = expectOk(await h.service.listDrafts("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id
    }));
    assert.equal(peerAfterSubmit.length, 1);
    assert.equal(peerAfterSubmit[0].hasContent, false, "submitted metadata may be visible but not the body");
    expectError(await h.service.readDraft("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      draftId: ownerSubmitted.id
    }), "access_denied");

    const codexEditing = expectOk(await h.service.saveDraft("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      expectedEditRevision: 0,
      content: "CODEX-PRIVATE",
      readers: ["gera"],
      operationId: "collection:thread-1:draft:codex:save:1"
    }));
    const codexSubmitted = expectOk(await h.service.submitDraft("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      draftId: codexEditing.id,
      expectedEditRevision: codexEditing.editRevision,
      operationId: "collection:thread-1:draft:codex:submit"
    }));
    assert.equal((expectOk(await h.service.readDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      draftId: codexSubmitted.id
    }))).content, "CODEX-PRIVATE");
    expectError(await h.service.readDraft("drew", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      draftId: codexSubmitted.id
    }), "access_denied");
    expectError(await h.service.publish("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      content: "published content",
      requiredSigners: ["gera", "codex", "drew"],
      sources: [
        { draftId: ownerSubmitted.id, disposition: "considered" },
        { draftId: codexSubmitted.id, disposition: "considered" }
      ],
      operationId: "collection:thread-1:publish"
    }), "invalid_request");

    const drewEditing = expectOk(await h.service.saveDraft("drew", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      expectedEditRevision: 0,
      content: "DREW-PRIVATE",
      readers: ["gera"],
      operationId: "collection:thread-1:draft:drew:save:1"
    }));
    const drewSubmitted = expectOk(await h.service.submitDraft("drew", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      draftId: drewEditing.id,
      expectedEditRevision: drewEditing.editRevision,
      operationId: "collection:thread-1:draft:drew:submit"
    }));
    const published = expectOk(await h.service.publish("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      content: "PUBLISHED-V1",
      requiredSigners: ["gera", "codex", "drew"],
      sources: [
        { draftId: ownerSubmitted.id, disposition: "considered" },
        { draftId: codexSubmitted.id, disposition: "considered" },
        { draftId: drewSubmitted.id, disposition: "considered" }
      ],
      operationId: "collection:thread-1:publish"
    }));
    const publishedRetry = expectOk(await h.service.publish("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      content: "PUBLISHED-V1",
      requiredSigners: ["gera", "codex", "drew"],
      sources: [
        { draftId: ownerSubmitted.id, disposition: "considered" },
        { draftId: codexSubmitted.id, disposition: "considered" },
        { draftId: drewSubmitted.id, disposition: "considered" }
      ],
      operationId: "collection:thread-1:publish"
    }));
    assert.equal(published.lifecycle, "published");
    assert.equal(published.version.version, 1);
    assert.equal(published.version.content, "PUBLISHED-V1");
    assert.equal(published.version.signatures.length, 0, "draft authorship must not imply approval");
    assert.equal(published.summary.approval.state, "unsigned");
    assert.equal(published.sources?.length, 3);
    assert.equal(publishedRetry.version.version, 1);
    assert.equal(h.notes.filter((note) => note.includes(" published ")).length, 1);
    assert.ok(published.sources?.every((source) => /^[a-f0-9]{64}$/.test(source.contentHash)));

    const publicNotes = h.notes.join("\n");
    assert.ok(publicNotes.includes("submitted a draft"));
    for (const secret of ["OWNER-PRIVATE", "CODEX-PRIVATE", "DREW-PRIVATE"]) {
      assert.ok(!publicNotes.includes(secret), `public notes must not leak ${secret}`);
    }
    assert.ok(!publicNotes.includes("gera" + "]"), "public notes must not serialize audience lists");
  } finally {
    await h.cleanup();
  }
});

test("operation ids make collecting creation, save, and submit retries idempotent", async () => {
  const h = await harness();
  try {
    const request = {
      conversationId: CONVERSATION_ID,
      name: "Retryable collection",
      initialState: "collecting_drafts" as const,
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "collection:retry:create"
    };
    const first = expectOk(await h.service.create("gera", request));
    const second = expectOk(await h.service.create("gera", request));
    assert.equal(first.summary.id, second.summary.id);
    assert.equal(h.notes.length, 1, "create retry must not duplicate its public note");

    const saveRequest = {
      conversationId: CONVERSATION_ID,
      artifactId: first.summary.id,
      expectedEditRevision: 0,
      content: "stable bytes",
      readers: [] as string[],
      operationId: "collection:retry:draft:save"
    };
    const saved = expectOk(await h.service.saveDraft("gera", saveRequest));
    const savedRetry = expectOk(await h.service.saveDraft("gera", saveRequest));
    assert.equal(saved.id, savedRetry.id);
    expectError(await h.service.saveDraft("gera", { ...saveRequest, content: "different bytes" }), "invalid_request");

    const submitRequest = {
      conversationId: CONVERSATION_ID,
      artifactId: first.summary.id,
      draftId: saved.id,
      expectedEditRevision: saved.editRevision,
      operationId: "collection:retry:draft:submit"
    };
    const submitted = expectOk(await h.service.submitDraft("gera", submitRequest));
    const submittedRetry = expectOk(await h.service.submitDraft("gera", submitRequest));
    assert.equal(submitted.id, submittedRetry.id);
    assert.equal(h.notes.length, 2, "submit retry must post exactly one additional note");
    assert.equal((await h.store.listDrafts(first.summary.id)).length, 1);
  } finally {
    await h.cleanup();
  }
});

test("concurrent identical operations return the durable winning create, save, and replacement", async () => {
  const h = await harness();
  try {
    const other = attach(h.dbPath);
    const createRequest = {
      conversationId: CONVERSATION_ID,
      name: "Concurrent retry",
      initialState: "collecting_drafts" as const,
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [] as string[], requiredReaders: [] as string[] } },
      operationId: "concurrent-retry:create"
    };
    const [createdA, createdB] = await Promise.all([
      h.service.create("gera", createRequest),
      other.service.create("gera", createRequest)
    ]);
    const artifactA = expectOk(createdA);
    const artifactB = expectOk(createdB);
    assert.equal(artifactA.summary.id, artifactB.summary.id);

    const saveRequest = {
      conversationId: CONVERSATION_ID,
      artifactId: artifactA.summary.id,
      expectedEditRevision: 0,
      content: "durable draft",
      readers: [] as string[],
      operationId: "concurrent-retry:save"
    };
    const [savedA, savedB] = await Promise.all([
      h.service.saveDraft("gera", saveRequest),
      other.service.saveDraft("gera", saveRequest)
    ]);
    const draftA = expectOk(savedA);
    const draftB = expectOk(savedB);
    assert.equal(draftA.id, draftB.id);
    assert.equal((await h.store.listDrafts(artifactA.summary.id)).length, 1);

    const submitted = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: artifactA.summary.id,
      draftId: draftA.id,
      expectedEditRevision: draftA.editRevision,
      operationId: "concurrent-retry:submit"
    }));
    const replaceRequest = {
      conversationId: CONVERSATION_ID,
      artifactId: artifactA.summary.id,
      supersedesDraftId: submitted.id,
      content: "durable replacement",
      readers: [] as string[],
      operationId: "concurrent-retry:replace"
    };
    const [replacementA, replacementB] = await Promise.all([
      h.service.replaceDraft("gera", replaceRequest),
      other.service.replaceDraft("gera", replaceRequest)
    ]);
    assert.equal(expectOk(replacementA).id, expectOk(replacementB).id);
    assert.equal(
      (await h.store.listDrafts(artifactA.summary.id)).filter((draft) => draft.state === "editing").length,
      1
    );
  } finally {
    await h.cleanup();
  }
});

test("replacement and withdrawal preserve frozen provenance and readiness", async () => {
  const h = await harness();
  try {
    const collecting = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Replaceable",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "replace:create"
    }));
    const edit = expectOk(await h.service.saveDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      expectedEditRevision: 0,
      content: "original bytes",
      readers: [],
      operationId: "replace:save:original"
    }));
    const original = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: edit.id,
      expectedEditRevision: edit.editRevision,
      operationId: "replace:submit:original"
    }));
    expectError(await h.service.saveDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      expectedEditRevision: 0,
      content: "must use explicit replacement",
      readers: [],
      operationId: "replace:invalid-plain-save"
    }), "invalid_request");
    const replacementEdit = expectOk(await h.service.replaceDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      supersedesDraftId: original.id,
      content: "replacement bytes",
      readers: [],
      operationId: "replace:save:new"
    }));
    expectError(await h.service.withdrawDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: original.id,
      operationId: "replace:withdraw-original-while-editing"
    }), "invalid_request");
    const replacement = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: replacementEdit.id,
      expectedEditRevision: replacementEdit.editRevision,
      operationId: "replace:submit:new"
    }));
    const frozenOriginal = expectOk(await h.service.readDraft("user", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: original.id
    }));
    assert.equal(frozenOriginal.state, "superseded");
    assert.equal(frozenOriginal.content, "original bytes");
    assert.equal(replacement.supersedesDraftId, original.id);

    const withdrawRequest = {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: replacement.id,
      operationId: "replace:withdraw:new"
    };
    expectOk(await h.service.withdrawDraft("gera", withdrawRequest));
    const withdrawnRetry = expectOk(await h.service.withdrawDraft("gera", withdrawRequest));
    assert.equal(withdrawnRetry.state, "withdrawn");
    const afterWithdraw = expectOk(await h.service.read("user", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id
    }));
    assert.equal(afterWithdraw.lifecycle, "collecting_drafts");
    if (afterWithdraw.lifecycle === "collecting_drafts") {
      assert.equal(afterWithdraw.readyToPublish, false);
      assert.deepEqual(afterWithdraw.missingRequiredAuthors, ["gera"]);
    }
  } finally {
    await h.cleanup();
  }
});

test("roster updates use optimistic concurrency and migration init is rerun-safe", async () => {
  const h = await harness();
  try {
    const collecting = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Roster",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "roster:create"
    }));
    const updated = expectOk(await h.service.updateDraftRoster("user", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      allowedDraftAuthors: ["gera", "codex"],
      requiredDraftAuthors: ["gera", "codex"],
      audiencePolicyByAuthor: {
        gera: { allowedReaders: [], requiredReaders: [] },
        codex: { allowedReaders: ["gera"], requiredReaders: ["gera"] }
      },
      expectedDraftRosterRevision: 0,
      operationId: "roster:update:1"
    }));
    assert.equal(updated.summary.draftRosterRevision, 1);
    const stale = expectError(await h.service.updateDraftRoster("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      expectedDraftRosterRevision: 0,
      operationId: "roster:update:stale"
    }), "stale_version");
    assert.equal(stale.currentRosterRevision, 1);

    await h.store.init();
    await new ArtifactStore(h.dbPath).init();
    const restarted = attach(h.dbPath);
    const read = expectOk(await restarted.service.read("user", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id
    }));
    assert.equal(read.lifecycle, "collecting_drafts");
    assert.equal(read.summary.draftRosterRevision, 1);
  } finally {
    await h.cleanup();
  }
});

test("migration initialization tolerates concurrent app processes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "artifact-service-init-race-"));
  const dbPath = path.join(dir, "artifacts.sqlite3");
  try {
    await runCommand("sqlite3", [dbPath], {
      input: `
        create table artifacts (
          id text primary key, conversation_id text not null, name text not null,
          name_key text not null, owner text not null, contributors_json text not null,
          required_signers_json text not null, labels_json text not null,
          head_version integer not null, created_at text not null, updated_at text not null
        );
      `,
      primeLoginShellEnv: false
    });
    const script = `
      const { ArtifactStore } = require("./dist/main/main/services/artifactStore.js");
      new ArtifactStore(process.argv[1]).init().catch((error) => { console.error(error); process.exit(1); });
    `;
    await Promise.all([
      runCommand("node", ["-e", script, dbPath], { primeLoginShellEnv: false }),
      runCommand("node", ["-e", script, dbPath], { primeLoginShellEnv: false })
    ]);
    const columns = await runCommand("sqlite3", ["-json", dbPath, "pragma table_info(artifacts);"], {
      primeLoginShellEnv: false
    });
    const names = (JSON.parse(columns.stdout) as Array<{ name: string }>).map((column) => column.name);
    assert.equal(names.filter((name) => name === "lifecycle").length, 1);
    await Promise.all([new ArtifactStore(dbPath).init(), new ArtifactStore(dbPath).init()]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collecting create race returns one winner and a retryable name_taken loser", async () => {
  const h = await harness();
  try {
    const other = attach(h.dbPath);
    const base = {
      conversationId: CONVERSATION_ID,
      name: "Concurrent collection",
      initialState: "collecting_drafts" as const,
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [] as string[], requiredReaders: [] as string[] } }
    };
    const [first, second] = await Promise.all([
      h.service.create("gera", { ...base, operationId: "race:create:gera" }),
      other.service.create("codex", {
        ...base,
        allowedDraftAuthors: ["codex"],
        requiredDraftAuthors: ["codex"],
        audiencePolicyByAuthor: { codex: { allowedReaders: [], requiredReaders: [] } },
        operationId: "race:create:codex"
      })
    ]);
    assert.equal([first, second].filter((result) => result.ok).length, 1);
    const loser = first.ok ? second : first;
    assert.equal(loser.ok, false);
    if (!loser.ok) assert.equal(loser.error.code, "name_taken");
    const loserRetry = first.ok
      ? await other.service.create("codex", {
          ...base,
          allowedDraftAuthors: ["codex"],
          requiredDraftAuthors: ["codex"],
          audiencePolicyByAuthor: { codex: { allowedReaders: [], requiredReaders: [] } },
          operationId: "race:create:codex"
        })
      : await h.service.create("gera", { ...base, operationId: "race:create:gera" });
    expectError(loserRetry, "name_taken");
  } finally {
    await h.cleanup();
  }
});

test("store guards reject stale-roster and post-publication draft writes", async () => {
  const h = await harness();
  try {
    const collecting = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Guarded collection",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "guard:create"
    }));
    const updated = expectOk(await h.service.updateDraftRoster("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      expectedDraftRosterRevision: 0,
      operationId: "guard:roster"
    }));
    const staleDraft = draftRecord("guard-stale", collecting.summary.id, "stale roster");
    assert.equal(await h.store.saveDraft(staleDraft, 0, 0, operationRecord("guard:save:stale", staleDraft)), false);
    assert.equal(await h.store.getOperation(CONVERSATION_ID, "gera", "save_draft", "guard:save:stale"), undefined);

    const editing = expectOk(await h.service.saveDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      expectedEditRevision: 0,
      content: "current",
      readers: [],
      operationId: "guard:save:current"
    }));
    const submitted = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: editing.id,
      expectedEditRevision: editing.editRevision,
      operationId: "guard:submit"
    }));
    assert.equal((await h.store.getById(collecting.summary.id))?.updatedAt, submitted.updatedAt);
    expectOk(await h.service.publish("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      content: "v1",
      requiredSigners: [],
      sources: [{ draftId: submitted.id, disposition: "considered" }],
      operationId: "guard:publish"
    }));
    const lateDraft = draftRecord("guard-late", collecting.summary.id, "too late");
    assert.equal(
      await h.store.saveDraft(lateDraft, 0, updated.summary.draftRosterRevision, operationRecord("guard:save:late", lateDraft)),
      false
    );
    assert.equal(await h.store.getDraft(lateDraft.id), undefined);
  } finally {
    await h.cleanup();
  }
});

test("guard failures discard unapplied operations so corrected retries can reuse stable ids", async () => {
  const h = await harness();
  try {
    const collecting = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Guard retry collection",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "guard-retry:create"
    }));
    const artifactId = collecting.summary.id;
    const editing = draftRecord("guard-retry-editing", artifactId, "draft content");
    const failedSave = operationRecord("guard-retry:save", editing, "save_draft", "save:stale");
    assert.equal(await h.store.saveDraft(editing, 0, 1, failedSave), false);
    assert.equal(await h.store.getOperation(CONVERSATION_ID, "gera", "save_draft", failedSave.operationId), undefined);
    const correctedSave = operationRecord(failedSave.operationId, editing, "save_draft", "save:corrected");
    assert.equal(await h.store.saveDraft(editing, 0, 0, correctedSave), true);

    const submittedAt = "2026-07-13T13:01:00.000Z";
    const submitted = { ...editing, state: "submitted" as const, updatedAt: submittedAt, submittedAt };
    const failedSubmit = operationRecord("guard-retry:submit", submitted, "submit_draft", "submit:stale");
    assert.equal(await h.store.submitDraft(
      submitted,
      0,
      0,
      failedSubmit,
      eventRecord("guard-retry:event:submit:stale", artifactId, "submitted", submittedAt)
    ), false);
    assert.equal(await h.store.getOperation(CONVERSATION_ID, "gera", "submit_draft", failedSubmit.operationId), undefined);
    const correctedSubmit = operationRecord(failedSubmit.operationId, submitted, "submit_draft", "submit:corrected");
    assert.equal(await h.store.submitDraft(
      submitted,
      1,
      0,
      correctedSubmit,
      eventRecord("guard-retry:event:submit", artifactId, "submitted", submittedAt)
    ), true);

    const withdrawnAt = "2026-07-13T13:02:00.000Z";
    const withdrawn = { ...submitted, state: "withdrawn" as const, updatedAt: withdrawnAt };
    const failedWithdraw = operationRecord("guard-retry:withdraw", withdrawn, "withdraw_draft", "withdraw:stale");
    assert.equal(await h.store.withdrawDraft(
      withdrawn,
      1,
      failedWithdraw,
      eventRecord("guard-retry:event:withdraw:stale", artifactId, "withdrawn", withdrawnAt)
    ), false);
    assert.equal(await h.store.getOperation(CONVERSATION_ID, "gera", "withdraw_draft", failedWithdraw.operationId), undefined);
    const correctedWithdraw = operationRecord(failedWithdraw.operationId, withdrawn, "withdraw_draft", "withdraw:corrected");
    assert.equal(await h.store.withdrawDraft(
      withdrawn,
      0,
      correctedWithdraw,
      eventRecord("guard-retry:event:withdraw", artifactId, "withdrawn", withdrawnAt)
    ), true);

    const roster = {
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [] as string[], requiredReaders: [] as string[] } }
    };
    const failedRoster = operationForArtifact("guard-retry:roster", artifactId, "update_draft_roster", "roster:stale");
    assert.equal(await h.store.updateDraftRoster(artifactId, 1, roster, withdrawnAt, failedRoster), false);
    assert.equal(await h.store.getOperation(CONVERSATION_ID, "gera", "update_draft_roster", failedRoster.operationId), undefined);
    const correctedRoster = operationForArtifact(failedRoster.operationId, artifactId, "update_draft_roster", "roster:corrected");
    assert.equal(await h.store.updateDraftRoster(artifactId, 0, roster, withdrawnAt, correctedRoster), true);

    const base = expectOk(await h.service.saveDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId,
      expectedEditRevision: 0,
      content: "replacement base",
      readers: [],
      operationId: "guard-retry:base-save"
    }));
    const frozenBase = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId,
      draftId: base.id,
      expectedEditRevision: base.editRevision,
      operationId: "guard-retry:base-submit"
    }));
    const replacement = {
      ...draftRecord("guard-retry-replacement", artifactId, "replacement"),
      supersedesDraftId: frozenBase.id
    };
    const failedReplacement = operationRecord(
      "guard-retry:replacement",
      replacement,
      "save_draft",
      "replacement:stale"
    );
    assert.equal(await h.store.saveDraft(replacement, 0, 0, failedReplacement), false);
    assert.equal(await h.store.getOperation(CONVERSATION_ID, "gera", "save_draft", failedReplacement.operationId), undefined);
    const correctedReplacement = operationRecord(
      failedReplacement.operationId,
      replacement,
      "save_draft",
      "replacement:corrected"
    );
    assert.equal(await h.store.saveDraft(replacement, 0, 1, correctedReplacement), true);
    assert.equal((await h.store.getOperation(
      CONVERSATION_ID,
      "gera",
      "save_draft",
      correctedReplacement.operationId
    ))?.applied, true);
  } finally {
    await h.cleanup();
  }
});

test("legacy published artifacts migrate without changing v1 read or signing behavior", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "artifact-service-legacy-"));
  const dbPath = path.join(dir, "legacy.sqlite3");
  try {
    await runCommand("sqlite3", [dbPath], {
      input: `
        create table artifacts (
          id text primary key, conversation_id text not null, name text not null,
          name_key text not null, owner text not null, contributors_json text not null,
          required_signers_json text not null, labels_json text not null,
          head_version integer not null, created_at text not null, updated_at text not null
        );
        create table artifact_versions (
          artifact_id text not null, version integer not null, content text not null,
          author text not null, note text, created_at text not null,
          primary key (artifact_id, version)
        );
        create table artifact_signatures (
          artifact_id text not null, version integer not null, signer text not null,
          signed_at text not null, primary key (artifact_id, version, signer)
        );
        insert into artifacts values (
          'legacy-id', '${CONVERSATION_ID}', 'Legacy plan', 'legacy plan', 'gera',
          '["codex"]', '["user"]', '["legacy"]', 1, '${NOW_FOR_LEGACY}', '${NOW_FOR_LEGACY}'
        );
        insert into artifact_versions values (
          'legacy-id', 1, 'legacy body', 'gera', null, '${NOW_FOR_LEGACY}'
        );
      `,
      primeLoginShellEnv: false
    });
    const migrated = attach(dbPath);
    const read = expectPublished(expectOk(await migrated.service.read("user", {
      conversationId: CONVERSATION_ID,
      artifactId: "legacy-id"
    })));
    assert.equal(read.summary.lifecycle, "published");
    assert.equal(read.summary.headVersion, 1);
    assert.equal(read.version.content, "legacy body");
    const signed = expectOk(await migrated.service.sign("user", {
      conversationId: CONVERSATION_ID,
      artifactId: "legacy-id"
    }));
    assert.equal(signed.approval.state, "approved");
    await new ArtifactStore(dbPath).init();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outbox retries after response loss without duplicating the visible note", async () => {
  const h = await harness();
  const visibleEventIds = new Set<string>();
  let loseFirstResponse = true;
  try {
    const flaky = new ArtifactService({
      store: h.store,
      getMembers: async (conversationId) => (conversationId === CONVERSATION_ID ? [...MEMBERS] : undefined),
      postNote: async (_conversationId, eventId) => {
        visibleEventIds.add(eventId);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error("response lost after chat commit");
        }
      }
    });
    const created = expectOk(await flaky.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Outbox",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "outbox:create"
    }));
    assert.equal(created.lifecycle, "collecting_drafts");
    assert.equal((await h.store.listPendingEvents()).length, 1, "lost response leaves the event pending");

    const restarted = new ArtifactService({
      store: new ArtifactStore(h.dbPath),
      getMembers: async (conversationId) => (conversationId === CONVERSATION_ID ? [...MEMBERS] : undefined),
      postNote: async (_conversationId, eventId) => {
        visibleEventIds.add(eventId);
      }
    });
    await restarted.flushPendingArtifactEvents();
    await restarted.flushPendingArtifactEvents();
    assert.equal(visibleEventIds.size, 1, "replay uses the same event id so chat dedup keeps one visible note");
    assert.equal((await h.store.listPendingEvents()).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("outbox drains more than one page without an early failure starving later notes", async () => {
  const h = await harness();
  try {
    await h.store.init();
    const rows = Array.from({ length: 205 }, (_, index) => {
      const id = `event-${String(index).padStart(3, "0")}`;
      return `('${id}', '${CONVERSATION_ID}', 'artifact', 'test', 'gera', 'note ${index}', '2026-07-13T14:00:00.000Z', null)`;
    }).join(",\n");
    await runCommand("sqlite3", [h.dbPath], {
      input: `insert into artifact_event_outbox (id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at) values ${rows};`,
      primeLoginShellEnv: false
    });
    const attempted = new Set<string>();
    const flaky = new ArtifactService({
      store: h.store,
      getMembers: async () => [...MEMBERS],
      postNote: async (_conversationId, eventId) => {
        attempted.add(eventId);
        if (eventId === "event-000") throw new Error("first event unavailable");
      }
    });
    await flaky.flushPendingArtifactEvents();
    assert.equal(attempted.size, 205);
    assert.deepEqual((await h.store.listPendingEvents()).map((event) => event.id), ["event-000"]);

    const retry = new ArtifactService({
      store: new ArtifactStore(h.dbPath),
      getMembers: async () => [...MEMBERS],
      postNote: async () => undefined
    });
    await retry.flushPendingArtifactEvents();
    assert.deepEqual(await h.store.listPendingEvents(), []);
  } finally {
    await h.cleanup();
  }
});

test("publication rejects a source replaced after readiness was snapshotted", async () => {
  const h = await harness();
  try {
    const collecting = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Source race",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "source-race:create"
    }));
    const editing = expectOk(await h.service.saveDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      expectedEditRevision: 0,
      content: "original source",
      readers: [],
      operationId: "source-race:save"
    }));
    const original = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: editing.id,
      expectedEditRevision: editing.editRevision,
      operationId: "source-race:submit"
    }));
    const other = attach(h.dbPath);
    const publishFirstVersion = h.store.publishFirstVersion.bind(h.store);
    let replacementId = "";
    h.store.publishFirstVersion = async (...args) => {
      if (!replacementId) {
        const replacement = expectOk(await other.service.replaceDraft("gera", {
          conversationId: CONVERSATION_ID,
          artifactId: collecting.summary.id,
          supersedesDraftId: original.id,
          content: "replacement source",
          readers: [],
          operationId: "source-race:replace"
        }));
        const submitted = expectOk(await other.service.submitDraft("gera", {
          conversationId: CONVERSATION_ID,
          artifactId: collecting.summary.id,
          draftId: replacement.id,
          expectedEditRevision: replacement.editRevision,
          operationId: "source-race:submit-replacement"
        }));
        replacementId = submitted.id;
      }
      return publishFirstVersion(...args);
    };
    expectError(await h.service.publish("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      content: "must not bind stale source",
      requiredSigners: [],
      sources: [{ draftId: original.id, disposition: "considered" }],
      operationId: "source-race:publish"
    }), "invalid_request");
    assert.equal((await h.store.getById(collecting.summary.id))?.lifecycle, "collecting_drafts");
    assert.equal((await h.store.getDraft(replacementId))?.state, "submitted");
    assert.equal(await h.store.getVersion(collecting.summary.id, 1), undefined);
    assert.equal(await h.store.getOperation(
      CONVERSATION_ID,
      "gera",
      "publish_v1",
      "source-race:publish"
    ), undefined, "failed publication must not poison the stable operation id");

    const published = expectOk(await h.service.publish("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      content: "published from replacement",
      requiredSigners: [],
      sources: [{ draftId: replacementId, disposition: "considered" }],
      operationId: "source-race:publish"
    }));
    assert.equal(published.summary.lifecycle, "published");
    assert.equal(published.summary.headVersion, 1);
    assert.deepEqual((await h.store.listVersionSources(collecting.summary.id, 1)).map((source) => source.draftId), [replacementId]);
    assert.equal((await h.store.listVersionMetas(collecting.summary.id)).length, 1);
    assert.equal(h.notes.filter((note) => note.includes(" published ") && note.includes("Source race")).length, 1);
  } finally {
    await h.cleanup();
  }
});

test("publication accepts current considered sources regardless of earlier source ordering", async () => {
  const h = await harness();
  try {
    const collecting = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Ordered sources",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "ordered:create"
    }));
    const firstEdit = expectOk(await h.service.saveDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      expectedEditRevision: 0,
      content: "first",
      readers: [],
      operationId: "ordered:save:first"
    }));
    const first = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: firstEdit.id,
      expectedEditRevision: firstEdit.editRevision,
      operationId: "ordered:submit:first"
    }));
    const secondEdit = expectOk(await h.service.replaceDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      supersedesDraftId: first.id,
      content: "second",
      readers: [],
      operationId: "ordered:save:second"
    }));
    const second = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: secondEdit.id,
      expectedEditRevision: secondEdit.editRevision,
      operationId: "ordered:submit:second"
    }));
    const published = expectOk(await h.service.publish("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      content: "v1",
      requiredSigners: [],
      sources: [
        { draftId: first.id, disposition: "considered" },
        { draftId: second.id, disposition: "considered" }
      ],
      operationId: "ordered:publish"
    }));
    assert.equal(published.lifecycle, "published");
    assert.deepEqual(published.sources?.map((source) => source.draftId), [first.id, second.id]);
  } finally {
    await h.cleanup();
  }
});

test("publication revalidates the current draft roster and audiences against chat membership", async () => {
  const h = await harness();
  try {
    let members = [...MEMBERS];
    const dynamic = attach(h.dbPath, async (conversationId) => (
      conversationId === CONVERSATION_ID ? [...members] : undefined
    ));
    const collecting = expectOk(await dynamic.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Membership recheck",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: ["codex"], requiredReaders: ["codex"] } },
      operationId: "membership:create"
    }));
    const edit = expectOk(await dynamic.service.saveDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      expectedEditRevision: 0,
      content: "body",
      readers: ["codex"],
      operationId: "membership:save"
    }));
    const submitted = expectOk(await dynamic.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: edit.id,
      expectedEditRevision: edit.editRevision,
      operationId: "membership:submit"
    }));
    members = members.filter((member) => member !== "codex");
    expectError(await dynamic.service.publish("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      content: "v1",
      requiredSigners: [],
      sources: [{ draftId: submitted.id, disposition: "considered" }],
      operationId: "membership:publish"
    }), "invalid_request");
    assert.equal((await h.store.getById(collecting.summary.id))?.lifecycle, "collecting_drafts");
  } finally {
    await h.cleanup();
  }
});

test("selected readers can inspect editing drafts while unselected members cannot discover them", async () => {
  const h = await harness();
  try {
    const collecting = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Editing audience",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: ["codex"], requiredReaders: [] } },
      operationId: "editing-audience:create"
    }));
    const editing = expectOk(await h.service.saveDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      expectedEditRevision: 0,
      content: "work in progress",
      readers: ["codex"],
      operationId: "editing-audience:save"
    }));
    assert.equal(expectOk(await h.service.readDraft("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: editing.id
    })).content, "work in progress");
    expectError(await h.service.readDraft("drew", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: editing.id
    }), "not_found");
    assert.equal(expectOk(await h.service.listDrafts("drew", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id
    })).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("delayed operation retries return immutable original responses after state advances", async () => {
  const h = await harness();
  try {
    const collecting = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Durable replay",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "replay:create"
    }));
    const saveRequest = {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      expectedEditRevision: 0,
      content: "original",
      readers: [] as string[],
      operationId: "replay:save"
    };
    const editing = expectOk(await h.service.saveDraft("gera", saveRequest));
    const submitRequest = {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: editing.id,
      expectedEditRevision: editing.editRevision,
      operationId: "replay:submit"
    };
    const original = expectOk(await h.service.submitDraft("gera", submitRequest));
    const replaceRequest = {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      supersedesDraftId: original.id,
      content: "replacement",
      readers: [] as string[],
      operationId: "replay:replace"
    };
    const replacementEditing = expectOk(await h.service.replaceDraft("gera", replaceRequest));
    const replacement = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: replacementEditing.id,
      expectedEditRevision: replacementEditing.editRevision,
      operationId: "replay:submit-replacement"
    }));
    const rosterRequest = {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [] as string[], requiredReaders: [] as string[] } },
      expectedDraftRosterRevision: 0,
      operationId: "replay:roster"
    };
    const rosterResponse = expectOk(await h.service.updateDraftRoster("gera", rosterRequest));
    const publishRequest = {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      content: "published v1",
      requiredSigners: [] as string[],
      sources: [{ draftId: replacement.id, disposition: "considered" as const }],
      operationId: "replay:publish"
    };
    expectOk(await h.service.publish("gera", publishRequest));

    assert.equal(expectOk(await h.service.saveDraft("gera", saveRequest)).state, "editing");
    assert.equal(expectOk(await h.service.submitDraft("gera", submitRequest)).state, "submitted");
    assert.equal(expectOk(await h.service.replaceDraft("gera", replaceRequest)).state, "editing");
    assert.equal(expectOk(await h.service.updateDraftRoster("gera", rosterRequest)).summary.draftRosterRevision, rosterResponse.summary.draftRosterRevision);

    expectOk(await h.service.revise("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      baseVersion: 1,
      content: "published v2"
    }));
    const publishReplay = expectOk(await h.service.publish("gera", publishRequest));
    assert.equal(publishReplay.version.version, 1);
    assert.equal(publishReplay.summary.headVersion, 1);
    assert.equal(publishReplay.version.content, "published v1");
  } finally {
    await h.cleanup();
  }
});

test("create variants reject mixed lifecycle fields instead of silently dropping them", async () => {
  const h = await harness();
  try {
    expectError(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Mixed collecting",
      initialState: "collecting_drafts",
      content: "must reject",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "mixed:collecting"
    } as never), "invalid_request");
    expectError(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Mixed published",
      content: "v1",
      allowedDraftAuthors: ["gera"]
    } as never), "invalid_request");
    assert.deepEqual(await h.store.listByConversation(CONVERSATION_ID), []);
  } finally {
    await h.cleanup();
  }
});

test("conversation deletion installs a durable barrier against in-flight and later creates", async () => {
  const h = await harness();
  try {
    const other = attach(h.dbPath);
    const originalInsert = h.store.insertCollectingArtifact.bind(h.store);
    const entered = deferred<void>();
    const release = deferred<void>();
    h.store.insertCollectingArtifact = async (...args) => {
      entered.resolve(undefined);
      await release.promise;
      return originalInsert(...args);
    };
    const inFlight = h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Deleted while creating",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "delete-race:create"
    });
    await entered.promise;
    await other.service.deleteConversationArtifacts(CONVERSATION_ID);
    release.resolve(undefined);
    expectError(await inFlight, "invalid_request");
    expectError(await other.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Later ordinary",
      content: "must not survive"
    }), "invalid_request");
    assert.deepEqual(await h.store.listByConversation(CONVERSATION_ID), []);
    assert.deepEqual(await h.store.listPendingEvents(), []);
  } finally {
    await h.cleanup();
  }
});

test("conversation deletion cascades draft, provenance, operation, and outbox rows", async () => {
  const h = await harness();
  try {
    const collecting = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Disposable",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "delete:create"
    }));
    const editing = expectOk(await h.service.saveDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      expectedEditRevision: 0,
      content: "draft content",
      readers: [],
      operationId: "delete:save"
    }));
    const submitted = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      draftId: editing.id,
      expectedEditRevision: editing.editRevision,
      operationId: "delete:submit"
    }));
    expectOk(await h.service.publish("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      content: "published content",
      requiredSigners: ["gera"],
      sources: [{ draftId: submitted.id, disposition: "considered" }],
      operationId: "delete:publish"
    }));

    await h.store.deleteByConversation(CONVERSATION_ID);
    assert.equal(await h.store.getById(collecting.summary.id), undefined);
    assert.deepEqual(await h.store.listDrafts(collecting.summary.id), []);
    assert.deepEqual(await h.store.listVersionSources(collecting.summary.id, 1), []);
    assert.equal(await h.store.getOperation(CONVERSATION_ID, "gera", "create_collecting", "delete:create"), undefined);
    assert.deepEqual(await h.store.listPendingEvents(), []);
  } finally {
    await h.cleanup();
  }
});

function draftRecord(id: string, artifactId: string, content: string): ArtifactDraftRecord {
  const now = "2026-07-13T13:00:00.000Z";
  return {
    id,
    artifactId,
    author: "gera",
    state: "editing",
    content,
    readers: [],
    editRevision: 1,
    createdAt: now,
    updatedAt: now
  };
}

function operationRecord(
  operationId: string,
  draft: ArtifactDraftRecord,
  operationKind = "save_draft",
  requestHash = operationId
): ArtifactOperationRecord {
  return {
    conversationId: CONVERSATION_ID,
    artifactId: draft.artifactId,
    actor: draft.author,
    operationKind,
    operationId,
    requestHash,
    resultJson: JSON.stringify({ artifactId: draft.artifactId, draftId: draft.id }),
    createdAt: draft.createdAt
  };
}

function operationForArtifact(
  operationId: string,
  artifactId: string,
  operationKind: string,
  requestHash: string
): ArtifactOperationRecord {
  return {
    conversationId: CONVERSATION_ID,
    artifactId,
    actor: "gera",
    operationKind,
    operationId,
    requestHash,
    resultJson: JSON.stringify({ artifactId }),
    createdAt: "2026-07-13T13:00:00.000Z"
  };
}

function eventRecord(
  id: string,
  artifactId: string,
  kind: string,
  createdAt: string
): import("./artifactStore").ArtifactEventRecord {
  return {
    id,
    conversationId: CONVERSATION_ID,
    artifactId,
    kind,
    actor: "gera",
    content: `${kind} note`,
    createdAt
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}
