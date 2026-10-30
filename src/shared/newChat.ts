import { normalizeAutoChatTitle, normalizeManualChatTitle } from "./chatTitles";
import type { ChatParticipant, ChatParticipantConfig, ConversationSummary } from "./types";

/**
 * How a new chat is made, the same on the computer and on the phone (the
 * User, 2026-10-29: the phone's New chat is the computer's). The computer
 * prepares each member as it would add it (HubNewChatOptions); the phone puts
 * the chat together with these rules, which copy the computer's own (named at
 * each), and both use the intro, the title, the usage order and the projects.
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

/** A project's folder, as the computer's sidebar groups chats by it. */
export function normalizeProjectPath(repoPath: string | undefined): string | undefined {
  const trimmed = repoPath?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/[\\/]+$/g, "");
  return normalized || trimmed;
}

export function projectLabelForPath(repoPath: string): string {
  const parts = repoPath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? repoPath;
}

function timeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The computer's projects for a new chat: the folders its chats are in (not
 * archived), newest first; and the folder its New chat starts in when no chat
 * is open: the one last chosen, or the newest chat's that has one.
 */
export function newChatProjects(summaries: ConversationSummary[], lastRepoPath: string | undefined): {
  projects: Array<{ path: string; label: string }>;
  defaultProject?: string;
} {
  const byPath = new Map<string, { path: string; label: string; at: number }>();
  let newest: { path: string; at: number } | undefined;
  for (const summary of summaries) {
    const path = normalizeProjectPath(summary.repoPath);
    if (!path) continue;
    const at = timeValue(summary.updatedAt);
    if (!newest || at > newest.at) newest = { path, at };
    if (summary.archived) continue;
    const known = byPath.get(path);
    if (known) known.at = Math.max(known.at, at);
    else byPath.set(path, { path, label: projectLabelForPath(path), at });
  }
  const projects = [...byPath.values()].sort((left, right) => (right.at - left.at) || left.label.localeCompare(right.label))
    .map(({ path, label }) => ({ path, label }));
  const defaultProject = normalizeProjectPath(lastRepoPath) ?? newest?.path;
  return defaultProject ? { projects, defaultProject } : { projects };
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
  /** The machine it runs on, when it runs on one: for a Cloud run member,
   *  the machine on the computer's AWS instance. A chat started off the
   *  computer goes straight there (the server asks the machine for its turns
   *  and wakes it). */
  machineId?: string;
  /** Why it cannot be started straight on its machine (no cloud machine yet,
   *  one the server does not know): a chat started off the computer cannot
   *  have it. */
  machineUnavailable?: string;
  /** For a member that runs on a machine: the projects that machine has. In
   *  any other project its turn would not find the project's files there,
   *  so it is offered only for these, and for a chat without a project.
   *  Absent: any project (a member of this computer, or a machine set up by
   *  hand, which keeps its own folders). */
  projects?: string[];
}

/** Whether a member can be in a new chat in this project ("" or none: a
 *  chat without one). */
export function newChatMemberFitsProject(member: Pick<NewChatMemberOption, "projects">, project: string | undefined): boolean {
  const path = normalizeProjectPath(project);
  if (!path || !member.projects) return true;
  return member.projects.some((item) => normalizeProjectPath(item) === path);
}

/** The saved members a new chat gets: each chosen, and each the first
 *  message names with an @ (the computer's selectedOrMentionedChatParticipantDrafts). */
export function newChatPickedMembers(input: { members: NewChatMemberOption[]; chosenConfigIds: string[]; firstMessage: string }): NewChatMemberOption[] {
  const chosen = new Set(input.chosenConfigIds);
  return input.members.filter((member) => chosen.has(member.configId) ||
    new RegExp(`@${escapeRegExp(member.participant.handle)}(?![A-Za-z0-9_-])`, "i").test(input.firstMessage));
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
  const picked = newChatPickedMembers(input);
  let watching = false;
  const members = picked.map((member) => {
    const autoWatch = member.participant.autoWatch === true && !watching;
    if (autoWatch) watching = true;
    return { ...member.participant, ...(member.machineId ? { homeMachineId: member.machineId } : {}), id: input.newId(), autoWatch };
  });
  const taken = new Set(members.map((member) => member.handle.toLowerCase()));
  let handle = input.assistant.handle;
  for (let suffix = 2; taken.has(handle.toLowerCase()); suffix += 1) {
    const suffixText = `-${suffix}`;
    handle = `${input.assistant.handle.slice(0, 32 - suffixText.length)}${suffixText}`;
  }
  return [{ ...input.assistant, id: input.newId(), handle, autoWatch: input.assistant.autoWatch === true && !watching }, ...members];
}
