import { lineIcon } from "../activity/activityData.js";
import { sessionsViewLabelFor, sessionsViewTextFor } from "../cards/cardText.js";
import { FINISHED_NOTE_CLOSE_PATHS } from "./finishedNoteCard.js";
import { formatClockTime } from "./messageRows.js";
import { mobileSharedRules } from "../members/avatars.js";
import { hubClient } from "../pairing/hubPairing.js";

/** An urgent alert's card on a member's row; none for any other row. */
export function urgentAlertOfEntry(entry) {
  return entry && entry.author === "agent" && !entry.scaffolding && entry.urgentAlert && typeof entry.urgentAlert.id === "string"
    ? entry.urgentAlert
    : undefined;
}

// Alerts the User opened again after closing them, on this screen only.
const expandedUrgentAlerts = new Set();

// Got it that the server did not confirm, by alert: shown in the card until
// the next try (a call may still come, so it must not flash away).
const urgentAlertErrors = new Map();

const URGENT_ALERT_BELL_PATHS = [
  "M10.268 21a2 2 0 0 0 3.464 0", "M22 8c0-2.3-.8-4.3-2-6",
  "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
  "M4 2C2.8 3.7 2 5.7 2 8"
];

const URGENT_ALERT_PHONE_PATH = "M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384";
const URGENT_ALERT_CIRCLE_PATH = "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0";

// The desktop's lucide icons for the status band, by urgentAlertStatus().icon.
const URGENT_ALERT_STATUS_PATHS = {
  clock: ["M12 6v6l4 2", URGENT_ALERT_CIRCLE_PATH],
  ringing: ["M13 2a9 9 0 0 1 9 9", "M13 6a5 5 0 0 1 5 5", URGENT_ALERT_PHONE_PATH],
  sent: ["M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z", "m21.854 2.147-10.94 10.939"],
  missed: ["m16 2 6 6", "m22 2-6 6", URGENT_ALERT_PHONE_PATH],
  check: [URGENT_ALERT_CIRCLE_PATH, "m9 12 2 2 4-4"],
  off: ["M10.268 21a2 2 0 0 0 3.464 0", "M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742", "m2 2 20 20", "M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"],
  failed: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"]
};

export const URGENT_ALERT_CHEVRON_PATHS = ["m6 9 6 6 6-6"];

/** An urgent alert a member raised: the desktop's card as the User approved
 *  it on 2026-11-15 — the red header whatever its state, the member and the
 *  time, the message, then a status band that says what happens now, with
 *  Got it while the alert waits for her (no cross then). Got it here folds
 *  it into one line; after Got it in Telegram or on the call it stays open
 *  with a cross that folds it. */
export function urgentAlertCardElement(entry) {
  const alert = urgentAlertOfEntry(entry);
  const shared = mobileSharedRules();
  const awaiting = Boolean(shared && typeof shared.urgentAlertAwaitsGotIt === "function" && shared.urgentAlertAwaitsGotIt(alert));
  // The sessions view names a member by its task and the main session by
  // nothing (its line then says only when).
  const rawLabel = entry.participantLabel || "A member";
  const label = sessionsViewLabelFor(entry.conversationId, rawLabel);
  const wrap = document.createElement("div");
  wrap.className = "urgent-alert-card";
  if (alert.closedAt && !awaiting && !expandedUrgentAlerts.has(alert.id)) {
    const outcome = shared && typeof shared.urgentAlertOutcome === "function" ? shared.urgentAlertOutcome(alert) : { text: "Closed", short: "Closed", done: true };
    wrap.classList.add("is-folded");
    const folded = document.createElement("button");
    folded.type = "button";
    folded.className = "urgent-alert-folded" + (outcome.done ? "" : " is-unresolved");
    folded.dataset.urgentAlertToggle = alert.id;
    folded.setAttribute("aria-expanded", "false");
    const bell = lineIcon(URGENT_ALERT_BELL_PATHS, 14);
    bell.classList.add("urgent-alert-folded-bell");
    // Read out as what it shows, after what it is.
    const kind = document.createElement("span");
    kind.className = "sr-only";
    kind.textContent = "Urgent alert: ";
    const preview = document.createElement("span");
    preview.className = "urgent-alert-folded-preview";
    preview.textContent = entry.content || "";
    const end = document.createElement("span");
    end.className = "urgent-alert-folded-outcome";
    // The short outcome: a phone's line has room for little more than the
    // message (the approved phone mockup); the card it opens says the rest.
    end.textContent = outcome.short || outcome.text;
    const who = document.createElement("span");
    who.className = "sr-only";
    who.textContent = (label ? " from " + label : "") + ": " + outcome.text;
    const chevron = lineIcon(URGENT_ALERT_CHEVRON_PATHS, 14);
    chevron.classList.add("urgent-alert-folded-chevron");
    end.setAttribute("aria-hidden", "true");
    folded.append(bell, kind, preview, who, end, chevron);
    wrap.append(folded);
    return wrap;
  }
  const panel = document.createElement("div");
  panel.className = "urgent-alert-panel";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", label ? "Urgent alert from " + label : "Urgent alert");
  const head = document.createElement("div");
  head.className = "urgent-alert-head";
  const headTitle = document.createElement("span");
  headTitle.className = "urgent-alert-title";
  headTitle.textContent = "Urgent alert";
  head.append(lineIcon(URGENT_ALERT_BELL_PATHS, 18), headTitle);
  if (!awaiting) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "urgent-alert-close";
    if (alert.closedAt) {
      close.setAttribute("aria-label", "Fold alert");
      close.setAttribute("aria-expanded", "true");
      close.dataset.urgentAlertToggle = alert.id;
    } else {
      close.setAttribute("aria-label", "Close alert");
      close.dataset.urgentAlertClose = alert.id;
    }
    close.append(lineIcon(FINISHED_NOTE_CLOSE_PATHS, 18));
    head.append(close);
  }
  // Who and when, inside the card above the message (the User, 2026-11-13).
  const from = document.createElement("div");
  from.className = "urgent-alert-from";
  const when = formatClockTime(entry.createdAt);
  from.textContent = [label, when].filter(Boolean).join(", ");
  const text = document.createElement("div");
  text.className = "urgent-alert-text";
  text.textContent = entry.content || "";
  panel.append(head, from, text);
  const status = shared && typeof shared.urgentAlertStatus === "function" ? shared.urgentAlertStatus(alert, rawLabel, Date.now()) : undefined;
  if (status) {
    const band = document.createElement("div");
    band.className = "urgent-alert-status is-" + status.tone;
    const icon = lineIcon(URGENT_ALERT_STATUS_PATHS[status.icon] || URGENT_ALERT_STATUS_PATHS.clock, 16);
    icon.classList.add("urgent-alert-status-icon");
    const words = document.createElement("div");
    words.className = "urgent-alert-status-words";
    const main = document.createElement("div");
    main.className = "urgent-alert-status-main";
    main.append(document.createTextNode(status.lead));
    if (status.countdown) {
      const countdown = document.createElement("strong");
      countdown.className = "urgent-alert-countdown";
      countdown.dataset.urgentAlertCountdown = status.countdown.to;
      countdown.textContent = status.countdown.text;
      main.append(countdown);
      startUrgentAlertClock();
    }
    if (status.tail) main.append(document.createTextNode(status.tail));
    words.append(main);
    if (status.detail) {
      const detail = document.createElement("div");
      detail.className = "urgent-alert-status-detail";
      detail.textContent = sessionsViewTextFor(entry.conversationId, status.detail);
      words.append(detail);
    }
    // A failed Got it holds while the alert still waits for one (a call
    // placed meanwhile changes nothing about it); once it no longer waits,
    // or is closed, it is moot.
    const failure = urgentAlertErrors.get(alert.id);
    if (failure && failure.awaiting === awaiting && !alert.closedAt) {
      const error = document.createElement("div");
      error.className = "urgent-alert-error";
      error.setAttribute("role", "alert");
      error.textContent = typeof shared.urgentAlertFailureText === "function"
        ? shared.urgentAlertFailureText(alert, failure.message)
        : "Not confirmed: " + failure.message;
      words.append(error);
    }
    band.append(icon, words);
    if (status.action === "got-it") {
      const gotIt = document.createElement("button");
      gotIt.type = "button";
      gotIt.className = "urgent-alert-action";
      gotIt.dataset.urgentAlertClose = alert.id;
      gotIt.textContent = "Got it";
      band.append(gotIt);
    } else if (status.action === "set-up") {
      const hint = document.createElement("div");
      hint.className = "urgent-alert-hint";
      hint.textContent = "Set up alerts on your computer: Settings → Alerts.";
      band.append(hint);
    }
    panel.append(band);
  }
  wrap.append(panel);
  return wrap;
}

// The time left before a call ticks down on every card that shows one; the
// clock runs only while one is on screen and the app is in front. When it
// runs out the card is drawn again ("Calling you now").
let urgentAlertClock;

export function tickUrgentAlertCountdowns() {
  const countdowns = document.hidden ? [] : [...document.querySelectorAll("[data-urgent-alert-countdown]")];
  if (!countdowns.length) {
    if (urgentAlertClock) clearInterval(urgentAlertClock);
    urgentAlertClock = undefined;
    return;
  }
  const shared = mobileSharedRules();
  const now = Date.now();
  for (const countdown of countdowns) {
    const due = Date.parse(countdown.dataset.urgentAlertCountdown || "");
    if (!Number.isFinite(due) || !shared || typeof shared.urgentAlertCountdown !== "function") continue;
    if (due <= now) {
      rerenderUrgentAlertRow(countdown.closest(".message-row"));
      continue;
    }
    countdown.textContent = shared.urgentAlertCountdown(due - now);
  }
}

export function startUrgentAlertClock() {
  if (!urgentAlertClock) urgentAlertClock = setInterval(tickUrgentAlertCountdowns, 1000);
}

export function toggleUrgentAlert(alertId, row) {
  if (!alertId) return;
  if (expandedUrgentAlerts.has(alertId)) expandedUrgentAlerts.delete(alertId); else expandedUrgentAlerts.add(alertId);
  rerenderUrgentAlertRow(row);
}

/** Draws the row's card again. Focus that was on the card (the button she
 *  pressed is gone) goes to the new card's button, so it is not lost. */
function rerenderUrgentAlertRow(row) {
  const card = row && row.querySelector ? row.querySelector(".urgent-alert-card") : undefined;
  const entry = row && row.__urgentAlertEntry;
  if (!card || !entry) return;
  const hadFocus = card.contains(document.activeElement);
  const next = urgentAlertCardElement(entry);
  card.replaceWith(next);
  if (hadFocus) {
    const target = next.querySelector(".urgent-alert-folded, .urgent-alert-close, .urgent-alert-action");
    if (target) target.focus({ preventScroll: true });
  }
}

/** Got it, or the cross on a card nobody closed yet: the server closes it on
 *  every device (Got it while it waits for one); the card changes when the
 *  server's copy of the message does, like every other change. */
export async function closeUrgentAlert(alertId, tappedRow) {
  if (!alertId) return;
  const buttons = tappedRow && tappedRow.querySelectorAll ? [...tappedRow.querySelectorAll("[data-urgent-alert-close]")] : [];
  for (const button of buttons) button.disabled = true;
  // The row on screen when the answer comes: the timeline may have drawn the
  // card again meanwhile (Telegram delivered, a call placed).
  const liveRow = function () {
    return [...document.querySelectorAll(".message-row[data-urgent-alert]")]
      .find(function (item) { const shown = item.__urgentAlertEntry && urgentAlertOfEntry(item.__urgentAlertEntry); return shown && shown.id === alertId; }) || tappedRow;
  };
  let row = tappedRow;
  try {
    const client = hubClient();
    if (!client) throw new Error("this phone is not paired with a server");
    const shared = mobileSharedRules();
    const answer = await client.postJson(shared && shared.HUB_ALERTS_PATH ? shared.HUB_ALERTS_PATH : "/v3/alerts", { action: "close", alertId: alertId });
    if (!answer || answer.ok !== true) {
      throw new Error(answer && answer.error && answer.error.message ? answer.error.message : "your server did not answer");
    }
    urgentAlertErrors.delete(alertId);
    expandedUrgentAlerts.delete(alertId);
    row = liveRow();
    if (row) row.__urgentAlertEntry = { ...(row.__urgentAlertEntry || {}), urgentAlert: answer.value };
  } catch (error) {
    row = liveRow();
    const current = row && row.__urgentAlertEntry ? urgentAlertOfEntry(row.__urgentAlertEntry) : undefined;
    const shared = mobileSharedRules();
    const awaiting = Boolean(current && shared && typeof shared.urgentAlertAwaitsGotIt === "function" && shared.urgentAlertAwaitsGotIt(current));
    urgentAlertErrors.set(alertId, { message: error && error.message ? error.message : "try again", awaiting: awaiting });
  }
  rerenderUrgentAlertRow(row);
}
