import type { ArtifactDraftRecord, ArtifactEventRecord, ArtifactRecord, ArtifactVersionSourceRecord } from "./types";

export interface ArtifactRow {
  id: string;
  conversationId: string;
  name: string;
  owner: string;
  contributorsJson: string;
  requiredSignersJson: string;
  labelsJson: string;
  lifecycle: "collecting_drafts" | "published";
  allowedDraftAuthorsJson: string;
  requiredDraftAuthorsJson: string;
  audiencePolicyJson: string;
  draftRosterRevision: number;
  headVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  originMessageId: string | null;
}

export interface ArtifactDraftRow {
  id: string;
  artifactId: string;
  author: string;
  state: ArtifactDraftRecord["state"];
  content: string;
  readersJson: string;
  editRevision: number;
  supersedesDraftId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

export interface ArtifactVersionSourceRow extends Omit<ArtifactVersionSourceRecord, "exclusionRationale"> {
  exclusionRationale: string | null;
}

export interface ArtifactEventRow extends Omit<ArtifactEventRecord, "deliveredAt"> {
  deliveredAt: string | null;
}

export function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function parseAudiencePolicy(json: string): ArtifactRecord["audiencePolicyByAuthor"] {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: ArtifactRecord["audiencePolicyByAuthor"] = {};
    for (const [author, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const policy = value as Record<string, unknown>;
      result[author] = {
        allowedReaders: Array.isArray(policy.allowedReaders)
          ? policy.allowedReaders.filter((entry): entry is string => typeof entry === "string")
          : [],
        requiredReaders: Array.isArray(policy.requiredReaders)
          ? policy.requiredReaders.filter((entry): entry is string => typeof entry === "string")
          : []
      };
    }
    return result;
  } catch {
    return {};
  }
}

export const ARTIFACT_SELECT = `
  select
    id,
    conversation_id as conversationId,
    name,
    owner,
    contributors_json as contributorsJson,
    required_signers_json as requiredSignersJson,
    labels_json as labelsJson,
    lifecycle,
    allowed_draft_authors_json as allowedDraftAuthorsJson,
    required_draft_authors_json as requiredDraftAuthorsJson,
    audience_policy_json as audiencePolicyJson,
    draft_roster_revision as draftRosterRevision,
    head_version as headVersion,
    created_at as createdAt,
    updated_at as updatedAt,
    archived_at as archivedAt,
    origin_message_id as originMessageId
  from artifacts
`;

export const DRAFT_SELECT = `
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
`;
