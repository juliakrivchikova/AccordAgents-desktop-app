import type { ChatMessage } from "./types";

/**
 * A message of the User's its member has not taken yet, in the sessions view
 * (the User, 2026-11-25: "as Claude does: send it, force it, or just wait
 * until the agent takes it itself", no "Queued" rows): the reply it will get
 * has no row, and the message itself says what can be done with it.
 */
export interface WaitingMessage {
  participantId: string;
  /** The run it waits as: taking the message back stops it. */
  runId: string;
  /** The member's reply being written now. Sending the message now stops it,
   *  as the CLI's own send-now interrupts the step it is in, and the member
   *  takes what waits next. Undefined when the member waits for something
   *  else (a compaction). */
  behind?: { runId: string; messageId?: string };
}

type WaitingSource = Pick<ChatMessage, "id" | "role" | "status" | "participantId" | "metadata">;

/** A reply that has not started: its member still answers something else. */
export function isWaitingReply(message: WaitingSource): boolean {
  return message.role === "participant" && message.status === "pending" &&
    Boolean(message.metadata?.queuedBehind || message.metadata?.turnQueued);
}

/** The reply a member is writing now (its first one started). */
export function runningReplyOf<T extends WaitingSource>(messages: readonly T[], participantId: string): T | undefined {
  return messages.find((message) => message.role === "participant" && message.status === "pending" && message.participantId === participantId &&
    Boolean(message.metadata?.runId) && !isWaitingReply(message));
}

/** The User's messages one member has not taken yet, by the message's id (a
 *  message to several members waits in each one's session on its own). */
export function waitingMessages(messages: readonly WaitingSource[], participantId: string): ReadonlyMap<string, WaitingMessage> {
  const waiting = new Map<string, WaitingMessage>();
  const replies = messages.filter((message) => message.participantId === participantId && isWaitingReply(message));
  if (replies.length === 0) return waiting;
  const users = new Set(messages.filter((message) => message.role === "user").map((message) => message.id));
  const running = runningReplyOf(messages, participantId);
  for (const { metadata } of replies) {
    if (!metadata?.runId || !metadata.sourceMessageId || !users.has(metadata.sourceMessageId)) continue;
    waiting.set(metadata.sourceMessageId, {
      participantId,
      runId: metadata.runId,
      ...(running ? { behind: { runId: running.metadata!.runId!, ...(running.metadata!.sourceMessageId ? { messageId: running.metadata!.sourceMessageId } : {}) } } : {})
    });
  }
  return waiting;
}
