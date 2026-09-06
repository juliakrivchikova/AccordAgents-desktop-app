import type { ChatProviderKind, ChatReasoningEffort } from "./types";

// Providers that can actually produce a picture: Codex through its own image
// tool, Claude by writing SVG. Antigravity has neither in our run mode, so it is
// deliberately absent instead of failing at the end of a run.
export const AVATAR_STUDIO_PROVIDER_KINDS = ["codex-cli", "claude-code"] as const;

export type AvatarStudioProviderKind = (typeof AVATAR_STUDIO_PROVIDER_KINDS)[number];

export function isAvatarStudioProviderKind(kind: ChatProviderKind | undefined): kind is AvatarStudioProviderKind {
  return kind === "codex-cli" || kind === "claude-code";
}

export type AvatarImageMediaType = "image/svg+xml" | "image/png";

export interface AvatarStudioRunner {
  kind: AvatarStudioProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
}

export interface AvatarStudioCandidate {
  id: string;
  mediaType: AvatarImageMediaType;
  /** Inline image the renderer can show directly, without file access. */
  dataUrl: string;
  /** Which runner drew it, so the user can go back to a combination that worked. */
  drawnBy: AvatarStudioRunner;
  note?: string;
  createdAt: string;
}

export interface AvatarStudioTurnRequest {
  /** Identifies the studio window; a session per (studio, provider). */
  studioId: string;
  prompt: string;
  runner: AvatarStudioRunner;
  member: { handle: string; roleLabel?: string };
  /** Candidate the user is refining, when the run starts a fresh session. */
  baseCandidateId?: string;
}

export interface AvatarStudioTurnResult {
  ok: boolean;
  candidate?: AvatarStudioCandidate;
  /** The runner's own one-line answer, shown in the studio chat. */
  reply?: string;
  error?: string;
}

export interface SavedAvatarImage {
  id: string;
  mediaType: AvatarImageMediaType;
  dataUrl: string;
  label: string;
  createdAt: string;
}

const CUSTOM_AVATAR_PREFIX = "custom:";

export function customAvatarId(id: string): string {
  return `${CUSTOM_AVATAR_PREFIX}${id}`;
}

export function parseCustomAvatarId(avatarId: string | undefined): string | undefined {
  if (!avatarId || !avatarId.startsWith(CUSTOM_AVATAR_PREFIX)) {
    return undefined;
  }
  const id = avatarId.slice(CUSTOM_AVATAR_PREFIX.length).trim();
  return id.length > 0 ? id : undefined;
}

export function avatarImageMediaType(fileName: string): AvatarImageMediaType | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  return undefined;
}

export function avatarImageDataUrl(mediaType: AvatarImageMediaType, bytes: Buffer | Uint8Array): string {
  const base64 = Buffer.from(bytes).toString("base64");
  return `data:${mediaType};base64,${base64}`;
}
