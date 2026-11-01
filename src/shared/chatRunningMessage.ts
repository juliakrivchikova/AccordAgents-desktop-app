import { activeRunSummaryForConversation } from "./chatActiveRuns";
import { isChatMessageHiddenFromTimeline } from "./chatTimelineVisibility";
import type { ChatMessage, ChatRunningMessageTarget, Conversation } from "./types";

type ConversationRunState = Pick<Conversation, "metadata" | "messages">;

/** The member's message that is in progress right now: the pending reply of
 *  one of its live runs. Anything the member posted during the turn is not it
 *  (those posts are newer than the turn's own message, which is why "the
 *  member's newest message" opened the wrong one), and neither is a turn
 *  waiting behind it. A waiting turn is marked here, but the mark is local to
 *  the computer that runs the member (a chat read from the User's server has
 *  none), so the rule does not depend on it: a member's turns run one after
 *  another, and the one in progress is the one started first. The phone uses
 *  the same rule. Undefined when no such message is in
 *  `conversation.messages`: the member is not running, or the message is not
 *  loaded. */
export function runningMessageForParticipant(
  conversation: ConversationRunState,
  participantId: string
): ChatMessage | undefined {
  const id = participantId.trim();
  if (!id) {
    return undefined;
  }
  const activeRuns = activeRunSummaryForConversation(conversation);
  const liveRunIds = new Set(activeRuns.runIdsByParticipantId.get(id) ?? []);
  if (liveRunIds.size === 0) {
    return undefined;
  }
  let running: ChatMessage | undefined;
  for (const message of conversation.messages) {
    if (message.role !== "participant" || message.status !== "pending" || message.metadata?.queuedBehind) {
      continue;
    }
    const runId = typeof message.metadata?.runId === "string" ? message.metadata.runId.trim() : "";
    if (!runId || !liveRunIds.has(runId) || (message.participantId?.trim() || activeRuns.participantIdsByRunId.get(runId)) !== id) {
      continue;
    }
    if (isChatMessageHiddenFromTimeline(message)) {
      continue;
    }
    if (!running || isStartedEarlier(message, running)) {
      running = message;
    }
  }
  return running;
}

export function runningMessageTarget(message: ChatMessage): ChatRunningMessageTarget {
  // Only a real thread reply carries `chatThreadRootId`; `parentMessageId` is
  // causal lineage and also set on replies shown inline in the main timeline.
  const rootId = typeof message.metadata?.chatThreadRootId === "string" ? message.metadata.chatThreadRootId.trim() : "";
  return {
    messageId: message.id,
    ...(rootId && rootId !== message.id ? { threadRootId: rootId } : {})
  };
}

function isStartedEarlier(candidate: ChatMessage, current: ChatMessage): boolean {
  const candidateTime = Date.parse(candidate.createdAt);
  const currentTime = Date.parse(current.createdAt);
  // An unknown start time cannot claim to be first (the phone's rule too).
  // Same time: storage order is chronological, so the one already found
  // (earlier in the list) was started first.
  if (!Number.isFinite(candidateTime)) {
    return false;
  }
  return !Number.isFinite(currentTime) || candidateTime < currentTime;
}
