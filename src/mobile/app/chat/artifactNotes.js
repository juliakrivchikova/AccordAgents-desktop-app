import { lineIcon } from "../activity/activityData.js";
import { noteProgressOf } from "../cards/cardRows.js";
import { sessionsViewLabelFor } from "../cards/cardText.js";
import { formatClockTime } from "./messageRows.js";
import { mobileSharedRules } from "../members/avatars.js";

// The FileBox outline the desktop's artifact cards and links use.
const ARTIFACT_NOTE_ICON_PATHS = [
  "M14.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4",
  "M14 2v4a2 2 0 0 0 2 2h4",
  "M3 13.1a2 2 0 0 0-1 1.76v3.24a2 2 0 0 0 .97 1.78L6 21.7a2 2 0 0 0 2.03.01L11 19.9a2 2 0 0 0 1-1.76V14.9a2 2 0 0 0-.97-1.78L8 11.3a2 2 0 0 0-2.03-.01Z",
  "M7 17v5",
  "M11.7 14.2 7 17l-4.7-2.8"
];

/** An artifact note, its sentence read by the desktop's own parser
 *  (artifactNoteCard.ts). The server sends the phone no other system rows
 *  but these (messageTravelsToPhone), and the phone's own machine notes
 *  never read as one; a note it cannot read stays a bubble. */
export function artifactNoteCardForEntry(entry) {
  if (!entry || entry.author !== "system" || entry.scaffolding) return undefined;
  const shared = mobileSharedRules();
  return shared && typeof shared.parseArtifactNoteCard === "function"
    ? shared.parseArtifactNoteCard(entry.content)
    : undefined;
}

/** The note as the desktop shows it: a card with no avatar or author line,
 *  who did what inside it. The phone has no artifact viewer, so the card
 *  names the artifact as the note did and opens nothing. */
export function artifactNoteCardElement(entry, card) {
  const shared = mobileSharedRules();
  const wrap = document.createElement("div");
  wrap.className = "artifact-note-card";
  const icon = document.createElement("span");
  icon.className = "artifact-note-icon";
  icon.append(lineIcon(ARTIFACT_NOTE_ICON_PATHS, 20));
  const text = document.createElement("div");
  text.className = "artifact-note-text";
  // Who did what leads the card; the artifact and the time follow in grey.
  const title = document.createElement("div");
  title.className = "artifact-note-title";
  const actor = document.createElement("span");
  actor.className = card.actor === "user" ? "artifact-note-actor" : "artifact-note-actor is-member";
  // The sessions view names a member by its task and the main session by
  // nothing ("Revised v3").
  const actorName = sessionsViewLabelFor(entry.conversationId, shared.artifactNoteActorLabel(card.actor));
  const verb = shared.artifactNoteVerb(card.action);
  actor.textContent = actorName;
  if (actorName) title.append(actor, document.createTextNode(" " + verb));
  else title.append(document.createTextNode(verb.charAt(0).toUpperCase() + verb.slice(1)));
  const version = card.action === "published" || card.action === "revised"
    ? card.details.find(function (detail) { return /^v\d+$/.test(detail); })
    : undefined;
  if (version) {
    const tag = document.createElement("span");
    tag.className = "artifact-note-version";
    tag.textContent = version;
    title.append(tag);
  }
  const details = card.details.filter(function (detail) { return detail !== version; });
  if (details.length) title.append(document.createTextNode(" · " + details.join(" · ")));
  const meta = document.createElement("div");
  meta.className = "artifact-note-meta";
  const when = formatClockTime(entry.createdAt);
  meta.textContent = card.label + (when ? " · " + when : "");
  text.append(title, meta);
  if (card.note) {
    const body = document.createElement("div");
    body.className = "artifact-note-body";
    body.textContent = card.note;
    text.append(body);
  }
  wrap.append(icon, text);
  const progress = noteProgressOf(entry);
  if (progress) wrap.append(artifactNoteMarksElement(progress));
  return wrap;
}

// The desktop's FileText and BadgeCheck outlines: a draft, a signature.
const DRAFT_MARK_PATHS = [
  "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
  "M14 2v4a2 2 0 0 0 2 2h4",
  "M10 9H8",
  "M16 13H8",
  "M16 17H8"
];

const SIGNATURE_MARK_PATHS = [
  "M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z",
  "m9 12 2 2 4-4"
];

/** One mark per member the artifact waits for: grey until their draft or
 *  signature is in, lilac once it is, green when every signature is. */
function artifactNoteMarksElement(progress) {
  const marks = document.createElement("span");
  marks.className = "artifact-note-marks" + (progress.total > 3 ? " is-many" : "");
  marks.setAttribute("role", "img");
  marks.setAttribute("aria-label", (progress.kind === "drafts" ? "Drafts " : "Signed ") + progress.done.length + " of " + progress.total);
  for (let index = 0; index < progress.total; index += 1) {
    const mark = document.createElement("span");
    const given = index < progress.done.length;
    mark.className = "artifact-note-mark" + (given ? (progress.complete ? " is-complete" : " is-given") : "");
    mark.append(lineIcon(progress.kind === "drafts" ? DRAFT_MARK_PATHS : SIGNATURE_MARK_PATHS, 15));
    marks.append(mark);
  }
  return marks;
}
