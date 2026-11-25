import { lineIcon } from "../activity/activityData.js";
import { applyRowIdentity, formatClockTime } from "./messageRows.js";
import { sessionsMemberTitleOf, sessionsStateState } from "../sessions/sessionsState.js";
import { providerLogoElement } from "../sessions/sessionsStatus.js";

/** The reply a turn-finished note leads back to; none for any other row. */
export function finishedNoteOfEntry(entry) {
  return entry && entry.author === "system" && !entry.scaffolding && entry.finishedNote && entry.finishedNote.messageId
    ? entry.finishedNote
    : undefined;
}

// The desktop's X outline, for the note's close button.
export const FINISHED_NOTE_CLOSE_PATHS = ["M18 6 6 18", "m6 6 12 12"];

/** A member finished answering while its reply had other messages below
 *  it: the desktop's card, with the member, the reply's first line and a
 *  cross. A tap leads to the reply; the cross takes the note away
 *  (the User, 2026-11-04). */
export function finishedNoteCardElement(entry) {
  const note = finishedNoteOfEntry(entry);
  const wrap = document.createElement("div");
  wrap.className = "finished-note-card";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "finished-note-open";
  // The sessions view names a member by its task with its provider's logo,
  // the main session by nothing: no handle, label or avatar there.
  const sessionsView = entry.presentation === "sessions";
  const sessionsState = sessionsView && sessionsStateState.lastSessionsState ? sessionsStateState.lastSessionsState : undefined;
  const label = sessionsState && note.participantId === sessionsState.mainId ? ""
    : sessionsState ? sessionsMemberTitleOf(sessionsState, note.participantId) : note.participantLabel || "A member";
  // Its name is what it says (who, the time, the reply's first words).
  open.title = label ? "Go to " + label + "'s reply" : "Go to the reply";
  open.dataset.finishedNoteTarget = note.messageId;
  let avatar;
  if (sessionsState) {
    const member = sessionsState.members.find(function (item) { return item.id === note.participantId; });
    avatar = providerLogoElement(member ? member.kind : "", "is-note");
  } else {
    avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    applyRowIdentity(avatar, { ...entry, participantLabel: label, identified: Boolean(note.participantLabel) });
  }
  const text = document.createElement("div");
  text.className = "finished-note-text";
  const title = document.createElement("div");
  title.className = "finished-note-title";
  const who = document.createElement("span");
  who.className = "finished-note-actor";
  who.textContent = label;
  const when = formatClockTime(entry.createdAt);
  if (label) title.append(who, document.createTextNode(" finished answering" + (when ? " · " + when : "")));
  else title.append(document.createTextNode("Finished answering" + (when ? " · " + when : "")));
  const preview = document.createElement("div");
  preview.className = "finished-note-preview";
  preview.textContent = entry.content || "";
  text.append(title, preview);
  open.append(avatar, text);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "finished-note-close";
  close.setAttribute("aria-label", "Dismiss note");
  close.dataset.finishedNoteDismiss = entry.sourceId || entry.id;
  close.append(lineIcon(FINISHED_NOTE_CLOSE_PATHS, 16));
  wrap.append(open, close);
  return wrap;
}
