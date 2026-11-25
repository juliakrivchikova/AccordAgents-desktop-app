import { getTimelineEntry } from "../activity/activityItem.js";
import { render } from "../chat/render.js";
import { canSync } from "../outbox/sending.js";
import { loadPairing } from "../pairing/pairing.js";
import { deletePendingTimelineEntriesForRun, listTimelineEntries, turnsStillGoing } from "../store/timelineRows.js";
import { serverPhoneGet } from "./serverReads.js";
import { handleRelayTimelinePayload } from "./timelinePayload.js";

// Turns the list showed running and no longer does, kept until the server
// says how each ended: a long turn answers where it started, far above the
// newest page, so nothing else brings its end to this phone. Kept across
// launches and read again after a failed or not-yet-final answer, so a
// dropped read or an end saved late does not lose the answer.
export const SETTLE_TURNS_KEY = "accordagents.mobile.settleTurns.v1";

const SETTLE_TURNS_MAX = 200;
const SETTLE_PASS_MAX = 12;

// Given up after this many reads (hours of the app in front, at the
// longest wait between reads) or this long: then the row is left to the
// corpse rule. Counted in reads, not time, so a phone away for a day still
// asks once when it is back.
const SETTLE_ATTEMPTS_MAX = 100;

const SETTLE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// A row not held yet can be a page still being stored: asked again a few
// times before it is dropped.
const SETTLE_MISSING_MAX = 3;

const SETTLE_RETRY_FIRST_MS = 15_000;
const SETTLE_RETRY_MAX_MS = 5 * 60_000;
const SETTLE_UNSUPPORTED_WAIT_MS = 30 * 60_000;
let settlePassRunning = false;
let settlePassTimer;
let settleUnsupportedUntil = 0;

// An entry given up (too many reads) is kept until it is old, so the same
// row is not taken up again from scratch, but it is not read, timed, or a
// reason to spare the row from the corpse rule.
export function settleGivenUp(entry) {
  return (entry.attempts || 0) >= SETTLE_ATTEMPTS_MAX;
}

export function loadSettleTurns() {
  const now = Date.now();
  try {
    const raw = JSON.parse(localStorage.getItem(SETTLE_TURNS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter(function (entry) {
      return entry && typeof entry.conversationId === "string" && typeof entry.messageId === "string" &&
        now - (entry.since || 0) < SETTLE_KEEP_MS;
    }) : [];
  } catch {
    return [];
  }
}

// A turn asked about again because something changed (its chat changed,
// or it left the list) is read soon, not at the end of its longest wait,
// but not more often than this, however busy the chat.
const SETTLE_NUDGE_FLOOR_MS = 10_000;

function addSettleTurns(items) {
  if (items.length === 0) return;
  const list = loadSettleTurns();
  const byKey = new Map(list.map(function (entry) { return [entry.conversationId + "\u0000" + entry.messageId, entry]; }));
  const now = Date.now();
  for (const item of items) {
    const key = item.conversationId + "\u0000" + item.messageId;
    const known = byKey.get(key);
    if (known) {
      if (!settleGivenUp(known)) known.nextAt = Math.min(known.nextAt || 0, Math.max(now, (known.lastAt || 0) + SETTLE_NUDGE_FLOOR_MS));
      continue;
    }
    const entry = { conversationId: item.conversationId, messageId: item.messageId, since: now, attempts: 0, missing: 0, nextAt: 0 };
    byKey.set(key, entry);
    list.push(entry);
  }
  saveSettleTurns(list);
  void runSettlePass();
}

/** Running rows this phone holds that the newest page just read does not
 *  reach and the list does not carry: a turn with no turn on the server (a
 *  member's own follow-up reply), buried past the page. Nothing else would
 *  ever bring its end, so it is asked about like a turn that left the list. */
export async function settleHeldTurnsBeyondPage(conversationId, events) {
  if (Date.now() < settleUnsupportedUntil) return;
  const times = (Array.isArray(events) ? events : []).map(function (event) { return event && event.createdAt; })
    .filter(function (at) { return typeof at === "string" && at; }).sort();
  if (times.length === 0) return;
  const oldestOnPage = times[0];
  const going = turnsStillGoing(conversationId, events, false);
  const rows = await listTimelineEntries(conversationId).catch(function () { return []; });
  addSettleTurns(rows.filter(function (row) {
    const messageId = row && (row.messageId || row.sourceId);
    return row && row.role === "participant" && row.status === "pending" && row.participantLabel && row.runId && messageId &&
      typeof row.createdAt === "string" && row.createdAt < oldestOnPage && !going.has(messageId) && !going.has(row.runId);
  }).map(function (row) {
    return { conversationId: conversationId, messageId: row.messageId || row.sourceId };
  }));
}

function saveSettleTurns(list) {
  try {
    localStorage.setItem(SETTLE_TURNS_KEY, JSON.stringify(list.slice(-SETTLE_TURNS_MAX)));
  } catch {
    // Best effort: the corpse rule still clears a row that is never settled.
  }
}

export function settleTurnsThatLeftTheList(previousById, chats) {
  // A server that cannot settle a turn is not asked to (see runSettlePass).
  if (Date.now() < settleUnsupportedUntil) return;
  const items = [];
  for (const chat of chats) {
    const before = previousById.get(chat.id);
    if (!before || !Array.isArray(before.activity)) continue;
    const still = new Set((Array.isArray(chat.activity) ? chat.activity : [])
      .filter(function (row) { return row && row.status === "pending"; })
      .map(function (row) { return row.messageId; }));
    for (const row of before.activity) {
      if (row && row.status === "pending" && row.messageId && !still.has(row.messageId)) {
        items.push({ conversationId: chat.id, messageId: row.messageId });
      }
    }
  }
  if (items.length > 0) addSettleTurns(items);
  else void runSettlePass();
}

export async function runSettlePass() {
  if (settlePassRunning || Date.now() < settleUnsupportedUntil) return;
  settlePassRunning = true;
  try {
    const now = Date.now();
    const due = loadSettleTurns().filter(function (entry) {
      return !settleGivenUp(entry) && (entry.nextAt || 0) <= now;
    }).slice(0, SETTLE_PASS_MAX);
    for (const entry of due) {
      const outcome = await settleTurnByMessage(entry);
      const list = loadSettleTurns();
      const index = list.findIndex(function (item) {
        return item.conversationId === entry.conversationId && item.messageId === entry.messageId;
      });
      if (index >= 0) {
        const missing = outcome === "missing" ? (list[index].missing || 0) + 1 : 0;
        if (outcome === "settled" || missing >= SETTLE_MISSING_MAX) {
          list.splice(index, 1);
        } else if (outcome === "missing") {
          list[index] = { ...list[index], missing: missing, lastAt: Date.now(), nextAt: Date.now() + SETTLE_RETRY_FIRST_MS };
        } else {
          const attempts = (list[index].attempts || 0) + 1;
          list[index] = { ...list[index], attempts: attempts, lastAt: Date.now(),
            nextAt: Date.now() + Math.min(SETTLE_RETRY_MAX_MS, SETTLE_RETRY_FIRST_MS * Math.pow(2, attempts - 1)) };
        }
      }
      saveSettleTurns(list);
      if (outcome === "unsupported") {
        // This server cannot read one message yet (it updates after the
        // desktop does): nothing waiting here can be settled by it, so the
        // rows go back to the old rules (their corpse cleanup included)
        // instead of being held, and it is asked again later.
        saveSettleTurns([]);
        settleUnsupportedUntil = Date.now() + SETTLE_UNSUPPORTED_WAIT_MS;
        break;
      }
    }
  } finally {
    settlePassRunning = false;
    scheduleSettlePass();
  }
}

/** The next pass when the earliest waiting turn is due, while the app is in
 *  front; a list or a return to the app also starts one. */
function scheduleSettlePass() {
  clearTimeout(settlePassTimer);
  settlePassTimer = undefined;
  const pending = loadSettleTurns().filter(function (entry) { return !settleGivenUp(entry); });
  if (pending.length === 0 || document.hidden) return;
  const nextAt = Math.max(settleUnsupportedUntil, pending.reduce(function (earliest, entry) {
    return Math.min(earliest, entry.nextAt || 0);
  }, Infinity));
  settlePassTimer = setTimeout(function () {
    settlePassTimer = undefined;
    void runSettlePass();
  }, Math.max(1000, Math.min(SETTLE_RETRY_MAX_MS, nextAt - Date.now())));
}

/** "settled" when the server's answer is final (the turn's end, or the
 *  message gone) or this phone's row is already settled; "missing" when
 *  this phone holds no row for it (yet); "pending" when it still runs;
 *  "failed" or "unsupported" otherwise. */
// An end found soon after the turn left the list is one this phone watched
// happen: Finished lists it by when it ended. A row settled long after
// (a phone away, an old stuck row) keeps its own time.
const SETTLE_LIVE_WINDOW_MS = 10 * 60_000;

async function settleTurnByMessage(entry) {
  const conversationId = entry.conversationId;
  const messageId = entry.messageId;
  const held = await getTimelineEntry(conversationId + ":" + messageId).catch(function () { return undefined; });
  // Already settled here: done. Not held: maybe a page that holds it is
  // still being stored, so asked again a few times; an answer this phone
  // never showed is not placed alone above its newest page.
  if (held && held.status !== "pending") return "settled";
  if (!held) return "missing";
  const pairing = loadPairing();
  if (!pairing || !canSync(pairing)) return "failed";
  let payload;
  try {
    payload = await serverPhoneGet("/v1/phone/timeline", { conversationId: conversationId, messageId: messageId });
  } catch {
    return "failed";
  }
  // A server that cannot read one message answers with its newest page.
  if (!payload || payload.message !== messageId || !Array.isArray(payload.events)) return "unsupported";
  if (payload.events.length === 0) {
    // Gone on the server (a stopped turn's message is removed): so is its row.
    await deletePendingTimelineEntriesForRun(conversationId, undefined, undefined, messageId, "done").catch(function () { return 0; });
    void render("synced");
    return "settled";
  }
  const event = payload.events.find(function (item) { return item && (item.messageId === messageId || item.id === messageId); });
  try {
    await handleRelayTimelinePayload(payload, conversationId, { live: Date.now() - (entry.since || 0) < SETTLE_LIVE_WINDOW_MS });
  } catch {
    return "failed";
  }
  return event && event.status === "pending" ? "pending" : "settled";
}
