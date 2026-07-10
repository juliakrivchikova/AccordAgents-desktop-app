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

const STATUS_RANK: Record<ChatActivityItem["status"], number> = {
  pending: 0,
  running: 1,
  recent: 2
};

export interface BuildChatActivityItemsOptions {
  now?: string | Date;
  lastViewedAt?: string;
  recentWindowDays?: number;
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

  items.push(...pendingApprovalItems(conversation, participants, recentCutoffMs));
  for (const message of conversation.messages) {
    items.push(...pendingMessageItems(conversation, message, participants, recentCutoffMs));
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
      preview: previewText(message?.content) || "A participant run is in progress.",
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
      preview: previewText(message.content) || "A participant posted an update.",
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

  return sortChatActivityItems(dedupeChatActivityItems(items));
}

export function applyChatActivityItemPreferences(
  items: ChatActivityItem[],
  options: ApplyChatActivityItemPreferencesOptions = {}
): ChatActivityItem[] {
  const readItemIds = options.readItemIds ?? new Set<string>();
  const clearedItemIds = options.clearedItemIds ?? new Set<string>();
  return items
    .filter((item) => !clearedItemIds.has(item.id))
    .map((item) => item.read === true || !readItemIds.has(item.id) ? item : { ...item, read: true });
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
  return items.slice(0, normalizedLimit);
}

function pendingApprovalItems(
  conversation: Conversation,
  participants: Map<string, ChatActivityParticipantSummary>,
  recentCutoffMs: number
): ChatActivityItem[] {
  const approvals = chatAppToolApprovals(conversation.metadata.pendingAppToolApprovals);
  return approvals.flatMap((approval) => {
    if (approval.status !== "pending" && approval.status !== "denied") {
      return [];
    }
    const triggerMessageId = cleanString(approval.resumeContext?.triggerMessageId);
    const targetMessage = timelineMessageForApproval(conversation.messages, approval, triggerMessageId);
    const participant = participantForMessage(targetMessage, participants)
      ?? participants.get(approval.requesterParticipantId);
    const messageId = targetMessage?.id ?? triggerMessageId;
    const cancelled = approval.status === "denied";
    if (cancelled && timeValue(approval.updatedAt) < recentCutoffMs) {
      return [];
    }
    return [{
      id: `approval:${conversation.id}:${approval.id}`,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      repoPath: conversation.repoPath,
      status: cancelled ? "recent" as const : "pending" as const,
      ...(cancelled ? { read: true } : {}),
      kind: "approval" as const,
      title: participant ? `@${participant.handle} needs approval` : "Approval required",
      preview: previewText(targetMessage?.content) || approval.summary || approval.toolName || "A tool request is waiting for approval.",
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
      participant,
      target: {
        approvalId: approval.id,
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
  participants: Map<string, ChatActivityParticipantSummary>,
  recentCutoffMs: number
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
      preview: previewText(targetMessage.content) || message.metadata.pendingChoice.question || "A participant is waiting for a choice.",
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
  if (message.metadata?.pendingChoice?.status === "cancelled") {
    const terminalAt = message.metadata.pendingChoice.cancelledAt || updatedAt;
    if (timeValue(terminalAt) < recentCutoffMs) {
      return items;
    }
    items.push({
      id: `choice:${conversation.id}:${message.id}:${message.metadata.pendingChoice.id}`,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      repoPath: conversation.repoPath,
      status: "recent",
      read: true,
      kind: "choice",
      title: message.metadata.pendingChoice.title || "Choice cancelled",
      preview: previewText(targetMessage.content) || message.metadata.pendingChoice.question || "A participant choice was cancelled.",
      createdAt: message.createdAt,
      updatedAt: terminalAt,
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
  const rejectedMentions = Array.isArray(message.metadata?.pendingMentions)
    ? message.metadata.pendingMentions.filter((mention) => mention.status === "rejected")
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
  if (pendingMentions.length === 0 && rejectedMentions.length > 0) {
    const terminalAt = newestMentionTimestamp(rejectedMentions) || conversation.updatedAt;
    if (timeValue(terminalAt) < recentCutoffMs) {
      return items;
    }
    items.push({
      id: `mention:${conversation.id}:${message.id}`,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      repoPath: conversation.repoPath,
      status: "recent",
      read: true,
      kind: "mention",
      title: "Mention approval cancelled",
      preview: previewText(targetMessage.content) || rejectedMentions.map((mention) => `@${mention.targetHandle}`).join(", "),
      createdAt: message.createdAt,
      updatedAt: terminalAt,
      participant,
      target: {
        ...target,
        sourceMessageId: message.id,
        mentionTargetParticipantIds: rejectedMentions.map((mention) => mention.targetParticipantId)
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
      title: "Participant request approval required",
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
  const newestRecentByParticipant = new Map<string, ChatActivityItem>();
  for (const item of items) {
    byId.set(item.id, item);
    const messageId = cleanString(item.target.messageId);
    if (messageId) {
      const existingMessageItem = strongestByMessage.get(messageId);
      if (!existingMessageItem || STATUS_RANK[item.status] < STATUS_RANK[existingMessageItem.status]) {
        strongestByMessage.set(messageId, item);
      }
    }
    const runId = cleanString(item.target.runId);
    if (!runId) {
      continue;
    }
    const existing = strongestByRun.get(runId);
    if (!existing || STATUS_RANK[item.status] < STATUS_RANK[existing.status]) {
      strongestByRun.set(runId, item);
    }
  }
  for (const item of byId.values()) {
    const groupKey = recentParticipantGroupKey(item);
    if (!groupKey) {
      continue;
    }
    const existing = newestRecentByParticipant.get(groupKey);
    if (!existing || isNewerActivityItem(item, existing)) {
      newestRecentByParticipant.set(groupKey, item);
    }
  }

  return [...byId.values()].filter((item) => {
    const messageId = cleanString(item.target.messageId);
    if (messageId && item.kind === "message" && item.status === "recent" && strongestByMessage.get(messageId)?.id !== item.id) {
      return false;
    }
    const runId = cleanString(item.target.runId);
    if (!runId || item.status !== "recent") {
      const groupKey = recentParticipantGroupKey(item);
      return !groupKey || newestRecentByParticipant.get(groupKey)?.id === item.id;
    }
    if (strongestByRun.get(runId)?.id !== item.id) {
      return false;
    }
    const groupKey = recentParticipantGroupKey(item);
    return !groupKey || newestRecentByParticipant.get(groupKey)?.id === item.id;
  });
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

function isNewerActivityItem(candidate: ChatActivityItem, existing: ChatActivityItem): boolean {
  const timeDelta = timeValue(candidate.updatedAt) - timeValue(existing.updatedAt);
  return timeDelta > 0 || (timeDelta === 0 && candidate.id.localeCompare(existing.id) > 0);
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
    if (!id || !handle || (kind !== "codex-cli" && kind !== "claude-code")) {
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
    return "A participant request is waiting for approval.";
  }
  return requests.map((request) => `@${cleanHandle(request.targetHandle)}`).filter(Boolean).join(", ");
}

function newestMentionTimestamp(mentions: Array<{ approvedAt?: string; rejectedAt?: string; updatedAt?: string; createdAt?: string }>): string | undefined {
  return mentions
    .map((mention) => mention.rejectedAt || mention.approvedAt || mention.updatedAt || mention.createdAt)
    .filter((value): value is string => Boolean(cleanString(value)))
    .sort((left, right) => timeValue(right) - timeValue(left))[0];
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
