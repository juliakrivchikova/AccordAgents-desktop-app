import type { ChatMessage } from "../../shared/types";

/** How long a member's choice card waits after the User went on with that
 *  member before it expires (the User, 2026-11-01). */
export const CHAT_CHOICE_EXPIRY_MS = 60 * 60_000;

/** When the card was put in front of the User: when it was asked, or, for a
 *  card saved before that was recorded, when its reply finished. */
export function choiceAskedAtMs(message: ChatMessage): number {
  const asked = Date.parse(message.metadata?.pendingChoice?.askedAt ?? "");
  if (Number.isFinite(asked)) return asked;
  const created = Date.parse(message.createdAt);
  const workedMs = message.metadata?.workedMs;
  return typeof workedMs === "number" && Number.isFinite(workedMs) && workedMs >= 0 ? created + workedMs : created;
}

export interface ChoiceExpiryPlan {
  /** Messages whose waiting choice expires now. */
  due: string[];
  /** The earliest moment a waiting choice of a member the User already went
   *  on with expires, when that is still ahead. */
  nextAtMs?: number;
}

/**
 * Which waiting choices expire: those an hour old whose member the User has
 * since gone on with — a message of hers (an answer to another of its cards
 * included), written after the card, that started a turn of that member.
 * A turn another member asked for, or one her earlier message queued, does
 * not count. `include` says which cards this device may close.
 */
export function choiceExpiryPlan(messages: ChatMessage[], nowMs: number, include: (message: ChatMessage) => boolean): ChoiceExpiryPlan {
  const userMessageAtMs = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const at = Date.parse(message.createdAt);
    if (Number.isFinite(at)) userMessageAtMs.set(message.id, at);
  }
  // The newest message of the User's that started each member's turn.
  const latestUserTurnAtMs = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "participant" || !message.participantId) continue;
    const triggerId = message.metadata?.sourceMessageId ?? message.metadata?.parentMessageId;
    const at = triggerId ? userMessageAtMs.get(triggerId) : undefined;
    if (at === undefined) continue;
    if (at > (latestUserTurnAtMs.get(message.participantId) ?? -Infinity)) latestUserTurnAtMs.set(message.participantId, at);
  }
  const plan: ChoiceExpiryPlan = { due: [] };
  for (const message of messages) {
    if (message.role !== "participant" || !message.participantId || message.metadata?.pendingChoice?.status !== "pending") continue;
    const askedAtMs = choiceAskedAtMs(message);
    const wentOnAtMs = latestUserTurnAtMs.get(message.participantId);
    if (!Number.isFinite(askedAtMs) || wentOnAtMs === undefined || wentOnAtMs <= askedAtMs || !include(message)) continue;
    const expiresAtMs = askedAtMs + CHAT_CHOICE_EXPIRY_MS;
    if (expiresAtMs <= nowMs) plan.due.push(message.id);
    else plan.nextAtMs = Math.min(plan.nextAtMs ?? Infinity, expiresAtMs);
  }
  return plan;
}
