import type { HubArtifactDraftRow, HubArtifactRecord, HubArtifactRevisionMeta, HubArtifactState } from "../../../shared/hubOps";
import { sqlString } from "./sqlText";
import type { ArtifactDraftRecord, ArtifactRecord } from "./types";

export const REVISION_META_COLUMNS = `artifact_id as artifactId, version_event_id as versionEventId, original_version as originalVersion,
  base_version_event_id as baseVersionEventId, content_hash as contentHash, author, note, created_at as createdAt`;

export interface RevisionMetaRow {
  artifactId: string;
  versionEventId: string;
  originalVersion: number;
  baseVersionEventId: string | null;
  contentHash: string;
  author: string;
  note: string | null;
  createdAt: string;
}

export function revisionMeta(row: RevisionMetaRow): HubArtifactRevisionMeta {
  return {
    artifactId: row.artifactId,
    versionEventId: row.versionEventId,
    originalVersion: Number(row.originalVersion),
    ...(row.baseVersionEventId ? { baseVersionEventId: row.baseVersionEventId } : {}),
    contentHash: row.contentHash,
    author: row.author,
    ...(row.note !== null && row.note !== undefined ? { note: row.note } : {}),
    createdAt: row.createdAt
  };
}

export function hubRecord(record: ArtifactRecord): HubArtifactRecord {
  const { archivedAt, originMessageId, ...rest } = record;
  return { ...rest, ...(archivedAt ? { archivedAt } : {}), ...(originMessageId ? { originMessageId } : {}) };
}

export function hubDraft(draft: ArtifactDraftRecord): HubArtifactDraftRow {
  const { supersedesDraftId, submittedAt, ...rest } = draft;
  return { ...rest, ...(supersedesDraftId ? { supersedesDraftId } : {}), ...(submittedAt ? { submittedAt } : {}) };
}

export function draftInsertSql(draft: HubArtifactDraftRow, artifactId: string, condition?: string): string {
  return `insert into artifact_drafts (id, artifact_id, author, state, content, readers_json, edit_revision, supersedes_draft_id, created_at, updated_at, submitted_at)
    select ${sqlString(draft.id)}, ${sqlString(artifactId)}, ${sqlString(draft.author)}, ${sqlString(draft.state)}, ${sqlString(draft.content)},
      ${sqlString(JSON.stringify(draft.readers))}, ${Math.floor(draft.editRevision)}, ${sqlString(draft.supersedesDraftId)}, ${sqlString(draft.createdAt)},
      ${sqlString(draft.updatedAt)}, ${sqlString(draft.submittedAt)}
    ${condition ? `where ${condition}` : ""};`;
}

/** Why a document as the server sent it cannot be held as it is, or
 *  undefined when it can. */
export function serverStateProblem(state: HubArtifactState): string | undefined {
  const known = new Set(state.revisions.map((revision) => revision.versionEventId));
  if (state.projection.some((row) => !known.has(row.versionEventId)) || state.projection.length !== state.record.headVersion) {
    return `Document ${state.record.id} from the server numbers a revision it does not list.`;
  }
  return undefined;
}

/** Statements that drop documents from this copy (by an id list or a
 *  subquery of ids), without marking their chat deleted. */
export function forgetSql(ids: string): string {
  return `
    delete from artifact_bound_sources where artifact_id in ${ids};
    delete from artifact_bound_signatures where artifact_id in ${ids};
    delete from artifact_version_projection where artifact_id in ${ids};
    delete from artifact_drafts where artifact_id in ${ids};
    delete from artifact_revisions where artifact_id in ${ids};
    delete from artifacts where id in ${ids};
  `;
}
