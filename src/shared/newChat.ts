import { normalizeAutoChatTitle, normalizeManualChatTitle } from "./chatTitles";
import type { ChatParticipant, ChatParticipantConfig, ConversationSummary } from "./types";

/**
 * How a new chat is made, the same on the computer and on the phone (the
 * User, 2026-10-29: the phone's New chat is the computer's). The computer
 * prepares each member as it would add it (HubNewChatOptions); either device
 * then puts the chat together with these rules.
 */

/** The system message a new chat starts with. */
export function newChatIntro(handles: string[]): string {
  return ["Chat started.", "Members:", "- User", ...handles.map((handle) => `- @${handle}`)].join("\n");
}

/** A new chat's title, from its first message (or its first picture). */
export function newChatTitle(firstMessage: string, firstImageName?: string): string {
  if (firstMessage) return normalizeAutoChatTitle(firstMessage);
  const filename = firstImageName?.trim();
  return normalizeManualChatTitle(filename ? `Image: ${filename}` : "Image chat");
}

export interface ParticipantConfigUsage {
  byConfigId: Map<string, number>;
  byFallbackKey: Map<string, number>;
}

/** How often each saved member was in a chat: the New chat screen offers the
 *  most used first. */
export function participantConfigUsage(summaries: ConversationSummary[]): ParticipantConfigUsage {
  const byConfigId = new Map<string, number>();
  const byFallbackKey = new Map<string, number>();
  for (const summary of summaries) {
    if (summary.kind !== "chat" || !summary.chatParticipants) continue;
    for (const participant of summary.chatParticipants) {
      const participantConfigId = participant.participantConfigId?.trim();
      if (participantConfigId) {
        byConfigId.set(participantConfigId, (byConfigId.get(participantConfigId) ?? 0) + 1);
        continue;
      }
      const fallbackKey = participantFallbackKey(participant);
      byFallbackKey.set(fallbackKey, (byFallbackKey.get(fallbackKey) ?? 0) + 1);
    }
  }
  return { byConfigId, byFallbackKey };
}

export function participantConfigUsageCount(config: Pick<ChatParticipantConfig, "id" | "handle" | "kind">, usage: ParticipantConfigUsage): number {
  return (usage.byConfigId.get(config.id) ?? 0) + (usage.byFallbackKey.get(participantFallbackKey(config)) ?? 0);
}

/** Items in the New chat screen's order: most used first, ties as given. */
export function orderByParticipantUsage<T>(items: T[], configOf: (item: T) => Pick<ChatParticipantConfig, "id" | "handle" | "kind">, summaries: ConversationSummary[]): T[] {
  if (items.length <= 1 || summaries.length === 0) return items;
  const usage = participantConfigUsage(summaries);
  return items
    .map((item, index) => ({ item, index, count: participantConfigUsageCount(configOf(item), usage) }))
    .sort((left, right) => (right.count - left.count) || (left.index - right.index))
    .map(({ item }) => item);
}

function participantFallbackKey(participant: Pick<ChatParticipantConfig, "handle" | "kind">): string {
  return `${participant.kind}:${participant.handle.trim().replace(/^@/, "").toLowerCase()}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A saved member offered for a new chat, as the computer would add it (in
 *  the order of the computer's saved members). */
export interface NewChatMemberOption {
  configId: string;
  participant: ChatParticipant;
  /** In how many chats it was: the screen offers the most used first. */
  uses: number;
  /** Why it cannot be added now (its CLI is not ready, say), as the
   *  computer's New chat screen says it. */
  unavailable?: string;
}

/**
 * A new chat's members, as the computer makes them: each member chosen, and
 * each saved member the first message names with an @, then the Chat
 * Assistant before them all. Only the first that watches the chat (the
 * Assistant counted last) keeps watching it. Every member gets a fresh id.
 */
export function newChatParticipants(input: {
  assistant: ChatParticipant;
  members: NewChatMemberOption[];
  chosenConfigIds: string[];
  firstMessage: string;
  newId: () => string;
}): ChatParticipant[] {
  const chosen = new Set(input.chosenConfigIds);
  const picked = input.members.filter((member) => chosen.has(member.configId) ||
    new RegExp(`@${escapeRegExp(member.participant.handle)}(?![A-Za-z0-9_-])`, "i").test(input.firstMessage));
  let watching = false;
  const members = picked.map((member) => {
    const autoWatch = member.participant.autoWatch === true && !watching;
    if (autoWatch) watching = true;
    return { ...member.participant, id: input.newId(), autoWatch };
  });
  const taken = new Set(members.map((member) => member.handle.toLowerCase()));
  let handle = input.assistant.handle;
  for (let suffix = 2; taken.has(handle.toLowerCase()); suffix += 1) {
    const suffixText = `-${suffix}`;
    handle = `${input.assistant.handle.slice(0, 32 - suffixText.length)}${suffixText}`;
  }
  return [{ ...input.assistant, id: input.newId(), handle, autoWatch: input.assistant.autoWatch === true && !watching }, ...members];
}
