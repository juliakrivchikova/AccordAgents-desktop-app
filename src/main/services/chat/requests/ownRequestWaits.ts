import type { ChatMessage, ChatParticipantRequestItem, Conversation } from "../../../../shared/types";
import type { SelfCompactedAnswer } from "../compaction/selfCompactionMarks";
import { chatParticipants } from "../members/identity";
import type { ChatModules } from "../modules";
import { messagesById, ownRequestsAnswering, permissionCardAnswering, repliesAnswering } from "./ownRequests";
import { isOpenParticipantRequestStatus } from "./requestRecords";

/** How often a wait for a member to come back from its own requests looks
 *  again with nothing saved here (its machine writes its replies there). */
const OWN_REQUEST_LOOK_AGAIN_MS = 60_000;

/** How a request's target answered after the work of its own in between. */
export type OwnWorkAnswer =
  /** Ended meanwhile elsewhere (the member's device found its resume will
   *  not be made): left as it was ended. */
  | { kind: "closed"; item: ChatParticipantRequestItem | undefined }
  /** Its answer: the last reply, what came of it, and what it wrote before. */
  | { kind: "answer"; answer: SelfCompactedAnswer; reply: ChatMessage; earlier: ChatMessage[] };

type NextReply =
  | { kind: "none" }
  | { kind: "closed"; item: ChatParticipantRequestItem | undefined }
  | { kind: "ended"; answer: Extract<SelfCompactedAnswer, { kind: "ended" }> }
  | { kind: "reply"; reply: ChatMessage; skipped: ChatMessage[] };

/**
 * A request's target that ended its turn in the middle of its work, as its
 * CLI would go on with it: it compacted its own context (the turn it goes on
 * in answers), or it asked others with a resume of its own (the turn it is
 * resumed in with their answers answers; it may ask again, or wait on a
 * permission card there). Waits for its last reply, wherever the member runs.
 */
export async function answerThroughOwnWork(
  chat: Pick<ChatModules, "appQuit" | "selfCompaction" | "store">,
  conversationId: string,
  requestMessageId: string,
  targetId: string,
  first: ChatMessage,
  firstEarlier: readonly ChatMessage[],
  /** Aborted: the request was stopped. None: nothing stops this wait but
   *  the member's own replies (a resume after a permission card). */
  signal: AbortSignal | undefined
): Promise<OwnWorkAnswer> {
  const earlier = [...firstEarlier];
  let reply = first;
  for (;;) {
    // A reply the User stopped, or cut for a message delivered now, is where
    // it ends (settleSelfCompactedItem ends the request as its first turn's).
    if (reply.metadata?.terminalReason === "user-stopped" || reply.metadata?.turnContinues === true) {
      return { kind: "answer", answer: { kind: "went-on", reply }, reply, earlier };
    }
    if (reply.metadata?.selfCompaction && reply.metadata.runId) {
      const through = await chat.selfCompaction.answerThroughSelfCompactions(conversationId, targetId, reply, signal);
      earlier.push(...through.earlier);
      if (through.answer.kind === "ended") return { kind: "answer", answer: through.answer, reply: through.reply, earlier };
      reply = through.reply;
      continue;
    }
    const next = await nextReplyAfterOwnRequests(chat, conversationId, requestMessageId, targetId, reply, signal);
    if (next.kind === "closed") return next;
    if (next.kind === "none") return { kind: "answer", answer: { kind: "went-on", reply }, reply, earlier };
    if (next.kind === "ended") return { kind: "answer", answer: next.answer, reply, earlier };
    earlier.push(reply, ...next.skipped);
    reply = next.reply;
  }
}

/** The member's next reply to the request after `after` once it is back
 *  from every request of its own it is still out on (and from a permission
 *  card in a turn after one); none when it is out on none. */
async function nextReplyAfterOwnRequests(
  chat: Pick<ChatModules, "appQuit" | "store">,
  conversationId: string,
  requestMessageId: string,
  targetId: string,
  after: ChatMessage,
  signal: AbortSignal | undefined
): Promise<NextReply> {
  // As stored: from memory while this device saved it last, else read again
  // (another device's change came through the server).
  const read = async (): Promise<Conversation> => (await chat.store.readStoredChatStateForRefresh(conversationId)).stored ?? await chat.store.requireChat(conversationId);
  // A read that fails (storage busy for a moment) is made again later: it
  // does not end a wait that may last hours. A chat deleted ends it.
  const readAgain = async (previous: Conversation | undefined): Promise<Conversation | undefined> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof Error && /permanently deleted|was not found/.test(error.message)) throw error;
      return previous;
    }
  };
  let conversation = await readAgain(undefined);
  for (;;) {
    if (!conversation) {
      await chat.store.nextChatSave(conversationId, OWN_REQUEST_LOOK_AGAIN_MS, signal);
      if (signal?.aborted) return { kind: "ended", answer: { kind: "ended", reason: chat.appQuit.quitting ? "interrupted" : "stopped" } };
      conversation = await readAgain(undefined);
      continue;
    }
    if (signal?.aborted) return { kind: "ended", answer: { kind: "ended", reason: chat.appQuit.quitting ? "interrupted" : "stopped" } };
    const item = conversation.messages.find((message) => message.id === requestMessageId)?.metadata?.participantRequest?.items
      .find((candidate) => candidate.targetParticipantId === targetId);
    if (!item || !isOpenParticipantRequestStatus(item.status)) return { kind: "closed", item };
    if (!chatParticipants(conversation).some((participant) => participant.id === targetId)) {
      return { kind: "ended", answer: { kind: "ended", reason: "failed", error: "Target member is no longer in this chat." } };
    }
    const byId = messagesById(conversation);
    const own = ownRequestsAnswering(conversation, targetId, requestMessageId, byId);
    if (own.all.length === 0) return { kind: "none" };
    const replies = repliesAnswering(conversation, targetId, requestMessageId, byId);
    const stillOut = own.open.length > 0 || replies.running || permissionCardAnswering(conversation, targetId, requestMessageId, byId);
    if (!stillOut) {
      const newer = replies.finished.filter((message) => message.id !== after.id && message.createdAt > after.createdAt);
      if (newer.length > 0) return { kind: "reply", reply: newer.at(-1)!, skipped: newer.slice(0, -1) };
      // Asked in this turn, and the resume after it ended with no reply.
      const ended = own.ended.find((entry) => entry.message.createdAt > after.createdAt);
      if (ended) {
        return { kind: "ended", answer: ended.reason === "failed" ? { kind: "ended", reason: "failed", error: ended.error ?? "It could not be resumed with the answers." }
          : { kind: "ended", reason: ended.reason === "stopped" ? "stopped" : "interrupted" } };
      }
      return { kind: "none" };
    }
    const saved = await chat.store.nextChatSave(conversationId, OWN_REQUEST_LOOK_AGAIN_MS, signal);
    conversation = saved ?? await readAgain(conversation);
  }
}
