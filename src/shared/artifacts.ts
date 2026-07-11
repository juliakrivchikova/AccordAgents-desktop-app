import { ARTIFACT_USER_MEMBER } from "./types";
import type { ArtifactApproval, ArtifactSignature, ChatParticipant, Conversation } from "./types";

// metadata.appMessageSource marker for the brief system notes artifacts post
// into the chat timeline. These notes stay visible (system messages are
// otherwise hidden from the timeline).
export const ARTIFACT_NOTE_MESSAGE_SOURCE = "app_artifact_note";

export const ARTIFACT_NAME_MAX_LENGTH = 120;
export const ARTIFACT_CONTENT_MAX_BYTES = 512 * 1024;
export const ARTIFACT_NOTE_MAX_LENGTH = 300;
export const ARTIFACT_LABEL_MAX_LENGTH = 40;
export const ARTIFACT_MAX_LABELS = 12;

// Member identity inside the artifact system: "user" for the human chat owner,
// or a chat participant's normalized handle (lowercase, no leading @).
export function normalizeArtifactMember(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().replace(/^@/, "").toLowerCase();
}

export function normalizeArtifactMemberList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const members = raw.map((value) => normalizeArtifactMember(value)).filter((value) => value.length > 0);
  return [...new Set(members)];
}

export function artifactMemberLabel(member: string): string {
  return member === ARTIFACT_USER_MEMBER ? "User" : `@${member}`;
}

// Current member set of a chat conversation: the human user plus every
// participant handle. Artifact ACLs are validated against this set.
export function artifactMembersForConversation(conversation: Pick<Conversation, "metadata">): string[] {
  const rawParticipants = conversation.metadata?.participants;
  const participants = Array.isArray(rawParticipants) ? rawParticipants as ChatParticipant[] : [];
  const handles = participants
    .map((participant) => normalizeArtifactMember(participant?.handle))
    .filter((handle) => handle.length > 0);
  return [...new Set([ARTIFACT_USER_MEMBER, ...handles])];
}

export function normalizeArtifactName(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.replace(/\s+/g, " ").trim();
}

// Case-insensitive uniqueness key for names within one chat.
export function artifactNameKey(name: string): string {
  return normalizeArtifactName(name).toLowerCase();
}

// Chat reference token. References always carry the stable artifact id; the
// label is a convenience snapshot and the renderer substitutes the current
// name at display time, so renames never break or redirect references.
export function artifactReference(artifactId: string, label: string): string {
  const safeLabel = label.replace(/[\[\]\n\r]/g, " ").replace(/\s+/g, " ").trim() || "artifact";
  return `[${safeLabel}](#artifact:${artifactId})`;
}

export function computeArtifactApproval(
  requiredSigners: string[],
  headSignatures: ArtifactSignature[]
): ArtifactApproval {
  const required = [...requiredSigners];
  const signedSet = new Set(headSignatures.map((signature) => signature.signer));
  const signedCurrent = required.filter((signer) => signedSet.has(signer));
  let state: ArtifactApproval["state"];
  if (required.length === 0) {
    state = "none-required";
  } else if (signedCurrent.length === 0) {
    state = "unsigned";
  } else if (signedCurrent.length < required.length) {
    state = "partially-signed";
  } else {
    state = "approved";
  }
  return { state, requiredSigners: required, signedCurrent };
}

export function artifactApprovalShortLabel(approval: ArtifactApproval): string {
  if (approval.state === "none-required") {
    return "no signers required";
  }
  if (approval.state === "approved") {
    return "fully approved";
  }
  return `${approval.signedCurrent.length}/${approval.requiredSigners.length} signed`;
}
