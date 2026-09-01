import { createHash } from "node:crypto";
import type { ChatMessage, Conversation, ConversationUpdate } from "../../shared/types";
import { CONVERSATION_UPDATE_TAIL_SIZE } from "../../shared/conversationUpdates";
import type { SavedMessageRow } from "./storage";

/** One message of an emitted snapshot in serialized form. `json` and `hash` are
 *  what storage writes and compares; `message` is the parsed copy the snapshot
 *  holds. Rows are shared between consecutive snapshots while the message is
 *  unchanged, so nothing may mutate `message`. */
export interface SnapshotMessageRow extends SavedMessageRow {
  message: ChatMessage;
}

export interface ConversationSnapshotBuild {
  /** Immutable copy of the conversation for persistence and the phone paths. */
  snapshot: Conversation;
  rows: SnapshotMessageRow[];
  /** What the renderer receives: the full snapshot when there is no previous
   *  state to diff against, otherwise the changed messages plus the newest
   *  window with a delta descriptor. */
  update: ConversationUpdate;
  /** Diagnostics: which message ids the delta carries as changed or removed. */
  changedMessageIds: string[];
  removedMessageIds: string[];
}

/** Deep copy of everything but the messages. */
export function cloneConversationBody(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify({ ...conversation, messages: [] })) as Conversation;
}

/**
 * Builds the snapshot of a conversation that a mutation produced. Every message
 * is serialized once; the string is compared with the previous snapshot's row
 * for the same id, and an unchanged message keeps its previous row — parsed
 * copy and hash included — so the cost of a snapshot grows with what changed,
 * not with the size of the chat. Deep-cloning the whole conversation and
 * re-parsing every message on each update is what made large chats lag.
 */
export function buildConversationSnapshot(
  conversation: Conversation,
  previousRows: SnapshotMessageRow[] | undefined,
  tailSize = CONVERSATION_UPDATE_TAIL_SIZE
): ConversationSnapshotBuild {
  const previousById = new Map<string, SnapshotMessageRow>();
  for (const row of previousRows ?? []) {
    previousById.set(row.id, row);
  }
  const changedMessageIds: string[] = [];
  const seenIds = new Set<string>();
  const rows = conversation.messages.map((message, index): SnapshotMessageRow => {
    const json = JSON.stringify(message);
    seenIds.add(message.id);
    const previous = previousById.get(message.id);
    if (previous && previous.json === json) {
      return previous.index === index ? previous : { ...previous, index };
    }
    changedMessageIds.push(message.id);
    return {
      index,
      id: message.id,
      createdAt: message.createdAt,
      json,
      hash: createHash("sha1").update(json).digest("hex"),
      message: JSON.parse(json) as ChatMessage
    };
  });
  const removedMessageIds = (previousRows ?? [])
    .filter((row) => !seenIds.has(row.id))
    .map((row) => row.id);
  const body = cloneConversationBody(conversation);
  const snapshot: Conversation = { ...body, messages: rows.map((row) => row.message) };
  if (!previousRows) {
    return { snapshot, rows, update: snapshot, changedMessageIds, removedMessageIds };
  }
  const tailStart = Math.max(0, rows.length - Math.max(0, tailSize));
  const changed = new Set(changedMessageIds);
  const changedOlder = rows.slice(0, tailStart).filter((row) => changed.has(row.id));
  const tail = rows.slice(tailStart);
  const update: ConversationUpdate = {
    ...body,
    messages: [...changedOlder, ...tail].map((row) => row.message),
    messageDelta: {
      totalMessages: rows.length,
      tailCount: tail.length,
      removedIds: removedMessageIds
    }
  };
  return { snapshot, rows, update, changedMessageIds, removedMessageIds };
}

/** Bytes of serialized message JSON a row set retains. */
export function snapshotRowsBytes(rows: SnapshotMessageRow[]): number {
  let total = 0;
  for (const row of rows) {
    total += row.json.length;
  }
  return total;
}
