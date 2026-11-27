import type { ChatMessage, ChatParticipantRequestBatch, ChatParticipantRequestItem, Conversation } from "../../../../shared/types";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "../../appMcp";
import { chatAppToolApprovals, permissionApprovalResumeRunId } from "../approvals/approvalRecords";
import { PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION } from "../constants";
import { chatParticipants } from "../members/identity";
import { isOpenParticipantRequestStatus, rollupParticipantRequestStatus, updateParticipantRequestBatch } from "./requestRecords";

/**
 * A member that asks another member something while it answers a request
 * (app_chat_request_participants with resumeRequester) and ends its turn to
 * wait has not answered yet: the turn it is resumed in with the answers does,
 * and so on while it asks again (or waits on the User's permission card in
 * that turn). These read, from the chat as stored, which of its own requests a
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
    const lastChange = Date.parse(batch.updatedAt);
    if (!batch.items.some((item) => isOpenParticipantRequestStatus(item.status)) && Number.isFinite(lastChange) && now - lastChange > OWN_REQUEST_STALE_MS) continue;
    state.open.push(message);
  }
  return state;
}

/** The member's replies in the turns that answer `requestMessageId` (its
 *  first turn, the turns it was resumed in after its own requests, after a
 *  permission card, after its own compaction), oldest first, and whether one
 *  of those turns is still running. */
export function repliesAnswering(
  conversation: Conversation,
  memberId: string,
  requestMessageId: string,
  byId: MessagesById = messagesById(conversation)
): { finished: ChatMessage[]; running: boolean } {
  const finished: ChatMessage[] = [];
  let running = false;
  for (const message of conversation.messages) {
    // A reply of a turn of its (not its own requests, nor a placeholder).
    if (message.role !== "participant" || message.participantId !== memberId || !message.metadata?.runId ||
      message.metadata.participantRequest || message.metadata.serverPlaceholder) continue;
    if (requestAnsweredByTurn(conversation, memberId, message.metadata?.sourceMessageId, byId)?.id !== requestMessageId) continue;
    if (message.status === "pending") running = true;
    else finished.push(message);
  }
  finished.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { finished, running };
}

/** How long after the User approved a member's permission card its resumed
 *  turn is waited for before the card counts as done (its turn starts within
 *  seconds; one that never starts must not hold the request). */
const APPROVED_CARD_RESUME_GRACE_MS = 60_000;

/** A permission card the member raised in a turn that answers the request,
 *  still waiting for the User, or approved and its resumed turn not begun
 *  yet: that turn's reply answers. */
export function permissionCardAnswering(conversation: Conversation, memberId: string, requestMessageId: string, byId: MessagesById, now = Date.now()): boolean {
  return chatAppToolApprovals(conversation).some((approval) => {
    if (approval.toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL || approval.requesterParticipantId !== memberId) return false;
    const waitsForTurn = approval.status === "pending" || (approval.status === "approved" &&
      now - Date.parse(approval.updatedAt) < APPROVED_CARD_RESUME_GRACE_MS &&
      !conversation.messages.some((message) => message.participantId === memberId && message.metadata?.runId === permissionApprovalResumeRunId(approval.id)));
    return waitsForTurn && requestAnsweredByTurn(conversation, memberId, approval.resumeContext?.triggerMessageId, byId)?.id === requestMessageId;
  });
}

/** Whether `reply` is not yet the member's answer to the request because it
 *  asked others itself in the turns that answer it, and it is still out on
 *  one of them, still in a turn (or on a permission card) after one, or has
 *  written a later reply. False when it asked nobody: other waits (a card in
 *  its first turn, its own compaction) are not this one's. */
export function memberWorksOnAfter(conversation: Conversation, memberId: string, requestMessageId: string, reply: ChatMessage): boolean {
  const byId = messagesById(conversation);
  const own = ownRequestsAnswering(conversation, memberId, requestMessageId, byId);
  if (own.all.length === 0) return false;
  if (own.open.length > 0) return true;
  const replies = repliesAnswering(conversation, memberId, requestMessageId, byId);
  return replies.running || replies.finished.some((message) => message.id !== reply.id && message.createdAt > reply.createdAt) ||
    permissionCardAnswering(conversation, memberId, requestMessageId, byId);
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
 *  waits for nothing. Returns that request when one changed. */
export function endWaitOnUnresumedOwnRequest(conversation: Conversation, ownRequestMessageId: string, byId?: MessagesById): ChatMessage | undefined {
  const own = conversation.messages.find((message) => message.id === ownRequestMessageId);
  const waiting = own ? requestWaitingOnOwnRequest(conversation, own, byId) : undefined;
  if (!waiting || !itemWaitsOnOwnRequests(conversation, waiting.message, waiting.item)) return undefined;
  const now = new Date().toISOString();
  updateParticipantRequestBatch(conversation, waiting.message.id, (current) => {
    const items = current.items.map((item) => item.targetParticipantId === waiting.item.targetParticipantId
      ? { ...item, status: "interrupted" as const, error: PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION, updatedAt: now }
      : item);
    return { ...current, items, status: rollupParticipantRequestStatus(items), updatedAt: now };
  });
  return conversation.messages.find((message) => message.id === waiting.message.id);
}
