import { type ArtifactDraftRow, type ArtifactRow, parseAudiencePolicy, parseStringArray } from "./artifactRows";
import { sqlString } from "./sqlText";
import type { ArtifactDraftRecord, ArtifactEventRecord, ArtifactOperationRecord, ArtifactRecord } from "./types";

export function operationCommittedSql(operation: ArtifactOperationRecord): string {
  return operationAppliedSql(operation);
}

/** The statements that delete a chat's documents and keep them deleted (a
 *  late write for the chat is refused by the tombstone), to commit with
 *  the chat's own deletion. */
export function deleteByConversationSql(conversationId: string, deletedAt: string): string {
  const artifacts = `(select id from artifacts where conversation_id = ${sqlString(conversationId)})`;
  return `
      insert or ignore into artifact_conversation_tombstones (conversation_id, deleted_at)
      values (${sqlString(conversationId)}, ${sqlString(deletedAt)});
      delete from artifact_version_sources where artifact_id in ${artifacts};
      delete from artifact_bound_sources where artifact_id in ${artifacts};
      delete from artifact_bound_signatures where artifact_id in ${artifacts};
      delete from artifact_version_projection where artifact_id in ${artifacts};
      delete from artifact_revisions where artifact_id in ${artifacts};
      delete from artifact_signatures where artifact_id in ${artifacts};
      delete from artifact_versions where artifact_id in ${artifacts};
      delete from artifact_drafts where artifact_id in ${artifacts};
      delete from artifact_event_outbox where conversation_id = ${sqlString(conversationId)};
      delete from artifact_operations where conversation_id = ${sqlString(conversationId)};
      delete from artifacts where conversation_id = ${sqlString(conversationId)};
    `;
}

export function recordFromRow(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    name: row.name,
    owner: row.owner,
    contributors: parseStringArray(row.contributorsJson),
    requiredSigners: parseStringArray(row.requiredSignersJson),
    labels: parseStringArray(row.labelsJson),
    lifecycle: row.lifecycle === "collecting_drafts" ? "collecting_drafts" : "published",
    allowedDraftAuthors: parseStringArray(row.allowedDraftAuthorsJson),
    requiredDraftAuthors: parseStringArray(row.requiredDraftAuthorsJson),
    audiencePolicyByAuthor: parseAudiencePolicy(row.audiencePolicyJson),
    draftRosterRevision: typeof row.draftRosterRevision === "number"
      ? row.draftRosterRevision
      : Number.parseInt(String(row.draftRosterRevision), 10) || 0,
    headVersion: typeof row.headVersion === "number" ? row.headVersion : Number.parseInt(String(row.headVersion), 10) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? undefined,
    ...(row.originMessageId ? { originMessageId: row.originMessageId } : {})
  };
}

export function draftFromRow(row: ArtifactDraftRow): ArtifactDraftRecord {
  return {
    id: row.id,
    artifactId: row.artifactId,
    author: row.author,
    state: row.state,
    content: row.content,
    readers: parseStringArray(row.readersJson),
    editRevision: typeof row.editRevision === "number" ? row.editRevision : Number.parseInt(String(row.editRevision), 10) || 0,
    supersedesDraftId: row.supersedesDraftId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt ?? undefined
  };
}

export function insertOperationSql(operation: ArtifactOperationRecord): string {
  return `
      insert or ignore into artifact_operations (
        conversation_id, artifact_id, actor, operation_kind, operation_id,
        request_hash, result_json, applied, created_at
      ) values (
        ${sqlString(operation.conversationId)}, ${sqlString(operation.artifactId)}, ${sqlString(operation.actor)},
        ${sqlString(operation.operationKind)}, ${sqlString(operation.operationId)},
        ${sqlString(operation.requestHash)}, ${sqlString(operation.resultJson)}, 0,
        ${sqlString(operation.createdAt)}
      );
    `;
}

export function operationIdentitySql(operation: ArtifactOperationRecord): string {
  return `conversation_id = ${sqlString(operation.conversationId)}
      and actor = ${sqlString(operation.actor)}
      and operation_kind = ${sqlString(operation.operationKind)}
      and operation_id = ${sqlString(operation.operationId)}`;
}

export function operationPendingSql(operation: ArtifactOperationRecord): string {
  return `exists (
      select 1 from artifact_operations
      where ${operationIdentitySql(operation)}
        and request_hash = ${sqlString(operation.requestHash)}
        and result_json = ${sqlString(operation.resultJson)}
        and applied = 0
    )`;
}

export function operationAppliedSql(operation: ArtifactOperationRecord): string {
  return `exists (
      select 1 from artifact_operations
      where ${operationIdentitySql(operation)}
        and request_hash = ${sqlString(operation.requestHash)}
        and result_json = ${sqlString(operation.resultJson)}
        and applied = 1
    )`;
}

export function deletePendingOperationSql(operation: ArtifactOperationRecord): string {
  return `delete from artifact_operations
      where ${operationIdentitySql(operation)}
        and request_hash = ${sqlString(operation.requestHash)}
        and result_json = ${sqlString(operation.resultJson)}
        and applied = 0;`;
}

export function insertEventSql(event: ArtifactEventRecord): string {
  return `
      insert or ignore into artifact_event_outbox (
        id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
      ) values (
        ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
        ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
        ${sqlString(event.createdAt)}, ${sqlString(event.deliveredAt)}
      );
    `;
}
