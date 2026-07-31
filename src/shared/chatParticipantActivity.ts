import { activeRunSummaryForConversation } from "./chatActiveRuns";
import { buildChatParticipantStatusMap } from "./chatRosterStatus";
import { readParticipantCompactions } from "./chatRunState";
import { isChatMessageHiddenFromTimeline } from "./chatTimelineVisibility";
import type { ChatParticipantRosterStatus } from "./chatParticipantStatus";
import type {
  ChatAppToolApproval,
  ChatMessage,
  ChatParticipant,
  ChatParticipantActiveWork,
  ChatParticipantActivitySnapshot,
  Conversation,
  RemoteRunHandle
} from "./types";

const ACTIVE_RUN_OWNERS_KEY = "activeRunOwnersByRunId";
const ACTIVE_ROSTER_STATUSES = new Set<ChatParticipantRosterStatus>(["running", "pending", "compacting"]);

interface RunOwnerState {
  startedAt: string;
  updatedAt: string;
}

export function buildChatParticipantActivitySnapshot(
  conversation: Conversation,
  snapshotAt = new Date().toISOString()
): ChatParticipantActivitySnapshot {
  const participants = chatParticipants(conversation);
  const participantIds = new Set(participants.map((participant) => participant.id));
  const statuses = buildChatParticipantStatusMap(conversation);
  const activeWorkByParticipantId = new Map<string, ChatParticipantActiveWork[]>(
    participants.map((participant) => [participant.id, []])
  );
  const activeRuns = activeRunSummaryForConversation(conversation);
  const liveRunIds = new Set(activeRuns.runIds);
  const compactions = readParticipantCompactions(conversation.metadata);
  const compactionRunIds = new Set<string>();
  const remoteRuns = remoteRunHandles(conversation);
  const runOwners = activeRunOwners(conversation);

  for (const [participantId, compaction] of Object.entries(compactions)) {
    if (!participantIds.has(participantId) || !liveRunIds.has(compaction.runId)) {
      continue;
    }
    compactionRunIds.add(compaction.runId);
    const message = newestMessageForRun(conversation.messages, compaction.runId, participantId);
    addActiveWork(activeWorkByParticipantId, participantId, {
      kind: "compaction",
      status: "running",
      phase: "compacting",
      runId: compaction.runId,
      ...messageContext(conversation, message),
      startedAt: compaction.startedAt,
      lastActivityAt: latestTimestamp([
        compaction.startedAt,
        ...messageActivityTimestamps(message)
      ], compaction.startedAt)
    });
  }

  for (const runId of activeRuns.runIds) {
    if (compactionRunIds.has(runId)) {
      continue;
    }
    const participantId = activeRuns.participantIdsByRunId.get(runId);
    if (!participantId || !participantIds.has(participantId)) {
      continue;
    }
    const message = newestMessageForRun(conversation.messages, runId, participantId);
    const remoteRun = remoteRuns[runId];
    const owner = runOwners[runId];
    const remoteStatus = message?.metadata?.remoteRunStatus;
    const startedAt = earliestTimestamp([
      remoteRun?.startedAt,
      remoteStatus?.startedAt,
      owner?.startedAt,
      message?.createdAt
    ], snapshotAt);
    addActiveWork(activeWorkByParticipantId, participantId, {
      kind: "run",
      status: remoteRun?.status ?? "running",
      ...(remoteStatus?.phase ? { phase: remoteStatus.phase } : {}),
      runId,
      ...messageContext(conversation, message),
      startedAt,
      lastActivityAt: latestTimestamp([
        startedAt,
        remoteRun?.updatedAt,
        remoteRun?.lastPolledAt,
        remoteStatus?.updatedAt,
        owner?.updatedAt,
        ...messageActivityTimestamps(message)
      ], startedAt),
      ...(remoteRun?.error ? { error: remoteRun.error } : {})
    });
  }

  for (const message of conversation.messages) {
    const batch = message.metadata?.participantRequest;
    if (batch?.status === "resuming_requester" && participantIds.has(batch.requesterParticipantId)) {
      addActiveWork(activeWorkByParticipantId, batch.requesterParticipantId, {
        kind: "participant_request",
        status: "resuming_requester",
        requestId: batch.id,
        ...messageContext(conversation, message),
        startedAt: batch.createdAt,
        lastActivityAt: batch.updatedAt,
        ...(batch.error ? { error: batch.error } : {})
      });
    }
    if (!batch) {
      continue;
    }
    for (const item of batch.items) {
      if (
        !participantIds.has(item.targetParticipantId) ||
        (item.status !== "pending_approval" && item.status !== "running")
      ) {
        continue;
      }
      addActiveWork(activeWorkByParticipantId, item.targetParticipantId, {
        kind: "participant_request",
        status: item.status,
        requestId: batch.id,
        ...messageContext(conversation, message),
        startedAt: item.createdAt,
        lastActivityAt: item.updatedAt,
        ...(item.error ? { error: item.error } : {}),
        ...(item.status === "pending_approval"
          ? {
              approvalDependency: {
                type: "user",
                summary: `Approval required to request @${item.targetHandle}.`
              } as const
            }
          : {})
      });
    }
  }

  for (const approval of pendingAppToolApprovals(conversation)) {
    if (!participantIds.has(approval.requesterParticipantId)) {
      continue;
    }
    const message = messageForApproval(conversation.messages, approval);
    addActiveWork(activeWorkByParticipantId, approval.requesterParticipantId, {
      kind: "approval",
      status: "pending",
      approvalType: "app_tool",
      requestId: approval.id,
      ...messageContext(conversation, message, approval.resumeContext?.triggerMessageId),
      startedAt: approval.createdAt,
      lastActivityAt: approval.updatedAt,
      ...(approval.error ? { error: approval.error } : {}),
      approvalDependency: {
        type: "user",
        summary: approval.summary
      }
    });
  }

  for (const message of conversation.messages) {
    const participantId = message.participantId;
    if (!participantId || !participantIds.has(participantId)) {
      continue;
    }
    const choice = message.metadata?.pendingChoice;
    if (choice?.status === "pending") {
      addActiveWork(activeWorkByParticipantId, participantId, {
        kind: "approval",
        status: "pending",
        approvalType: "pending_choice",
        requestId: choice.id,
        ...messageContext(conversation, message),
        startedAt: message.createdAt,
        lastActivityAt: message.createdAt,
        approvalDependency: {
          type: "user",
          summary: choice.question
        }
      });
    }
    for (const mention of message.metadata?.pendingMentions ?? []) {
      if (mention.status !== "pending") {
        continue;
      }
      addActiveWork(activeWorkByParticipantId, participantId, {
        kind: "approval",
        status: "pending",
        approvalType: "pending_mention",
        ...messageContext(conversation, message),
        startedAt: message.createdAt,
        lastActivityAt: message.createdAt,
        approvalDependency: {
          type: "participant",
          participantId: mention.targetParticipantId,
          handle: mention.targetHandle,
          summary: `Approval required to notify @${mention.targetHandle}.`
        }
      });
    }
  }

  const statusCounts: Record<ChatParticipantRosterStatus, number> = {
    idle: 0,
    running: 0,
    pending: 0,
    compacting: 0,
    stopped: 0,
    error: 0
  };
  const entries = participants.map((participant) => {
    const status = statuses.get(participant.id) ?? "idle";
    statusCounts[status] += 1;
    return {
      participantId: participant.id,
      handle: participant.handle,
      provider: participant.kind,
      model: participant.model?.trim() || null,
      status,
      activeWork: sortActiveWork(activeWorkByParticipantId.get(participant.id) ?? []),
      lastFinishedMessage: lastFinishedMessage(conversation, participant.id)
    };
  });

  return {
    snapshotAt,
    hasActiveParticipants: entries.some((entry) => ACTIVE_ROSTER_STATUSES.has(entry.status)),
    statusCounts,
    participants: entries
  };
}

function chatParticipants(conversation: Conversation): ChatParticipant[] {
  const raw = conversation.metadata.participants;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is ChatParticipant => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
    const participant = item as Partial<ChatParticipant>;
    return (
      typeof participant.id === "string" &&
      Boolean(participant.id.trim()) &&
      typeof participant.handle === "string" &&
      Boolean(participant.handle.trim()) &&
      (participant.kind === "codex-cli" || participant.kind === "claude-code" || participant.kind === "gemini-cli")
    );
  });
}

function addActiveWork(
  byParticipantId: Map<string, ChatParticipantActiveWork[]>,
  participantId: string,
  work: ChatParticipantActiveWork
): void {
  byParticipantId.get(participantId)?.push(work);
}

function newestMessageForRun(
  messages: ChatMessage[],
  runId: string,
  participantId: string
): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.participantId === participantId && message.metadata?.runId?.trim() === runId) {
      return message;
    }
  }
  return undefined;
}

function messageContext(
  conversation: Conversation,
  message: ChatMessage | undefined,
  fallbackMessageId?: string
): Pick<ChatParticipantActiveWork, "messageId" | "threadId" | "parentMessageId" | "chatThreadRootId"> {
  const fallback = fallbackMessageId
    ? conversation.messages.find((candidate) => candidate.id === fallbackMessageId)
    : undefined;
  const contextMessage = message ?? fallback;
  const originId = cleanString(contextMessage?.metadata?.sourceMessageId)
    || cleanString(contextMessage?.metadata?.parentMessageId)
    || cleanString(fallbackMessageId)
    || cleanString(contextMessage?.id);
  const origin = originId
    ? conversation.messages.find((candidate) => candidate.id === originId)
    : undefined;
  const originMetadata = origin?.metadata;
  const contextMetadata = contextMessage?.metadata;
  const threadId = cleanString(originMetadata?.threadId) || cleanString(contextMetadata?.threadId);
  const parentMessageId = cleanString(originMetadata?.parentMessageId)
    || cleanString(contextMetadata?.parentMessageId);
  const chatThreadRootId = cleanString(originMetadata?.chatThreadRootId)
    || cleanString(contextMetadata?.chatThreadRootId);
  return {
    ...(originId ? { messageId: originId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
    ...(chatThreadRootId ? { chatThreadRootId } : {})
  };
}

function messageActivityTimestamps(message: ChatMessage | undefined): string[] {
  if (!message) {
    return [];
  }
  return [
    message.createdAt,
    message.metadata?.processingTranscript?.capturedAt,
    message.metadata?.remoteRunStatus?.updatedAt,
    ...(message.metadata?.activityEvents ?? []).map((event) => event.createdAt)
  ].filter((value): value is string => Boolean(cleanString(value)));
}

function remoteRunHandles(conversation: Conversation): Record<string, RemoteRunHandle> {
  const raw = conversation.metadata.remoteRunHandles;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const handles: Record<string, RemoteRunHandle> = {};
  for (const [runId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const handle = value as Partial<RemoteRunHandle>;
    if (
      typeof handle.participantId === "string" &&
      typeof handle.startedAt === "string" &&
      typeof handle.updatedAt === "string" &&
      (handle.status === "running" || handle.status === "unknown")
    ) {
      handles[runId] = handle as RemoteRunHandle;
    }
  }
  return handles;
}

function activeRunOwners(conversation: Conversation): Record<string, RunOwnerState> {
  const raw = conversation.metadata[ACTIVE_RUN_OWNERS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const owners: Record<string, RunOwnerState> = {};
  for (const [runId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    const startedAt = cleanString(record.startedAt);
    if (startedAt) {
      owners[runId] = {
        startedAt,
        updatedAt: cleanString(record.updatedAt) || startedAt
      };
    }
  }
  return owners;
}

function pendingAppToolApprovals(conversation: Conversation): ChatAppToolApproval[] {
  const raw = conversation.metadata.pendingAppToolApprovals;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is ChatAppToolApproval => {
    const approval = item as Partial<ChatAppToolApproval>;
    return approval.status === "pending" && typeof approval.requesterParticipantId === "string";
  });
}

function messageForApproval(
  messages: ChatMessage[],
  approval: ChatAppToolApproval
): ChatMessage | undefined {
  const triggerMessageId = cleanString(approval.resumeContext?.triggerMessageId);
  return triggerMessageId
    ? messages.find((message) => message.id === triggerMessageId)
    : undefined;
}

function lastFinishedMessage(
  conversation: Conversation,
  participantId: string
): {
  messageId: string;
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
  sequence: number;
  createdAt: string;
  status: "done" | "error";
  terminalReason?: string;
  content: string;
} | null {
  for (let sequence = conversation.messages.length - 1; sequence >= 0; sequence -= 1) {
    const message = conversation.messages[sequence];
    if (
      message.role !== "participant" ||
      message.participantId !== participantId ||
      message.status === "pending" ||
      isChatMessageHiddenFromTimeline(message)
    ) {
      continue;
    }
    return {
      messageId: message.id,
      ...(cleanString(message.metadata?.threadId) ? { threadId: cleanString(message.metadata?.threadId) } : {}),
      ...(cleanString(message.metadata?.parentMessageId)
        ? { parentMessageId: cleanString(message.metadata?.parentMessageId) }
        : {}),
      ...(cleanString(message.metadata?.chatThreadRootId)
        ? { chatThreadRootId: cleanString(message.metadata?.chatThreadRootId) }
        : {}),
      sequence,
      createdAt: message.createdAt,
      status: message.status === "error" ? "error" : "done",
      ...(message.metadata?.terminalReason ? { terminalReason: message.metadata.terminalReason } : {}),
      content: message.content
    };
  }
  return null;
}

function sortActiveWork(work: ChatParticipantActiveWork[]): ChatParticipantActiveWork[] {
  return [...work].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt)
    || left.kind.localeCompare(right.kind)
    || cleanString("runId" in left ? left.runId : "requestId" in left ? left.requestId : "").localeCompare(
      cleanString("runId" in right ? right.runId : "requestId" in right ? right.requestId : "")
    )
  );
}

function earliestTimestamp(values: Array<string | undefined>, fallback: string): string {
  const valid = values.filter((value): value is string => isTimestamp(value));
  return valid.sort((left, right) => timeValue(left) - timeValue(right))[0] ?? fallback;
}

function latestTimestamp(values: Array<string | undefined>, fallback: string): string {
  const valid = values.filter((value): value is string => isTimestamp(value));
  return valid.sort((left, right) => timeValue(right) - timeValue(left))[0] ?? fallback;
}

function isTimestamp(value: string | undefined): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function timeValue(value: string): number {
  return Date.parse(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
