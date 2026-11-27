import type { ChatMessage, ChatParticipantRequestItem, Conversation } from "../../../../shared/types";
import type { SelfCompactedAnswer } from "../compaction/selfCompactionMarks";
import { chatParticipants } from "../members/identity";
import type { ChatModules } from "../modules";
import { ownRequestsAnswering } from "./ownRequests";
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
 * resumed in with their answers answers; it may ask again). Waits for its
 * last reply, wherever the member runs. Aborted: the request was stopped.
 */
export async function answerThroughOwnWork(
  chat: Pick<ChatModules, "appQuit" | "selfCompaction" | "store">,
  conversationId: string,
  requestMessageId: string,
  targetId: string,
  first: ChatMessage,
  firstEarlier: readonly ChatMessage[],
  signal: AbortSignal
): Promise<OwnWorkAnswer> {
  const earlier = [...firstEarlier];
  let reply = first;
  for (;;) {
    // A reply the User stopped is where it ends.
    if (reply.metadata?.terminalReason === "user-stopped") return { kind: "answer", answer: { kind: "went-on", reply }, reply, earlier };
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

/** The member's next reply after `after` once it is back from every request
 *  of its own it is still out on; none when it is out on none. */
async function nextReplyAfterOwnRequests(
  chat: Pick<ChatModules, "appQuit" | "store">,
  conversationId: string,
  requestMessageId: string,
  targetId: string,
  after: ChatMessage,
  signal: AbortSignal
): Promise<NextReply> {
  // As stored: from memory while this device saved it last, else read again
  // (another device's change came through the server).
  const read = async (): Promise<Conversation> => (await chat.store.readStoredChatStateForRefresh(conversationId)).stored ?? await chat.store.requireChat(conversationId);
  let conversation = await read();
  for (;;) {
    if (signal.aborted) return { kind: "ended", answer: { kind: "ended", reason: chat.appQuit.quitting ? "interrupted" : "stopped" } };
    const item = conversation.messages.find((message) => message.id === requestMessageId)?.metadata?.participantRequest?.items
      .find((candidate) => candidate.targetParticipantId === targetId);
    if (!item || !isOpenParticipantRequestStatus(item.status)) return { kind: "closed", item };
    if (!chatParticipants(conversation).some((participant) => participant.id === targetId)) {
      return { kind: "ended", answer: { kind: "ended", reason: "failed", error: "Target member is no longer in this chat." } };
    }
    const state = ownRequestsAnswering(conversation, targetId, requestMessageId);
    if (state.open.length === 0) {
      const newer = state.resumed.filter((message) => message.id !== after.id && message.createdAt > after.createdAt);
      if (newer.length > 0) return { kind: "reply", reply: newer.at(-1)!, skipped: newer.slice(0, -1) };
      // Asked in this turn, and its resume could not be made.
      const failed = state.failed.find((entry) => entry.message.createdAt > after.createdAt);
      if (failed) return { kind: "ended", answer: { kind: "ended", reason: "failed", error: failed.error } };
      return { kind: "none" };
    }
    const saved = await chat.store.nextChatSave(conversationId, OWN_REQUEST_LOOK_AGAIN_MS, signal);
    conversation = saved ?? await read();
  }
}
