import { nowIso, recordRelayDebug } from "../base/bytes.js";
import { outboxStatusById } from "../base/storageKeys.js";
import { formatClockTime } from "../chat/messageRows.js";
import { loadChats } from "../chats/chatStore.js";
import { syncHeaderSpacer } from "../members/membersSheet.js";
import { serverOwesEntry } from "./sending.js";
import { isHubPairing } from "../pairing/hubPairing.js";
import { loadPairing } from "../pairing/pairing.js";
import { settingsViewState } from "../settings/settingsView.js";
import { applyDock } from "../shell/home.js";
import { requestToPromise, withNamedStore } from "../store/database.js";

// --- the send log (agreement Д12) -----------------------------------------
// Every attempt to send that failed — no connection, a timeout, an error
// answer, the server refusing it — with when, what was sent (its kind, its
// chat, a little of its text) and why. Kept on this phone, the newest
// SEND_FAILURES_KEPT, and shown from the chat's header and from Settings.

export const SEND_FAILURES_STORE = "sendFailures";

const SEND_FAILURES_KEPT = 200;
const SEND_FAILURE_TEXT_CHARS = 80;

// When the User last opened the log: the header points at it while a send
// is failing, or after a refusal (or a chat this phone could not start)
// she has not seen.
export const SEND_LOG_SEEN_KEY = "accordagents.mobile.sendLogSeenAt.v1";

export let sendLogNewestAt = "";
let sendLogNewestRefusalAt = "";

// Whether that newest one is a chat this phone could not start (a fork
// that failed after she left its screen), not a refusal by her server.
let sendLogNewestNotStarted = false;

export let sendLogCount = 0;

/** What an entry is, for the log: its kind, its chat and a little of it. */
export function sendFailureRecord(entry, failure, attempt) {
  const payload = entry.payload || {};
  let text = "";
  if (entry.kind === "message.created" || !entry.kind) {
    text = String(payload.content || "").replace(/\s+/g, " ").trim() || (Array.isArray(payload.attachments) && payload.attachments.length ? "A picture" : "");
  } else if (entry.kind === "message.system") {
    text = String(payload.message && payload.message.content || "");
  } else if (entry.kind === "turn.stop") {
    const chat = loadChats().find(function (item) { return item.id === entry.conversationId; });
    const member = chat && Array.isArray(chat.members) ? chat.members.find(function (item) { return item.id === payload.participantId; }) : undefined;
    text = (payload.sendNow ? "Send now" : "Stop") + (member ? " @" + member.handle : "");
  } else if (entry.kind === "card.answer") {
    text = String(payload.label || "Your answer");
  } else if (entry.kind === "conversation.create") {
    text = String(payload.conversation && payload.conversation.title || "");
  } else if (entry.kind === "message.remove") {
    text = "Dismiss a finished-answering note";
  } else if (entry.kind === "conversation.pin") {
    const chat = loadChats().find(function (item) { return item.id === entry.conversationId; });
    text = (payload.pinned === true ? "Pin " : "Unpin ") + (chat && chat.title ? "“" + chat.title + "”" : "a chat");
  } else if (entry.kind === "conversation.view") {
    const chat = loadChats().find(function (item) { return item.id === entry.conversationId; });
    text = "Show " + (chat && chat.title ? "“" + chat.title + "”" : "a chat") + " in the " + (payload.view === "classic" ? "Classic" : "Sessions") + " view";
  }
  return {
    entryId: entry.eventId,
    kind: entry.kind || "message.created",
    conversationId: entry.conversationId,
    text: text.length > SEND_FAILURE_TEXT_CHARS ? text.slice(0, SEND_FAILURE_TEXT_CHARS - 1) + "\u2026" : text,
    cause: failure.cause,
    reason: failure.reason,
    ...(attempt ? { attempt: attempt } : {})
  };
}

/** What the header points at until she has looked: her server's refusal,
 *  or a chat this phone could not start once she had left its screen. */
function sendLogNeedsLook(record) {
  return Boolean(record) && (record.cause === "refused" || record.notStarted === true);
}

/** Writes one failed attempt, and lets go of the oldest past the bound. A
 *  log that cannot be written never stops the sending it describes. */
export function recordSendFailure(record) {
  const at = nowIso();
  const chat = loadChats().find(function (item) { return item.id === record.conversationId; });
  const stored = { ...record, at: at, ...(chat && chat.title ? { chatTitle: chat.title } : {}) };
  sendLogNewestAt = at;
  if (sendLogNeedsLook(record)) {
    sendLogNewestRefusalAt = at;
    sendLogNewestNotStarted = record.notStarted === true;
  }
  recordRelayDebug({ event: "send-failure", kind: record.kind, cause: record.cause, reason: record.reason });
  return withNamedStore(SEND_FAILURES_STORE, "readwrite", function (store) {
    store.add(stored);
    const counting = store.count();
    counting.onsuccess = function () {
      let extra = Number(counting.result) - SEND_FAILURES_KEPT;
      sendLogCount = Math.min(SEND_FAILURES_KEPT, Number(counting.result) || 0);
      if (extra <= 0) return;
      // The oldest first: the keys count up as attempts are written.
      const oldest = store.openCursor();
      oldest.onsuccess = function () {
        const row = oldest.result;
        if (!row || extra <= 0) return;
        row.delete();
        extra -= 1;
        row.continue();
      };
    };
  }).then(function () {
    settingsViewState.lastSettingsRenderSignature = "";
  }, function () { return undefined; });
}

/** The log, newest first. */
export function listSendFailures() {
  return withNamedStore(SEND_FAILURES_STORE, "readonly", function (store) {
    return requestToPromise(store.getAll());
  }).then(function (rows) {
    const list = Array.isArray(rows) ? rows.slice().reverse() : [];
    sendLogCount = list.length;
    if (list[0] && list[0].at > sendLogNewestAt) sendLogNewestAt = list[0].at;
    const refusal = list.find(sendLogNeedsLook);
    if (refusal && refusal.at > sendLogNewestRefusalAt) {
      sendLogNewestRefusalAt = refusal.at;
      sendLogNewestNotStarted = refusal.notStarted === true;
    }
    return list;
  }).catch(function () { return []; });
}

/** How many queue entries still wait for the server, and whether one of
 *  them has failed an attempt (the header then points at the log). */
export function owedSummary() {
  let owed = 0;
  let failing = 0;
  for (const held of outboxStatusById.values()) {
    if (!serverOwesEntry(held)) continue;
    owed += 1;
    if (held.failedAt) failing += 1;
  }
  return { owed: owed, failing: failing };
}

function sendLogSeenAt() {
  try {
    return localStorage.getItem(SEND_LOG_SEEN_KEY) || "";
  } catch {
    return "";
  }
}

/** The way to the log from the chat's header, beside where it says whether
 *  the phone is connected: there while a send is failing, and after a
 *  refusal (or a chat this phone could not start) the User has not looked
 *  at. It sits before the members button at the header's end. */
export function renderSendLogButton() {
  const button = document.getElementById("send-log-button");
  if (!button) return;
  const summary = owedSummary();
  const unseenRefusal = Boolean(sendLogNewestRefusalAt) && sendLogNewestRefusalAt > sendLogSeenAt();
  const shown = isHubPairing(loadPairing()) && (summary.failing > 0 || unseenRefusal);
  button.hidden = !shown;
  syncHeaderSpacer();
  button.setAttribute("aria-label", summary.failing > 0
    ? "Send log: " + (summary.failing === 1 ? "something you sent has" : summary.failing + " things you sent have") + " not reached your server yet"
    : sendLogNewestNotStarted
      ? "Send log: a chat you started did not start"
      : "Send log: your server did not take something you sent");
}

function sendLogKindLabel(record) {
  if (record.kind === "turn.stop") return "";
  if (record.kind === "card.answer") return "Answer: ";
  if (record.kind === "message.system") return "Note ";
  if (record.kind === "conversation.create") return "New chat: ";
  if (record.kind === "conversation.pin" || record.kind === "conversation.view") return "";
  return "Message ";
}

let sendLogDayFormatter;

export function sendLogTime(iso) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return "";
  if (new Date(time).toDateString() === new Date().toDateString()) return formatClockTime(iso);
  if (!sendLogDayFormatter) sendLogDayFormatter = new Intl.DateTimeFormat([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return sendLogDayFormatter.format(new Date(time));
}

/** The log's rows: tries of one thing that failed the same way one after
 *  another are one row, with how many and from when to when. */
function groupSendFailures(records) {
  const groups = [];
  for (const record of records) {
    const last = groups[groups.length - 1];
    if (last && record.entryId && last.entryId === record.entryId && last.reason === record.reason) {
      last.count += 1;
      last.firstAt = record.at;
      continue;
    }
    groups.push({ ...record, count: 1, firstAt: record.at, lastAt: record.at });
  }
  return groups;
}

let sendLogRenderToken = 0;

/** Opens the send log: every attempt that failed, newest first, with what
 *  it was, its chat, and why. */
export async function openSendLog() {
  const sheet = document.getElementById("send-log-sheet");
  const list = document.getElementById("send-log-list");
  const summaryNode = document.getElementById("send-log-summary");
  if (!sheet || !list) return;
  const token = ++sendLogRenderToken;
  const records = await listSendFailures();
  if (token !== sendLogRenderToken) return;
  try {
    localStorage.setItem(SEND_LOG_SEEN_KEY, nowIso());
  } catch {
    // The header keeps pointing here a little longer.
  }
  const summary = owedSummary();
  if (summaryNode) {
    summaryNode.textContent = summary.owed > 0
      ? (summary.owed === 1 ? "1 thing you sent has" : summary.owed + " things you sent have") + " not reached your server yet. It is tried again while the app is open."
      : "Everything you sent has reached your server.";
  }
  list.replaceChildren();
  if (records.length === 0) {
    const empty = document.createElement("div");
    empty.className = "members-sheet-empty";
    empty.textContent = "Nothing failed to send.";
    list.append(empty);
  }
  for (const group of groupSendFailures(records)) {
    const row = document.createElement("div");
    row.className = "send-log-row";
    row.dataset.cause = group.cause || "";
    row.dataset.entryId = group.entryId || "";
    const head = document.createElement("span");
    head.className = "send-log-when";
    head.textContent = [sendLogTime(group.lastAt), group.chatTitle].filter(Boolean).join(" · ");
    const what = document.createElement("strong");
    what.className = "send-log-what";
    const label = sendLogKindLabel(group);
    what.textContent = group.kind === "message.created" || group.kind === "message.system"
      ? label + "\u201c" + (group.text || "") + "\u201d"
      : label + (group.text || "");
    const why = document.createElement("span");
    why.className = "send-log-why";
    why.textContent = group.reason || "";
    row.append(head, what, why);
    if (group.count > 1) {
      const count = document.createElement("span");
      count.className = "send-log-count";
      count.textContent = group.count + " tries, " + sendLogTime(group.firstAt) + "\u2013" + sendLogTime(group.lastAt);
      row.append(count);
    }
    list.append(row);
  }
  const footer = document.createElement("div");
  footer.className = "send-log-footer";
  footer.textContent = "This phone keeps the newest " + SEND_FAILURES_KEPT + " failed tries.";
  list.append(footer);
  sheet.hidden = false;
  applyDock();
  renderSendLogButton();
}

export function closeSendLog() {
  sendLogRenderToken += 1;
  const sheet = document.getElementById("send-log-sheet");
  if (sheet) sheet.hidden = true;
  applyDock();
  renderSendLogButton();
}

export function wireSendLog() {
  const button = document.getElementById("send-log-button");
  const sheet = document.getElementById("send-log-sheet");
  const close = document.getElementById("send-log-close");
  button?.addEventListener("click", function () { void openSendLog(); });
  close?.addEventListener("click", closeSendLog);
  sheet?.addEventListener("click", function (event) {
    if (event.target instanceof Element && event.target.dataset.sendLogClose === "1") closeSendLog();
  });
}
