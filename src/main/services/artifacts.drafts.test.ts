import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactStore } from "./artifactStore";
import { ARTIFACT_REVISION_SCHEMA } from "./artifactRevisions";
import type { ArtifactDraftRecord, ArtifactOperationRecord } from "./artifactStore";
import { CommandError, runCommand } from "./command";
import { parseArtifactNoteCard } from "../../shared/artifactNoteCard";
import {
  attach, CONVERSATION_ID, expectError, expectOk, expectPublished, harness, SQLITE_EXECUTABLE
} from "./artifacts/test/artifactFixtures";

const NOW_FOR_LEGACY = "2026-07-13T12:00:00.000Z";

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
    assert.ok(h.notes.some((note) => parseArtifactNoteCard(note)?.action === "withdrew-draft"));
    assert.ok(h.notes.every((note) => parseArtifactNoteCard(note)), "every note reads as a card");
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
    await new ArtifactStore(h.dbPath, SQLITE_EXECUTABLE).init();
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
    const beforePublish = (await h.store.getById(collecting.summary.id))!;
    expectOk(await h.service.publish("gera", {
      conversationId: CONVERSATION_ID,
      artifactId: collecting.summary.id,
      content: "v1",
      requiredSigners: [],
      sources: [{ draftId: submitted.id, disposition: "considered" }],
      operationId: "guard:publish"
    }));
    const sources = await h.store.listVersionSources(collecting.summary.id, 1);
    const rejectedEventId = "guard:losing-publication";
    assert.equal(await h.store.publishFirstVersion(beforePublish,
      { artifactId: collecting.summary.id, version: 1, content: "losing v1", author: "gera", createdAt: submitted.updatedAt },
      sources, [], operationForArtifact("guard:losing-publish", collecting.summary.id, "publish_v1", "losing"),
      eventRecord(rejectedEventId, collecting.summary.id, "published", submitted.updatedAt)), false);
    const residue = await runCommand(SQLITE_EXECUTABLE, [h.dbPath], {
      input: `select count(*) from artifact_bound_sources where version_event_id = '${rejectedEventId}';`, primeLoginShellEnv: false
    });
    assert.equal(residue.stdout.trim(), "0");
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
    await runCommand(SQLITE_EXECUTABLE, [dbPath], {
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
        insert into artifact_signatures values ('legacy-id', 1, 'user', '${NOW_FOR_LEGACY}');
      `,
      primeLoginShellEnv: false
    });
    await runCommand(SQLITE_EXECUTABLE, [dbPath], { input: `${ARTIFACT_REVISION_SCHEMA}
      create trigger migration_disk_full before insert on artifact_bound_signatures begin select raise(abort, 'SQLITE_FULL'); end;`, primeLoginShellEnv: false });
    const migrated = attach(dbPath);
    await assert.rejects(migrated.store.init(), error => error instanceof CommandError && /SQLITE_FULL/.test(error.result.stderr));
    const legacyResult = JSON.stringify({ artifactId: "legacy-id", value: { lifecycle: "published", version: {
      version: 1, content: "legacy body", author: "gera", createdAt: NOW_FOR_LEGACY, signatures: []
    }, history: [] } });
    await runCommand(SQLITE_EXECUTABLE, [dbPath], { input: `
      drop trigger migration_disk_full;
      insert into artifact_operations(conversation_id, artifact_id, actor, operation_kind, operation_id, request_hash, result_json, created_at, applied)
        values ('${CONVERSATION_ID}', 'legacy-id', 'gera', 'publish_v1', 'legacy-publish', 'legacy-hash', '${legacyResult}', '${NOW_FOR_LEGACY}', 1);`, primeLoginShellEnv: false });
    const read = expectPublished(expectOk(await migrated.service.read("user", {
      conversationId: CONVERSATION_ID,
      artifactId: "legacy-id"
    })));
    assert.equal(read.summary.lifecycle, "published");
    assert.equal(read.summary.headVersion, 1);
    assert.equal(read.version.content, "legacy body");
    assert.equal(read.version.signatures[0].signedAt, NOW_FOR_LEGACY);
    assert.equal(read.version.signatures[0].versionEventId, read.version.versionEventId);
    assert.equal(read.version.signatures[0].contentHash, read.version.contentHash);
    const replay = await migrated.store.getOperation(CONVERSATION_ID, "gera", "publish_v1", "legacy-publish");
    assert.equal(JSON.parse(replay!.resultJson).value.version.versionEventId, read.version.versionEventId);
    assert.equal(JSON.parse(replay!.resultJson).value.version.contentHash, read.version.contentHash);
    const signed = expectOk(await migrated.service.sign("user", {
      conversationId: CONVERSATION_ID,
      artifactId: "legacy-id"
    }));
    assert.equal(signed.approval.state, "approved");
    await assert.rejects(runCommand(SQLITE_EXECUTABLE, ["-bail", dbPath], {
      input: `insert into artifact_versions values ('legacy-id', 2, 'old app write', 'gera', null, '${NOW_FOR_LEGACY}');`,
      primeLoginShellEnv: false
    }), error => error instanceof CommandError && /upgrade AccordAgents/.test(error.result.stderr));
    await new ArtifactStore(dbPath, SQLITE_EXECUTABLE).init();
  } finally {
    await rm(dir, { recursive: true, force: true });
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
