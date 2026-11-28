import type { ChatMessage, ChatParticipantRequestBatch, ChatParticipantRequestItem, Conversation } from "../../../../shared/types";
import { PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION } from "../constants";
import { chatParticipants } from "../members/identity";
import { isOpenParticipantRequestStatus, rollupParticipantRequestStatus, updateParticipantRequestBatch } from "./requestRecords";

/**
 * A member that asks another member something while it answers a request
 * (app_chat_request_participants with resumeRequester) and ends its turn to
 * wait has not answered yet: the turn it is resumed in with the answers does,
 * and so on while it asks again. These read, from the chat as stored, which of its own requests a
 * request waits on, where each of them stands and which of its replies answer
 * the request, on every device alike (the member may run on a machine).
 */

/** How long a request may wait on a member's own request that nothing will
 *  resume it from any more (no answer, no resume begun, nothing written about
 *  it): a day, as long as a restart still resumes a requester
 *  (requestRecovery). */
const OWN_REQUEST_STALE_MS = 24 * 60 * 60_000;

export type MessagesById = ReadonlyMap<string, ChatMessage>;

export function messagesById(conversation: Conversation): Map<string, ChatMessage> {
  return new Map(conversation.messages.map((message) => [message.id, message]));
}

/** Whether `message` comes after `than` in the chat. By its place in the
 *  chat, not its time: a request a turn asks can carry the same millisecond
 *  as that turn's reply, written as the turn began, and devices' clocks
 *  differ. */
export function comesAfter(conversation: Conversation, message: ChatMessage, than: ChatMessage): boolean {
  if (message.id === than.id) return false;
  let seen = false;
  for (const candidate of conversation.messages) {
    if (candidate.id === than.id) seen = true;
    else if (candidate.id === message.id) return seen || !conversation.messages.some((other) => other.id === than.id) && message.createdAt > than.createdAt;
  }
  return false;
}

/** Whether a request of the member's own was asked in the turn that wrote
 *  `reply` or after it: by that turn's segment, whatever their places, since
 *  a reply that reached this device from another one can be placed after the
 *  requests its turn asked (a resume after a permission card has the same
 *  starting message as the turn before it, not the same segment). */
export function askedInOrAfter(conversation: Conversation, ownRequest: ChatMessage, reply: ChatMessage): boolean {
  const segment = reply.metadata?.turnSegmentId;
  if (segment && ownRequest.metadata?.participantRequest?.requesterTurnSegmentId === segment) return true;
  return comesAfter(conversation, ownRequest, reply);
}

/** The request a member was answering in the turn that the message
 *  `triggerMessageId` started: that message itself when it is a request to
 *  the member, else the request answered by the turn it goes on from (the
 *  line that resumed it after its own request, after its own compaction or
 *  after a permission card). Undefined when that turn answered no request
 *  (the User's message, a scheduled task). */
export function requestAnsweredByTurn(
  conversation: Conversation,
  memberId: string,
  triggerMessageId: string | undefined,
  byId: MessagesById = messagesById(conversation)
): ChatMessage | undefined {
  const seen = new Set<string>();
  let id = triggerMessageId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const message = byId.get(id);
    if (!message) return undefined;
    const batch = message.metadata?.participantRequest;
    if (batch) {
      // The member's own request: the turn that asked it answered what that
      // turn was started by.
      if (batch.requesterParticipantId === memberId) {
        id = batch.triggerMessageId;
        continue;
      }
      return batch.items.some((item) => item.targetParticipantId === memberId) ? message : undefined;
    }
    // A line the app wrote to go on: what it goes on from.
    if (message.role !== "system") return undefined;
    id = message.metadata?.sourceMessageId;
  }
  return undefined;
}

/** Whether a request's answer can wait on this request its requester made
 *  itself: a tool request answered in a turn of its own. */
function resumesItsRequester(batch: ChatParticipantRequestBatch): boolean {
  return batch.source === "mcp" && batch.resumeRequester && !batch.completedInToolCall;
}

export interface OwnRequestsState {
  /** Every request the member made in the turns that answer the request. */
  all: ChatMessage[];
  /** Asked, and the member not yet back from it. */
  open: ChatMessage[];
  /** The member's resume after it ended with no reply of the member's. */
  ended: Array<{ message: ChatMessage; reason: NonNullable<ChatParticipantRequestBatch["requesterResumeEnded"]>["reason"]; error?: string }>;
}

/** The requests `memberId` made with a resume of its own in the turns that
 *  answer `requestMessageId`, and where each stands. One that nothing wrote
 *  about for a day with no resume (its device gone) is no longer open. */
export function ownRequestsAnswering(
  conversation: Conversation,
  memberId: string,
  requestMessageId: string,
  byId?: MessagesById,
  now = Date.now()
): OwnRequestsState {
  const state: OwnRequestsState = { all: [], open: [], ended: [] };
  let index = byId;
  for (const message of conversation.messages) {
    const batch = message.metadata?.participantRequest;
    if (!batch || batch.requesterParticipantId !== memberId || !resumesItsRequester(batch)) continue;
    index ??= messagesById(conversation);
    if (requestAnsweredByTurn(conversation, memberId, batch.triggerMessageId, index)?.id !== requestMessageId) continue;
    state.all.push(message);
    if (batch.autoResumeMessageId) continue;
    if (batch.requesterResumeEnded) {
      state.ended.push({ message, reason: batch.requesterResumeEnded.reason, error: batch.requesterResumeEnded.error });
      continue;
    }
    // Nothing came of it for a day (its device gone): it will not resume
    // the member, as a restart's verdict would say.
    const lastChange = Date.parse(batch.updatedAt);
    if (!batch.items.some((item) => isOpenParticipantRequestStatus(item.status)) && Number.isFinite(lastChange) && now - lastChange > OWN_REQUEST_STALE_MS) {
      state.ended.push({ message, reason: "not-made" });
      continue;
    }
    state.open.push(message);
  }
  // Its resume recorded as done with no reply here: another device ran it.
  const handedOver = state.open.filter((message) => message.metadata?.participantRequest?.status === "completed");
  if (handedOver.length > 0) {
    const resumed = resumedElsewhere(conversation, memberId, handedOver, index ?? messagesById(conversation));
    if (resumed.size > 0) state.open = state.open.filter((message) => !resumed.has(message.id));
  }
  return state;
}

/** Of these requests of the member's own whose resume was recorded as done
 *  with no reply (the User's server gave that turn another device), those
 *  whose reply is there: it goes on from the line its resume wrote from it,
 *  or from the first request it went out with in one turn. A resume a quit
 *  cut short is not recorded as done: a restart weighs it. */
function resumedElsewhere(conversation: Conversation, memberId: string, candidates: readonly ChatMessage[], byId: MessagesById): Set<string> {
  const resumedBy = new Map<string, string[]>();
  for (const message of candidates) {
    const turnId = message.metadata?.participantRequest?.delegation?.turnId;
    const sources = turnId
      ? conversation.messages.filter((other) => other.metadata?.participantRequest?.requesterParticipantId === memberId &&
        other.metadata.participantRequest.delegation?.turnId === turnId).map((other) => other.id)
      : [message.id];
    for (const source of sources) resumedBy.set(source, [...(resumedBy.get(source) ?? []), message.id]);
  }
  const resumed = new Set<string>();
  for (const reply of conversation.messages) {
    if (reply.role !== "participant" || reply.participantId !== memberId || !reply.metadata?.runId ||
      reply.metadata.participantRequest || reply.metadata.serverPlaceholder || !reply.metadata.sourceMessageId) continue;
    const line = byId.get(reply.metadata.sourceMessageId);
    const source = line?.role === "system" ? line.metadata?.sourceMessageId : undefined;
    for (const id of (source ? resumedBy.get(source) : undefined) ?? []) resumed.add(id);
  }
  return resumed;
}

/** The member's replies in the turns that answer `requestMessageId` (its
 *  first turn, the turns it was resumed in after its own requests, after a
 *  permission card, after its own compaction), in the chat's order (one
 *  device writes them, and the server keeps its order), and whether one of
 *  those turns is still running. */
export function repliesAnswering(
  conversation: Conversation,
  memberId: string,
  requestMessageId: string,
  byId: MessagesById = messagesById(conversation),
  /** Leave out the replies of the turn resumed after this request of its own. */
  besidesResumeOf?: string
): { finished: ChatMessage[]; running: boolean } {
  const finished: ChatMessage[] = [];
  let running = false;
  for (const message of conversation.messages) {
    // A reply of a turn of its (not its own requests, nor a placeholder).
    if (message.role !== "participant" || message.participantId !== memberId || !message.metadata?.runId ||
      message.metadata.participantRequest || message.metadata.serverPlaceholder) continue;
    if (besidesResumeOf && message.metadata.sourceMessageId) {
      const line = byId.get(message.metadata.sourceMessageId);
      if (line?.role === "system" && line.metadata?.sourceMessageId === besidesResumeOf) continue;
    }
    if (requestAnsweredByTurn(conversation, memberId, message.metadata?.sourceMessageId, byId)?.id !== requestMessageId) continue;
    if (message.status === "pending") running = true;
    else finished.push(message);
  }
  // In the chat's order, as they were written.
  return { finished, running };
}

/** Whether `reply` is not yet the member's answer to the request because it
 *  asked others itself in the turns that answer it, and it is still out on
 *  one of them, still in a turn after one, or has written a later reply.
 *  False when it asked nobody: other waits (a card in its first turn, its own
 *  compaction) are not this one's. A permission card it raises in a turn
 *  after one is not waited on: that turn's reply answers, as before. */
export function memberWorksOnAfter(conversation: Conversation, memberId: string, requestMessageId: string, reply: ChatMessage): boolean {
  return worksOnAfter(conversation, memberId, requestMessageId, reply);
}

/** The same, leaving out one of its own requests (one that will not resume
 *  it) and what its resume a quit cut short wrote. */
function worksOnAfter(conversation: Conversation, memberId: string, requestMessageId: string, reply: ChatMessage, besidesOwnId?: string): boolean {
  const byId = messagesById(conversation);
  const own = ownRequestsAnswering(conversation, memberId, requestMessageId, byId);
  if (own.all.length === 0) return false;
  if (own.open.some((message) => message.id !== besidesOwnId)) return true;
  const replies = repliesAnswering(conversation, memberId, requestMessageId, byId, besidesOwnId);
  return replies.running || replies.finished.some((message) => comesAfter(conversation, message, reply));
}

/** Whether the member is out on a request of its own to `requesterId`
 *  itself, in the turns that answer `requestMessageId`. */
export function asksBack(conversation: Conversation, memberId: string, requestMessageId: string, requesterId: string): boolean {
  return ownRequestsAnswering(conversation, memberId, requestMessageId).open
    .some((message) => message.metadata?.participantRequest?.items.some((item) => item.targetParticipantId === requesterId));
}

/** Whether a request's item still waits on its member's own requests (it
 *  ended its turn while they were out): the item is open, the reply it has
 *  so far is finished, its member is still in the chat and still works on it
 *  (memberWorksOnAfter). A restart or a quit leaves such an item running: the
 *  member is resumed with its answers and that reply settles it. A request
 *  that went out with another in one turn (answeredWith) waits as that one
 *  does, and ends with it. */
export function itemWaitsOnOwnRequests(
  conversation: Conversation,
  requestMessage: ChatMessage,
  item: ChatParticipantRequestItem
): boolean {
  if (item.status !== "running") return false;
  if (item.answeredWith) {
    const lead = conversation.messages.find((message) => message.id === item.answeredWith?.requestMessageId);
    const leadItem = lead?.metadata?.participantRequest?.items.find((candidate) => candidate.targetParticipantId === item.targetParticipantId);
    return Boolean(lead && leadItem && !leadItem.answeredWith && itemWaitsOnOwnRequests(conversation, lead, leadItem));
  }
  if (!item.replyMessageId) return false;
  const reply = conversation.messages.find((message) => message.id === item.replyMessageId);
  if (!reply || reply.status === "pending" || reply.metadata?.terminalReason === "user-stopped") return false;
  if (!chatParticipants(conversation).some((participant) => participant.id === item.targetParticipantId)) return false;
  return memberWorksOnAfter(conversation, item.targetParticipantId, requestMessage.id, reply);
}

/** The open request (and its item for the member) that waits on this request
 *  the member made itself, if any. */
export function requestWaitingOnOwnRequest(
  conversation: Conversation,
  ownRequestMessage: ChatMessage,
  byId?: MessagesById
): { message: ChatMessage; item: ChatParticipantRequestItem } | undefined {
  const batch = ownRequestMessage.metadata?.participantRequest;
  if (!batch || !resumesItsRequester(batch)) return undefined;
  const answered = requestAnsweredByTurn(conversation, batch.requesterParticipantId, batch.triggerMessageId, byId);
  const item = answered?.metadata?.participantRequest?.items.find((candidate) => candidate.targetParticipantId === batch.requesterParticipantId);
  return answered && item && isOpenParticipantRequestStatus(item.status) ? { message: answered, item } : undefined;
}

/** A request of the member's own whose resume will not be made (a restart
 *  decided so): written on it, on the member's own device, for a request that
 *  waits on its answer, wherever that one is waited on. Returns whether it
 *  changed. */
export function markOwnRequestResumeEnded(
  conversation: Conversation,
  ownRequestMessageId: string,
  reason: NonNullable<ChatParticipantRequestBatch["requesterResumeEnded"]>["reason"],
  byId?: MessagesById
): boolean {
  const own = conversation.messages.find((message) => message.id === ownRequestMessageId);
  const batch = own?.metadata?.participantRequest;
  if (!own || !batch || batch.autoResumeMessageId || batch.requesterResumeEnded || !requestWaitingOnOwnRequest(conversation, own, byId)) return false;
  const now = new Date().toISOString();
  updateParticipantRequestBatch(conversation, own.id, (current) => ({ ...current, requesterResumeEnded: { reason, at: now }, updatedAt: now }));
  return true;
}

/** The same, where the request that waits is this device's to end too: it
 *  ends as a restart ends a task (interrupted before completion), so it never
 *  waits for nothing, unless the member still works on it besides (another
 *  question of its still out, a turn of its running or a later reply).
 *  Returns that request when one changed. */
export function endWaitOnUnresumedOwnRequest(conversation: Conversation, ownRequestMessageId: string, byId?: MessagesById): ChatMessage | undefined {
  const own = conversation.messages.find((message) => message.id === ownRequestMessageId);
  const waiting = own ? requestWaitingOnOwnRequest(conversation, own, byId) : undefined;
  if (!waiting || !itemWaitsOnOwnRequests(conversation, waiting.message, waiting.item)) return undefined;
  const reply = conversation.messages.find((message) => message.id === waiting.item.replyMessageId);
  if (reply && worksOnAfter(conversation, waiting.item.targetParticipantId, waiting.message.id, reply, ownRequestMessageId)) return undefined;
  const now = new Date().toISOString();
  updateParticipantRequestBatch(conversation, waiting.message.id, (current) => {
    const items = current.items.map((item) => item.targetParticipantId === waiting.item.targetParticipantId
      ? { ...item, status: "interrupted" as const, error: PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION, updatedAt: now }
      : item);
    return { ...current, items, status: rollupParticipantRequestStatus(items), updatedAt: now };
  });
  return conversation.messages.find((message) => message.id === waiting.message.id);
}
