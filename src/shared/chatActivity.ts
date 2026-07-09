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
    const message = newestMessageForRun(conversation.messages, runId);
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
    if (message.role !== "participant" || message.status !== "done") {
      continue;
    }
    const runId = cleanString(message.metadata?.runId);
    if (!runId || runningRunIds.has(runId)) {
      continue;
    }
    const updatedAt = message.createdAt;
    const updatedMs = timeValue(updatedAt);
    if (updatedMs <= 0 || updatedMs < recentCutoffMs || (lastViewedMs > 0 && updatedMs <= lastViewedMs)) {
      continue;
    }
    const participant = participantForMessage(message, participants);
    items.push({
      id: `recent:${conversation.id}:${runId || message.id}`,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      repoPath: conversation.repoPath,
      status: "recent",
      kind: "message",
      title: participant ? `@${participant.handle} recently finished` : "Recent activity",
      preview: previewText(message.content) || "A participant posted an update.",
      createdAt: message.createdAt,
      updatedAt,
      participant,
      target: {
        runId,
        messageId: message.id,
        threadRootId: threadRootIdForMessage(message)
      }
    });
  }

  return sortChatActivityItems(dedupeChatActivityItems(items));
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
  participants: Map<string, ChatActivityParticipantSummary>
): ChatActivityItem[] {
  const approvals = chatAppToolApprovals(conversation.metadata.pendingAppToolApprovals);
  return approvals.flatMap((approval) => {
    if (approval.status !== "pending") {
      return [];
    }
    const participant = participants.get(approval.requesterParticipantId);
    const triggerMessageId = cleanString(approval.resumeContext?.triggerMessageId);
    const targetMessage = timelineMessageForApproval(conversation.messages, approval, triggerMessageId);
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
  const exact = triggerMessageId
    ? messages.find((message) => message.id === triggerMessageId && message.role !== "system")
    : undefined;
  if (exact) {
    return exact;
  }
  const approvalMs = timeValue(approval.createdAt);
  const requesterParticipantId = cleanString(approval.requesterParticipantId);
  const visibleMessages = messages.filter((message) =>
    message.role !== "system" &&
    (!approvalMs || timeValue(message.createdAt) <= approvalMs)
  );
  const requesterMessages = requesterParticipantId
    ? visibleMessages.filter((message) => cleanString(message.participantId) === requesterParticipantId)
    : [];
  return newestMessageByCreatedAt(requesterMessages)
    ?? newestMessageByCreatedAt(visibleMessages)
    ?? newestMessageByCreatedAt(messages.filter((message) => message.role !== "system"));
}

function pendingMessageItems(
  conversation: Conversation,
  message: ChatMessage,
  participants: Map<string, ChatActivityParticipantSummary>
): ChatActivityItem[] {
  const items: ChatActivityItem[] = [];
  const participant = participantForMessage(message, participants);
  const runId = cleanString(message.metadata?.runId);
  const target = {
    ...(runId ? { runId } : {}),
    messageId: message.id,
    threadRootId: threadRootIdForMessage(message)
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
      preview: previewText(message.content) || message.metadata.pendingChoice.question || "A participant is waiting for a choice.",
      createdAt: message.createdAt,
      updatedAt,
      participant,
      target
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
      preview: previewText(message.content) || pendingMentions.map((mention) => `@${mention.targetHandle}`).join(", "),
      createdAt: message.createdAt,
      updatedAt,
      participant,
      target
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
      preview: previewText(message.content) || participantRequestPreview(message),
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
  for (const item of items) {
    byId.set(item.id, item);
    const runId = cleanString(item.target.runId);
    if (!runId) {
      continue;
    }
    const existing = strongestByRun.get(runId);
    if (!existing || STATUS_RANK[item.status] < STATUS_RANK[existing.status]) {
      strongestByRun.set(runId, item);
    }
  }

  return [...byId.values()].filter((item) => {
    const runId = cleanString(item.target.runId);
    if (!runId || item.status !== "recent") {
      return true;
    }
    return strongestByRun.get(runId)?.id === item.id;
  });
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
    kind: handle.toLowerCase().includes("claude") ? "claude-code" : "codex-cli"
  };
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
