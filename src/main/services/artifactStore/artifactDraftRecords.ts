import { artifactRevision, revisionInsertSql, revisionProjectionInsertSql } from "../artifactRevisions";
import type { ArtifactDraftRow } from "./artifactRows";
import {
  deletePendingOperationSql, draftFromRow, insertOperationSql, operationAppliedSql, operationIdentitySql, operationPendingSql
} from "./artifactSql";
import { sqlString } from "./sqlText";
import type {
  ArtifactDraftRecord, ArtifactEventRecord, ArtifactOperationRecord, ArtifactRecord, ArtifactVersionRecord,
  ArtifactVersionSourceRecord
} from "./types";
import type { ArtifactStoreModules } from "./modules";

/** Drafts of a document that is not published yet. */
export class ArtifactDraftRecords {
  constructor(private readonly store: Pick<ArtifactStoreModules, "artifactDatabase" | "artifactOperations">) {}

  async listDrafts(artifactId: string): Promise<ArtifactDraftRecord[]> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactDraftRow>(`
      select
        id,
        artifact_id as artifactId,
        author,
        state,
        content,
        readers_json as readersJson,
        edit_revision as editRevision,
        supersedes_draft_id as supersedesDraftId,
        created_at as createdAt,
        updated_at as updatedAt,
        submitted_at as submittedAt
      from artifact_drafts
      where artifact_id = ${sqlString(artifactId)}
      order by created_at asc, id asc;
    `);
    return rows.map((row) => draftFromRow(row));
  }

  async getDraft(draftId: string): Promise<ArtifactDraftRecord | undefined> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactDraftRow>(`
      select
        id,
        artifact_id as artifactId,
        author,
        state,
        content,
        readers_json as readersJson,
        edit_revision as editRevision,
        supersedes_draft_id as supersedesDraftId,
        created_at as createdAt,
        updated_at as updatedAt,
        submitted_at as submittedAt
      from artifact_drafts
      where id = ${sqlString(draftId)}
      limit 1;
    `);
    return rows[0] ? draftFromRow(rows[0]) : undefined;
  }

  async saveDraft(
    record: ArtifactDraftRecord,
    expectedEditRevision: number,
    expectedRosterRevision: number,
    operation: ArtifactOperationRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.store.artifactDatabase.init();
    const isNew = expectedEditRevision === 0;
    await this.store.artifactDatabase.runSql(`
      begin immediate;
      ${insertOperationSql(operation)}
      ${isNew ? `
        insert into artifact_drafts (
          id, artifact_id, author, state, content, readers_json, edit_revision,
          supersedes_draft_id, created_at, updated_at, submitted_at
        )
        select
          ${sqlString(record.id)}, ${sqlString(record.artifactId)}, ${sqlString(record.author)},
          'editing', ${sqlString(record.content)}, ${sqlString(JSON.stringify(record.readers))},
          1, ${sqlString(record.supersedesDraftId)}, ${sqlString(record.createdAt)},
          ${sqlString(record.updatedAt)}, NULL
        where ${operationPendingSql(operation)}
          and exists (
            select 1 from artifacts
            where id = ${sqlString(record.artifactId)}
              and lifecycle = 'collecting_drafts'
              and draft_roster_revision = ${Math.floor(expectedRosterRevision)}
          )
          and not exists (
            select 1 from artifact_drafts
            where artifact_id = ${sqlString(record.artifactId)}
              and author = ${sqlString(record.author)} and state = 'editing'
          )
          and (
            (${sqlString(record.supersedesDraftId)} is null and not exists (
              select 1 from artifact_drafts current
              where current.artifact_id = ${sqlString(record.artifactId)}
                and current.author = ${sqlString(record.author)}
                and current.state = 'submitted'
            ))
            or (${sqlString(record.supersedesDraftId)} is not null and exists (
              select 1 from artifact_drafts current
              where current.id = ${sqlString(record.supersedesDraftId)}
                and current.artifact_id = ${sqlString(record.artifactId)}
                and current.author = ${sqlString(record.author)}
                and current.state = 'submitted'
            ))
          );
      ` : `
        update artifact_drafts
        set
          content = ${sqlString(record.content)},
          readers_json = ${sqlString(JSON.stringify(record.readers))},
          edit_revision = ${Math.floor(record.editRevision)},
          updated_at = ${sqlString(record.updatedAt)}
        where id = ${sqlString(record.id)}
          and artifact_id = ${sqlString(record.artifactId)}
          and author = ${sqlString(record.author)}
          and state = 'editing'
          and edit_revision = ${Math.floor(expectedEditRevision)}
          and exists (
            select 1 from artifacts
            where id = ${sqlString(record.artifactId)}
              and lifecycle = 'collecting_drafts'
              and draft_roster_revision = ${Math.floor(expectedRosterRevision)}
          )
          and ${operationPendingSql(operation)};
      `}
      update artifact_operations set applied = 1
      where ${operationIdentitySql(operation)} and applied = 0 and changes() = 1;
      update artifacts
      set updated_at = ${sqlString(record.updatedAt)}
      where id = ${sqlString(record.artifactId)} and ${operationAppliedSql(operation)};
      ${deletePendingOperationSql(operation)}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return (await this.store.artifactOperations.getOperation(
      operation.conversationId,
      operation.actor,
      operation.operationKind,
      operation.operationId
    ))?.applied === true;
  }

  async submitDraft(
    draft: ArtifactDraftRecord,
    expectedEditRevision: number,
    expectedRosterRevision: number,
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`
      begin immediate;
      ${insertOperationSql(operation)}
      update artifact_drafts
      set state = 'submitted', submitted_at = ${sqlString(draft.submittedAt)}, updated_at = ${sqlString(draft.updatedAt)}
      where id = ${sqlString(draft.id)}
        and artifact_id = ${sqlString(draft.artifactId)}
        and author = ${sqlString(draft.author)}
        and state = 'editing'
        and edit_revision = ${Math.floor(expectedEditRevision)}
        and exists (
          select 1 from artifacts
          where id = ${sqlString(draft.artifactId)}
            and lifecycle = 'collecting_drafts'
            and draft_roster_revision = ${Math.floor(expectedRosterRevision)}
        )
        and ${operationPendingSql(operation)}
        and (
          supersedes_draft_id is null
          or exists (
            select 1 from artifact_drafts prior
            where prior.id = artifact_drafts.supersedes_draft_id
              and prior.artifact_id = artifact_drafts.artifact_id
              and prior.author = artifact_drafts.author
              and prior.state = 'submitted'
          )
        )
        and not exists (
          select 1 from artifact_drafts current
          where current.artifact_id = artifact_drafts.artifact_id
            and current.author = artifact_drafts.author
            and current.state = 'submitted'
            and current.id <> coalesce(artifact_drafts.supersedes_draft_id, '')
        );
      update artifact_operations set applied = 1
      where ${operationIdentitySql(operation)} and applied = 0 and changes() = 1;
      update artifact_drafts
      set state = 'superseded', updated_at = ${sqlString(draft.updatedAt)}
      where id = ${sqlString(draft.supersedesDraftId)}
        and artifact_id = ${sqlString(draft.artifactId)}
        and author = ${sqlString(draft.author)}
        and state = 'submitted'
        and ${operationAppliedSql(operation)};
      update artifacts
      set updated_at = ${sqlString(draft.updatedAt)}
      where id = ${sqlString(draft.artifactId)} and ${operationAppliedSql(operation)};
      insert into artifact_event_outbox (
        id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
      )
      select
        ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
        ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
        ${sqlString(event.createdAt)}, NULL
      where ${operationAppliedSql(operation)};
      ${deletePendingOperationSql(operation)}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return (await this.store.artifactOperations.getOperation(
      operation.conversationId,
      operation.actor,
      operation.operationKind,
      operation.operationId
    ))?.applied === true;
  }

  async withdrawDraft(
    draft: ArtifactDraftRecord,
    expectedRosterRevision: number,
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`
      begin immediate;
      ${insertOperationSql(operation)}
      update artifact_drafts
      set state = 'withdrawn', updated_at = ${sqlString(draft.updatedAt)}
      where id = ${sqlString(draft.id)}
        and artifact_id = ${sqlString(draft.artifactId)}
        and state = 'submitted'
        and exists (
          select 1 from artifacts
          where id = ${sqlString(draft.artifactId)}
            and lifecycle = 'collecting_drafts'
            and draft_roster_revision = ${Math.floor(expectedRosterRevision)}
        )
        and ${operationPendingSql(operation)}
        and not exists (
          select 1 from artifact_drafts replacement
          where replacement.supersedes_draft_id = artifact_drafts.id
            and replacement.state = 'editing'
        );
      update artifact_operations set applied = 1
      where ${operationIdentitySql(operation)} and applied = 0 and changes() = 1;
      update artifacts
      set updated_at = ${sqlString(draft.updatedAt)}
      where id = ${sqlString(draft.artifactId)} and ${operationAppliedSql(operation)};
      insert into artifact_event_outbox (
        id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
      )
      select
        ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
        ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
        ${sqlString(event.createdAt)}, NULL
      where ${operationAppliedSql(operation)};
      ${deletePendingOperationSql(operation)}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return (await this.store.artifactOperations.getOperation(
      operation.conversationId,
      operation.actor,
      operation.operationKind,
      operation.operationId
    ))?.applied === true;
  }

  async updateDraftRoster(
    artifactId: string,
    expectedRevision: number,
    roster: Pick<ArtifactRecord, "allowedDraftAuthors" | "requiredDraftAuthors" | "audiencePolicyByAuthor">,
    updatedAt: string,
    operation: ArtifactOperationRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`
      begin immediate;
      ${insertOperationSql(operation)}
      update artifacts
      set
        allowed_draft_authors_json = ${sqlString(JSON.stringify(roster.allowedDraftAuthors))},
        required_draft_authors_json = ${sqlString(JSON.stringify(roster.requiredDraftAuthors))},
        audience_policy_json = ${sqlString(JSON.stringify(roster.audiencePolicyByAuthor))},
        draft_roster_revision = draft_roster_revision + 1,
        updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(artifactId)}
        and lifecycle = 'collecting_drafts'
        and draft_roster_revision = ${Math.floor(expectedRevision)}
        and ${operationPendingSql(operation)};
      update artifact_operations set applied = 1
      where ${operationIdentitySql(operation)} and applied = 0 and changes() = 1;
      ${deletePendingOperationSql(operation)}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return (await this.store.artifactOperations.getOperation(
      operation.conversationId,
      operation.actor,
      operation.operationKind,
      operation.operationId
    ))?.applied === true;
  }

  async publishFirstVersion(
    artifact: ArtifactRecord,
    version: ArtifactVersionRecord,
    sources: ArtifactVersionSourceRecord[],
    requiredSigners: string[],
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.store.artifactDatabase.init();
    const revision = artifactRevision(version, event.id);
    const requiredChecks = artifact.requiredDraftAuthors.map((author) => {
      const sourceIds = sources
        .filter((candidate) => candidate.author === author && candidate.disposition === "considered")
        .map((candidate) => sqlString(candidate.draftId));
      return sourceIds.length > 0 ? `
      and exists (
        select 1 from artifact_drafts
        where id in (${sourceIds.join(", ")})
          and artifact_id = ${sqlString(artifact.id)}
          and author = ${sqlString(author)}
          and state = 'submitted'
      )
    ` : "and 0";
    }).join("\n");
    const sourceChecks = sources.map((source) => `
      and exists (
        select 1 from artifact_drafts
        where id = ${sqlString(source.draftId)}
          and artifact_id = ${sqlString(artifact.id)}
          and author = ${sqlString(source.author)}
          and submitted_at = ${sqlString(source.submittedAt)}
          and state in ('submitted', 'superseded', 'withdrawn')
      )
    `).join("\n");
    const sourceInserts = sources.map((source) => `
      insert into artifact_bound_sources (
        artifact_id, version_event_id, draft_id, author, submitted_at,
        content_hash, disposition, exclusion_rationale
      )
      select
        ${sqlString(source.artifactId)}, ${sqlString(revision.versionEventId)}, draft.id,
        draft.author, draft.submitted_at, ${sqlString(source.contentHash)},
        ${sqlString(source.disposition)}, ${sqlString(source.exclusionRationale)}
      from artifact_drafts draft
      where ${operationPendingSql(operation)}
        and draft.id = ${sqlString(source.draftId)}
        and draft.artifact_id = ${sqlString(artifact.id)}
        and draft.author = ${sqlString(source.author)}
        and draft.submitted_at = ${sqlString(source.submittedAt)}
        and draft.state in ('submitted', 'superseded', 'withdrawn')
        and exists (
          select 1 from artifact_version_projection
          where artifact_id = ${sqlString(artifact.id)} and version = 1 and version_event_id = ${sqlString(revision.versionEventId)}
        );
    `).join("\n");
    await this.store.artifactDatabase.runSql(`
      begin immediate;
      ${insertOperationSql(operation)}
      ${revisionInsertSql(revision, `${operationPendingSql(operation)}
        and exists (
          select 1 from artifacts
          where id = ${sqlString(artifact.id)}
            and lifecycle = 'collecting_drafts'
            and head_version = 0
            and draft_roster_revision = ${Math.floor(artifact.draftRosterRevision)}
            ${requiredChecks}
            ${sourceChecks}
        )`)}
      ${revisionProjectionInsertSql(revision)}
      ${sourceInserts}
      update artifacts
      set
        lifecycle = 'published',
        head_version = 1,
        required_signers_json = ${sqlString(JSON.stringify(requiredSigners))},
        updated_at = ${sqlString(version.createdAt)}
      where id = ${sqlString(artifact.id)}
        and lifecycle = 'collecting_drafts'
        and head_version = 0
        and ${operationPendingSql(operation)}
        and exists (
          select 1 from artifact_version_projection
          where artifact_id = ${sqlString(artifact.id)} and version = 1 and version_event_id = ${sqlString(revision.versionEventId)}
        );
      insert into artifact_event_outbox (
        id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
      )
      select
        ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
        ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
        ${sqlString(event.createdAt)}, NULL
      where changes() = 1;
      update artifact_operations set applied = 1
      where ${operationIdentitySql(operation)} and applied = 0 and changes() = 1;
      ${deletePendingOperationSql(operation)}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return (await this.store.artifactOperations.getOperation(
      operation.conversationId,
      operation.actor,
      operation.operationKind,
      operation.operationId
    ))?.applied === true;
  }
}
