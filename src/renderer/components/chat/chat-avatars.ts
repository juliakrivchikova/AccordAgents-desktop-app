import {
  CHAT_AVATAR_CATALOG,
  defaultChatAvatarId as sharedDefaultChatAvatarId,
  isChatAvatarIdForKind as sharedIsChatAvatarIdForKind,
  mapChatAvatarIdToKind as sharedMapChatAvatarIdToKind,
  normalizedChatAvatarId as sharedNormalizedChatAvatarId,
  resolveChatParticipantAvatar,
  type ChatAvatarCatalogEntry
} from "../../../shared/chatAvatarCatalog";
import type { ChatParticipant, ChatProviderKind } from "../../../shared/types";
import { customAvatarUrl } from "../avatar/custom-avatars";
import { CHAT_ASSISTANT_DISPLAY_NAME, chatParticipantDisplayName } from "../conversation/conversation-display";

const CHAT_AVATAR_URLS = {
  "accordagents-mark": new URL("../../assets/accordagents-mark.png", import.meta.url).href,
  "codex-logo": new URL("../../assets/codex-cli.svg", import.meta.url).href,
  "codex-human": new URL("../../assets/participant-codex-human.png", import.meta.url).href,
  "codex-bunny": new URL("../../assets/participant-codex-bunny.png", import.meta.url).href,
  "codex-cat": new URL("../../assets/participant-codex-cat.png", import.meta.url).href,
  "codex-dog": new URL("../../assets/participant-codex-dog.png", import.meta.url).href,
  "codex-frog": new URL("../../assets/participant-codex-frog.png", import.meta.url).href,
  "codex-hamster": new URL("../../assets/participant-codex-hamster.png", import.meta.url).href,
  "claude-logo": new URL("../../assets/claude-avatar.png", import.meta.url).href,
  "gemini-logo": new URL("../../assets/gemini-cli.svg", import.meta.url).href,
  "claude-human": new URL("../../assets/participant-claude-human.png", import.meta.url).href,
  "claude-bunny": new URL("../../assets/participant-claude-bunny.png", import.meta.url).href,
  "claude-cat": new URL("../../assets/participant-claude-cat.png", import.meta.url).href,
  "claude-dog": new URL("../../assets/participant-claude-dog.png", import.meta.url).href,
  "claude-frog": new URL("../../assets/participant-claude-frog.png", import.meta.url).href,
  "claude-hamster": new URL("../../assets/participant-claude-hamster.png", import.meta.url).href,
  "generated-avatar-01": new URL("../../assets/participant-generated-01.png", import.meta.url).href,
  "generated-avatar-02": new URL("../../assets/participant-generated-02.png", import.meta.url).href,
  "generated-avatar-03": new URL("../../assets/participant-generated-03.png", import.meta.url).href,
  "generated-avatar-04": new URL("../../assets/participant-generated-04.png", import.meta.url).href,
  "generated-avatar-05": new URL("../../assets/participant-generated-05.png", import.meta.url).href,
  "generated-avatar-06": new URL("../../assets/participant-generated-06.png", import.meta.url).href,
  "generated-avatar-07": new URL("../../assets/participant-generated-07.png", import.meta.url).href,
  "generated-avatar-08": new URL("../../assets/participant-generated-08.png", import.meta.url).href,
  "generated-avatar-09": new URL("../../assets/participant-generated-09.png", import.meta.url).href,
  "generated-avatar-10": new URL("../../assets/participant-generated-10.png", import.meta.url).href,
  "generated-avatar-11": new URL("../../assets/participant-generated-11.png", import.meta.url).href,
  "generated-avatar-12": new URL("../../assets/participant-generated-12.png", import.meta.url).href,
  "generated-avatar-13": new URL("../../assets/participant-generated-13.png", import.meta.url).href,
  "generated-avatar-14": new URL("../../assets/participant-generated-14.png", import.meta.url).href,
  "generated-avatar-15": new URL("../../assets/participant-generated-15.png", import.meta.url).href,
  "generated-avatar-16": new URL("../../assets/participant-generated-16.png", import.meta.url).href,
  "generated-avatar-17": new URL("../../assets/participant-generated-17.png", import.meta.url).href,
  "generated-avatar-18": new URL("../../assets/participant-generated-18.png", import.meta.url).href,
  "generated-avatar-19": new URL("../../assets/participant-generated-19.png", import.meta.url).href,
  "generated-avatar-20": new URL("../../assets/participant-generated-20.png", import.meta.url).href,
  "generated-avatar-21": new URL("../../assets/participant-generated-21.png", import.meta.url).href,
  "generated-avatar-22": new URL("../../assets/participant-generated-22.png", import.meta.url).href,
  "generated-avatar-23": new URL("../../assets/participant-generated-23.png", import.meta.url).href,
  "generated-avatar-24": new URL("../../assets/participant-generated-24.png", import.meta.url).href
} as const;

export type AvatarKind = "user" | "arbiter" | "anthropic" | "codex" | "gemini" | "generic" | "custom";
export type AvatarMediaMode = "glyph" | "photo";
export type ChatAvatarId = keyof typeof CHAT_AVATAR_URLS;

export interface AvatarSpec {
  kind: AvatarKind;
  label: string;
  initials?: string;
  imageUrl?: string;
  mediaMode?: AvatarMediaMode;
}

export interface ChatAvatarOption {
  id: ChatAvatarId;
  kind: ChatProviderKind;
  label: string;
  imageUrl: string;
  avatarKind?: AvatarKind;
  mediaMode: AvatarMediaMode;
  defaultEligible?: boolean;
}

// The rule (ids, provider, glyph/photo, default eligibility, picker order) is
// shared with the main process and the phone in chatAvatarCatalog.ts; only the
// bundled image URLs are this surface's own.
function chatAvatarOptionFromCatalog(entry: ChatAvatarCatalogEntry): ChatAvatarOption {
  return {
    id: entry.id as ChatAvatarId,
    kind: entry.kind,
    label: entry.label,
    imageUrl: CHAT_AVATAR_URLS[entry.id as ChatAvatarId],
    ...(entry.glyphKind && entry.glyphKind !== "custom" && entry.glyphKind !== "generic" ? { avatarKind: entry.glyphKind } : {}),
    mediaMode: entry.mediaMode,
    ...(entry.defaultEligible === false ? { defaultEligible: false } : {})
  };
}

const CHAT_AVATAR_OPTIONS: ChatAvatarOption[] = CHAT_AVATAR_CATALOG.map(chatAvatarOptionFromCatalog);

export function chatAvatarOptionsForKind(kind: ChatProviderKind): ChatAvatarOption[] {
  return CHAT_AVATAR_OPTIONS.filter((option) => option.kind === kind);
}

export function chatAvatarOption(avatarId: string | undefined): ChatAvatarOption | undefined {
  return CHAT_AVATAR_OPTIONS.find((option) => option.id === avatarId);
}

export function isChatAvatarIdForKind(avatarId: string | undefined, kind: ChatProviderKind): boolean {
  return sharedIsChatAvatarIdForKind(avatarId, kind);
}

export function defaultChatAvatarId(kind: ChatProviderKind, seed = ""): ChatAvatarId {
  return sharedDefaultChatAvatarId(kind, seed) as ChatAvatarId;
}

export function normalizedChatAvatarId(kind: ChatProviderKind, avatarId: string | undefined, seed = ""): string {
  return sharedNormalizedChatAvatarId(kind, avatarId, seed);
}

export function mapChatAvatarIdToKind(kind: ChatProviderKind, avatarId: string | undefined, seed = ""): string {
  return sharedMapChatAvatarIdToKind(kind, avatarId, seed);
}

export function avatarForChatAvatarOption(option: ChatAvatarOption, label = option.label): AvatarSpec {
  return { kind: option.avatarKind ?? "custom", label, imageUrl: option.imageUrl, mediaMode: option.mediaMode };
}

export function avatarForChatParticipant(
  participant: Pick<ChatParticipant, "id" | "handle" | "kind" | "avatarId">,
  label = chatParticipantDisplayName(participant)
): AvatarSpec {
  const resolved = resolveChatParticipantAvatar(participant, label, { isAssistant: label === CHAT_ASSISTANT_DISPLAY_NAME });
  if (resolved.customAvatarId) {
    const imageUrl = customAvatarUrl(resolved.customAvatarId);
    // The bytes load asynchronously; initials stand in rather than a broken image.
    return imageUrl
      ? { kind: "custom", label, imageUrl, mediaMode: "photo" }
      : { kind: "generic", label, initials: resolved.initials, mediaMode: "glyph" };
  }
  if (resolved.assetId) {
    return { kind: resolved.glyphKind, label, imageUrl: CHAT_AVATAR_URLS[resolved.assetId as ChatAvatarId], mediaMode: resolved.mediaMode };
  }
  return { kind: "generic", label, initials: resolved.initials, mediaMode: "glyph" };
}
