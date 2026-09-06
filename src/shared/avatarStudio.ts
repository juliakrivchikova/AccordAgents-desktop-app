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
  /** Identifies the studio window; a session per (window, provider). */
  studioId: string;
  prompt: string;
  runner: AvatarStudioRunner;
  member: { handle: string; roleLabel?: string };
  /** The picture on screen, so a fresh session can start from it. */
  baseCandidate?: { mediaType: AvatarImageMediaType; dataUrl: string };
}

export interface AvatarStudioTurnResult {
  ok: boolean;
  candidate?: AvatarStudioCandidate;
  /** The runner's own one-line answer, shown in the studio chat. */
  reply?: string;
  error?: string;
}

/** Metadata only: the bytes live in a file and are fetched on demand. */
export interface CustomAvatarSummary {
  id: string;
  mediaType: AvatarImageMediaType;
  label: string;
  createdAt: string;
}

export interface SaveCustomAvatarRequest {
  mediaType: AvatarImageMediaType;
  dataBase64: string;
  label: string;
}

export interface ReadCustomAvatarResult {
  id: string;
  mediaType: AvatarImageMediaType;
  dataBase64: string;
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

export function avatarImageExtension(mediaType: AvatarImageMediaType): "svg" | "png" {
  return mediaType === "image/png" ? "png" : "svg";
}

export function avatarImageDataUrl(mediaType: AvatarImageMediaType, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

/**
 * Whether the picture on screen has to travel with the next request. A session
 * that already drew it knows it; a different provider, model or effort starts a
 * fresh session and needs it as the starting point. Re-sending it every turn
 * would push megabytes over IPC for nothing.
 */
export function avatarStudioNeedsSeed(
  candidate: Pick<AvatarStudioCandidate, "drawnBy"> | undefined,
  runner: AvatarStudioRunner
): boolean {
  if (!candidate) {
    return false;
  }
  return candidate.drawnBy.kind !== runner.kind
    || (candidate.drawnBy.model ?? "") !== (runner.model ?? "")
    || (candidate.drawnBy.reasoningEffort ?? "") !== (runner.reasoningEffort ?? "");
}
