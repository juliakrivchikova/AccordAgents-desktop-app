import { accordDockElement, closeAccordScreen } from "../accord/accordDock.js";
import { lineIcon } from "../activity/activityData.js";
import { syncPendingCards } from "../cards/tailCards.js";
import { mobileSharedRules } from "../members/avatars.js";
import {
  formatWorkedMs, providerLogoElement, sessionsActivityElement, sessionsDelegationRowElement, sessionsElapsedElement,
  sessionsStatusElement, sessionsStopButton
} from "./sessionsStatus.js";
import { renderMessageContentIfChanged } from "../text/messageText.js";

const HAMMER_ICON_PATHS = ["m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9", "m18 15 4-4", "m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"];

/** The tasks a main-session turn gave, as T3 Code shows them: in the
 *  reply's "Worked for …" fold (open while the reply is still written),
 *  a summary line, then a row per task. A task no reply holds is its rows
 *  alone. */
export function sessionsDelegationsElement(delegations) {
  const rows = delegations.entries.map(sessionsDelegationRowElement);
  if (delegations.standalone) {
    const wrap = document.createElement("div");
    wrap.className = "sessions-delegations";
    wrap.append(...rows);
    return wrap;
  }
  const wrap = document.createElement("div");
  wrap.className = "sessions-worked" + (delegations.open ? " is-open" : "") + (delegations.live ? " is-live" : "") + (delegations.continued ? " is-continued" : "");
  // A part its turn went on from: open, with no "Worked for" of its own.
  if (!delegations.live && !delegations.continued) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "sessions-worked-toggle";
    toggle.dataset.workedFold = delegations.key;
    toggle.setAttribute("aria-expanded", delegations.open ? "true" : "false");
    const label = document.createElement("span");
    label.textContent = typeof delegations.workedMs === "number" ? "Worked for " + formatWorkedMs(delegations.workedMs) : "Worked";
    toggle.append(label, lineIcon([delegations.open ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6"], 14));
    wrap.append(toggle);
  }
  if (delegations.open) {
    const summary = document.createElement("div");
    summary.className = "sessions-worked-summary";
    const text = document.createElement("span");
    text.textContent = delegations.summary;
    summary.append(lineIcon(HAMMER_ICON_PATHS, 14), text);
    const body = document.createElement("div");
    body.className = "sessions-worked-body";
    // A finished turn's steps first, as they came, then its tasks.
    if (!delegations.live && Array.isArray(delegations.activity) && delegations.activity.length) body.append(sessionsActivityElement(delegations, false));
    body.append(summary, ...rows);
    wrap.append(body);
  }
  return wrap;
}

/** A member's choice still waiting for the User, on the main timeline:
 *  who asks (its logo and task; opens its session) and the card itself. */
function sessionsChoiceElement(entry) {
  const wrap = document.createElement("div");
  wrap.className = "message-copy sessions-member-choice";
  const from = document.createElement("button");
  from.type = "button";
  from.className = "sessions-choice-from";
  from.dataset.openMember = entry.memberChoice.participantId || "";
  const name = document.createElement("span");
  name.className = "sessions-choice-name";
  name.textContent = entry.memberChoice.name;
  from.append(providerLogoElement(entry.memberChoice.kind, "is-small"), name, document.createTextNode(" asks"), lineIcon(["m9 18 6-6-6-6"], 14));
  wrap.append(from);
  syncPendingCards(wrap, entry);
  return wrap;
}

function sessionsMemberHeadElement(head) {
  const wrap = document.createElement("div");
  wrap.className = "member-session-head";
  const text = document.createElement("span");
  text.className = "member-session-provider";
  text.textContent = [head.detail, head.location].filter(Boolean).join(" · ");
  const state = document.createElement("span");
  state.className = "member-session-state";
  if (head.status !== "idle") state.append(sessionsStatusElement(head.status));
  if (head.since) state.append(sessionsElapsedElement(head.since));
  wrap.append(providerLogoElement(head.kind), text, state);
  if (head.canStop || head.stopping) wrap.append(sessionsStopButton([head.participantId], head.canStop, head.stopping, "Stop this session"));
  return wrap;
}

function sessionsTaskFoldElement(entry) {
  const fold = entry.taskFold;
  const wrap = document.createElement("div");
  wrap.className = "member-task" + (fold.open ? " is-open" : "");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "member-task-toggle";
  toggle.dataset.taskFold = entry.rowKey || entry.id;
  toggle.setAttribute("aria-expanded", fold.open ? "true" : "false");
  toggle.append(lineIcon([fold.open ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6"], 14));
  const label = document.createElement("span");
  label.className = "member-task-label";
  label.textContent = fold.label;
  toggle.append(label);
  if (!fold.open) {
    const preview = document.createElement("span");
    preview.className = "member-task-preview";
    preview.textContent = fold.preview;
    toggle.append(preview);
  }
  wrap.append(toggle);
  if (fold.open) {
    const body = document.createElement("div");
    body.className = "member-task-body message-content";
    renderMessageContentIfChanged(body, entry.content, "agent");
    wrap.append(body);
  }
  return wrap;
}

/** The Accord on its own screen in the sessions view: its whole card. */
function sessionsAccordScreenElement(entry) {
  const wrap = document.createElement("div");
  wrap.className = "sessions-accord-screen";
  wrap.append(accordDockElement(entry.conversationId, entry.accordScreen, false, { fold: closeAccordScreen }));
  return wrap;
}

/** What a row of the sessions view draws instead of, or besides, a plain
 *  message. */
export function sessionsSpecialSignature(entry) {
  if (entry.delegations) return "delegations:" + JSON.stringify(entry.delegations);
  if (entry.memberHead) return "head:" + JSON.stringify(entry.memberHead);
  if (entry.taskFold) return "fold:" + JSON.stringify(entry.taskFold);
  if (entry.sessionsEmpty) return "empty:" + entry.sessionsEmpty;
  if (entry.memberChoice) return "choice:" + JSON.stringify(entry.memberChoice);
  if (entry.accordScreen) return "accord:" + JSON.stringify([entry.accordScreen.launchId, entry.accordScreen.progress]);
  return undefined;
}

/** Draws a sessions-view row that is not a plain message; false when the
 *  row is a message (its delegations are drawn with it). */
export function appendSessionsSpecial(item, entry) {
  if (entry.delegations && entry.delegations.standalone) {
    item.dataset.sessionsKind = "task";
    item.append(sessionsDelegationsElement(entry.delegations));
    return true;
  }
  if (entry.memberHead) {
    item.dataset.sessionsKind = "member-head";
    item.append(sessionsMemberHeadElement(entry.memberHead));
    return true;
  }
  if (entry.taskFold) {
    item.dataset.sessionsKind = "task-fold";
    item.append(sessionsTaskFoldElement(entry));
    return true;
  }
  if (entry.sessionsEmpty) {
    item.dataset.sessionsKind = "empty";
    const empty = document.createElement("p");
    empty.className = "member-session-empty";
    empty.textContent = entry.sessionsEmpty;
    item.append(empty);
    return true;
  }
  if (entry.memberChoice) {
    item.dataset.sessionsKind = "choice";
    item.append(sessionsChoiceElement(entry));
    return true;
  }
  if (entry.accordScreen) {
    item.dataset.sessionsKind = "accord";
    item.append(sessionsAccordScreenElement(entry));
    return true;
  }
  return false;
}

/** Which `@handle` in a message is a member's chip in the sessions view,
 *  in prose and in code: the desktop's own rule (sessionsMentionPieces),
 *  an exact handle of a member or a former one; everything else, the main
 *  session's handle and handles of nobody included, stays as written. */
export function sessionsMentionPiecesOf(text, scope) {
  const source = String(text || "");
  const shared = mobileSharedRules();
  if (!scope || !shared || typeof shared.sessionsMentionPieces !== "function") return source ? [{ text: source }] : [];
  return shared.sessionsMentionPieces(source, function (handle) { return scope.byHandle.has(handle); }, function (handle) { return handle === scope.mainHandle; });
}

/** A member's chip: its provider's logo and its task, opening its session. */
export function sessionsMemberChip(handle, scope) {
  const member = scope && scope.byHandle.get(String(handle).toLowerCase());
  if (!member) return document.createTextNode("@" + handle);
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "sessions-member-chip";
  chip.dataset.openMember = member.id;
  if (member.focus) chip.dataset.focusMessage = member.focus;
  const title = document.createElement("span");
  title.textContent = member.title;
  chip.append(providerLogoElement(member.kind, "is-chip"), title);
  return chip;
}

export function appendSessionsMentions(parent, text, scope) {
  sessionsMentionPiecesOf(text, scope).forEach(function (piece) {
    parent.append(piece.handle !== undefined ? sessionsMemberChip(piece.handle, scope) : document.createTextNode(piece.text));
  });
}
