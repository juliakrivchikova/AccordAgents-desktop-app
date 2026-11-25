import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactStore } from "./artifactStore";
import { runCommand } from "./command";
import {
  attach, CONVERSATION_ID, expectError, expectOk, expectPublished, harness, SQLITE_EXECUTABLE
} from "./artifacts/test/artifactFixtures";

test("a maximum-size artifact is written over stdin and signatures never embed its body", async () => {
  const h = await harness();
  try {
    const content = "'".repeat(512 * 1024);
    const created = expectPublished(expectOk(await h.service.create("gera", { conversationId: CONVERSATION_ID,
      name: "Maximum payload", content, requiredSigners: ["user"] })));
    assert.equal(created.version.content, content);
    expectOk(await h.service.sign("user", { conversationId: CONVERSATION_ID, artifactId: created.summary.id,
      versionEventId: created.version.versionEventId, contentHash: created.version.contentHash }));
    const signatures = await h.store.listSignatures(created.summary.id);
    assert.ok(Buffer.byteLength(JSON.stringify(signatures)) < 1024);
    const reread = await attach(h.dbPath).store.getVersion(created.summary.id, 1);
    assert.equal(reread?.contentHash, created.version.contentHash);
    assert.equal(reread?.content, content);
  } finally { await h.cleanup(); }
});

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

test("human user can always revise and manage artifact access", async () => {
  const h = await harness();
  try {
    const created = expectOk(await h.service.create("codex", {
      conversationId: CONVERSATION_ID,
      name: "Agent Owned",
      content: "v1"
    }));
    const id = created.summary.id;

    const userRevision = expectOk(await h.service.revise("user", {
      conversationId: CONVERSATION_ID,
      artifactId: id,
      baseVersion: 1,
      content: "v2 by user"
    }));
    assert.equal(userRevision.summary.headVersion, 2);

    const updated = expectOk(await h.service.updateAccess("user", {
      conversationId: CONVERSATION_ID,
      artifactId: id,
      contributors: ["drew"],
      requiredSigners: ["user"]
    }));
    assert.equal(updated.owner, "codex");
    assert.deepEqual(updated.contributors, ["drew"]);
    assert.deepEqual(updated.approval.requiredSigners, ["user"]);

    const drewRevision = expectOk(await h.service.revise("drew", {
      conversationId: CONVERSATION_ID,
      artifactId: id,
      baseVersion: 2,
      content: "v3 by drew"
    }));
    assert.equal(drewRevision.summary.headVersion, 3);
  } finally {
    await h.cleanup();
  }
});

test("artifact archive is a reversible soft state that preserves contents and history", async () => {
  const h = await harness();
  try {
    const created = expectPublished(expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Old Plan",
      content: "v1",
      contributors: ["codex"],
      requiredSigners: ["user"]
    })));
    const id = created.summary.id;
    expectOk(await h.service.sign("user", { conversationId: CONVERSATION_ID, artifactId: id }));

    expectError(await h.service.setArchived("drew", { conversationId: CONVERSATION_ID, artifactId: id, archived: true }), "access_denied");

    const archived = expectOk(await h.service.setArchived("user", { conversationId: CONVERSATION_ID, artifactId: id, archived: true }));
    assert.equal(typeof archived.archivedAt, "string");
    assert.equal(archived.approval.state, "approved", "archive must not touch signatures");

    const listed = expectOk(await h.service.list("codex", CONVERSATION_ID));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].archivedAt, archived.archivedAt);

    const read = expectPublished(expectOk(await h.service.read("codex", { conversationId: CONVERSATION_ID, artifactId: id, includeHistory: true })));
    assert.equal(read.version.content, "v1");
    assert.equal(read.summary.archivedAt, archived.archivedAt);
    assert.equal(read.history?.length, 1);

    assert.match(expectError(await h.service.rename("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: id,
      newName: "Edited Old Plan"
    }), "invalid_request").message, /Restore "Old Plan" before renaming it/);
    assert.match(expectError(await h.service.revise("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: id,
      baseVersion: 1,
      content: "v2 while archived"
    }), "invalid_request").message, /Restore "Old Plan" before revising it/);
    assert.match(expectError(await h.service.sign("user", {
      conversationId: CONVERSATION_ID,
      artifactId: id
    }), "invalid_request").message, /Restore "Old Plan" before signing it/);
    assert.match(expectError(await h.service.updateAccess("user", {
      conversationId: CONVERSATION_ID,
      artifactId: id,
      contributors: ["codex", "drew"]
    }), "invalid_request").message, /Restore "Old Plan" before changing access/);

    const restored = expectOk(await h.service.setArchived("gera", { conversationId: CONVERSATION_ID, artifactId: id, archived: false }));
    assert.equal(restored.archivedAt, undefined);
    assert.equal(expectPublished(expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: id }))).summary.archivedAt, undefined);
    const revisedAfterRestore = expectPublished(expectOk(await h.service.revise("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: id,
      baseVersion: 1,
      content: "v2 after restore"
    })));
    assert.equal(revisedAfterRestore.summary.headVersion, 2);
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

test("migration initialization tolerates concurrent app processes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "artifact-service-init-race-"));
  const dbPath = path.join(dir, "artifacts.sqlite3");
  try {
    await runCommand(SQLITE_EXECUTABLE, [dbPath], {
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
      const keepAlive = setInterval(() => undefined, 1_000);
      new ArtifactStore(process.argv[1], process.argv[2]).init()
        .then(() => clearInterval(keepAlive))
        .catch((error) => { clearInterval(keepAlive); console.error(error); process.exitCode = 1; });
    `;
    await Promise.all([
      runCommand(process.execPath, ["-e", script, dbPath, SQLITE_EXECUTABLE], { primeLoginShellEnv: false }),
      runCommand(process.execPath, ["-e", script, dbPath, SQLITE_EXECUTABLE], { primeLoginShellEnv: false })
    ]);
    const columns = await runCommand(SQLITE_EXECUTABLE, ["-json", dbPath, "pragma table_info(artifacts);"], {
      primeLoginShellEnv: false
    });
    const names = (JSON.parse(columns.stdout) as Array<{ name: string }>).map((column) => column.name);
    assert.equal(names.filter((name) => name === "lifecycle").length, 1);
    await Promise.all([
      new ArtifactStore(dbPath, SQLITE_EXECUTABLE).init(),
      new ArtifactStore(dbPath, SQLITE_EXECUTABLE).init()
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}
