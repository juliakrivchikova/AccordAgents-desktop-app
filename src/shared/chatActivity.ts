import { activeRunSummaryForConversation } from "./chatActiveRuns";
import type {
  ChatActivityItem,
  ChatActivityParticipantSummary,
  ChatAppToolApproval,
  ChatMessage,
  ChatParticipant,
  Conversation
} from "./types";

export const DEFAULT_CHAT_ACTIVITY_LIMIT = 50;
export const DEFAULT_CHAT_ACTIVITY_RECENT_CONVERSATION_LIMIT = 80;
export const DEFAULT_CHAT_ACTIVITY_RECENT_WINDOW_DAYS = 7;
export const MAX_CHAT_ACTIVITY_CLEAR_HORIZONS = 500;

const STATUS_RANK: Record<ChatActivityItem["status"], number> = {
  pending: 0,
  running: 1,
  recent: 2
};

export interface BuildChatActivityItemsOptions {
  now?: string | Date;
  lastViewedAt?: string;
  recentWindowDays?: number;
  /**
   * Applied before rows collapse, so a cleared update is not counted by the row that replaces it.
   * Filtering after the collapse cannot fix that: the rows it would drop are already gone.
   */
  preferences?: ApplyChatActivityItemPreferencesOptions;
}

export interface BuildChatActivityItemsForUpdateOptions extends BuildChatActivityItemsOptions {
  treatAsViewed?: boolean;
}

export interface ReconcileChatActivityRefreshOptions {
  revisionsAtStart: Record<string, number>;
  revisionsNow: Record<string, number>;
  archivedConversationIds?: ReadonlySet<string>;
  limit?: number;
}

export interface ApplyChatActivityItemPreferencesOptions {
  readItemIds?: ReadonlySet<string>;
  clearedItemIds?: ReadonlySet<string>;
  /**
   * Clear horizons keyed by finished-activity group (one chat + one member). Clearing a
   * collapsed row hides the older updates it stood for, and only those: a horizon must never
   * suppress finished rows of another member or another chat.
   */
  clearedRecentThroughByGroup?: Readonly<Record<string, string>>;
  /**
   * Frozen cutoff inherited from the pre-per-group clear state. It keeps finished rows the user
   * had already cleared hidden after the upgrade, and it never moves: new clears write group
   * horizons instead, so it can no longer suppress another chat's later activity.
   */
  clearedRecentThroughBefore?: string;
}

export interface ChatActivityItemPreferences {
  readItemIds: Set<string>;
  clearedItemIds: Set<string>;
  clearedRecentThroughByGroup?: Record<string, string>;
  clearedRecentThroughBefore?: string;
}

export function buildChatActivityItems(
  conversation: Conversation | undefined,
  options: BuildChatActivityItemsOptions = {}
): ChatActivityItem[] {
  if (!conversation || conversation.kind !== "chat" || conversation.archived || conversation.metadata.archived === true) {
    return [];
  }

  const participants = participantSummaries(conversation);
  const items: ChatActivityItem[] = [];
  const nowMs = timeValue(options.now ?? new Date());
  const recentWindowDays = normalizePositiveNumber(options.recentWindowDays, DEFAULT_CHAT_ACTIVITY_RECENT_WINDOW_DAYS);
  const recentCutoffMs = nowMs - recentWindowDays * 24 * 60 * 60 * 1000;
  const lastViewedMs = timeValue(options.lastViewedAt);

  items.push(...pendingApprovalItems(conversation, participants));
  for (const message of conversation.messages) {
    items.push(...pendingMessageItems(conversation, message, participants));
  }

  const runningRunIds = new Set<string>();
  const activeRuns = activeRunSummaryForConversation(conversation);
  for (const runId of activeRuns.runIds) {
    runningRunIds.add(runId);
    const participantId = activeRuns.participantIdsByRunId.get(runId);
    const runMessage = newestMessageForRun(conversation.messages, runId);
    const message = runMessage && isVisibleTimelineMessage(runMessage)
      ? runMessage
      : referencedVisibleMessage(runMessage, conversation.messages);
    const participant = participantId ? participants.get(participantId) : participantForMessage(message, participants);
    const timestamp = message?.createdAt ?? conversation.updatedAt;
    items.push({
      id: `run:${conversation.id}:${runId}`,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      repoPath: conversation.repoPath,
      status: "running",
      kind: "run",
      title: participant ? `@${participant.handle} is running` : "Run in progress",
      preview: previewText(message?.content) || "A member run is in progress.",
      createdAt: timestamp,
      updatedAt: timestamp,
      participant,
      target: {
        runId,
        messageId: message?.id,
        threadRootId: threadRootIdForMessage(message)
      }
    });
  }

  for (const message of conversation.messages) {
    if (message.role !== "participant" || message.status !== "done" || !isVisibleTimelineMessage(message)) {
      continue;
    }
    const runId = cleanString(message.metadata?.runId);
    if (runId && runningRunIds.has(runId)) {
      continue;
    }
    const updatedAt = finishedMessageActivityTime(message);
    const updatedMs = timeValue(updatedAt);
    if (updatedMs <= 0 || updatedMs < recentCutoffMs) {
      continue;
    }
    const participant = participantForMessage(message, participants);
    items.push({
      id: `recent:${conversation.id}:${runId || message.id}`,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      repoPath: conversation.repoPath,
      status: "recent",
      ...(lastViewedMs > 0 && updatedMs <= lastViewedMs ? { read: true } : {}),
      kind: "message",
      title: participant ? `@${participant.handle} recently finished` : "Recent activity",
      preview: previewText(message.content) || "A member posted an update.",
      createdAt: message.createdAt,
      updatedAt,
      participant,
      target: {
        ...(runId ? { runId } : {}),
        messageId: message.id,
        threadRootId: threadRootIdForMessage(message)
      }
    });
  }

  const retained = options.preferences ? applyChatActivityItemPreferences(items, options.preferences) : items;
  return sortChatActivityItems(dedupeChatActivityItems(retained));
}

export function applyChatActivityItemPreferences(
  items: ChatActivityItem[],
  options: ApplyChatActivityItemPreferencesOptions = {}
): ChatActivityItem[] {
  const readItemIds = options.readItemIds ?? new Set<string>();
  const clearedItemIds = options.clearedItemIds ?? new Set<string>();
  const clearedRecentThroughByGroup = options.clearedRecentThroughByGroup ?? {};
  const clearedBeforeMs = timeValue(options.clearedRecentThroughBefore);
  const retained = items
    .filter((item) => {
      if (clearedItemIds.has(item.id)) {
        return false;
      }
      if (item.status === "recent" && clearedBeforeMs > 0 && timeValue(item.updatedAt) > 0 && timeValue(item.updatedAt) <= clearedBeforeMs) {
        return false;
      }
      const groupKey = recentParticipantGroupKey(item);
      if (!groupKey) {
        return true;
      }
      const clearedThroughMs = timeValue(clearedRecentThroughByGroup[groupKey]);
      const updatedMs = timeValue(item.updatedAt);
      return clearedThroughMs <= 0 || updatedMs <= 0 || updatedMs > clearedThroughMs;
    })
    .map((item) => item.read === true || !readItemIds.has(item.id) ? item : { ...item, read: true });
  return retained;
}

export function chatActivityItemPreferencesAfterClear(
  current: ChatActivityItemPreferences,
  items: ChatActivityItem[],
  itemId: string
): ChatActivityItemPreferences {
  const normalizedId = itemId.trim();
  const readItemIds = new Set(current.readItemIds);
  const clearedItemIds = new Set(current.clearedItemIds);
  readItemIds.delete(normalizedId);
  clearedItemIds.delete(normalizedId);
  clearedItemIds.add(normalizedId);
  const clearedItem = items.find((item) => item.id === normalizedId);
  // A finished row stands for every update of that member in that chat, so clearing it must also
  // hide the older updates it collapsed - and nothing outside that member and chat.
  const groupKey = clearedItem ? recentParticipantGroupKey(clearedItem) : undefined;
  const existingHorizons = current.clearedRecentThroughByGroup ?? {};
  const clearedThrough = groupKey && clearedItem
    ? newerTimestamp(existingHorizons[groupKey], clearedItem.updatedAt)
    : undefined;
  // Re-insert the touched group last and keep only the newest horizons, so a bounded store drops
  // the least recently cleared group instead of the one the user just cleared.
  const clearedRecentThroughByGroup = Object.fromEntries([
    ...Object.entries(existingHorizons).filter(([key]) => key !== groupKey),
    ...(groupKey && clearedThrough ? [[groupKey, clearedThrough] as [string, string]] : [])
  ].slice(-MAX_CHAT_ACTIVITY_CLEAR_HORIZONS));
  return {
    readItemIds,
    clearedItemIds,
    ...(Object.keys(clearedRecentThroughByGroup).length > 0 ? { clearedRecentThroughByGroup } : {}),
    ...(current.clearedRecentThroughBefore ? { clearedRecentThroughBefore: current.clearedRecentThroughBefore } : {})
  };
}

export function buildChatActivityItemsForConversationUpdate(
  conversation: Conversation | undefined,
  options: BuildChatActivityItemsForUpdateOptions = {}
): ChatActivityItem[] {
  return buildChatActivityItems(conversation, {
    ...options,
    lastViewedAt: options.treatAsViewed ? conversation?.updatedAt : options.lastViewedAt
  });
}

export function resolveSelectedChatActivityItem(
  items: ChatActivityItem[],
  selectedItem: ChatActivityItem | undefined
): ChatActivityItem | undefined {
  if (!selectedItem) {
    return undefined;
  }
  return items.find((item) => item.id === selectedItem.id) ?? selectedItem;
}

export function isCodexActivityApprovalItem(item: ChatActivityItem): boolean {
  return item.kind === "approval" &&
    item.status === "pending" &&
    item.target.approvalKind === "codex" &&
    Boolean(item.target.approvalId?.trim());
}

export function mergeChatActivityItems(
  current: ChatActivityItem[],
  incoming: ChatActivityItem[],
  options: { limit?: number; replaceConversationId?: string } = {}
): ChatActivityItem[] {
  const byId = new Map<string, ChatActivityItem>();
  const replaceConversationId = cleanString(options.replaceConversationId);
  for (const item of current) {
    if (replaceConversationId && item.conversationId === replaceConversationId) {
      continue;
    }
    byId.set(item.id, item);
  }
  for (const item of incoming) {
    byId.set(item.id, item);
  }
  return limitChatActivityItems(sortChatActivityItems(dedupeChatActivityItems([...byId.values()])), options.limit);
}

export function reconcileChatActivityRefreshItems(
  current: ChatActivityItem[],
  incoming: ChatActivityItem[],
  options: ReconcileChatActivityRefreshOptions
): ChatActivityItem[] {
  const archivedConversationIds = options.archivedConversationIds ?? new Set<string>();
  const changedConversationIds = new Set<string>();
  for (const [conversationId, revision] of Object.entries(options.revisionsNow)) {
    if (revision !== (options.revisionsAtStart[conversationId] ?? 0)) {
      changedConversationIds.add(conversationId);
    }
  }

  const acceptedIncoming = incoming.filter((item) =>
    !archivedConversationIds.has(item.conversationId) &&
    !changedConversationIds.has(item.conversationId)
  );
  const preservedCurrent = current.filter((item) => {
    if (archivedConversationIds.has(item.conversationId)) {
      return false;
    }
    if (changedConversationIds.has(item.conversationId)) {
      return true;
    }
    return item.status === "recent" && item.read === true;
  });

  return mergeChatActivityItems(acceptedIncoming, preservedCurrent, { limit: options.limit });
}

export function preservedRecentChatActivityItems(
  items: ChatActivityItem[],
  conversationId: string,
  options: { archived: boolean; treatAsRead: boolean }
): ChatActivityItem[] {
  if (options.archived) {
    return [];
  }
  return items
    .filter((item) =>
      item.conversationId === conversationId &&
      item.status === "recent" &&
      (item.read === true || options.treatAsRead)
    )
    .map((item) => ({ ...item, read: true }));
}

export function sortChatActivityItems(items: ChatActivityItem[]): ChatActivityItem[] {
  return [...items].sort((left, right) => {
    const statusDelta = STATUS_RANK[left.status] - STATUS_RANK[right.status];
    if (statusDelta !== 0) {
      return statusDelta;
    }
    const timeDelta = timeValue(right.updatedAt) - timeValue(left.updatedAt);
    return timeDelta || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  });
}

export function limitChatActivityItems(items: ChatActivityItem[], limit?: number): ChatActivityItem[] {
  const normalizedLimit = normalizePositiveNumber(limit, DEFAULT_CHAT_ACTIVITY_LIMIT);
  // The cap is per status: a long finished history can no longer push a waiting approval out of
  // view, and no status can grow without a bound of its own.
  const countByStatus = new Map<ChatActivityItem["status"], number>();
  return items.filter((item) => {
    const count = (countByStatus.get(item.status) ?? 0) + 1;
    countByStatus.set(item.status, count);
    return count <= normalizedLimit;
  });
}

function pendingApprovalItems(
  conversation: Conversation,
  participants: Map<string, ChatActivityParticipantSummary>
): ChatActivityItem[] {
  const approvals = chatAppToolApprovals(conversation.metadata.pendingAppToolApprovals);
  return approvals.flatMap((approval) => {
    // A cancelled or denied approval is finished business: it stays visible on the card in the
    // chat timeline and leaves activity entirely instead of piling up in the finished list.
    if (approval.status !== "pending") {
      return [];
    }
    const triggerMessageId = cleanString(approval.resumeContext?.triggerMessageId);
    const targetMessage = timelineMessageForApproval(conversation.messages, approval, triggerMessageId);
    const participant = participantForMessage(targetMessage, participants)
      ?? participants.get(approval.requesterParticipantId);
    const messageId = targetMessage?.id ?? triggerMessageId;
    return [{
      id: `approval:${conversation.id}:${approval.id}`,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      repoPath: conversation.repoPath,
      status: "pending" as const,
      kind: "approval" as const,
      title: participant ? `@${participant.handle} needs approval` : "Approval required",
      preview: previewText(targetMessage?.content) || approval.summary || approval.toolName || "A tool request is waiting for approval.",
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
      participant,
      target: {
        approvalId: approval.id,
        ...("kind" in approval.request && approval.request.kind === "codexApproval"
          ? { approvalKind: "codex" as const }
          : {}),
        runId: approval.resumeContext?.runId,
        messageId,
        threadRootId: threadRootIdForMessage(targetMessage) || messageId
      }
    }];
  });
}

function timelineMessageForApproval(
  messages: ChatMessage[],
  approval: ChatAppToolApproval,
  triggerMessageId: string
): ChatMessage | undefined {
  const triggerMessage = triggerMessageId
    ? messages.find((message) => message.id === triggerMessageId)
    : undefined;
  const exact = triggerMessage && isVisibleTimelineMessage(triggerMessage) ? triggerMessage : undefined;
  if (exact) {
    return exact;
  }
  const visibleReference = referencedVisibleMessage(triggerMessage, messages);
  if (visibleReference) {
    return visibleReference;
  }
  const approvalMs = timeValue(approval.createdAt);
  const requesterParticipantId = cleanString(approval.requesterParticipantId);
  const visibleMessages = messages.filter((message) =>
    isVisibleTimelineMessage(message) &&
    (!approvalMs || timeValue(message.createdAt) <= approvalMs)
  );
  const requesterMessages = requesterParticipantId
    ? visibleMessages.filter((message) => cleanString(message.participantId) === requesterParticipantId)
    : [];
  return newestMessageByCreatedAt(requesterMessages)
    ?? newestMessageByCreatedAt(visibleMessages)
    ?? newestMessageByCreatedAt(messages.filter(isVisibleTimelineMessage));
}

function referencedVisibleMessage(
  message: ChatMessage | undefined,
  messages: ChatMessage[]
): ChatMessage | undefined {
  const metadata = message?.metadata;
  const referencedIds = [metadata?.sourceMessageId, metadata?.parentMessageId, metadata?.chatThreadRootId]
    .map(cleanString)
    .filter(Boolean);
  for (const id of referencedIds) {
    const referenced = messages.find((candidate) => candidate.id === id && isVisibleTimelineMessage(candidate));
    if (referenced) {
      return referenced;
    }
  }
  return undefined;
}

function isVisibleTimelineMessage(message: ChatMessage): boolean {
  return message.role !== "system" && message.metadata?.hiddenFromTimeline !== true;
}

function pendingMessageItems(
  conversation: Conversation,
  message: ChatMessage,
  participants: Map<string, ChatActivityParticipantSummary>
): ChatActivityItem[] {
  const items: ChatActivityItem[] = [];
  const targetMessage = isVisibleTimelineMessage(message)
    ? message
    : referencedVisibleMessage(message, conversation.messages);
  if (!targetMessage) {
    return items;
  }
  const participant = participantForMessage(targetMessage, participants);
  const runId = cleanString(message.metadata?.runId);
  const target = {
    ...(runId ? { runId } : {}),
    messageId: targetMessage.id,
    threadRootId: threadRootIdForMessage(targetMessage)
  };
  const updatedAt = message.createdAt;

  if (message.metadata?.pendingChoice?.status === "pending") {
    items.push({
      id: `choice:${conversation.id}:${message.id}:${message.metadata.pendingChoice.id}`,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      repoPath: conversation.repoPath,
      status: "pending",
      kind: "choice",
      title: message.metadata.pendingChoice.title || "Choice required",
      preview: previewText(targetMessage.content) || message.metadata.pendingChoice.question || "A member is waiting for a choice.",
      createdAt: message.createdAt,
      updatedAt,
      participant,
      target: {
        ...target,
        sourceMessageId: message.id,
        choiceId: message.metadata.pendingChoice.id
      }
    });
  }
  const pendingMentions = Array.isArray(message.metadata?.pendingMentions)
    ? message.metadata.pendingMentions.filter((mention) => mention.status === "pending")
    : [];
  if (pendingMentions.length > 0) {
    items.push({
      id: `mention:${conversation.id}:${message.id}`,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      repoPath: conversation.repoPath,
      status: "pending",
      kind: "mention",
      title: "Mention approval required",
      preview: previewText(targetMessage.content) || pendingMentions.map((mention) => `@${mention.targetHandle}`).join(", "),
      createdAt: message.createdAt,
      updatedAt,
      participant,
      target: {
        ...target,
        sourceMessageId: message.id,
        mentionTargetParticipantIds: pendingMentions.map((mention) => mention.targetParticipantId)
      }
    });
  }
  if (message.metadata?.participantRequest?.status === "pending_approval") {
    items.push({
      id: `participant-request:${conversation.id}:${message.id}:${message.metadata.participantRequest.id}`,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      repoPath: conversation.repoPath,
      status: "pending",
      kind: "participant-request",
      title: "Member request approval required",
      preview: previewText(targetMessage.content) || participantRequestPreview(message),
      createdAt: message.createdAt,
      updatedAt,
      participant,
      target
    });
  }

  return items;
}

function dedupeChatActivityItems(items: ChatActivityItem[]): ChatActivityItem[] {
  const byId = new Map<string, ChatActivityItem>();
  const strongestByRun = new Map<string, ChatActivityItem>();
  const strongestByMessage = new Map<string, ChatActivityItem>();
  for (const item of items) {
    if (!isRetainableChatActivityItem(item)) {
      continue;
    }
    byId.set(item.id, item);
    const messageId = cleanString(item.target.messageId);
    if (messageId) {
      const existingMessageItem = strongestByMessage.get(messageId);
      if (!existingMessageItem || strongerActivityItem(item, existingMessageItem)) {
        strongestByMessage.set(messageId, item);
      }
    }
    const runId = cleanString(item.target.runId);
    if (!runId) {
      continue;
    }
    const existing = strongestByRun.get(runId);
    if (!existing || strongerActivityItem(item, existing)) {
      strongestByRun.set(runId, item);
    }
  }

  // One event can be described by several rows (a run, its message, an approval on the same
  // message). Keep the strongest row per run and per message first, so a row that loses here
  // cannot go on to win - and silently hide - its finished group below.
  const distinct = [...byId.values()].filter((item) => {
    const messageId = cleanString(item.target.messageId);
    if (messageId && item.kind === "message" && item.status === "recent" && strongestByMessage.get(messageId)?.id !== item.id) {
      return false;
    }
    const runId = cleanString(item.target.runId);
    return !runId || item.status !== "recent" || strongestByRun.get(runId)?.id === item.id;
  });

  // Finished updates collapse to one row per chat and member. The count is the larger of the rows
  // seen in this pass and the count a surviving row already carried - never their sum, because a
  // delta that re-supplies a row already folded into the survivor would otherwise keep inflating
  // it, and never the pass alone, because a pass over already collapsed rows would reset it to 1.
  const newestRecentByGroup = new Map<string, ChatActivityItem>();
  const rowsByGroup = new Map<string, number>();
  const carriedCountByGroup = new Map<string, number>();
  for (const item of distinct) {
    const groupKey = recentParticipantGroupKey(item);
    if (!groupKey) {
      continue;
    }
    rowsByGroup.set(groupKey, (rowsByGroup.get(groupKey) ?? 0) + 1);
    carriedCountByGroup.set(
      groupKey,
      Math.max(carriedCountByGroup.get(groupKey) ?? 1, carriedCollapsedCount(item))
    );
    const existing = newestRecentByGroup.get(groupKey);
    if (!existing || isNewerActivityItem(item, existing)) {
      newestRecentByGroup.set(groupKey, item);
    }
  }

  return distinct
    .filter((item) => {
      const groupKey = recentParticipantGroupKey(item);
      return !groupKey || newestRecentByGroup.get(groupKey)?.id === item.id;
    })
    .map((item) => {
      const groupKey = recentParticipantGroupKey(item);
      const groupedCount = groupKey
        ? Math.max(rowsByGroup.get(groupKey) ?? 1, carriedCountByGroup.get(groupKey) ?? 1)
        : 1;
      if (groupedCount <= 1) {
        if (item.groupedCount === undefined) {
          return item;
        }
        const { groupedCount: _dropped, ...rest } = item;
        return rest;
      }
      return item.groupedCount === groupedCount ? item : { ...item, groupedCount };
    });
}

/**
 * Cancelled, denied and rejected cards are finished business that lives on the chat card, so they
 * never belong in activity. Rows built before that rule can still arrive from preserved renderer
 * state, and this is the one place every build, merge and refresh path passes through.
 */
function carriedCollapsedCount(item: ChatActivityItem): number {
  const count = item.groupedCount;
  return typeof count === "number" && Number.isFinite(count) && count > 1 ? Math.floor(count) : 1;
}

function isRetainableChatActivityItem(item: ChatActivityItem): boolean {
  return item.status !== "recent" || item.kind === "message";
}

function recentParticipantGroupKey(item: ChatActivityItem): string | undefined {
  if (item.status !== "recent" || item.kind !== "message") {
    return undefined;
  }
  const conversationId = cleanString(item.conversationId);
  const participantId = cleanString(item.participant?.id);
  const participantHandle = cleanHandle(item.participant?.handle).toLowerCase();
  const participantKey = participantId
    ? `id:${participantId.toLowerCase()}`
    : participantHandle
      ? `handle:${participantHandle}`
      : "";
  return conversationId && participantKey ? `${conversationId}:${participantKey}` : undefined;
}

function strongerActivityItem(candidate: ChatActivityItem, existing: ChatActivityItem): boolean {
  const rankDelta = STATUS_RANK[candidate.status] - STATUS_RANK[existing.status];
  if (rankDelta !== 0) {
    return rankDelta < 0;
  }
  // Equal status rank: prefer the newer event. Emission order must not decide, or a
  // stale read card (e.g. a denied approval) permanently hides the unread finished
  // message that shares its run or target message.
  return isNewerActivityItem(candidate, existing);
}

function isNewerActivityItem(candidate: ChatActivityItem, existing: ChatActivityItem): boolean {
  const timeDelta = timeValue(candidate.updatedAt) - timeValue(existing.updatedAt);
  return timeDelta > 0 || (timeDelta === 0 && candidate.id.localeCompare(existing.id) > 0);
}

function newerTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  const leftMs = timeValue(left);
  const rightMs = timeValue(right);
  if (leftMs <= 0) return rightMs > 0 ? right : undefined;
  if (rightMs <= 0) return left;
  return rightMs > leftMs ? right : left;
}

function participantSummaries(conversation: Conversation): Map<string, ChatActivityParticipantSummary> {
  const participants = Array.isArray(conversation.metadata.participants)
    ? conversation.metadata.participants
    : [];
  const map = new Map<string, ChatActivityParticipantSummary>();
  for (const item of participants) {
    const participant = item as Partial<ChatParticipant>;
    const id = cleanString(participant.id);
    const handle = cleanHandle(participant.handle);
    const kind = participant.kind;
    if (!id || !handle || (kind !== "codex-cli" && kind !== "claude-code" && kind !== "gemini-cli")) {
      continue;
    }
    map.set(id, {
      id,
      handle,
      kind,
      roleConfigId: cleanString(participant.roleConfigId) || undefined,
      avatarId: cleanString(participant.avatarId)
    });
  }
  return map;
}

function participantForMessage(
  message: ChatMessage | undefined,
  participants: Map<string, ChatActivityParticipantSummary>
): ChatActivityParticipantSummary | undefined {
  if (!message) {
    return undefined;
  }
  if (message.role === "system") {
    return {
      id: "chat-assistant",
      handle: "assistant",
      kind: "codex-cli",
      roleConfigId: "administrator"
    };
  }
  const participantId = cleanString(message.participantId);
  if (participantId) {
    const participant = participants.get(participantId);
    if (participant) {
      return participant;
    }
  }
  const handle = cleanHandle(message.participantLabel);
  if (!handle) {
    return undefined;
  }
  return {
    id: participantId || handle,
    handle,
    kind: handle.toLowerCase().includes("claude") ? "claude-code" : "codex-cli",
    roleConfigId: isChatAssistantHandle(handle) ? "administrator" : undefined
  };
}

function isChatAssistantHandle(handle: string): boolean {
  const normalized = handle.trim().replace(/^@/, "").toLowerCase();
  return normalized === "assistant" || normalized === "admin";
}

function newestMessageForRun(messages: ChatMessage[], runId: string): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "participant" && cleanString(message.metadata?.runId) === runId) {
      return message;
    }
  }
  return undefined;
}

function newestMessageByCreatedAt(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].sort((left, right) => {
    const timeDelta = timeValue(right.createdAt) - timeValue(left.createdAt);
    return timeDelta || right.id.localeCompare(left.id);
  })[0];
}

function finishedMessageActivityTime(message: ChatMessage): string {
  const createdMs = timeValue(message.createdAt);
  const workedMs = typeof message.metadata?.workedMs === "number" && Number.isFinite(message.metadata.workedMs)
    ? Math.max(0, message.metadata.workedMs)
    : undefined;
  if (createdMs > 0 && workedMs !== undefined) {
    return new Date(createdMs + workedMs).toISOString();
  }
  const remoteUpdatedAt = message.metadata?.remoteRunStatus?.phase === "terminal"
    ? cleanString(message.metadata.remoteRunStatus.updatedAt)
    : "";
  return remoteUpdatedAt || message.createdAt;
}

function chatAppToolApprovals(value: unknown): ChatAppToolApproval[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ChatAppToolApproval => {
    const approval = item as Partial<ChatAppToolApproval>;
    return Boolean(
      approval &&
      typeof approval.id === "string" &&
      typeof approval.requesterParticipantId === "string" &&
      typeof approval.toolName === "string" &&
      typeof approval.status === "string" &&
      typeof approval.createdAt === "string" &&
      typeof approval.updatedAt === "string"
    );
  });
}

function threadRootIdForMessage(message: ChatMessage | undefined): string | undefined {
  return cleanString(message?.metadata?.chatThreadRootId)
    || cleanString(message?.metadata?.parentMessageId)
    || undefined;
}

function participantRequestPreview(message: ChatMessage): string {
  const requests = message.metadata?.participantRequest?.items;
  if (!Array.isArray(requests) || requests.length === 0) {
    return "A member request is waiting for approval.";
  }
  return requests.map((request) => `@${cleanHandle(request.targetHandle)}`).filter(Boolean).join(", ");
}

function previewText(value: unknown): string {
  return cleanString(value)
    .replace(/\s+/g, " ")
    .slice(0, 220);
}

function cleanHandle(value: unknown): string {
  return cleanString(value).replace(/^@+/, "");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timeValue(value: string | Date | undefined): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
