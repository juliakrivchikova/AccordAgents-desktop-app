import { accordIcon, accordLaunchAvatarSignature, accordLaunchCardForEntry } from "./accordCards.js";
import { accordDockElement, renderAccordDock, setAccordDockChoice } from "./accordDock.js";
import { createEventId, nowIso } from "../base/bytes.js";
import { cardRowElement } from "../cards/cardRows.js";
import { artifactNoteCardForEntry } from "../chat/artifactNotes.js";
import { messageRowSignature } from "../chat/messageRows.js";
import { render } from "../chat/render.js";
import { mobileSharedRules } from "../members/avatars.js";
import { createOutboxEvent, persistOutboundEvent, sendNow } from "../outbox/sending.js";

export const accordLinesState = {
  // Each Accord's progress for the rows being drawn, by launch message id,
  // and the launches drawn as cards (their notes are folded into them).
  renderAccordProgress: null
};

function accordLaunchIdOf(row) {
  return accordLaunchCardForEntry(row) ? (row.messageId || row.sourceId) : undefined;
}

export function accordProgressFor(rows) {
  const shared = mobileSharedRules();
  // The lines closed Accords left in the chat: the first for each Accord,
  // by launch (one closed on two devices at once draws one line).
  const lines = new Map();
  for (const row of rows) {
    const launchId = accordClosedLaunchOf(row);
    if (launchId && !lines.has(launchId)) lines.set(launchId, row.rowKey || row.id);
  }
  const empty = { folded: new Set(), docked: null, lines: lines, accordOf: function () { return null; } };
  if (!shared || typeof shared.dockedAccordFrom !== "function" || typeof shared.accordFoldedNoteKeys !== "function") return empty;
  const notes = rows.filter(function (row) {
    return row.author === "system" && Boolean(artifactNoteCardForEntry(row));
  }).map(function (row) {
    return {
      key: row.rowKey || row.id, content: row.content, createdAt: row.createdAt,
      accordLaunchMessageId: row.accordLaunchMessageId, accordLaunch: row.accordLaunch
    };
  });
  if (!notes.some(function (note) { return note.accordLaunchMessageId; })) return empty;
  const launches = [];
  for (const row of rows) {
    const id = accordLaunchIdOf(row);
    if (id) launches.push({ id: id, card: accordLaunchCardForEntry(row), createdAt: row.createdAt });
  }
  const docked = shared.dockedAccordFrom(launches, notes);
  const known = new Map();
  // Every Accord's document notes leave the chat: pinned, closed or older,
  // its steps are on its card or in its document (the User, 2026-11-08).
  return {
    folded: shared.accordFoldedNoteKeys(notes), docked: docked, lines: lines,
    accordOf: function (launchId) {
      if (typeof shared.accordOfLaunch !== "function") return null;
      if (!known.has(launchId)) known.set(launchId, shared.accordOfLaunch(launches, notes, launchId) || null);
      return known.get(launchId);
    }
  };
}

export function accordFoldedRow(row) {
  if (!accordLinesState.renderAccordProgress) return false;
  if (accordLinesState.renderAccordProgress.folded.has(row.rowKey || row.id)) return true;
  // A second line for the same Accord draws nothing.
  const launchId = accordClosedLaunchOf(row);
  return Boolean(launchId) && accordLinesState.renderAccordProgress.lines.get(launchId) !== (row.rowKey || row.id);
}

export function accordClosedLaunchOf(row) {
  const closed = row && row.author === "system" ? row.accordClosed : undefined;
  return closed && typeof closed.launchMessageId === "string" && closed.launchMessageId ? closed.launchMessageId : undefined;
}

// Lines opened into the Accord's card, by row: this phone's own, as an
// urgent alert's are.
const expandedAccordLines = new Set();

/**
 * The line a closed Accord left at the end of the chat as it stood when the
 * User pressed the cross on its card (the User, 2026-11-16): one line like
 * a folded urgent alert -- the document's name, then where it stands. A tap
 * opens the very card there; its head or its cross folds it back.
 */
export function accordLineElement(entry) {
  const shared = mobileSharedRules();
  const launchId = accordClosedLaunchOf(entry);
  // One line per Accord: kept open by it, also when the server's copy takes
  // the place of this phone's own.
  const key = entry.conversationId + "\0" + launchId;
  const accord = launchId && accordLinesState.renderAccordProgress ? accordLinesState.renderAccordProgress.accordOf(launchId) : null;
  const wrap = document.createElement("div");
  wrap.className = "accord-line";
  const lineIconElement = function () {
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.append(accordIcon(15));
    return icon;
  };
  if (!accord) {
    // Its document's notes are not on this phone: the line says which
    // Accord it was, and opens nothing.
    const title = entry.accordClosed && typeof entry.accordClosed.title === "string" ? entry.accordClosed.title : "";
    wrap.append(cardRowElement("div", lineIconElement(), title || "Accord", "Accord", false));
    return wrap;
  }
  const fold = function (open) {
    return function () {
      if (open) expandedAccordLines.add(key);
      else expandedAccordLines.delete(key);
      const item = wrap.closest("li.message-row");
      const next = accordLineElement(entry);
      wrap.replaceWith(next);
      if (item) item.dataset.rowSignature = messageRowSignature(entry);
      const target = next.querySelector(open ? ".accord-dock-toggle" : ".card-row");
      if (target) target.focus({ preventScroll: true });
      // A render already under way may still draw the row as it was (the
      // server's copy replacing this phone's): the next one draws it as
      // she left it.
      void render("synced");
    };
  };
  if (expandedAccordLines.has(key)) {
    wrap.classList.add("is-open");
    wrap.append(accordDockElement(entry.conversationId, accord, false, { fold: fold(false) }));
    return wrap;
  }
  const row = cardRowElement("button", lineIconElement(), accord.progress.title,
    typeof shared.accordLineOutcome === "function" ? shared.accordLineOutcome(accord.progress) : shared.accordProgressStatus(accord.progress), true);
  // Read out as what it is, then what it shows.
  const kind = document.createElement("span");
  kind.className = "sr-only";
  kind.textContent = "Accord: ";
  row.insertBefore(kind, row.querySelector(".card-row-preview"));
  row.addEventListener("click", fold(true));
  wrap.append(row);
  return wrap;
}

export function accordLineSignatureOf(entry) {
  const launchId = accordClosedLaunchOf(entry);
  if (!launchId) return undefined;
  const accord = accordLinesState.renderAccordProgress ? accordLinesState.renderAccordProgress.accordOf(launchId) : null;
  return JSON.stringify([launchId, expandedAccordLines.has(entry.conversationId + "\0" + launchId), accord ? accord.progress : null,
    accord ? accordLaunchAvatarSignature({ conversationId: entry.conversationId }, accord.card) : null]);
}

/** The pinned card's cross (the User, 2026-11-16): the card folds into a
 *  line at the end of the chat as it stands now, written to the server like
 *  any message, so every device shows it in the same place. It leaves the
 *  composer at once; the line comes with the chat. */
export async function closeAccordIntoChat(conversationId, docked) {
  const shared = mobileSharedRules();
  if (accordLinesState.renderAccordProgress && accordLinesState.renderAccordProgress.lines.has(docked.launchId)) return;
  if (!shared || typeof shared.accordClosedLine !== "function") return;
  const eventId = createEventId();
  const createdAt = nowIso();
  setAccordDockChoice("closedIntoChat", conversationId, docked.launchId, true);
  renderAccordDock(conversationId, docked);
  try {
    await createOutboxEvent({
      eventId: eventId, conversationId: conversationId, kind: "message.system", createdAt: createdAt,
      payload: { message: shared.accordClosedLine({ id: eventId, launchMessageId: docked.launchId, title: docked.progress.title, createdAt: createdAt }) }
    }).then(persistOutboundEvent);
  } catch (error) {
    // Not queued: the card stays where it was, for another try.
    setAccordDockChoice("closedIntoChat", conversationId, docked.launchId, false);
    renderAccordDock(conversationId, docked);
    return;
  }
  await render("synced");
  // Where every other write goes, at once.
  await sendNow();
}
