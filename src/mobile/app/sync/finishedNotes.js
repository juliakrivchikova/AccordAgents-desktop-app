import { render } from "../chat/render.js";
import {
  FOCUS_SETTLE_MS, focusMessageRow, messageRowFor, openChatState, revealEarlierFocusMessage, selectedConversationId
} from "../chats/openChat.js";
import { createOutboxEvent, persistOutboundEvent, sendNow } from "../outbox/sending.js";
import { sessionsStateState } from "../sessions/sessionsState.js";
import { loadStoredStringArray, saveStoredStringArray } from "../store/database.js";
import { deleteTimelineEntry } from "../store/timelineRows.js";

/** A turn-finished note's target, as the server sent it: the member's reply
 *  the note leads back to. Nothing for any other system row. */
export function finishedNoteOfEvent(event) {
  const note = event && event.finishedNote;
  if (!note || typeof note !== "object" || typeof note.messageId !== "string" || !note.messageId.trim()) return {};
  return {
    finishedNote: {
      messageId: note.messageId.trim(),
      participantId: typeof note.participantId === "string" ? note.participantId : "",
      participantLabel: typeof note.participantLabel === "string" ? note.participantLabel : ""
    }
  };
}

// Notes the User took away on this phone, by entry id, kept until the
// server names them among the notes taken away (bounded: a removal the
// server never took is not remembered forever).
const DISMISSED_FINISHED_NOTES_KEY = "accordagents.mobile.dismissedFinishedNotes.v1";

const DISMISSED_FINISHED_NOTES_MAX = 200;
export const dismissedFinishedNotes = new Set(loadStoredStringArray(DISMISSED_FINISHED_NOTES_KEY));

/** The notes the server says the User took away (on any device): the
 *  copies kept here go, and those this phone took away are settled. */
export async function dropRemovedFinishedNotes(conversationId, removedIds) {
  let dropped = 0;
  let settled = false;
  for (const id of removedIds) {
    if (typeof id !== "string" || !id) continue;
    const entryId = conversationId + ":" + id;
    if (dismissedFinishedNotes.delete(entryId)) settled = true;
    if (await deleteTimelineEntry(entryId)) dropped += 1;
  }
  if (settled) saveDismissedFinishedNotes();
  return dropped;
}

function saveDismissedFinishedNotes() {
  const kept = [...dismissedFinishedNotes].slice(-DISMISSED_FINISHED_NOTES_MAX);
  if (kept.length < dismissedFinishedNotes.size) {
    dismissedFinishedNotes.clear();
    for (const id of kept) dismissedFinishedNotes.add(id);
  }
  saveStoredStringArray(DISMISSED_FINISHED_NOTES_KEY, kept);
}

/** The note's tap: the reply it leads back to, scrolled to and marked in
 *  the open chat, reading earlier pages when it is far above. */
export function openFinishedNoteTarget(messageId) {
  const conversationId = selectedConversationId();
  if (!conversationId || !messageId) return;
  const list = document.getElementById("message-list");
  const row = list ? messageRowFor(list, messageId) : undefined;
  if (row) {
    focusMessageRow(conversationId, row);
    return;
  }
  const focusRequest = { conversationId: conversationId, messageId: messageId };
  openChatState.pendingMessageFocus = focusRequest;
  // In the sessions view the reply can be in its member's session, which
  // the next drawing opens on it.
  if (sessionsStateState.lastSessionsState && sessionsStateState.lastSessionsState.conversationId === conversationId) void render();
  void revealEarlierFocusMessage(focusRequest).finally(function () {
    setTimeout(function () {
      if (openChatState.pendingMessageFocus === focusRequest) openChatState.pendingMessageFocus = undefined;
    }, FOCUS_SETTLE_MS);
  });
}

/** The note's cross: gone from this phone now, and from every device once
 *  the server takes its removal. */
export async function dismissFinishedNote(messageId) {
  const conversationId = selectedConversationId();
  if (!conversationId || !messageId) return;
  const entryId = conversationId + ":" + messageId;
  // The removal is queued first: a note hidden here and never removed on
  // the server would stay on every other device.
  await createOutboxEvent({ conversationId: conversationId, kind: "message.remove", payload: { messageId: messageId } }).then(persistOutboundEvent);
  dismissedFinishedNotes.add(entryId);
  saveDismissedFinishedNotes();
  await deleteTimelineEntry(entryId);
  await render("synced");
  // Where every other write goes, at once.
  await sendNow();
}
