import { firstTextLine, sessionsTaskTitle } from "../../../../shared/mainSessionView";
import type {
  ChatMessage, ChatParticipant, ChatParticipantRequestBatch, ChatParticipantRequestItem, Conversation
} from "../../../../shared/types";
import { chatMessageMemberText } from "../../../../shared/interimPosts";
import { PARTICIPANT_REQUEST_CUT_BY_SEND_NOW, PARTICIPANT_REQUEST_STOPPED_BY_USER } from "../constants";

/** What a resume of the main session's tasks of one turn reads of their
 *  replies: each at most this long, all of them together at most the next. */
export const TASK_REPLY_PROMPT_MAX_CHARS = 12_000;

export const TASK_REPLIES_PROMPT_MAX_CHARS = 60_000;

/** The requests one auto-resume answers, in chat order: the main
 *  session's tasks given in the same turn as this one (each a request of
 *  its own, app_chat_delegate_task), else this request alone. */
export function delegationTurnGroup(
  conversation: Conversation,
  requestMessage: ChatMessage,
  batch: ChatParticipantRequestBatch
): Array<{ message: ChatMessage; batch: ChatParticipantRequestBatch }> {
  const turnId = batch.delegation?.turnId;
  if (!turnId) {
    return [{ message: requestMessage, batch }];
  }
  const group = conversation.messages.flatMap((message) => {
    const candidate = message.metadata?.participantRequest;
    return candidate?.delegation?.turnId === turnId && candidate.requesterParticipantId === batch.requesterParticipantId &&
      candidate.resumeRequester && !candidate.completedInToolCall && !candidate.autoResumeMessageId
      ? [{ message, batch: candidate }]
      : [];
  });
  return group.length > 0 ? group : [{ message: requestMessage, batch }];
}

/** The line that resumes the main session after all the tasks of one turn
 *  ended: each task, whom it went to and how it ended. The replies come
 *  with the turn as untrusted context (extraPromptContextMessageIds). */
export function delegationGroupResumeText(
  conversation: Conversation,
  requester: ChatParticipant,
  group: Array<{ message: ChatMessage; batch: ChatParticipantRequestBatch }>
): string {
  const items = group.flatMap((entry) => entry.batch.items);
  const outcome = (item: ChatParticipantRequestItem): string => {
    const reply = item.replyMessageId ? conversation.messages.find((message) => message.id === item.replyMessageId) : undefined;
    const where = item.replyMessageId ? ` (message ${item.replyMessageId})` : "";
    switch (item.status) {
      case "answered":
      case "completed":
        return `answered${where}`;
      case "denied":
        return "denied";
      case "interrupted":
        // Why, when it was cut for a message to take now (its reply may hold
        // no words at all).
        return item.error === PARTICIPANT_REQUEST_STOPPED_BY_USER ? `stopped by User${where}`
          : item.error === PARTICIPANT_REQUEST_CUT_BY_SEND_NOW ? `interrupted${where}: ${item.error}` : `interrupted${where}`;
      default:
        // A reply carries its own error; without one, the app's reason.
        return reply ? `failed${where}` : `failed: ${firstTextLine(item.error, 200) || "no reply"}`;
    }
  };
  const one = items.length === 1;
  return [
    `Auto-resumed @${requester.handle} after member request.`,
    one ? "The task you gave has ended:" : `All ${items.length} tasks you gave in one turn have ended:`,
    ...items.map((item) => `- @${item.targetHandle} (task "${sessionsTaskTitle(item)}"): ${outcome(item)}`),
    one
      ? "Its reply or error is in the context above. Continue from your request using it."
      : "Their replies and errors are in the context above. Continue from your requests using the available answers and errors."
  ].join("\n");
}

export function turnSegmentKey(conversationId: string, turnSegmentId: string): string {
  return `${conversationId}\u0000${turnSegmentId}`;
}

/** The replies a resume of the main session's tasks of one turn reads, cut
 *  so the prompt stays far from a CLI's argument limit (Antigravity takes
 *  its prompt on the command line) and from flooding the context: each
 *  reply to TASK_REPLY_PROMPT_MAX_CHARS, all of them together to
 *  TASK_REPLIES_PROMPT_MAX_CHARS, a cut one saying where the rest is. */
export function cappedTaskReplyRecords(records: Array<{ message: ChatMessage; sequence: number }>): Array<{ message: ChatMessage; sequence: number }> {
  let budget = TASK_REPLIES_PROMPT_MAX_CHARS;
  return records.map((record) => {
    const text = chatMessageMemberText(record.message).trim();
    const room = Math.max(0, Math.min(TASK_REPLY_PROMPT_MAX_CHARS, budget));
    if (text.length <= room) {
      budget -= text.length;
      return record;
    }
    budget -= room;
    const note = `…cut; read the full reply with app_chat_read_messages (message id ${record.message.id}).`;
    const kept = text.slice(0, room).trimEnd();
    const { interimPosts: _posts, ...metadata } = record.message.metadata ?? {};
    return { ...record, message: { ...record.message, content: kept ? `${kept}\n\n${note}` : note, metadata } };
  });
}

/** What a restart weighs once to resume a requester: one key a turn of
 *  the main session's tasks, one each request made with a tool on its own
 *  (app_chat_request_participants, or a task given after its turn ended).
 *  Undefined for a request a restart leaves nobody waiting on (answered in
 *  its tool call, inline, already resumed) and for an inferred request
 *  (a mention in a reply, not a wait its requester asked for). */
export function requesterResumeRecoveryKey(conversationId: string, requestMessageId: string, batch: ChatParticipantRequestBatch): string | undefined {
  if (!batch.resumeRequester || batch.completedInToolCall || batch.autoResumeMessageId || batch.source !== "mcp") return undefined;
  const turnId = batch.delegation?.turnId;
  return turnId ? turnSegmentKey(conversationId, turnId) : `${conversationId}\u0000request\u0000${requestMessageId}`;
}
