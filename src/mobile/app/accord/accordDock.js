import { accordIcon, accordLaunchAvatarSignature, accordStageElement } from "./accordCards.js";
import { accordLinesState, closeAccordIntoChat } from "./accordLines.js";
import { lineIcon } from "../activity/activityData.js";
import { sessionsViewTextFor } from "../cards/cardText.js";
import { keepingReaderAtLatest } from "../chat/chatScroll.js";
import { render } from "../chat/render.js";
import { loadChats } from "../chats/chatStore.js";
import { openChatState } from "../chats/openChat.js";
import { mobileSharedRules } from "../members/avatars.js";
import { closeMembersSheet } from "../members/membersSheet.js";
import { sessionsStateState, setOpenMemberSessionId } from "../sessions/sessionsState.js";

// The chat's newest Accord, pinned above the composer as on the desktop
// (the User, 2026-11-08): it stays until she closes it or a new Accord
// starts, and its head folds it into one line. Both are this phone's own
// choice, kept per chat.
export const ACCORD_DOCK_STORAGE_KEY = "accordagents.accordDock.v1";

function readAccordDockState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCORD_DOCK_STORAGE_KEY) || "{}");
    // "closed" (the cross closed a card for good on this phone, before
    // 2026-11-16) is no longer read: the cross folds it into the chat.
    return {
      closedIntoChat: parsed && typeof parsed.closedIntoChat === "object" && parsed.closedIntoChat ? parsed.closedIntoChat : {},
      folded: parsed && typeof parsed.folded === "object" && parsed.folded ? parsed.folded : {}
    };
  } catch (error) {
    return { closedIntoChat: {}, folded: {} };
  }
}

export function setAccordDockChoice(key, conversationId, launchId, on) {
  const state = readAccordDockState();
  if (on) state[key][conversationId] = launchId;
  // Undone only for the Accord it was set for, not a newer one since.
  else if (state[key][conversationId] === launchId) delete state[key][conversationId];
  try {
    localStorage.setItem(ACCORD_DOCK_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // A full or blocked storage only forgets the choice after a reload.
  }
}

/** The Accord a launch started, as the open chat's rows know it. */
export function sessionsAccordOf(launchId) {
  const progress = accordLinesState.renderAccordProgress;
  if (!progress || !launchId) return undefined;
  if (progress.docked && progress.docked.launchId === launchId) return progress.docked;
  return progress.accordOf(launchId) || undefined;
}

/** The sessions view opens an Accord on a screen of its own (the desktop
 *  opens it in the right panel). */
export function openAccordScreen(launchId) {
  if (!launchId) return;
  closeMembersSheet();
  setOpenMemberSessionId(undefined);
  // A member's message still to be landed on would open its session again.
  openChatState.pendingMessageFocus = undefined;
  sessionsStateState.openAccordLaunchId = launchId;
  void render();
}

export function closeAccordScreen() {
  sessionsStateState.openAccordLaunchId = undefined;
  void render();
}

/** The chat's newest Accord while it is not closed into the chat (on any
 *  device, or by her cross here): the one pinned above the composer. */
export function accordStillOpen(conversationId, docked) {
  if (!docked) return null;
  const state = readAccordDockState();
  const chat = loadChats().find(function (item) { return item.id === conversationId; });
  const listed = Boolean(chat) && Array.isArray(chat.accordClosed) && chat.accordClosed.indexOf(docked.launchId) >= 0;
  const closedHere = state.closedIntoChat[conversationId] === docked.launchId;
  const closedLine = Boolean(accordLinesState.renderAccordProgress) && accordLinesState.renderAccordProgress.lines.has(docked.launchId);
  return !closedHere && !closedLine && !listed ? docked : null;
}

/** The Accord in the sessions view: one quiet line (its icon, its title
 *  and where it stands) that opens it on its own screen. */
function accordStripElement(docked) {
  const shared = mobileSharedRules();
  const strip = document.createElement("button");
  strip.type = "button";
  strip.className = "accord-strip";
  strip.dataset.openAccord = docked.launchId;
  const icon = document.createElement("span");
  icon.className = "accord-strip-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.append(accordIcon(14));
  const text = document.createElement("span");
  text.className = "accord-strip-text";
  text.textContent = docked.progress.title + " · " + shared.accordProgressStatus(docked.progress);
  strip.setAttribute("aria-label", "Accord: " + text.textContent);
  strip.append(icon, text, lineIcon(["m9 18 6-6-6-6"], 14));
  strip.addEventListener("click", function () { openAccordScreen(docked.launchId); });
  return strip;
}

export function renderAccordDock(conversationId, docked, asStrip) {
  const dock = document.getElementById("accord-dock");
  if (!dock) return;
  const state = readAccordDockState();
  // Closed into the chat, on any device: the card is its line there now.
  // Her server's list records it over the whole chat; a line among the
  // rows here says so too; and her cross here, until the server has it.
  const shown = accordStillOpen(conversationId, docked);
  const folded = Boolean(shown) && state.folded[conversationId] === shown.launchId;
  const signature = shown ? JSON.stringify([conversationId, shown.launchId, shown.progress, folded, Boolean(asStrip), accordLaunchAvatarSignature({ conversationId: conversationId }, shown.card)]) : "";
  dock.dataset.conversationId = conversationId || "";
  if (dock.dataset.signature === signature) return;
  dock.dataset.signature = signature;
  dock.classList.toggle("is-strip", Boolean(asStrip));
  // The timeline gets shorter or longer: a reader at the latest message stays there.
  keepingReaderAtLatest(function () {
    dock.replaceChildren();
    dock.hidden = !shown;
    if (shown) dock.append(asStrip ? accordStripElement(shown) : accordDockElement(conversationId, shown, folded));
  });
}

/** A text with its members named the sessions view's way (their tasks;
 *  anyone else without "@"), where it cannot hold a chip. */
function sessionsPlainHandles(text) {
  return String(text || "").replace(/(^|[^A-Za-z0-9_@./-])@([A-Za-z0-9][A-Za-z0-9_-]*)/g, function (_, before, handle) {
    const member = sessionsMemberByHandle(handle);
    return before + (member ? member.title : handle);
  });
}

/** A member of the open chat by its handle, as the sessions view names it. */
export function sessionsMemberByHandle(handle) {
  return sessionsStateState.sessionsMentionScope ? sessionsStateState.sessionsMentionScope.byHandle.get(String(handle || "").replace(/^@/, "").toLowerCase()) : undefined;
}

/** The Accord's card. Pinned above the composer by default; `inline` is the
 *  card a closed Accord's line opens in the chat, whose head and cross fold
 *  it back into the line. */
export function accordDockElement(conversationId, docked, folded, inline) {
  const shared = mobileSharedRules();
  const progress = docked.progress;
  // On the sessions view's Accord screen members are named by their tasks.
  const entry = { conversationId: conversationId, ...(sessionsStateState.sessionsMentionScope ? { presentation: "sessions" } : {}) };
  const card = document.createElement("section");
  card.className = "accord-dock-card" + (progress.reached ? " is-reached" : "") + (folded ? " is-folded" : "");
  card.setAttribute("aria-label", "Accord");
  const head = document.createElement("div");
  head.className = "accord-dock-head";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "accord-dock-toggle";
  toggle.setAttribute("aria-expanded", String(!folded));
  toggle.addEventListener("click", function () {
    if (inline) return inline.fold();
    setAccordDockChoice("folded", conversationId, docked.launchId, !folded);
    renderAccordDock(conversationId, docked);
  });
  const icon = document.createElement("span");
  icon.className = "accord-dock-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.append(accordIcon(folded ? 16 : 20));
  const heading = document.createElement("span");
  heading.className = "accord-dock-heading";
  const title = document.createElement("span");
  title.className = "accord-dock-title";
  title.textContent = progress.title;
  heading.append(title);
  if (!folded) {
    const meta = document.createElement("span");
    meta.className = "accord-dock-meta";
    const kind = document.createElement("span");
    kind.className = "accord-dock-kind";
    kind.textContent = "Accord";
    // The sessions view names members by their tasks, not their handles,
    // and the main session by nothing (left out, as on the desktop).
    const named = function (handle) {
      if (!sessionsStateState.sessionsMentionScope) return "@" + handle;
      const member = sessionsMemberByHandle(handle);
      return member ? member.title : String(handle).toLowerCase() === sessionsStateState.sessionsMentionScope.mainHandle ? "" : handle;
    };
    const lead = named(docked.card.facilitator);
    const others = docked.card.members.map(named).filter(Boolean);
    meta.append(kind, document.createTextNode((lead ? " · led by " + lead : "") + (others.length ? " · with " + others.join(", ") : "")));
    heading.append(meta);
  }
  const status = document.createElement("span");
  status.className = "accord-progress-status";
  status.textContent = shared.accordProgressStatus(progress);
  toggle.append(icon, heading, status);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "accord-dock-close";
  close.setAttribute("aria-label", inline ? "Fold" : "Close");
  close.append(lineIcon(["M18 6 6 18", "m6 6 12 12"], 16));
  close.addEventListener("click", function () {
    if (inline) return inline.fold();
    void closeAccordIntoChat(conversationId, docked);
  });
  head.append(toggle, close);
  card.append(head);
  if (folded) return card;
  const stages = document.createElement("ol");
  stages.className = "accord-progress-stages";
  stages.setAttribute("aria-label", "Accord progress");
  for (const stage of shared.accordProgressStages(progress)) stages.append(accordStageElement(entry, stage));
  card.append(stages);
  const version = progress.version;
  if (version) {
    // The phone has no artifact viewer, so it offers no Open (as its
    // artifact notes open nothing).
    const note = document.createElement("div");
    note.className = "accord-progress-note";
    const noteHead = document.createElement("span");
    noteHead.className = "accord-progress-note-head";
    noteHead.textContent = sessionsViewTextFor(entry && entry.conversationId, shared.accordProgressNoteHead(version));
    note.append(noteHead);
    if (version.note) {
      const body = document.createElement("span");
      body.className = "accord-progress-note-body";
      body.textContent = sessionsStateState.sessionsMentionScope ? sessionsPlainHandles(version.note) : version.note;
      note.append(body);
    }
    card.append(note);
  }
  return card;
}
