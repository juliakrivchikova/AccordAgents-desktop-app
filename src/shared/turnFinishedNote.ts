import { APP_CHAT_SEND_MESSAGE_TOOL } from "./appMcpToolContracts";
import {
  chatMessageHiddenFromTimeline,
  chatMessageVisualThreadRootId,
  chatParticipantRequestReplyRootMap
} from "./chatParticipantRequestThreads";
import { TURN_FINISHED_NOTE_SOURCE, turnFinishedNoteOf } from "./turnFinishedNoteSource";
import type { ChatMessage, Conversation } from "./types";

/** How much of the reply a note carries: one line, cut by the card anyway. */
export const TURN_FINISHED_NOTE_PREVIEW_MAX = 200;

/** A reply's note has one id, whichever device or pass writes it: a second
 *  pass over the turn's end finds it, and once the User took it away the
 *  removal names it, so it is never written again. */
export function turnFinishedNoteId(replyId: string): string {
  return `${TURN_FINISHED_NOTE_ID_PREFIX}${replyId}`;
}

/** What every note's id starts with: how her server finds the notes the User
 *  took away, to tell the phone. */
export const TURN_FINISHED_NOTE_ID_PREFIX = "turn-finished-";

/** At most this many of a chat's taken-away notes travel with its newest page. */
export const TURN_FINISHED_NOTE_REMOVALS_PER_PAGE = 100;

/**
 * The note to add when a member's turn ends and its reply is no longer the
 * last message where it stands (the timeline, or the thread it is in): the
 * member's posts during the turn, the User's words or other members' replies
 * came below it while it worked, and its answer would be lost above them
 * (the User, 2026-11-04). The reply keeps its place; the note goes at the end
 * and leads back to it.
 *
 * `accepted` are the messages the turn just wrote, in order; the last finished
 * reply among them is the one the note is about. None when it is last already,
 * when it ended in an error or a stop, when it has no words to show, when a
 * note for it exists, or when the User took its note away (`removedIds`).
 *
 * Below it counts what the chat draws there for the User: not another note
 * (two members finishing one after the other would each leave one for the
 * other's), and not a message her server refused, which stays at the end of
 * the chat on this device only.
 */
export function turnFinishedNoteFor(
  conversation: Pick<Conversation, "messages">,
  accepted: ChatMessage[],
  note: { createdAt: string; removedIds?: readonly string[] }
): ChatMessage | undefined {
  const reply = [...accepted].reverse().find(isFinishedReply);
  if (!reply || !reply.participantId) {
    return undefined;
  }
  const preview = turnFinishedNotePreview(reply.content);
  if (!preview || chatMessageHiddenFromTimeline(conversation, reply)) {
    return undefined;
  }
  const index = conversation.messages.findIndex((message) => message.id === reply.id);
  if (index < 0) {
    return undefined;
  }
  const id = turnFinishedNoteId(reply.id);
  if (note.removedIds?.includes(id) ||
    conversation.messages.some((message) => message.id === id || turnFinishedNoteOf(message)?.messageId === reply.id)) {
    return undefined;
  }
  const roots = chatParticipantRequestReplyRootMap(conversation);
  const where = chatMessageVisualThreadRootId(conversation, reply, roots);
  const written = new Set(accepted.map((message) => message.id));
  const below = conversation.messages.slice(index + 1).some((message) =>
    !written.has(message.id) &&
    !turnFinishedNoteOf(message) &&
    !message.metadata?.serverRejected &&
    !chatMessageHiddenFromTimeline(conversation, message) &&
    chatMessageVisualThreadRootId(conversation, message, roots) === where
  );
  if (!below) {
    return undefined;
  }
  const threadId = reply.metadata?.threadId ?? where;
  return {
    id,
    role: "system",
    content: preview,
    createdAt: note.createdAt,
    status: "done",
    metadata: {
      appMessageSource: TURN_FINISHED_NOTE_SOURCE,
      turnFinishedNote: {
        messageId: reply.id,
        participantId: reply.participantId,
        participantLabel: reply.participantLabel ?? ""
      },
      ...(threadId ? { threadId } : {}),
      // In a thread the note stays in that thread, under the replies there.
      ...(where ? { chatThreadRootId: where } : {})
    }
  };
}

/** A member's reply that ended well: what "finished answering" means. A post
 *  during the turn is not its reply. */
function isFinishedReply(message: ChatMessage): boolean {
  return message.role === "participant" &&
    message.status === "done" &&
    message.metadata?.appMessageSource !== APP_CHAT_SEND_MESSAGE_TOOL;
}

/** The reply's first line of words, without the markdown around it. */
export function turnFinishedNotePreview(content: string): string {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(```|~~~)/.test(line) || /^[-*_]{3,}$/.test(line)) {
      continue;
    }
    const text = line
      .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|~~|`)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      continue;
    }
    // Cut by characters, not UTF-16 units: an emoji is never split in two.
    const characters = Array.from(text);
    return characters.length > TURN_FINISHED_NOTE_PREVIEW_MAX
      ? `${characters.slice(0, TURN_FINISHED_NOTE_PREVIEW_MAX - 1).join("").trimEnd()}…`
      : text;
  }
  return "";
}
