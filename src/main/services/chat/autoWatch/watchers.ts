import type { ChatMessage, ChatParticipant, ChatParticipantWatcherState, Conversation } from "../../../../shared/types";
import { isAutoWatchStableMessage } from "../../../../shared/chatTimelineVisibility";
import { participantRequestMessages } from "../requests/requestRecords";
import { askedParticipantIdsOf } from "../turns/deliveryTargets";
import { isMetadataRecord } from "../compaction/contextUsage";

export function normalizeParticipantWatchers(value: unknown): Record<string, ChatParticipantWatcherState> {
  if (!isMetadataRecord(value)) {
    return {};
  }
  const watchers: Record<string, ChatParticipantWatcherState> = {};
  for (const [participantId, raw] of Object.entries(value)) {
    if (!participantId || !isMetadataRecord(raw)) {
      continue;
    }
    const wakeChainDepth = Number(raw.wakeChainDepth);
    const pausedReason = raw.pausedReason === "wake-limit" || raw.pausedReason === "error"
      ? raw.pausedReason
      : undefined;
    watchers[participantId] = {
      lastSeenMessageId: typeof raw.lastSeenMessageId === "string" ? raw.lastSeenMessageId : undefined,
      lastRunId: typeof raw.lastRunId === "string" ? raw.lastRunId : undefined,
      lastTriggeredAt: typeof raw.lastTriggeredAt === "string" ? raw.lastTriggeredAt : undefined,
      wakeChainDepth: Number.isFinite(wakeChainDepth) && wakeChainDepth > 0 ? Math.floor(wakeChainDepth) : 0,
      pausedReason,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
    };
  }
  return watchers;
}

export function metadataWithParticipantWatchers(
  metadata: Conversation["metadata"],
  watchers: Record<string, ChatParticipantWatcherState>
): Conversation["metadata"] {
  if (Object.keys(watchers).length === 0) {
    const { participantWatchers: _removed, ...rest } = metadata;
    return rest;
  }
  return { ...metadata, participantWatchers: watchers };
}

export function metadataWithAutoWatchDisabled(metadata: Conversation["metadata"], participantId: string): Conversation["metadata"] {
  const watchers = normalizeParticipantWatchers(metadata.participantWatchers);
  delete watchers[participantId];
  return metadataWithParticipantWatchers(metadata, watchers);
}

export function metadataWithAutoWatchEnabled(conversation: Conversation, participantId: string): Conversation["metadata"] {
  const now = new Date().toISOString();
  const watchers = normalizeParticipantWatchers(conversation.metadata.participantWatchers);
  watchers[participantId] = {
    ...watchers[participantId],
    lastSeenMessageId: autoWatchToggleOnCursor(conversation, participantId),
    wakeChainDepth: 0,
    updatedAt: now
  };
  delete watchers[participantId].pausedReason;
  return metadataWithParticipantWatchers(conversation.metadata, watchers);
}

/** Turned on, a member looks at the User's latest message, unless that
 *  message asked it (autoWatchMessagesAfterCursor): it answered that one. */
export function autoWatchToggleOnCursor(conversation: Conversation, participantId: string): string | undefined {
  const eligible = autoWatchStableMessages(conversation, participantId);
  let latestUserIndex = -1;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    if (eligible[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex > 0) {
    return eligible[latestUserIndex - 1].id;
  }
  if (latestUserIndex === 0) {
    return undefined;
  }
  return eligible.at(-1)?.id;
}

export function resetAutoWatchDepthForUserMessage(conversation: Conversation): void {
  const watchers = normalizeParticipantWatchers(conversation.metadata.participantWatchers);
  let changed = false;
  const now = new Date().toISOString();
  for (const [participantId, watcher] of Object.entries(watchers)) {
    if (watcher.wakeChainDepth !== 0) {
      watchers[participantId] = { ...watcher, wakeChainDepth: 0, updatedAt: now };
      changed = true;
    }
  }
  if (changed) {
    conversation.metadata = metadataWithParticipantWatchers(conversation.metadata, watchers);
  }
}

export function advanceAutoWatchCursorForDirectTargets(
  conversation: Conversation,
  targets: ChatParticipant[],
  userMessage: ChatMessage
): void {
  if (userMessage.role !== "user" || userMessage.status === "pending") {
    return;
  }
  const autoWatchTargets = targets.filter((participant) => participant.autoWatch === true);
  if (autoWatchTargets.length === 0) {
    return;
  }
  const watchers = normalizeParticipantWatchers(conversation.metadata.participantWatchers);
  const now = new Date().toISOString();
  let changed = false;
  for (const participant of autoWatchTargets) {
    const existing = watchers[participant.id] ?? {
      wakeChainDepth: 0,
      updatedAt: now
    };
    const cursor = laterAutoWatchCursor(conversation, participant.id, existing.lastSeenMessageId, userMessage.id);
    if (existing.lastSeenMessageId === cursor) {
      continue;
    }
    watchers[participant.id] = {
      ...existing,
      lastSeenMessageId: cursor,
      updatedAt: now
    };
    changed = true;
  }
  if (changed) {
    conversation.metadata = metadataWithParticipantWatchers(conversation.metadata, watchers);
  }
}

/** A watcher's cursor only moves forward. Its own turn for a User's message
 *  starts late on a machine (it readies its settings and project first); a
 *  watch wake for a later message may have moved the cursor past it by then,
 *  and moving it back would wake the member for that message again. */
export function laterAutoWatchCursor(conversation: Conversation, participantId: string, current: string | undefined, next: string): string {
  if (!current || current === next) return next;
  const stable = autoWatchStableMessages(conversation, participantId);
  const at = stable.findIndex((message) => message.id === current);
  const to = stable.findIndex((message) => message.id === next);
  return at >= 0 && to >= 0 && at > to ? current : next;
}

function autoWatchStableMessages(conversation: Conversation, participantId: string): ChatMessage[] {
  return conversation.messages.filter((message) => isAutoWatchStableMessage(message, participantId));
}

export function autoWatchMessagesAfterCursor(conversation: Conversation, participantId: string, cursor?: string): ChatMessage[] {
  const messages = autoWatchStableMessages(conversation, participantId);
  const afterCursor = (() => {
    if (!cursor) {
      return messages;
    }
    const index = messages.findIndex((message) => message.id === cursor);
    return index >= 0 ? messages.slice(index + 1) : messages;
  })();
  // A User's message that asks this member is answered by its own turn.
  // The cursor alone does not say so in time: on a cloud machine the
  // message arrives before that turn starts (the machine readies its
  // settings and project first, or the computer asks it only once the
  // project is there), and a wake meanwhile ran the member twice.
  const notAskedOfIt = afterCursor.filter((message) => !(message.role === "user" && askedParticipantIdsOf(message).includes(participantId)));
  const handledReplyIds = autoWatchHandledParticipantRequestMessageIds(conversation, participantId);
  if (handledReplyIds.size === 0) {
    return notAskedOfIt;
  }
  return notAskedOfIt.filter((message) => !handledReplyIds.has(message.id));
}

function autoWatchHandledParticipantRequestMessageIds(conversation: Conversation, participantId: string): Set<string> {
  const ids = new Set<string>();
  for (const { message, batch } of participantRequestMessages(conversation)) {
    // A direct or inferred request already assigns its source to this
    // target. Auto-watch must neither duplicate it nor bypass its approval.
    if (batch.items.some(item => item.targetParticipantId === participantId)) {
      ids.add(message.id);
      const sourceId = message.metadata?.sourceMessageId ?? message.metadata?.parentMessageId;
      if (sourceId) ids.add(sourceId);
    }
    if (
      batch.requesterParticipantId !== participantId ||
      batch.resumeRequester !== true ||
      !batch.autoResumeMessageId
    ) {
      continue;
    }
    for (const item of batch.items) {
      const replyMessageId = typeof item.replyMessageId === "string" ? item.replyMessageId.trim() : "";
      if (replyMessageId) {
        ids.add(replyMessageId);
      }
    }
  }
  return ids;
}

export function autoWatchTriggerContent(participant: ChatParticipant, messages: ChatMessage[]): string {
  const lines = messages.map((message, index) => {
    const author = message.role === "user"
      ? "User"
      : message.participantLabel ?? (message.participantId ? `Participant ${message.participantId}` : "Participant");
    const content = message.content.trim().replace(/\s+/g, " ").slice(0, 1200);
    return `${index + 1}. ${author}: ${content}`;
  });
  return [
    `Auto-watch trigger for @${participant.handle}.`,
    "",
    "New stable messages since your last evaluation:",
    ...lines,
    "",
    "Decide whether to wait, act, mark done, or mark blocked according to your active role and skill instructions."
  ].join("\n");
}
