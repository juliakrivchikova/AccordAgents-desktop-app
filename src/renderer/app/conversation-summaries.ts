import type { ConversationSummary, ConversationUpdate } from "../../shared/types";
import { isPendingReply, isWaitingChoice } from "../../shared/chatActiveRuns";
import { conversationSummaryMainSessionKind, normalizeConversationSummaryChatParticipants } from "../../shared/conversationSummary";
import type { ProjectSessionGroup } from "../components/shell";
import { NO_PROJECT_GROUP_KEY } from "./constants";
import { normalizeProjectPath, projectLabelForPath } from "../../shared/newChat";

export { normalizeProjectPath };

/** The Projects list keeps its places; only Recents ranks chats by activity
 *  (the User, 2026-11-27). A project stays where it first appeared, a new one
 *  below the others (as a newly pinned chat), and an archived chat still holds
 *  its project's place. A project's chats are listed newest-created first, so
 *  a chat at work does not move. */
export function buildProjectSessionGroups(summaries: ConversationSummary[]): ProjectSessionGroup[] {
  const groups = new Map<string, ProjectSessionGroup>();
  const firstCreated = new Map<string, number>();

  for (const summary of summaries) {
    const projectPath = normalizeProjectPath(summary.repoPath);
    const key = projectPath ?? NO_PROJECT_GROUP_KEY;
    const created = conversationTimeValue(summary.createdAt);
    firstCreated.set(key, Math.min(firstCreated.get(key) ?? created, created));
    if (summary.archived) {
      continue;
    }
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(summary);
      continue;
    }
    groups.set(key, {
      key,
      label: projectPath ? projectLabelForPath(projectPath) : "No project",
      repoPath: projectPath,
      sessions: [summary],
      isNoProject: !projectPath
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sessions: [...group.sessions].sort(compareByCreation)
    }))
    .sort((left, right) => {
      if (left.isNoProject !== right.isNoProject) {
        return left.isNoProject ? 1 : -1;
      }
      const timeDelta = (firstCreated.get(left.key) ?? 0) - (firstCreated.get(right.key) ?? 0);
      return timeDelta || left.label.localeCompare(right.label) || left.key.localeCompare(right.key);
    });
}

function compareByCreation(left: ConversationSummary, right: ConversationSummary): number {
  const timeDelta = conversationTimeValue(right.createdAt) - conversationTimeValue(left.createdAt);
  return timeDelta || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

/** How many chats Recents lists, as Claude's does. */
export const RECENT_CHAT_LIMIT = 10;

/** Pinned chats, in the order they were pinned (a newly pinned chat goes to
 *  the bottom, so the list does not shift under the User; one whose time is
 *  not known goes last). The phone orders them the same way. */
export function pinnedChatSummaries(summaries: ConversationSummary[]): ConversationSummary[] {
  const pinnedAtValue = (summary: ConversationSummary): number => {
    const value = Date.parse(summary.pinnedAt ?? "");
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  return summaries
    .filter((summary) => summary.pinned === true && summary.archived !== true)
    .sort((left, right) => {
      const timeDelta = pinnedAtValue(left) - pinnedAtValue(right);
      return timeDelta || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
    });
}

/** The most recent chats of every project, pinned ones included. */
export function recentChatSummaries(summaries: ConversationSummary[], limit = RECENT_CHAT_LIMIT): ConversationSummary[] {
  return summaries
    .filter((summary) => summary.archived !== true)
    .sort(compareConversationSummaries)
    .slice(0, limit);
}

/** The chat as the User just pinned or unpinned it, before her server says so. */
export function withPinnedState(summary: ConversationSummary, pinned: boolean, at: string): ConversationSummary {
  const { pinned: _pinned, pinnedAt: _pinnedAt, ...rest } = summary;
  return pinned ? { ...rest, pinned: true, pinnedAt: at } : rest;
}

export function upsertConversationSummary(summaries: ConversationSummary[], conversation: ConversationUpdate): ConversationSummary[] {
  const nextSummary = summaryFromConversation(conversation);
  return [
    nextSummary,
    ...summaries.filter((summary) => summary.id !== conversation.id)
  ].sort(compareConversationSummaries);
}

/** A folder's most recently active chats: what New chat offers to continue. */
export function projectChatSummaries(summaries: ConversationSummary[], repoPath: string | undefined, limit: number): ConversationSummary[] {
  const projectPath = normalizeProjectPath(repoPath);
  if (!projectPath) return [];
  const group = buildProjectSessionGroups(summaries).find((item) => item.repoPath === projectPath);
  return group ? group.sessions.filter((summary) => summary.kind === "chat").sort(compareConversationSummaries).slice(0, limit) : [];
}

export function compareConversationSummaries(left: ConversationSummary, right: ConversationSummary): number {
  const timeDelta = conversationTimeValue(right.updatedAt) - conversationTimeValue(left.updatedAt);
  return timeDelta || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

export function conversationTimeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function summaryFromConversation(conversation: ConversationUpdate): ConversationSummary {
  const activeRunIds = conversation.metadata?.activeRunIds;
  const hasActiveRuns = Array.isArray(activeRunIds) && activeRunIds.length > 0;
  const running = Boolean(hasActiveRuns || conversation.metadata?.running);
  // A member's reply not ended yet, even with no run of this device in the
  // chat (a machine member's turn asked from the phone). A delta carries only
  // some messages, so it says whether the whole chat has one; a full update
  // or a loaded chat is read as it is.
  const replyPending = conversation.messageDelta?.replyPending === true || conversation.messages.some(isPendingReply);
  // The same for a member's choice card waiting for the User.
  const waitingChoice = conversation.messageDelta
    ? conversation.messageDelta.waitingChoice === true
    : conversation.messages.some(isWaitingChoice);
  const pinned = conversation.metadata?.pinned === true;
  const pinnedAt = typeof conversation.metadata?.pinnedAt === "string" ? conversation.metadata.pinnedAt : undefined;
  const chatParticipants = conversation.kind === "chat"
    ? normalizeConversationSummaryChatParticipants(conversation.metadata?.participants)
    : undefined;
  const mainSessionKind = conversation.kind === "chat"
    ? conversationSummaryMainSessionKind(conversation.metadata?.participants, conversation.metadata?.mainSessionParticipantId)
    : undefined;
  return {
    id: conversation.id,
    title: conversation.title,
    kind: conversation.kind,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    repoPath: conversation.repoPath,
    running,
    ...(replyPending ? { replyPending: true } : {}),
    archived: conversation.metadata?.archived === true,
    ...(pinned ? { pinned: true, ...(pinnedAt ? { pinnedAt } : {}) } : {}),
    ...(waitingChoice ? { waitingChoice: true } : {}),
    ...(chatParticipants ? { chatParticipants } : {}),
    ...(mainSessionKind ? { mainSessionKind } : {})
  };
}
