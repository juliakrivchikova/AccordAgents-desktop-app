import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactService } from "./artifacts";
import { ArtifactStore } from "./artifactStore";
import { runCommand } from "./command";
import { parseMarkdownInline } from "../../shared/markdownInline";
import { unifiedLineDiff } from "../../shared/artifactDiff";
import { artifactNoteActorLabel, artifactNoteVerb, parseArtifactNoteCard } from "../../shared/artifactNoteCard";
import type { PublishedArtifactReadResult } from "../../shared/types";
import { CONVERSATION_ID, expectOk, expectPublished, harness, MEMBERS, SQLITE_EXECUTABLE } from "./artifacts/test/artifactFixtures";

test("rename and its outbox note commit or roll back together", async () => {
  const h = await harness();
  try {
    const created = expectPublished(expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Atomic rename",
      content: "body"
    })));
    await runCommand(SQLITE_EXECUTABLE, [h.dbPath], {
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

test("every chat note the service writes reads as a timeline card", async () => {
  const h = await harness();
  try {
    const created = expectPublished(expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Memory plan",
      content: "v1",
      requiredSigners: ["user", "drew"]
    })));
    const id = created.summary.id;
    expectOk(await h.service.revise("gera", { conversationId: CONVERSATION_ID, artifactId: id, baseVersion: 1, content: "v2",
      note: "Choice rule: project knowledge — repo, private — memory" }));
    expectOk(await h.service.revise("user", { conversationId: CONVERSATION_ID, artifactId: id, baseVersion: 2, content: "v3" }));
    expectOk(await h.service.sign("user", { conversationId: CONVERSATION_ID, artifactId: id }));
    expectOk(await h.service.sign("drew", { conversationId: CONVERSATION_ID, artifactId: id, version: 1 }));
    expectOk(await h.service.rename("gera", { conversationId: CONVERSATION_ID, artifactId: id, newName: "Memory plan v2" }));
    expectOk(await h.service.setArchived("user", { conversationId: CONVERSATION_ID, artifactId: id, archived: true }));
    expectOk(await h.service.setArchived("gera", { conversationId: CONVERSATION_ID, artifactId: id, archived: false }));

    assert.deepEqual(h.notes.map(parseArtifactNoteCard), [
      { actor: "gera", action: "created", artifactId: id, label: "Memory plan", details: ["v1"] },
      { actor: "gera", action: "revised", artifactId: id, label: "Memory plan", details: ["v2"],
        note: "Choice rule: project knowledge — repo, private — memory" },
      { actor: "user", action: "revised", artifactId: id, label: "Memory plan", details: ["v3"] },
      { actor: "user", action: "signed", artifactId: id, label: "Memory plan", details: ["v3", "1/2 signed"] },
      { actor: "drew", action: "signed", artifactId: id, label: "Memory plan", details: ["v1"] },
      { actor: "gera", action: "renamed", artifactId: id, label: "Memory plan v2", details: ['was "Memory plan"'] },
      { actor: "user", action: "archived", artifactId: id, label: "Memory plan v2", details: [] },
      { actor: "gera", action: "restored", artifactId: id, label: "Memory plan v2", details: [] }
    ]);
    assert.equal(artifactNoteActorLabel("user"), "You");
    assert.equal(artifactNoteActorLabel("assistant"), "Chat Assistant");
    assert.equal(artifactNoteActorLabel("gera"), "@gera");
    assert.equal(artifactNoteVerb("withdrew-draft"), "withdrew a draft");
  } finally {
    await h.cleanup();
  }
});

test("a note the card does not know stays a plain message", () => {
  // Notes already in the User's chats use these exact sentences.
  assert.deepEqual(parseArtifactNoteCard("@taylor revised [Память участников — план v1](#artifact:ab-1) · v4 — Правило выбора"), {
    actor: "taylor", action: "revised", artifactId: "ab-1", label: "Память участников — план v1", details: ["v4"], note: "Правило выбора"
  });
  for (const text of [
    "",
    "Chat started.",
    "@taylor revised the plan",
    "@taylor revised [Plan](#artifact:ab-1)",
    "@taylor revised [Plan](#artifact:ab-1) · v4 extra",
    "@taylor deleted [Plan](#artifact:ab-1)",
    "@taylor signed [Plan](https://example.com) v2",
    "someone signed [Plan](#artifact:ab-1) v2",
    // The service names the User "User"; a member cannot pass as her.
    "@user signed [Plan](#artifact:ab-1) v2",
    "@User revised [Plan](#artifact:ab-1) · v2"
  ]) {
    assert.equal(parseArtifactNoteCard(text), undefined, text);
  }
  assert.equal(parseArtifactNoteCard(undefined), undefined);
});

test("artifact reference tokens parse into artifact links (rename-safe by id)", () => {
  const labeled = parseMarkdownInline("See [Release Plan](#artifact:0b9f3d3a-1) for details.");
  const link = labeled.find((node) => node.type === "artifactLink");
  assert.deepEqual(link, { type: "artifactLink", artifactId: "0b9f3d3a-1", label: "Release Plan" });

  const bare = parseMarkdownInline("ref #artifact:abc-123 end");
  const bareLink = bare.find((node) => node.type === "artifactLink");
  assert.deepEqual(bareLink, { type: "artifactLink", artifactId: "abc-123" });

  const uri = parseMarkdownInline("[Release Plan](artifact://0b9f3d3a-1)");
  const uriLink = uri.find((node) => node.type === "artifactLink");
  assert.deepEqual(uriLink, { type: "artifactLink", artifactId: "0b9f3d3a-1", label: "Release Plan" });

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
      store: new ArtifactStore(h.dbPath, SQLITE_EXECUTABLE),
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
    await runCommand(SQLITE_EXECUTABLE, [h.dbPath], {
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
      store: new ArtifactStore(h.dbPath, SQLITE_EXECUTABLE),
      getMembers: async () => [...MEMBERS],
      postNote: async () => undefined
    });
    await retry.flushPendingArtifactEvents();
    assert.deepEqual(await h.store.listPendingEvents(), []);
  } finally {
    await h.cleanup();
  }
});

test("usage signals: a document for several signers is started, and signed only when all sign its newest version", async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.store.multiSignerDocumentStatus(), { started: false, signed: false, plain: false });
    expectOk(await h.service.create("gera", { conversationId: CONVERSATION_ID, name: "Solo drafts", initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera"], requiredDraftAuthors: ["gera"], audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] } },
      operationId: "usage:solo-drafts" }));
    const solo = expectPublished(expectOk(await h.service.create("gera", { conversationId: CONVERSATION_ID,
      name: "One signer", content: "solo", requiredSigners: ["user"] })));
    expectOk(await h.service.sign("user", { conversationId: CONVERSATION_ID, artifactId: solo.summary.id,
      versionEventId: solo.version.versionEventId, contentHash: solo.version.contentHash }));
    assert.deepEqual(await h.store.multiSignerDocumentStatus(), { started: false, signed: false, plain: true }, "a one-signer document is a plain one");

    const shared = expectPublished(expectOk(await h.service.create("gera", { conversationId: CONVERSATION_ID,
      name: "Resolution", content: "v1", requiredSigners: ["gera", "drew"] })));
    assert.deepEqual(await h.store.multiSignerDocumentStatus(), { started: true, signed: false, plain: true });
    const sign = async (actor: string, version: PublishedArtifactReadResult["version"]) => expectOk(await h.service.sign(actor, {
      conversationId: CONVERSATION_ID, artifactId: shared.summary.id, versionEventId: version.versionEventId, contentHash: version.contentHash }));
    await sign("gera", shared.version);
    assert.deepEqual(await h.store.multiSignerDocumentStatus(), { started: true, signed: false, plain: true });
    await sign("drew", shared.version);
    assert.deepEqual(await h.store.multiSignerDocumentStatus(), { started: true, signed: true, plain: true });

    // A newer version: the signatures on the old one no longer count.
    const revised = expectPublished(expectOk(await h.service.revise("gera", { conversationId: CONVERSATION_ID,
      artifactId: shared.summary.id, baseVersion: 1, content: "v2" })));
    assert.deepEqual(await h.store.multiSignerDocumentStatus(), { started: true, signed: false, plain: true });
    await sign("gera", revised.version);
    assert.deepEqual(await h.store.multiSignerDocumentStatus(), { started: true, signed: false, plain: true });
    await sign("drew", revised.version);
    assert.deepEqual(await h.store.multiSignerDocumentStatus(), { started: true, signed: true, plain: true });

    // Drafts for several authors start one too, before anything is signed.
    const other = await harness();
    try {
      expectOk(await other.service.create("gera", { conversationId: CONVERSATION_ID, name: "Collecting", initialState: "collecting_drafts",
        contributors: ["drew"], allowedDraftAuthors: ["gera", "drew"], requiredDraftAuthors: ["gera", "drew"],
        audiencePolicyByAuthor: { gera: { allowedReaders: [], requiredReaders: [] }, drew: { allowedReaders: ["gera"], requiredReaders: ["gera"] } },
        operationId: "usage:collecting" }));
      assert.deepEqual(await other.store.multiSignerDocumentStatus(), { started: true, signed: false, plain: false });
    } finally { await other.cleanup(); }

    // Counted from a moment after all of that (a copy of older documents):
    // neither is new. A draft for several authors made since then is.
    const later = new Date(Date.now() + 60_000).toISOString();
    assert.deepEqual(await h.store.multiSignerDocumentStatus(later), { started: false, signed: false, plain: false });
    const before = new Date(Date.now() - 60 * 60_000).toISOString();
    assert.deepEqual(await h.store.multiSignerDocumentStatus(before), { started: true, signed: true, plain: true });
  } finally { await h.cleanup(); }
});
