import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactService } from "./artifacts";
import { ArtifactStore } from "./artifactStore";
import { parseMarkdownInline } from "../../shared/markdownInline";
import { unifiedLineDiff } from "../../shared/artifactDiff";
import type { ArtifactError, ArtifactResult } from "../../shared/types";

const CONVERSATION_ID = "chat-1";
const MEMBERS = ["user", "gera", "codex", "drew"];

interface Harness {
  dbPath: string;
  store: ArtifactStore;
  service: ArtifactService;
  notes: string[];
  changed: string[];
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-artifacts-"));
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
function attach(dbPath: string): { store: ArtifactStore; service: ArtifactService; notes: string[]; changed: string[] } {
  const store = new ArtifactStore(dbPath);
  const notes: string[] = [];
  const changed: string[] = [];
  const service = new ArtifactService({
    store,
    getMembers: async (conversationId) => (conversationId === CONVERSATION_ID ? [...MEMBERS] : undefined),
    postNote: async (_conversationId, content) => {
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

test("create + read: every member reads the current version; non-members are rejected; list stays lean", async () => {
  const h = await harness();
  try {
    const created = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Release Plan",
      content: "Step 1: ship it.",
      contributors: ["codex"],
      requiredSigners: ["user", "drew"],
      labels: ["plan"]
    }));
    assert.equal(created.summary.name, "Release Plan");
    assert.equal(created.summary.owner, "gera");
    assert.deepEqual(created.summary.contributors, ["codex"]);
    assert.equal(created.summary.headVersion, 1);
    assert.equal(created.version.content, "Step 1: ship it.");
    assert.equal(created.summary.approval.state, "unsigned");

    // Any member can read, by name or id, with "@" and case tolerated for actors.
    const readByUser = expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, name: "release plan" }));
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
    const created = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "QA Cases",
      content: "case A\ncase B",
      contributors: ["codex"]
    }));
    const revised = expectOk(await h.service.revise("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      baseVersion: 1,
      content: "case A\ncase B\ncase C",
      note: "added case C"
    }));
    assert.equal(revised.summary.headVersion, 2);
    assert.equal(revised.version.version, 2);

    const v1 = expectOk(await h.service.read("drew", { conversationId: CONVERSATION_ID, artifactId: created.summary.id, version: 1 }));
    assert.equal(v1.version.content, "case A\ncase B");

    const withHistory = expectOk(await h.service.read("user", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      includeHistory: true
    }));
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
    const created = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Decision",
      content: "v1 text",
      contributors: ["codex", "drew"]
    }));
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
    const winnerContent = okResults[0].ok ? okResults[0].value.version.content : "";
    assert.equal(stale.error.current?.content, winnerContent, "loser must be given the current version to redo its edit");

    // No lost update: head is exactly v2 with the winner's content, and v1 is intact.
    const head = expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: created.summary.id }));
    assert.equal(head.summary.headVersion, 2);
    assert.equal(head.version.content, winnerContent);
    const v1 = expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: created.summary.id, version: 1 }));
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
    const created = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Cross Process",
      content: "base"
    }));
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
    const revised = expectOk(await h.service.revise("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: id,
      baseVersion: 1,
      content: "spec v2"
    }));
    assert.equal(revised.summary.approval.state, "unsigned");
    assert.equal(revised.version.signatures.length, 0);
    const v1 = expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: id, version: 1 }));
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
    const created = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Plan A",
      content: "original plan",
      requiredSigners: ["user"]
    }));
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
    const original = expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: id }));
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
    const after = expectOk(await h.service.read("user", { conversationId: CONVERSATION_ID, artifactId: id, includeHistory: true }));
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
    const detail = expectOk(await restarted.service.read("user", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      includeHistory: true
    }));
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
