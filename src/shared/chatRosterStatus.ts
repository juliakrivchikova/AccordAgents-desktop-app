import { activeRunSummaryForConversation } from "./chatActiveRuns";
import { readParticipantCompactions } from "./chatRunState";
import type { ChatParticipantRosterStatus } from "./chatParticipantStatus";
import type { ChatAppToolApproval, Conversation } from "./types";

export { activeRunIdsForConversation, activeRunSummaryForConversation } from "./chatActiveRuns";

type NonIdleRosterStatus = Exclude<ChatParticipantRosterStatus, "idle">;

const STATUS_RANK: Record<NonIdleRosterStatus, number> = {
  error: 1,
  stopped: 2,
  background: 3,
  pending: 4,
  compacting: 5,
  running: 6
};

/** `backgroundTasks`: live background work by member (see
 *  ChatService.backgroundTasksForConversation); a member with some and nothing
 *  more pressing shows as working in the background. */
export function buildChatParticipantStatusMap(
  activeChatConversation: Conversation | undefined,
  backgroundTasks?: ReadonlyMap<string, readonly string[]>
): Map<string, ChatParticipantRosterStatus> {
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

  for (const [participantId, labels] of backgroundTasks ?? []) {
    if (labels.length > 0) {
      setStatus(participantId, "background");
    }
  }

  const activeRuns = activeRunSummaryForConversation(activeChatConversation);
  const liveRunIds = new Set(activeRuns.runIds);
  const compactingRunIds = new Set<string>();
  const compacting = readParticipantCompactions(activeChatConversation.metadata);
  for (const [participantId, state] of Object.entries(compacting)) {
    if (liveRunIds.has(state.runId)) {
      compactingRunIds.add(state.runId);
      setStatus(participantId, "compacting");
    }
  }

  for (const [runId, participantId] of activeRuns.participantIdsByRunId) {
    if (compactingRunIds.has(runId)) {
      continue;
    }
    setStatus(participantId, "running");
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
    const runId = typeof message.metadata?.runId === "string" ? message.metadata.runId.trim() : "";
    if (
      message.role === "participant" &&
      message.status === "pending" &&
      message.participantId &&
      runId &&
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

/** Members whose own work in this chat is still live, as the chat's saved
 *  state shows it: a turn (also one queued behind its earlier turn, or one
 *  another device runs, by its pending reply), a compaction, or a member
 *  request still running that it asked or answers. Only these members'
 *  settings and removal wait for that work to end; any other member can be
 *  added, changed, compacted or removed meanwhile. ChatService adds the work
 *  only its own process knows about (memberHasLiveWork). */
export function chatMemberIdsWithLiveWork(conversation: Pick<Conversation, "metadata" | "messages">): Set<string> {
  const ids = new Set<string>();
  const activeRuns = activeRunSummaryForConversation(conversation);
  for (const participantId of activeRuns.participantIds) {
    ids.add(participantId);
  }
  const liveRunIds = new Set(activeRuns.runIds);
  for (const [participantId, state] of Object.entries(readParticipantCompactions(conversation.metadata))) {
    if (liveRunIds.has(state.runId)) {
      ids.add(participantId);
    }
  }
  for (const message of conversation.messages) {
    if (message.role === "participant" && message.status === "pending" && message.participantId) {
      ids.add(message.participantId);
    }
    const participantRequest = message.metadata?.participantRequest;
    if (!participantRequest) {
      continue;
    }
    for (const item of participantRequest.items) {
      if (item.status === "running") {
        ids.add(item.targetParticipantId);
        ids.add(participantRequest.requesterParticipantId);
      } else if (item.status === "resuming_requester") {
        ids.add(participantRequest.requesterParticipantId);
      }
    }
  }
  return ids;
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
