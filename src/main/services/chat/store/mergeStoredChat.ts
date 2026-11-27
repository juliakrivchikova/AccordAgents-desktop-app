import { sessionsRowDetailLine, sessionsRowShowsDetail } from "../../../../shared/sessionsActivity";
import { furthestTurnMarks } from "../../chatServerOps";
import type {
  ChatAgentActivityEvent, ChatMessage, ChatParticipantRequestBatch, ChatParticipantRequestItem, ChatPendingChoice,
  ChatPendingMention, Conversation
} from "../../../../shared/types";
import { withInterimPostsFrom } from "../../../../shared/interimPosts";
import { furthestSelfCompactionMark } from "../compaction/selfCompactionMarks";
import { CHAT_CHOICE_REFUSALS_KEPT } from "../constants";
import { isOpenParticipantRequestStatus, rollupParticipantRequestStatus } from "../requests/requestRecords";
import { repairLastMessagePointerAfterRemoval } from "./lastMessages";
import { CHAT_REMOVED_MESSAGE_ID_MAX, cloneJsonValue, hasStaleRunRecoveryMarker, normalizedRemovedChatMessageIds } from "./messages";
import { chatAutoTitleMetadata } from "./titles";

const CHAT_ACTIVITY_EVENT_MAX_COUNT = 500;

/** What all of one reply's step details may take together: a dozen of
 *  Claude's steps' full details (1,800 each at most, cliToolActivity.ts), half
 *  as many of Codex's (a call and its output, CHAT_ACTIVITY_DETAIL_MAX_CHARS).
 *  They are saved with the reply, go to the User's server with it, and the
 *  window gets the whole list on every live update, so the oldest steps lose
 *  their details first (withinActivityDetailsBudget); every row keeps what it
 *  shows. */
const CHAT_ACTIVITY_DETAILS_TOTAL_MAX_CHARS = 24_000;

export function mergeStoredChatTitle(stored: Conversation, current: Conversation): string {
  return storedChatTitleWins(stored.metadata, current.metadata) ? stored.title : current.title;
}

/** Whether the saved chat's name is newer than the one a copy holds: the name
 *  changes while members run (a rename, a member's first title, either from
 *  another device through the server), so the newer one wins, by when it was
 *  given (metadata.autoTitle). The name and that record always come from the
 *  same side (mergeStoredChatMetadata): a copy keeping its older record would
 *  tie with the next older copy, which would then bring its old name back. */
export function storedChatTitleWins(storedMetadata: Conversation["metadata"], currentMetadata: Conversation["metadata"]): boolean {
  const storedTitle = chatAutoTitleMetadata({ metadata: storedMetadata } as Conversation);
  const currentTitle = chatAutoTitleMetadata({ metadata: currentMetadata } as Conversation);
  if (!storedTitle) {
    return false;
  }
  if (!currentTitle) {
    return true;
  }
  return storedTitle.appliedAt > currentTitle.appliedAt;
}

export function mergeStoredChatMessages(storedMessages: ChatMessage[], currentMessages: ChatMessage[], shared = false): ChatMessage[] {
  const currentById = new Map(currentMessages.map((message) => [message.id, message]));
  // Stored messages read from the last saved snapshot are shared with it (see
  // readStoredChatStateForRefresh); anything adopted into the live
  // conversation is copied first so later in-place edits stay out of it.
  const adopt = (message: ChatMessage): ChatMessage => (shared ? cloneJsonValue(message) : message);
  const merged = storedMessages.map((message) => {
    const current = currentById.get(message.id);
    return current ? mergeStoredChatMessage(message, current, adopt) : adopt(message);
  });
  const storedIds = new Set(storedMessages.map((message) => message.id));
  for (const message of currentMessages) {
    if (!storedIds.has(message.id)) {
      merged.push(message);
    }
  }
  return merged;
}

function mergeStoredChatMessage(
  stored: ChatMessage,
  current: ChatMessage,
  adopt: (message: ChatMessage) => ChatMessage = (message) => message
): ChatMessage {
  const chosen = preferredChatMessageForRefresh(stored, current);
  const preferred = chosen === stored ? adopt(stored) : chosen;
  if (chosen === stored && stored.status !== current.status) {
    // The stored copy is the finished message and the current one a stale
    // in-flight copy (another turn's view of it): the finished message's own
    // metadata (worked time, transcript, choices) is the truth. Merging the
    // stale copy's metadata in dropped those fields.
    return preferred;
  }
  const metadata = mergeStoredChatMessageMetadata(stored.metadata, current.metadata);
  if (metadata && preferred.status !== "pending") {
    // A finished reply is never queued, whatever an older stored copy of it
    // still says (its CLI held it, then it ran and ended before that was
    // written).
    delete metadata.queuedBehind;
    delete metadata.turnQueued;
  }
  if (metadata && Object.keys(metadata).length > 0) {
    preferred.metadata = metadata;
  } else {
    delete preferred.metadata;
  }
  return preferred;
}

function preferredChatMessageForRefresh(stored: ChatMessage, current: ChatMessage): ChatMessage {
  if (stored.status === "done" && current.status !== "done") {
    return stored;
  }
  if (
    stored.status === "error" &&
    !hasStaleRunRecoveryMarker(stored) &&
    current.status !== "error"
  ) {
    return stored;
  }
  return current;
}

// Stale refresh keeps storage authoritative for removable metadata while
// preserving in-flight local progress. Carrying a placeholder's reactions onto
// a fresh completed message is a different operation — see mergeChatMessageReactions.
function mergeStoredChatMessageMetadata(
  storedMetadata: ChatMessage["metadata"] | undefined,
  currentMetadata: ChatMessage["metadata"] | undefined
): ChatMessage["metadata"] | undefined {
  if (
    !currentMetadata &&
    !storedMetadata?.reactions &&
    !storedMetadata?.pendingMentions &&
    !storedMetadata?.pendingChoice &&
    !storedMetadata?.participantRequest &&
    !storedMetadata?.queuedBehind &&
    !storedMetadata?.turnQueued &&
    !storedMetadata?.turnStartedAt &&
    !storedMetadata?.activityEvents &&
    !storedMetadata?.processingTranscript &&
    !storedMetadata?.remoteRunStatus &&
    !storedMetadata?.interimPosts?.length &&
    storedMetadata?.serverSeq === undefined &&
    !storedMetadata?.serverTurns &&
    !storedMetadata?.serverRejected &&
    !storedMetadata?.serverCard &&
    !storedMetadata?.selfCompaction
  ) {
    return undefined;
  }
  const merged: ChatMessage["metadata"] = {
    ...currentMetadata
  };
  // What the User's server said of a message (its place, its writer, a
  // refusal, the turns it asked for) only moves forward: a running turn's
  // older copy of the message never takes it back (Д3, Д5).
  if (merged.serverSeq === undefined && storedMetadata?.serverSeq !== undefined) {
    merged.serverSeq = storedMetadata.serverSeq;
    if (storedMetadata.serverWriter !== undefined) merged.serverWriter = storedMetadata.serverWriter;
  }
  if (!merged.serverRejected && storedMetadata?.serverRejected) merged.serverRejected = storedMetadata.serverRejected;
  const selfCompaction = furthestSelfCompactionMark(storedMetadata?.selfCompaction, currentMetadata?.selfCompaction);
  if (selfCompaction) merged.selfCompaction = { ...selfCompaction };
  const serverTurns = furthestTurnMarks(storedMetadata?.serverTurns, currentMetadata?.serverTurns);
  if (serverTurns) merged.serverTurns = cloneJsonValue(serverTurns);
  // An answer elsewhere to a machine member's card, as the feed last said
  // (only ever written through the stored copy): the stored one, or none.
  if (storedMetadata?.serverCard) merged.serverCard = cloneJsonValue(storedMetadata.serverCard);
  else delete merged.serverCard;
  if (storedMetadata?.reactions) {
    merged.reactions = cloneJsonValue(storedMetadata.reactions);
  } else {
    delete merged.reactions;
  }
  const pendingMentions = mergeStoredPendingMentions(storedMetadata?.pendingMentions, currentMetadata?.pendingMentions);
  if (pendingMentions) {
    merged.pendingMentions = cloneJsonValue(pendingMentions);
  } else {
    delete merged.pendingMentions;
  }
  const pendingChoice = mergeStoredPendingChoice(storedMetadata?.pendingChoice, currentMetadata?.pendingChoice);
  if (pendingChoice) {
    merged.pendingChoice = cloneJsonValue(pendingChoice);
  } else {
    delete merged.pendingChoice;
  }
  const participantRequest = mergeStoredParticipantRequest(storedMetadata?.participantRequest, currentMetadata?.participantRequest);
  if (participantRequest) {
    merged.participantRequest = cloneJsonValue(participantRequest);
  } else {
    delete merged.participantRequest;
  }
  if (storedMetadata?.queuedBehind) {
    merged.queuedBehind = cloneJsonValue(storedMetadata.queuedBehind);
  } else {
    delete merged.queuedBehind;
  }
  // Its shared word and its own turn's start follow the same stored truth.
  if (storedMetadata?.turnQueued) merged.turnQueued = true;
  else delete merged.turnQueued;
  if (storedMetadata?.turnStartedAt) merged.turnStartedAt = storedMetadata.turnStartedAt;
  if (storedMetadata?.activityEvents?.length && !currentMetadata?.activityEvents?.length) {
    merged.activityEvents = cloneJsonValue(storedMetadata.activityEvents);
  }
  if (storedMetadata?.processingTranscript && !currentMetadata?.processingTranscript) {
    merged.processingTranscript = cloneJsonValue(storedMetadata.processingTranscript);
  }
  if (storedMetadata?.remoteRunStatus && !currentMetadata?.remoteRunStatus) {
    merged.remoteRunStatus = cloneJsonValue(storedMetadata.remoteRunStatus);
  }
  // Posts written into a running reply (the post's own save) while a turn
  // held an older copy of it: the turn's copy takes them, never drops them.
  const withPosts = withInterimPostsFrom(merged, storedMetadata) ?? merged;
  return Object.keys(withPosts).length > 0 ? withPosts : undefined;
}

function mergeStoredPendingMentions(
  storedMentions: ChatPendingMention[] | undefined,
  currentMentions: ChatPendingMention[] | undefined
): ChatPendingMention[] | undefined {
  if (!storedMentions?.length) {
    return undefined;
  }
  if (!currentMentions?.length) {
    return storedMentions;
  }
  const currentByTarget = new Map(currentMentions.map((mention) => [mention.targetParticipantId, mention]));
  const merged = storedMentions.map((storedMention) => {
    const currentMention = currentByTarget.get(storedMention.targetParticipantId);
    if (!currentMention) {
      return storedMention;
    }
    return pendingMentionStatusRank(currentMention.status) > pendingMentionStatusRank(storedMention.status)
      ? currentMention
      : storedMention;
  });
  return merged.length > 0 ? merged : undefined;
}

function pendingMentionStatusRank(status: ChatPendingMention["status"]): number {
  return status === "pending" ? 0 : 1;
}

function mergeStoredPendingChoice(
  storedChoice: ChatPendingChoice | undefined,
  currentChoice: ChatPendingChoice | undefined
): ChatPendingChoice | undefined {
  if (!storedChoice || !currentChoice) {
    return currentChoice ?? storedChoice;
  }
  if (storedChoice.id !== currentChoice.id) {
    return pendingChoiceTimestamp(currentChoice) >= pendingChoiceTimestamp(storedChoice)
      ? currentChoice
      : storedChoice;
  }
  const storedRank = pendingChoiceStatusRank(storedChoice.status);
  const currentRank = pendingChoiceStatusRank(currentChoice.status);
  if (storedRank !== currentRank) {
    return currentRank > storedRank ? currentChoice : storedChoice;
  }
  if (storedRank > 0) {
    return pendingChoiceTimestamp(currentChoice) >= pendingChoiceTimestamp(storedChoice)
      ? currentChoice
      : storedChoice;
  }
  // Both still waiting. What changes on a waiting choice is its refused
  // answers, and a copy held by a longer flow (another member's turn) must
  // not drop the ones recorded since it was read.
  const refusals = mergeChoiceRefusals(storedChoice.refusals, currentChoice.refusals);
  return refusals ? { ...currentChoice, refusals } : currentChoice;
}

function mergeChoiceRefusals(
  stored: ChatPendingChoice["refusals"],
  current: ChatPendingChoice["refusals"]
): ChatPendingChoice["refusals"] {
  if (!stored?.length) return current;
  if (!current?.length) return stored;
  const byOperation = new Map<string, NonNullable<ChatPendingChoice["refusals"]>[number]>();
  for (const refusal of [...stored, ...current]) {
    const known = byOperation.get(refusal.operationId);
    if (!known || refusal.at >= known.at) byOperation.set(refusal.operationId, refusal);
  }
  return [...byOperation.values()].sort((left, right) => left.at.localeCompare(right.at)).slice(-CHAT_CHOICE_REFUSALS_KEPT);
}

function pendingChoiceStatusRank(status: ChatPendingChoice["status"]): number {
  return status === "pending" ? 0 : 1;
}

function pendingChoiceTimestamp(choice: ChatPendingChoice): string {
  return choice.selectedAt ?? choice.cancelledAt ?? "";
}

function mergeStoredParticipantRequest(
  storedBatch: ChatParticipantRequestBatch | undefined,
  currentBatch: ChatParticipantRequestBatch | undefined
): ChatParticipantRequestBatch | undefined {
  if (!storedBatch || !currentBatch) {
    return currentBatch ?? storedBatch;
  }
  if (storedBatch.id !== currentBatch.id) {
    return currentBatch.updatedAt >= storedBatch.updatedAt ? currentBatch : storedBatch;
  }
  const currentItemsByTarget = new Map(currentBatch.items.map((item) => [item.targetParticipantId, item]));
  const items = storedBatch.items.map((storedItem) => {
    const currentItem = currentItemsByTarget.get(storedItem.targetParticipantId);
    return currentItem ? mergeStoredParticipantRequestItem(storedItem, currentItem) : storedItem;
  });
  const storedTargets = new Set(storedBatch.items.map((item) => item.targetParticipantId));
  for (const currentItem of currentBatch.items) {
    if (!storedTargets.has(currentItem.targetParticipantId)) {
      items.push(currentItem);
    }
  }
  const newerBatch = currentBatch.updatedAt >= storedBatch.updatedAt ? currentBatch : storedBatch;
  const hasOpenItems = items.some((item) => isOpenParticipantRequestStatus(item.status));
  const status = hasOpenItems
    ? rollupParticipantRequestStatus(items)
    : storedBatch.status === "completed" || currentBatch.status === "completed"
      ? "completed"
      : rollupParticipantRequestStatus(items);
  // Once written, the end of its requester's resume stays (a copy read
  // before it was written does not take it back).
  const requesterResumeEnded = newerBatch.requesterResumeEnded ?? storedBatch.requesterResumeEnded ?? currentBatch.requesterResumeEnded;
  // So does the reply its requester was resumed with.
  const autoResumeMessageId = newerBatch.autoResumeMessageId ?? storedBatch.autoResumeMessageId ?? currentBatch.autoResumeMessageId;
  return {
    ...newerBatch,
    items,
    status,
    ...(requesterResumeEnded ? { requesterResumeEnded } : {}),
    ...(autoResumeMessageId ? { autoResumeMessageId } : {}),
    updatedAt: currentBatch.updatedAt >= storedBatch.updatedAt ? currentBatch.updatedAt : storedBatch.updatedAt
  };
}

function mergeStoredParticipantRequestItem(
  storedItem: ChatParticipantRequestItem,
  currentItem: ChatParticipantRequestItem
): ChatParticipantRequestItem {
  const storedOpen = isOpenParticipantRequestStatus(storedItem.status);
  const currentOpen = isOpenParticipantRequestStatus(currentItem.status);
  if (storedOpen !== currentOpen) {
    return currentOpen ? storedItem : currentItem;
  }
  return currentItem.updatedAt >= storedItem.updatedAt ? currentItem : storedItem;
}

export function capChatActivityEvents(events: ChatAgentActivityEvent[]): { events: ChatAgentActivityEvent[]; dropped: number } {
  const kept = events.length <= CHAT_ACTIVITY_EVENT_MAX_COUNT ? events : events.slice(-CHAT_ACTIVITY_EVENT_MAX_COUNT);
  return { events: withinActivityDetailsBudget(kept), dropped: events.length - kept.length };
}

/** The events cut, oldest first, until their details fit
 *  CHAT_ACTIVITY_DETAILS_TOTAL_MAX_CHARS (the same array when they do):
 *  first the details no row shows (its label says what the step did), then
 *  those a row shows down to the line it shows ("Viewing image" and its
 *  path, sessionsActivity.ts), and only past that the rest. */
export function withinActivityDetailsBudget(events: ChatAgentActivityEvent[]): ChatAgentActivityEvent[] {
  let total = 0;
  for (const event of events) total += event.detail?.length ?? 0;
  if (total <= CHAT_ACTIVITY_DETAILS_TOTAL_MAX_CHARS) return events;
  const next = [...events];
  const cut = (skip: (event: ChatAgentActivityEvent) => boolean, toRowLine: boolean): void => {
    for (let index = 0; index < next.length && total > CHAT_ACTIVITY_DETAILS_TOTAL_MAX_CHARS; index += 1) {
      const event = next[index];
      const detail = event.detail;
      if (!detail || skip(event)) continue;
      const kept = toRowLine ? sessionsRowDetailLine(detail) : "";
      if (kept.length >= detail.length) continue;
      total -= detail.length - kept.length;
      const { detail: _detail, ...rest } = event;
      next[index] = kept ? { ...rest, detail: kept } : rest;
    }
  };
  cut((event) => sessionsRowShowsDetail(event.label), false);
  cut((event) => !sessionsRowShowsDetail(event.label), true);
  cut(() => false, false);
  return next;
}

function isChatAgentActivityKind(value: unknown): value is ChatAgentActivityEvent["kind"] {
  return value === "tool" ||
    value === "command" ||
    value === "file-edit" ||
    value === "web" ||
    value === "approval" ||
    value === "status";
}

export function mergeRemovedChatMessageIds(storedValue: unknown, currentValue: unknown): string[] {
  const merged: string[] = [];
  for (const id of [
    ...normalizedRemovedChatMessageIds(storedValue),
    ...normalizedRemovedChatMessageIds(currentValue)
  ]) {
    if (!merged.includes(id)) {
      merged.push(id);
    }
  }
  return merged.slice(-CHAT_REMOVED_MESSAGE_ID_MAX);
}

export function markChatMessageRemoved(conversation: Conversation, messageId: string): void {
  const existing = normalizedRemovedChatMessageIds(conversation.metadata.removedChatMessageIds)
    .filter((id) => id !== messageId);
  conversation.metadata = {
    ...conversation.metadata,
    removedChatMessageIds: [...existing, messageId].slice(-CHAT_REMOVED_MESSAGE_ID_MAX)
  };
}

export function applyRemovedChatMessageTombstones(conversation: Conversation): boolean {
  const removedIds = new Set(normalizedRemovedChatMessageIds(conversation.metadata.removedChatMessageIds));
  if (removedIds.size === 0) {
    return false;
  }
  const beforeLength = conversation.messages.length;
  conversation.messages = conversation.messages.filter((message) => !removedIds.has(message.id));
  if (conversation.messages.length === beforeLength) {
    return false;
  }
  for (const removedId of removedIds) {
    repairLastMessagePointerAfterRemoval(conversation, removedId);
  }
  conversation.updatedAt = new Date().toISOString();
  return true;
}

