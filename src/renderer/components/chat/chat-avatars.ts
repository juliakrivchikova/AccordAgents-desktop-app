import type { ChatParticipant, ChatProviderKind } from "../../../shared/types";

const CHAT_AVATAR_URLS = {
  "codex-logo": new URL("../../assets/codex-cli.svg", import.meta.url).href,
  "codex-human": new URL("../../assets/participant-codex-human.png", import.meta.url).href,
  "codex-bunny": new URL("../../assets/participant-codex-bunny.png", import.meta.url).href,
  "codex-cat": new URL("../../assets/participant-codex-cat.png", import.meta.url).href,
  "codex-dog": new URL("../../assets/participant-codex-dog.png", import.meta.url).href,
  "codex-frog": new URL("../../assets/participant-codex-frog.png", import.meta.url).href,
  "codex-hamster": new URL("../../assets/participant-codex-hamster.png", import.meta.url).href,
  "claude-logo": new URL("../../assets/claude-avatar.webp", import.meta.url).href,
  "claude-human": new URL("../../assets/participant-claude-human.png", import.meta.url).href,
  "claude-bunny": new URL("../../assets/participant-claude-bunny.png", import.meta.url).href,
  "claude-cat": new URL("../../assets/participant-claude-cat.png", import.meta.url).href,
  "claude-dog": new URL("../../assets/participant-claude-dog.png", import.meta.url).href,
  "claude-frog": new URL("../../assets/participant-claude-frog.png", import.meta.url).href,
  "claude-hamster": new URL("../../assets/participant-claude-hamster.png", import.meta.url).href
} as const;

export type AvatarKind = "user" | "arbiter" | "anthropic" | "codex" | "gemini" | "generic" | "custom";
export type ChatAvatarId = keyof typeof CHAT_AVATAR_URLS;

export interface AvatarSpec {
  kind: AvatarKind;
  label: string;
  initials?: string;
  imageUrl?: string;
}

export interface ChatAvatarOption {
  id: ChatAvatarId;
  kind: ChatProviderKind;
  label: string;
  imageUrl: string;
  avatarKind?: AvatarKind;
  defaultEligible?: boolean;
}

const CHAT_AVATAR_OPTIONS: ChatAvatarOption[] = [
  { id: "codex-logo", kind: "codex-cli", label: "Codex logo", imageUrl: CHAT_AVATAR_URLS["codex-logo"], avatarKind: "codex", defaultEligible: false },
  { id: "codex-human", kind: "codex-cli", label: "Codex human", imageUrl: CHAT_AVATAR_URLS["codex-human"] },
  { id: "codex-bunny", kind: "codex-cli", label: "Codex bunny", imageUrl: CHAT_AVATAR_URLS["codex-bunny"] },
  { id: "codex-cat", kind: "codex-cli", label: "Codex cat", imageUrl: CHAT_AVATAR_URLS["codex-cat"] },
  { id: "codex-dog", kind: "codex-cli", label: "Codex dog", imageUrl: CHAT_AVATAR_URLS["codex-dog"] },
  { id: "codex-frog", kind: "codex-cli", label: "Codex frog", imageUrl: CHAT_AVATAR_URLS["codex-frog"] },
  { id: "codex-hamster", kind: "codex-cli", label: "Codex hamster", imageUrl: CHAT_AVATAR_URLS["codex-hamster"] },
  { id: "claude-logo", kind: "claude-code", label: "Claude logo", imageUrl: CHAT_AVATAR_URLS["claude-logo"], avatarKind: "anthropic", defaultEligible: false },
  { id: "claude-human", kind: "claude-code", label: "Claude human", imageUrl: CHAT_AVATAR_URLS["claude-human"] },
  { id: "claude-bunny", kind: "claude-code", label: "Claude bunny", imageUrl: CHAT_AVATAR_URLS["claude-bunny"] },
  { id: "claude-cat", kind: "claude-code", label: "Claude cat", imageUrl: CHAT_AVATAR_URLS["claude-cat"] },
  { id: "claude-dog", kind: "claude-code", label: "Claude dog", imageUrl: CHAT_AVATAR_URLS["claude-dog"] },
  { id: "claude-frog", kind: "claude-code", label: "Claude frog", imageUrl: CHAT_AVATAR_URLS["claude-frog"] },
  { id: "claude-hamster", kind: "claude-code", label: "Claude hamster", imageUrl: CHAT_AVATAR_URLS["claude-hamster"] }
];

export function chatAvatarOptionsForKind(kind: ChatProviderKind): ChatAvatarOption[] {
  return CHAT_AVATAR_OPTIONS.filter((option) => option.kind === kind);
}

export function chatAvatarOption(avatarId: string | undefined): ChatAvatarOption | undefined {
  return CHAT_AVATAR_OPTIONS.find((option) => option.id === avatarId);
}

export function isChatAvatarIdForKind(avatarId: string | undefined, kind: ChatProviderKind): boolean {
  return chatAvatarOption(avatarId)?.kind === kind;
}

export function defaultChatAvatarId(kind: ChatProviderKind, seed = ""): ChatAvatarId {
  const options = chatAvatarOptionsForKind(kind).filter((option) => option.defaultEligible !== false);
  const fallback = kind === "claude-code" ? "claude-human" : "codex-human";
  if (options.length === 0) {
    return fallback;
  }
  const normalizedSeed = seed.trim().toLowerCase();
  const index = normalizedSeed ? stableHash(normalizedSeed) % options.length : 0;
  return options[index]?.id ?? fallback;
}

export function normalizedChatAvatarId(kind: ChatProviderKind, avatarId: string | undefined, seed = ""): ChatAvatarId {
  const option = chatAvatarOption(avatarId);
  if (option?.kind === kind) {
    return option.id;
  }
  return defaultChatAvatarId(kind, seed);
}

export function avatarForChatAvatarOption(option: ChatAvatarOption, label = option.label): AvatarSpec {
  return { kind: option.avatarKind ?? "custom", label, imageUrl: option.imageUrl };
}

export function avatarForChatParticipant(
  participant: Pick<ChatParticipant, "id" | "handle" | "kind" | "avatarId">,
  label = `@${participant.handle}`
): AvatarSpec {
  const avatarId = normalizedChatAvatarId(participant.kind, participant.avatarId, participant.id || participant.handle);
  const option = chatAvatarOption(avatarId);
  return option ? avatarForChatAvatarOption(option, label) : { kind: "generic", label, initials: initials(label) };
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function initials(label: string): string {
  return label
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}
