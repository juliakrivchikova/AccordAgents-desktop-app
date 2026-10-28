import { randomUUID } from "node:crypto";
import { LOCAL_MESSAGE_METADATA_KEYS, SHARED_CONVERSATION_METADATA_KEYS, type ChatChange } from "./chatChanges";
import type { HubCard, HubConversationFields, HubOp, HubOpEffect, HubTurn } from "../../shared/hubOps";
import type { HubOpOutcome } from "./hubOpsClient";
import type { ChatMessage, Conversation } from "../../shared/types";

/**
 * A device's link to the User's server, as ChatService uses it: where its
 * saves go (as operations queued with the save itself), and how a turn waits
 * for the server (agreements Д1–Д5, Д13).
 */
export interface ChatServerLink {
  /** This device's id on the server (the writer of what it writes). */
  deviceId(): string;
  /** Statements that queue operations, committed with the save that made them. */
  queueSql(ops: HubOp[], condition?: string): string;
  /** Queues operations on their own (a Stop, a claim, a finish). */
  enqueue(ops: HubOp[]): Promise<void>;
  /** Sends what is queued now. */
  nudge(): void;
  /** Resolves once the server answered the operation that wrote this
   *  message: undefined when no operation of this device writes it. */
  messageAccepted(conversationId: string, messageId: string, signal?: AbortSignal): Promise<{ status: "accepted"; seq: number } | { status: "rejected"; reason: string } | undefined>;
  /** Resolves once the server answered this operation. */
  opAnswered(opId: string, signal?: AbortSignal): Promise<HubOpOutcome>;
  /** Turns asked of this device's members that nobody took yet, and the
   *  ones this device took and never finished (it stopped or restarted). */
  waitingTurns(): Promise<{ requested: HubTurn[]; claimed: HubTurn[] }>;
  /** A machine's name, for "waiting for machine …". */
  machineName(machineId: string): string | undefined;
  /** The chat moved to the server whole: what was queued for it is in that move. */
  settleMoved?(conversationId: string): Promise<void>;
  /** Cards not settled yet on the server, in every chat, and the place in
   *  its order they were read at (undefined: not linked yet). */
  openCards?(): Promise<{ cards: HubCard[]; head: number } | undefined>;
  /** Resolves once this device has read the feed through `seq`, or after
   *  `timeoutMs` (false then). */
  readThrough?(seq: number, timeoutMs: number): Promise<boolean>;
  /** Whether this device holds a settle of this card it has not sent yet
   *  (what it did with the answer is said already). */
  cardSettleQueued?(conversationId: string, cardId: string): Promise<boolean>;
}

/** Message metadata a device keeps for itself about the server: the turns
 *  the message asked for (its "taken to work" marks), and a placeholder bubble
 *  for a member that runs elsewhere, shown until that device writes the real
 *  one. Never sent. */
export const SERVER_LOCAL_MESSAGE_KEYS = ["serverTurns", "serverPlaceholder", "serverRejected"] as const;

export function newOpId(): string {
  return `op-${randomUUID()}`;
}

/** The chat's own fields, as the server takes them. */
export function conversationFieldsOf(conversation: Conversation): HubConversationFields {
  const metadata: Record<string, unknown> = {};
  for (const key of SHARED_CONVERSATION_METADATA_KEYS) {
    const value = (conversation.metadata as Record<string, unknown>)?.[key];
    if (value !== undefined) metadata[key] = value;
  }
  return {
    title: conversation.title,
    kind: "chat",
    createdAt: conversation.createdAt,
    ...(conversation.repoPath ? { repoPath: conversation.repoPath } : {}),
    metadata
  };
}

/** A message as it is written to the server: this device's bookkeeping out. */
export function messageForServer(message: ChatMessage): ChatMessage {
  const { metadata, ...rest } = message;
  if (!metadata) return { ...rest };
  const shared: Record<string, unknown> = { ...metadata };
  for (const key of LOCAL_MESSAGE_METADATA_KEYS) delete shared[key];
  for (const key of SERVER_LOCAL_MESSAGE_KEYS) delete shared[key];
  delete shared.reactions;
  return Object.keys(shared).length ? { ...rest, metadata: shared as ChatMessage["metadata"] } : { ...rest };
}

/** What a save changed, as operations for the server. A message this device
 *  may not write (another device's, a placeholder) stays local; the server's
 *  copy replaces it. */
export function chatChangesToOps(
  conversation: Conversation,
  changes: ChatChange[],
  mayWrite: (message: ChatMessage) => boolean
): HubOp[] {
  const conversationId = conversation.id;
  const ops: HubOp[] = [];
  for (const change of changes) {
    switch (change.type) {
      case "conversation.created":
        ops.push({ opId: newOpId(), kind: "conversation.create", conversationId, conversation: conversationFieldsOf(conversation) });
        break;
      case "conversation.updated":
        ops.push({
          opId: newOpId(), kind: "conversation.update", conversationId,
          ...(change.title !== undefined ? { title: change.title } : {}),
          ...(change.repoPath !== undefined ? { repoPath: change.repoPath } : {}),
          ...(change.metadata ? { metadata: change.metadata } : {}),
          ...(change.removedMetadataKeys?.length ? { removedMetadataKeys: change.removedMetadataKeys } : {})
        });
        break;
      case "message.created": {
        const current = conversation.messages.find((message) => message.id === change.message.id) ?? change.message;
        if (!mayWrite(current)) break;
        ops.push({ opId: newOpId(), kind: "message.create", conversationId, message: messageForServer(current) });
        const reactions = current.metadata?.reactions;
        if (reactions && Object.keys(reactions).length) {
          ops.push({ opId: newOpId(), kind: "message.react", conversationId, messageId: current.id,
            added: Object.entries(reactions).flatMap(([emoji, reactors]) => (reactors ?? []).map((reactor) => ({ emoji, reactor }))), removed: [] });
        }
        break;
      }
      case "message.updated": {
        const current = conversation.messages.find((message) => message.id === change.message.id) ?? change.message;
        if (!mayWrite(current)) break;
        ops.push({ opId: newOpId(), kind: "message.update", conversationId, message: messageForServer(current) });
        break;
      }
      case "message.reactions":
        ops.push({ opId: newOpId(), kind: "message.react", conversationId, messageId: change.messageId, added: change.added, removed: change.removed });
        break;
      case "message.removed":
        ops.push({ opId: newOpId(), kind: "message.remove", conversationId, messageId: change.messageId });
        break;
    }
  }
  return ops;
}

/** Where a message stands in the server's order (absent: not accepted yet). */
export function serverSeqOf(message: ChatMessage): number | undefined {
  const value = message.metadata?.serverSeq;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Messages in the server's order; those it has not accepted yet come last,
 *  in the order they were written here. */
export function sortByServerOrder(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index, seq: serverSeqOf(message) }))
    .sort((left, right) => {
      if (left.seq === undefined && right.seq === undefined) return left.index - right.index;
      if (left.seq === undefined) return 1;
      if (right.seq === undefined) return -1;
      return left.seq - right.seq || left.index - right.index;
    })
    .map((entry) => entry.message);
}

/** A turn as a message keeps it: what the device needs to show "taken to
 *  work" (Д5) and to stop it. */
export interface ChatServerTurnMark {
  runId: string;
  state: HubTurn["state"];
  executorDeviceId?: string;
  stopRequested?: boolean;
  outcome?: HubTurn["outcome"];
}

export function turnMark(turn: HubTurn): ChatServerTurnMark {
  return {
    runId: turn.runId,
    state: turn.state,
    ...(turn.executorDeviceId ? { executorDeviceId: turn.executorDeviceId } : {}),
    ...(turn.stopRequestedAt ? { stopRequested: true } : {}),
    ...(turn.outcome ? { outcome: turn.outcome } : {})
  };
}

const TURN_STAGE: Record<HubTurn["state"], number> = { requested: 0, claimed: 1, stopped: 2, finished: 2 };

/** A turn on the server only moves forward (requested, claimed, then stopped
 *  or finished): of two copies of a message's turn marks, each turn keeps the
 *  furthest one, so an older copy of the message never takes it back. */
export function furthestTurnMarks(
  a: Record<string, ChatServerTurnMark> | undefined,
  b: Record<string, ChatServerTurnMark> | undefined
): Record<string, ChatServerTurnMark> | undefined {
  if (!a || !b) return a ?? b;
  const merged: Record<string, ChatServerTurnMark> = { ...a };
  for (const [participantId, mark] of Object.entries(b)) {
    const other = merged[participantId];
    const further = !other || other.runId !== mark.runId || TURN_STAGE[mark.state] > TURN_STAGE[other.state] ||
      (TURN_STAGE[mark.state] === TURN_STAGE[other.state] && Boolean(mark.stopRequested || mark.outcome) && !(other.stopRequested || other.outcome));
    if (further) merged[participantId] = mark;
  }
  return merged;
}

/** The turns an effect carries (to keep their marks on the messages). */
export function turnsOfEffect(effect: HubOpEffect): HubTurn[] {
  if (effect.kind === "message.create") return effect.turns ?? [];
  if (effect.kind === "turn.request" || effect.kind === "turn.claim" || effect.kind === "turn.stop" || effect.kind === "turn.finish") return [effect.turn];
  return [];
}
