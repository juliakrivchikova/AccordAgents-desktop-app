import type { ChatParticipant, ChatProviderKind } from "../../../shared/types";
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
  "claude-logo": new URL("../../assets/claude-avatar.webp", import.meta.url).href,
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

// Order within each provider group is intentional and drives the picker layout
// (chatAvatarOptionsForKind preserves array order): logo first, then people
// (human + the generated human avatars), then animals.
const CHAT_AVATAR_OPTIONS: ChatAvatarOption[] = [
  { id: "codex-logo", kind: "codex-cli", label: "Codex logo", imageUrl: CHAT_AVATAR_URLS["codex-logo"], avatarKind: "codex", defaultEligible: false },
  { id: "codex-human", kind: "codex-cli", label: "Codex human", imageUrl: CHAT_AVATAR_URLS["codex-human"] },
  { id: "generated-avatar-01", kind: "codex-cli", label: "Generated avatar 1", imageUrl: CHAT_AVATAR_URLS["generated-avatar-01"], defaultEligible: false },
  { id: "generated-avatar-02", kind: "codex-cli", label: "Generated avatar 2", imageUrl: CHAT_AVATAR_URLS["generated-avatar-02"], defaultEligible: false },
  { id: "generated-avatar-03", kind: "codex-cli", label: "Generated avatar 3", imageUrl: CHAT_AVATAR_URLS["generated-avatar-03"], defaultEligible: false },
  { id: "generated-avatar-04", kind: "codex-cli", label: "Generated avatar 4", imageUrl: CHAT_AVATAR_URLS["generated-avatar-04"], defaultEligible: false },
  { id: "generated-avatar-05", kind: "codex-cli", label: "Generated avatar 5", imageUrl: CHAT_AVATAR_URLS["generated-avatar-05"], defaultEligible: false },
  { id: "generated-avatar-06", kind: "codex-cli", label: "Generated avatar 6", imageUrl: CHAT_AVATAR_URLS["generated-avatar-06"], defaultEligible: false },
  { id: "generated-avatar-07", kind: "codex-cli", label: "Generated avatar 7", imageUrl: CHAT_AVATAR_URLS["generated-avatar-07"], defaultEligible: false },
  { id: "generated-avatar-08", kind: "codex-cli", label: "Generated avatar 8", imageUrl: CHAT_AVATAR_URLS["generated-avatar-08"], defaultEligible: false },
  { id: "generated-avatar-21", kind: "codex-cli", label: "Generated avatar 21", imageUrl: CHAT_AVATAR_URLS["generated-avatar-21"], defaultEligible: false },
  { id: "generated-avatar-22", kind: "codex-cli", label: "Generated avatar 22", imageUrl: CHAT_AVATAR_URLS["generated-avatar-22"], defaultEligible: false },
  { id: "generated-avatar-23", kind: "codex-cli", label: "Generated avatar 23", imageUrl: CHAT_AVATAR_URLS["generated-avatar-23"], defaultEligible: false },
  { id: "generated-avatar-24", kind: "codex-cli", label: "Generated avatar 24", imageUrl: CHAT_AVATAR_URLS["generated-avatar-24"], defaultEligible: false },
  { id: "codex-bunny", kind: "codex-cli", label: "Codex bunny", imageUrl: CHAT_AVATAR_URLS["codex-bunny"] },
  { id: "codex-cat", kind: "codex-cli", label: "Codex cat", imageUrl: CHAT_AVATAR_URLS["codex-cat"] },
  { id: "codex-dog", kind: "codex-cli", label: "Codex dog", imageUrl: CHAT_AVATAR_URLS["codex-dog"] },
  { id: "codex-frog", kind: "codex-cli", label: "Codex frog", imageUrl: CHAT_AVATAR_URLS["codex-frog"] },
  { id: "codex-hamster", kind: "codex-cli", label: "Codex hamster", imageUrl: CHAT_AVATAR_URLS["codex-hamster"] },
  { id: "claude-logo", kind: "claude-code", label: "Claude logo", imageUrl: CHAT_AVATAR_URLS["claude-logo"], avatarKind: "anthropic", defaultEligible: false },
  { id: "claude-human", kind: "claude-code", label: "Claude human", imageUrl: CHAT_AVATAR_URLS["claude-human"] },
  { id: "generated-avatar-09", kind: "claude-code", label: "Generated avatar 9", imageUrl: CHAT_AVATAR_URLS["generated-avatar-09"], defaultEligible: false },
  { id: "generated-avatar-10", kind: "claude-code", label: "Generated avatar 10", imageUrl: CHAT_AVATAR_URLS["generated-avatar-10"], defaultEligible: false },
  { id: "generated-avatar-11", kind: "claude-code", label: "Generated avatar 11", imageUrl: CHAT_AVATAR_URLS["generated-avatar-11"], defaultEligible: false },
  { id: "generated-avatar-12", kind: "claude-code", label: "Generated avatar 12", imageUrl: CHAT_AVATAR_URLS["generated-avatar-12"], defaultEligible: false },
  { id: "generated-avatar-13", kind: "claude-code", label: "Generated avatar 13", imageUrl: CHAT_AVATAR_URLS["generated-avatar-13"], defaultEligible: false },
  { id: "generated-avatar-14", kind: "claude-code", label: "Generated avatar 14", imageUrl: CHAT_AVATAR_URLS["generated-avatar-14"], defaultEligible: false },
  { id: "generated-avatar-15", kind: "claude-code", label: "Generated avatar 15", imageUrl: CHAT_AVATAR_URLS["generated-avatar-15"], defaultEligible: false },
  { id: "generated-avatar-16", kind: "claude-code", label: "Generated avatar 16", imageUrl: CHAT_AVATAR_URLS["generated-avatar-16"], defaultEligible: false },
  { id: "generated-avatar-17", kind: "claude-code", label: "Generated avatar 17", imageUrl: CHAT_AVATAR_URLS["generated-avatar-17"], defaultEligible: false },
  { id: "generated-avatar-18", kind: "claude-code", label: "Generated avatar 18", imageUrl: CHAT_AVATAR_URLS["generated-avatar-18"], defaultEligible: false },
  { id: "generated-avatar-19", kind: "claude-code", label: "Generated avatar 19", imageUrl: CHAT_AVATAR_URLS["generated-avatar-19"], defaultEligible: false },
  { id: "generated-avatar-20", kind: "claude-code", label: "Generated avatar 20", imageUrl: CHAT_AVATAR_URLS["generated-avatar-20"], defaultEligible: false },
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

// Character suffix shared across providers, e.g. "codex-cat" / "claude-cat" -> "cat".
function chatAvatarCharacter(id: string): string {
  return id.slice(id.indexOf("-") + 1);
}

// Map an avatar to the equivalent character on a different provider so switching
// provider keeps logo->logo and cat->cat instead of falling back to a hashed default.
export function mapChatAvatarIdToKind(kind: ChatProviderKind, avatarId: string | undefined, seed = ""): ChatAvatarId {
  const option = chatAvatarOption(avatarId);
  if (option?.kind === kind) {
    return option.id;
  }
  if (option) {
    const character = chatAvatarCharacter(option.id);
    const match = chatAvatarOptionsForKind(kind).find((candidate) => chatAvatarCharacter(candidate.id) === character);
    if (match) {
      return match.id;
    }
  }
  return defaultChatAvatarId(kind, seed);
}

export function avatarForChatAvatarOption(option: ChatAvatarOption, label = option.label): AvatarSpec {
  return { kind: option.avatarKind ?? "custom", label, imageUrl: option.imageUrl };
}

export function avatarForChatParticipant(
  participant: Pick<ChatParticipant, "id" | "handle" | "kind" | "avatarId">,
  label = chatParticipantDisplayName(participant)
): AvatarSpec {
  if (label === CHAT_ASSISTANT_DISPLAY_NAME) {
    return { kind: "custom", label, imageUrl: CHAT_AVATAR_URLS["accordagents-mark"] };
  }
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
