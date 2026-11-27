import type { ChatMessage, ChatParticipantRequestItem, Conversation } from "../../../../shared/types";
import { PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION } from "../constants";
import { chatParticipants } from "../members/identity";
import { isOpenParticipantRequestStatus, rollupParticipantRequestStatus, updateParticipantRequestBatch } from "./requestRecords";

/**
 * A member that asks another member something while it answers a request
 * (app_chat_request_participants with resumeRequester) and ends its turn to
 * wait has not answered yet: the turn it is resumed in with the answers does,
 * and so on while it asks again. These read, from the chat as stored, which
 * of its own requests a request waits on and where each of them stands, on
 * every device alike (the member may run on a machine).
 */

function messagesById(conversation: Conversation): Map<string, ChatMessage> {
  return new Map(conversation.messages.map((message) => [message.id, message]));
}

/** How far up a chain of own requests and their resumes is followed. */
const OWN_REQUEST_CHAIN_MAX_STEPS = 64;

/** How long a request may wait on a member's own request that nobody will
 *  resume it from any more (no answer, no resume begun): a day, as long as a
 *  restart still resumes a requester (requestRecovery). */
const OWN_REQUEST_STALE_MS = 24 * 60 * 60_000;

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
  byId: ReadonlyMap<string, ChatMessage> = messagesById(conversation)
): ChatMessage | undefined {
  const find = (id: string): ChatMessage | undefined => byId.get(id);
  let id = triggerMessageId;
  for (let step = 0; id && step < OWN_REQUEST_CHAIN_MAX_STEPS; step += 1) {
    const message = find(id);
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

export interface OwnRequestsState {
  /** Asked, and the member not yet back from it with a finished reply. */
  open: ChatMessage[];
  /** The member's finished replies in the turns it was resumed in, oldest first. */
  resumed: ChatMessage[];
  /** Its resume could not start or failed: the request's error. */
  failed: Array<{ message: ChatMessage; error: string }>;
}

/** The requests `memberId` made, with app_chat_request_participants and a
 *  resume of its own, in the turns that answer `requestMessageId`, and where
 *  each stands. A request whose resume a restart will not make (nobody
 *  resumes it within a day) counts as neither open nor resumed. */
export function ownRequestsAnswering(
  conversation: Conversation,
  memberId: string,
  requestMessageId: string,
  now = Date.now()
): OwnRequestsState {
  const state: OwnRequestsState = { open: [], resumed: [], failed: [] };
  let byId: Map<string, ChatMessage> | undefined;
  for (const message of conversation.messages) {
    const batch = message.metadata?.participantRequest;
    if (!batch || batch.requesterParticipantId !== memberId || batch.source !== "mcp" || !batch.resumeRequester || batch.completedInToolCall) continue;
    byId ??= messagesById(conversation);
    if (requestAnsweredByTurn(conversation, memberId, batch.triggerMessageId, byId)?.id !== requestMessageId) continue;
    if (batch.autoResumeMessageId) {
      const reply = byId.get(batch.autoResumeMessageId);
      if (reply && reply.status !== "pending" && !reply.metadata?.serverPlaceholder) state.resumed.push(reply);
      else state.open.push(message);
      continue;
    }
    if (batch.status === "failed" && batch.error && !batch.items.some((item) => isOpenParticipantRequestStatus(item.status))) {
      state.failed.push({ message, error: batch.error });
      continue;
    }
    // Answered (or ended) and not resumed yet: its resume is under way, or a
    // restart makes it at the next start. One nobody resumed for a day is over.
    const lastChange = Date.parse(batch.updatedAt);
    if (batch.status !== "resuming_requester" && !batch.items.some((item) => isOpenParticipantRequestStatus(item.status)) &&
      Number.isFinite(lastChange) && now - lastChange > OWN_REQUEST_STALE_MS) continue;
    state.open.push(message);
  }
  state.resumed.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return state;
}

/** Whether a request's item still waits on its member's own requests (it
 *  ended its turn while they were out): the item is open, the reply it has
 *  so far is finished, its member is still in the chat and asked in the
 *  turns that answer it. A restart or a quit leaves such an item running: the
 *  member is resumed with its answers and that reply settles it. */
export function itemWaitsOnOwnRequests(
  conversation: Conversation,
  requestMessage: ChatMessage,
  item: ChatParticipantRequestItem
): boolean {
  if (item.status !== "running" || !item.replyMessageId) return false;
  const reply = conversation.messages.find((message) => message.id === item.replyMessageId);
  if (!reply || reply.status === "pending" || reply.metadata?.terminalReason === "user-stopped") return false;
  if (!chatParticipants(conversation).some((participant) => participant.id === item.targetParticipantId)) return false;
  return stillWorksAfter(ownRequestsAnswering(conversation, item.targetParticipantId, requestMessage.id), reply);
}

/** Whether a member's reply is not yet its answer: it is still out on a
 *  request of its own, or it was resumed after it (the resume may even end
 *  first: a Claude Code member takes it into its running turn). */
export function stillWorksAfter(state: OwnRequestsState, reply: ChatMessage): boolean {
  return state.open.length > 0 || state.resumed.some((resumed) => resumed.id !== reply.id && resumed.createdAt > reply.createdAt);
}

/** A request of the member's own that will not resume it (a restart ended it
 *  and its requester is not resumed, or a resume cut short is not made
 *  again): the request whose answer waited on it ends as a restart ends a
 *  task (interrupted before completion), so it never waits for nothing.
 *  Returns that request when one changed. */
export function endWaitOnUnresumedOwnRequest(conversation: Conversation, ownRequestMessageId: string): ChatMessage | undefined {
  const own = conversation.messages.find((message) => message.id === ownRequestMessageId);
  const waiting = own ? requestWaitingOnOwnRequest(conversation, own) : undefined;
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

/** The open request (and its item for the member) that waits on this request
 *  the member made itself, if any. */
export function requestWaitingOnOwnRequest(
  conversation: Conversation,
  ownRequestMessage: ChatMessage
): { message: ChatMessage; item: ChatParticipantRequestItem } | undefined {
  const batch = ownRequestMessage.metadata?.participantRequest;
  if (!batch || batch.source !== "mcp" || !batch.resumeRequester || batch.completedInToolCall) return undefined;
  const answered = requestAnsweredByTurn(conversation, batch.requesterParticipantId, batch.triggerMessageId);
  const item = answered?.metadata?.participantRequest?.items.find((candidate) => candidate.targetParticipantId === batch.requesterParticipantId);
  return answered && item && isOpenParticipantRequestStatus(item.status) ? { message: answered, item } : undefined;
}
