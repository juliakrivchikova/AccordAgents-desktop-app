import { TIMELINE_PAGES_KEY } from "../base/storageKeys.js";
import { listTimelineEntries } from "./timelineRows.js";

function loadTimelinePages() {
  try {
    const raw = localStorage.getItem(TIMELINE_PAGES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function timelinePageFor(conversationId) {
  const page = loadTimelinePages()[conversationId];
  return page && typeof page === "object" ? page : undefined;
}

// Where "earlier" continues from. An answer to a request for the page before
// a message always moves it back. The latest page — asked on every open,
// every pull and every return to the foreground — must not move it forward
// past history this phone already holds: each of those reset it to the page
// below the latest one, so the next taps re-fetched rows already on screen
// and showed nothing.
export async function adoptTimelinePage(conversationId, payload) {
  const page = payload.page;
  const existing = timelinePageFor(conversationId);
  if (page.earlier !== true && existing && existing.beforeMessageId &&
    existing.beforeMessageId !== page.beforeMessageId &&
    await holdsHistoryBefore(conversationId, payload.events)) {
    return;
  }
  saveTimelinePage(conversationId, page);
}

async function holdsHistoryBefore(conversationId, events) {
  const pageTimes = (Array.isArray(events) ? events : []).map(function (event) {
    return Date.parse((event && event.createdAt) || "");
  }).filter(Number.isFinite);
  if (pageTimes.length === 0) {
    return false;
  }
  const pageOldest = Math.min.apply(null, pageTimes);
  const entries = await listTimelineEntries(conversationId).catch(function () { return []; });
  return entries.some(function (entry) {
    const time = Date.parse((entry && entry.createdAt) || "");
    return Number.isFinite(time) && time < pageOldest;
  });
}

export function saveTimelinePage(conversationId, page) {
  const pages = loadTimelinePages();
  pages[conversationId] = {
    hasMoreBefore: page.hasMoreBefore === true,
    beforeMessageId: typeof page.beforeMessageId === "string" && page.beforeMessageId.trim()
      ? page.beforeMessageId
      : undefined
  };
  localStorage.setItem(TIMELINE_PAGES_KEY, JSON.stringify(pages));
}
