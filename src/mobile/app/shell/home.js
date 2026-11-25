import { closeActivityItem } from "../activity/activityItem.js";
import { activityViewState } from "../activity/activityView.js";
import { ACTIVE_CONVERSATION_KEY } from "../base/storageKeys.js";
import { keepingReaderAtLatest, setOpenThreadRootId } from "../chat/chatScroll.js";
import { render } from "../chat/render.js";
import { closeChatSearch } from "../chats/chatSearch.js";
import { clearFocusMark, selectedConversationId } from "../chats/openChat.js";
import { pendingAttachments } from "../composer/pickedImages.js";
import { closeImageViewer } from "../media/attachments.js";
import { closeMembersSheet } from "../members/membersSheet.js";
import { closeNewChat } from "../newChat/newChatOffer.js";
import { loadPairing } from "../pairing/pairing.js";
import { setOpenMemberSessionId } from "../sessions/sessionsState.js";
import { dropCachedChatRows } from "../store/timelineRows.js";

// Which home tab the bottom bar shows (Chats, Activity, Settings), and which
// list Activity was left on. Coming back from a chat lands where you left.
const HOME_TAB_KEY = "accordagents.mobile.homeTab.v1";

const ACTIVITY_TAB_KEY = "accordagents.mobile.activityTab.v1";

// --- home: the bottom bar, Activity and Settings ---------------------------
//
// With no chat open the phone shows one of three home tabs, switched by the
// floating bar at the bottom: Chats, Activity and Settings. Activity lists
// what the relay already delivered (see mobile-activity.js), so it works the
// same whether the desktop is answering right now or not.

const HOME_TABS = ["chats", "activity", "settings"];

export const ACTIVITY_TABS = ["running", "pending", "finished"];
export const ACTIVITY_TAB_LABELS = { running: "Running", pending: "Pending", finished: "Finished" };
export const SVG_NS = "http://www.w3.org/2000/svg";

// A copy of the week's rows is kept until the store changes, and refreshed at
// least this often in case another window of the app wrote to it.
export const ACTIVITY_CACHE_MAX_AGE_MS = 60_000;

// A tap that lands this soon after the list was redrawn may have been aimed
// at a row that has since moved; answering is too consequential to guess.
export const ACTIVITY_TAP_GUARD_MS = 450;

// What the User cleared from Activity on this phone, by row key and the
// moment she cleared it. Local to the device, as the desktop's Clear is.
export const ACTIVITY_CLEARED_KEY = "accordagents.mobile.activityCleared.v1";

// How far a row slides to show its action, and how far a finger must travel
// before the list stops treating the gesture as a scroll.
export const SWIPE_ACTION_WIDTH = 88;

export const SWIPE_START_PX = 12;

// A batch for a chat the stored list does not have asks for the list again,
// at most this often.
export const CHAT_LIST_REFRESH_MIN_MS = 60_000;

export function setStoredValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A full quota must not stop the bar from switching; the choice is just
    // not remembered.
  }
}

// The chat's own dialogs: while one is open the bar is not there to be
// tapped behind it.
const CHAT_DIALOG_IDS = ["image-viewer", "members-sheet"];

const SCREEN_IDS = {
  chats: "chats-screen",
  activity: "activity-screen",
  settings: "settings-screen",
  timeline: "timeline-screen"
};

// What the User picked this session wins over what storage holds, so a
// write refused by a full quota does not flip the bar straight back.
let currentHomeTab;

let currentActivityTab;

export function homeTab() {
  if (currentHomeTab) return currentHomeTab;
  const stored = localStorage.getItem(HOME_TAB_KEY);
  return HOME_TABS.indexOf(stored) >= 0 ? stored : "chats";
}

export function setHomeTab(tab) {
  if (HOME_TABS.indexOf(tab) < 0) return;
  currentHomeTab = tab;
  setStoredValue(HOME_TAB_KEY, tab);
}

export function setActivityTab(tab) {
  currentActivityTab = tab;
  setStoredValue(ACTIVITY_TAB_KEY, tab);
}

/** Leaving the open chat, the one way the back button and the bar's tabs
 *  both take: the thread is left first, then the chat, so a redraw in
 *  between cannot land on a thread of a chat that is no longer open. */
export function leaveOpenChat() {
  if (!selectedConversationId()) return;
  clearFocusMark();
  closeMembersSheet();
  closeImageViewer();
  setOpenThreadRootId(undefined);
  setOpenMemberSessionId(undefined);
  localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
  dropCachedChatRows();
}

/** One way to change home tab, from the bar and from New chat's menu button
 *  alike: an open choice is left, the open chat is left (the bar is under
 *  the chat too, so a tab can be tapped from inside one), the tab is
 *  remembered, and the screen redrawn. */
export function switchHomeTab(tab) {
  // Search belongs to the Chats header: left open on another tab it would
  // keep the bar away with nothing on screen to close it.
  if (tab !== "chats") closeChatSearch();
  closeNewChat();
  closeActivityItem();
  leaveOpenChat();
  setHomeTab(tab);
  showScreen(tab);
  return render();
}

export function storedActivityTab() {
  if (currentActivityTab) return currentActivityTab;
  const stored = localStorage.getItem(ACTIVITY_TAB_KEY);
  return ACTIVITY_TABS.indexOf(stored) >= 0 ? stored : undefined;
}

/** Which home screen, or the open chat, is on screen. */
export function showScreen(name) {
  for (const key of Object.keys(SCREEN_IDS)) {
    const screen = document.getElementById(SCREEN_IDS[key]);
    if (screen) screen.classList.toggle("is-active", key === name);
  }
  // After the classes are on: applyDock reads the screen from them.
  applyDock();
  for (const tab of document.querySelectorAll("[data-home-tab]")) {
    const active = tab.dataset.homeTab === name;
    tab.dataset.active = active ? "true" : "false";
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
}

/** Whether the keyboard is up: the composer holding focus is what the height
 *  tracker already treats as the keyboard being open, so the bar and the
 *  measuring cannot disagree about it. */
export function composerHasFocus() {
  const active = document.activeElement;
  if (!active) return false;
  if (active.id === "composer-input") return true;
  // A card's own answer field raises the keyboard the same way the
  // composer does, and the bar has no room beside it either. So does one on
  // a choice opened from Activity: iOS lifts it, and the height must hold
  // there too or the screen shrinking would lift it a second time.
  return (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
    Boolean(active.closest && active.closest("#timeline-screen, #activity-item, #new-chat-screen"));
}

/** What is on screen, read from the screens themselves rather than kept
 *  beside them: the bar is decided outside a redraw too (the keyboard opens),
 *  and a remembered copy could then answer for a screen that is not up. */
export function screenOnShow() {
  for (const key of Object.keys(SCREEN_IDS)) {
    const screen = document.getElementById(SCREEN_IDS[key]);
    if (screen && screen.classList.contains("is-active")) return key;
  }
  return "chats";
}

/** The bar's own state. It shows on the home screens of a paired phone and
 *  under the chat's composer, as the User asked on 2026-09-20 (Slack's
 *  behaviour). It steps aside for a choice opened from Activity, so nothing
 *  behind it can be reached, and inside a chat while the keyboard is up,
 *  where there is no room for it. Called on every screen change and on the
 *  composer's focus and blur, which is when the keyboard comes and goes. */
export function applyDock() {
  const name = screenOnShow();
  const paired = Boolean(loadPairing());
  const home = name !== "timeline" && paired;
  const inChat = name === "timeline" && paired;
  // Anything that takes the screen for itself takes the bar with it: the
  // choice opened from Activity, a picture at full size, and the members
  // sheet — a dialog with a backdrop, and navigation left live outside a
  // backdrop is a way around it. The live-reply view is a screen of the
  // chat rather than a dialog, so the bar stays under that one.
  const sendLog = document.getElementById("send-log-sheet");
  const newChat = document.getElementById("new-chat-screen");
  const covered = (name === "activity" && Boolean(activityViewState.openActivityCardId)) ||
    Boolean(sendLog && !sendLog.hidden) || Boolean(newChat && !newChat.hidden) ||
    (inChat && CHAT_DIALOG_IDS.some(function (id) {
      const node = document.getElementById(id);
      return Boolean(node && !node.hidden);
    }));
  const typing = inChat && composerHasFocus();
  const shown = (home || inChat) && !covered && !typing;
  // Where the bar is, for the stylesheet: "1" floating over a home screen,
  // "chat" in the column under the composer, "0" not on screen at all.
  const placement = !shown ? "0" : home ? "1" : "chat";
  const dock = document.getElementById("home-dock");
  if (dock) dock.hidden = !shown;
  const phone = document.querySelector(".mobile-phone");
  if (phone) phone.dataset.dock = placement;
}

/** Layout that follows a field losing focus, run once the tap that took the
 *  focus has landed. A tap on a button while the keyboard is up blurs the
 *  field on the way down, and the release is hit-tested again: the bar coming
 *  back under the composer, or the composer folding to one line, pulls the
 *  button out from under the finger in between, and the tap only closes the
 *  keyboard — a card's Send, Allow or Deny tapped once and not taken. The
 *  work waits for the release, and runs behind the click that follows it;
 *  a blur no tap caused (the keyboard's own Done) waits out a short bound. */
const AFTER_TAP_BOUND_MS = 350;

const afterTapWork = new Set();
let afterTapTimer = 0;
let afterTapWired = false;

export function afterTapLands(work) {
  afterTapWork.add(work);
  if (!afterTapWired) {
    afterTapWired = true;
    for (const type of ["mouseup", "click"]) {
      document.addEventListener(type, function () {
        if (afterTapTimer) setTimeout(runAfterTapWork, 0);
      }, true);
    }
  }
  if (!afterTapTimer) afterTapTimer = setTimeout(runAfterTapWork, AFTER_TAP_BOUND_MS);
}

function runAfterTapWork() {
  clearTimeout(afterTapTimer);
  afterTapTimer = 0;
  const queued = Array.from(afterTapWork);
  afterTapWork.clear();
  for (const run of queued) run();
}

/** Slack's composer: one line until it is tapped, then the row of tools.
 *  Anything written or attached keeps it open, so a draft is never left
 *  without a way to send it. The one rule for the composer's shape; a fold
 *  that follows a tap goes through afterTapLands, or the text field slides
 *  under the finger still on Send and the tap's click lands on it — which
 *  on iOS raised the keyboard again right after a send (the User,
 *  2026-09-22). */
export function updateComposerShape() {
  const form = document.getElementById("composer-form");
  const input = document.getElementById("composer-input");
  if (!form || !input) return;
  const open = document.activeElement === input ||
    Boolean(input.value.trim()) ||
    pendingAttachments.length > 0;
  form.dataset.expanded = open ? "1" : "";
}

export function applyDockAfterTap() {
  afterTapLands(applyDockKeepingReader);
}

export function applyDockKeepingReader() {
  keepingReaderAtLatest(applyDock);
}
