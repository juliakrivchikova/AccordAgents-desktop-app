import { createHash } from "node:crypto";
import type { ArtifactDraftAudiencePolicyByAuthor } from "../../../shared/types";
import {
  ARTIFACT_CONTENT_MAX_BYTES, ARTIFACT_LABEL_MAX_LENGTH, ARTIFACT_MAX_LABELS, ARTIFACT_NAME_MAX_LENGTH, ARTIFACT_NOTE_MAX_LENGTH,
  normalizeArtifactMember, normalizeArtifactMemberList
} from "../../../shared/artifacts";

export function isVersionNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.floor(value) >= 1;
}

export function validateName(name: string): string | undefined {
  if (!name) {
    return "Artifact name is required.";
  }
  if (name.length > ARTIFACT_NAME_MAX_LENGTH) {
    return `Artifact name must be at most ${ARTIFACT_NAME_MAX_LENGTH} characters.`;
  }
  return undefined;
}

export function validateContent(content: unknown): string | undefined {
  if (typeof content !== "string" || content.length === 0) {
    return "Artifact content must be a non-empty string.";
  }
  if (Buffer.byteLength(content, "utf8") > ARTIFACT_CONTENT_MAX_BYTES) {
    return `Artifact content is limited to ${Math.floor(ARTIFACT_CONTENT_MAX_BYTES / 1024)} KB per version.`;
  }
  return undefined;
}

export function validateMemberSets(members: string[], contributors: string[], requiredSigners: string[]): string | undefined {
  const memberSet = new Set(members);
  const unknown = [...new Set([...contributors, ...requiredSigners])].filter((member) => !memberSet.has(member));
  if (unknown.length > 0) {
    return `Not current chat members: ${unknown.join(", ")}. Members are "user" and chat member handles.`;
  }
  return undefined;
}

export function normalizeLabels(raw: string[] | undefined): string[] | string {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return "labels must be an array of short strings.";
  }
  const labels = [...new Set(raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0))];
  if (labels.some((label) => label.length > ARTIFACT_LABEL_MAX_LENGTH)) {
    return `Each label must be at most ${ARTIFACT_LABEL_MAX_LENGTH} characters.`;
  }
  if (labels.length > ARTIFACT_MAX_LABELS) {
    return `At most ${ARTIFACT_MAX_LABELS} labels are allowed.`;
  }
  return labels;
}

/** A message id the app passed with a collection, when it is one. */
export function isOriginMessageId(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 256 && !/\s/.test(raw);
}

export function normalizeNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const note = raw.replace(/\s+/g, " ").trim();
  if (!note) {
    return undefined;
  }
  return note.length > ARTIFACT_NOTE_MAX_LENGTH ? `${note.slice(0, ARTIFACT_NOTE_MAX_LENGTH - 1)}…` : note;
}

export function validateOperationId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return "operationId is required.";
  }
  if (value.length > 240) {
    return "operationId must be at most 240 characters.";
  }
  return undefined;
}

export function normalizeDraftRoster(
  members: string[],
  allowedRaw: string[],
  requiredRaw: string[],
  policyRaw: ArtifactDraftAudiencePolicyByAuthor
): {
  allowedDraftAuthors: string[];
  requiredDraftAuthors: string[];
  audiencePolicyByAuthor: ArtifactDraftAudiencePolicyByAuthor;
} | string {
  if (!Array.isArray(allowedRaw) || !Array.isArray(requiredRaw) || !policyRaw || typeof policyRaw !== "object") {
    return "allowedDraftAuthors, requiredDraftAuthors, and audiencePolicyByAuthor are required.";
  }
  const allowedDraftAuthors = normalizeArtifactMemberList(allowedRaw);
  const requiredDraftAuthors = normalizeArtifactMemberList(requiredRaw);
  if (allowedDraftAuthors.length !== allowedRaw.length || requiredDraftAuthors.length !== requiredRaw.length) {
    return "Draft author lists must contain unique, valid chat member handles.";
  }
  if (allowedDraftAuthors.length === 0 || requiredDraftAuthors.length === 0) {
    return "At least one allowed and required draft author is needed.";
  }
  const memberSet = new Set(members);
  const unknownAuthors = allowedDraftAuthors.filter((author) => !memberSet.has(author));
  if (unknownAuthors.length > 0) {
    return `Not current chat members: ${unknownAuthors.join(", ")}.`;
  }
  const allowedSet = new Set(allowedDraftAuthors);
  const outside = requiredDraftAuthors.filter((author) => !allowedSet.has(author));
  if (outside.length > 0) {
    return `Required draft authors must also be allowed: ${outside.join(", ")}.`;
  }
  const rawKeys = Object.keys(policyRaw).map(normalizeArtifactMember).filter((value): value is string => Boolean(value));
  if (rawKeys.length !== allowedDraftAuthors.length || rawKeys.some((key) => !allowedSet.has(key))) {
    return "Audience policy keys must exactly match allowed draft authors.";
  }
  const audiencePolicyByAuthor: ArtifactDraftAudiencePolicyByAuthor = {};
  for (const author of allowedDraftAuthors) {
    const rawPolicy = policyRaw[author] ?? policyRaw[`@${author}`];
    if (!rawPolicy || !Array.isArray(rawPolicy.allowedReaders) || !Array.isArray(rawPolicy.requiredReaders)) {
      return `Audience policy is required for ${author}.`;
    }
    const allowedReaders = normalizeArtifactMemberList(rawPolicy.allowedReaders)
      .filter((reader) => reader !== "user" && reader !== author);
    const requiredReaders = normalizeArtifactMemberList(rawPolicy.requiredReaders)
      .filter((reader) => reader !== "user" && reader !== author);
    const unknownReaders = [...new Set([...allowedReaders, ...requiredReaders])].filter((reader) => !memberSet.has(reader));
    if (unknownReaders.length > 0) {
      return `Audience policy for ${author} names non-members: ${unknownReaders.join(", ")}.`;
    }
    const readerSet = new Set(allowedReaders);
    const missingAllowed = requiredReaders.filter((reader) => !readerSet.has(reader));
    if (missingAllowed.length > 0) {
      return `Required readers for ${author} must also be allowed: ${missingAllowed.join(", ")}.`;
    }
    audiencePolicyByAuthor[author] = { allowedReaders, requiredReaders };
  }
  return { allowedDraftAuthors, requiredDraftAuthors, audiencePolicyByAuthor };
}

export function normalizeDraftReaders(
  members: string[],
  author: string,
  readersRaw: string[],
  policy: { allowedReaders: string[]; requiredReaders: string[] } | undefined
): string[] | string {
  if (!policy) {
    return `No audience policy exists for ${author}.`;
  }
  if (!Array.isArray(readersRaw)) {
    return "readers must be an array of chat member handles.";
  }
  const readers = normalizeArtifactMemberList(readersRaw)
    .filter((reader) => reader !== "user" && reader !== author);
  const memberSet = new Set(members);
  const unknown = readers.filter((reader) => !memberSet.has(reader));
  if (unknown.length > 0) {
    return `Draft readers are not current chat members: ${unknown.join(", ")}.`;
  }
  const allowed = new Set(policy.allowedReaders);
  const forbidden = readers.filter((reader) => !allowed.has(reader));
  if (forbidden.length > 0) {
    return `Draft readers are forbidden by the artifact audience policy: ${forbidden.join(", ")}.`;
  }
  const readerSet = new Set(readers);
  const missing = policy.requiredReaders.filter((reader) => !readerSet.has(reader));
  if (missing.length > 0) {
    return `Draft readers must include: ${missing.join(", ")}.`;
  }
  return readers;
}

export function hashRequest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
