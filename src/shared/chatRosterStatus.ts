import { readActiveRunParticipants, readParticipantCompactions } from "./chatRunState";
import type { ChatParticipantRosterStatus } from "./chatParticipantStatus";
import type { ChatAppToolApproval, Conversation } from "./types";

type NonIdleRosterStatus = Exclude<ChatParticipantRosterStatus, "idle">;

const STATUS_RANK: Record<NonIdleRosterStatus, number> = {
  error: 1,
  stopped: 2,
  pending: 3,
  compacting: 4,
  running: 5
};

export function buildChatParticipantStatusMap(activeChatConversation: Conversation | undefined): Map<string, ChatParticipantRosterStatus> {
  const statuses = new Map<string, ChatParticipantRosterStatus>();
  if (!activeChatConversation) {
    return statuses;
  }

  const participantIds = chatParticipantIds(activeChatConversation);
  const setStatus = (participantId: string, status: NonIdleRosterStatus): void => {
    if (!participantIds.has(participantId)) {
      return;
    }
    const current = statuses.get(participantId);
    const currentRank = current && current !== "idle" ? STATUS_RANK[current] : 0;
    if (STATUS_RANK[status] > currentRank) {
      statuses.set(participantId, status);
    }
  };

  const liveRunIds = activeRunIdsForConversation(activeChatConversation);
  const compactingRunIds = new Set<string>();
  const compacting = readParticipantCompactions(activeChatConversation.metadata);
  for (const [participantId, state] of Object.entries(compacting)) {
    if (liveRunIds.has(state.runId)) {
      compactingRunIds.add(state.runId);
      setStatus(participantId, "compacting");
    }
  }

  const localRunParticipants = readActiveRunParticipants(activeChatConversation.metadata);
  const remoteRunParticipants = activeRemoteRunParticipants(activeChatConversation.metadata, liveRunIds);
  for (const runId of liveRunIds) {
    if (compactingRunIds.has(runId)) {
      continue;
    }
    const participantId = localRunParticipants.get(runId) ?? remoteRunParticipants.get(runId);
    if (participantId) {
      setStatus(participantId, "running");
    }
  }

  const latestTerminalParticipantIds = new Set<string>();
  for (let index = activeChatConversation.messages.length - 1; index >= 0; index -= 1) {
    const message = activeChatConversation.messages[index];
    if (message.role !== "participant" || !message.participantId || message.status === "pending" || latestTerminalParticipantIds.has(message.participantId)) {
      continue;
    }
    latestTerminalParticipantIds.add(message.participantId);
    if (message.status === "error") {
      setStatus(message.participantId, message.metadata?.terminalReason === "user-stopped" ? "stopped" : "error");
    }
  }

  for (const message of activeChatConversation.messages) {
    const participantRequest = message.metadata?.participantRequest;
    if (participantRequest) {
      for (const item of participantRequest.items) {
        if (item.status === "pending_approval") {
          setStatus(item.targetParticipantId, "pending");
        }
      }
    }
    if (message.participantId) {
      if (message.metadata?.pendingChoice?.status === "pending") {
        setStatus(message.participantId, "pending");
      }
      if (message.metadata?.pendingMentions?.some((mention) => mention.status === "pending")) {
        setStatus(message.participantId, "pending");
      }
    }
    const runId = message.metadata?.runId;
    if (
      message.role === "participant" &&
      message.status === "pending" &&
      message.participantId &&
      typeof runId === "string" &&
      liveRunIds.has(runId) &&
      !compactingRunIds.has(runId)
    ) {
      setStatus(message.participantId, "running");
    }
  }

  for (const approval of chatAppToolApprovals(activeChatConversation)) {
    if (approval.status === "pending") {
      setStatus(approval.requesterParticipantId, "pending");
    }
  }

  return statuses;
}

export function activeRunIdsForConversation(conversation: Pick<Conversation, "metadata">): Set<string> {
  const metadata = conversation.metadata;
  const activeRunIds = Array.isArray(metadata.activeRunIds)
    ? metadata.activeRunIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const compatibilityRunId = typeof metadata.runId === "string" && metadata.runId.trim()
    ? metadata.runId
    : undefined;
  return new Set([
    ...activeRunIds,
    ...(compatibilityRunId ? [compatibilityRunId] : [])
  ]);
}

function chatParticipantIds(conversation: Conversation): Set<string> {
  const participants = conversation.metadata.participants;
  const ids = new Set<string>();
  if (!Array.isArray(participants)) {
    return ids;
  }
  for (const item of participants) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) {
      ids.add(id);
    }
  }
  return ids;
}

function activeRemoteRunParticipants(metadata: Record<string, unknown>, liveRunIds: Set<string>): Map<string, string> {
  const handles = metadata.remoteRunHandles;
  const participants = new Map<string, string>();
  if (!handles || typeof handles !== "object" || Array.isArray(handles)) {
    return participants;
  }
  for (const [runId, raw] of Object.entries(handles as Record<string, unknown>)) {
    if (!liveRunIds.has(runId) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
      continue;
    }
    const participantId = typeof record.participantId === "string" ? record.participantId.trim() : "";
    if (participantId) {
      participants.set(runId, participantId);
    }
  }
  return participants;
}

function chatAppToolApprovals(conversation: Conversation): ChatAppToolApproval[] {
  const value = conversation.metadata.pendingAppToolApprovals;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ChatAppToolApproval => {
    const approval = item as Partial<ChatAppToolApproval>;
    return (
      typeof approval.requesterParticipantId === "string" &&
      (approval.status === "pending" || approval.status === "approved" || approval.status === "denied" || approval.status === "auto-applied")
    );
  });
}
