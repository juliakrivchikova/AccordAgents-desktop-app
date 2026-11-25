import { artifactRevision, revisionInsertSql, revisionProjectionInsertSql } from "../artifactRevisions";
import { ARTIFACT_SELECT, type ArtifactRow } from "./artifactRows";
import {
  deletePendingOperationSql, insertEventSql, insertOperationSql, operationAppliedSql, operationIdentitySql, operationPendingSql,
  recordFromRow
} from "./artifactSql";
import { sqlString } from "./sqlText";
import type { ArtifactEventRecord, ArtifactOperationRecord, ArtifactRecord, ArtifactVersionRecord } from "./types";
import type { ArtifactStoreModules } from "./modules";

/** Documents themselves. */
export class ArtifactRecords {
  constructor(private readonly store: Pick<ArtifactStoreModules, "artifactDatabase" | "artifactOperations">) {}

  async insertArtifact(
    record: ArtifactRecord,
    nameKey: string,
    firstVersion: ArtifactVersionRecord,
    event?: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.store.artifactDatabase.init();
    const revision = artifactRevision(firstVersion, event?.id);
    const output = await this.store.artifactDatabase.queryText(`
      begin immediate;
      insert into artifacts (
        id, conversation_id, name, name_key, owner,
        contributors_json, required_signers_json, labels_json,
        lifecycle, allowed_draft_authors_json, required_draft_authors_json,
        audience_policy_json, draft_roster_revision,
        head_version, created_at, updated_at
      ) select
        ${sqlString(record.id)},
        ${sqlString(record.conversationId)},
        ${sqlString(record.name)},
        ${sqlString(nameKey)},
        ${sqlString(record.owner)},
        ${sqlString(JSON.stringify(record.contributors))},
        ${sqlString(JSON.stringify(record.requiredSigners))},
        ${sqlString(JSON.stringify(record.labels))},
        ${sqlString(record.lifecycle)},
        ${sqlString(JSON.stringify(record.allowedDraftAuthors))},
        ${sqlString(JSON.stringify(record.requiredDraftAuthors))},
        ${sqlString(JSON.stringify(record.audiencePolicyByAuthor))},
        ${Math.floor(record.draftRosterRevision)},
        ${Math.floor(record.headVersion)},
        ${sqlString(record.createdAt)},
        ${sqlString(record.updatedAt)}
      where not exists (
        select 1 from artifact_conversation_tombstones
        where conversation_id = ${sqlString(record.conversationId)}
      );
      ${revisionInsertSql(revision, `exists (select 1 from artifacts where id = ${sqlString(record.id)})`)}
      ${revisionProjectionInsertSql(revision)}
      ${event ? `
        insert into artifact_event_outbox (
          id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
        )
        select
          ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
          ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
          ${sqlString(event.createdAt)}, ${sqlString(event.deliveredAt)}
        where exists (select 1 from artifacts where id = ${sqlString(record.id)});
      ` : ""}
      select count(*) from artifacts where id = ${sqlString(record.id)};
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return Number.parseInt(output.trim(), 10) === 1;
  }

  async insertCollectingArtifact(
    record: ArtifactRecord,
    nameKey: string,
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`
      begin immediate;
      ${insertOperationSql(operation)}
      insert or ignore into artifacts (
        id, conversation_id, name, name_key, owner,
        contributors_json, required_signers_json, labels_json,
        lifecycle, allowed_draft_authors_json, required_draft_authors_json,
        audience_policy_json, draft_roster_revision,
        head_version, created_at, updated_at, origin_message_id
      )
      select
        ${sqlString(record.id)},
        ${sqlString(record.conversationId)},
        ${sqlString(record.name)},
        ${sqlString(nameKey)},
        ${sqlString(record.owner)},
        ${sqlString(JSON.stringify(record.contributors))},
        ${sqlString(JSON.stringify(record.requiredSigners))},
        ${sqlString(JSON.stringify(record.labels))},
        ${sqlString(record.lifecycle)},
        ${sqlString(JSON.stringify(record.allowedDraftAuthors))},
        ${sqlString(JSON.stringify(record.requiredDraftAuthors))},
        ${sqlString(JSON.stringify(record.audiencePolicyByAuthor))},
        ${Math.floor(record.draftRosterRevision)},
        0,
        ${sqlString(record.createdAt)},
        ${sqlString(record.updatedAt)},
        ${sqlString(record.originMessageId)}
      where ${operationPendingSql(operation)}
        and not exists (
          select 1 from artifact_conversation_tombstones
          where conversation_id = ${sqlString(record.conversationId)}
        );
      update artifact_operations set applied = 1
      where ${operationIdentitySql(operation)}
        and request_hash = ${sqlString(operation.requestHash)}
        and applied = 0
        and exists (select 1 from artifacts where id = ${sqlString(record.id)});
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

  async getById(id: string): Promise<ArtifactRecord | undefined> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactRow>(`${ARTIFACT_SELECT} where id = ${sqlString(id)} limit 1;`);
    return rows[0] ? recordFromRow(rows[0]) : undefined;
  }

  async getByName(conversationId: string, nameKey: string): Promise<ArtifactRecord | undefined> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactRow>(
      `${ARTIFACT_SELECT} where conversation_id = ${sqlString(conversationId)} and name_key = ${sqlString(nameKey)} limit 1;`
    );
    return rows[0] ? recordFromRow(rows[0]) : undefined;
  }

  async listByConversation(conversationId: string): Promise<ArtifactRecord[]> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactRow>(
      `${ARTIFACT_SELECT} where conversation_id = ${sqlString(conversationId)} order by updated_at desc, name asc;`
    );
    return rows.map((row) => recordFromRow(row));
  }

  async updateName(
    id: string,
    name: string,
    nameKey: string,
    updatedAt: string,
    event?: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<void> {
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`
      begin immediate;
      update artifacts
      set name = ${sqlString(name)}, name_key = ${sqlString(nameKey)}, updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(id)};
      ${event ? insertEventSql(event) : ""}
      ${alsoCommitSql ?? ""}
      commit;
    `);
  }

  async updateAccess(
    id: string,
    access: { owner: string; contributors: string[]; requiredSigners: string[]; labels: string[] },
    updatedAt: string,
    alsoCommitSql?: string
  ): Promise<void> {
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`
      begin immediate;
      update artifacts
      set
        owner = ${sqlString(access.owner)},
        contributors_json = ${sqlString(JSON.stringify(access.contributors))},
        required_signers_json = ${sqlString(JSON.stringify(access.requiredSigners))},
        labels_json = ${sqlString(JSON.stringify(access.labels))},
        updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(id)};
      ${alsoCommitSql ?? ""}
      commit;
    `);
  }

  async touch(id: string, updatedAt: string): Promise<void> {
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`update artifacts set updated_at = ${sqlString(updatedAt)} where id = ${sqlString(id)};`);
  }

  async updateArchived(
    id: string,
    archivedAt: string | undefined,
    updatedAt: string,
    event?: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<void> {
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`
      begin immediate;
      update artifacts
      set archived_at = ${sqlString(archivedAt)}, updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(id)};
      ${event ? insertEventSql(event) : ""}
      ${alsoCommitSql ?? ""}
      commit;
    `);
  }
}
