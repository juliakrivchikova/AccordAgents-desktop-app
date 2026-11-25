import { nowIso } from "../base/bytes.js";
import { SYNC_WAIT_KEY } from "../base/storageKeys.js";
import { outboxUnreachable } from "./outboxRetry.js";

let activeSyncProgressClockTimer;

// A message of the User's is faded until her server took it, then shown
// as any message; a member's reply appearing under it is the sign that
// work started (the User, 2026-10-29). Only a refusal says something.
export const MARK_REFUSED = "Not taken by your server";

// Waiting with no feedback reads as "nothing is happening", so the wait is
// timed and named, and a long silence says the chats have not come.
export function syncWaitStartedAt() {
  const existing = sessionStorage.getItem(SYNC_WAIT_KEY);
  if (existing) {
    return existing;
  }
  const now = nowIso();
  sessionStorage.setItem(SYNC_WAIT_KEY, now);
  return now;
}

export function syncProgressText(startedAt) {
  const started = Date.parse(startedAt || "");
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
  return seconds < 60
    ? "Loading your chats… " + seconds + "s"
    : "Your chats have not loaded in " + Math.floor(seconds / 60) + "m. Check your connection, then pull to refresh.";
}

export function startSyncProgressClock() {
  clearInterval(activeSyncProgressClockTimer);
  activeSyncProgressClockTimer = setInterval(function () {
    for (const node of document.querySelectorAll(".sync-progress")) {
      const next = syncProgressText(node.dataset.startedAt);
      if (node.textContent !== next) {
        node.textContent = next;
      }
    }
  }, 1000);
}

export function connectionStatusText(status) {
  if (status === "tunnel-reconnecting") {
    return "Tunnel reconnecting";
  }
  // Nothing the phone sends could get through: said, because nothing else
  // would say it, and kept until something is reached. The last outcome
  // decides, not the status a caller passes on after it went stale.
  if (outboxUnreachable) {
    return "Not connected";
  }
  // A send still on its way is not the chat's state: its message or card
  // fades instead (the User, 2026-09-24).
  return "Synced";
}

export function relativeTime(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) {
    return "";
  }
  const diffMs = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return minutes + "m";
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours + "h";
  }
  return Math.floor(hours / 24) + "d";
}
