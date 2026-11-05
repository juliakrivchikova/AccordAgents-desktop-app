import type { ChatMessage, ChatTurnFinishedNoteMetadata } from "./types";

/** metadata.appMessageSource of a turn-finished note: the line at the end of
 *  the chat that says a member finished answering, when its reply had other
 *  messages below it by then (the User, 2026-11-04). Kept apart from the rule
 *  that decides when one is written so the timeline's visibility rule can read
 *  it without importing the thread helpers that read that rule. */
export const TURN_FINISHED_NOTE_SOURCE = "app_turn_finished_note";

/** The reply a turn-finished note points at; none for any other message. */
export function turnFinishedNoteOf(
  message: Pick<ChatMessage, "role" | "metadata">
): ChatTurnFinishedNoteMetadata | undefined {
  if (message.role !== "system" || message.metadata?.appMessageSource !== TURN_FINISHED_NOTE_SOURCE) {
    return undefined;
  }
  // Written by another device: read as strings, or not as a note at all.
  const note = message.metadata.turnFinishedNote as Partial<ChatTurnFinishedNoteMetadata> | undefined;
  if (!note || typeof note.messageId !== "string" || !note.messageId ||
    typeof note.participantId !== "string" || typeof note.participantLabel !== "string") {
    return undefined;
  }
  return { messageId: note.messageId, participantId: note.participantId, participantLabel: note.participantLabel };
}
