import { nowIso } from "../base/bytes.js";
import { META_STORE, TIMELINE_STORE } from "../base/storageKeys.js";
import { loadChats } from "../chats/chatStore.js";
import { openDb, requestToPromise } from "./database.js";
import { loadSettleTurns, settleGivenUp } from "../sync/settledTurns.js";
import { activitySignature, interimPostsSignature, mergedInterimPosts } from "../sync/timelinePayload.js";

// Bumped by every write to the timeline store. The home screens redraw on
// every batch and poll; rereading a week of messages each time for the
// Activity badge would cost the phone far more than the list is worth.
export let timelineGeneration = 0;

// One chat's rows, as they stand in the store. Every delivered row is
// deduplicated against the chat it belongs to, and reading that chat back
// from the database for each of them is what a streaming member costs: a
// dozen full reads in seven seconds, each one hundreds of milliseconds on a
// real phone, which is why text arrived in lumps (the User, 2026-09-21).
// Only this page writes timeline rows -- the push-woken worker reads what a
// push is about and writes no rows -- so the rows held here cannot go stale
// behind this context's back. Anything that writes without maintaining them drops
// them, which is enforced in withTimeline rather than left to each caller.
// A few chats at a time, not one: the chat on screen is read for drawing
// while another member streams into a different chat, and a single slot made
// those two evict each other on every delivered row.
const CHAT_ROWS_HELD_LIMIT = 4;

const chatRowsHeld = new Map();

export function dropCachedChatRows() {
  chatRowsHeld.clear();
}

function holdChatRows(conversationId, rows) {
  if (typeof conversationId !== "string" || !conversationId) return rows;
  chatRowsHeld.delete(conversationId);
  chatRowsHeld.set(conversationId, rows);
  while (chatRowsHeld.size > CHAT_ROWS_HELD_LIMIT) {
    chatRowsHeld.delete(chatRowsHeld.keys().next().value);
  }
  return rows;
}

export function withTimeline(mode, fn, options) {
  // A write that does not keep the held rows in step drops them twice: when
  // it is asked for, and again once it has landed. The first alone was not
  // enough — a write created between the two moments read the chat afresh
  // and held rows this one was about to delete.
  const dropsHeldRows = mode === "readwrite" && !(options && options.maintainsChatRows);
  if (dropsHeldRows) {
    dropCachedChatRows();
  }
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([TIMELINE_STORE, META_STORE], mode);
      const store = tx.objectStore(TIMELINE_STORE);
      let value;
      tx.onerror = function () {
        reject(tx.error || new Error("Timeline transaction failed."));
      };
      // A transaction that fails still holds its connection open until it
      // is closed here; left to the garbage collector, that connection
      // blocks the next version change the worker asks for. And the rows
      // held for a chat were brought up to date as this write's requests
      // succeeded, before the store took them: after an abort they name a
      // row the store never got, and the next copy of it would be judged
      // "already here" and never written. Dropped, so the next write reads
      // the chat as it is.
      tx.onabort = function () {
        dropCachedChatRows();
        reject(tx.error || new Error("Timeline transaction aborted."));
        db.close();
      };
      tx.oncomplete = function () {
        // Activity keeps what it read until the store changes. The write
        // helpers resolve false or 0 when a replayed row changed nothing;
        // anything else counts as a change. Registered on the value before
        // it is handed back, so the count moves before the caller resumes.
        if (mode === "readwrite") {
          Promise.resolve(value).then(function (result) {
            if (result !== false && result !== 0) timelineGeneration += 1;
          }, function () { timelineGeneration += 1; });
        }
        if (dropsHeldRows) {
          dropCachedChatRows();
        }
        resolve(value);
        db.close();
      };
      try {
        value = fn(store, tx.objectStore(META_STORE));
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  });
}

export function isScaffoldingEntry(entry) {
  return Boolean(entry) &&
    entry.role === "participant" &&
    entry.status === "pending" &&
    isPlaceholderTimelineContent(entry.content);
}

function sameTimelineEntryContent(left, right) {
  const attachmentIds = function (entry) {
    return Array.isArray(entry.attachments)
      ? entry.attachments.map(function (attachment) { return attachment.id; }).join(",")
      : "";
  };
  // Where the turns a message asked for stand: a member's waiting row follows them.
  const turns = function (entry) {
    return Array.isArray(entry.turns)
      ? entry.turns.map(function (turn) { return turn.participantId + ":" + turn.state; }).join(",")
      : "";
  };
  return left.content === right.content &&
    left.status === right.status &&
    left.createdAt === right.createdAt &&
    // What a member posted during its turn, inside its reply.
    interimPostsSignature(left) === interimPostsSignature(right) &&
    (left.participantLabel || "") === (right.participantLabel || "") &&
    (left.threadRootId || "") === (right.threadRootId || "") &&
    (left.runId || "") === (right.runId || "") &&
    (left.sourceMessageId || "") === (right.sourceMessageId || "") &&
    attachmentIds(left) === attachmentIds(right) &&
    turns(left) === turns(right) &&
    // A note an older shell stored as a plain row becomes the card.
    ((left.finishedNote && left.finishedNote.messageId) || "") === ((right.finishedNote && right.finishedNote.messageId) || "") &&
    // An urgent alert's card changes as the alert goes on (sent, calls, Got it).
    JSON.stringify(left.urgentAlert || null) === JSON.stringify(right.urgentAlert || null) &&
    (left.accordLaunchMessageId || "") === (right.accordLaunchMessageId || "") &&
    JSON.stringify(left.accordLaunch || null) === JSON.stringify(right.accordLaunch || null) &&
    // The sessions view places a message by whom it was for, and draws a
    // request's card from where each task stands.
    (left.addressees || []).join(",") === (right.addressees || []).join(",") &&
    JSON.stringify(left.participantRequest || null) === JSON.stringify(right.participantRequest || null) &&
    // An Accord the main session started is its card; a turn's worked time
    // heads its delegations.
    Boolean(left.accordLaunchByMainSession) === Boolean(right.accordLaunchByMainSession) &&
    (left.workedMs || 0) === (right.workedMs || 0) &&
    Boolean(left.turnContinues) === Boolean(right.turnContinues) &&
    Boolean(left.stopped) === Boolean(right.stopped) &&
    // A running reply's steps, and what its Worked for opens to.
    activitySignature(left) === activitySignature(right) &&
    Boolean(left.liveStatus) === Boolean(right.liveStatus) &&
    Boolean(left.liveActivity) === Boolean(right.liveActivity);
}

function sameMobileEvent(left, right) {
  return Boolean(left.mobileEventId) &&
    left.mobileEventId === right.mobileEventId &&
    Boolean(left.conversationId) && left.conversationId === right.conversationId;
}

// Scaffolding ("@x is running..." / "Running...") says an answer is being
// written before anyone has been picked. Once the participant's own row
// exists for the same phone message, that sentence has been replaced by the
// real thing — it is not a second live row, it is a leftover. User watched a
// long turn and saw both: an anonymous "Thinking" and, under it, the row
// carrying the actual text.
//
// The rule lives INSIDE the write transaction because the two rows travel
// different paths and race. Checked outside, the scaffolding's "is there a
// real row yet?" can run between the real row's own delete and its put, see
// nothing, and store itself anyway. IndexedDB serialises readwrite
// transactions on the store, so deciding here cannot interleave.
// The rows one chat holds, through the store's chat index when the database
// has it. Every rule below works inside one chat — the key it compares
// carries the chat id, and a phone message's own row is matched by chat as
// well — yet the read behind it used to scan the whole store for every
// delivered row. On a phone with weeks of chats that was seconds of main
// thread per batch, and a streaming member sends a batch every few seconds:
// the timeline fell behind and caught up in lumps, and the live text with
// it (the User, 2026-09-20).
/** The rows of one chat. The write path may take them from what this page
 *  already holds -- it is the only writer, so they cannot be stale behind its
 *  back -- while a read for drawing always goes to the store, because what is
 *  on screen must not come from memory that a reload would not have. */
// The key of a row that never exists. A write asks the store for it before
// taking the rows held for a chat: the answer comes only once every write
// created before this one has landed, and each of those brought the held
// rows up to date as it landed. Taken any earlier — at the moment the write
// was created, as they were at first — the held rows could predate the
// write in front, and a run's end judged against them missed the live row
// it had come to end: "Thinking…" stayed above the answer it belonged to
// whenever the run's last live row and its finished one landed together.
const HELD_ROWS_SYNC_KEY = "\u0000held-rows-sync";

function timelineRowsForConversation(store, conversationId, options) {
  const mayHold = Boolean(options && options.mayHold) &&
    typeof conversationId === "string" && Boolean(conversationId);
  const remember = function (rows) {
    return mayHold ? holdChatRows(conversationId, rows) : rows;
  };
  const readStore = function () {
    const schema = globalThis.AccordMobileDb;
    const indexName = schema && schema.TIMELINE_CONVERSATION_INDEX;
    if (typeof conversationId === "string" && conversationId && indexName && store.indexNames.contains(indexName)) {
      return requestToPromise(store.index(indexName).getAll(conversationId)).then(remember);
    }
    return requestToPromise(store.getAll()).then(function (rows) {
      return typeof conversationId === "string" && conversationId
        ? rows.filter(function (row) { return row && row.conversationId === conversationId; })
        : rows;
    }).then(remember);
  };
  if (!mayHold) {
    return readStore();
  }
  return requestToPromise(store.get(HELD_ROWS_SYNC_KEY)).then(function () {
    const held = chatRowsHeld.get(conversationId);
    return held ? held : readStore();
  });
}

/** Keeps the rows held for a chat in step with a write this function just
 *  made, so the next delivered row does not have to read the chat back. */
function noteChatRowStored(entry) {
  if (!entry) return;
  const rows = chatRowsHeld.get(entry.conversationId);
  if (!rows) return;
  holdChatRows(entry.conversationId, rows.filter(function (row) {
    return row && row.id !== entry.id;
  }).concat([entry]));
}

function noteChatRowsRemoved(conversationId, ids) {
  const rows = chatRowsHeld.get(conversationId);
  if (!rows || ids.length === 0) return;
  holdChatRows(conversationId, rows.filter(function (row) { return row && ids.indexOf(row.id) < 0; }));
}

/** `arrivedAt` is when a row new here (or in a new state) counts as having
 *  come, when that is not now: the page a chat was opened with. */
export function putTimelineEntryDeduped(entry, options) {
  const arrivedAt = options && typeof options.arrivedAt === "string" ? options.arrivedAt : undefined;
  const key = timelineEntryDedupeKey(entry);
  // The one write path that keeps the held rows in step instead of dropping
  // them: it is the one a streaming member takes, over and over.
  return withTimeline("readwrite", function (store) {
    return timelineRowsForConversation(store, entry.conversationId, { mayHold: true }).then(function (entries) {
      const current = entries.find(function (existing) {
        return existing && existing.id === entry.id && existing.conversationId === entry.conversationId &&
          existing.role === "participant" && entry.role === "participant" && existing.runId === entry.runId;
      });
      if (current && entry.status === "pending") {
        // A chat's page carries the waiting row; only the live progress
        // carries growing text. Either can arrive last, including after a
        // reconnect.
        if (current.status !== "pending") return 0;
        if (isScaffoldingEntry(entry) && !isPlaceholderTimelineContent(current.content)) {
          entry = { ...entry, content: current.content };
        }
        // Live progress does not repeat the snapshot's visual thread metadata.
        entry = { ...entry, createdAt: current.createdAt, threadRootId: entry.threadRootId || current.threadRootId };
      }
      const others = entries.filter(function (existing) {
        return existing && existing.id !== entry.id;
      });
      if (isScaffoldingEntry(entry) && others.some(function (existing) {
        return existing.role === "participant" &&
          !isPlaceholderTimelineContent(existing.content) &&
          sameMobileEvent(entry, existing);
      })) {
        return 0;
      }
      // Resolves true only when the store ends up different from before: a
      // replayed copy of a row already held is not news for anyone.
      const stored = entries.find(function (existing) {
        return existing && existing.id === entry.id && existing.conversationId === entry.conversationId;
      });
      // When this phone got the row in this state, and when it watched the
      // run end, are this phone's knowledge; a later copy of the same row
      // (the snapshot after the terminal, a page read under another id) does
      // not carry them. Taken from the copy being replaced, and stamped only
      // for a row that is new here or has just changed state.
      const prior = stored || (key ? others.find(function (existing) {
        return timelineEntryDedupeKey(existing) === key;
      }) : undefined);
      if (prior && prior.status === entry.status) {
        entry = {
          ...entry,
          ...(prior.receivedAt && !entry.receivedAt ? { receivedAt: prior.receivedAt } : {}),
          ...(prior.settledAt && !entry.settledAt ? { settledAt: prior.settledAt } : {})
        };
      } else if (!entry.receivedAt) {
        entry = { ...entry, receivedAt: arrivedAt || nowIso() };
      }
      // A later copy of a row this phone already holds can name less than
      // the first one did: a machine's delta carries no run id, a page read
      // no thread root. What was known stays known, or the row's identity
      // in Activity flips and a cleared update comes back as news.
      if (stored) {
        entry = {
          ...entry,
          ...(stored.runId && !entry.runId ? { runId: stored.runId } : {}),
          ...(stored.messageId && !entry.messageId ? { messageId: stored.messageId } : {}),
          ...(stored.threadRootId && !entry.threadRootId ? { threadRootId: stored.threadRootId } : {}),
          ...(stored.mobileEventId && !entry.mobileEventId ? { mobileEventId: stored.mobileEventId } : {}),
          ...(stored.participantId && !entry.participantId ? { participantId: stored.participantId } : {}),
          ...(stored.sourceMessageId && !entry.sourceMessageId ? { sourceMessageId: stored.sourceMessageId } : {}),
          // A copy without turns (a page from before the server kept them)
          // does not undo what a later one said.
          ...(Array.isArray(stored.turns) && !Array.isArray(entry.turns) ? { turns: stored.turns } : {}),
          // Nor one without the message's addressees or its tasks (live
          // progress carries neither).
          ...(Array.isArray(stored.addressees) && !Array.isArray(entry.addressees) ? { addressees: stored.addressees } : {}),
          ...(stored.participantRequest && !entry.participantRequest ? { participantRequest: stored.participantRequest } : {}),
          ...(stored.accordLaunchByMainSession && !entry.accordLaunchByMainSession ? { accordLaunchByMainSession: true } : {}),
          ...(typeof stored.workedMs === "number" && typeof entry.workedMs !== "number" && !entry.turnContinues ? { workedMs: stored.workedMs } : {}),
          ...(stored.turnContinues && !entry.turnContinues ? { turnContinues: true } : {}),
          // Nor one without the reply's steps (a live copy from a server
          // before it carried them).
          ...(Array.isArray(stored.activity) && !Array.isArray(entry.activity)
            ? { activity: stored.activity, ...(stored.activityMore ? { activityMore: stored.activityMore } : {}) } : {})
        };
        // Nor one that holds fewer of the reply's posts (a live copy from a
        // server before it carried them, a page read before the newest
        // post): posts are only ever added, so the two sets are merged.
        const posts = mergedInterimPosts(stored.interimPosts, entry.interimPosts);
        if (posts.length > 0 && interimPostsSignature({ interimPosts: posts }) !== interimPostsSignature(entry)) {
          entry = { ...entry, interimPosts: posts };
        }
        // A running reply's pictures are its posts' pictures: a copy
        // without them does not take them off.
        if (entry.status === "pending" && Array.isArray(stored.attachments) && stored.attachments.length > 0 &&
          !(Array.isArray(entry.attachments) && entry.attachments.length > 0)) {
          entry = { ...entry, attachments: stored.attachments };
        }
      }
      if (stored && sameTimelineEntryContent(stored, entry) &&
        (stored.settledAt || "") === (entry.settledAt || "") &&
        (stored.receivedAt || "") === (entry.receivedAt || "")) {
        return false;
      }
      const removed = others.filter(function (existing) {
        if (key && timelineEntryDedupeKey(existing) === key) {
          return true;
        }
        return !isScaffoldingEntry(entry) &&
          entry.role === "participant" &&
          isScaffoldingEntry(existing) &&
          sameMobileEvent(entry, existing);
      });
      const deletes = removed.map(function (existing) {
        return requestToPromise(store.delete(existing.id));
      });
      return Promise.all(deletes).then(function () {
        return requestToPromise(store.put(entry));
      }).then(function () {
        noteChatRowsRemoved(entry.conversationId, removed.map(function (existing) { return existing.id; }));
        noteChatRowStored(entry);
        return true;
      });
    });
  }, { maintainsChatRows: true });
}

// NOTE: an age guard was tried here and reverted. Its intent was right — an
// old terminal should not delete a newer live row — but the pending row and
// the answer it becomes do not share an id on every path, so the guard blocked
// rows from ever being replaced and they piled up on screen. The root cause it
// was defending against is fixed upstream: the conversation projection no
// longer lends one run's id to unrelated messages.
// A terminal carries two keys and they do NOT identify the same row. The run
// id names the run that produced the answer; a participant answering a
// phone-sent message fans out under a fresh run id chat.ts invents, while the
// placeholder the phone is showing was keyed by the ingest run
// (`mobile-<eventId>`). Requiring BOTH keys to match — which is what this did
// — meant a phone-started turn never cleared its own row: the answer landed
// and "Thinking" stayed above it forever, and tapping that corpse opened the
// stream on whichever older answer shared its mobile event id.
//
// Requiring EITHER key is too blunt in the other direction: a live row from a
// second participant on the same phone message carries the same mobile event
// id, so the first agent to finish would delete the other's in-progress row —
// the "Thinking appears for a second and vanishes" regression. So the mobile
// event id clears scaffolding only. Real in-progress text is never touched by
// it; only the run id, which is precise, may take a row with content.
// The ingest run is named after the phone message it carries, so a terminal
// under that name is the whole message failing rather than one member
// finishing. Nothing else can say it: when sendMessage throws, no participant
// ever produced a terminal of its own, and the control service's catch is the
// only thing that reports the run is over.
function isPhoneMessageFailure(status, runId, mobileEventId) {
  return status === "error" && Boolean(mobileEventId) && runId === "mobile-" + mobileEventId;
}

export function deleteTimelineEntry(entryId) {
  return withTimeline("readwrite", function (store) {
    return requestToPromise(store.get(entryId)).then(function (existing) {
      if (!existing) {
        return false;
      }
      return requestToPromise(store.delete(entryId)).then(function () {
        noteChatRowsRemoved(existing.conversationId, [entryId]);
        return true;
      });
    });
  }, { maintainsChatRows: true });
}

export function deletePendingTimelineEntriesForRun(conversationId, runId, mobileEventId, messageId, status) {
  if (!runId && !mobileEventId && !messageId) {
    return Promise.resolve(0);
  }
  const wholeMessageFailed = isPhoneMessageFailure(status, runId, mobileEventId);
  return withTimeline("readwrite", function (store) {
    return timelineRowsForConversation(store, conversationId, { mayHold: true }).then(function (entries) {
      const deletes = entries.filter(function (entry) {
        if (!entry || entry.status !== "pending") {
          return false;
        }
        // A finished message ends its OWN row. It used to end every pending
        // row of its run, which is wrong for a turn that posts more than one
        // message: an intermediate note posted mid-run deleted the live row
        // the run was still writing, so the turn looked finished while it was
        // still going.
        const matchesMessage = Boolean(messageId) &&
          (entry.messageId === messageId || entry.sourceId === messageId);
        const matchesScaffolding = isPlaceholderTimelineContent(entry.content) &&
          ((Boolean(runId) && entry.runId === runId) ||
            (Boolean(mobileEventId) && entry.mobileEventId === mobileEventId));
        // A live row that never carried a message id of its own can only be
        // this run's current segment, so the run id is the only handle there
        // is. Rows that DO name a message are left to the clause above.
        //
        // This holds because every source that posts more than one message
        // per run also stamps a message id: chat turns build their progress
        // sink with the pending message's id, and scaffolding carries a
        // synthetic one. A future progress source that omits the message id
        // AND posts intermediate messages would bring back the bug where a
        // note deletes the live row beside it — give it a message id.
        const matchesAnonymousRunRow = Boolean(runId) && entry.runId === runId && !entry.messageId;
        // A failed phone message takes every row it started with it. Scoped
        // to the ingest run on purpose: one member erroring while another is
        // still writing carries the same mobile event id, and must not clear
        // the other's live row.
        const matchesFailedPhoneMessage = wholeMessageFailed && entry.mobileEventId === mobileEventId;
        return (matchesMessage || matchesScaffolding || matchesAnonymousRunRow || matchesFailedPhoneMessage) &&
          entry.conversationId === conversationId;
      }).map(function (entry) {
        return { id: entry.id, done: requestToPromise(store.delete(entry.id)) };
      });
      return Promise.all(deletes.map(function (item) { return item.done; })).then(function () {
        noteChatRowsRemoved(conversationId, deletes.map(function (item) { return item.id; }));
        return deletes.length;
      });
    });
  }, { maintainsChatRows: true });
}

// A placeholder row ("@x is running..." / "Running...") is pure scaffolding:
// it announces that an answer is being written. Its run can die without a
// terminal that carries its keys — an interrupted app, or an answer written
// before terminals inherited the source's mobile event id — and then nothing
// ever deletes it. A placeholder half an hour older than an arriving
// terminal is taken for a corpse, unless the server still lists its turn as
// going (turnsStillGoing): a member's turn can run for hours, and the old
// "no run outlives the CLI's 15-minute kill" no longer holds. Only
// placeholder-sentence rows qualify; real pending text is never touched,
// which is what the reverted age guard got wrong.
const PLACEHOLDER_CORPSE_AGE_MS = 30 * 60 * 1000;

export function isPlaceholderTimelineContent(content) {
  const text = (content || "").trim();
  return text === "Running..." || /\bis running\.\.\.$/.test(text);
}

/** The turns still going in a chat as far as this phone can tell: its chat
 *  list carries every turn in progress (however far back it started), the
 *  page just read carries those among its rows, and the turns that left the
 *  list are kept until the server says how they ended. A placeholder of one
 *  of them is a turn that is long, not dead: members' turns run for hours. */
export function turnsStillGoing(conversationId, batchEvents, includeSettling) {
  const going = new Set();
  const chat = loadChats().find(function (item) { return item.id === conversationId; });
  const events = (chat && Array.isArray(chat.activity) ? chat.activity : []).concat(Array.isArray(batchEvents) ? batchEvents : []);
  for (const event of events) {
    if (!event || event.status !== "pending") continue;
    for (const key of [event.runId, event.messageId, event.id]) {
      if (typeof key === "string" && key) going.add(key);
    }
  }
  // A turn this phone is still asking the server about is not a corpse
  // either: its end is on its way (see settleTurnsThatLeftTheList).
  if (includeSettling !== false) {
    for (const entry of loadSettleTurns()) {
      if (entry.conversationId === conversationId && !settleGivenUp(entry)) going.add(entry.messageId);
    }
  }
  return going;
}

export function deleteStalePlaceholderTimelineEntries(conversationId, terminalCreatedAt, batchEvents) {
  const terminalTime = Date.parse(terminalCreatedAt || "");
  if (!Number.isFinite(terminalTime)) {
    return Promise.resolve(0);
  }
  const going = turnsStillGoing(conversationId, batchEvents);
  return withTimeline("readwrite", function (store) {
    return timelineRowsForConversation(store, conversationId, { mayHold: true }).then(function (entries) {
      const deletes = entries.filter(function (entry) {
        if (!entry || entry.status !== "pending" || !isPlaceholderTimelineContent(entry.content)) {
          return false;
        }
        if (entry.conversationId !== conversationId) {
          return false;
        }
        if ((entry.runId && going.has(entry.runId)) || going.has(entry.messageId || entry.sourceId)) {
          return false;
        }
        const created = Date.parse(entry.createdAt || "");
        return Number.isFinite(created) && terminalTime - created > PLACEHOLDER_CORPSE_AGE_MS;
      }).map(function (entry) {
        return { id: entry.id, done: requestToPromise(store.delete(entry.id)) };
      });
      return Promise.all(deletes.map(function (item) { return item.done; })).then(function () {
        noteChatRowsRemoved(conversationId, deletes.map(function (item) { return item.id; }));
        return deletes.length;
      });
    });
  }, { maintainsChatRows: true });
}

// Before 2026-09-18-pwa-parity-v1 the desktop's projection sent every
// system message and the phone stored each as a bubble. Those the desktop
// never showed ("Auto-resumed @x after member request", tool-approval
// notes) are dropped once; a system row the User can see (an artifact note)
// is fetched again with the chat's last page and comes back. Rows the phone
// itself wrote — machine warnings and errors, from when it reached machines
// directly, kept under ids with this prefix — are not from the desktop and
// stay.
const INTERNAL_SYSTEM_ROWS_DROPPED_KEY = "accordagents.mobile.internalSystemRowsDropped.v1";

const MACHINE_ROW_ID_PREFIX = "machine-";

export function dropStoredInternalSystemRows() {
  if (localStorage.getItem(INTERNAL_SYSTEM_ROWS_DROPPED_KEY) === "1") {
    return Promise.resolve(0);
  }
  return withTimeline("readwrite", function (store) {
    return requestToPromise(store.getAll()).then(function (entries) {
      const deletes = entries.filter(function (entry) {
        return entry && entry.role === "system" && !String(entry.sourceId || "").startsWith(MACHINE_ROW_ID_PREFIX);
      }).map(function (entry) {
        return requestToPromise(store.delete(entry.id));
      });
      return Promise.all(deletes).then(function () {
        return deletes.length;
      });
    });
  }).then(function (dropped) {
    localStorage.setItem(INTERNAL_SYSTEM_ROWS_DROPPED_KEY, "1");
    return dropped;
  });
}

export function listTimelineEntries(conversationId) {
  return withTimeline("readonly", function (store) {
    return timelineRowsForConversation(store, conversationId);
  }).then(function (entries) {
    return entries.filter(function (entry) {
      // Older rows without an owner stay on disk, but cannot be attributed
      // to every chat. Only the desktop/machine can state their ownership.
      return !conversationId || entry.conversationId === conversationId;
    }).sort(function (left, right) {
      return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    });
  });
}

export function timelineEntryDedupeKey(entry) {
  if (!entry || entry.role === "you") {
    return "";
  }
  const conversationId = typeof entry.conversationId === "string" ? entry.conversationId.trim() : "";
  const mobileEventId = typeof entry.mobileEventId === "string" ? entry.mobileEventId.trim() : "";
  const messageId = typeof entry.messageId === "string" ? entry.messageId.trim() : "";
  const sourceId = typeof entry.sourceId === "string" ? entry.sourceId.trim() : "";
  const runId = typeof entry.runId === "string" ? entry.runId.trim() : "";
  const content = typeof entry.content === "string" ? entry.content.trim() : "";
  if (!content) {
    return "";
  }
  const participant = typeof entry.participantLabel === "string" && entry.participantLabel.trim()
    ? entry.participantLabel.trim().toLowerCase()
    : entry.role === "system" ? "system" : "participant";
  const status = entry.status === "error" ? "error" : entry.status === "done" ? "done" : "pending";
  if (mobileEventId) {
    return [conversationId, "mobile", mobileEventId, participant, status, content].join("\0");
  }
  if (messageId || sourceId) {
    return [conversationId, "message", messageId || sourceId, participant, status, content].join("\0");
  }
  if (!runId) {
    return "";
  }
  return [conversationId, "run", runId, participant, status, content].join("\0");
}

export function dedupeTimelineEntries(entries) {
  const output = [];
  const indexByKey = new Map();
  for (const entry of entries) {
    const key = timelineEntryDedupeKey(entry);
    if (!key) {
      output.push(entry);
      continue;
    }
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, output.length);
      output.push(entry);
      continue;
    }
    output[existingIndex] = preferTimelineEntry(output[existingIndex], entry);
  }
  return output;
}

// One render key means one row on screen — that is the whole point of the
// key. The store can hold two records that collapse to it for a moment: a
// live row and the finished answer differ in status and content, so they are
// separate records until reconciliation removes the first. Rendering both
// mounted two nodes under one key, and the newest text won on one of them
// while the other kept whatever it had.
export function dedupeRenderRowsByKey(rows) {
  const output = [];
  const indexByKey = new Map();
  for (const row of rows) {
    const key = row.rowKey || row.id;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, output.length);
      output.push(row);
      continue;
    }
    output[existingIndex] = preferTimelineEntry(output[existingIndex], row);
  }
  return output;
}

function preferTimelineEntry(left, right) {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return rightTime >= leftTime ? right : left;
  }
  return right.createdAt >= left.createdAt ? right : left;
}

export function timelineRenderRowKey(entry) {
  if (!entry) {
    return "";
  }
  const conversationId = typeof entry.conversationId === "string" ? entry.conversationId.trim() : "";
  const participant = typeof entry.participantLabel === "string" && entry.participantLabel.trim()
    ? entry.participantLabel.trim().toLowerCase()
    : entry.role === "system" ? "system" : "participant";
  const mobileEventId = typeof entry.mobileEventId === "string" ? entry.mobileEventId.trim() : "";
  // Scaffolding has no message of its own — it stands for the phone message
  // until a real row exists — so the phone message is its identity. Anything
  // else is keyed by its own message: one turn can post several (an
  // intermediate note while the run carries on, then the answer), and keying
  // those by the phone message collapsed them into one row, so the note ate
  // the live row and the turn looked finished while it was still writing.
  if (mobileEventId && isScaffoldingEntry(entry)) {
    return ["timeline-mobile", conversationId, mobileEventId, participant].join("\0");
  }
  const messageId = typeof entry.messageId === "string" ? entry.messageId.trim() : "";
  const sourceId = typeof entry.sourceId === "string" ? entry.sourceId.trim() : "";
  if (messageId || sourceId) {
    return ["timeline-message", conversationId, messageId || sourceId, participant].join("\0");
  }
  const runId = typeof entry.runId === "string" ? entry.runId.trim() : "";
  if (runId) {
    return ["timeline-run", conversationId, runId, participant].join("\0");
  }
  return "timeline-entry\0" + String(entry.id || "");
}
