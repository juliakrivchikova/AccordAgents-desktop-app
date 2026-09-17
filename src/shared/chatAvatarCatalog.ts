import { parseCustomAvatarId } from "./avatarStudio";
import type { ChatProviderKind } from "./types";

// The one description of which avatar a member shows. The desktop renderer,
// the desktop main process and the phone all resolve from this file, so a
// member cannot look like a frog on the phone and a logo on the desktop: the
// phone used to guess from the handle ("codex" -> frog) and never read
// `avatarId` at all. Image URLs stay with each surface (Vite bundles the
// desktop's, the phone build copies `assetFile` next to itself); this file
// holds the rule and the file names, not the URLs.

export type ChatAvatarMediaMode = "glyph" | "photo";

/** The disc a glyph sits on. Photos cover the disc, so only glyphs carry one. */
export type ChatAvatarGlyphKind = "anthropic" | "codex" | "gemini" | "custom" | "generic";

export interface ChatAvatarCatalogEntry {
  id: string;
  kind: ChatProviderKind;
  label: string;
  /** File name under the desktop renderer's assets directory. */
  assetFile: string;
  mediaMode: ChatAvatarMediaMode;
  glyphKind?: ChatAvatarGlyphKind;
  defaultEligible?: boolean;
}

// Order within each provider group is intentional and drives the picker layout
// (chatAvatarCatalogForKind preserves array order): logo first, then people
// (human + the generated human avatars), then animals.
export const CHAT_AVATAR_CATALOG: ChatAvatarCatalogEntry[] = [
  { id: "codex-logo", kind: "codex-cli", label: "Codex logo", assetFile: "codex-cli.svg", mediaMode: "glyph", glyphKind: "codex", defaultEligible: false },
  { id: "codex-human", kind: "codex-cli", label: "Codex human", assetFile: "participant-codex-human.png", mediaMode: "photo" },
  { id: "generated-avatar-01", kind: "codex-cli", label: "Generated avatar 1", assetFile: "participant-generated-01.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-02", kind: "codex-cli", label: "Generated avatar 2", assetFile: "participant-generated-02.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-03", kind: "codex-cli", label: "Generated avatar 3", assetFile: "participant-generated-03.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-04", kind: "codex-cli", label: "Generated avatar 4", assetFile: "participant-generated-04.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-05", kind: "codex-cli", label: "Generated avatar 5", assetFile: "participant-generated-05.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-06", kind: "codex-cli", label: "Generated avatar 6", assetFile: "participant-generated-06.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-07", kind: "codex-cli", label: "Generated avatar 7", assetFile: "participant-generated-07.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-08", kind: "codex-cli", label: "Generated avatar 8", assetFile: "participant-generated-08.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-21", kind: "codex-cli", label: "Generated avatar 21", assetFile: "participant-generated-21.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-22", kind: "codex-cli", label: "Generated avatar 22", assetFile: "participant-generated-22.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-23", kind: "codex-cli", label: "Generated avatar 23", assetFile: "participant-generated-23.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-24", kind: "codex-cli", label: "Generated avatar 24", assetFile: "participant-generated-24.png", mediaMode: "photo", defaultEligible: false },
  { id: "codex-bunny", kind: "codex-cli", label: "Codex bunny", assetFile: "participant-codex-bunny.png", mediaMode: "photo" },
  { id: "codex-cat", kind: "codex-cli", label: "Codex cat", assetFile: "participant-codex-cat.png", mediaMode: "photo" },
  { id: "codex-dog", kind: "codex-cli", label: "Codex dog", assetFile: "participant-codex-dog.png", mediaMode: "photo" },
  { id: "codex-frog", kind: "codex-cli", label: "Codex frog", assetFile: "participant-codex-frog.png", mediaMode: "photo" },
  { id: "codex-hamster", kind: "codex-cli", label: "Codex hamster", assetFile: "participant-codex-hamster.png", mediaMode: "photo" },
  { id: "claude-logo", kind: "claude-code", label: "Claude logo", assetFile: "claude-avatar.png", mediaMode: "glyph", glyphKind: "anthropic", defaultEligible: false },
  { id: "claude-human", kind: "claude-code", label: "Claude human", assetFile: "participant-claude-human.png", mediaMode: "photo" },
  { id: "generated-avatar-09", kind: "claude-code", label: "Generated avatar 9", assetFile: "participant-generated-09.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-10", kind: "claude-code", label: "Generated avatar 10", assetFile: "participant-generated-10.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-11", kind: "claude-code", label: "Generated avatar 11", assetFile: "participant-generated-11.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-12", kind: "claude-code", label: "Generated avatar 12", assetFile: "participant-generated-12.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-13", kind: "claude-code", label: "Generated avatar 13", assetFile: "participant-generated-13.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-14", kind: "claude-code", label: "Generated avatar 14", assetFile: "participant-generated-14.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-15", kind: "claude-code", label: "Generated avatar 15", assetFile: "participant-generated-15.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-16", kind: "claude-code", label: "Generated avatar 16", assetFile: "participant-generated-16.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-17", kind: "claude-code", label: "Generated avatar 17", assetFile: "participant-generated-17.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-18", kind: "claude-code", label: "Generated avatar 18", assetFile: "participant-generated-18.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-19", kind: "claude-code", label: "Generated avatar 19", assetFile: "participant-generated-19.png", mediaMode: "photo", defaultEligible: false },
  { id: "generated-avatar-20", kind: "claude-code", label: "Generated avatar 20", assetFile: "participant-generated-20.png", mediaMode: "photo", defaultEligible: false },
  { id: "claude-bunny", kind: "claude-code", label: "Claude bunny", assetFile: "participant-claude-bunny.png", mediaMode: "photo" },
  { id: "claude-cat", kind: "claude-code", label: "Claude cat", assetFile: "participant-claude-cat.png", mediaMode: "photo" },
  { id: "claude-dog", kind: "claude-code", label: "Claude dog", assetFile: "participant-claude-dog.png", mediaMode: "photo" },
  { id: "claude-frog", kind: "claude-code", label: "Claude frog", assetFile: "participant-claude-frog.png", mediaMode: "photo" },
  { id: "claude-hamster", kind: "claude-code", label: "Claude hamster", assetFile: "participant-claude-hamster.png", mediaMode: "photo" },
  { id: "gemini-logo", kind: "gemini-cli", label: "Gemini logo", assetFile: "gemini-cli.svg", mediaMode: "glyph", glyphKind: "gemini" }
];

/** The file name a surface that copies the catalog next to itself (the phone)
 *  serves an entry under: the catalog id with the source file's extension. */
export function chatAvatarAssetFileName(entry: Pick<ChatAvatarCatalogEntry, "id" | "assetFile">): string {
  const dot = entry.assetFile.lastIndexOf(".");
  return `${entry.id}${dot >= 0 ? entry.assetFile.slice(dot) : ""}`;
}

export function chatAvatarCatalogForKind(kind: ChatProviderKind): ChatAvatarCatalogEntry[] {
  return CHAT_AVATAR_CATALOG.filter((entry) => entry.kind === kind);
}

export function chatAvatarCatalogEntry(avatarId: string | undefined): ChatAvatarCatalogEntry | undefined {
  return CHAT_AVATAR_CATALOG.find((entry) => entry.id === avatarId);
}

export function isChatAvatarIdForKind(avatarId: string | undefined, kind: ChatProviderKind): boolean {
  // A drawn avatar belongs to the member, not to a provider: it stays valid for
  // every kind, and switching provider must not replace it with a preset.
  if (parseCustomAvatarId(avatarId)) {
    return true;
  }
  return chatAvatarCatalogEntry(avatarId)?.kind === kind;
}

export function defaultChatAvatarId(kind: ChatProviderKind, seed = ""): string {
  const options = chatAvatarCatalogForKind(kind).filter((entry) => entry.defaultEligible !== false);
  const fallback = kind === "claude-code" ? "claude-human" : kind === "gemini-cli" ? "gemini-logo" : "codex-human";
  if (options.length === 0) {
    return fallback;
  }
  const normalizedSeed = seed.trim().toLowerCase();
  const index = normalizedSeed ? stableHash(normalizedSeed) % options.length : 0;
  return options[index]?.id ?? fallback;
}

export function normalizedChatAvatarId(kind: ChatProviderKind, avatarId: string | undefined, seed = ""): string {
  // A generated avatar is not tied to a provider, so it survives a provider change.
  if (parseCustomAvatarId(avatarId)) {
    return avatarId as string;
  }
  const entry = chatAvatarCatalogEntry(avatarId);
  if (entry?.kind === kind) {
    return entry.id;
  }
  return defaultChatAvatarId(kind, seed);
}

// Character suffix shared across providers, e.g. "codex-cat" / "claude-cat" -> "cat".
function chatAvatarCharacter(id: string): string {
  return id.slice(id.indexOf("-") + 1);
}

// Map an avatar to the equivalent character on a different provider so switching
// provider keeps logo->logo and cat->cat instead of falling back to a hashed default.
export function mapChatAvatarIdToKind(kind: ChatProviderKind, avatarId: string | undefined, seed = ""): string {
  if (parseCustomAvatarId(avatarId)) {
    return avatarId as string;
  }
  const entry = chatAvatarCatalogEntry(avatarId);
  if (entry?.kind === kind) {
    return entry.id;
  }
  if (entry) {
    const character = chatAvatarCharacter(entry.id);
    const match = chatAvatarCatalogForKind(kind).find((candidate) => chatAvatarCharacter(candidate.id) === character);
    if (match) {
      return match.id;
    }
  }
  return defaultChatAvatarId(kind, seed);
}

/** What a surface draws for one member, with no file paths in it: `assetId`
 *  names a catalog entry the surface has the picture for, `customAvatarId`
 *  names a drawn avatar whose bytes it must fetch, and `initials` stand in
 *  when there is no picture at all. */
export interface ResolvedChatAvatar {
  glyphKind: ChatAvatarGlyphKind;
  label: string;
  mediaMode: ChatAvatarMediaMode;
  assetId?: string;
  customAvatarId?: string;
  initials?: string;
}

export const CHAT_ASSISTANT_AVATAR_ASSET_ID = "accordagents-mark";

export function resolveChatParticipantAvatar(
  participant: { id?: string; handle: string; kind: ChatProviderKind; avatarId?: string },
  label: string,
  options: { isAssistant?: boolean } = {}
): ResolvedChatAvatar {
  if (options.isAssistant) {
    return { glyphKind: "custom", label, mediaMode: "glyph", assetId: CHAT_ASSISTANT_AVATAR_ASSET_ID };
  }
  const customId = parseCustomAvatarId(participant.avatarId);
  if (customId) {
    return { glyphKind: "custom", label, mediaMode: "photo", customAvatarId: customId, initials: chatAvatarInitials(label) };
  }
  const avatarId = normalizedChatAvatarId(participant.kind, participant.avatarId, participant.id || participant.handle);
  const entry = chatAvatarCatalogEntry(avatarId);
  if (!entry) {
    return { glyphKind: "generic", label, mediaMode: "glyph", initials: chatAvatarInitials(label) };
  }
  return { glyphKind: entry.glyphKind ?? "custom", label, mediaMode: entry.mediaMode, assetId: entry.id };
}

/** A member the surface has no record for: the provider glyph its name
 *  suggests, or initials. Same rule the desktop applies to an unknown author. */
export function resolveChatAvatarByName(label: string, participantId?: string): ResolvedChatAvatar {
  const text = `${participantId ?? ""} ${label}`.toLowerCase();
  if (text.includes("claude") || text.includes("anthropic")) {
    return { glyphKind: "anthropic", label, mediaMode: "glyph", assetId: "claude-logo" };
  }
  if (text.includes("codex") || text.includes("openai")) {
    return { glyphKind: "codex", label, mediaMode: "glyph", assetId: "codex-logo" };
  }
  if (text.includes("gemini")) {
    return { glyphKind: "gemini", label, mediaMode: "glyph", assetId: "gemini-logo" };
  }
  return { glyphKind: "generic", label, mediaMode: "glyph", initials: chatAvatarInitials(label) };
}

export function chatAvatarInitials(label: string): string {
  return label
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
