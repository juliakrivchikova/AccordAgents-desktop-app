/**
 * What the phone's Activity tab lists, worked out from what the relay already
 * delivered: the timeline rows every `mobile.timeline.events` batch stores and
 * the cards that ride along with them. Nothing is asked of the desktop, so the
 * lists are the same whether it answers right now or not.
 *
 * The three lists follow the desktop's Activity (src/shared/chatActivity.ts):
 *  - Running: a member run still in progress, one row per run and member.
 *  - Pending: a permission or a choice a member is waiting on.
 *  - Finished: finished member messages from the last seven days, one row per
 *    chat and member, carrying how many runs it stands for.
 *
 * Two clocks are involved. Whether something is new since you looked, and
 * whether the desktop's chat list came after a run reached the phone, are
 * decided on this phone's clock only: `receivedAt` (when a row first arrived
 * here in its current state) against `viewedAt` and `chatListAt`. Ordering and
 * the age shown use the desktop's `createdAt`, or `settledAt` when the phone
 * watched a run end live; a small skew between the two there only moves a row
 * by a place.
 *
 * Kept free of the DOM and of storage so it can be exercised with plain node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AccordMobileActivity = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  // The same window, cap and preview length the desktop list uses.
  const WINDOW_DAYS = 7;
  const FINISHED_LIMIT = 50;
  const PREVIEW_LIMIT = 220;
  // A preview is taken from the start of a message; normalising whitespace
  // over the whole of a long answer only to keep 220 characters of it is
  // wasted work on every render.
  const PREVIEW_SOURCE_LIMIT = PREVIEW_LIMIT * 4;
  // How long after the desktop's chat list a run may have started and still
  // be one that list could not have known about.
  const STALE_RUN_GRACE_MS = 60 * 1000;

  function timeValue(iso) {
    const value = Date.parse(iso || "");
    return Number.isFinite(value) ? value : 0;
  }

  function previewText(value) {
    return String(value || "").slice(0, PREVIEW_SOURCE_LIMIT).replace(/\s+/g, " ").trim().slice(0, PREVIEW_LIMIT);
  }

  // Fallback for node tests; the shell passes the chat's own rule in.
  function defaultIsPlaceholder(content) {
    const text = String(content || "").trim();
    return text === "Running..." || /\bis running\.\.\.$/.test(text);
  }

  function handleOf(entry) {
    return typeof entry.participantLabel === "string" ? entry.participantLabel.trim() : "";
  }

  // When a finished message became news, for ordering and the age shown. A
  // run's message is stamped with the moment it started; when the phone
  // watched it end live, that moment is the better answer.
  function finishedAt(entry) {
    return entry.settledAt || entry.createdAt;
  }

  // Phone clock: when this phone got the row in its current state. Rows kept
  // from before the phone recorded it fall back to the desktop's stamp.
  function receivedAt(entry) {
    return entry.receivedAt || entry.createdAt;
  }

  function newestFirst(left, right) {
    return timeValue(right.at) - timeValue(left.at) || String(right.key).localeCompare(String(left.key));
  }

  /**
   * @param {object} input
   * @param {Array} input.entries stored timeline rows (any chat)
   * @param {Object<string, Array>} input.cardsByConversation stored cards per chat
   * @param {Array} input.chats the chat list the desktop last sent; only chats
   *   in it are listed
   * @param {string[]} input.unreadConversationIds chats with something unseen
   * @param {Object<string, string>} input.viewedAt when each chat was last
   *   looked at, on this phone's clock
   * @param {string} [input.chatListAt] when this phone got that chat list, on
   *   its own clock
   * @param {function(string): boolean} [input.isRunSettled] runs this phone saw end
   * @param {function(string): boolean} [input.isRunKnownLive] runs this phone
   *   itself knows are going (commanded on a machine directly)
   * @param {function(string): boolean} [input.isStopRequested] runs a stop was
   *   asked for and not yet taken
   * @param {function(string): boolean} [input.isPlaceholder] the chat's rule
   *   for "a run started" text
   * @param {string[]} [input.hiddenConversationIds] chats that must not be listed
   * @param {number} [input.now]
   */
  function buildActivity(input) {
    const now = typeof input.now === "number" ? input.now : Date.now();
    const cutoff = now - WINDOW_DAYS * DAY_MS;
    const isRunSettled = typeof input.isRunSettled === "function" ? input.isRunSettled : function () { return false; };
    const isRunKnownLive = typeof input.isRunKnownLive === "function" ? input.isRunKnownLive : function () { return false; };
    const isStopRequested = typeof input.isStopRequested === "function" ? input.isStopRequested : function () { return false; };
    const isPlaceholder = typeof input.isPlaceholder === "function" ? input.isPlaceholder : defaultIsPlaceholder;
    const hidden = new Set(Array.isArray(input.hiddenConversationIds) ? input.hiddenConversationIds : []);
    const chatsById = new Map();
    for (const chat of Array.isArray(input.chats) ? input.chats : []) {
      if (chat && typeof chat.id === "string") chatsById.set(chat.id, chat);
    }
    const titleFor = function (conversationId) {
      const chat = chatsById.get(conversationId);
      return chat && typeof chat.title === "string" && chat.title.trim() ? chat.title : "Chat";
    };
    // Only chats the desktop lists. An archived or deleted chat drops out of
    // the list, but what it left in this phone's storage does not; and with no
    // list at all there is nothing the phone can vouch for.
    const listed = function (conversationId) {
      return !hidden.has(conversationId) && chatsById.has(conversationId);
    };
    // The desktop's chat list says whether a chat has a run going. A row still
    // "in progress" that reached this phone well before a list saying nothing
    // runs there is a run the phone never saw end (the desktop restarted, a
    // terminal was missed). Both times are this phone's.
    const chatListAt = timeValue(input.chatListAt);
    const endedSinceStarted = function (entry) {
      if (entry.runId && isRunKnownLive(entry.runId)) return false;
      const chat = chatsById.get(entry.conversationId);
      return Boolean(chat) && chat.running !== true && chatListAt > 0 &&
        chatListAt - timeValue(receivedAt(entry)) > STALE_RUN_GRACE_MS;
    };
    const unread = new Set(Array.isArray(input.unreadConversationIds) ? input.unreadConversationIds : []);
    const viewedAt = input.viewedAt && typeof input.viewedAt === "object" ? input.viewedAt : {};
    const entries = (Array.isArray(input.entries) ? input.entries : []).filter(function (entry) {
      return entry && typeof entry === "object" &&
        entry.role === "participant" &&
        typeof entry.conversationId === "string" && entry.conversationId &&
        listed(entry.conversationId);
    });

    // --- Running ------------------------------------------------------------
    // The rows the chat itself draws as in progress. A run can be described by
    // an early "Running..." row that names nobody and by a row that names the
    // member; the member's row wins.
    const runs = new Map();
    for (const entry of entries) {
      if (entry.status !== "pending") continue;
      if (entry.runId && isRunSettled(entry.runId)) continue;
      if (endedSinceStarted(entry)) continue;
      const runKey = entry.conversationId + "\u0000" + (entry.runId || entry.mobileEventId || entry.id);
      const group = runs.get(runKey) || new Map();
      const memberKey = handleOf(entry).toLowerCase();
      const existing = group.get(memberKey);
      if (!existing || timeValue(entry.createdAt) > timeValue(existing.createdAt)) {
        group.set(memberKey, entry);
      }
      runs.set(runKey, group);
    }
    const running = [];
    const runningRunIds = new Set();
    for (const group of runs.values()) {
      const named = Array.from(group.entries()).filter(function (pair) { return pair[0] !== ""; });
      const rows = named.length > 0 ? named.map(function (pair) { return pair[1]; }) : Array.from(group.values());
      for (const entry of rows) {
        if (entry.runId) runningRunIds.add(entry.runId);
        const placeholder = isPlaceholder(entry.content);
        running.push({
          key: "run:" + entry.conversationId + ":" + (entry.runId || entry.id) + ":" + handleOf(entry).toLowerCase(),
          kind: "run",
          conversationId: entry.conversationId,
          chatTitle: titleFor(entry.conversationId),
          handle: handleOf(entry),
          preview: placeholder ? "" : previewText(entry.content),
          at: entry.createdAt,
          runId: entry.runId,
          threadRootId: entry.threadRootId,
          // A row that names nobody has no member to stop yet.
          cancellable: Boolean(entry.runId) && !placeholder,
          stopping: Boolean(entry.runId) && isStopRequested(entry.runId)
        });
      }
    }
    // An early row that names nobody, left beside a member's row in the same
    // chat, is the same work seen before routing picked the member.
    const namedChats = new Set(running.filter(function (row) { return row.handle; }).map(function (row) { return row.conversationId; }));
    for (let index = running.length - 1; index >= 0; index -= 1) {
      if (!running[index].handle && namedChats.has(running[index].conversationId)) running.splice(index, 1);
    }
    running.sort(newestFirst);

    // --- Pending ------------------------------------------------------------
    const pending = [];
    const cardsByConversation = input.cardsByConversation && typeof input.cardsByConversation === "object"
      ? input.cardsByConversation
      : {};
    for (const conversationId of Object.keys(cardsByConversation)) {
      if (!listed(conversationId)) continue;
      const cards = Array.isArray(cardsByConversation[conversationId]) ? cardsByConversation[conversationId] : [];
      for (const card of cards) {
        if (!card || card.status !== "pending" || typeof card.id !== "string") continue;
        const permission = card.kind !== "choice";
        pending.push({
          key: "card:" + card.id,
          kind: permission ? "permission" : "choice",
          conversationId: card.conversationId || conversationId,
          chatTitle: titleFor(card.conversationId || conversationId),
          handle: typeof card.requesterLabel === "string" ? card.requesterLabel.trim() : "",
          // Where a permission's command will run is part of what is allowed.
          machineName: permission && typeof card.machineName === "string" ? card.machineName.trim() : "",
          // A choice shows its question and opens in full. A permission is
          // answered right in the row, so the row carries every word of what
          // is being allowed, as the chat's card does: a command cut to fit
          // could hide its dangerous end.
          preview: permission ? String(card.summary || card.title || "") : previewText(card.summary || card.title),
          at: card.createdAt,
          card: card
        });
      }
    }
    pending.sort(newestFirst);

    // --- Finished -----------------------------------------------------------
    // A message that carries a question still waiting for an answer is listed
    // under Pending, as the desktop lists it, not again as a finished update.
    const askingMessageIds = new Set(pending.map(function (row) {
      return row.card.sourceMessageId;
    }).filter(Boolean));
    const groups = new Map();
    for (const entry of entries) {
      if (entry.status !== "done") continue;
      if (entry.runId && runningRunIds.has(entry.runId)) continue;
      if (askingMessageIds.has(entry.messageId) || askingMessageIds.has(entry.sourceId)) continue;
      const at = timeValue(finishedAt(entry));
      if (at <= 0 || at < cutoff) continue;
      const handle = handleOf(entry);
      const groupKey = entry.conversationId + "\u0000" + (handle ? "handle:" + handle.toLowerCase() : "entry:" + entry.id);
      const group = groups.get(groupKey) || { newest: undefined, ids: new Set(), latestReceived: 0 };
      // One update per run, as the desktop counts them: a turn that posts a
      // note and then its answer is one thing that happened. The same message
      // stored under two keys (a page read and a live batch) is one too.
      group.ids.add(entry.runId ? "run:" + entry.runId : "message:" + (entry.messageId || entry.sourceId || entry.id));
      group.latestReceived = Math.max(group.latestReceived, timeValue(receivedAt(entry)));
      if (!group.newest || at > timeValue(finishedAt(group.newest)) ||
        (at === timeValue(finishedAt(group.newest)) && String(entry.id) > String(group.newest.id))) {
        group.newest = entry;
      }
      groups.set(groupKey, group);
    }
    const finished = [];
    for (const group of groups.values()) {
      const entry = group.newest;
      const seen = viewedAt[entry.conversationId];
      // Seen once the chat was opened on this phone after the newest of these
      // updates arrived. Before the phone has ever recorded a look, the chat's
      // unread dot is what says whether there is anything new in it.
      const read = seen
        ? group.latestReceived <= timeValue(seen)
        : !unread.has(entry.conversationId);
      finished.push({
        key: "done:" + entry.conversationId + ":" + (handleOf(entry).toLowerCase() || entry.id),
        kind: "message",
        conversationId: entry.conversationId,
        chatTitle: titleFor(entry.conversationId),
        handle: handleOf(entry),
        content: entry.content,
        at: finishedAt(entry),
        count: group.ids.size,
        read: read,
        messageId: entry.messageId || entry.sourceId,
        threadRootId: entry.threadRootId
      });
    }
    finished.sort(newestFirst);
    const shown = finished.slice(0, FINISHED_LIMIT);
    // Only the rows that are shown need their text trimmed.
    for (const row of shown) {
      row.preview = previewText(row.content);
      delete row.content;
    }

    return {
      running: running,
      pending: pending,
      finished: shown
    };
  }

  /** The number on the Activity tab: what is waiting for the User plus the
   *  finished updates not seen yet. A run in progress needs nothing from them. */
  function attentionCount(activity) {
    if (!activity) return 0;
    return activity.pending.length + activity.finished.filter(function (row) { return !row.read; }).length;
  }

  return {
    buildActivity: buildActivity,
    attentionCount: attentionCount,
    WINDOW_DAYS: WINDOW_DAYS,
    PREVIEW_SOURCE_LIMIT: PREVIEW_SOURCE_LIMIT
  };
});
