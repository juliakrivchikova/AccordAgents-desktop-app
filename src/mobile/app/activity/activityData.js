import { loadClearedActivity } from "./activityView.js";
import {
  CHAT_LIST_AT_KEY, CHAT_LIST_KEY, CONTROL_CARDS_KEY, LIST_ACTIVITY_SEEN_KEY, UNREAD_KEY, VIEWED_AT_KEY
} from "../base/storageKeys.js";
import { loadControlCards } from "../cards/controlCardStore.js";
import { render } from "../chat/render.js";
import { loadChats, loadUnreadConversationIds, loadViewedAt } from "../chats/chatStore.js";
import { selectedConversationId } from "../chats/openChat.js";
import { OUTBOX_REFUSED } from "../outbox/hubOutbox.js";
import { listOutboxEntries } from "../outbox/outboxStore.js";
import { canSync, stopRequestedRunIds } from "../outbox/sending.js";
import { loadPairing } from "../pairing/pairing.js";
import { ACTIVITY_CACHE_MAX_AGE_MS, ACTIVITY_CLEARED_KEY, CHAT_LIST_REFRESH_MIN_MS, SVG_NS } from "../shell/home.js";
import { requestToPromise } from "../store/database.js";
import { isPlaceholderTimelineContent, timelineGeneration, withTimeline } from "../store/timelineRows.js";
import { memberActionsShown } from "../chat/memberActions.js";
import { loadListActivitySeen, withListActivity } from "../sync/chatListPayload.js";
import { requestChatListViaRelay } from "../sync/serverChanges.js";
import { displayedMessageText } from "../text/messageText.js";

export const activityDataState = {
  // The lists last built, and what they were built from.
  activityMemo: undefined
};

let recentTimelineCache;
let recentTimelineRead;
let chatListRefreshTimer;
let lastChatListRefreshAt = 0;
let activityRereadTimer;
const ACTIVITY_REREAD_MIN_MS = 1500;

export function lineIcon(paths, size) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size || 20));
  svg.setAttribute("height", String(size || 20));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** The members' rows from the Activity window on, read by their time index.
 *  Only what Activity uses is kept, with the text cut to what a preview
 *  needs: the copy stays in memory between redraws, and a week of answers in
 *  full is megabytes. */
function listRecentTimelineEntries(sinceIso, keepChars) {
  return withTimeline("readonly", function (store) {
    return requestToPromise(store.index("createdAt").getAll(IDBKeyRange.lowerBound(sinceIso)));
  }).then(function (rows) {
    const kept = [];
    for (const row of rows) {
      if (!row || row.role !== "participant") continue;
      kept.push({
        id: row.id,
        sourceId: row.sourceId,
        messageId: row.messageId,
        conversationId: row.conversationId,
        role: row.role,
        participantLabel: row.participantLabel,
        status: row.status,
        createdAt: row.createdAt,
        receivedAt: row.receivedAt,
        settledAt: row.settledAt,
        runId: row.runId,
        mobileEventId: row.mobileEventId,
        threadRootId: row.threadRootId,
        // The step in progress is not previewed while members' actions are hidden.
        content: typeof row.content === "string" && !(row.liveActivity && !memberActionsShown()) ? row.content.slice(0, keepChars) : ""
      });
    }
    return kept;
  });
}

/** The runs a Stop was asked for, by every name a row may carry them
 *  under (the turn's id on the server, and the row's own), from the queue
 *  itself: after a reload the in-memory mark is gone, the request is not. */
export function stopRunIdsOf(entries) {
  const ids = [];
  for (const entry of entries) {
    // A Send now stops nothing.
    if (!entry || entry.kind !== "turn.stop" || !entry.payload || entry.payload.sendNow || entry.status === OUTBOX_REFUSED) continue;
    if (entry.payload.runId) ids.push(entry.payload.runId);
    if (entry.payload.rowRunId) ids.push(entry.payload.rowRunId);
  }
  return ids;
}

function queuedStopRunIds() {
  return listOutboxEntries(undefined).then(stopRunIdsOf).catch(function () {
    return [];
  });
}

function readRecentActivitySource(activityApi, now) {
  if (recentTimelineRead) return recentTimelineRead;
  const generation = timelineGeneration;
  const since = new Date(now - activityApi.WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  recentTimelineRead = Promise.all([
    listRecentTimelineEntries(since, activityApi.PREVIEW_SOURCE_LIMIT),
    queuedStopRunIds()
  ]).then(function (read) {
    const source = { generation: generation, readAt: Date.now(), entries: read[0], queuedStops: read[1] };
    // Renders overlap: an older read finishing late must not replace a newer one.
    if (!recentTimelineCache || generation >= recentTimelineCache.generation) {
      recentTimelineCache = source;
    }
    return recentTimelineCache;
  }).catch(function () {
    return recentTimelineCache || { generation: generation, readAt: 0, entries: [], queuedStops: [] };
  }).finally(function () {
    recentTimelineRead = undefined;
  });
  return recentTimelineRead;
}

/** `cached` asks for the lists to be built from rows already read, never
 *  from a fresh pass over the store. Inside a chat that is the only
 *  acceptable cost: reading a week of rows takes hundreds of milliseconds on
 *  a phone with a busy week behind it, and an agent streaming into the open
 *  chat would pay it every second or so, on the main thread. What waits for
 *  the User is counted from the cards, which are read from storage anyway;
 *  what is stale in there is at most the count of finished updates, until
 *  the chat is left. Nothing cached at all (a phone opened straight into a
 *  chat from a notification) is read once. */
export async function loadActivity(options) {
  const activityApi = self.AccordMobileActivity;
  if (!activityApi) return undefined;
  const now = Date.now();
  // Inside a chat the lists are not on screen — only the bar's number is —
  // and a pass over a week of rows for it is what made streaming text arrive
  // in lumps. Whoever asks while a chat is open gets what was last read,
  // whether or not they remembered to say so.
  const cached = Boolean(options && options.cached) || Boolean(selectedConversationId());
  let source = recentTimelineCache;
  if (source && source.generation === timelineGeneration && now - source.readAt < ACTIVITY_CACHE_MAX_AGE_MS) {
    // Nothing written since the last read.
  } else if (cached && source) {
    // Whatever was last read stands; no new pass over the store.
  } else if (cached) {
    source = await readRecentActivitySource(activityApi, now);
  } else if (source && now - source.readAt < ACTIVITY_REREAD_MIN_MS) {
    // A run streaming into the store changes it every second or so; the
    // lists catch up once the burst has had a moment, not on every write.
    if (!activityRereadTimer) {
      activityRereadTimer = setTimeout(function () {
        activityRereadTimer = undefined;
        if (!selectedConversationId()) void render();
      }, ACTIVITY_REREAD_MIN_MS - (now - source.readAt));
    }
  } else {
    source = await readRecentActivitySource(activityApi, now);
  }
  const stops = new Set(source.queuedStops.concat(Array.from(stopRequestedRunIds)));
  // The same inputs give the same lists; a redraw for an unrelated reason
  // (a poll, the clock) does not redo the work. Stored strings are compared
  // as they are, not copied into a key: the chat list can be large.
  const inputs = [
    localStorage.getItem(CONTROL_CARDS_KEY),
    localStorage.getItem(CHAT_LIST_KEY),
    localStorage.getItem(UNREAD_KEY),
    localStorage.getItem(VIEWED_AT_KEY),
    localStorage.getItem(ACTIVITY_CLEARED_KEY),
    localStorage.getItem(CHAT_LIST_AT_KEY),
    localStorage.getItem(LIST_ACTIVITY_SEEN_KEY),
    JSON.stringify(Array.from(stops)),
    String(Math.floor(now / 60_000))
  ];
  if (activityDataState.activityMemo && activityDataState.activityMemo.source === source && activityDataState.activityMemo.inputs.length === inputs.length &&
    activityDataState.activityMemo.inputs.every(function (value, index) { return value === inputs[index]; })) {
    return activityDataState.activityMemo.activity;
  }
  const activity = activityApi.buildActivity({
    entries: withListActivity(source.entries, loadChats(), loadListActivitySeen()),
    cardsByConversation: loadControlCards(),
    chats: loadChats(),
    unreadConversationIds: loadUnreadConversationIds(),
    viewedAt: loadViewedAt(),
    isStopRequested: function (runId) { return stops.has(runId); },
    isPlaceholder: isPlaceholderTimelineContent,
    // Activity previews are member messages too: the block that becomes a
    // card is not what the row should read.
    displayText: function (content) { return displayedMessageText(content, "agent"); },
    clearedEntryIds: loadClearedActivity(),
    chatListAt: localStorage.getItem(CHAT_LIST_AT_KEY) || undefined,
    now: now
  });
  activityDataState.activityMemo = { source: source, inputs: inputs, activity: activity };
  return activity;
}

/** A batch for a chat the phone's list does not have yet (created on the
 *  desktop while this app stayed open) asks for the list again, so the chat
 *  and anything it is waiting on show up without a trip to the background. */
export function refreshChatListSoon(conversationId) {
  if (!conversationId || chatListRefreshTimer) return;
  if (loadChats().some(function (chat) { return chat.id === conversationId; })) return;
  const wait = Math.max(0, CHAT_LIST_REFRESH_MIN_MS - (Date.now() - lastChatListRefreshAt));
  chatListRefreshTimer = setTimeout(function () {
    chatListRefreshTimer = undefined;
    lastChatListRefreshAt = Date.now();
    const pairing = loadPairing();
    if (!pairing || !canSync(pairing)) return;
    void requestChatListViaRelay(pairing).then(function () {
      return render("synced");
    }).catch(function () {
      return undefined;
    });
  }, wait);
}
