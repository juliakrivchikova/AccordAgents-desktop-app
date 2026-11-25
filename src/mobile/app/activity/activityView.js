import { activityDataState, lineIcon, loadActivity } from "./activityData.js";
import { closeActivityItem, renderActivityItem } from "./activityItem.js";
import { nowIso } from "../base/bytes.js";
import { answerControlCard, cardSentText, controlCardAnswering, controlCardErrors, isCardLocked } from "../cards/cardAnswers.js";
import { sessionsMentionTextFor, sessionsViewLabelFor, sessionsViewNamesFor, sessionsViewSummaryTextFor } from "../cards/cardText.js";
import { cardOnItsWay, cardStateText, onItsWayNote } from "../cards/controlCard.js";
import { formatElapsed } from "../chat/messageRows.js";
import { render, renderRevision } from "../chat/render.js";
import { loadChats } from "../chats/chatStore.js";
import { openConversation, selectedConversationId } from "../chats/openChat.js";
import { avatarForLabel, avatarSignature, paintAvatar } from "../members/avatars.js";
import { chatMembers, conversationMembers } from "../members/mentions.js";
import { stopRequestedRunIds, stopRunFromPhone } from "../outbox/sending.js";
import { chatViewOf } from "../sessions/sessionsState.js";
import { providerLogoElement } from "../sessions/sessionsStatus.js";
import { renderSettings } from "../settings/settingsView.js";
import {
  ACTIVITY_CLEARED_KEY, ACTIVITY_TAB_LABELS, ACTIVITY_TABS, ACTIVITY_TAP_GUARD_MS, setActivityTab, setStoredValue, showScreen,
  storedActivityTab, SWIPE_ACTION_WIDTH, SWIPE_START_PX
} from "../shell/home.js";
import { relativeTime } from "../sync/connectionStatus.js";

export const activityViewState = {
  // The choice opened from Activity to be answered in full, by card id.
  openActivityCardId: undefined
};

let lastActivityRenderSignature = "";

// When the Activity list was last redrawn; taps right after it are ignored.
let lastActivityListRenderAt = 0;

let lastActivityRowOrder = "";

export async function renderHome(tab, revision) {
  const activity = await loadActivity();
  if (revision !== renderRevision || selectedConversationId()) return;
  renderActivityBadge(activity);
  if (tab === "activity") {
    renderActivity(activity);
  } else if (tab === "settings") {
    renderSettings();
  }
}

/** The bar's Activity number on its own, for when the lists are not on
 *  screen: inside a chat. Built from rows already read — see loadActivity —
 *  so an open chat never pays for a pass over the store. */
export async function refreshDockBadge(revision) {
  const activity = await loadActivity({ cached: true });
  // A newer redraw has taken over: its own number is the one to keep.
  if (revision !== undefined && revision !== renderRevision) return;
  if (!activity) return;
  renderActivityBadge(activity);
}

function renderActivityBadge(activity) {
  const badge = document.getElementById("activity-badge");
  const tab = document.querySelector('[data-home-tab="activity"]');
  const count = activity && self.AccordMobileActivity ? self.AccordMobileActivity.attentionCount(activity) : 0;
  if (badge) {
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
  }
  if (tab) tab.setAttribute("aria-label", count > 0 ? "Activity, " + count + " new" : "Activity");
}

function activityAvatarFor(conversationId, handle) {
  return avatarForLabel(conversationMembers(conversationId), handle || "Agent");
}

/** The provider of the member an Activity row is about, by its handle. */
function activityMemberKind(conversationId, handle) {
  const chat = loadChats().find(function (item) { return item.id === conversationId; });
  const key = String(handle || "").trim().replace(/^@/, "").toLowerCase();
  const member = chat && key ? chatMembers(chat).find(function (item) {
    return [item.handle, item.mentionHandle].some(function (name) { return String(name || "").replace(/^@/, "").toLowerCase() === key; });
  }) : undefined;
  return member && member.kind ? member.kind : "";
}

/** Who an Activity row is about, as its chat's view names it: its handle,
 *  or in the sessions view a member's task ("" for the main session). */
export function activityRowWho(row) {
  return sessionsViewLabelFor(row.conversationId, row.handle);
}

export function activityRowAvatar(conversationId, handle) {
  // A sessions-view chat has no avatars: the member's provider logo.
  if (sessionsViewNamesFor(conversationId)) {
    const glyph = document.createElement("span");
    glyph.className = "act-avatar act-avatar-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.append(providerLogoElement(activityMemberKind(conversationId, handle), ""));
    return glyph;
  }
  const avatar = document.createElement("span");
  avatar.className = "mobile-chat-avatar act-avatar";
  paintAvatar(avatar, activityAvatarFor(conversationId, handle), conversationId);
  // Its name is read out as the row names it: no handle in the sessions view.
  const who = sessionsViewLabelFor(conversationId, handle);
  if (who !== handle && avatar.hasAttribute("aria-label")) {
    if (who) avatar.setAttribute("aria-label", who);
    else avatar.removeAttribute("aria-label");
  }
  return avatar;
}

/** The two lines every Activity row starts with: the chat, who (and where,
 *  for a permission), when, and whether it is new; then what was said. */
function activityRowMain(row, stamp) {
  const main = document.createElement("button");
  main.type = "button";
  main.className = "act-main";
  const top = document.createElement("span");
  top.className = "act-top";
  const title = document.createElement("span");
  title.className = "act-chat-title";
  title.textContent = row.chatTitle;
  // "by @drew · Office Mac": who asks, and where it would run. A machine is
  // never named as the author. A chat in the sessions view names a member
  // by its task and the main session by nothing.
  const who = activityRowWho(row);
  const byText = who
    ? " by " + [who, row.machineName].filter(Boolean).join(" · ")
    : row.machineName ? " · " + row.machineName : "";
  if (byText) {
    const by = document.createElement("span");
    by.className = "act-by";
    by.textContent = byText;
    title.append(by);
  }
  top.append(title);
  for (const node of stamp) top.append(node);
  const preview = document.createElement("span");
  preview.className = "act-preview" + (row.kind === "permission" ? " act-preview-full" : "");
  preview.textContent = (row.kind === "permission" ? sessionsViewSummaryTextFor(row.conversationId, row.preview) : sessionsMentionTextFor(row.conversationId, row.preview)) || (row.kind === "run" ? "Thinking…" : "");
  main.append(top, preview);
  return main;
}

function activityTime(iso) {
  const time = document.createElement("span");
  time.className = "act-time";
  time.textContent = relativeTime(iso);
  return time;
}

/** The whole row is the way in, as a chat-list row is, not only its text. */
function makeRowOpen(element, open) {
  element.dataset.tappable = "1";
  element.addEventListener("click", open);
}

// What has been cleared, most recently cleared last, bounded: a phone does
// not keep a year of them, and the newest are the ones that must survive.
const ACTIVITY_CLEARED_LIMIT = 2000;

export function loadClearedActivity() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVITY_CLEARED_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter(function (id) { return typeof id === "string"; }) : [];
  } catch {
    return [];
  }
}

/** Clearing a finished row hides the updates that row stands for, and only
 *  those: the next answer from that member in that chat is a new update and
 *  brings the row back. Named by update rather than by a moment in time,
 *  because a finished row is stamped when its run started — a run already in
 *  flight would otherwise be swallowed when it finished. */
function clearActivityRow(row) {
  const ids = Array.isArray(row && row.entryIds) ? row.entryIds : [];
  if (ids.length === 0) return;
  const cleared = loadClearedActivity().filter(function (id) { return ids.indexOf(id) < 0; });
  const next = cleared.concat(ids).slice(-ACTIVITY_CLEARED_LIMIT);
  setStoredValue(ACTIVITY_CLEARED_KEY, JSON.stringify(next));
  activityDataState.activityMemo = undefined;
  void render();
}

/** One row is open at a time: a second swipe closes the first, and so does a
 *  tap anywhere else. */
let openSwipeRow;

// Kept beside the node: the list is rebuilt from scratch, so the node goes
// and the row it stood for does not.
let openSwipeKey;

function closeOpenSwipe() {
  if (openSwipeRow && openSwipeRow.isConnected) {
    openSwipeRow.dataset.swiped = "0";
  }
  openSwipeRow = undefined;
  openSwipeKey = undefined;
}

/** The Activity list is rebuilt whenever anything in it changes, including
 *  once a minute for the clock. An open row is re-opened on the new node so
 *  the action does not vanish between the swipe and the tap. */
function restoreOpenSwipe(list) {
  if (!openSwipeKey || !list) return;
  const wrap = list.querySelector('.act-swipe[data-activity-key="' + cssEscapeValue(openSwipeKey) + '"]');
  if (!wrap) {
    openSwipeRow = undefined;
    openSwipeKey = undefined;
    return;
  }
  wrap.dataset.swiped = "1";
  openSwipeRow = wrap;
}

function cssEscapeValue(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

/** The row slides left under the finger and stops at its action. Vertical
 *  movement wins until the finger has travelled far enough sideways, so the
 *  list still scrolls normally. */
function makeRowSwipeable(wrap, surface) {
  let startX = 0;
  let startY = 0;
  let sliding = false;
  let decided = false;
  surface.addEventListener("touchstart", function (event) {
    if (event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    sliding = false;
    decided = false;
  }, { passive: true });
  surface.addEventListener("touchmove", function (event) {
    if (event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - startX;
    const dy = event.touches[0].clientY - startY;
    if (!decided) {
      if (Math.abs(dy) > Math.abs(dx)) {
        decided = true;
        return;
      }
      if (Math.abs(dx) < SWIPE_START_PX) return;
      decided = true;
      sliding = true;
      if (openSwipeRow && openSwipeRow !== wrap) closeOpenSwipe();
    }
    if (!sliding) return;
    const offset = Math.max(-SWIPE_ACTION_WIDTH, Math.min(0, dx));
    surface.style.transform = "translateX(" + offset + "px)";
  }, { passive: true });
  const settle = function (event) {
    if (!sliding) return;
    sliding = false;
    surface.style.transform = "";
    const dx = (event.changedTouches && event.changedTouches[0] ? event.changedTouches[0].clientX : startX) - startX;
    const open = dx <= -SWIPE_ACTION_WIDTH / 2;
    wrap.dataset.swiped = open ? "1" : "0";
    openSwipeRow = open ? wrap : undefined;
    openSwipeKey = open ? wrap.dataset.activityKey : undefined;
  };
  surface.addEventListener("touchend", settle);
  surface.addEventListener("touchcancel", settle);
}

/** A row with an action behind it. The action is a real button — reachable
 *  by a screen reader without the gesture — and the row itself keeps doing
 *  what it did before. */
function rowWithSwipeAction(element, action) {
  if (!action) return element;
  const wrap = document.createElement("div");
  wrap.className = "act-swipe";
  wrap.dataset.swiped = "0";
  if (element.dataset.activityKey) wrap.dataset.activityKey = element.dataset.activityKey;
  const actions = document.createElement("div");
  actions.className = "act-swipe-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "act-swipe-action act-swipe-" + action.kind;
  button.setAttribute("aria-label", action.label);
  button.append(action.icon, (function () {
    const label = document.createElement("span");
    label.textContent = action.label;
    return label;
  })());
  button.addEventListener("click", function (event) {
    event.stopPropagation();
    closeOpenSwipe();
    action.run();
  });
  actions.append(button);
  element.classList.add("act-swipe-surface");
  // A tap on the row itself closes the action rather than opening the chat
  // behind it: the row is showing something to be answered, not a link.
  element.addEventListener("click", function (event) {
    if (wrap.dataset.swiped !== "1") return;
    event.stopPropagation();
    event.preventDefault();
    closeOpenSwipe();
  }, true);
  makeRowSwipeable(wrap, element);
  wrap.append(actions, element);
  return wrap;
}

function finishedActivityRow(row) {
  const element = document.createElement("div");
  element.className = "act-row" + (row.read ? "" : " is-unread");
  element.dataset.activityKey = row.key;
  const stamp = [activityTime(row.at)];
  if (row.count > 1) {
    const badge = document.createElement("span");
    badge.className = "act-badge" + (row.read ? " act-badge-read" : "");
    badge.textContent = String(row.count);
    badge.setAttribute("aria-label", row.count + " updates");
    stamp.push(badge);
  } else if (!row.read) {
    const dot = document.createElement("span");
    dot.className = "act-dot";
    dot.setAttribute("aria-label", "Unread");
    stamp.push(dot);
  }
  const col = document.createElement("div");
  col.className = "act-col";
  col.append(activityRowMain(row, stamp));
  element.append(activityRowAvatar(row.conversationId, row.handle), col);
  makeRowOpen(element, function () {
    // In the sessions view a member's reply is in its session, which opens
    // on it (there are no threads to open).
    const chat = loadChats().find(function (item) { return item.id === row.conversationId; });
    void openConversation(row.conversationId, chatViewOf(chat) === "sessions" && row.messageId
      ? { messageId: row.messageId } : { threadRootId: row.threadRootId });
  });
  // Swipe left to clear it from this phone's Activity, the way the desktop's
  // "Clear from activity" works there: local to the device (the User,
  // 2026-09-20).
  return rowWithSwipeAction(element, {
    kind: "clear",
    label: "Clear",
    icon: lineIcon(["M18 6 6 18", "m6 6 12 12"], 20),
    run: function () { clearActivityRow(row); }
  });
}

function pendingActivityRow(row) {
  const card = row.card;
  const element = document.createElement("div");
  element.className = "act-row is-unread";
  element.dataset.activityKey = row.key;
  element.dataset.cardId = card.id;
  element.dataset.cardKind = card.kind;
  const dot = document.createElement("span");
  dot.className = "act-dot act-dot-pending";
  dot.setAttribute("aria-label", "Waiting for you");
  const col = document.createElement("div");
  col.className = "act-col";
  col.append(activityRowMain(row, [activityTime(row.at), dot]));
  const sent = isCardLocked(card.id) || controlCardAnswering.has(card.id);
  if (row.kind === "choice" || card.plan) {
    // A choice is read and answered in full, so the row opens it; so is a
    // plan, read before it is approved, as in Claude Code.
    const chevron = document.createElement("span");
    chevron.className = "act-chevron";
    chevron.append(lineIcon(["m9 18 6-6-6-6"], 20));
    element.append(activityRowAvatar(row.conversationId, row.handle), col, chevron);
    makeRowOpen(element, function () {
      activityViewState.openActivityCardId = card.id;
      showScreen("activity");
      void render();
    });
  } else {
    const actions = document.createElement("div");
    actions.className = "act-actions";
    // A tap that misses a pill by a few pixels stays on the list: it was
    // meant for an answer, not for opening the chat behind the row.
    actions.addEventListener("click", function (event) { event.stopPropagation(); });
    const buttons = [];
    for (const option of Array.isArray(card.options) ? card.options : []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "act-pill" + (option.id === "allow" ? " act-pill-primary" : "");
      button.dataset.optionId = option.id;
      button.textContent = option.label || option.id;
      button.disabled = sent;
      button.addEventListener("click", function (event) {
        event.stopPropagation();
        // Rows can move when a card arrives or leaves; a tap right after a
        // redraw may have been meant for another row.
        if (Date.now() - lastActivityListRenderAt < ACTIVITY_TAP_GUARD_MS) return;
        // One answer per card: the other option goes dead with the first tap.
        for (const other of buttons) other.disabled = true;
        void answerControlCard(card, { optionId: option.id });
      });
      buttons.push(button);
      actions.append(button);
    }
    col.append(actions);
    element.append(activityRowAvatar(row.conversationId, row.handle), col);
    makeRowOpen(element, function () {
      void openConversation(row.conversationId);
    });
  }
  // A tap is not the answer being applied; the row leaves when the desktop
  // says the card is answered, and until then it only fades.
  element.classList.toggle("is-on-its-way", cardOnItsWay(card));
  if (cardOnItsWay(card)) col.append(onItsWayNote());
  const stateText = cardStateText(card);
  if (stateText) {
    const state = document.createElement("p");
    state.className = "act-state";
    state.textContent = stateText;
    col.append(state);
  }
  // Swipe left to cancel, as the desktop's "Cancel pending card" does. Only
  // where cancelling is the card's own answer: a permission is answered by
  // Allow or Deny, and those are already in the row — a second control
  // meaning Deny would be a trap.
  if (!card.allowsCancel || sent) {
    return element;
  }
  return rowWithSwipeAction(element, {
    kind: "cancel",
    label: "Cancel",
    icon: lineIcon(["M18 6 6 18", "m6 6 12 12"], 20),
    run: function () {
      if (Date.now() - lastActivityListRenderAt < ACTIVITY_TAP_GUARD_MS) return;
      void answerControlCard(card, { cancel: true });
    }
  });
}

function runningActivityRow(row) {
  const element = document.createElement("div");
  element.className = "act-row";
  element.dataset.activityKey = row.key;
  const elapsed = document.createElement("span");
  // Ticked by the same clock as the chat's own running rows.
  elapsed.className = "act-elapsed thinking-elapsed";
  elapsed.dataset.startedAt = row.at || nowIso();
  elapsed.textContent = formatElapsed(row.at);
  const live = document.createElement("span");
  live.className = "mobile-live-dot";
  live.setAttribute("aria-label", "Running");
  const col = document.createElement("div");
  col.className = "act-col";
  col.append(activityRowMain(row, [elapsed, live]));
  element.append(activityRowAvatar(row.conversationId, row.handle), col);
  if (row.cancellable) {
    const stopping = row.stopping || stopRequestedRunIds.has(row.runId);
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "act-stop";
    stop.dataset.runId = row.runId;
    stop.disabled = stopping;
    stop.setAttribute("aria-label", stopping ? "Stopping" : "Stop " + (activityRowWho(row) || "this run"));
    const ring = document.createElement("span");
    ring.className = "act-stop-ring";
    const square = document.createElement("span");
    square.className = "act-stop-square";
    ring.append(square);
    stop.append(ring);
    stop.addEventListener("click", function (event) {
      event.stopPropagation();
      if (stop.disabled || Date.now() - lastActivityListRenderAt < ACTIVITY_TAP_GUARD_MS) return;
      stop.disabled = true;
      stop.setAttribute("aria-label", "Stopping");
      void stopRunFromPhone(row.runId, row.conversationId);
    });
    element.append(stop);
  }
  makeRowOpen(element, function () {
    // The member's turn in progress, not the end of the chat: what it
    // posted during the turn sits below it.
    void openConversation(row.conversationId, row.openMessageId
      ? { threadRootId: row.openThreadRootId, messageId: row.openMessageId }
      : { threadRootId: row.threadRootId });
  });
  return element;
}

function activityEmptyText(tab) {
  if (tab === "running") return "Nothing is running right now.";
  if (tab === "pending") return "Nothing is waiting for you.";
  const days = self.AccordMobileActivity ? self.AccordMobileActivity.WINDOW_DAYS : 7;
  return "No updates from members in the last " + days + " days.";
}

function renderActivityTabs(data, tab) {
  const tabsHost = document.getElementById("activity-tabs");
  if (!tabsHost) return;
  const signature = JSON.stringify([tab, ACTIVITY_TABS.map(function (name) { return data[name].length; })]);
  if (tabsHost.dataset.signature === signature) return;
  tabsHost.dataset.signature = signature;
  tabsHost.replaceChildren();
  for (const name of ACTIVITY_TABS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "act-tab";
    button.dataset.activityTab = name;
    button.dataset.active = name === tab ? "true" : "false";
    if (name === tab) button.setAttribute("aria-current", "true");
    const label = document.createElement("span");
    label.textContent = ACTIVITY_TAB_LABELS[name];
    const count = document.createElement("span");
    count.className = "act-tab-count";
    count.textContent = String(data[name].length);
    button.append(label, count);
    if (name === tab) {
      const bar = document.createElement("span");
      bar.className = "act-tab-bar";
      button.append(bar);
    }
    button.addEventListener("click", function () {
      setActivityTab(name);
      const list = document.getElementById("activity-list");
      if (list) list.scrollTop = 0;
      void render();
    });
    tabsHost.append(button);
  }
}

function renderActivity(activity) {
  const list = document.getElementById("activity-list");
  if (!list) return;
  const data = activity || { running: [], pending: [], finished: [] };
  const openCard = activityViewState.openActivityCardId
    ? data.pending.find(function (row) { return row.card.id === activityViewState.openActivityCardId; })
    : undefined;
  if (activityViewState.openActivityCardId && !openCard) {
    // Answered or withdrawn: there is nothing left to answer here.
    closeActivityItem();
    showScreen("activity");
  }
  void renderActivityItem(openCard);
  let tab = storedActivityTab();
  if (!tab) {
    // Chosen once there is something to choose by, and then kept: a list
    // that switched itself whenever a card came or went would move rows
    // under a finger.
    tab = data.pending.length > 0 ? "pending" : data.running.length > 0 ? "running" : "finished";
    if (data.pending.length + data.running.length + data.finished.length > 0) setActivityTab(tab);
  }
  renderActivityTabs(data, tab);
  // Only the list on screen decides whether it is drawn again.
  const rows = data[tab];
  const signature = JSON.stringify({
    tab: tab,
    minute: Math.floor(Date.now() / 60_000),
    rows: rows.map(function (row) {
      return [row.key, row.chatTitle, row.handle, row.machineName, row.preview, row.at, row.count, row.read,
        row.cancellable, row.stopping, avatarSignature(activityAvatarFor(row.conversationId, row.handle)), activityRowWho(row), Boolean(sessionsViewNamesFor(row.conversationId)),
        row.card ? [isCardLocked(row.card.id), cardSentText(row.card.id), controlCardAnswering.has(row.card.id), controlCardErrors.get(row.card.id) || ""] : 0,
        row.runId ? stopRequestedRunIds.has(row.runId) : 0];
    })
  });
  if (signature === lastActivityRenderSignature) return;
  lastActivityRenderSignature = signature;
  // The guard against a tap meant for a row that has just moved is armed
  // only when rows did move. A redraw for the clock, a streaming preview or
  // a card's state leaves every row where it was, and a tap on one of them
  // is meant — armed on those too, a Stop or an Allow was dropped, with
  // nothing on screen to say so, for half a second after every redraw.
  const order = tab + "\n" + rows.map(function (row) { return row.key; }).join("\n");
  if (order !== lastActivityRowOrder) {
    lastActivityRowOrder = order;
    lastActivityListRenderAt = Date.now();
  }
  list.replaceChildren();
  list.dataset.activityTab = tab;
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mobile-empty act-empty";
    empty.textContent = activityEmptyText(tab);
    list.append(empty);
    return;
  }
  for (const row of rows) {
    list.append(tab === "running" ? runningActivityRow(row) : tab === "pending" ? pendingActivityRow(row) : finishedActivityRow(row));
  }
  restoreOpenSwipe(list);
}
