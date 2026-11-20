import type { ChatMessage, ChatPendingChoice } from "../../shared/types";

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
  /** Of those, the ones whose member is no longer in the chat. */
  memberGone?: string[];
  /** Messages of members no longer in the chat whose mention approvals still
   *  wait (not choices: rejected, not expired). */
  goneMentions?: string[];
}

/** A waiting choice closed because its member left the chat (removed, or
 *  replaced by a member of the same name): nobody can take an answer. */
export function choiceClosedForGoneMember(choice: ChatPendingChoice, now: string): ChatPendingChoice {
  return { ...choice, status: "cancelled", cancelledAt: now, expiredAt: now, memberGoneAt: now };
}

/** The waiting choices of members no longer in the chat. `include` says
 *  which of their messages this device may close. */
export function choicesOfGoneMembers(messages: ChatMessage[], memberIds: ReadonlySet<string>, include: (message: ChatMessage) => boolean): string[] {
  return messages
    .filter((message) => message.role === "participant" && message.metadata?.pendingChoice?.status === "pending" &&
      (!message.participantId || !memberIds.has(message.participantId)) && include(message))
    .map((message) => message.id);
}

/** A message of the User's that started a turn of a member. */
interface UserTurnStart {
  messageId: string;
  atMs: number;
  /** The message hers answers (a card's answer names the card's message). */
  answersMessageId?: string;
}

/** The User's messages that started a turn of each member, by member, each
 *  with when she wrote it, oldest first. A turn another member asked for, a
 *  script woke, or one a message of the member itself started is not one;
 *  nor is one still queued behind the member's running turn (it has not
 *  started: stopped, it never will). */
function userTurnStartsByMember(messages: ChatMessage[]): Map<string, UserTurnStart[]> {
  const userMessages = new Map<string, { atMs: number; answersMessageId?: string }>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const at = Date.parse(message.createdAt);
    if (Number.isFinite(at)) userMessages.set(message.id, { atMs: at, answersMessageId: message.metadata?.sourceMessageId });
  }
  const starts = new Map<string, UserTurnStart[]>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "participant" || !message.participantId || message.metadata?.queuedBehind) continue;
    const triggerId = message.metadata?.sourceMessageId ?? message.metadata?.parentMessageId;
    const user = triggerId ? userMessages.get(triggerId) : undefined;
    if (!triggerId || !user) continue;
    const key = `${message.participantId}\u0000${triggerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = starts.get(message.participantId) ?? [];
    list.push({ messageId: triggerId, ...user });
    starts.set(message.participantId, list);
  }
  for (const list of starts.values()) list.sort((left, right) => left.atMs - right.atMs);
  return starts;
}

/** Whether any card in the chat could close or have closed: most chats have
 *  none, and need no pass over their turns. */
function holdsChoices(messages: ChatMessage[]): boolean {
  return messages.some((message) => {
    const choice = message.metadata?.pendingChoice;
    return choice?.status === "pending" || (choice?.status === "cancelled" && Boolean(choice.expiredAt));
  });
}

/** The User's message that went on with the card's member past it: the first
 *  of hers, written after the card was asked, that started a turn of that
 *  member. Her answer to this very card is not going past it. */
function wentOnPast(message: ChatMessage, starts: Map<string, UserTurnStart[]>): string | undefined {
  const askedAtMs = choiceAskedAtMs(message);
  if (!message.participantId || !Number.isFinite(askedAtMs)) return undefined;
  return starts.get(message.participantId)
    ?.find((start) => start.atMs > askedAtMs && start.answersMessageId !== message.id)?.messageId;
}

/**
 * Which waiting choices expire (the User, 2026-11-15): a member's card closes,
 * unanswered, as soon as she goes on with that member instead of answering
 * it — a message of hers, written after the card, that started a turn of
 * that member (an answer to another of its cards included). A message to
 * another member, a member's request, a script, a message of hers queued
 * before the card appeared, or one still queued behind the member's running
 * turn does not close it. (Until then a card waited an
 * hour after it was asked.) `include` says which cards this device may close.
 */
export function choiceExpiryPlan(messages: ChatMessage[], include: (message: ChatMessage) => boolean): ChoiceExpiryPlan {
  const plan: ChoiceExpiryPlan = { due: [] };
  if (!holdsChoices(messages)) return plan;
  const starts = userTurnStartsByMember(messages);
  for (const message of messages) {
    if (message.role !== "participant" || !message.participantId || message.metadata?.pendingChoice?.status !== "pending") continue;
    if (wentOnPast(message, starts) && include(message)) plan.due.push(message.id);
  }
  return plan;
}

/**
 * The cards of a member that the User's message closes by going on with the
 * member instead of answering them, for the member's turn on that message to
 * be told: still waiting (about to close) or closed by this very message.
 * One she answered, cancelled herself, or that an earlier message of hers
 * closed is not among them.
 */
export function choicesClosedByMessage(
  messages: ChatMessage[],
  participantId: string,
  trigger: ChatMessage,
  include: (message: ChatMessage) => boolean = () => true
): ChatPendingChoice[] {
  if (trigger.role !== "user" || !holdsChoices(messages)) return [];
  const starts = userTurnStartsByMember(messages);
  // The member's turn on it is the one being started now: its reply may not
  // be among the messages yet.
  const triggerAtMs = Date.parse(trigger.createdAt);
  const own = starts.get(participantId) ?? [];
  if (Number.isFinite(triggerAtMs) && !own.some((start) => start.messageId === trigger.id)) {
    own.push({ messageId: trigger.id, atMs: triggerAtMs, answersMessageId: trigger.metadata?.sourceMessageId });
    own.sort((left, right) => left.atMs - right.atMs);
    starts.set(participantId, own);
  }
  const closed: ChatPendingChoice[] = [];
  for (const message of messages) {
    const choice = message.metadata?.pendingChoice;
    if (message.role !== "participant" || message.participantId !== participantId || !choice) continue;
    const open = choice.status === "pending" || (choice.status === "cancelled" && Boolean(choice.expiredAt));
    if (!open || !include(message)) continue;
    if (wentOnPast(message, starts) === trigger.id) closed.push(choice);
  }
  return closed;
}
