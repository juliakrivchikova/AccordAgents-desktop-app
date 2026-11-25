import assert from "node:assert/strict";
import test from "node:test";
import { SUBMIT_OWN_DRAFT_FIRST_MESSAGE } from "./artifacts";
import { parseArtifactNoteCard } from "../../shared/artifactNoteCard";
import { attach, CONVERSATION_ID, expectError, expectOk, harness, MEMBERS } from "./artifacts/test/artifactFixtures";

test("archived collecting artifacts are read-only until restored", async () => {
  const h = await harness();
  try {
    const created = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Archived Drafts",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera", "codex"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: {
        gera: { allowedReaders: ["codex"], requiredReaders: [] },
        codex: { allowedReaders: ["gera"], requiredReaders: [] }
      },
      operationId: "archived-drafts:create"
    }));
    assert.equal(created.lifecycle, "collecting_drafts");
    const draft = expectOk(await h.service.saveDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      expectedEditRevision: 0,
      content: "draft body",
      readers: ["codex"],
      operationId: "archived-drafts:save-before"
    }));

    expectOk(await h.service.setArchived("user", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      archived: true
    }));

    assert.match(expectError(await h.service.saveDraft("codex", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      expectedEditRevision: 0,
      content: "new draft while archived",
      readers: ["gera"],
      operationId: "archived-drafts:save-after"
    }), "invalid_request").message, /Restore "Archived Drafts" before editing drafts/);
    assert.match(expectError(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      draftId: draft.id,
      expectedEditRevision: draft.editRevision,
      operationId: "archived-drafts:submit-after"
    }), "invalid_request").message, /Restore "Archived Drafts" before submitting drafts/);
    assert.match(expectError(await h.service.updateDraftRoster("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      expectedDraftRosterRevision: created.summary.draftRosterRevision,
      allowedDraftAuthors: ["gera"],
      requiredDraftAuthors: ["gera"],
      audiencePolicyByAuthor: {},
      operationId: "archived-drafts:roster-after"
    }), "invalid_request").message, /Restore "Archived Drafts" before changing the draft roster/);
    assert.match(expectError(await h.service.publish("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      content: "published body",
      requiredSigners: [],
      sources: [],
      operationId: "archived-drafts:publish-after"
    }), "invalid_request").message, /Restore "Archived Drafts" before publishing it/);

    expectOk(await h.service.setArchived("user", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      archived: false
    }));
    const submitted = expectOk(await h.service.submitDraft("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: created.summary.id,
      draftId: draft.id,
      expectedEditRevision: draft.editRevision,
      operationId: "archived-drafts:submit-after-restore"
    }));
    assert.equal(submitted.state, "submitted");
  } finally {
    await h.cleanup();
  }
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
      note: "Ship on Monday,\n  after the fix.",
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
      note: "Ship on Monday,\n  after the fix.",
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
    // The publication's note carries the version's note, read back as the
    // card's outcome; on one line, as a revision's.
    const publishedNote = parseArtifactNoteCard(h.notes.find((note) => note.includes(" published "))!);
    assert.deepEqual([publishedNote?.action, publishedNote?.details, publishedNote?.note], ["published", ["v1"], "Ship on Monday, after the fix."]);
    assert.ok(published.sources?.every((source) => /^[a-f0-9]{64}$/.test(source.contentHash)));

    const publicNotes = h.notes.join("\n");
    assert.ok(publicNotes.includes("submitted a draft"));
    assert.deepEqual(
      [...new Set(h.notes.map((note) => parseArtifactNoteCard(note)?.action ?? `unread: ${note}`))],
      ["created-collection", "submitted-draft", "published"]
    );
    for (const secret of ["OWNER-PRIVATE", "CODEX-PRIVATE", "DREW-PRIVATE"]) {
      assert.ok(!publicNotes.includes(secret), `public notes must not leak ${secret}`);
    }
    assert.ok(!publicNotes.includes("gera" + "]"), "public notes must not serialize audience lists");
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

test("a required author cannot read other drafts until their own draft is submitted, so authors can draft in parallel", async () => {
  const h = await harness();
  try {
    const collecting = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Parallel drafts",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera", "codex", "drew"],
      requiredDraftAuthors: ["gera", "codex", "drew"],
      audiencePolicyByAuthor: {
        gera: { allowedReaders: [], requiredReaders: [] },
        codex: { allowedReaders: ["gera"], requiredReaders: ["gera"] },
        drew: { allowedReaders: ["gera"], requiredReaders: ["gera"] }
      },
      operationId: "parallel:create"
    }));
    const artifactId = collecting.summary.id;
    const ref = { conversationId: CONVERSATION_ID, artifactId };
    const codexEditing = expectOk(await h.service.saveDraft("codex", {
      ...ref,
      expectedEditRevision: 0,
      content: "CODEX-PARALLEL",
      readers: ["gera"],
      operationId: "parallel:codex:save"
    }));
    const codexSubmitted = expectOk(await h.service.submitDraft("codex", {
      ...ref,
      draftId: codexEditing.id,
      expectedEditRevision: codexEditing.editRevision,
      operationId: "parallel:codex:submit"
    }));
    const drewEditing = expectOk(await h.service.saveDraft("drew", {
      ...ref,
      expectedEditRevision: 0,
      content: "DREW-IN-PROGRESS",
      readers: ["gera"],
      operationId: "parallel:drew:save"
    }));

    for (const draftId of [codexSubmitted.id, drewEditing.id]) {
      const denied = expectError(await h.service.readDraft("gera", { ...ref, draftId }), "access_denied");
      assert.equal(denied.message, SUBMIT_OWN_DRAFT_FIRST_MESSAGE);
    }
    const listedBefore = expectOk(await h.service.listDrafts("gera", ref));
    assert.deepEqual(listedBefore.map((draft) => [draft.author, draft.hasContent]), [["codex", false], ["drew", false]]);
    const readBefore = expectOk(await h.service.read("gera", ref));
    assert.equal(readBefore.lifecycle, "collecting_drafts");
    assert.deepEqual(readBefore.lifecycle === "collecting_drafts" ? readBefore.drafts.map((draft) => draft.hasContent) : [], [false, false]);
    for (const view of [listedBefore, readBefore]) {
      assert.ok(!JSON.stringify(view).includes("CODEX-PARALLEL") && !JSON.stringify(view).includes("DREW-IN-PROGRESS"));
    }
    assert.equal(expectOk(await h.service.readDraft("user", { ...ref, draftId: codexSubmitted.id })).content, "CODEX-PARALLEL",
      "User always reads every draft");

    const geraEditing = expectOk(await h.service.saveDraft("gera", {
      ...ref,
      expectedEditRevision: 0,
      content: "GERA-OWN",
      readers: [],
      operationId: "parallel:gera:save"
    }));
    expectError(await h.service.readDraft("gera", { ...ref, draftId: codexSubmitted.id }), "access_denied");
    assert.equal(expectOk(await h.service.readDraft("gera", { ...ref, draftId: geraEditing.id })).content, "GERA-OWN",
      "an author always reads their own work in progress");

    const geraSubmitted = expectOk(await h.service.submitDraft("gera", {
      ...ref,
      draftId: geraEditing.id,
      expectedEditRevision: geraEditing.editRevision,
      operationId: "parallel:gera:submit"
    }));
    assert.equal(expectOk(await h.service.readDraft("gera", { ...ref, draftId: codexSubmitted.id })).content, "CODEX-PARALLEL");
    assert.equal(expectOk(await h.service.readDraft("gera", { ...ref, draftId: drewEditing.id })).content, "DREW-IN-PROGRESS");
    const listedAfter = expectOk(await h.service.listDrafts("gera", ref));
    assert.ok(listedAfter.every((draft) => draft.hasContent));
    const readAfter = expectOk(await h.service.read("gera", ref));
    const codexView = readAfter.lifecycle === "collecting_drafts" ? readAfter.drafts.find((draft) => draft.id === codexSubmitted.id) : undefined;
    assert.equal(codexView && "content" in codexView ? codexView.content : undefined, "CODEX-PARALLEL");

    expectOk(await h.service.withdrawDraft("gera", { ...ref, draftId: geraSubmitted.id, operationId: "parallel:gera:withdraw" }));
    assert.equal(expectOk(await h.service.readDraft("gera", { ...ref, draftId: codexSubmitted.id })).content, "CODEX-PARALLEL",
      "a withdrawn draft was still submitted unseen first");
  } finally {
    await h.cleanup();
  }
});

test("only required authors are held back, and a held-back owner cannot drop themselves from the roster to read", async () => {
  const h = await harness();
  try {
    const collecting = expectOk(await h.service.create("gera", {
      conversationId: CONVERSATION_ID,
      name: "Roster gate",
      initialState: "collecting_drafts",
      allowedDraftAuthors: ["gera", "codex", "drew"],
      requiredDraftAuthors: ["gera", "codex"],
      audiencePolicyByAuthor: {
        gera: { allowedReaders: [], requiredReaders: [] },
        codex: { allowedReaders: ["gera", "drew"], requiredReaders: ["gera"] },
        drew: { allowedReaders: [], requiredReaders: [] }
      },
      operationId: "roster-gate:create"
    }));
    const ref = { conversationId: CONVERSATION_ID, artifactId: collecting.summary.id };
    const codexEditing = expectOk(await h.service.saveDraft("codex", {
      ...ref,
      expectedEditRevision: 0,
      content: "CODEX-BODY",
      readers: ["gera", "drew"],
      operationId: "roster-gate:codex:save"
    }));
    const codexSubmitted = expectOk(await h.service.submitDraft("codex", {
      ...ref,
      draftId: codexEditing.id,
      expectedEditRevision: codexEditing.editRevision,
      operationId: "roster-gate:codex:submit"
    }));
    assert.equal(expectOk(await h.service.readDraft("drew", { ...ref, draftId: codexSubmitted.id })).content, "CODEX-BODY",
      "an optional author is never locked out");
    expectError(await h.service.readDraft("gera", { ...ref, draftId: codexSubmitted.id }), "access_denied");

    const selfRemoval = {
      ...ref,
      expectedDraftRosterRevision: collecting.summary.draftRosterRevision,
      allowedDraftAuthors: ["gera", "codex", "drew"],
      requiredDraftAuthors: ["codex"],
      audiencePolicyByAuthor: {
        gera: { allowedReaders: [], requiredReaders: [] },
        codex: { allowedReaders: ["gera", "drew"], requiredReaders: ["gera"] },
        drew: { allowedReaders: [], requiredReaders: [] }
      }
    };
    assert.match(expectError(await h.service.updateDraftRoster("gera", {
      ...selfRemoval,
      operationId: "roster-gate:self-removal"
    }), "access_denied").message, /Submit your own draft before removing yourself/);
    expectError(await h.service.readDraft("gera", { ...ref, draftId: codexSubmitted.id }), "access_denied");

    expectOk(await h.service.updateDraftRoster("user", { ...selfRemoval, operationId: "roster-gate:user-change" }));
    assert.equal(expectOk(await h.service.readDraft("gera", { ...ref, draftId: codexSubmitted.id })).content, "CODEX-BODY",
      "User may still change who must write");
  } finally {
    await h.cleanup();
  }
});
