import { newOpId, turnMark, type ChatServerLink } from "../../chatServerOps";
import type { HubTurn } from "../../../../shared/hubOps";
import { HUB_OP_TAKEN_BACK } from "../../hubOpsClient";
import type { ChatMessage, ChatMessageMetadata, ChatParticipant, Conversation } from "../../../../shared/types";
import { clearChatRunMetadata } from "../../../../shared/chatRunState";
import { INTERRUPTED_RUN_WARNING, sanitizeWarningList } from "../../../../shared/warnings";
import { ACTIVE_RUN_OWNERS_KEY } from "./constants";
import type { ChatRunOwner } from "./types";
import { recordLastMessageByParticipant } from "../store/lastMessages";
import { stableJson } from "../store/messages";
import { markParticipantMessageStoppedByUser } from "../turns/replyMessages";

const CHAT_RUN_OWNER_STALE_MS = 90_000;

export function metadataWithInterruptedRunWarning(metadata: Record<string, unknown>): Record<string, unknown> {
  const warnings = sanitizeWarningList(metadata.warnings);
  if (warnings.includes(INTERRUPTED_RUN_WARNING)) {
    return { ...metadata, warnings };
  }
  return { ...metadata, warnings: [...warnings, INTERRUPTED_RUN_WARNING] };
}

export function chatRunId(conversation: Conversation): string | undefined {
  const runId = conversation.metadata.runId;
  return typeof runId === "string" && runId.trim() ? runId : undefined;
}

export function clearedChatRunMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return clearChatRunMetadata(metadata);
}

export function chatRunOwners(metadata: Record<string, unknown>): Record<string, ChatRunOwner> {
  const raw = metadata[ACTIVE_RUN_OWNERS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const owners: Record<string, ChatRunOwner> = {};
  for (const [runId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!runId.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    const processId = typeof record.processId === "number" && Number.isFinite(record.processId)
      ? Math.floor(record.processId)
      : undefined;
    const instanceId = typeof record.instanceId === "string" && record.instanceId.trim()
      ? record.instanceId.trim()
      : undefined;
    const startedAt = typeof record.startedAt === "string" ? record.startedAt : "";
    const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : startedAt;
    if (processId && processId > 0 && startedAt) {
      owners[runId] = { processId, instanceId, startedAt, updatedAt };
    }
  }
  return owners;
}

export function runOwnerHeartbeatFresh(owner: ChatRunOwner): boolean {
  const updatedAt = Date.parse(owner.updatedAt);
  if (!Number.isFinite(updatedAt)) {
    return false;
  }
  return Date.now() - updatedAt <= CHAT_RUN_OWNER_STALE_MS;
}

export function processAppearsAlive(processId: number): boolean {
  if (!Number.isFinite(processId) || processId <= 0) {
    return false;
  }
  if (Math.floor(processId) === process.pid) {
    return true;
  }
  try {
    process.kill(Math.floor(processId), 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

export function markStoredParticipantRunStoppedByUser(conversation: Conversation, runId: string): boolean {
  let changed = false;
  const participantsById = new Map<string, ChatParticipant>();
  const participants = conversation.metadata.participants;
  if (Array.isArray(participants)) {
    for (const participant of participants) {
      if (participant && typeof participant === "object" && !Array.isArray(participant)) {
        const item = participant as ChatParticipant;
        if (typeof item.id === "string") {
          participantsById.set(item.id, item);
        }
      }
    }
  }
  for (const message of conversation.messages) {
    if (
      message.role !== "participant" ||
      message.metadata?.runId !== runId ||
      (
        message.status !== "pending" &&
        (message.status !== "error" || message.metadata?.terminalReason === "user-stopped")
      )
    ) {
      continue;
    }
    const before = stableJson(message);
    const participant = message.participantId ? participantsById.get(message.participantId) : undefined;
    if (participant) {
      markParticipantMessageStoppedByUser(message, participant, { preserveContent: true });
    } else {
      message.status = "error";
      if (!message.content.trim()) {
        message.content = "Stopped by user.";
      }
      message.metadata = {
        ...message.metadata,
        terminalReason: "user-stopped"
      };
    }
    recordLastMessageByParticipant(conversation, message);
    changed = changed || before !== stableJson(message);
  }
  return changed;
}

/** The turn, as the server holds it, on the message it answers. */
export function markServerTurn(conversation: Conversation, turn: HubTurn): void {
  const index = conversation.messages.findIndex((message) => message.id === turn.messageId);
  if (index < 0) return;
  const message = conversation.messages[index];
  const marks = { ...(message.metadata?.serverTurns ?? {}) };
  marks[turn.participantId] = turnMark(turn) as NonNullable<ChatMessageMetadata["serverTurns"]>[string];
  conversation.messages[index] = { ...message, metadata: { ...(message.metadata ?? {}), serverTurns: marks } };
}

/**
 * A turn stopped before it ran here: never left taken on the server. The
 * Stop goes first, whatever the claim's state (a turn only asked for is
 * stopped by it); a claim nothing sent yet is taken back, and a turn the
 * server gave this device (or may have, after a request carrying the
 * claim failed) is also finished as stopped, since a Stop alone leaves
 * it taken, every device showing it busy.
 */
export async function endAbortedServerTurn(link: ChatServerLink, turn: { conversationId: string; runId: string; messageId: string; participantId: string }, claimOpId?: string): Promise<void> {
  const taken = claimOpId ? await link.withdraw?.(claimOpId) : undefined;
  await link.enqueue([{ opId: newOpId(), kind: "turn.stop", ...turn }]);
  if (!claimOpId || !taken || taken.status === "missing" || (taken.status === "withdrawn" && !taken.attempted)) return;
  const outcome = taken.status === "withdrawn" ? undefined : taken.status === "answered" ? taken.outcome : await link.opAnswered(claimOpId);
  const given = !outcome || (outcome.status === "accepted" && (outcome.claim === "claimed" || outcome.claim === "already-yours")) ||
    (outcome.status === "rejected" && outcome.reason === HUB_OP_TAKEN_BACK);
  if (given) await link.enqueue([{ opId: newOpId(), kind: "turn.finish", conversationId: turn.conversationId, runId: turn.runId, outcome: "stopped" }]);
}

/** Whether a member's turn for a message already shows in the chat (its
 *  bubble, or the line saying it was stopped). */
export function turnShown(conversation: Conversation, message: ChatMessage, participant: ChatParticipant, runId: string): boolean {
  const stopped = `@${participant.handle} stopped by user.`;
  return conversation.messages.some((item) => item.metadata?.runId === runId ||
    (item.role === "system" && item.content === stopped && item.metadata?.parentMessageId === message.id));
}
