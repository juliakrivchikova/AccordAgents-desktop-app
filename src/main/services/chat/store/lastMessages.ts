import type { ChatLastMessageByParticipant, ChatMessage, Conversation } from "../../../../shared/types";
import { isChatMessageHiddenFromTimeline } from "../../../../shared/chatTimelineVisibility";
import { withInterimPostsFrom } from "../../../../shared/interimPosts";
import { hasStaleRunRecoveryMarker } from "../runs/runOwnerRecords";
import { mergeChatMessageReactions } from "./mergeStoredChat";

// Single finalize/upsert path: append a completed message, or repair a
// placeholder we created for the same id (a still-pending bubble, or an error
// bubble that stale-run recovery marked). Reactions added to the placeholder
// are carried onto the completed message. Never overwrites a real error or a
// user-stopped message.
export function upsertCompletedMessage(conversation: Conversation, message: ChatMessage): boolean {
  const existingIndex = conversation.messages.findIndex((item) => item.id === message.id);
  if (existingIndex < 0) {
    conversation.messages.push(message);
    recordLastMessageByParticipant(conversation, message);
    return true;
  }
  const existing = conversation.messages[existingIndex];
  if (existing === message) {
    recordLastMessageByParticipant(conversation, message);
    return true;
  }
  const replaceable =
    existing.status === "pending" ||
    (existing.status === "error" && hasStaleRunRecoveryMarker(existing));
  if (!replaceable) {
    return false;
  }
  const reactions = mergeChatMessageReactions(existing.metadata?.reactions, message.metadata?.reactions);
  // The posts the turn made into the reply it replaces stay in it.
  const metadata: ChatMessage["metadata"] = { ...withInterimPostsFrom(message.metadata, existing.metadata) };
  delete metadata.staleRunRecovery;
  if (reactions) {
    metadata.reactions = reactions;
  } else {
    delete metadata.reactions;
  }
  message.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
  conversation.messages[existingIndex] = message;
  recordLastMessageByParticipant(conversation, message);
  return true;
}

// Single O(n) pass over full history: keep the newest visible message per participant by
// `createdAt` (with array order as the tie-break, since storage order is chronological).
// Do not route through recordLastMessageByParticipant per message — its index lookup falls
// to an O(n) findIndex during a rebuild, making the whole thing O(n²) on every open.
export function rebuildLastMessagesByParticipant(conversation: Conversation): void {
  const map: ChatLastMessageByParticipant = {};
  for (let index = 0; index < conversation.messages.length; index += 1) {
    const message = conversation.messages[index];
    const participantId = message.participantId?.trim();
    if (message.role !== "participant" || !participantId || isChatMessageHiddenFromTimeline(message)) {
      continue;
    }
    const existing = map[participantId];
    if (existing) {
      const existingTime = lastMessageTimestamp(existing.createdAt);
      const incomingTime = lastMessageTimestamp(message.createdAt);
      if (existingTime !== undefined && incomingTime !== undefined && existingTime > incomingTime) {
        continue;
      }
    }
    const threadRootId = threadRootIdForLastMessagePointer(message);
    map[participantId] = {
      messageId: message.id,
      sequence: index,
      ...(typeof message.createdAt === "string" && message.createdAt.trim() ? { createdAt: message.createdAt } : {}),
      ...(threadRootId ? { threadRootId } : {})
    };
  }
  conversation.metadata = {
    ...conversation.metadata,
    lastMessageByParticipant: map
  };
}

// Rebuild the pointer map from the (full) message history currently on the conversation
// and report whether it actually changed, so callers only persist on a real diff. Must
// run where conversation.messages is full history (e.g. inside withChatMutation after
// refreshStoredChatState) — a windowed rebuild would drop participants whose latest
// message sits outside the window.
export function rebuildLastMessagesByParticipantIfChanged(conversation: Conversation): boolean {
  const before = serializeLastMessagePointers(
    normalizedLastMessageByParticipant(conversation.metadata.lastMessageByParticipant)
  );
  rebuildLastMessagesByParticipant(conversation);
  const after = serializeLastMessagePointers(
    normalizedLastMessageByParticipant(conversation.metadata.lastMessageByParticipant)
  );
  return before !== after;
}

// Recompute pointers when a recorded message is removed from history (pointers only
// advance via recordLastMessageByParticipant, so a removal would otherwise dangle).
// No-op unless the removed message was actually a pointer target. Requires full history.
export function repairLastMessagePointerAfterRemoval(conversation: Conversation, removedMessageId: string): void {
  const map = normalizedLastMessageByParticipant(conversation.metadata.lastMessageByParticipant);
  const affected = Object.values(map).some((entry) => entry.messageId === removedMessageId);
  if (!affected) {
    return;
  }
  rebuildLastMessagesByParticipant(conversation);
}

// Include createdAt so a heal that only back-fills the timestamp on an already-correct
// pointer is detected as a change and persisted — otherwise legacy entries never gain a
// stored createdAt and keep paying the O(n) messages.find fallback in record on every turn.
function serializeLastMessagePointers(map: ChatLastMessageByParticipant): string {
  return Object.keys(map)
    .sort()
    .map((key) => {
      const entry = map[key];
      return `${key}=${entry.messageId}:${entry.threadRootId ?? ""}:${entry.createdAt ?? ""}`;
    })
    .join("|");
}

export function recordLastMessageByParticipant(conversation: Conversation, message: ChatMessage): void {
  const participantId = message.participantId?.trim();
  if (message.role !== "participant" || !participantId || isChatMessageHiddenFromTimeline(message)) {
    return;
  }
  // `sequence` is the message's index at record time. It is advisory only and kept for
  // debugging/back-compat — it must NOT gate updates: `conversation.messages` is a
  // paginated window, so the index is window-relative and not comparable across opens.
  // Ordering by it froze pointers on stale messages. Recency is decided by `createdAt`,
  // which is stable regardless of pagination. Most call sites push-then-record, so the
  // message is last — fast-path that O(1) and fall back to findIndex for a mid-list upsert.
  const lastIndex = conversation.messages.length - 1;
  const sequence = conversation.messages[lastIndex]?.id === message.id
    ? lastIndex
    : conversation.messages.findIndex((item) => item.id === message.id);
  if (sequence < 0) {
    return;
  }
  const current = normalizedLastMessageByParticipant(conversation.metadata.lastMessageByParticipant);
  const existing = current[participantId];
  // Refuse to move the pointer backward only when the existing target is a *different*,
  // genuinely newer message (later createdAt). Re-recording the same id, or a message
  // with an equal/newer timestamp, always wins. Legacy entries without a stored
  // createdAt fall back to the pointed message's own timestamp if still loaded; if it is
  // unknown, we allow the update so stale pre-fix pointers self-heal.
  if (existing && existing.messageId !== message.id) {
    const incomingTime = lastMessageTimestamp(message.createdAt);
    const existingTime = lastMessageTimestamp(existing.createdAt)
      ?? lastMessageTimestamp(conversation.messages.find((item) => item.id === existing.messageId)?.createdAt);
    if (existingTime !== undefined && incomingTime !== undefined && existingTime > incomingTime) {
      return;
    }
  }
  const threadRootId = threadRootIdForLastMessagePointer(message);
  current[participantId] = {
    messageId: message.id,
    sequence,
    ...(typeof message.createdAt === "string" && message.createdAt.trim() ? { createdAt: message.createdAt } : {}),
    ...(threadRootId ? { threadRootId } : {})
  };
  conversation.metadata = {
    ...conversation.metadata,
    lastMessageByParticipant: current
  };
}

export function lastMessageTimestamp(value: string | undefined): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function latestTimestamp(...values: Array<number | undefined>): number | undefined {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length > 0 ? Math.max(...known) : undefined;
}

export function normalizedLastMessageByParticipant(raw: unknown): ChatLastMessageByParticipant {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const normalized: ChatLastMessageByParticipant = {};
  for (const [participantId, value] of Object.entries(raw)) {
    if (!participantId || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as { messageId?: unknown; sequence?: unknown; createdAt?: unknown; threadRootId?: unknown };
    if (typeof record.messageId !== "string" || !record.messageId.trim() || typeof record.sequence !== "number" || !Number.isFinite(record.sequence)) {
      continue;
    }
    normalized[participantId] = {
      messageId: record.messageId,
      sequence: Math.max(0, Math.floor(record.sequence)),
      ...(typeof record.createdAt === "string" && record.createdAt.trim() ? { createdAt: record.createdAt } : {}),
      ...(typeof record.threadRootId === "string" && record.threadRootId.trim() ? { threadRootId: record.threadRootId } : {})
    };
  }
  return normalized;
}

function threadRootIdForLastMessagePointer(message: ChatMessage): string | undefined {
  // Only a real thread reply (one nested under a thread root in a side panel) carries
  // `chatThreadRootId`. `parentMessageId` is broader causal lineage — a top-level reply
  // to a user message has it set yet renders inline in the main timeline. Using it as a
  // thread root sent the renderer hunting for the message inside a non-existent thread
  // and missed the inline focus when the message was paginated out.
  const rootId = message.metadata?.chatThreadRootId?.trim() || undefined;
  return rootId && rootId !== message.id ? rootId : undefined;
}
