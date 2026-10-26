(function () {
  const META_STORE = "meta";
  const OUTBOX_STORE = "outbox";
  const TIMELINE_STORE = "timeline";
  // A pairing made the old way, through the desktop's relay. Nothing reads or
  // writes through it any more: a phone that still holds one is told to pair
  // again with the User's server, and what that pairing kept is cleared.
  const OLD_PAIRING_KEY = "accordagents.mobile.pairing.v1";
  const OLD_MAILBOX_CURSOR_KEY = "accordagents.mobile.mailboxCursor.v1";
  // Set when an old pairing was cleared and no server pairing replaced it yet,
  // so the notice that says why stays until the phone pairs again.
  const OLD_PAIRING_CLEARED_KEY = "accordagents.mobile.oldPairingCleared.v1";
  // What the old way kept on this phone, in stores and meta records nothing
  // reads any more. The stores stay in the database's description (it only
  // ever adds); their contents go with the old pairing.
  const OLD_PAIRING_STORES = ["sealedEnvelopes", "events", "machineEvents", "machineOutbox", "machineBlobs"];
  const OLD_PAIRING_META_KEYS = ["mailboxAccess", "machine-command-identity", "machine-access", "machine-run-terminals"];
  const OLD_PAIRING_META_PREFIXES = ["machine-change-order:", "conversation-deleted:"];
  const ACTIVE_CONVERSATION_KEY = "accordagents.mobile.activeConversationId.v1";
  const OPEN_THREAD_KEY = "accordagents.mobile.openThreadRootId.v1";
  // W-M: which run's reply is being watched. Session-scoped like the open
  // thread: reopening the app should land you back in the chat, not in a
  // stream for a run that finished while you were away.
  const OPEN_STREAM_KEY = "accordagents.mobile.openStreamRunId.v1";
  const SYNC_WAIT_KEY = "accordagents.mobile.syncWaitStartedAt.v1";
  const CHAT_LIST_KEY = "accordagents.mobile.chatList.v1";
  const TERMINAL_RUNS_KEY = "accordagents.mobile.terminalRuns.v1";
  // Cards a member is waiting on, per chat, as the desktop last stated them.
  // Kept so closing the app does not lose a question that is still open.
  const CONTROL_CARDS_KEY = "accordagents.mobile.controlCards.v1";
  // Cards answered from this phone whose answer the desktop has not yet
  // stated as applied, with the queue entry that carries the answer. Kept
  // across launches: a mark that lived only in memory made a reloaded app
  // show the card as never answered (the User, 2026-09-20).
  const CONTROL_CARD_SENT_KEY = "accordagents.mobile.controlCardSent.v1";
  // Chats with activity this phone has not looked at yet. The dot in the list
  // and the number on the app icon both read from here; the service worker
  // adds to its IndexedDB mirror when a push lands while the app is closed.
  const UNREAD_KEY = "accordagents.mobile.unreadConversationIds.v1";
  const UNREAD_META_KEY = "unreadConversations";
  const CHAT_TITLES_META_KEY = "chatTitles";
  // Where the history of each chat stops on this phone: whether the desktop
  // has messages before the oldest one shown, and which message to ask before.
  const TIMELINE_PAGES_KEY = "accordagents.mobile.timelinePages.v1";
  // Which home tab the bottom bar shows (Chats, Activity, Settings), and which
  // list Activity was left on. Coming back from a chat lands where you left.
  const HOME_TAB_KEY = "accordagents.mobile.homeTab.v1";
  const ACTIVITY_TAB_KEY = "accordagents.mobile.activityTab.v1";
  // When each chat was last looked at on this phone. Activity reads a finished
  // update as seen when the chat was opened after it arrived.
  const VIEWED_AT_KEY = "accordagents.mobile.viewedAt.v1";
  // When the desktop's chat list last reached this phone, on its own clock.
  // Activity drops an "in progress" row that reached the phone well before a
  // list saying nothing runs in that chat: a run the phone never saw end.
  const CHAT_LIST_AT_KEY = "accordagents.mobile.chatListAt.v1";
  // When each member message the chat list carries for Activity first reached
  // this phone in its current state, on this phone's clock: what Activity
  // judges "new since you looked" by for a chat whose pages it never read.
  const LIST_ACTIVITY_SEEN_KEY = "accordagents.mobile.listActivitySeen.v1";
  // What the list may carry per chat, and how much of each message: the same
  // length Activity previews from.
  const LIST_ACTIVITY_PER_CHAT = 8;
  const LIST_ACTIVITY_CONTENT_CHARS = 880;
  const TERMINAL_RUNS_MAX = 600;
  let activeFlushOutboxPromise;
  // The status of every queue entry this phone has seen, by event id, so a
  // card can say whether the answer it sent was handed over without a read.
  const outboxStatusById = new Map();
  // Held so a second bootstrap replaces the ticker instead of stacking another
  // one on top of it.
  let activeThinkingClockTimer;
  let activeSyncProgressClockTimer;
  let lastChatListRenderSignature = "";
  let lastActivityRenderSignature = "";
  let lastSettingsRenderSignature = "";
  // The choice opened from Activity to be answered in full, by card id.
  let openActivityCardId;
  // The thread to land in when the chat Activity is opening is first drawn.
  let pendingThreadOpen;
  // Bumped by every write to the timeline store. The home screens redraw on
  // every batch and poll; rereading a week of messages each time for the
  // Activity badge would cost the phone far more than the list is worth.
  let timelineGeneration = 0;
  let recentTimelineCache;
  let recentTimelineRead;
  // The lists last built, and what they were built from.
  let activityMemo;
  // When the Activity list was last redrawn; taps right after it are ignored.
  let lastActivityListRenderAt = 0;
  let lastActivityRowOrder = "";
  let chatListRefreshTimer;
  let lastChatListRefreshAt = 0;
  let activityRereadTimer;
  const ACTIVITY_REREAD_MIN_MS = 1500;
  let activityItemRenderToken = 0;

  function nowIso() {
    return new Date().toISOString();
  }

  // What this phone did and was handed, kept in memory when the page is opened
  // with `?qa` (the harnesses read it); nothing otherwise.
  function recordRelayDebug(entry) {
    try {
      if (!new URL(globalThis.location.href).searchParams.has("qa")) {
        return;
      }
      globalThis.__relayDebug = globalThis.__relayDebug || [];
      globalThis.__relayDebug.push({
        at: Date.now(),
        ...entry
      });
    } catch {
      return;
    }
  }

  function createEventId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join("-");
  }

  function base64UrlToBytes(value) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function textToBytes(value) {
    return new TextEncoder().encode(value);
  }

  async function sha256Hex(value) {
    if (!globalThis.crypto?.subtle) {
      throw new Error("Mobile outbox hashing requires WebCrypto.");
    }
    const digest = await globalThis.crypto.subtle.digest("SHA-256", textToBytes(value));
    return Array.from(new Uint8Array(digest), function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function stableJson(value) {
    if (value === undefined) {
      return "null";
    }
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return "[" + value.map(stableJson).join(",") + "]";
    }
    return "{" + Object.keys(value).filter(function (key) {
      return value[key] !== undefined;
    }).sort().map(function (key) {
      return JSON.stringify(key) + ":" + stableJson(value[key]);
    }).join(",") + "}";
  }

  // Doorbell subscription: the phone registers its Web Push subscription with
  // the User's server, signed with its own key. The server's pushes carry no
  // message text; iOS requires a user gesture before Notification permission,
  // hence the explicit enable button.
  let pushSubscriptionEnsured = false;
  // The server refuses push endpoints it does not ring. That refusal must be
  // said out loud: a phone that silently never rings looks identical to one
  // that is simply quiet, and the user waits forever.
  let pushEndpointRejected = false;

  // One subscription attempt at a time: the launch and a tap on "Enable"
  // can ask together, and two attempts post two subscriptions (and undo
  // each other's).
  let pushSubscriptionInFlight;

  /** The push subscription goes to the User's server, signed: the server
   *  rings this phone itself, desktop or no desktop. Replaced on each launch:
   *  a subscription can stop being delivered without ever being reported
   *  gone, and from in here the two cases look identical. The server's key is
   *  read before anything is given up: a phone that cannot reach the server
   *  just now keeps the subscription it has rather than trading it for a
   *  replacement it cannot make. */
  async function ensureHubPushSubscription() {
    const client = hubClient();
    if (!client) return;
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    const publicKey = await client.vapidKey();
    if (subscription) {
      try {
        await subscription.unsubscribe();
        subscription = undefined;
      } catch {
        // Keeping a subscription that might be dead beats having none.
      }
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
    }
    try {
      await client.registerPushSubscription(subscription.toJSON());
      pushSubscriptionEnsured = true;
    } catch (error) {
      if (error && error.status === 400) {
        // Terminal for this browser: its push service is not one the server
        // rings.
        pushEndpointRejected = true;
        pushSubscriptionEnsured = true;
        return;
      }
      throw error;
    }
  }

  function ensurePushSubscription() {
    if (pushSubscriptionInFlight) return pushSubscriptionInFlight;
    pushSubscriptionInFlight = ensurePushSubscriptionNow().finally(function () {
      pushSubscriptionInFlight = undefined;
    });
    return pushSubscriptionInFlight;
  }

  async function ensurePushSubscriptionNow() {
    if (pushSubscriptionEnsured) {
      return;
    }
    try {
      if (!("Notification" in globalThis) || Notification.permission !== "granted") {
        return;
      }
      if (!navigator.serviceWorker || !("PushManager" in globalThis)) {
        return;
      }
      if (!isHubPairing(loadPairing())) {
        return;
      }
      await ensureHubPushSubscription();
    } catch {
      // Push is an enhancement; the app reads the server when it is open.
    }
  }

  // A push subscription can go dead while still looking alive: the push
  // service keeps accepting rings for it and the phone never hears one. From
  // inside the app the only cure is to drop the subscription and ask for a new
  // one, so this is offered wherever alerts are already on.
  let alertsReconnect = "";

  async function reconnectMessageAlerts() {
    if (!isHubPairing(loadPairing())) return "failed";
    if (!navigator.serviceWorker || !("PushManager" in globalThis)) return "failed";
    try {
      // ensurePushSubscription replaces the subscription itself, and only once
      // it has reached the server: dropping it here first left a phone that
      // tapped Reconnect without a connection with no subscription at all.
      pushSubscriptionEnsured = false;
      await ensurePushSubscription();
      return pushSubscriptionEnsured && !pushEndpointRejected ? "ok" : "failed";
    } catch {
      return "failed";
    }
  }

  async function enableMessageAlerts() {
    try {
      if (!("Notification" in globalThis)) {
        return "unsupported";
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        return permission;
      }
      await ensurePushSubscription();
      await render("synced");
      return "granted";
    } catch {
      return "error";
    }
  }

  function openDb() {
    // One description of this database, shared with the service worker. They
    // are separate programs over the same storage, and when each carried its
    // own version the two drifted far enough that the worker could no longer
    // open it at all.
    const schema = globalThis.AccordMobileDb;
    if (!schema) return Promise.reject(new Error("The phone's database description did not load."));
    return schema.openControlDb(indexedDB);
  }

  /**
   * One IndexedDB transaction across several stores. A queued event and the
   * head of the chain it was signed into are written inside one, so a failed
   * write leaves neither: an event the server will never hear about is worse
   * than one the User can retry.
   */
  function eventLogPort() {
    return {
      runAtomic: function (names, work) {
        return openDb().then(function (db) {
          return new Promise(function (resolve, reject) {
            const tx = db.transaction(names, "readwrite");
            const stores = {};
            names.forEach(function (name) { stores[name] = tx.objectStore(name); });
            let value;
            let failed;
            tx.onerror = function () { reject(failed || tx.error || new Error("Event log transaction failed.")); };
            tx.onabort = function () { reject(failed || tx.error || new Error("Event log transaction aborted.")); };
            tx.oncomplete = function () { resolve(value); db.close(); };
            const handle = {
              get: function (name, key) { return requestToPromise(stores[name].get(key)); },
              getAll: function (name) { return requestToPromise(stores[name].getAll()); },
              put: function (name, entry) { return requestToPromise(stores[name].put(entry)); },
              remove: function (name, key) { return requestToPromise(stores[name].delete(key)); },
              clear: function (name) { return requestToPromise(stores[name].clear()); },
              removeWhere: function (name, matches) {
                return new Promise(function (resolve, reject) {
                  const request = stores[name].openCursor();
                  request.onerror = () => reject(request.error);
                  request.onsuccess = function () {
                    const cursor = request.result;
                    if (!cursor) { resolve(); return; }
                    if (matches(cursor.value)) cursor.delete();
                    cursor.continue();
                  };
                });
              }
            };
            Promise.resolve()
              .then(function () { return work(handle); })
              .then(function (result) { value = result; })
              .catch(function (error) { failed = error; try { tx.abort(); } catch (abortError) { reject(error); } });
          });
        });
      }
    };
  }

  function withOutbox(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(OUTBOX_STORE, mode);
        const store = tx.objectStore(OUTBOX_STORE);
        let value;
        tx.onerror = function () {
          reject(tx.error || new Error("Outbox transaction failed."));
        };
        tx.oncomplete = function () {
          resolve(value);
          db.close();
        };
        try {
          value = fn(store);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    });
  }

  function requestToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onerror = function () {
        reject(request.error || new Error("IndexedDB request failed."));
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
    });
  }

  function noteOutboxStatus(entry) {
    if (entry && typeof entry.eventId === "string") {
      outboxStatusById.set(entry.eventId, { status: entry.status });
    }
  }

  function putOutboxEntry(entry) {
    noteOutboxStatus(entry);
    return withOutbox("readwrite", function (store) {
      return requestToPromise(store.put(entry));
    });
  }

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

  function dropCachedChatRows() {
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

  function withTimeline(mode, fn, options) {
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

  function isScaffoldingEntry(entry) {
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
    return left.content === right.content &&
      left.status === right.status &&
      left.createdAt === right.createdAt &&
      (left.participantLabel || "") === (right.participantLabel || "") &&
      (left.threadRootId || "") === (right.threadRootId || "") &&
      (left.runId || "") === (right.runId || "") &&
      attachmentIds(left) === attachmentIds(right);
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
  function putTimelineEntryDeduped(entry, options) {
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
            ...(stored.mobileEventId && !entry.mobileEventId ? { mobileEventId: stored.mobileEventId } : {})
          };
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

  function deleteTimelineEntry(entryId) {
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

  function deletePendingTimelineEntriesForRun(conversationId, runId, mobileEventId, messageId, status) {
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
  // ever deletes it. No live run outlives the CLI's own 15-minute kill, so a
  // placeholder half an hour older than an arriving terminal is a corpse, not
  // a run. Only placeholder-sentence rows qualify; real pending text is never
  // touched, which is what the reverted age guard got wrong.
  const PLACEHOLDER_CORPSE_AGE_MS = 30 * 60 * 1000;

  function isPlaceholderTimelineContent(content) {
    const text = (content || "").trim();
    return text === "Running..." || /\bis running\.\.\.$/.test(text);
  }

  function deleteStalePlaceholderTimelineEntries(conversationId, terminalCreatedAt) {
    const terminalTime = Date.parse(terminalCreatedAt || "");
    if (!Number.isFinite(terminalTime)) {
      return Promise.resolve(0);
    }
    return withTimeline("readwrite", function (store) {
      return timelineRowsForConversation(store, conversationId, { mayHold: true }).then(function (entries) {
        const deletes = entries.filter(function (entry) {
          if (!entry || entry.status !== "pending" || !isPlaceholderTimelineContent(entry.content)) {
            return false;
          }
          if (entry.conversationId !== conversationId) {
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

  function dropStoredInternalSystemRows() {
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

  function withNamedStore(storeName, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let value;
        tx.onerror = function () {
          reject(tx.error || new Error(storeName + " transaction failed."));
        };
        tx.oncomplete = function () {
          resolve(value);
          db.close();
        };
        try {
          value = fn(store);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    });
  }

  async function readMetaRecord(key) {
    return withNamedStore(META_STORE, "readonly", function (store) {
      return requestToPromise(store.get(key));
    });
  }

  /**
   * A record this phone cannot lose quietly.
   *
   * This used to swallow its errors. A failed write of the signing identity
   * meant a phone that minted a new key on the next reload, which the server
   * then refused because its roster names the old one. It is visible now, and
   * the caller decides.
   */
  async function writeMetaRecord(key, value) {
    const existing = (await readMetaRecord(key)) || {};
    await withNamedStore(META_STORE, "readwrite", function (store) {
      store.put({ ...existing, ...value, key });
    });
  }

  // Once a run has produced its final (done or error) event, replayed copies
  // of its older "running" placeholders must not resurrect. A retry of the
  // same run stays visible because its placeholder is newer than the recorded
  // terminal timestamp.
  let terminalRunMap;

  function terminalRuns() {
    if (!terminalRunMap) {
      terminalRunMap = new Map();
      for (const pair of loadStoredStringArray(TERMINAL_RUNS_KEY)) {
        const split = pair.indexOf("\u0000");
        if (split > 0) {
          terminalRunMap.set(pair.slice(0, split), pair.slice(split + 1));
        }
      }
    }
    return terminalRunMap;
  }

  function terminalRunKeys(runId, mobileEventId) {
    const keys = [];
    if (typeof runId === "string" && runId.trim()) {
      keys.push("run\u0000" + runId.trim());
    }
    if (typeof mobileEventId === "string" && mobileEventId.trim()) {
      keys.push("mobile\u0000" + mobileEventId.trim());
    }
    return keys;
  }

  function rememberTerminalRun(runId, mobileEventId, terminalCreatedAt) {
    const runs = terminalRuns();
    let changed = false;
    for (const key of terminalRunKeys(runId, mobileEventId)) {
      const existing = runs.get(key);
      if (existing === undefined || existing < terminalCreatedAt) {
        runs.set(key, terminalCreatedAt);
        changed = true;
      }
    }
    if (changed) {
      saveStoredStringArray(TERMINAL_RUNS_KEY, Array.from(runs.entries()).slice(-TERMINAL_RUNS_MAX).map(function (entry) {
        return entry[0] + "\u0000" + entry[1];
      }));
    }
  }

  function isSupersededPendingEvent(runId, mobileEventId, createdAt) {
    const runs = terminalRuns();
    return terminalRunKeys(runId, mobileEventId).some(function (key) {
      const terminalAt = runs.get(key);
      return terminalAt !== undefined && createdAt <= terminalAt;
    });
  }

  function loadStoredStringArray(key) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(function (value) {
        return typeof value === "string";
      }) : [];
    } catch {
      return [];
    }
  }

  function saveStoredStringArray(key, values) {
    try {
      localStorage.setItem(key, JSON.stringify(values));
    } catch {
      // Bookkeeping is best-effort; ingest stays idempotent without it.
    }
  }

  function listTimelineEntries(conversationId) {
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

  function timelineEntryDedupeKey(entry) {
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

  function dedupeTimelineEntries(entries) {
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
  function dedupeRenderRowsByKey(rows) {
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

  function timelineRenderRowKey(entry) {
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

  function listOutboxEntries(conversationId) {
    return withOutbox("readonly", function (store) {
      return requestToPromise(store.getAll());
    }).then(function (entries) {
      for (const entry of entries) noteOutboxStatus(entry);
      return entries.filter(function (entry) {
        return !conversationId || entry.conversationId === conversationId;
      }).sort(function (left, right) {
        return left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId);
      });
    });
  }

  // The list is read for every avatar painted and every row reconciled;
  // parsing a hundred chats with their member records each time was tens of
  // megabytes of JSON per list rebuild on the User's phone. The parse is kept
  // until the list is saved again here, or changed by another window of this
  // origin (the storage event); the objects are never mutated by readers.
  let cachedChatList;

  function forgetCachedChatList() {
    cachedChatList = undefined;
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", function (event) {
      if (!event || event.key === null || event.key === CHAT_LIST_KEY) {
        forgetCachedChatList();
      }
      // Another tab paired this phone again: its key is read afresh.
      if (!event || event.key === null || event.key === HUB_PAIRING_KEY) {
        forgetHubIdentity();
        hubClientCache = undefined;
      }
    });
  }

  function loadChats() {
    try {
      if (!cachedChatList) {
        const raw = localStorage.getItem(CHAT_LIST_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        cachedChatList = Array.isArray(parsed) ? parsed : [];
      }
      return cachedChatList;
    } catch {
      return [];
    }
  }

  function saveChats(chats) {
    if (Array.isArray(chats) && chats.length > 0) {
      sessionStorage.removeItem(SYNC_WAIT_KEY);
    }
    const previousById = new Map(loadChats().map(function (chat) {
      return [chat.id, chat];
    }));
    const normalized = Array.isArray(chats) ? chats.filter(function (chat) {
      return chat && typeof chat.id === "string" && chat.id.trim();
    }).map(function (chat) {
      return {
        id: chat.id,
        title: typeof chat.title === "string" && chat.title.trim() ? chat.title : "Chat",
        group: typeof chat.group === "string" && chat.group.trim() ? chat.group : "AccordAgents",
        snippet: typeof chat.snippet === "string" && chat.snippet.trim() ? chat.snippet : "No messages yet",
        who: typeof chat.who === "string" ? chat.who : undefined,
        updatedAt: typeof chat.updatedAt === "string" ? chat.updatedAt : nowIso(),
        running: chat.running === true,
        participants: Array.isArray(chat.participants) ? chat.participants.filter(function (item) {
          return typeof item === "string" && item.trim();
        }).slice(0, 4) : [],
        members: Array.isArray(chat.members) ? chat.members.map(normalizeMobileMember).filter(Boolean) : [],
        ...listActivityOf(chat)
      };
    }) : [];
    // A full storage must not stop the list: without the members' recent
    // messages it is a fraction of the size, and failing that it is kept for
    // this session only. A list write that threw left the phone on the list
    // it had, whatever the server said.
    let kept = normalized;
    try {
      localStorage.setItem(CHAT_LIST_KEY, JSON.stringify(normalized));
      forgetCachedChatList();
    } catch {
      kept = normalized.map(function (chat) {
        const { activity: _activity, ...rest } = chat;
        return rest;
      });
      try {
        localStorage.setItem(CHAT_LIST_KEY, JSON.stringify(kept));
        forgetCachedChatList();
      } catch {
        recordRelayDebug({ event: "chat-list-not-stored" });
      }
      cachedChatList = kept;
    }
    noteListActivitySeen(kept);
    // Same rule as the desktop sidebar: a chat that moved while it was not the
    // one on screen is unread. The list this phone held before is the "seen"
    // baseline, so the first list after an update marks nothing.
    const activeId = selectedConversationId();
    const viewingActive = Boolean(activeId) && !document.hidden;
    const newlyActive = normalized.filter(function (chat) {
      const previous = previousById.get(chat.id);
      return Boolean(previous) &&
        chat.updatedAt > previous.updatedAt &&
        !(viewingActive && chat.id === activeId);
    }).map(function (chat) {
      return chat.id;
    });
    if (newlyActive.length > 0) {
      markConversationsUnread(newlyActive);
    }
    void mirrorChatTitlesForWorker(normalized);
    return normalized;
  }

  function loadUnreadConversationIds() {
    return loadStoredStringArray(UNREAD_KEY);
  }

  function markConversationsUnread(conversationIds) {
    const current = loadUnreadConversationIds();
    const next = current.slice();
    for (const conversationId of conversationIds) {
      if (conversationId && next.indexOf(conversationId) < 0) {
        next.push(conversationId);
      }
    }
    if (next.length === current.length) {
      return;
    }
    saveStoredStringArray(UNREAD_KEY, next);
    void syncUnreadWithWorker(next);
  }

  function markConversationRead(conversationId) {
    const current = loadUnreadConversationIds();
    if (current.indexOf(conversationId) < 0) {
      return;
    }
    const next = current.filter(function (item) {
      return item !== conversationId;
    });
    saveStoredStringArray(UNREAD_KEY, next);
    void syncUnreadWithWorker(next);
  }

  function loadViewedAt() {
    try {
      const parsed = JSON.parse(localStorage.getItem(VIEWED_AT_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Records that the chat was looked at now, on this phone's clock: Activity
   *  compares it with when rows reached this phone, never with a desktop
   *  stamp, so a desktop clock running ahead cannot mark news as seen. Every
   *  render of the open chat lands here, so the answer the User just watched
   *  finish is always behind the mark. */
  function markConversationViewed(conversationId, newestReceivedAt, viewedAt) {
    if (!conversationId) return;
    const all = loadViewedAt();
    const stored = Date.parse(all[conversationId] || "");
    const newest = Date.parse(newestReceivedAt || "");
    // A mark already past the newest row this phone holds for the chat says
    // all it needs to; rewriting it on every redraw of a streaming chat made
    // Activity rebuild its lists on each one.
    if (Number.isFinite(stored) && (!Number.isFinite(newest) || stored >= newest)) return;
    // Now, unless the look happened earlier (a chat opened and left before
    // its page came): never moved back.
    const next = viewedAt || nowIso();
    if (Number.isFinite(stored) && stored >= Date.parse(next)) return;
    all[conversationId] = next;
    try {
      localStorage.setItem(VIEWED_AT_KEY, JSON.stringify(all));
    } catch {
      // Losing this only makes an update look unseen a little longer.
    }
  }

  // The number on the icon is the number of chats with something new, the
  // same thing the dots in the list add up to. The IndexedDB copy is what a
  // push-woken service worker adds to and shows while the page is closed.
  async function syncUnreadWithWorker(ids) {
    await writeMetaRecord(UNREAD_META_KEY, { ids: ids }).catch(function () { return undefined; });
    applyAppBadge(ids.length);
  }

  function applyAppBadge(count) {
    if (!("setAppBadge" in navigator)) {
      return;
    }
    const apply = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
    Promise.resolve(apply).catch(function () { return undefined; });
  }

  // The worker cannot read localStorage, and the chat list lives there; the
  // titles it needs for a notification are mirrored, nothing else.
  async function mirrorChatTitlesForWorker(chats) {
    const titles = {};
    for (const chat of chats) {
      titles[chat.id] = chat.title;
    }
    await writeMetaRecord(CHAT_TITLES_META_KEY, { titles: titles }).catch(function () { return undefined; });
  }

  // Reconciles the unread set with what a push-woken worker added while the
  // page was closed, then puts the icon number back in step.
  async function adoptWorkerUnread() {
    const record = await readMetaRecord(UNREAD_META_KEY).catch(function () { return undefined; });
    const workerIds = record && Array.isArray(record.ids) ? record.ids.filter(function (id) {
      return typeof id === "string" && id.trim();
    }) : [];
    // The chat on screen is being read only while the page is visible; a
    // push counted for it behind a locked screen is still news.
    const activeId = selectedConversationId();
    const viewingActive = Boolean(activeId) && !document.hidden;
    const merged = loadUnreadConversationIds();
    for (const id of workerIds) {
      if (merged.indexOf(id) < 0 && !(viewingActive && id === activeId)) {
        merged.push(id);
      }
    }
    saveStoredStringArray(UNREAD_KEY, merged);
    await syncUnreadWithWorker(merged);
  }

  function loadTimelinePages() {
    try {
      const raw = localStorage.getItem(TIMELINE_PAGES_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function timelinePageFor(conversationId) {
    const page = loadTimelinePages()[conversationId];
    return page && typeof page === "object" ? page : undefined;
  }

  // Where "earlier" continues from. An answer to a request for the page before
  // a message always moves it back. The latest page — asked on every open,
  // every pull and every return to the foreground — must not move it forward
  // past history this phone already holds: each of those reset it to the page
  // below the latest one, so the next taps re-fetched rows already on screen
  // and showed nothing.
  async function adoptTimelinePage(conversationId, payload) {
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

  function saveTimelinePage(conversationId, page) {
    const pages = loadTimelinePages();
    pages[conversationId] = {
      hasMoreBefore: page.hasMoreBefore === true,
      beforeMessageId: typeof page.beforeMessageId === "string" && page.beforeMessageId.trim()
        ? page.beforeMessageId
        : undefined
    };
    localStorage.setItem(TIMELINE_PAGES_KEY, JSON.stringify(pages));
  }

  function normalizeMobileMember(value) {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const handle = typeof value.handle === "string" ? value.handle.trim().replace(/^@/, "") : "";
    if (!handle) {
      return undefined;
    }
    return {
      id: typeof value.id === "string" && value.id.trim() ? value.id : handle,
      handle,
      mentionHandle: typeof value.mentionHandle === "string" && value.mentionHandle.trim()
        ? value.mentionHandle.trim().replace(/^@/, "")
        : handle,
      displayName: typeof value.displayName === "string" && value.displayName.trim()
        ? value.displayName.trim()
        : "@" + handle,
      roleLabel: typeof value.roleLabel === "string" ? value.roleLabel.trim() : "",
      kind: typeof value.kind === "string" ? value.kind : "",
      avatarId: typeof value.avatarId === "string" ? value.avatarId : undefined,
      isAssistant: value.isAssistant === true,
      // Where this member actually runs, and what that machine needs to run
      // it. Present only for members that live on a machine.
      homeMachineId: typeof value.homeMachineId === "string" ? value.homeMachineId : undefined,
      homeMachineName: typeof value.homeMachineName === "string" && value.homeMachineName.trim()
        ? value.homeMachineName.trim()
        : undefined,
      participant: value.participant && typeof value.participant === "object" ? value.participant : undefined
    };
  }

  function activeMentionQuery(value) {
    const match = String(value || "").match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
    return match ? match[1] : undefined;
  }

  function mentionOptions(value, members) {
    const query = activeMentionQuery(value);
    if (query === undefined) {
      return [];
    }
    const normalizedQuery = query.toLowerCase();
    return (Array.isArray(members) ? members : []).filter(function (member) {
      return member.handle.toLowerCase().includes(normalizedQuery) ||
        member.displayName.toLowerCase().includes(normalizedQuery);
    });
  }

  function replaceActiveMention(value, handle) {
    const source = String(value || "");
    const match = source.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
    if (!match || match.index === undefined) {
      return source + (source.endsWith(" ") || !source ? "" : " ") + "@" + handle + " ";
    }
    const prefix = source.slice(0, match.index);
    const leadingSpace = match[0].startsWith(" ") ? " " : "";
    return prefix + leadingSpace + "@" + handle + " ";
  }

  function mentionShortcutEdit(value, selectionStart, selectionEnd) {
    const source = String(value || "");
    const rawStart = Number.isFinite(selectionStart) ? selectionStart : source.length;
    const rawEnd = Number.isFinite(selectionEnd) ? selectionEnd : rawStart;
    const start = Math.max(0, Math.min(source.length, Math.min(rawStart, rawEnd)));
    const end = Math.max(start, Math.min(source.length, Math.max(rawStart, rawEnd)));
    const before = source.slice(0, start);
    const trigger = before && !/\s$/.test(before) ? " @" : "@";
    return {
      value: before + trigger + source.slice(end),
      caret: before.length + trigger.length
    };
  }

  function replaceMentionAtCaret(value, handle, caret) {
    const source = String(value || "");
    const position = Number.isFinite(caret)
      ? Math.max(0, Math.min(source.length, caret))
      : source.length;
    const replacedBefore = replaceActiveMention(source.slice(0, position), handle);
    const after = source.slice(position);
    const suffix = replacedBefore.endsWith(" ") && after.startsWith(" ")
      ? after.slice(1)
      : after;
    return {
      value: replacedBefore + suffix,
      caret: replacedBefore.length
    };
  }

  function selectedConversationMembers() {
    return conversationMembers(selectedConversationId());
  }

  function conversationMembers(conversationId) {
    const chat = loadChats().find(function (item) {
      return item.id === conversationId;
    });
    return chat ? chatMembers(chat) : [];
  }

  function chatMembers(chat) {
    if (Array.isArray(chat.members) && chat.members.length > 0) {
      return chat.members;
    }
    return (chat.participants || []).map(function (handle) {
      return normalizeMobileMember({ handle });
    }).filter(Boolean);
  }

  /** How this phone is paired: with the User's server, or not at all. A
   *  pairing made the old way (through the desktop's relay) is not one: it is
   *  cleared at launch (see clearOldPairing). */
  function loadPairing() {
    const hub = loadHubPairing();
    return hub ? hubPairingAsPairing(hub) : undefined;
  }

  // Once a pairing code is read from the address, it leaves the address bar:
  // a URL surviving in history, screenshots or share sheets must not be able
  // to pair anyone else. Non-credential params (the qa debug flag) survive,
  // and the app never re-reads credentials from location after boot. A link
  // made the old way carried its credentials in these too, and is scrubbed
  // the same way though it pairs nothing.
  const CREDENTIAL_URL_PARAMS = ["pair", "rid", "rendezvousId", "route", "routingId", "cap", "fingerprint", "relay", "endpoint", "mailbox", "mailboxUrl", "outbox", "outboxUrl", "conversationId", "relaySealKey"];

  function scrubCredentialsFromLocation() {
    try {
      const history = globalThis.history;
      const locationValue = globalThis.location;
      if (!history || !history.replaceState || !locationValue) {
        return;
      }
      const url = new URL(locationValue.href);
      let dirty = Boolean(url.hash);
      url.hash = "";
      for (const param of CREDENTIAL_URL_PARAMS) {
        if (url.searchParams.has(param)) {
          url.searchParams.delete(param);
          dirty = true;
        }
      }
      if (!dirty) {
        return;
      }
      const query = url.searchParams.toString();
      history.replaceState(null, "", url.pathname + (query ? "?" + query : ""));
    } catch {
      // Scrubbing is hygiene; failing must never break pairing itself.
    }
  }

  /** Starts pairing with the User's server when the address carries the code
   *  the desktop shows; true when it did. */
  function readBootstrapFromLocation(locationValue) {
    const url = new URL(locationValue.href);
    // The code for the User's server: paired with it now, in the background
    // of the first screen; the address bar keeps none of it.
    const invite = readHubInvite(url);
    if (invite) {
      scrubCredentialsFromLocation();
      void pairWithServer(invite);
      return true;
    }
    if (url.hash || CREDENTIAL_URL_PARAMS.some(function (param) { return url.searchParams.has(param); })) {
      scrubCredentialsFromLocation();
    }
    return false;
  }

  /**
   * A pairing made the old way, through the desktop's relay, is not used for
   * anything: what it kept on this phone (its key, its mailbox's cursor and
   * mirrored access, its queue in the relay's form, the machine journal) is
   * cleared. A phone that has no server pairing yet says once, plainly, that
   * it has to be paired again; the note stays until it is.
   */
  function clearOldPairing() {
    let held = false;
    try {
      held = localStorage.getItem(OLD_PAIRING_KEY) !== null;
      if (!held) return Promise.resolve(false);
      // Said at once (the phone cannot use the old pairing either way); the
      // key itself goes only once what it kept is cleared, so a launch that
      // could not clear it tries again at the next one.
      if (!loadHubPairing()) localStorage.setItem(OLD_PAIRING_CLEARED_KEY, "1");
    } catch {
      return Promise.resolve(held);
    }
    let dropped = 0;
    return eventLogPort().runAtomic(OLD_PAIRING_STORES.concat([META_STORE, OUTBOX_STORE]), function (tx) {
      return Promise.all(OLD_PAIRING_STORES.map(function (name) { return tx.clear(name); }))
        .then(function () { return Promise.all(OLD_PAIRING_META_KEYS.map(function (key) { return tx.remove(META_STORE, key); })); })
        .then(function () {
          return tx.removeWhere(META_STORE, function (record) {
            const key = record && typeof record.key === "string" ? record.key : "";
            return OLD_PAIRING_META_PREFIXES.some(function (prefix) { return key.indexOf(prefix) === 0; });
          });
        })
        // What the old pairing never sent goes with it: it was addressed to
        // the desktop through the relay, and nothing reads it any more.
        .then(function () { return tx.removeWhere(OUTBOX_STORE, function (entry) { const old = !entry || entry.hub !== true; if (old) dropped += 1; return old; }); });
    }).then(function () {
      try {
        localStorage.removeItem(OLD_PAIRING_KEY);
        localStorage.removeItem(OLD_MAILBOX_CURSOR_KEY);
      } catch {
        // Tried again at the next launch.
      }
      recordRelayDebug({ event: "old-pairing-cleared", hubPaired: Boolean(loadHubPairing()), droppedUnsent: dropped });
      return true;
    }, function (error) {
      recordRelayDebug({ event: "old-pairing-clear-failed", message: String(error && error.message || error) });
      return true;
    });
  }

  function oldPairingCleared() {
    try {
      return localStorage.getItem(OLD_PAIRING_CLEARED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function activeConversationId(inputConversationId) {
    return inputConversationId ||
      localStorage.getItem(ACTIVE_CONVERSATION_KEY) ||
      loadPairing()?.conversationId ||
      "unpaired";
  }

  function selectedConversationId() {
    const active = localStorage.getItem(ACTIVE_CONVERSATION_KEY) || loadPairing()?.conversationId;
    return active && active !== "unpaired" ? active : undefined;
  }

  /** A queue entry for something this phone did. Every entry is for the
   *  User's server: it is signed, in its place in this phone's chain, when it
   *  is first sent (mintHubEntry). */
  async function createOutboxEvent(input) {
    return hubOutboxEntry(input);
  }

  // Pictures chosen on the phone, waiting for the next send. Same limits the
  // desktop composer enforces, checked here so the refusal is visible where the
  // picture was chosen rather than deep in the relay.
  const MOBILE_UPLOAD_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const MOBILE_UPLOAD_MAX_IMAGES = 5;
  const MOBILE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
  const MOBILE_UPLOAD_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
  // The models downscale anything above this before looking, so sending more
  // costs the same tokens and only burns relay bandwidth and phone storage.
  const MOBILE_UPLOAD_MAX_EDGE = 2576;
  // A guard on what we are willing to decode at all, before any resizing. A
  // compressed byte count is a poor proxy for decoded memory — a 12 MB JPEG can
  // still be tens of megapixels — so this is deliberately conservative.
  const MOBILE_UPLOAD_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
  let pendingAttachments = [];

  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onerror = function () {
        reject(new Error("read-failed"));
      };
      reader.onload = function () {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : "");
      };
      reader.readAsDataURL(file);
    });
  }

  // JPEG is lossy and has no transparency, so only a JPEG stays a JPEG. PNG and
  // WebP both become PNG: lossless, alpha preserved, and encodable on every
  // engine that runs this app.
  function preparedImageMimeType(sourceMimeType) {
    return sourceMimeType === "image/jpeg" ? "image/jpeg" : "image/png";
  }

  function preparedImageFilename(filename, mimeType) {
    const base = String(filename || "image").replace(/\.[A-Za-z0-9]+$/, "");
    return base + (mimeType === "image/jpeg" ? ".jpg" : ".png");
  }

  async function decodeOrientedImage(file) {
    // createImageBitmap with imageOrientation is the direct route, but it is not
    // everywhere: older WebKit either lacks the function or ignores the option.
    // Falling through to an <img>, which honours EXIF on its own, keeps a phone
    // that cannot do the first route from losing the picture entirely.
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        // fall through
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      if (typeof image.decode === "function") {
        await image.decode();
      } else {
        await new Promise(function (resolve, reject) {
          image.onload = resolve;
          image.onerror = reject;
        });
      }
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function preparePickedImage(file) {
    // Orientation is baked into the pixels here. Models do not read image
    // metadata at all, so a photo taken sideways reaches them sideways — which
    // is exactly what happened to the first picture sent from the phone.
    const source = await decodeOrientedImage(file);
    try {
      const sourceWidth = source.width || source.naturalWidth;
      const sourceHeight = source.height || source.naturalHeight;
      if (!sourceWidth || !sourceHeight) {
        throw new Error("decode-failed");
      }
      const scale = Math.min(1, MOBILE_UPLOAD_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(source, 0, 0, width, height);
      const mimeType = preparedImageMimeType(file.type);
      const blob = await new Promise(function (resolve) {
        canvas.toBlob(resolve, mimeType, 0.9);
      });
      if (!blob) {
        throw new Error("encode-failed");
      }
      return {
        mimeType,
        filename: preparedImageFilename(file.name, mimeType),
        dataBase64: await readFileAsBase64(blob),
        width,
        height
      };
    } finally {
      if (source && typeof source.close === "function") {
        source.close();
      }
    }
  }

  async function addPendingAttachments(files) {
    const rejected = [];
    for (const file of Array.from(files || [])) {
      if (pendingAttachments.length >= MOBILE_UPLOAD_MAX_IMAGES) {
        rejected.push(file.name + " — too many pictures");
        continue;
      }
      if (MOBILE_UPLOAD_MIME_TYPES.indexOf(file.type) < 0) {
        rejected.push(file.name + " — not a PNG, JPEG or WebP");
        continue;
      }
      if (file.size > MOBILE_UPLOAD_MAX_SOURCE_BYTES) {
        rejected.push(file.name + " — too large to open");
        continue;
      }
      try {
        // Resize first: the limits below apply to what actually travels, so a
        // 12 MP photo is accepted rather than refused for a size it will not
        // have by the time it is sent.
        const prepared = await preparePickedImage(file);
        const bytes = Math.floor((prepared.dataBase64.length * 3) / 4);
        if (!prepared.dataBase64 || bytes <= 0) {
          rejected.push(file.name + " — could not be read");
          continue;
        }
        if (bytes > MOBILE_UPLOAD_MAX_BYTES) {
          rejected.push(file.name + " — larger than 4 MB");
          continue;
        }
        // Five 4 MB pictures would be a 27 MB base64 payload in IndexedDB and
        // one relay frame. The batch is bounded as well as each picture.
        const pendingBytes = pendingAttachments.reduce(function (total, item) {
          return total + Math.floor((item.dataBase64.length * 3) / 4);
        }, 0);
        if (pendingBytes + bytes > MOBILE_UPLOAD_MAX_TOTAL_BYTES) {
          rejected.push(file.name + " — over the 8 MB total");
          continue;
        }
        pendingAttachments.push({
          id: createEventId(),
          filename: prepared.filename,
          mimeType: prepared.mimeType,
          dataBase64: prepared.dataBase64
        });
      } catch {
        rejected.push(file.name + " — could not be read");
      }
    }
    return rejected;
  }

  function renderPendingAttachments() {
    const strip = document.getElementById("composer-attachments");
    if (!strip) {
      return;
    }
    strip.textContent = "";
    // A picture waiting to be sent keeps the composer open, the same as text.
    // Folding waits for the tap in progress: a send takes the pictures while
    // the finger is still on Send.
    if (pendingAttachments.length > 0) {
      updateComposerShape();
    } else {
      afterTapLands(updateComposerShape);
    }
    if (pendingAttachments.length === 0) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    for (const attachment of pendingAttachments) {
      const chip = document.createElement("div");
      chip.className = "composer-attachment-chip";
      const thumb = document.createElement("img");
      thumb.className = "composer-attachment-thumb";
      thumb.alt = attachment.filename;
      thumb.src = "data:" + attachment.mimeType + ";base64," + attachment.dataBase64;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "composer-attachment-remove";
      remove.setAttribute("aria-label", "Remove " + attachment.filename);
      remove.textContent = "×";
      remove.addEventListener("click", function () {
        pendingAttachments = pendingAttachments.filter(function (item) {
          return item.id !== attachment.id;
        });
        renderPendingAttachments();
      });
      chip.append(thumb, remove);
      strip.append(chip);
    }
  }

  function takePendingAttachments() {
    const taken = pendingAttachments.map(function (attachment) {
      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        dataBase64: attachment.dataBase64
      };
    });
    pendingAttachments = [];
    renderPendingAttachments();
    return taken;
  }

  /**
   * Queues what this device did. An entry is its own record: its event is
   * made, signed and kept with it when it is first sent (mintHubEntry), so a
   * failed write here leaves nothing behind that the User did not see fail.
   */
  function persistOutboundEvent(entry) {
    return putOutboxEntry(entry).then(function () { return entry; });
  }

  function enqueueMessage(input) {
    return createOutboxEvent(input).then(persistOutboundEvent);
  }

  function enqueueRunCancel(input) {
    return createOutboxEvent({
      conversationId: input.conversationId,
      kind: "run.cancel.requested",
      payload: { runId: input.runId }
    }).then(persistOutboundEvent);
  }

  function isMessageOutboxEntry(entry) {
    return !entry.kind || entry.kind === "message.created";
  }

  /** Whether a queue entry is still the server's to take: not acknowledged,
   *  not replaced by a later answer to the same card, and not refused for
   *  good. */
  function desktopOwesEntry(entry) {
    return Boolean(entry) && entry.status !== "acked" && entry.status !== "superseded" &&
      entry.status !== "refused";
  }

  /** Runs the User has asked to stop, from the tap onward. The queue entry is
   *  written asynchronously, and a render in that gap used to put the Stop
   *  control back as if nothing had been asked -- which is both a lie and a
   *  second Stop the User can send by accident. */
  const stopRequestedRunIds = new Set();

  async function stopRunFromPhone(runId, forConversationId) {
    // Activity stops a run in a chat that is not open, so it names the chat.
    const conversationId = forConversationId || selectedConversationId();
    if (!conversationId || typeof runId !== "string" || !runId.trim()) {
      return;
    }
    stopRequestedRunIds.add(runId.trim());
    await render("waiting-to-sync");
    await enqueueRunCancel({ conversationId, runId: runId.trim() });
    // A stop goes where every other write goes, at once; the member's home
    // stops it when it reads it, and the row keeps saying "Stopping" until
    // it has.
    const flushing = flushOutbox();
    await handOverBeforeDrawing(flushing);
    await render("waiting-to-sync");
    const flushResult = await flushing;
    await render(flushResult.status);
  }

  /** Whether this phone can read and write at all: only through the User's
   *  server, once paired with it. */
  function canSync(pairing) {
    return isHubPairing(pairing);
  }

  // --- pairing with the User's own server ----------------------------------
  // The phone pairs with her server itself: the desktop shows a code (the
  // server's address, a one-time token, the server's id), the phone makes a
  // key of its own and enrolls it, and from then on every read and every
  // write is a request signed with that key, straight to the server. No
  // desktop has to be awake, and the phone never addresses one.

  const HUB_PAIRING_KEY = "accordagents.mobile.hub.v1";
  const HUB_IDENTITY_META_KEY = "hub-identity";
  const HUB_PENDING_IDENTITY_META_KEY = "hub-identity-pending";
  const HUB_PAIRING_META_KEY = "hub-pairing";
  /** The key the server said it no longer knows (the phone was removed). */
  const HUB_REVOKED_IDENTITY_META_KEY = "hub-identity-revoked";
  const HUB_HEAD_META_PREFIX = "hubHead:";
  const HUB_CLOCK_META_KEY = "hubClock";
  const HUB_PHONE_PROTOCOL = 2;
  /** A sent event is kept this long, so a server that lost it (restored
   *  from an older copy) can be given it again. */
  const HUB_SENT_KEEP_MS = 7 * 24 * 60 * 60_000;
  /** A payload over this travels as a body the server holds (as every
   *  device does it), not inside its event. */
  const HUB_INLINE_PAYLOAD_BYTES = 32 * 1024;
  const HUB_PUSH_PAGE = 50;
  // Where pairing with the server stands, for the screen: "pairing",
  // "outdated" (the Mac or its server is older), "failed", "revoked".
  let hubPairingState;
  let hubClientCache;

  function loadHubPairing() {
    try {
      const raw = localStorage.getItem(HUB_PAIRING_KEY);
      const parsed = raw ? JSON.parse(raw) : undefined;
      return parsed && typeof parsed.hubUrl === "string" && typeof parsed.deviceId === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  function isHubPairing(pairing) {
    return Boolean(pairing && pairing.hub === true && pairing.hubUrl);
  }

  /** The hub pairing in the shape the rest of the app reads a pairing in. */
  function hubPairingAsPairing(hub) {
    return {
      hub: true,
      hubUrl: hub.hubUrl,
      hubId: hub.hubId,
      deviceId: hub.deviceId,
      ...(hub.scope && hub.scope.scope === "conversation" ? { conversationId: hub.scope.conversationId } : {}),
      pairedAt: hub.pairedAt
    };
  }

  // The phone's key, read once: every event it mints and every request it
  // signs asks for it, and each read was its own database open on the way
  // to the server. Replaced when the phone pairs (or another tab does).
  let hubIdentityCache;
  // Bumped whenever the key may have changed: a read that started before
  // does not put the old key back.
  let hubIdentityGeneration = 0;

  function forgetHubIdentity() {
    hubIdentityGeneration += 1;
    hubIdentityCache = undefined;
  }

  function hubIdentity() {
    if (hubIdentityCache) return Promise.resolve(hubIdentityCache);
    const generation = hubIdentityGeneration;
    return readMetaRecord(HUB_IDENTITY_META_KEY).then(function (identity) {
      if (!identity || !identity.deviceId || !identity.privateKeyDerBase64) throw new Error("This phone has lost its pairing key. Pair it again.");
      if (generation === hubIdentityGeneration) hubIdentityCache = identity;
      return identity;
    });
  }

  function hubClient() {
    const pairing = loadHubPairing();
    const api = globalThis.AccordHubClient;
    if (!pairing || !api) return undefined;
    if (!hubClientCache || hubClientCache.hubUrl !== pairing.hubUrl) {
      hubClientCache = { hubUrl: pairing.hubUrl, client: api.createHubDeviceClient({ hubUrl: pairing.hubUrl, identity: hubIdentity }) };
    }
    return hubClientCache.client;
  }

  /** The code the desktop shows, from the link it opened: `#hub=…&t=…&id=…`. */
  function readHubInvite(url) {
    const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const hubUrl = fragment.get("hub");
    const token = fragment.get("t");
    const hubId = fragment.get("id");
    if (!hubUrl || !token || !hubId) return undefined;
    try {
      const parsed = new URL(hubUrl);
      const local = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
      if (parsed.protocol !== "https:" && !local) return undefined;
    } catch {
      return undefined;
    }
    return { hubUrl: hubUrl.replace(/\/+$/, ""), token: token, hubId: hubId };
  }

  function phoneName() {
    const agent = String(globalThis.navigator && navigator.userAgent || "");
    if (/iPhone/.test(agent)) return "iPhone";
    if (/iPad/.test(agent)) return "iPad";
    if (/Android/.test(agent)) return "Android phone";
    return "Phone";
  }

  function hubPairingFailure(error) {
    const status = error && typeof error.status === "number" ? error.status : 0;
    if (status === 410) return { status: "failed", message: "This pairing code was already used or has expired. Make a new one on your Mac (Settings → Device Pairing)." };
    if (status === 404 || status === 405) return { status: "outdated", message: "Update AccordAgents on your Mac, then pair this phone again." };
    if (error && error.unreachable) return { status: "failed", message: "Could not reach your server. Check the phone's connection and scan the code again." };
    if (status === 400 || status === 429) {
      // The server says what was wrong (a clock that is off, too many tries).
      let said = "";
      try { said = String(JSON.parse(error.body || "{}").error || ""); } catch { said = ""; }
      if (said) return { status: "failed", message: said };
    }
    return { status: "failed", message: "Pairing did not work: " + String(error && error.message || error) };
  }

  /**
   * Pairs this phone with the User's server from the code the desktop shows.
   * The key is made (and kept) before it is offered, so a lost answer is
   * asked again with the same key and the same code; the server answers the
   * same phone again rather than refusing it.
   */
  async function pairWithServer(invite) {
    const api = globalThis.AccordHubClient;
    if (!api) {
      hubPairingState = { status: "failed", message: "This copy of the app cannot pair yet. Reload it and scan the code again." };
      await render();
      return false;
    }
    hubPairingState = { status: "pairing" };
    await render();
    try {
      const probe = api.createHubDeviceClient({ hubUrl: invite.hubUrl, identity: function () { return Promise.reject(new Error("not paired")); } });
      const health = await probe.health();
      if (!health || !(Number(health.protocol) >= HUB_PHONE_PROTOCOL)) {
        hubPairingState = { status: "outdated", message: "Update AccordAgents on your Mac, then pair this phone again." };
        await render();
        return false;
      }
      if (health.hubId !== invite.hubId) {
        hubPairingState = { status: "failed", message: "This code is for another server. Make a new one on your Mac." };
        await render();
        return false;
      }
      const tokenHash = await sha256Hex(invite.token);
      const pending = await readMetaRecord(HUB_PENDING_IDENTITY_META_KEY);
      // A phone paired with this server before keeps its key: paired again,
      // it replaces its own entry on the Mac and the server instead of
      // standing beside it as a second phone.
      const previous = await readMetaRecord(HUB_IDENTITY_META_KEY);
      const previousPairing = await readMetaRecord(HUB_PAIRING_META_KEY);
      const revoked = await readMetaRecord(HUB_REVOKED_IDENTITY_META_KEY);
      const sameServer = Boolean(previous && previous.deviceId && previous.privateKeyDerBase64 && previousPairing &&
        previousPairing.hubId === invite.hubId && previousPairing.deviceId === previous.deviceId &&
        !(revoked && revoked.deviceId && revoked.deviceId === previous.deviceId));
      const identity = pending && pending.tokenHash === tokenHash && pending.identity ? pending.identity
        : sameServer ? previous : await api.createHubDeviceIdentity();
      await writeMetaRecord(HUB_PENDING_IDENTITY_META_KEY, { tokenHash: tokenHash, identity: identity });
      const answer = await api.enrollHubPhone({ hubUrl: invite.hubUrl, hubId: invite.hubId, token: invite.token, identity: identity, name: phoneName() });
      const before = await readMetaRecord(HUB_IDENTITY_META_KEY);
      // The key the server now knows this phone by, before the pairing that
      // names it: a pairing without its key could never sign again.
      await writeMetaRecord(HUB_IDENTITY_META_KEY, identity);
      forgetHubIdentity();
      // A new key starts its own chains; where the old one's stood means
      // nothing to the server for it.
      if (!before || before.deviceId !== identity.deviceId) await forgetHubHeads();
      const pairing = { hubUrl: invite.hubUrl, hubId: invite.hubId, deviceId: identity.deviceId, scope: answer.scope, pairedAt: nowIso(), protocol: answer.protocol };
      setStoredValue(HUB_PAIRING_KEY, JSON.stringify(pairing));
      // Paired again: the note that the old pairing was cleared has done its work.
      localStorage.removeItem(OLD_PAIRING_CLEARED_KEY);
      if (revoked && revoked.deviceId) await writeMetaRecord(HUB_REVOKED_IDENTITY_META_KEY, { deviceId: "" }).catch(function () {});
      hubClientCache = undefined;
      // The worker reads these to fetch what a push is about.
      await writeMetaRecord(HUB_PAIRING_META_KEY, { hubUrl: invite.hubUrl, hubId: invite.hubId, deviceId: identity.deviceId });
      if (answer.scope && answer.scope.scope === "conversation") {
        localStorage.setItem(ACTIVE_CONVERSATION_KEY, answer.scope.conversationId);
      }
      // The certificate is the first thing this phone writes: every device
      // that reads the server learns from it that this phone is the User's.
      await putOutboxEntry(await hubOutboxEntry({ kind: "device.enrolled", conversationId: "device-enrollment", payload: answer.certificate }));
      hubPairingState = undefined;
      recordRelayDebug({ event: "hub-paired", deviceId: identity.deviceId });
      await render();
      // From here on the phone works as it does after a launch: what it owes
      // goes out, the chats come in, live progress and alerts start.
      await initHubSession(loadPairing());
      return true;
    } catch (error) {
      hubPairingState = hubPairingFailure(error);
      recordRelayDebug({ event: "hub-pairing-failed", message: String(error && error.message || error) });
      await render();
      return false;
    }
  }

  /** The log scope and event kind an outbox entry becomes on the server. */
  function hubEventShape(entry) {
    if (entry.kind === "device.enrolled") return { logScopeId: "device-enrollment", kind: "device.enrolled" };
    if (entry.kind === "run.cancel.requested") return { logScopeId: "chat:actions", kind: "turn.stop.requested" };
    if (entry.kind === "permission.decided" || entry.kind === "choice.answered") return { logScopeId: "chat:actions", kind: entry.kind };
    return { logScopeId: "chat-changes:" + entry.conversationId, kind: "chat.changes" };
  }

  async function hubOutboxEntry(input) {
    const eventId = input.eventId || createEventId();
    const createdAt = input.createdAt || nowIso();
    const kind = input.kind || "message.created";
    const conversationId = activeConversationId(input.conversationId);
    const payload = input.payload || {
      content: input.content,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    };
    const shape = hubEventShape({ kind: kind, conversationId: conversationId });
    return {
      eventId: eventId,
      conversationId: conversationId,
      logScopeId: shape.logScopeId,
      kind: kind,
      payload: payload,
      createdAt: createdAt,
      status: "queued",
      attempts: 0,
      updatedAt: createdAt,
      hub: true,
      // Who the message is for, decided now, from what this phone showed the
      // User when she sent it — the same rules the desktop applies to what is
      // typed there.
      ...(kind === "message.created" ? { hubDelivery: await resolvePhoneDelivery(conversationId, payload) } : {})
    };
  }

  /** The members a draft is for, by the desktop's own rules (bundled from
   *  src/shared/chatDeliveryPolicy.ts), over the chat as this phone holds it. */
  async function resolvePhoneDelivery(conversationId, payload) {
    const shared = mobileSharedRules();
    const chat = loadChats().find(function (item) { return item.id === conversationId; });
    const members = chat && Array.isArray(chat.members) ? chat.members : [];
    if (!shared || typeof shared.resolveChatDeliveryTargets !== "function") return { targets: [], unknownHandles: [], resolved: false };
    const participants = members.map(function (member) {
      return {
        id: member.id,
        handle: member.handle,
        roleConfigId: member.roleConfigId || (member.isAssistant ? "administrator" : "generic-participant"),
        kind: member.kind,
        ...(member.homeMachineId ? { homeMachineId: member.homeMachineId } : {})
      };
    });
    const rows = await listTimelineEntries(conversationId).catch(function () { return []; });
    const messages = rows.map(function (row) {
      return {
        id: row.messageId || row.sourceId || row.id,
        role: row.role === "you" ? "user" : row.role,
        content: row.content || "",
        createdAt: row.createdAt,
        ...(row.participantId ? { participantId: row.participantId } : {}),
        metadata: {
          ...(row.threadId ? { threadId: row.threadId } : {}),
          ...(row.threadRootId ? { chatThreadRootId: row.threadRootId } : {})
        }
      };
    });
    const threadRootId = payload && typeof payload.threadRootId === "string" ? payload.threadRootId : undefined;
    const result = shared.resolveChatDeliveryTargets({
      conversation: { id: conversationId, messages: messages, metadata: { participants: participants } },
      participants: participants,
      content: String(payload && payload.content || ""),
      context: threadRootId ? { chatThreadRootId: threadRootId } : {},
      options: shared.CHAT_DELIVERY_POLICY_OPTIONS
    });
    return {
      targets: result.targets.map(function (participant) { return participant.id; }),
      unknownHandles: result.unknownHandles,
      resolved: true
    };
  }

  function imageExtension(mimeType) {
    return mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  }

  /** The chat change a message from this phone is: the User's message, and
   *  the line the desktop adds for a name that is no member. */
  async function hubMessagePayload(entry, client) {
    const payload = entry.payload || {};
    const content = typeof payload.content === "string" ? payload.content : "";
    const messageId = entry.eventId;
    const delivery = entry.hubDelivery || { targets: [], unknownHandles: [] };
    const threadRootId = typeof payload.threadRootId === "string" && payload.threadRootId ? payload.threadRootId : undefined;
    const imageAttachments = [];
    for (const attachment of Array.isArray(payload.attachments) ? payload.attachments : []) {
      const bytes = base64ToBytesStd(attachment.dataBase64);
      const id = createEventId();
      const reference = await client.uploadBlob(bytes);
      imageAttachments.push({
        id: id,
        filename: attachment.filename || ("photo." + imageExtension(attachment.mimeType)),
        mimeType: attachment.mimeType,
        sizeBytes: bytes.length,
        width: Number(attachment.width) || 0,
        height: Number(attachment.height) || 0,
        storageKey: "attachments/" + id + "." + imageExtension(attachment.mimeType),
        createdAt: entry.createdAt,
        hubBlob: reference
      });
    }
    const shared = mobileSharedRules();
    let nativeCommand;
    if (shared && typeof shared.parseNativeGoalCommand === "function") {
      const goal = shared.parseNativeGoalCommand(content);
      if (goal.kind === "valid" && delivery.targets.length === 1) {
        const member = (loadChats().find(function (chat) { return chat.id === entry.conversationId; }) || {}).members || [];
        const target = member.find(function (item) { return item.id === delivery.targets[0]; });
        nativeCommand = { name: "goal", objective: shared.nativeGoalObjective(goal.contentWithoutCommand, target ? target.handle : "") };
      }
    }
    const message = {
      id: messageId,
      role: "user",
      content: content,
      createdAt: entry.createdAt,
      status: "done",
      metadata: {
        appMessageSource: "mobile-relay",
        mobileEventId: entry.eventId,
        threadId: messageId,
        ...(threadRootId ? { chatThreadRootId: threadRootId } : {}),
        deliveryTargets: delivery.targets,
        ...(Array.isArray(payload.skillMentions) && payload.skillMentions.length ? { skillMentions: payload.skillMentions } : {}),
        ...(imageAttachments.length ? { imageAttachments: imageAttachments } : {}),
        ...(nativeCommand ? { nativeCommand: nativeCommand } : {})
      }
    };
    const changes = [{ type: "message.created", message: message }];
    for (const handle of delivery.unknownHandles || []) {
      changes.push({ type: "message.created", message: {
        id: createEventId(), role: "system", content: "No member named @" + handle + ".", createdAt: entry.createdAt, status: "done",
        metadata: { threadId: messageId, parentMessageId: messageId, ...(threadRootId ? { chatThreadRootId: threadRootId } : {}) }
      } });
    }
    return { version: 1, conversationId: entry.conversationId, updatedAt: entry.createdAt, changes: changes };
  }

  function base64ToBytesStd(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  /** What an outbox entry says, as the event the server and every device
   *  apply. A card answer says it was given on the phone. */
  async function hubEventPayload(entry, client) {
    if (entry.kind === "device.enrolled") return entry.payload;
    if (entry.kind === "run.cancel.requested") {
      const runId = String(entry.payload && entry.payload.runId || "");
      return { operationId: "stop:" + runId, targetKey: "run:" + runId, stateId: "stop-requested", detail: { by: "phone", runId: runId } };
    }
    if (entry.kind === "permission.decided" || entry.kind === "choice.answered") {
      const payload = entry.payload || {};
      return { ...payload, detail: { ...(payload.detail || {}), decidedOn: "phone" } };
    }
    return hubMessagePayload(entry, client);
  }

  /** The next stamp of this phone's clock (the desktop's form, hlc:…). */
  async function hubLogicalTs(deviceId) {
    // Read and advanced in one transaction: the stamp is this phone's clock,
    // and two reads and a write for it were three database opens per send.
    return withNamedStore(META_STORE, "readwrite", function (store) {
      return requestToPromise(store.get(HUB_CLOCK_META_KEY)).then(function (found) {
        const record = found || {};
        const now = Date.now();
        let wall = Number(record.wallMs) || 0;
        let counter = Number(record.counter) || 0;
        if (now > wall) {
          wall = now;
          counter = 0;
        } else {
          counter += 1;
        }
        store.put({ ...record, key: HUB_CLOCK_META_KEY, wallMs: wall, counter: counter });
        return "hlc:" + String(wall).padStart(13, "0") + ":" + String(counter).padStart(6, "0") + ":" + deviceId;
      });
    });
  }

  /**
   * Makes an entry's event once, signed, in its place in this phone's chain
   * of that scope, and keeps it with the entry. Sending it again (after a
   * lost answer, after a restart) sends these very bytes: the server takes
   * the same event once.
   */
  async function mintHubEntry(entry) {
    const api = globalThis.AccordHubClient;
    const client = hubClient();
    if (!api || !client) throw new Error("This phone is not paired with a server.");
    const identity = await hubIdentity();
    const shape = hubEventShape(entry);
    let payload = await hubEventPayload(entry, client);
    const json = JSON.stringify(payload);
    if (new TextEncoder().encode(json).length > HUB_INLINE_PAYLOAD_BYTES) {
      const uploading = client.uploadBlob(new TextEncoder().encode(json));
      noteHandOverRequestStarted();
      payload = await uploading;
    }
    const headKey = HUB_HEAD_META_PREFIX + shape.logScopeId;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const head = hubHeadFor(await readMetaRecord(headKey), identity.deviceId);
      const seq = head.seq + 1;
      const event = await api.mintHubEvent(identity, {
        eventId: entry.eventId,
        conversationId: shape.kind === "device.enrolled" ? "device-enrollment" : entry.conversationId,
        logScopeId: shape.logScopeId,
        kind: shape.kind,
        payload: payload,
        originSeq: seq,
        ...(head.hash ? { prevHash: head.hash } : {}),
        logicalTs: await hubLogicalTs(identity.deviceId),
        createdAt: entry.createdAt
      });
      const minted = { ...entry, logScopeId: shape.logScopeId, minted: event, updatedAt: nowIso() };
      // The event and the chain's new head land together, or neither does.
      const taken = await eventLogPort().runAtomic([OUTBOX_STORE, META_STORE], function (tx) {
        return tx.get(META_STORE, headKey).then(function (current) {
          if (hubHeadFor(current, identity.deviceId).seq !== seq - 1) return false;
          return tx.get(OUTBOX_STORE, entry.eventId).then(function (stored) {
            if (stored && stored.minted && stored.minted.originId === identity.deviceId) return false;
            return tx.put(OUTBOX_STORE, minted).then(function () {
              return tx.put(META_STORE, { key: headKey, seq: seq, hash: event.eventHash, deviceId: identity.deviceId });
            }).then(function () { return true; });
          });
        });
      });
      if (taken) {
        noteOutboxStatus(minted);
        return minted;
      }
      const stored = (await listOutboxEntries()).find(function (item) { return item.eventId === entry.eventId; });
      if (stored && stored.minted && stored.minted.originId === identity.deviceId) return stored;
    }
    throw new Error("Could not place this in the phone's queue.");
  }

  function forgetHubHeads() {
    return withNamedStore(META_STORE, "readwrite", function (store) {
      store.delete(IDBKeyRange.bound(HUB_HEAD_META_PREFIX, HUB_HEAD_META_PREFIX + "\uffff"));
    });
  }

  /** Where this phone's chain in a scope stands, for its current identity: a
   *  phone paired again starts its chains afresh (a head without an owner is
   *  from before heads named one, so it is the identity's own). */
  function hubHeadFor(record, deviceId) {
    if (!record || (record.deviceId && record.deviceId !== deviceId)) return { seq: 0, hash: undefined };
    return { seq: Number(record.seq) || 0, hash: record.hash };
  }

  /** The server refused an event (it never will take it): what this phone
   *  minted after it in the same chain is minted again from the event before
   *  it, so one refusal does not hold every later message back. */
  async function rechainAfterRefusal(refused) {
    return rechainFrom(refused, false);
  }

  /** The chain in this entry's scope is minted again from where the entry
   *  stands (`including` it), or after it (it is refused). */
  async function rechainFrom(refused, including) {
    const identity = await hubIdentity();
    const scope = refused.minted && refused.minted.logScopeId;
    if (!scope || refused.minted.originId !== identity.deviceId) return;
    const headKey = HUB_HEAD_META_PREFIX + scope;
    const later = (await listOutboxEntries()).filter(function (item) {
      return item.minted && item.minted.logScopeId === scope && item.minted.originId === identity.deviceId &&
        (including ? item.minted.originSeq >= refused.minted.originSeq : item.minted.originSeq > refused.minted.originSeq) && item.status !== "acked";
    });
    await eventLogPort().runAtomic([OUTBOX_STORE, META_STORE], function (tx) {
      return tx.get(META_STORE, headKey).then(function (current) {
        // Already moved past (another flush did this): nothing to undo.
        if (hubHeadFor(current, identity.deviceId).seq < refused.minted.originSeq) return undefined;
        let chain = Promise.resolve();
        for (const item of later) {
          const { minted: _minted, ...unminted } = item;
          chain = chain.then(function () { return tx.put(OUTBOX_STORE, { ...unminted, status: "waiting-to-sync", updatedAt: nowIso() }); });
        }
        return chain.then(function () {
          return tx.put(META_STORE, { key: headKey, seq: refused.minted.originSeq - 1, hash: refused.minted.prevHash, deviceId: identity.deviceId });
        });
      });
    });
    for (const item of later) noteOutboxStatus({ ...item, status: "waiting-to-sync" });
  }

  // Who waits for this phone's part of the next hand-over to be done.
  let handOverWaiters = [];

  /** Called as the first request of a hand-over is started (the events, or a
   *  body too large to travel inline with them): the queue is written and
   *  the events minted and signed. The request itself is not sent yet — its
   *  own signature and the network still follow, asynchronously. */
  function noteHandOverRequestStarted() {
    const waiters = handOverWaiters;
    handOverWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // The longest a redraw after a send waits for the hand-over to start. The
  // wait is the phone's own work (its queue, the stamp, the signature), tens
  // of milliseconds; this only bounds a store that has stalled.
  const SEND_BEFORE_DRAW_MAX_MS = 1_000;

  /** What the User just did goes to the server before the chat is drawn
   *  again: a redraw reads and checks every row of the chat in one go, and
   *  started first, it held the hand-over back for as long as it took (most
   *  of the time between Send and the server having it). The wait ends when
   *  the first request has been started (see noteHandOverRequestStarted),
   *  when the flush ends without one, or after a second at most: the screen
   *  is never held for the network. */
  function handOverBeforeDrawing(flushing) {
    let timer;
    let waiter;
    const started = new Promise(function (resolve) {
      waiter = resolve;
      handOverWaiters.push(resolve);
      timer = setTimeout(resolve, SEND_BEFORE_DRAW_MAX_MS);
    });
    return Promise.race([started, flushing.then(function () { return undefined; }, function () { return undefined; })])
      .finally(function () {
        clearTimeout(timer);
        handOverWaiters = handOverWaiters.filter(function (item) { return item !== waiter; });
      });
  }

  /**
   * Sends what this phone still owes its server, in the order it was written.
   * Each entry is acknowledged only when the server says it holds it
   * (accepted, or already there); until then it stays queued here and is
   * offered again.
   */
  async function flushOutboxViaHub(entries) {
    const client = hubClient();
    const pending = entries.filter(function (entry) { return entry.hub && desktopOwesEntry(entry); });
    if (!client || pending.length === 0) return { status: client ? "synced" : "unreachable", sent: 0, pending: pending.length };
    let sent = 0;
    const minted = [];
    const identity = await hubIdentity();
    for (const entry of pending) {
      try {
        // An entry minted under an identity this phone no longer pairs with
        // (paired again) is minted again under the current one.
        minted.push(entry.minted && entry.minted.originId === identity.deviceId ? entry : await mintHubEntry(entry));
      } catch (error) {
        await putOutboxEntry({ ...entry, status: "waiting-to-sync", updatedAt: nowIso(), lastError: String(error && error.message || error) });
        return { status: error && error.unreachable ? "unreachable" : "waiting-to-sync", sent: sent, pending: pending.length - sent };
      }
    }
    for (let start = 0; start < minted.length; start += HUB_PUSH_PAGE) {
      const page = minted.slice(start, start + HUB_PUSH_PAGE);
      let response;
      try {
        const pushing = client.pushEvents(page.map(function (entry) { return entry.minted; }));
        noteHandOverRequestStarted();
        response = await pushing;
        response = await repairHubGaps(client, page, response);
      } catch (error) {
        for (const entry of page) await putOutboxEntry({ ...entry, status: "waiting-to-sync", updatedAt: nowIso(), lastError: String(error && error.message || error) });
        return { status: error && error.unreachable ? "unreachable" : "waiting-to-sync", sent: sent, pending: pending.length - sent };
      }
      const results = Array.isArray(response && response.results) ? response.results : [];
      const refused = [];
      for (const [index, entry] of page.entries()) {
        const result = results[index] || {};
        if (result.status === "accepted" || result.status === "duplicate") {
          await putOutboxEntry({ ...entry, status: "acked", ack: { hubSeq: result.hubSeq, ackRole: "server" }, updatedAt: nowIso(), lastError: undefined });
          sent += 1;
        } else if (result.status === "rejected" || result.status === "conflict") {
          await putOutboxEntry({ ...entry, status: "refused", attempts: entry.attempts + 1, updatedAt: nowIso(), lastError: result.error || result.status });
          refused.push(entry);
        } else {
          await putOutboxEntry({ ...entry, status: "waiting-to-sync", attempts: entry.attempts + 1, updatedAt: nowIso(), lastError: result.status || "not taken" });
        }
      }
      // The server has nothing of a chain this phone minted further along
      // (its record of where the chain stood was not this key's): the chain
      // starts again at the beginning, as the server expects.
      const restarts = new Map();
      for (const [index, entry] of page.entries()) {
        const result = results[index] || {};
        if (result.status !== "gap" || Number(result.expectedSeq) !== 1 || !entry.minted || entry.minted.originSeq <= 1) continue;
        const known = restarts.get(entry.minted.logScopeId);
        if (!known || entry.minted.originSeq < known.minted.originSeq) restarts.set(entry.minted.logScopeId, entry);
      }
      for (const entry of restarts.values()) {
        const ours = (await listOutboxEntries()).some(function (item) {
          return item.minted && item.minted.logScopeId === entry.minted.logScopeId && item.minted.originId === entry.minted.originId && item.minted.originSeq === 1;
        });
        if (!ours) await rechainFrom({ ...entry, minted: { ...entry.minted, originSeq: 1, prevHash: undefined } }, true).catch(function () { return undefined; });
      }
      // The earliest refusal in each chain decides where it is minted again.
      const firstRefusal = new Map();
      for (const entry of refused) {
        const known = firstRefusal.get(entry.minted.logScopeId);
        if (!known || entry.minted.originSeq < known.minted.originSeq) firstRefusal.set(entry.minted.logScopeId, entry);
      }
      for (const entry of firstRefusal.values()) await rechainAfterRefusal(entry).catch(function () { return undefined; });
      // Minted again: the next pages hold copies from before, so this pass
      // ends here and the next one reads the queue afresh.
      if (restarts.size > 0 || firstRefusal.size > 0) {
        return { status: "waiting-to-sync", sent: sent, pending: pending.length - sent };
      }
    }
    return { status: sent === pending.length ? "synced" : "waiting-to-sync", sent: sent, pending: pending.length - sent };
  }

  /** A server missing the start of a chain (restored from an older copy) is
   *  given it again from what this phone still keeps, then the page again. */
  async function repairHubGaps(client, page, response) {
    const results = Array.isArray(response && response.results) ? response.results : [];
    const gaps = new Map();
    results.forEach(function (result, index) {
      if (result && result.status === "gap" && page[index]) gaps.set(page[index].logScopeId, Number(result.expectedSeq) || 1);
    });
    if (gaps.size === 0) return response;
    const kept = await listOutboxEntries();
    const identity = await hubIdentity();
    for (const [scope, fromSeq] of gaps) {
      const chain = kept.filter(function (entry) {
        return entry.minted && entry.minted.logScopeId === scope && entry.minted.originSeq >= fromSeq &&
          entry.minted.originId === identity.deviceId && entry.status !== "refused" &&
          !page.some(function (item) { return item.eventId === entry.eventId; });
      }).sort(function (left, right) { return left.minted.originSeq - right.minted.originSeq; });
      if (chain.length) await client.pushEvents(chain.map(function (entry) { return entry.minted; }));
    }
    return client.pushEvents(page.map(function (entry) { return entry.minted; }));
  }

  /** Sent entries are kept a week (see HUB_SENT_KEEP_MS), then let go. */
  async function pruneSentHubEntries() {
    const cutoff = Date.now() - HUB_SENT_KEEP_MS;
    const entries = await listOutboxEntries();
    for (const entry of entries) {
      if (entry.hub && entry.status === "acked" && Date.parse(entry.updatedAt || entry.createdAt) < cutoff) {
        await withOutbox("readwrite", function (store) { return requestToPromise(store.delete(entry.eventId)); }).catch(function () { return undefined; });
      }
    }
  }

  /** The app is open and showing what happened: the notices so far are
   *  seen, so the server does not ring this phone for them, nor does a later
   *  ring show them again. At most every ten seconds. */
  let hubNoticesSeenAt = 0;
  async function markHubNoticesSeen() {
    if (!isHubPairing(loadPairing()) || document.visibilityState === "hidden" || Date.now() - hubNoticesSeenAt < 10_000) return;
    hubNoticesSeenAt = Date.now();
    try {
      const client = hubClient();
      const answer = await hubPhoneGet("/v1/phone/notices", {});
      if (client && answer && Number.isSafeInteger(answer.head) && answer.head > (Number(answer.seen) || 0)) {
        await client.postJson("/v1/phone/seen", { through: answer.head });
      }
    } catch {
      // The next look marks them.
    }
  }

  /** A signed read from the server, as serverPhoneGet answers it. */
  async function hubPhoneGet(path, params, options) {
    const client = hubClient();
    if (!client) throw Object.assign(new Error("Not paired with a server"), { serverStatus: 0, unavailable: true });
    try {
      return await client.getJson(path, params || {}, { timeoutMs: (options && options.timeoutMs) || SERVER_FETCH_TIMEOUT_MS });
    } catch (error) {
      const status = error && typeof error.status === "number" ? error.status : 0;
      if (status === 401 && String(error && error.body || "").indexOf("not on the hub's roster") >= 0) {
        // Taken off the server's devices (removed on the Mac): this phone
        // reads nothing more and says so. Any other refusal (a clock that is
        // off) is not a removal.
        hubPairingState = { status: "revoked", message: "This phone was removed from your server. Pair it again from your Mac." };
        // Paired again after this, the phone gets a new key: the one the
        // User took off is not trusted again.
        void hubIdentity().then(function (identity) { return writeMetaRecord(HUB_REVOKED_IDENTITY_META_KEY, { deviceId: identity.deviceId }); }).catch(function () {});
      }
      throw Object.assign(new Error(String(error && error.message || error)), { serverStatus: status, serverBody: error && error.body || "", unavailable: Boolean(error && error.unreachable) });
    }
  }

  // Live progress of the open chat's running members, read from the server
  // while one runs: the same pending rows the desktop's live frames carried.
  let hubProgressTimer;
  let hubProgressBusy = false;
  function startHubProgressPolling() {
    if (hubProgressTimer) return;
    let ticks = 0;
    hubProgressTimer = setInterval(function () {
      // What the server says about the machines (waking, last seen) every
      // fifteen seconds while the app is open.
      ticks += 1;
      if (ticks % 10 === 0 && document.visibilityState !== "hidden") void refreshHubMachines();
      // A send the server never answered (a dropped connection, a server
      // restarting) is offered again while the app is open; the server keeps
      // one copy whatever arrives twice.
      void retryPendingOutbox();
      const pairing = loadPairing();
      const conversationId = selectedConversationId();
      if (!isHubPairing(pairing) || !conversationId || document.visibilityState === "hidden" || hubProgressBusy) return;
      hubProgressBusy = true;
      void listTimelineEntries(conversationId).then(function (rows) {
        if (!rows.some(function (row) { return row.role === "participant" && row.status === "pending"; })) return undefined;
        return hubPhoneGet("/v1/phone/progress", { conversationId: conversationId }).then(function (payload) {
          return handleRelayTimelinePayload(payload, conversationId, { live: true });
        });
      }).catch(function () { return undefined; }).finally(function () { hubProgressBusy = false; });
    }, 1_500);
  }

  const SERVER_FETCH_TIMEOUT_MS = 20_000;
  const SERVER_CHANGES_WAIT_MS = 25_000;
  // Whether the server's feed of changes may be followed: "yes" once the
  // chat list has been read from it, "no" after it refused the feed (it is
  // asked again with the next list).
  let serverReads = "unknown"; // "yes" | "no" | "unknown"

  /** A signed read from the server. */
  function serverPhoneGet(path, params, options) {
    return hubPhoneGet(path, params, options);
  }

  async function requestChatListFromServer() {
    const requestedAt = Date.now();
    const payload = await serverPhoneGet("/v1/phone/chats");
    return handleRelayChatListPayload(payload, { requestedAt: requestedAt });
  }

  async function requestTimelineFromServer(conversationId, options) {
    const beforeMessageId = options && typeof options.beforeMessageId === "string" && options.beforeMessageId.trim()
      ? options.beforeMessageId
      : undefined;
    const payload = await serverPhoneGet("/v1/phone/timeline", { conversationId, beforeMessageId });
    return handleRelayTimelinePayload(payload, conversationId, {
      deferRender: Boolean(options && options.deferRender),
      historyPage: Boolean(beforeMessageId),
      opening: Boolean(options && options.opening),
      openedAt: options && options.openedAt
    });
  }

  // What changed on the server, asked with a request the server holds open
  // until something does. Runs while the app is in front; a chat that changed
  // is read again: the list always, the open chat's newest page when it is
  // the one.
  let serverChanges = { instance: "", seq: 0 };
  let serverChangesRunning = false;
  let serverChangesStopped = false;

  function startServerChanges() {
    serverChangesStopped = false;
    if (serverChangesRunning || serverReads !== "yes") return;
    serverChangesRunning = true;
    void (async function () {
      let failures = 0;
      try {
        while (!serverChangesStopped && serverReads === "yes" && document.visibilityState !== "hidden") {
          let answer;
          try {
            answer = await serverPhoneGet("/v1/phone/changes", {
              instance: serverChanges.instance || "none",
              after: serverChanges.seq,
              waitMs: serverChanges.instance ? SERVER_CHANGES_WAIT_MS : 0
            }, { timeoutMs: SERVER_CHANGES_WAIT_MS + 15_000 });
            failures = 0;
          } catch (error) {
            const status = error && typeof error === "object" ? error.serverStatus : undefined;
            if (status === 404 || status === 403 || status === 401) {
              serverReads = "no";
              return;
            }
            failures += 1;
            await new Promise(function (resolve) { setTimeout(resolve, Math.min(30_000, 2_000 * failures)); });
            continue;
          }
          if (!answer || typeof answer.instance !== "string" || typeof answer.seq !== "number") continue;
          // The server is busy (or answered at once with nothing): ask again
          // a little later rather than straight away.
          if (typeof answer.retryAfterMs === "number" && answer.retryAfterMs > 0) {
            await new Promise(function (resolve) { setTimeout(resolve, Math.min(60_000, answer.retryAfterMs)); });
          }
          const first = !serverChanges.instance;
          const reset = answer.reset === true;
          serverChanges = { instance: answer.instance, seq: answer.seq };
          if (first) continue;
          const changed = Array.isArray(answer.conversationIds) ? answer.conversationIds : [];
          if (!reset && changed.length === 0) continue;
          const openConversationId = selectedConversationId();
          void markHubNoticesSeen();
          await requestChatListFromServer().catch(function () { return []; });
          if (openConversationId && (reset || changed.indexOf(openConversationId) >= 0)) {
            await requestTimelineFromServer(openConversationId).catch(function () { return 0; });
          }
          await render("synced");
        }
      } finally {
        serverChangesRunning = false;
      }
    })();
  }

  function stopServerChanges() {
    serverChangesStopped = true;
  }

  /** The chat list, from the server; following its feed of changes starts
   *  (again) with it. */
  async function requestChatListViaRelay() {
    const chats = await requestChatListFromServer();
    serverReads = "yes";
    startServerChanges();
    return chats;
  }

  /** A chat's newest page (or the page before a message), from the server. */
  async function requestTimelineViaRelay(pairing, conversationId, options) {
    return requestTimelineFromServer(conversationId, options);
  }

  // A queue entry the desktop did not take at the time is offered again while
  // the phone is open, not only when the User next acts in that chat.
  const OUTBOX_RETRY_MIN_MS = 30_000;
  let lastOutboxRetryAt = 0;

  function retryPendingOutbox() {
    if (activeFlushOutboxPromise || Date.now() - lastOutboxRetryAt < OUTBOX_RETRY_MIN_MS) return Promise.resolve();
    let pending = false;
    for (const held of outboxStatusById.values()) {
      if (desktopOwesEntry(held)) { pending = true; break; }
    }
    if (!pending) return Promise.resolve();
    lastOutboxRetryAt = Date.now();
    return flushOutbox().then(function (result) {
      return result && result.sent > 0 ? render(result.status) : undefined;
    }).catch(function () { return undefined; });
  }

  // "Nothing new" and "still looking" must not look the same. The banner waits
  // a moment so an ordinary fast poll does not blink it, and stays up long
  // enough to be read once it is there.
  const SYNC_BANNER_DELAY_MS = 350;
  const SYNC_BANNER_MIN_MS = 700;
  let syncDepth = 0;
  let syncBannerTimer;
  let syncBannerHideTimer;
  let syncBannerShownAt = 0;

  function setSyncBanner(visible) {
    const node = document.getElementById("timeline-syncing");
    if (!node) return;
    if (visible && node.hidden) {
      syncBannerShownAt = Date.now();
    }
    node.hidden = !visible;
  }

  /** Runs a sync that could bring messages in, with the banner saying so. */
  async function whileLookingForMessages(run) {
    syncDepth += 1;
    if (syncDepth === 1 && !syncBannerTimer) {
      clearTimeout(syncBannerHideTimer);
      syncBannerHideTimer = undefined;
      syncBannerTimer = setTimeout(function () {
        syncBannerTimer = undefined;
        if (syncDepth > 0) setSyncBanner(true);
      }, SYNC_BANNER_DELAY_MS);
    }
    try {
      return await run();
    } finally {
      syncDepth = Math.max(0, syncDepth - 1);
      if (syncDepth === 0) {
        clearTimeout(syncBannerTimer);
        syncBannerTimer = undefined;
        const node = document.getElementById("timeline-syncing");
        if (node && !node.hidden) {
          const left = Math.max(0, SYNC_BANNER_MIN_MS - (Date.now() - syncBannerShownAt));
          clearTimeout(syncBannerHideTimer);
          syncBannerHideTimer = setTimeout(function () {
            syncBannerHideTimer = undefined;
            if (syncDepth === 0) setSyncBanner(false);
          }, left);
        }
      }
    }
  }

  /** The members' messages the server's list carries for a chat (its running
   *  members and newest finished replies), kept in the shape Activity reads
   *  timeline rows in. A chat the phone never opened has no other rows, and
   *  without these Activity listed only the chats opened on this phone. */
  function listActivityOf(chat) {
    if (!Array.isArray(chat.activity)) return {};
    const rows = [];
    // The newest, if the server ever sends more than this phone keeps.
    for (const event of chat.activity.slice(-LIST_ACTIVITY_PER_CHAT)) {
      if (!event || typeof event !== "object" || event.hidden === true || event.role !== "participant") continue;
      const messageId = typeof event.messageId === "string" && event.messageId.trim() ? event.messageId.trim()
        : typeof event.id === "string" && event.id.trim() ? event.id.trim() : "";
      if (!messageId || (event.status !== "pending" && event.status !== "done")) continue;
      if (typeof event.content !== "string" || typeof event.createdAt !== "string") continue;
      rows.push({
        messageId: messageId,
        status: event.status,
        content: event.content.slice(0, LIST_ACTIVITY_CONTENT_CHARS),
        createdAt: event.createdAt,
        ...(typeof event.runId === "string" && event.runId ? { runId: event.runId } : {}),
        ...(typeof event.mobileEventId === "string" && event.mobileEventId ? { mobileEventId: event.mobileEventId } : {}),
        ...(typeof event.participantLabel === "string" && event.participantLabel ? { participantLabel: event.participantLabel } : {}),
        ...(typeof event.participantId === "string" && event.participantId ? { participantId: event.participantId } : {}),
        ...(typeof event.threadRootId === "string" && event.threadRootId ? { threadRootId: event.threadRootId } : {})
      });
    }
    return rows.length > 0 ? { activity: rows } : {};
  }

  function listActivitySeenKey(conversationId, row) {
    return conversationId + "\u0000" + row.messageId + "\u0000" + row.status;
  }

  function loadListActivitySeen() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LIST_ACTIVITY_SEEN_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Each listed message keeps the moment it first came in its current state:
   *  the same list read again is not news, a run that finished since is. Only
   *  what the list still carries is kept. */
  function noteListActivitySeen(chats) {
    // The first list this phone keeps these for is the baseline, as the
    // first chat list after an update marks nothing: each message counts as
    // having come when it was written, so what was there before is judged
    // against when its chat was last looked at, not counted as new now.
    const firstList = localStorage.getItem(LIST_ACTIVITY_SEEN_KEY) === null;
    const previous = loadListActivitySeen();
    const next = {};
    const now = nowIso();
    let changed = firstList;
    for (const chat of chats) {
      for (const row of chat.activity || []) {
        const key = listActivitySeenKey(chat.id, row);
        next[key] = previous[key] || (firstList ? row.createdAt : now);
        if (!previous[key]) changed = true;
      }
    }
    if (!changed && Object.keys(previous).length === Object.keys(next).length) return;
    try {
      localStorage.setItem(LIST_ACTIVITY_SEEN_KEY, JSON.stringify(next));
    } catch {
      // Without it a listed reply only reads as new a little longer.
    }
  }

  /** The rows Activity is built from: what this phone holds of the chats it
   *  read, and for every chat the list carries, the members' messages it
   *  names. The same message from both is one row: the stored one, unless the
   *  list says a run the phone last saw going has finished. */
  function withListActivity(entries, chats, seen) {
    const listed = new Map();
    for (const chat of chats) {
      for (const row of chat.activity || []) {
        listed.set(chat.id + "\u0000" + row.messageId, {
          id: chat.id + ":" + row.messageId,
          sourceId: row.messageId,
          conversationId: chat.id,
          role: "participant",
          participantLabel: row.participantLabel,
          participantId: row.participantId,
          content: row.content,
          status: row.status,
          createdAt: row.createdAt,
          receivedAt: seen[listActivitySeenKey(chat.id, row)] || row.createdAt,
          runId: row.runId,
          mobileEventId: row.mobileEventId,
          messageId: row.messageId,
          threadRootId: row.threadRootId
        });
      }
    }
    if (listed.size === 0) return entries;
    const covered = new Set();
    const kept = entries.filter(function (entry) {
      const key = entry.conversationId + "\u0000" + (entry.messageId || entry.sourceId || "");
      const fromList = listed.get(key);
      if (!fromList) return true;
      if (entry.status === "pending" && fromList.status === "done") return false;
      covered.add(key);
      return true;
    });
    for (const [key, row] of listed) {
      if (!covered.has(key)) kept.push(row);
    }
    return kept;
  }

  // Only for a list this phone may have asked for before a card reached it
  // (or one it did not ask for itself): such a list cannot know the card, so
  // its silence about a card younger than this says nothing, and the next
  // list decides. Both moments are this phone's own clock.
  const PENDING_CARD_RECONCILE_GRACE_MS = 5 * 60_000;

  /**
   * The server's chat list says which cards still wait in every chat it
   * lists, read from the same store as the chat pages that bring the cards.
   * A pending card this phone holds that a list asked for after the card
   * arrived does not name was answered or withdrawn while this phone was not
   * looking at that chat, and it leaves at once; without this it would wait
   * here for ever (the User's screenshot of 2026-09-20 showed cards closed
   * days earlier). A list that may predate the card leaves it to the next
   * list, for the grace above.
   *
   * Answered cards are kept; they are the record under their messages, and
   * the list says nothing about them.
   */
  function reconcilePendingControlCards(payload, options) {
    // The stamp says the desktop knows this contract; the judgement below is
    // on this phone's clock.
    if (!Number.isFinite(Date.parse(typeof payload.generatedAt === "string" ? payload.generatedAt : ""))) return 0;
    const now = Date.now();
    // When this phone sent the request the list answers. The server serves
    // the list and the chat pages from one store, so a list asked for after a
    // card arrived knows everything the page that brought the card knew.
    const askedAt = options && Number.isFinite(options.requestedAt) ? options.requestedAt : undefined;
    let changed = 0;
    for (const chat of payload.chats) {
      if (!chat || typeof chat.id !== "string" || !Array.isArray(chat.pendingCards)) continue;
      const listed = new Map();
      for (const card of chat.pendingCards) {
        if (card && typeof card.id === "string" && card.status === "pending") {
          listed.set(card.id, { ...card, conversationId: chat.id });
        }
      }
      const next = [];
      const seen = new Set();
      for (const card of controlCardsFor(chat.id)) {
        if (!card || typeof card.id !== "string") continue;
        seen.add(card.id);
        if (card.status !== "pending") {
          // An answered card is never reopened by a list that was read before
          // the answer: what this phone holds is the later fact.
          next.push(card);
          continue;
        }
        const fresh = listed.get(card.id);
        if (fresh) {
          next.push({ ...card, ...fresh });
          continue;
        }
        const receivedAt = Date.parse(card.receivedAt || card.createdAt || "");
        const listIsLater = askedAt !== undefined && Number.isFinite(receivedAt) && receivedAt < askedAt;
        if (!listIsLater && Number.isFinite(receivedAt) && receivedAt > now - PENDING_CARD_RECONCILE_GRACE_MS) {
          // Too new to judge: the list may predate it. The next list decides.
          next.push(card);
        }
        // Otherwise the desktop no longer waits on it, and neither does this phone.
      }
      for (const card of listed.values()) {
        if (!seen.has(card.id)) next.push(card);
      }
      if (storeControlCards(chat.id, next)) changed += 1;
    }
    return changed;
  }

  function handleRelayChatListPayload(payload, options) {
    if (payload?.type !== "mobile.chat-list" || !Array.isArray(payload.chats)) {
      return [];
    }
    // A card the list closed leaves the screen now, whether or not the
    // caller redraws afterwards.
    if (reconcilePendingControlCards(payload, options) > 0) void render();
    // When the desktop last said which chats have a run going; Activity
    // trusts a "still running" row only if it started after that.
    try {
      localStorage.setItem(CHAT_LIST_AT_KEY, nowIso());
    } catch {
      // Without it Activity simply shows what the chat shows.
    }
    return saveChats(payload.chats);
  }

  function timelineAttachmentsFromEvent(event) {
    if (!event || !Array.isArray(event.attachments)) {
      return [];
    }
    return event.attachments
      .filter(function (attachment) {
        return attachment && typeof attachment.id === "string" && attachment.id.trim();
      })
      .map(function (attachment) {
        return {
          id: attachment.id,
          filename: typeof attachment.filename === "string" ? attachment.filename : "image",
          mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : "image/png",
          width: Number.isFinite(attachment.width) ? attachment.width : undefined,
          height: Number.isFinite(attachment.height) ? attachment.height : undefined
        };
      });
  }

  // Bytes arrive once per image and stay for the session. The timeline is read
  // again constantly; refetching a screenshot on every read would bring the
  // picture from the server again and again.
  const attachmentDataUrls = new Map();
  const attachmentFetches = new Map();
  const ATTACHMENT_CACHE_MAX_ENTRIES = 24;

  function rememberAttachmentResult(attachmentId, result) {
    // Oldest out first. Without a bound, scrolling a long history keeps every
    // picture ever opened in memory for the life of the session.
    if (attachmentDataUrls.size >= ATTACHMENT_CACHE_MAX_ENTRIES) {
      const oldest = attachmentDataUrls.keys().next();
      if (!oldest.done) {
        attachmentDataUrls.delete(oldest.value);
      }
    }
    attachmentDataUrls.set(attachmentId, result);
  }

  function loadAttachmentInto(image, conversationId, attachment, messageId) {
    if (attachment.dataBase64) {
      // Already in hand — a picture queued on this phone, not yet echoed back.
      applyAttachmentResult(image, "data:" + attachment.mimeType + ";base64," + attachment.dataBase64);
      return;
    }
    const cached = attachmentDataUrls.get(attachment.id);
    if (cached) {
      applyAttachmentResult(image, cached);
      return;
    }
    if (!attachmentFetches.has(attachment.id)) {
      attachmentFetches.set(attachment.id, (async function () {
        // From the server the picture is read by its message: the server
        // holds the body the device that posted it put there.
        const payload = await hubPhoneGet("/v1/phone/attachment", { conversationId: conversationId, attachmentId: attachment.id, messageId: messageId });
        if (payload && payload.type === "mobile.attachment" && typeof payload.dataBase64 === "string") {
          const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : attachment.mimeType;
          return "data:" + mimeType + ";base64," + payload.dataBase64;
        }
        // "too-large" and "unavailable" are answers, not failures: the row says
        // so instead of spinning forever.
        return payload && typeof payload.reason === "string" ? payload.reason : "unavailable";
      })().catch(function () {
        // A dropped connection is not an answer: leave it uncached so opening
        // the chat again retries instead of showing a permanent failure.
        return "retry";
      }).then(function (result) {
        if (result !== "retry") {
          rememberAttachmentResult(attachment.id, result);
        }
        attachmentFetches.delete(attachment.id);
        return result === "retry" ? "unavailable" : result;
      }));
    }
    attachmentFetches.get(attachment.id).then(function (result) {
      if (image.isConnected) {
        applyAttachmentResult(image, result);
      }
    });
  }

  function applyAttachmentResult(image, result) {
    if (result && result.indexOf("data:") === 0) {
      image.src = result;
      image.dataset.state = "ready";
      return;
    }
    // A replaced element renders no pseudo-element, so the reason goes in a
    // sibling the reader can actually see.
    image.dataset.state = result === "too-large" ? "too-large" : "unavailable";
    image.hidden = true;
    const note = image.nextElementSibling;
    if (note && note.classList.contains("message-image-note")) {
      note.textContent = result === "too-large"
        ? "Too large for the phone — open it on the desktop"
        : "Image unavailable";
      note.hidden = false;
    }
  }

  function renderAttachmentsInto(container, entry) {
    const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
    const signature = attachments.map(function (attachment) { return attachment.id; }).join(",");
    if (container.dataset.attachmentSignature === signature) {
      return;
    }
    container.dataset.attachmentSignature = signature;
    container.textContent = "";
    if (attachments.length === 0) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    for (const attachment of attachments) {
      const image = document.createElement("img");
      image.className = "message-image";
      image.alt = attachment.filename;
      image.dataset.state = "loading";
      image.loading = "lazy";
      if (attachment.width && attachment.height) {
        // Reserve the real box before the bytes land, so the timeline does not
        // jump under the reader when the picture appears.
        image.width = attachment.width;
        image.height = attachment.height;
      }
      const note = document.createElement("div");
      note.className = "message-image-note";
      note.hidden = true;
      // A loaded picture opens at full size; one that has no bytes yet, or
      // never will, stays a note in the row.
      image.addEventListener("click", function () {
        if (image.dataset.state === "ready" && image.src) {
          openImageViewer(image.src, attachment.filename);
        }
      });
      container.append(image, note);
      loadAttachmentInto(image, entry.conversationId, attachment, entry.messageId || entry.sourceId);
    }
  }

  function openImageViewer(src, alt) {
    const viewer = document.getElementById("image-viewer");
    const picture = document.getElementById("image-viewer-image");
    if (!viewer || !picture) {
      return;
    }
    picture.src = src;
    picture.alt = alt || "Picture";
    viewer.hidden = false;
    // The bar leaves and comes back with the viewer; a reader at the latest
    // message stays there across both, as across the keyboard.
    keepingReaderAtLatest(applyDock);
  }

  function closeImageViewer() {
    const viewer = document.getElementById("image-viewer");
    const picture = document.getElementById("image-viewer-image");
    if (!viewer || viewer.hidden) {
      return;
    }
    viewer.hidden = true;
    if (picture) {
      picture.removeAttribute("src");
    }
    keepingReaderAtLatest(applyDock);
  }

  function wireImageViewer() {
    const viewer = document.getElementById("image-viewer");
    const close = document.getElementById("image-viewer-close");
    if (!viewer) {
      return;
    }
    close?.addEventListener("click", closeImageViewer);
    // Anywhere outside the picture itself is "back": the dark backdrop and the
    // picture's own margins. Scrolling inside a tall picture must not close it.
    viewer.addEventListener("click", function (event) {
      if (event.target === viewer || (event.target instanceof Element && event.target.classList.contains("image-viewer-body"))) {
        closeImageViewer();
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeImageViewer();
      }
    });
  }

  function attachmentsNodeFor(parent) {
    let node = parent.querySelector(".message-images");
    if (!node) {
      node = document.createElement("div");
      node.className = "message-images";
      node.hidden = true;
      parent.append(node);
    }
    return node;
  }

  // The cards of every synced chat in one string. Parsing it per row per
  // redraw cost tens of milliseconds on a store with hundreds of answered
  // choices, on every batch of a streaming run; the parse is kept until the
  // string itself changes.
  let controlCardsParseCache;

  function loadControlCards() {
    try {
      const raw = localStorage.getItem(CONTROL_CARDS_KEY);
      if (controlCardsParseCache && controlCardsParseCache.raw === raw) {
        return controlCardsParseCache.parsed;
      }
      const decoded = raw ? JSON.parse(raw) : {};
      const parsed = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : {};
      controlCardsParseCache = { raw: raw, parsed: parsed };
      return parsed;
    } catch {
      return {};
    }
  }

  function saveControlCards(byConversation) {
    try {
      controlCardsParseCache = undefined;
      localStorage.setItem(CONTROL_CARDS_KEY, JSON.stringify(byConversation));
      return true;
    } catch {
      // A full quota must not lose the timeline; the cards arrive again with
      // the next batch. Said so to the caller rather than counted as written.
      return false;
    }
  }

  // Answered cards a batch does not name are kept as the record under their
  // messages; only this many per chat, newest first, so the store cannot grow
  // with every choice ever answered.
  // Per chat, and the record only matters for the chats still being read:
  // a hundred each across every chat the phone has opened grew towards the
  // few megabytes the browser allows, past which no new card is stored.
  const CONTROL_CARDS_KEPT_ANSWERED_LIMIT = 30;

  function controlCardsFor(conversationId) {
    const stored = loadControlCards()[conversationId];
    return Array.isArray(stored) ? stored : [];
  }

  /** The desktop states the whole set for a chat, so it replaces rather than
   *  merges: a card it no longer lists has been answered or withdrawn. */
  function storeControlCards(conversationId, cards) {
    if (!conversationId || !Array.isArray(cards)) return false;
    const all = loadControlCards();
    const previous = Array.isArray(all[conversationId]) ? all[conversationId] : [];
    const before = JSON.stringify(previous);
    const previousById = new Map(previous.filter(function (card) { return card && card.id; })
      .map(function (card) { return [card.id, card]; }));
    // When each card reached this phone, on its own clock: what a later list
    // is judged against. A card already held keeps the moment it first came.
    const arrived = nowIso();
    const stamped = cards.map(function (card) {
      if (!card || !card.id) return card;
      const held = previousById.get(card.id);
      return { ...card, receivedAt: (held && held.receivedAt) || card.receivedAt || arrived };
    });
    // What the server sends is the whole of what still waits, so a pending
    // card it leaves out is closed. An answered card it leaves out was only
    // outside the page it read: it stays, as the record under its message.
    const incoming = new Set(stamped.map(function (card) { return card && card.id; }));
    const kept = previous.filter(function (card) {
      return card && card.id && !incoming.has(card.id) && card.status !== "pending";
    }).sort(function (left, right) {
      return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
    }).slice(0, CONTROL_CARDS_KEPT_ANSWERED_LIMIT);
    const next = stamped.concat(kept);
    // Before the sameness check: the same answer sent again is refused again
    // under the card the phone already holds.
    let refused = false;
    for (const card of stamped) refused = noteRefusedAnswer(card) || refused;
    const after = JSON.stringify(next);
    if (before === after) return refused;
    all[conversationId] = next;
    if (!saveControlCards(all)) return refused;
    // A card the desktop no longer lists has been answered or withdrawn, so the
    // "sent" mark for it goes too: the next card with that id is a new question.
    // Only this chat's cards: the set says nothing about another chat's, and
    // clearing theirs made an answer already sent there answerable again.
    const live = new Set(next.map(function (card) { return card && card.id; }));
    for (const card of previous) {
      const id = card && card.id;
      if (!id || live.has(id)) continue;
      clearCardSent(id);
      controlCardErrors.delete(id);
      choiceDrafts.delete(id);
      choiceViews.delete(id);
    }
    // A card the desktop now states as answered is answered: the "sent" mark
    // has done its work, whichever device the answer came from, and a pick
    // not sent from here has nothing left to answer.
    for (const card of next) {
      if (card && card.id && card.status !== "pending") {
        clearCardSent(card.id);
        choiceDrafts.delete(card.id);
        choiceViews.delete(card.id);
      }
    }
    return true;
  }

  async function handleRelayTimelinePayload(payload, fallbackConversationId, options) {
    if (payload?.type !== "mobile.timeline.events" || !Array.isArray(payload.events)) {
      return 0;
    }
    // Never the chat that happens to be open: a batch that does not say which
    // conversation it belongs to used to be filed under whatever the user was
    // looking at, which is how another chat's messages appeared in this one.
    const conversationId = payload.conversationId || fallbackConversationId;
    if (!conversationId) {
      return 0;
    }
    // Only the answer to a direct request says where this chat's history
    // stops; batches that arrive on their own (live progress) carry no page
    // and leave the stored cursor alone. Handled here rather than by the
    // requester, so the rows never arrive without their cursor.
    if (payload.page && typeof payload.page === "object") {
      await adoptTimelinePage(conversationId, payload);
    }
    let stored = 0;
    let changed = 0;
    // Only a tap on the chat opens it: a chat restored at launch was not
    // opened this time, and what came while the app was closed stays news.
    const opening = Boolean(options && options.opening);
    const openedAt = opening && typeof options.openedAt === "string" ? options.openedAt : undefined;
    // Cards are drawn now, but a batch that carries only cards is not news
    // the chat is marked unread for: the refresh the desktop sends after the
    // phone's own answer, and a card it closes, put an unread dot and a
    // number on the icon for a chat nothing was said in.
    if (Array.isArray(payload.cards) && storeControlCards(conversationId, payload.cards)) {
      stored += 1;
    }
    for (const event of payload.events) {
      if (!event || typeof event !== "object") {
        continue;
      }
      const id = typeof event.id === "string" && event.id.trim() ? event.id : createEventId();
      const content = typeof event.content === "string" ? event.content.trim() : "";
      const attachments = timelineAttachmentsFromEvent(event);
      // A picture with no caption is still a message. Requiring text dropped it.
      if (!content && attachments.length === 0) {
        continue;
      }
      const status = event.status === "error" ? "error" : event.status === "done" ? "done" : "pending";
      const runId = typeof event.runId === "string" ? event.runId : undefined;
      const mobileEventId = typeof event.mobileEventId === "string" ? event.mobileEventId : undefined;
      const createdAt = typeof event.createdAt === "string" ? event.createdAt : nowIso();
      const role = event.role === "you" ? "you" : event.role === "system" ? "system" : "participant";
      // W-N: only the agent's own finished message ends the agent's run. A
      // message sent from this phone comes back in the next conversation
      // snapshot as "done" and carries the run's identity — the run is named
      // after it (`mobile-<eventId>`, same mobileEventId) — so treating any
      // non-pending event as terminal deleted the in-progress row about a
      // second after it appeared, and blacklisted the run so it never returned.
      const messageId = typeof event.messageId === "string" && event.messageId.trim() ? event.messageId.trim() : id;
      // A page of earlier history is a record, not a run ending: it must not
      // clear anything pending now, nor crowd the recent runs out of the
      // terminal bookkeeping, which is bounded.
      const historyPage = Boolean(options && options.historyPage) || Boolean(payload.page && payload.page.earlier === true);
      // When this phone watched the run end live (from the open chat), it notes when:
      // the message keeps the time the run started, and Activity lists an
      // update by when it finished. A backlog drained later carries no such
      // moment, so it keeps the desktop's stamp.
      let settledAt;
      if (!historyPage && status !== "pending" && role === "participant" && (runId || mobileEventId || messageId)) {
        const cleared = await deletePendingTimelineEntriesForRun(conversationId, runId, mobileEventId, messageId, status);
        if (cleared > 0 && status === "done" && options && options.live) settledAt = nowIso();
        rememberTerminalRun(runId, mobileEventId, createdAt);
        await deleteStalePlaceholderTimelineEntries(conversationId, createdAt);
      }
      if (!historyPage && status === "pending" && isSupersededPendingEvent(runId, mobileEventId, createdAt)) {
        continue;
      }
      // What the desktop keeps off its timeline travels only to end a run:
      // the bookkeeping above ran, and no bubble is stored for it. It counts
      // as handled so the settled row is drawn now, not on the next batch. A
      // copy stored before the desktop hid it (an older shell, a page read
      // that could not see the row's trigger) goes with it.
      if (event.hidden === true) {
        if (await deleteTimelineEntry(conversationId ? conversationId + ":" + id : id)) {
          changed += 1;
        }
        stored += 1;
        continue;
      }
      const written = await putTimelineEntryDeduped({
        id: conversationId ? conversationId + ":" + id : id,
        sourceId: id,
        conversationId,
        role,
        participantLabel: typeof event.participantLabel === "string" ? event.participantLabel : undefined,
        content,
        attachments: attachments.length > 0 ? attachments : undefined,
        status,
        createdAt,
        runId,
        messageId: typeof event.messageId === "string" ? event.messageId : undefined,
        threadRootId: typeof event.threadRootId === "string" && event.threadRootId.trim()
          ? event.threadRootId
          : undefined,
        mobileEventId,
        // Who wrote it and in which thread: what the phone resolves an
        // unaddressed message to the member that spoke last by.
        ...(typeof event.participantId === "string" && event.participantId ? { participantId: event.participantId } : {}),
        ...(typeof event.threadId === "string" && event.threadId ? { threadId: event.threadId } : {}),
        ...(settledAt ? { settledAt: settledAt } : {})
      }, openedAt ? { arrivedAt: openedAt } : undefined);
      if (written) {
        changed += 1;
      }
      stored += 1;
    }
    // News for a chat that is not on screen — or is, behind a locked screen —
    // is unread, the way the desktop marks a chat it is not showing. The
    // phone's own message echoed back is news too; the desktop treats it so.
    const historyBatch = Boolean(options && options.historyPage) || Boolean(payload.page && payload.page.earlier === true);
    // The page a chat is opened with is what the User opened it to read, not
    // news, even when it lands after she has left it again: its rows count
    // as come and seen when she opened the chat. What came after that is
    // still news, and the chat list says so.
    if (opening && openedAt && changed > 0 && (conversationId !== selectedConversationId() || document.hidden)) {
      markConversationViewed(conversationId, openedAt, openedAt);
    }
    if (changed > 0 && !historyBatch && !opening && (conversationId !== selectedConversationId() || document.hidden)) {
      markConversationsUnread([conversationId]);
    }
    // For the QA harness: a page answered, and whether it was news.
    if (payload.page) recordRelayDebug({ event: "timeline-page", conversationId: conversationId, opening: opening, changed: changed });
    if (changed > 0 && !historyBatch) {
      refreshChatListSoon(conversationId);
    }
    if (stored > 0 && !(options && options.deferRender)) {
      await render("synced");
    }
    return stored;
  }

  // One more pass, queued behind a flush in flight: that flush read the queue
  // before the entry this call is about was written, so answering with it
  // alone left a message sent during a slow flush waiting for the retry tick
  // half a minute later. However many ask meanwhile, one pass follows.
  let queuedFlushOutboxPromise;

  function flushOutbox() {
    if (activeFlushOutboxPromise) {
      if (!queuedFlushOutboxPromise) {
        const again = function () {
          queuedFlushOutboxPromise = undefined;
          return flushOutbox();
        };
        queuedFlushOutboxPromise = activeFlushOutboxPromise.then(again, again);
      }
      return queuedFlushOutboxPromise;
    }
    activeFlushOutboxPromise = flushOutboxInternal().then(function (result) {
      // Anything that came back reached the server, or said it could not.
      if (result) outboxUnreachable = result.status === "unreachable";
      return result;
    }).finally(function () {
      activeFlushOutboxPromise = undefined;
    });
    return activeFlushOutboxPromise;
  }

  // The last send could not reach anything, and none has since: the header
  // keeps saying so until one does, not only on the render right after it.
  let outboxUnreachable = false;

  async function flushOutboxInternal() {
    // Every chat's queue, not only the open chat's: an answer given from
    // Activity for a chat that was then never opened again sat here for days.
    const entries = (await listOutboxEntries()).filter(desktopOwesEntry);
    if (!isHubPairing(loadPairing())) {
      return { status: "unreachable", sent: 0, pending: entries.length };
    }
    try {
      return await flushOutboxViaHub(entries);
    } catch (error) {
      return { status: "unreachable", sent: 0, pending: entries.filter((entry) => entry.hub).length, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function statusText(status) {
    if (status === "acked") {
      return "Sent";
    }
    if (status === "syncing") {
      return "Syncing";
    }
    if (status === "refused") {
      return "Not taken by your server";
    }
    if (status === "superseded") {
      return "Replaced";
    }
    return "Waiting to sync";
  }

  // Waiting with no feedback reads as "nothing is happening", so the wait is
  // timed and named, and a long silence says the chats have not come.
  function syncWaitStartedAt() {
    const existing = sessionStorage.getItem(SYNC_WAIT_KEY);
    if (existing) {
      return existing;
    }
    const now = nowIso();
    sessionStorage.setItem(SYNC_WAIT_KEY, now);
    return now;
  }

  function syncProgressText(startedAt) {
    const started = Date.parse(startedAt || "");
    const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    return seconds < 60
      ? "Loading your chats… " + seconds + "s"
      : "Your chats have not loaded in " + Math.floor(seconds / 60) + "m. Check your connection, then pull to refresh.";
  }

  function startSyncProgressClock() {
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

  function connectionStatusText(status) {
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

  function relativeTime(iso) {
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

  // Which picture a member shows is decided by the same code the desktop
  // runs (bundled as mobile-shared.js from src/shared/chatAvatarCatalog.ts):
  // the member's `avatarId` and provider, never a guess from the handle. A
  // member the phone has no record for gets what the desktop gives an unknown
  // author — the provider glyph its name suggests, or initials.
  const CHAT_ASSISTANT_DISPLAY_NAME = "Chat Assistant";

  function mobileSharedRules() {
    return globalThis.AccordMobileShared;
  }

  function avatarAssetUrl(assetId) {
    const shared = mobileSharedRules();
    if (!shared || !assetId) {
      return undefined;
    }
    if (assetId === shared.CHAT_ASSISTANT_AVATAR_ASSET_ID) {
      return "assets/accordagents-mark.png";
    }
    const entry = shared.chatAvatarCatalogEntry(assetId);
    return entry ? "assets/avatars/" + shared.chatAvatarAssetFileName(entry) : undefined;
  }

  function normalizeMemberHandle(value) {
    return String(value || "").trim().replace(/^@/, "").toLowerCase();
  }

  function memberForLabel(members, label) {
    const wanted = normalizeMemberHandle(label);
    if (!wanted) {
      return undefined;
    }
    return (members || []).find(function (member) {
      return normalizeMemberHandle(member.handle) === wanted ||
        normalizeMemberHandle(member.mentionHandle) === wanted ||
        normalizeMemberHandle(member.displayName) === wanted;
    });
  }

  // Without the shared bundle (an old cached shell) the phone can still name
  // the member: initials on a plain disc, the same stand-in the desktop uses
  // while a picture is missing.
  function initialsAvatar(label) {
    const text = String(label || "").trim() || "Agent";
    return { glyphKind: "generic", label: text, mediaMode: "glyph", initials: text.replace(/^@/, "").charAt(0).toUpperCase() || "?" };
  }

  // Which picture a member shows depends only on what is read here, and
  // every row asks again on every redraw; worked out once per member state.
  const memberAvatarCache = new Map();

  function avatarForMember(member) {
    const shared = mobileSharedRules();
    const label = member.displayName || "@" + member.handle;
    if (!shared) {
      return initialsAvatar(label);
    }
    const key = [member.id, member.handle, member.kind, member.avatarId, label, member.isAssistant === true].map(function (part) {
      return part === undefined ? "" : String(part);
    }).join("\u0000");
    const known = memberAvatarCache.get(key);
    if (known) return { ...known };
    if (memberAvatarCache.size > 500) memberAvatarCache.clear();
    const resolved = resolveMemberAvatar(shared, member, label);
    memberAvatarCache.set(key, resolved);
    return { ...resolved };
  }

  function resolveMemberAvatar(shared, member, label) {
    // A member the list only knows by handle (an older chat list) has no
    // provider to pick a default from; its name is all there is to go on.
    if (member.kind !== "claude-code" && member.kind !== "codex-cli" && member.kind !== "gemini-cli") {
      return shared.resolveChatAvatarByName(label);
    }
    return shared.resolveChatParticipantAvatar(
      { id: member.id, handle: member.handle, kind: member.kind, avatarId: member.avatarId },
      label,
      // The desktop says which member is the assistant; a list from an older
      // desktop is recognised by the name it gave.
      { isAssistant: member.isAssistant === true || label === CHAT_ASSISTANT_DISPLAY_NAME }
    );
  }

  function avatarForLabel(members, label) {
    const member = memberForLabel(members, label);
    if (member) {
      return avatarForMember(member);
    }
    const shared = mobileSharedRules();
    const text = String(label || "").trim() || "Agent";
    return shared ? shared.resolveChatAvatarByName(text) : initialsAvatar(text);
  }

  /** What the frame will show, for change detection: repainting on every
   *  render would restart the image load. */
  function avatarSignature(resolved) {
    return [resolved.glyphKind, resolved.mediaMode, resolved.assetId || "", resolved.customAvatarId || "", resolved.initials || ""].join("\0");
  }

  function clearAvatarKindClasses(avatar) {
    for (const className of [...avatar.classList]) {
      if (className.startsWith("avatar-") && className !== "avatar-icon") {
        avatar.classList.remove(className);
      }
    }
  }

  // One frame contract, the desktop's: the element is the disc, sized by its
  // own class; the picture inside is either a glyph (75%, contained) or a
  // photo (100%, covering). Nothing per member or per surface beyond that.
  function paintAvatar(avatar, resolved, conversationId) {
    const signature = avatarSignature(resolved);
    if (avatar.dataset.avatarSignature === signature) {
      // A drawn avatar still waiting for its bytes is asked for again on a
      // repaint (once the retry pause has passed): a missed answer must not
      // leave initials on a row that is patched in place for the session.
      if (resolved.customAvatarId && avatar.dataset.avatarLoaded !== "1") {
        loadCustomAvatarInto(avatar, conversationId, resolved.customAvatarId, signature);
      }
      return;
    }
    avatar.dataset.avatarSignature = signature;
    delete avatar.dataset.avatarLoaded;
    delete avatar.dataset.avatarCustomId;
    avatar.textContent = "";
    avatar.removeAttribute("style");
    clearAvatarKindClasses(avatar);
    avatar.classList.add("avatar-icon", "avatar-" + resolved.glyphKind);
    avatar.setAttribute("aria-label", resolved.label || "");
    if (resolved.customAvatarId) {
      // Initials stand in until the bytes arrive; a drawn avatar that cannot be
      // fetched (no desktop reachable) stays initials, as on the desktop
      // before its bytes load.
      const initials = document.createElement("span");
      initials.className = "avatar-media avatar-media-glyph";
      initials.textContent = resolved.initials || "?";
      avatar.classList.remove("avatar-custom");
      avatar.classList.add("avatar-generic");
      avatar.append(initials);
      loadCustomAvatarInto(avatar, conversationId, resolved.customAvatarId, signature);
      return;
    }
    const assetUrl = avatarAssetUrl(resolved.assetId);
    if (assetUrl) {
      avatar.append(avatarImage(assetUrl, resolved.mediaMode));
      avatar.dataset.avatarLoaded = "1";
      return;
    }
    const initials = document.createElement("span");
    initials.className = "avatar-media avatar-media-glyph";
    initials.textContent = resolved.initials || "?";
    avatar.append(initials);
    avatar.dataset.avatarLoaded = "1";
  }

  function avatarImage(src, mediaMode) {
    const img = document.createElement("img");
    img.className = "avatar-media avatar-media-" + mediaMode;
    img.src = src;
    img.alt = "";
    img.decoding = "async";
    // A hundred chat rows and eighty message rows are built at once; only
    // the discs on screen need their picture now.
    img.loading = "lazy";
    return img;
  }

  // Drawn avatars live as files on the desktop; the member record names the
  // id and the bytes come once per session, like a picture in a message.
  // Bounded like the picture cache: a drawn avatar can be megabytes.
  const customAvatarDataUrls = new Map();
  const customAvatarFetches = new Map();
  const customAvatarRetryAfter = new Map();
  const CUSTOM_AVATAR_CACHE_MAX_ENTRIES = 24;
  // A server that cannot be reached answers nothing for the request's whole
  // wait; asking again on every repaint would keep a request in flight for
  // the session.
  const CUSTOM_AVATAR_RETRY_PAUSE_MS = 60 * 1000;

  function rememberCustomAvatar(avatarId, result) {
    if (customAvatarDataUrls.size >= CUSTOM_AVATAR_CACHE_MAX_ENTRIES) {
      const oldest = customAvatarDataUrls.keys().next();
      if (!oldest.done) {
        customAvatarDataUrls.delete(oldest.value);
      }
    }
    customAvatarDataUrls.set(avatarId, result);
  }

  function loadCustomAvatarInto(avatar, conversationId, customId, signature) {
    const avatarId = "custom:" + customId;
    const cached = customAvatarDataUrls.get(avatarId);
    if (cached) {
      applyCustomAvatar(avatar, cached, signature);
      return;
    }
    avatar.dataset.avatarCustomId = customId;
    if (!customAvatarFetches.has(avatarId)) {
      if ((customAvatarRetryAfter.get(avatarId) || 0) > Date.now()) {
        return;
      }
      const pairing = loadPairing();
      customAvatarFetches.set(avatarId, (async function () {
        if (!pairing || !canSync(pairing) || !conversationId) {
          return "retry";
        }
        const payload = await hubPhoneGet("/v1/phone/avatar", { conversationId: conversationId, avatarId: avatarId });
        if (payload && payload.type === "mobile.avatar" && typeof payload.dataBase64 === "string") {
          return "data:" + (typeof payload.mimeType === "string" ? payload.mimeType : "image/png") + ";base64," + payload.dataBase64;
        }
        // "unavailable" and "too-large" are answers: initials stay, and the
        // id is not asked for again this session.
        return payload && typeof payload.reason === "string" ? "unavailable" : "retry";
      })().catch(function () {
        return "retry";
      }).then(function (result) {
        if (result !== "retry") {
          rememberCustomAvatar(avatarId, result);
        }
        if (result !== "retry" && !result.startsWith("data:")) {
          // Answered "no" — not asked again while the answer is remembered.
          customAvatarRetryAfter.set(avatarId, Date.now() + CUSTOM_AVATAR_RETRY_PAUSE_MS);
        } else if (result === "retry") {
          customAvatarRetryAfter.set(avatarId, Date.now() + CUSTOM_AVATAR_RETRY_PAUSE_MS);
        }
        customAvatarFetches.delete(avatarId);
        // Every disc on screen that shows this member gets the picture: a row
        // painted while the server was unreachable is patched in place and
        // would otherwise keep its initials for the session.
        for (const node of document.querySelectorAll('[data-avatar-custom-id="' + CSS.escape(customId) + '"]')) {
          applyCustomAvatar(node, result, node.dataset.avatarSignature);
        }
        return result;
      }));
    }
    customAvatarFetches.get(avatarId).then(function (result) {
      if (avatar.isConnected && avatar.dataset.avatarSignature === signature) {
        applyCustomAvatar(avatar, result, signature);
      }
    });
  }

  function applyCustomAvatar(avatar, result, signature) {
    if (typeof result !== "string" || !result.startsWith("data:")) {
      return;
    }
    if (avatar.dataset.avatarSignature !== signature || avatar.dataset.avatarLoaded === "1") {
      return;
    }
    avatar.textContent = "";
    avatar.classList.remove("avatar-generic");
    avatar.classList.add("avatar-custom");
    avatar.append(avatarImage(result, "photo"));
    avatar.dataset.avatarLoaded = "1";
  }

  function renderMessageContent(container, markdown) {
    container.textContent = "";
    container.classList.add("markdown-text");
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }
      if (line.trim().startsWith("```")) {
        const language = line.trim().slice(3).trim();
        const codeLines = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith("```")) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          index += 1;
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (language) {
          code.dataset.language = language;
        }
        code.textContent = codeLines.join("\n");
        pre.append(code);
        container.append(pre);
        continue;
      }
      const unordered = line.match(/^\s*[-*]\s+(.+)$/);
      if (unordered) {
        const list = document.createElement("ul");
        while (index < lines.length) {
          const item = lines[index].match(/^\s*[-*]\s+(.+)$/);
          if (!item) {
            break;
          }
          const li = document.createElement("li");
          appendInlineMarkdown(li, item[1]);
          list.append(li);
          index += 1;
        }
        container.append(list);
        continue;
      }
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ordered) {
        const list = document.createElement("ol");
        while (index < lines.length) {
          const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
          if (!item) {
            break;
          }
          const li = document.createElement("li");
          appendInlineMarkdown(li, item[1]);
          list.append(li);
          index += 1;
        }
        container.append(list);
        continue;
      }
      const paragraphLines = [];
      while (index < lines.length && lines[index].trim()) {
        if (lines[index].trim().startsWith("```") ||
          /^\s*[-*]\s+/.test(lines[index]) ||
          /^\s*\d+[.)]\s+/.test(lines[index])) {
          break;
        }
        paragraphLines.push(lines[index]);
        index += 1;
      }
      const paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, paragraphLines.join("\n"));
      container.append(paragraph);
    }
  }

  function appendInlineMarkdown(parent, text) {
    const source = String(text || "");
    const pattern = /(`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*]+)\*)/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      appendPlainText(parent, source.slice(cursor, match.index));
      if (match[2] !== undefined) {
        const code = document.createElement("code");
        code.textContent = match[2];
        parent.append(code);
      } else if (match[3] !== undefined) {
        const strong = document.createElement("strong");
        appendPlainText(strong, match[3]);
        parent.append(strong);
      } else if (match[4] !== undefined && match[5] !== undefined) {
        const anchor = document.createElement("a");
        anchor.href = match[5];
        anchor.target = "_blank";
        anchor.rel = "noreferrer";
        appendPlainText(anchor, match[4]);
        parent.append(anchor);
      } else if (match[6] !== undefined) {
        const em = document.createElement("em");
        appendPlainText(em, match[6]);
        parent.append(em);
      }
      cursor = pattern.lastIndex;
    }
    appendPlainText(parent, source.slice(cursor));
  }

  /** What a member's message shows. The desktop hides the control blocks it
   *  turns into its own controls — the `User choice:` block that becomes the
   *  card below the message — and the phone shows the same message, so it
   *  applies the same rule, from the same shared module rather than a copy of
   *  its own. */
  function displayedMessageText(content, author) {
    const text = typeof content === "string" ? content : "";
    // The desktop applies this to a member's message only: what the User typed
    // is her own words, even when a line of it happens to start "User choice:".
    if (author !== undefined && author !== "agent") {
      return text;
    }
    const shared = self.AccordMobileShared;
    return shared && typeof shared.stripChatControlBlocks === "function"
      ? shared.stripChatControlBlocks(text)
      : text;
  }

  function renderMessageContentIfChanged(container, markdown, author) {
    // Compared before the rule runs: reconciling every row on every redraw
    // must not re-strip every message of a long chat to find nothing changed.
    const raw = String(markdown || "");
    if (container.dataset.markdownRaw === raw) {
      return;
    }
    let source = displayedMessageText(raw, author);
    // A message that is nothing but the block it asked its question with: the
    // card carries the question, and an empty bubble with a timestamp says
    // nothing about what happened. Only when a question was in fact asked —
    // a message that was nothing but "Participant requests: none." asked
    // nothing, and said so wrongly.
    if (!source.trim() && /^\s*user choice\s*:/im.test(raw)) {
      source = "Asked you a question.";
    }
    container.dataset.markdownRaw = raw;
    if (container.dataset.markdownSource === source) {
      return;
    }
    renderMessageContent(container, source);
    container.dataset.markdownSource = source;
  }

  function appendPlainText(parent, text) {
    const parts = String(text || "").split("\n");
    parts.forEach(function (part, index) {
      if (index > 0) {
        parent.append(document.createElement("br"));
      }
      if (part) {
        parent.append(document.createTextNode(part));
      }
    });
  }

  // Which projects are folded in the chat list. Persisted: the phone reopens
  // the app many times a day, and a second project that takes a long scroll to
  // reach every time was the complaint. The desktop folds its project groups
  // the same way, with the same chevron.
  const COLLAPSED_CHAT_GROUPS_KEY = "accordagents.mobile.collapsedChatGroups.v1";

  function loadCollapsedChatGroups() {
    try {
      const raw = localStorage.getItem(COLLAPSED_CHAT_GROUPS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(function (name) { return typeof name === "string"; }) : [];
    } catch {
      return [];
    }
  }

  function toggleChatGroupCollapsed(name) {
    const current = loadCollapsedChatGroups();
    const next = current.indexOf(name) >= 0
      ? current.filter(function (item) { return item !== name; })
      : current.concat([name]);
    try {
      localStorage.setItem(COLLAPSED_CHAT_GROUPS_KEY, JSON.stringify(next));
    } catch {
      // Storage full or unavailable: the fold is lost with the tap, not the app.
    }
  }

  function groupedChats(chats) {
    const groups = [];
    const groupByName = new Map();
    for (const chat of chats) {
      const name = chat.group || "AccordAgents";
      let group = groupByName.get(name);
      if (!group) {
        group = { name, items: [] };
        groupByName.set(name, group);
        groups.push(group);
      }
      group.items.push(chat);
    }
    return groups;
  }

  // The search filters what the phone already holds: title, who wrote last
  // and what they wrote. It never asks the desktop.
  let chatSearchQuery = "";

  function chatMatchesQuery(chat, query) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) {
      return true;
    }
    return [chat.title, chat.who, chat.snippet, chat.group].some(function (field) {
      return typeof field === "string" && field.toLowerCase().includes(needle);
    });
  }

  function filterChatsByQuery(chats, query) {
    return chats.filter(function (chat) {
      return chatMatchesQuery(chat, query);
    });
  }

  /** Opens a chat, or one thread in it, and asks for its latest page. The
   *  chat list and Activity both land here, so a chat opened from either is
   *  fetched the same way. */
  function openConversation(conversationId, options) {
    const rootId = options && options.threadRootId ? options.threadRootId : undefined;
    pendingThreadOpen = rootId ? { conversationId: conversationId, rootId: rootId } : undefined;
    setOpenThreadRootId(rootId);
    localStorage.setItem(ACTIVE_CONVERSATION_KEY, conversationId);
    // When the User opened it, on this phone's clock: what the page it is
    // opened with holds counts as seen at this moment.
    const openedAt = nowIso();
    // A new visit reads the chat again: rows held from an earlier visit are
    // exactly what a late read must not be able to bring back.
    dropCachedChatRows();
    return render("synced").then(function () {
      const pairing = loadPairing();
      if (!pairing || !canSync(pairing)) {
        return undefined;
      }
      // A page that could not be read leaves what this phone holds on
      // screen; the next change, pull or return to the app reads it again.
      return requestTimelineViaRelay(pairing, conversationId, { opening: true, openedAt: openedAt }).catch(function () {
        return 0;
      }).then(function () {
        return render("synced");
      });
    });
  }

  /** The chat list's subtitle is the desktop's 84-character cut of the last
   *  message with its line breaks already collapsed, so the line-based rule
   *  cannot find the block inside it: what follows the marker on that one line
   *  is protocol, and the User should read the sentence before it instead. Her
   *  own messages and the app's are left exactly as they are, as the desktop
   *  leaves them. */
  function snippetDisplayText(chat) {
    const snippet = typeof chat.snippet === "string" ? chat.snippet : "";
    const who = typeof chat.who === "string" ? chat.who.trim().toLowerCase() : "";
    if (who === "you:" || who === "system:") {
      return snippet;
    }
    const cut = snippet.replace(/\s*user choice\s*:.*$/i, "").trim();
    return cut || "Asked you a question";
  }

  function renderChatList() {
    const listContainer = document.getElementById("chat-list");
    if (listContainer) {
      delete listContainer.dataset.state;
    }
    const container = document.getElementById("chat-list");
    if (!container) {
      return;
    }
    const allChats = loadChats();
    const chats = filterChatsByQuery(allChats, chatSearchQuery);
    const activeId = selectedConversationId();
    const unreadIds = loadUnreadConversationIds();
    // A search shows everything it matches; folding applies to the plain list,
    // and the headers are plain labels while a search is open so a tap cannot
    // change a fold it does not show.
    const searching = Boolean(chatSearchQuery.trim());
    const collapsedGroups = searching ? [] : loadCollapsedChatGroups();
    const renderSignature = JSON.stringify({
      activeId,
      query: chatSearchQuery,
      unreadIds,
      collapsedGroups,
      chats: chats.map(function (chat) {
        return {
          id: chat.id,
          title: chat.title,
          group: chat.group,
          snippet: chat.snippet,
          who: chat.who,
          running: chat.running,
          updatedAt: chat.updatedAt,
          participants: chat.participants,
          // What each row's avatars are drawn from: a member's changed picture
          // must repaint the row even when nothing else about the chat moved.
          members: chatMembers(chat).map(function (member) {
            return [member.handle, member.kind, member.avatarId || "", member.isAssistant === true];
          })
        };
      })
    });
    if (lastChatListRenderSignature === renderSignature) {
      return;
    }
    lastChatListRenderSignature = renderSignature;
    container.textContent = "";
    if (allChats.length > 0 && chats.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mobile-empty";
      empty.textContent = "No chats match “" + chatSearchQuery.trim() + "”.";
      container.append(empty);
      return;
    }
    if (chats.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mobile-empty";
      if (!canSync(loadPairing())) {
        empty.textContent = "Scan the code from your Mac (Settings → Device Pairing) to connect this phone.";
      } else {
        empty.textContent = "";
        const line = document.createElement("div");
        line.className = "sync-progress";
        line.dataset.startedAt = syncWaitStartedAt();
        line.textContent = syncProgressText(line.dataset.startedAt);
        empty.append(line);
      }
      container.append(empty);
      return;
    }
    for (const group of groupedChats(chats)) {
      const collapsed = collapsedGroups.indexOf(group.name) >= 0;
      const title = document.createElement(searching ? "div" : "button");
      title.className = "mobile-chat-group-title";
      title.dataset.group = group.name;
      const name = document.createElement("span");
      name.className = "mobile-chat-group-name";
      name.textContent = group.name;
      if (searching) {
        title.append(name);
      } else {
        title.type = "button";
        title.setAttribute("aria-expanded", collapsed ? "false" : "true");
        const chevron = document.createElement("span");
        chevron.className = "mobile-chat-group-chevron";
        chevron.setAttribute("aria-hidden", "true");
        title.append(chevron, name);
      }
      if (collapsed) {
        // Folded away, not silenced: the count says what is inside, and a
        // fresh message in a folded project still shows its dot here.
        const count = document.createElement("span");
        count.className = "mobile-chat-group-count";
        count.textContent = String(group.items.length);
        title.append(count);
        if (group.items.some(function (chat) { return unreadIds.indexOf(chat.id) >= 0; })) {
          const dot = document.createElement("span");
          dot.className = "mobile-unread-dot";
          dot.setAttribute("aria-label", "Unread messages");
          title.append(dot);
        }
      }
      if (!searching) {
        title.addEventListener("click", function () {
          toggleChatGroupCollapsed(group.name);
          renderChatList();
        });
      }
      if (collapsed) {
        container.append(title);
        continue;
      }
      const list = document.createElement("div");
      list.className = "mobile-chat-group";
      for (const chat of group.items) {
        const row = document.createElement("button");
        const unread = unreadIds.indexOf(chat.id) >= 0;
        row.className = "mobile-chat-row" + (chat.id === activeId ? " is-active" : "") + (unread ? " is-unread" : "");
        row.type = "button";
        row.dataset.conversationId = chat.id;
        if (unread) {
          row.dataset.unread = "1";
        }
        row.addEventListener("click", function () {
          openConversation(chat.id);
        });
        const avatars = document.createElement("div");
        avatars.className = "mobile-chat-avatars";
        // A chat row that arrives without a participants array must not take
        // the whole list down with it.
        const chatParticipants = Array.isArray(chat.participants) ? chat.participants : [];
        const participants = chatParticipants.length > 0 ? chatParticipants : [chat.title];
        const rowMembers = chatMembers(chat);
        participants.slice(0, 2).forEach(function (participant) {
          const avatar = document.createElement("span");
          avatar.className = "mobile-chat-avatar";
          paintAvatar(avatar, avatarForLabel(rowMembers, participant), chat.id);
          avatars.append(avatar);
        });
        const copy = document.createElement("div");
        copy.className = "mobile-chat-copy";
        const titleLine = document.createElement("div");
        titleLine.className = "mobile-chat-title-line";
        const strong = document.createElement("strong");
        strong.textContent = chat.title;
        titleLine.append(strong);
        if (chat.running) {
          const live = document.createElement("span");
          live.className = "mobile-live-dot";
          titleLine.append(live);
        }
        if (unread) {
          const dot = document.createElement("span");
          dot.className = "mobile-unread-dot";
          dot.setAttribute("aria-label", "New activity");
          titleLine.append(dot);
        }
        const snippet = document.createElement("div");
        snippet.className = "mobile-chat-snippet";
        if (chat.who) {
          const who = document.createElement("b");
          who.textContent = chat.who;
          snippet.append(who);
        }
        const snippetText = document.createElement("span");
        snippetText.textContent = snippetDisplayText(chat);
        snippet.append(snippetText);
        copy.append(titleLine, snippet);
        const when = document.createElement("div");
        when.className = "mobile-chat-time";
        when.textContent = relativeTime(chat.updatedAt);
        row.append(avatars, copy, when);
        list.append(row);
      }
      container.append(title, list);
    }
  }

  // Treat "within this many pixels of the end" as reading the latest message.
  // Anything further up means the reader is in history and must not be yanked.
  const SCROLL_BOTTOM_THRESHOLD_PX = 80;

  // The composer overlays the bottom of the message area, so "visually at the
  // bottom" can still be ~100px away numerically. Measure it instead of
  // assuming, or the app decides you scrolled away when you did not.
  function bottomThresholdPx() {
    const composer = document.getElementById("composer-form");
    const composerHeight = composer ? composer.getBoundingClientRect().height : 0;
    return SCROLL_BOTTOM_THRESHOLD_PX + composerHeight;
  }
  let lastScrolledConversationId;
  let lastRenderedThreadRootId;
  let lastRowsFingerprint;
  // The chat's reading position while one of its messages is open on its own
  // screen; restored on the way back.
  let mainListScrollTop;

  function openThreadRootId() {
    const value = sessionStorage.getItem(OPEN_THREAD_KEY);
    return value && value !== "none" ? value : undefined;
  }

  // The follow target is a pair: the run id the row advertised at tap time,
  // plus the mobile event id of the message that run answers. The answering
  // run streams under a fresh id of its own, so the event id is the only key
  // that survives the placeholder being replaced by real text.
  function openStreamFollow() {
    const value = sessionStorage.getItem(OPEN_STREAM_KEY);
    if (!value || value === "none") {
      return undefined;
    }
    const parts = value.split("\u0000");
    return { runId: parts[0], mobileEventId: parts[1] || undefined };
  }

  function setOpenStreamRunId(runId, mobileEventId) {
    if (runId) {
      sessionStorage.setItem(OPEN_STREAM_KEY, mobileEventId ? runId + "\u0000" + mobileEventId : runId);
    } else {
      sessionStorage.removeItem(OPEN_STREAM_KEY);
    }
  }

  function setOpenThreadRootId(rootId) {
    if (rootId) {
      sessionStorage.setItem(OPEN_THREAD_KEY, rootId);
    } else {
      sessionStorage.removeItem(OPEN_THREAD_KEY);
    }
  }

  // Replies are hidden behind their root on the main list and shown in full
  // once that thread is opened, matching how the desktop collapses them.
  function groupRowsIntoThreads(rows, openThreadRoot) {
    const replyCountByRoot = new Map();
    const latestReplyAtByRoot = new Map();
    for (const row of rows) {
      if (!row.threadRootId) {
        continue;
      }
      replyCountByRoot.set(row.threadRootId, (replyCountByRoot.get(row.threadRootId) || 0) + 1);
      const previous = latestReplyAtByRoot.get(row.threadRootId);
      if (!previous || row.createdAt > previous) {
        latestReplyAtByRoot.set(row.threadRootId, row.createdAt);
      }
    }
    if (openThreadRoot) {
      const visible = rows.filter(function (row) {
        return row.sourceId === openThreadRoot || row.threadRootId === openThreadRoot;
      });
      return { rows: visible, replyCountByRoot, latestReplyAtByRoot };
    }
    const visible = rows.filter(function (row) {
      return !row.threadRootId;
    }).map(function (row) {
      const replies = replyCountByRoot.get(row.sourceId) || 0;
      return replies > 0
        ? { ...row, replyCount: replies, latestReplyAt: latestReplyAtByRoot.get(row.sourceId) }
        : row;
    });
    return { rows: visible, replyCountByRoot, latestReplyAtByRoot };
  }

  // One way back at a time, as on the desktop: a thread goes back to its
  // chat, a chat goes back to the list. Both arrows side by side read as a
  // mistake, and the second one skipped a level.
  function renderThreadHeader(openThreadRoot) {
    const composerInput = document.getElementById("composer-input");
    if (composerInput) {
      const placeholder = openThreadRoot ? "Add a reply..." : "Message the room...";
      if (composerInput.placeholder !== placeholder) {
        composerInput.placeholder = placeholder;
      }
    }
    const back = document.getElementById("back-to-timeline");
    const backToChats = document.getElementById("back-to-chats");
    const title = document.getElementById("chat-title");
    if (!back) {
      return;
    }
    const shouldShow = Boolean(openThreadRoot);
    if (back.classList.contains("is-visible") !== shouldShow) {
      back.classList.toggle("is-visible", shouldShow);
    }
    if (backToChats && backToChats.hidden !== shouldShow) {
      backToChats.hidden = shouldShow;
    }
    if (openThreadRoot && title && title.textContent !== "Thread") {
      title.textContent = "Thread";
    }
  }

  /** The offer to answer this message, on the screen the message opens on.
   *  Shown for a thread that has not been answered yet: once there are
   *  replies, the composer below is self-evident and the row is noise. */
  function renderThreadReplyAction(openThreadRoot, rowCount) {
    const node = document.getElementById("thread-reply-action");
    if (!node) return;
    // Decided from the rows this redraw is about to paint, not from the ones
    // still on screen from the last one.
    const show = Boolean(openThreadRoot) && rowCount <= 1;
    if (node.hidden !== !show) {
      node.hidden = !show;
    }
    if (show && !node.dataset.wired) {
      node.dataset.wired = "1";
      document.getElementById("thread-reply-button")?.addEventListener("click", function () {
        const input = document.getElementById("composer-input");
        if (!input) return;
        input.focus();
      });
    }
  }

  function threadSurface() {
    return document.querySelector("#timeline-screen .thread-surface");
  }

  function isNearBottom(surface) {
    if (!surface) {
      return true;
    }
    return surface.scrollHeight - surface.scrollTop - surface.clientHeight <= bottomThresholdPx();
  }

  /** A change that makes the chat taller or shorter — the keyboard arriving,
   *  the bar coming back — must not move a reader who was at the latest
   *  message away from it, and must leave a reader up in history where they
   *  are. Stated once so the places that resize cannot disagree. */
  function keepingReaderAtLatest(change) {
    const wasAtLatest = isNearBottom(threadSurface());
    change();
    if (wasAtLatest) {
      scrollToLatestWhenSettled("auto");
    }
  }

  function setJumpToLatestVisible(visible) {
    const button = document.getElementById("jump-to-latest");
    if (button) {
      if (visible) placeJumpToLatest(button);
      button.classList.toggle("is-visible", Boolean(visible));
    }
  }

  /** Just above the chat's own bottom edge, wherever that is: the syncing
   *  strip, the machine's wake control and the bar all push that edge up, and
   *  a fixed offset from the bottom of the screen put the button on top of
   *  what was under the chat (the User, 2026-09-24). */
  function placeJumpToLatest(button) {
    const surface = threadSurface();
    const screen = document.getElementById("timeline-screen");
    if (!surface || !screen) return;
    const offset = Math.round(screen.getBoundingClientRect().bottom - surface.getBoundingClientRect().bottom) + 12;
    const next = offset + "px";
    if (button.style.bottom !== next) button.style.bottom = next;
  }

  function scrollToLatest(behavior) {
    const surface = threadSurface();
    if (!surface) {
      return;
    }
    surface.scrollTo({ top: surface.scrollHeight, behavior: behavior || "auto" });
    setJumpToLatestVisible(false);
  }

  // Rows grow after mount: markdown reflows and avatars decode. Scrolling once
  // lands short, so settle again on the next frame.
  function scrollToLatestWhenSettled(behavior) {
    requestAnimationFrame(function () {
      scrollToLatest(behavior);
      requestAnimationFrame(function () {
        scrollToLatest(behavior);
      });
    });
  }

  // An installed home-screen app gets its own storage on iOS, so it starts with
  // no pairing even though Safari has one. Say that plainly instead of showing
  // an empty list with dead buttons. The same screen serves re-pairing after a
  // revoke: the QR scan and paste box are the no-hand-copy path to a new link.
  function renderUnpairedNotice(noticeText, stateTag) {
    const state = stateTag || "unpaired";
    const container = document.getElementById("chat-list");
    if (!container || container.dataset.state === state) {
      return;
    }
    container.dataset.state = state;
    container.textContent = "";

    const notice = document.createElement("div");
    notice.className = "mobile-empty";
    notice.textContent = noticeText ||
      ("Paste the pairing link from the desktop app to connect this device. " +
      "An installed app has its own storage, so it pairs separately from the browser.");

    const form = document.createElement("form");
    form.className = "pairing-form";
    const input = document.createElement("input");
    input.type = "url";
    input.className = "pairing-input";
    input.placeholder = "https://mobile.accordagents.com/?pair=server#hub=…";
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "pairing-submit";
    submit.textContent = "Pair this device";
    const error = document.createElement("p");
    error.className = "pairing-error";

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        return;
      }
      try {
        // Same parser the app uses when opened via the link, so a pasted link
        // and a tapped link produce exactly the same pairing.
        const pairing = readBootstrapFromLocation({ href: value });
        if (!pairing) {
          throw new Error("That link does not contain pairing details.");
        }
        delete container.dataset.state;
        void render();
      } catch (parseError) {
        error.textContent = parseError instanceof Error
          ? parseError.message
          : "That link could not be read. Copy it again from the desktop app.";
      }
    });

    const scan = document.createElement("button");
    scan.type = "button";
    scan.className = "pairing-scan";
    scan.textContent = "Scan QR code";
    const scanner = document.createElement("div");
    scanner.className = "pairing-scanner";
    const video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.muted = true;
    scanner.append(video);

    scan.addEventListener("click", function () {
      void startPairingScan(video, scanner, error, function (decoded) {
        input.value = decoded;
        form.dispatchEvent(new Event("submit", { cancelable: true }));
      });
    });

    form.append(input, submit);
    container.append(notice, scan, scanner, form, error);
  }

  // Scanning happens inside the app because iOS opens a camera-scanned link in
  // Safari, which cannot reach an installed home-screen app's storage.
  async function startPairingScan(video, scanner, error, onDecoded) {
    if (typeof jsQR !== "function") {
      error.textContent = "The QR reader did not load. Paste the link instead.";
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
      });
    } catch {
      error.textContent = "Camera access was refused. Paste the link instead.";
      return;
    }
    error.textContent = "";
    scanner.classList.add("is-active");
    video.srcObject = stream;
    await video.play().catch(function () {
      return undefined;
    });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const stop = function () {
      scanner.classList.remove("is-active");
      for (const track of stream.getTracks()) {
        track.stop();
      }
    };
    const deadline = Date.now() + 60_000;
    const tick = function () {
      if (!scanner.classList.contains("is-active")) {
        return;
      }
      if (Date.now() > deadline) {
        stop();
        error.textContent = "No code found. Try again, or paste the link.";
        return;
      }
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = context.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
        if (found && found.data) {
          stop();
          onDecoded(found.data);
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }


  // --- cards a member is waiting on -----------------------------------------

  /** The chat action a tapped card produces. The shape is the one every device
   *  emits, so the desktop records and applies it exactly as it would its own —
   *  including the native identifiers the provider needs back. */
  async function decisionEventForCard(card, answer) {
    if (card.kind === "permission") {
      const approve = answer.optionId === "allow";
      return {
        kind: "permission.decided",
        payload: {
          operationId: "permission:" + card.id + ":" + (approve ? "allow" : "deny"),
          targetKey: "approval:" + card.id,
          stateId: approve ? "approved" : "denied",
          detail: {
            approve: approve,
            ...(card.codexDecisionId ? { codexDecisionId: card.codexDecisionId } : {}),
            ...(card.draftOverride ? { draftOverride: card.draftOverride } : {})
          }
        }
      };
    }
    const value = answer.cancel ? "cancelled" : answer.optionId || (answer.customAnswer ? "custom" : "empty");
    const identity = answer.customAnswer !== undefined || answer.note !== undefined
      ? value + ":" + await sha256Hex(stableJson({ customAnswer: answer.customAnswer, note: answer.note })) : value;
    return {
      kind: "choice.answered",
      payload: {
        operationId: "choice:" + card.id + ":" + identity,
        targetKey: "choice:" + card.id,
        stateId: value,
        detail: {
          sourceMessageId: card.sourceMessageId || "",
          ...(answer.optionId ? { selectedOptionId: answer.optionId } : {}),
          ...(answer.customAnswer !== undefined ? { customAnswer: answer.customAnswer } : {}),
          ...(answer.note !== undefined ? { note: answer.note } : {}),
          ...(answer.cancel ? { cancel: true } : {})
        }
      }
    };
  }

  /**
   * Answering a card: the event and the queue entry are written in one
   * IndexedDB transaction, then the queue is flushed. A tap is not the answer
   * being applied — the card says "sent" until the desktop states it answered.
   */
  async function answerControlCard(card, answer) {
    const conversationId = card.conversationId || selectedConversationId();
    if (!conversationId) return;
    // One answer per card. Hashing and the database come before the "sent"
    // mark, so a second tap in that gap (Allow, then Deny beside it) would
    // otherwise queue a second, contradicting decision.
    if (controlCardAnswering.has(card.id) || isCardLocked(card.id)) return;
    controlCardAnswering.add(card.id);
    answeringOutcome.set(card.id, answerOutcomeText(card, answer));
    // The reason an earlier answer was not taken goes with it: left, it kept
    // this one from folding until the database was done.
    controlCardErrors.delete(card.id);
    foldDrawnCard(card);
    try {
      await answerControlCardOnce(card, answer, conversationId);
    } catch (error) {
      // Failed before it was saved here: the card opens again and says so.
      recordRelayDebug({ event: "card-answer-failed", reason: String(error && error.message || error) });
      if (!isCardLocked(card.id) && !controlCardErrors.has(card.id)) controlCardErrors.set(card.id, "Could not save your answer on this phone. Try again.");
    } finally {
      controlCardAnswering.delete(card.id);
      answeringOutcome.delete(card.id);
      // An answer that could not be saved, or that the server refused while
      // it was still being written, leaves the options live again: the
      // redraw inside the answer still counted it as being written and
      // folded the card.
      if (!isCardLocked(card.id)) void render();
    }
  }

  async function answerControlCardOnce(card, answer, conversationId) {
    const decision = await decisionEventForCard(card, answer);
    await supersedeQueuedAnswer(card.id);
    let queued;
    try {
      queued = await enqueueDecision({ conversationId: conversationId, kind: decision.kind, payload: decision.payload });
    } catch (error) {
      controlCardErrors.set(card.id, "Could not save your answer on this phone. Try again.");
      await render("waiting-to-sync");
      return;
    }
    controlCardErrors.delete(card.id);
    markCardSent(card.id, queued && queued.eventId, answerOutcomeText(card, answer), decision.payload.operationId);
    // The answer goes out at once; the redraw does not hold it back.
    const flushing = flushOutbox();
    await handOverBeforeDrawing(flushing);
    await render("waiting-to-sync");
    const flushResult = await flushing;
    await render(flushResult.status);
  }

  function enqueueDecision(input) {
    return createOutboxEvent({
      conversationId: input.conversationId,
      kind: input.kind,
      payload: input.payload
    }).then(persistOutboundEvent);
  }

  let controlCardSentCache;

  function loadCardSentMarks() {
    if (controlCardSentCache) return controlCardSentCache;
    try {
      const parsed = JSON.parse(localStorage.getItem(CONTROL_CARD_SENT_KEY) || "{}");
      controlCardSentCache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      controlCardSentCache = {};
    }
    return controlCardSentCache;
  }

  function saveCardSentMarks(marks) {
    controlCardSentCache = marks;
    setStoredValue(CONTROL_CARD_SENT_KEY, JSON.stringify(marks));
  }

  function isCardSent(cardId) {
    return Boolean(cardId) && Object.prototype.hasOwnProperty.call(loadCardSentMarks(), cardId);
  }

  function markCardSent(cardId, eventId, outcome, operationId) {
    const marks = { ...loadCardSentMarks() };
    // Only a label for the fold: an own answer of any length is already in
    // the queue entry, and the marks share the few megabytes with the cards.
    const label = typeof outcome === "string" && outcome.length > CONTROL_CARD_OUTCOME_LABEL_MAX
      ? outcome.slice(0, CONTROL_CARD_OUTCOME_LABEL_MAX - 1) + "\u2026" : outcome;
    marks[cardId] = { at: nowIso(), ...(eventId ? { eventId: eventId } : {}), ...(typeof label === "string" ? { outcome: label } : {}),
      ...(operationId ? { operationId: operationId } : {}) };
    saveCardSentMarks(marks);
  }

  /** The member's home refused the answer this phone sent to a card: it waits no
   *  more, and says why, as a member's machine already makes it. Only for the
   *  answer the refusal names: a later one may still be on its way. True when
   *  the card changed. */
  function noteRefusedAnswer(card) {
    const refusals = card && card.status === "pending" && Array.isArray(card.refusedAnswers) ? card.refusedAnswers : [];
    const mark = refusals.length ? loadCardSentMarks()[card.id] : undefined;
    const refused = mark && mark.operationId
      ? refusals.find(function (item) { return item && item.operationId === mark.operationId; }) : undefined;
    if (!refused) return false;
    clearCardSent(card.id);
    controlCardErrors.set(card.id, refused.reason || CONTROL_CARD_REFUSED_TEXT);
    return true;
  }

  /** The card folds where it is drawn at the tap itself: the render that
   *  follows waits on hashing and the database, which on a long chat is a
   *  visible while. */
  function foldDrawnCard(card) {
    for (const node of Array.from(document.querySelectorAll(".control-card[data-card-id]"))) {
      if (node.dataset.cardId !== card.id || node.classList.contains("control-card-answered")) continue;
      const folded = controlCardElement(card);
      folded.dataset.signature = controlCardSignature(card);
      node.replaceWith(folded);
    }
  }

  /** How an answer given on this phone reads once its card is folded away. */
  function answerOutcomeText(card, answer) {
    if (answer && answer.cancel) return "Cancelled";
    if (answer && typeof answer.customAnswer === "string") return answer.customAnswer;
    const options = Array.isArray(card.options) ? card.options : [];
    const option = options.find(function (item) { return answer && item.id === answer.optionId; });
    return option ? option.label || option.id : (answer && answer.optionId) || "";
  }

  /** The answer a card on its way folds to, while it is written and after. */
  function cardOutcome(cardId) {
    if (answeringOutcome.has(cardId)) return answeringOutcome.get(cardId);
    const mark = loadCardSentMarks()[cardId];
    return mark && typeof mark.outcome === "string" ? mark.outcome : undefined;
  }

  function clearCardSent(cardId) {
    const marks = loadCardSentMarks();
    if (!Object.prototype.hasOwnProperty.call(marks, cardId)) return;
    const next = { ...marks };
    delete next[cardId];
    saveCardSentMarks(next);
  }

  /** Whether an answer given on this phone still holds its card, folded and
   *  saying nothing more (the User, 2026-09-24), or has stopped meaning
   *  anything and the card says it can be answered again. The queue entry the
   *  mark names says how long it may hold; an entry this phone has not read
   *  yet counts as handed over rather than alarming the User over a cache
   *  miss. A mark this old with the card still waiting means the answer was
   *  lost on its way or given up without a word, so the card unlocks rather
   *  than showing an answer on its way for ever. */
  function cardSentState(cardId) {
    const mark = loadCardSentMarks()[cardId];
    if (!mark) return undefined;
    const held = mark.eventId ? outboxStatusById.get(mark.eventId) : undefined;
    if (held && held.status === "refused") return { locked: false, text: CONTROL_CARD_REFUSED_TEXT };
    const at = Date.parse(mark.at || "");
    // An answer nobody has taken yet may be lost, and ten minutes of that
    // unlocks the card. One the server has taken is not lost:
    // it is applied when the desktop is next up, and a second answer given
    // meanwhile only raced it — the older one won on the desktop and the
    // User's later one was quietly discarded. That answer waits an hour
    // before the card unlocks, for the desktop that took it and then gave it
    // up without saying so.
    const owed = !held || desktopOwesEntry(held);
    const unlockAfterMs = owed ? CONTROL_CARD_SENT_UNLOCK_MS : CONTROL_CARD_TAKEN_UNLOCK_MS;
    const stale = !Number.isFinite(at) || Date.now() - at > unlockAfterMs;
    if (stale) return { locked: false, text: CONTROL_CARD_STALE_TEXT };
    return { locked: true, text: "" };
  }

  /** An earlier answer to the card still on its way is replaced, not raced:
   *  both travelling would let the older one win on the desktop and record
   *  the User's later one as superseded. The entry stays in the journal, so
   *  the sequence this phone signs is unbroken; it is simply never offered. */
  function supersedeQueuedAnswer(cardId) {
    const mark = loadCardSentMarks()[cardId];
    if (!mark || !mark.eventId) return Promise.resolve(false);
    return withOutbox("readwrite", function (store) {
      return requestToPromise(store.get(mark.eventId)).then(function (entry) {
        if (!entry || !desktopOwesEntry(entry)) return false;
        const replaced = { ...entry, status: "superseded", updatedAt: nowIso() };
        noteOutboxStatus(replaced);
        return requestToPromise(store.put(replaced)).then(function () { return true; });
      });
    }).catch(function () { return false; });
  }

  function cardSentText(cardId) {
    const state = cardSentState(cardId);
    return state ? state.text : "";
  }

  /** Whether the card's options are dead because an answer is on its way. */
  function isCardLocked(cardId) {
    const state = cardSentState(cardId);
    return Boolean(state && state.locked);
  }

  const controlCardErrors = new Map();
  // Cards whose answer is being written right now, before it is "sent".
  const controlCardAnswering = new Set();
  // What such a card was answered with, for the fold, until the mark has it.
  const answeringOutcome = new Map();
  const CONTROL_CARD_OUTCOME_LABEL_MAX = 200;
  const CONTROL_CARD_STALE_TEXT = "Answer sent, but not applied yet. You can answer again.";
  // Said for a refusal from the member's home and from the server alike, so
  // it names neither: either way the answer was not taken.
  const CONTROL_CARD_REFUSED_TEXT = "This answer was not accepted. You can answer again.";
  // How long an answer may stay on its way before the card is offered again.
  const CONTROL_CARD_SENT_UNLOCK_MS = 10 * 60_000;
  // For an answer the server has taken: see cardSentState.
  // An hour, not a day: the desktop can take an answer and then give it up
  // (five failed applies) without the phone hearing, and the card must not
  // show dead buttons for a day over that.
  const CONTROL_CARD_TAKEN_UNLOCK_MS = 60 * 60_000;

  /** The cards a member is waiting on in this chat. */
  function pendingControlCards(conversationId) {
    return cardIndexFor(conversationId).pending;
  }

  /** The chat's own last item: what waits for the User and has no message of
   *  its own, a permission. A choice stands only under its message. It
   *  scrolls with the chat, as the desktop's does. A strip of its own above
   *  the composer cut the cards off against the chat and read as a card going
   *  under the text (the User, 2026-09-24). */
  function renderTailCards(list, cards) {
    let host = document.getElementById("control-cards");
    if (!host && cards.length === 0) return;
    if (!host) {
      host = document.createElement("li");
      host.id = "control-cards";
      host.className = "control-cards";
      host.setAttribute("aria-label", "Waiting for you");
    }
    if (host.parentElement !== list || list.lastElementChild !== host) list.append(host);
    host.hidden = cards.length === 0;
    syncCardNodes(host, cards);
  }

  /** A choice under the message that asked it, as on the desktop. */
  function syncPendingCards(container, entry) {
    const cards = pendingCardsForMessage(entry);
    let host = null;
    for (const child of Array.from(container.children)) {
      if (child.classList.contains("message-cards")) host = child;
    }
    if (!host && cards.length === 0) return;
    if (!host) {
      host = document.createElement("div");
      host.className = "message-cards";
      container.append(host);
    }
    host.hidden = cards.length === 0;
    syncCardNodes(host, cards);
  }

  function syncCardNodes(host, cards) {
    // Every render passes through here. A card that has not changed keeps its
    // node, so a pick, a note being typed and the keyboard over it survive a
    // reply arriving in the chat; only what changed is drawn again.
    const held = new Map();
    for (const node of Array.from(host.children)) held.set(node.dataset.cardId, node);
    const next = cards.map(function (card) {
      const signature = controlCardSignature(card);
      const node = held.get(card.id);
      if (node && node.dataset.signature === signature) return node;
      const fresh = controlCardElement(card);
      fresh.dataset.signature = signature;
      return fresh;
    });
    const keep = new Set(next);
    for (const node of Array.from(host.children)) {
      if (!keep.has(node)) node.remove();
    }
    let at = host.firstChild;
    for (const node of next) {
      if (node === at) {
        at = at.nextSibling;
        continue;
      }
      host.insertBefore(node, at);
    }
  }

  /** What a card is drawn from, so an unchanged card is not drawn again. */
  function controlCardSignature(card) {
    return JSON.stringify([card.id, card.kind, card.status, card.title, card.summary, card.requesterLabel,
      card.machineName, card.options, card.recommendedOptionId, card.allowsCustomAnswer, card.allowsCancel,
      isCardLocked(card.id) || controlCardAnswering.has(card.id), controlCardErrors.get(card.id) || "",
      cardSentText(card.id), cardOutcome(card.id) || ""]);
  }

  // What was picked on a choice and not sent yet, by card. Outside the card:
  // the same card is drawn in the chat and on Activity, and drawn again when
  // it changes, and a half-written answer must survive both.
  const CHOICE_CUSTOM_ID = "custom";
  // What the desktop calls your own answer. Sent without it, an own answer was
  // read as an option it does not have and refused (the User, 2026-10-01).
  const CHOICE_CUSTOM_OPTION_ID = "__custom__";
  const choiceDrafts = new Map();
  // Every drawing of a choice now on screen, by card: a pick made in one (the
  // chat, say) shows in the other (Activity) instead of leaving it showing a
  // pick its Submit would not send.
  const choiceViews = new Map();

  function syncChoiceViews(cardId) {
    const views = choiceViews.get(cardId);
    if (!views) return;
    for (const view of Array.from(views)) {
      if (view.wrap.isConnected) view.update();
      else views.delete(view);
    }
    if (views.size === 0) choiceViews.delete(cardId);
  }

  function choiceDraft(card) {
    const options = Array.isArray(card.options) ? card.options : [];
    // What the pick was made against. A member that changes its options or
    // its recommendation asks a different question, and the pick starts over
    // from the new recommendation, as the desktop card's does.
    const asked = JSON.stringify([options.map(function (option) { return option.id; }), card.recommendedOptionId || ""]);
    let draft = choiceDrafts.get(card.id);
    if (!draft || draft.asked !== asked) {
      const recommended = options.some(function (option) { return option.id === card.recommendedOptionId; })
        ? card.recommendedOptionId : "";
      draft = { asked: asked, selected: recommended, customAnswer: "", note: "" };
      choiceDrafts.set(card.id, draft);
    }
    return draft;
  }

  /** A choice laid out as the desktop lays it out: every option numbered, with
   *  its description and the member's recommendation marked and picked up
   *  front, "Write your own answer" last, then Cancel and Submit. Picking only
   *  selects; Submit answers (the User, 2026-09-22), so a tap made while
   *  scrolling cannot answer for her. */
  function choiceCardBody(wrap, card, sent) {
    const draft = choiceDraft(card);
    const who = card.requesterLabel || "the member";
    const list = document.createElement("div");
    list.className = "control-card-choices";
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", card.summary || card.title || "Choice");
    const rows = [];
    function choiceRow(id, marker, label, description, recommended) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "control-card-choice";
      row.setAttribute("role", "radio");
      row.dataset.optionId = id;
      row.disabled = sent;
      const num = document.createElement("span");
      num.className = "control-card-choice-num";
      num.setAttribute("aria-hidden", "true");
      num.append(marker);
      const body = document.createElement("span");
      body.className = "control-card-choice-body";
      const titleLine = document.createElement("span");
      titleLine.className = "control-card-choice-title";
      const strong = document.createElement("strong");
      strong.textContent = label;
      titleLine.append(strong);
      if (recommended) {
        const chip = document.createElement("small");
        chip.className = "control-card-recommended";
        chip.textContent = "Recommended";
        titleLine.append(chip);
      }
      body.append(titleLine);
      if (description) {
        const text = document.createElement("span");
        text.className = "control-card-choice-description";
        text.textContent = description;
        body.append(text);
      }
      row.append(num, body);
      // Picking only opens a field, the note's or your own answer's; the finger
      // takes it, as it takes the composer. Focused from script, a field came
      // up behind the iPhone's keyboard (the User, 2026-09-24).
      row.addEventListener("click", function () {
        draft.selected = id;
        changed();
        const opened = id === CHOICE_CUSTOM_ID ? answer.panel : note.panel;
        if (!opened.hidden) revealInCardScroller(opened);
      });
      rows.push(row);
      list.append(row);
    }
    (Array.isArray(card.options) ? card.options : []).forEach(function (option, index) {
      choiceRow(option.id, String(index + 1) + ".", option.label || option.id, option.description,
        option.id === card.recommendedOptionId);
    });
    if (card.allowsCustomAnswer) {
      choiceRow(CHOICE_CUSTOM_ID, lineIcon(["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"], 15),
        "Write your own answer", "None of the suggestions fit: type your own direction for " + who + ".", false);
    }
    wrap.append(list);

    function textPanel(className, label, hint, placeholder, rowsCount, value, onInput) {
      const panel = document.createElement("label");
      panel.className = "control-card-text " + className;
      const caption = document.createElement("span");
      caption.className = "control-card-text-caption";
      const strong = document.createElement("strong");
      strong.textContent = label;
      const small = document.createElement("small");
      small.textContent = hint;
      caption.append(strong, small);
      const field = document.createElement("textarea");
      field.rows = rowsCount;
      field.placeholder = placeholder;
      field.value = value;
      field.disabled = sent;
      // The keyboard this field raises takes the bar with it, as the
      // composer's does, and gives it back once a tap has landed.
      field.addEventListener("focus", applyDockKeepingReader);
      field.addEventListener("blur", applyDockAfterTap);
      field.addEventListener("input", function () {
        onInput(field.value);
        changed();
      });
      panel.append(caption, field);
      wrap.append(panel);
      return { panel: panel, field: field };
    }
    const answer = textPanel("control-card-answer", "Your answer", "sent word for word to " + who,
      "Your own direction for " + who, 3, draft.customAnswer, function (value) { draft.customAnswer = value; });
    const answerField = answer.field;
    // The note is open under the picked option itself and taken by the finger,
    // as the composer is. Folded behind a link that focused it from script, it
    // came up behind the iPhone's keyboard, out of sight while typed; at the
    // foot of a long list it started below the fold (the User, 2026-09-24).
    const note = textPanel("control-card-note", "Add a note", "optional, " + who + " sees it with your pick",
      "Constraints, caveats or a question for " + who, 2, draft.note, function (value) { draft.note = value; });

    const actions = document.createElement("div");
    actions.className = "control-card-actions";
    const hint = document.createElement("span");
    hint.className = "control-card-hint";
    hint.textContent = "Type your answer to send it.";
    actions.append(hint);
    if (card.allowsCancel) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "control-card-cancel";
      cancel.dataset.optionId = "cancel";
      cancel.textContent = "Cancel";
      cancel.disabled = sent;
      cancel.addEventListener("click", function () {
        blurWithin(wrap);
        // A note typed before Cancel does not go with it, so it is not shown
        // under the sent card as if it had. Only a Cancel that is taken: one
        // tapped behind a Submit already on its way changes nothing.
        if (controlCardAnswering.has(card.id) || isCardLocked(card.id)) return;
        draft.cancelled = true;
        void answerControlCard(card, { cancel: true }).then(function () {
          if (!isCardLocked(card.id)) draft.cancelled = false;
        });
      });
      actions.append(cancel);
    }
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "control-card-submit";
    submit.textContent = "Submit";
    submit.addEventListener("click", function () {
      const reply = choiceReply(card, draft);
      if (!reply) return;
      // Sent, so the keyboard has nothing left to do here, as after a message.
      blurWithin(wrap);
      if (!controlCardAnswering.has(card.id) && !isCardLocked(card.id)) draft.cancelled = false;
      // The draft stays until the desktop answers or withdraws the card: an
      // answer refused, or never taken, opens the card again with what was
      // picked and typed, not the recommendation and an empty box.
      void answerControlCard(card, reply);
    });
    actions.append(submit);
    wrap.append(actions);

    function changed() {
      syncChoiceViews(card.id);
    }

    function update() {
      for (const row of rows) {
        const on = row.dataset.optionId === draft.selected;
        row.setAttribute("aria-checked", on ? "true" : "false");
        row.classList.toggle("is-selected", on);
      }
      // Text typed in another drawing of this card, carried over here unless
      // this field is the one being typed in.
      for (const pair of [[answerField, draft.customAnswer], [note.field, draft.note]]) {
        if (document.activeElement !== pair[0] && pair[0].value !== pair[1]) pair[0].value = pair[1];
      }
      const custom = draft.selected === CHOICE_CUSTOM_ID;
      // Once sent, only a note that went with the answer is left to show.
      const noteShown = !custom && Boolean(draft.selected) &&
        (!sent || (!draft.cancelled && Boolean(draft.note.trim())));
      answer.panel.hidden = !custom;
      note.panel.hidden = !noteShown;
      // Moves with the pick, its text kept. Only when the pick changed: moving
      // a field takes its focus away.
      const pickedRow = rows.find(function (row) { return row.dataset.optionId === draft.selected; });
      if (noteShown && pickedRow && pickedRow.nextElementSibling !== note.panel) pickedRow.after(note.panel);
      hint.hidden = sent || !custom || Boolean(draft.customAnswer.trim());
      submit.disabled = sent || !choiceReply(card, draft);
    }
    update();
    // A drawing replaced since (the card changed, the view closed) is dropped
    // here, so the record stays as small as what is on screen.
    const views = choiceViews.get(card.id) || new Set();
    for (const view of Array.from(views)) {
      if (!view.wrap.isConnected) views.delete(view);
    }
    views.add({ wrap: wrap, update: update });
    choiceViews.set(card.id, views);
  }

  /** The answer a choice's draft makes, or undefined while it makes none. */
  function choiceReply(card, draft) {
    if (draft.selected === CHOICE_CUSTOM_ID) {
      const text = draft.customAnswer.trim();
      return text ? { optionId: CHOICE_CUSTOM_OPTION_ID, customAnswer: text } : undefined;
    }
    const options = Array.isArray(card.options) ? card.options : [];
    if (!options.some(function (option) { return option.id === draft.selected; })) return undefined;
    const noteText = draft.note.trim();
    return { optionId: draft.selected, ...(noteText ? { note: noteText } : {}) };
  }

  /** A field a pick just opened, brought into sight in whatever scrolls the
   *  card, the chat or Activity: without focus and without moving the page,
   *  so the finger still takes it and iOS lifts a tapped field itself. Opened
   *  under a row at the bottom edge, it was below the fold with nothing to say so. */
  function revealInCardScroller(node) {
    let scroller = node.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === document.body || scroller === document.documentElement) return;
    const overflow = node.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 8;
    if (overflow > 0) scroller.scrollTop += overflow;
  }

  function blurWithin(node) {
    const active = document.activeElement;
    if (active && node.contains(active) && typeof active.blur === "function") active.blur();
  }

  function controlCardElement(card) {
    // Answered here and on its way: folded at once to what was answered, and
    // faded until the desktop says so (the User, 2026-09-24).
    if (cardOnItsWay(card)) {
      // Her answer, not yet the member's: "Answered" is what the desktop says
      // once it has it. A mark from before answers were kept folds bare.
      const node = compactCardElement(card, cardOutcome(card.id) || "", "control-card-folded is-on-its-way", "Your answer: ");
      node.append(onItsWayNote());
      return node;
    }
    const wrap = document.createElement("article");
    wrap.className = "control-card";
    wrap.dataset.cardId = card.id;
    wrap.dataset.cardKind = card.kind;

    const head = document.createElement("div");
    head.className = "control-card-head";
    const title = document.createElement("span");
    title.className = "control-card-title";
    title.textContent = card.title || (card.kind === "permission" ? "Permission request" : "Choice");
    head.append(title);
    if (card.requesterLabel || card.machineName) {
      const who = document.createElement("span");
      who.className = "control-card-who";
      who.textContent = [card.requesterLabel, card.machineName].filter(Boolean).join(" · ");
      head.append(who);
    }
    wrap.append(head);

    if (card.summary) {
      const summary = document.createElement("p");
      summary.className = "control-card-summary";
      summary.textContent = card.summary;
      wrap.append(summary);
    }

    const sent = isCardLocked(card.id) || controlCardAnswering.has(card.id);
    if (card.kind === "choice") {
      choiceCardBody(wrap, card, sent);
      appendCardState(wrap, card);
      return wrap;
    }
    const options = document.createElement("div");
    options.className = "control-card-options";
    for (const option of Array.isArray(card.options) ? card.options : []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "control-card-option";
      button.dataset.optionId = option.id;
      button.textContent = option.label || option.id;
      button.disabled = sent;
      button.addEventListener("click", function () {
        void answerControlCard(card, { optionId: option.id });
      });
      options.append(button);
    }
    if (card.allowsCancel) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "control-card-option";
      cancel.dataset.optionId = "cancel";
      cancel.textContent = "Cancel";
      cancel.disabled = sent;
      cancel.addEventListener("click", function () {
        void answerControlCard(card, { cancel: true });
      });
      options.append(cancel);
    }
    wrap.append(options);
    appendCardState(wrap, card);
    return wrap;
  }

  /** What a card says under its options. An answer on its way only fades the
   *  card: how far it has got is detail the User does not need (the User,
   *  2026-09-24). What she can act on is still said: a failure, or that she
   *  can answer again. */
  function cardStateText(card) {
    const failure = controlCardErrors.get(card.id);
    if (failure) return failure;
    const sentState = cardSentState(card.id);
    return sentState && !sentState.locked ? sentState.text : "";
  }

  /** The fade, said to a screen reader: its controls are dead for a reason. */
  function onItsWayNote() {
    const note = document.createElement("span");
    note.className = "sr-only";
    note.textContent = "Your answer is on its way.";
    return note;
  }

  function cardOnItsWay(card) {
    return !controlCardErrors.has(card.id) && (isCardLocked(card.id) || controlCardAnswering.has(card.id));
  }

  function appendCardState(wrap, card) {
    const state = document.createElement("p");
    state.className = "control-card-state";
    state.textContent = cardStateText(card);
    state.hidden = !state.textContent;
    wrap.append(state);
  }


  // --- home: the bottom bar, Activity and Settings ---------------------------
  //
  // With no chat open the phone shows one of three home tabs, switched by the
  // floating bar at the bottom: Chats, Activity and Settings. Activity lists
  // what the relay already delivered (see mobile-activity.js), so it works the
  // same whether the desktop is answering right now or not.

  const HOME_TABS = ["chats", "activity", "settings"];
  const ACTIVITY_TABS = ["running", "pending", "finished"];
  const ACTIVITY_TAB_LABELS = { running: "Running", pending: "Pending", finished: "Finished" };
  const SVG_NS = "http://www.w3.org/2000/svg";
  // A copy of the week's rows is kept until the store changes, and refreshed at
  // least this often in case another window of the app wrote to it.
  const ACTIVITY_CACHE_MAX_AGE_MS = 60_000;
  // A tap that lands this soon after the list was redrawn may have been aimed
  // at a row that has since moved; answering is too consequential to guess.
  const ACTIVITY_TAP_GUARD_MS = 450;
  // What the User cleared from Activity on this phone, by row key and the
  // moment she cleared it. Local to the device, as the desktop's Clear is.
  const ACTIVITY_CLEARED_KEY = "accordagents.mobile.activityCleared.v1";
  // How far a row slides to show its action, and how far a finger must travel
  // before the list stops treating the gesture as a scroll.
  const SWIPE_ACTION_WIDTH = 88;
  const SWIPE_START_PX = 12;
  // A batch for a chat the stored list does not have asks for the list again,
  // at most this often.
  const CHAT_LIST_REFRESH_MIN_MS = 60_000;

  function setStoredValue(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A full quota must not stop the bar from switching; the choice is just
      // not remembered.
    }
  }

  // The chat's own dialogs: while one is open the bar is not there to be
  // tapped behind it.
  const CHAT_DIALOG_IDS = ["image-viewer", "members-sheet"];

  const SCREEN_IDS = {
    chats: "chats-screen",
    activity: "activity-screen",
    settings: "settings-screen",
    timeline: "timeline-screen"
  };

  // What the User picked this session wins over what storage holds, so a
  // write refused by a full quota does not flip the bar straight back.
  let currentHomeTab;
  let currentActivityTab;

  function homeTab() {
    if (currentHomeTab) return currentHomeTab;
    const stored = localStorage.getItem(HOME_TAB_KEY);
    return HOME_TABS.indexOf(stored) >= 0 ? stored : "chats";
  }

  function setHomeTab(tab) {
    if (HOME_TABS.indexOf(tab) < 0) return;
    currentHomeTab = tab;
    setStoredValue(HOME_TAB_KEY, tab);
  }

  function setActivityTab(tab) {
    currentActivityTab = tab;
    setStoredValue(ACTIVITY_TAB_KEY, tab);
  }

  /** Leaving the open chat, the one way the back button and the bar's tabs
   *  both take: the thread is left first, then the chat, so a redraw in
   *  between cannot land on a thread of a chat that is no longer open. */
  function leaveOpenChat() {
    if (!selectedConversationId()) return;
    closeMembersSheet();
    closeImageViewer();
    setOpenThreadRootId(undefined);
    localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
    dropCachedChatRows();
  }

  /** One way to change home tab, from the bar and from search alike: an open
   *  choice is left, the open chat is left (the bar is under the chat too, so
   *  a tab can be tapped from inside one), the tab is remembered, and the
   *  screen redrawn. */
  function switchHomeTab(tab) {
    closeActivityItem();
    leaveOpenChat();
    setHomeTab(tab);
    showScreen(tab);
    return render();
  }

  function storedActivityTab() {
    if (currentActivityTab) return currentActivityTab;
    const stored = localStorage.getItem(ACTIVITY_TAB_KEY);
    return ACTIVITY_TABS.indexOf(stored) >= 0 ? stored : undefined;
  }

  /** Which home screen, or the open chat, is on screen. */
  function showScreen(name) {
    for (const key of Object.keys(SCREEN_IDS)) {
      const screen = document.getElementById(SCREEN_IDS[key]);
      if (screen) screen.classList.toggle("is-active", key === name);
    }
    // After the classes are on: applyDock reads the screen from them.
    applyDock();
    for (const tab of document.querySelectorAll("[data-home-tab]")) {
      const active = tab.dataset.homeTab === name;
      tab.dataset.active = active ? "true" : "false";
      if (active) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
  }

  /** Whether the keyboard is up: the composer holding focus is what the height
   *  tracker already treats as the keyboard being open, so the bar and the
   *  measuring cannot disagree about it. */
  function composerHasFocus() {
    const active = document.activeElement;
    if (!active) return false;
    if (active.id === "composer-input") return true;
    // A card's own answer field raises the keyboard the same way the
    // composer does, and the bar has no room beside it either. So does one on
    // a choice opened from Activity: iOS lifts it, and the height must hold
    // there too or the screen shrinking would lift it a second time.
    return (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
      Boolean(active.closest && active.closest("#timeline-screen, #activity-item"));
  }

  /** What is on screen, read from the screens themselves rather than kept
   *  beside them: the bar is decided outside a redraw too (the keyboard opens),
   *  and a remembered copy could then answer for a screen that is not up. */
  function screenOnShow() {
    for (const key of Object.keys(SCREEN_IDS)) {
      const screen = document.getElementById(SCREEN_IDS[key]);
      if (screen && screen.classList.contains("is-active")) return key;
    }
    return "chats";
  }

  /** The bar's own state. It shows on the home screens of a paired phone and
   *  under the chat's composer, as the User asked on 2026-09-20 (Slack's
   *  behaviour). It steps aside for a choice opened from Activity, so nothing
   *  behind it can be reached, and inside a chat while the keyboard is up,
   *  where there is no room for it. Called on every screen change and on the
   *  composer's focus and blur, which is when the keyboard comes and goes. */
  function applyDock() {
    const name = screenOnShow();
    const paired = Boolean(loadPairing());
    const home = name !== "timeline" && paired;
    const inChat = name === "timeline" && paired;
    // Anything that takes the screen for itself takes the bar with it: the
    // choice opened from Activity, a picture at full size, and the members
    // sheet — a dialog with a backdrop, and navigation left live outside a
    // backdrop is a way around it. The live-reply view is a screen of the
    // chat rather than a dialog, so the bar stays under that one.
    const covered = (name === "activity" && Boolean(openActivityCardId)) ||
      (inChat && CHAT_DIALOG_IDS.some(function (id) {
        const node = document.getElementById(id);
        return Boolean(node && !node.hidden);
      }));
    const typing = inChat && composerHasFocus();
    const shown = (home || inChat) && !covered && !typing;
    // Where the bar is, for the stylesheet: "1" floating over a home screen,
    // "chat" in the column under the composer, "0" not on screen at all.
    const placement = !shown ? "0" : home ? "1" : "chat";
    const dock = document.getElementById("home-dock");
    if (dock) dock.hidden = !shown;
    const phone = document.querySelector(".mobile-phone");
    if (phone) phone.dataset.dock = placement;
  }

  /** Layout that follows a field losing focus, run once the tap that took the
   *  focus has landed. A tap on a button while the keyboard is up blurs the
   *  field on the way down, and the release is hit-tested again: the bar coming
   *  back under the composer, or the composer folding to one line, pulls the
   *  button out from under the finger in between, and the tap only closes the
   *  keyboard — a card's Send, Allow or Deny tapped once and not taken. The
   *  work waits for the release, and runs behind the click that follows it;
   *  a blur no tap caused (the keyboard's own Done) waits out a short bound. */
  const AFTER_TAP_BOUND_MS = 350;
  const afterTapWork = new Set();
  let afterTapTimer = 0;
  let afterTapWired = false;
  function afterTapLands(work) {
    afterTapWork.add(work);
    if (!afterTapWired) {
      afterTapWired = true;
      for (const type of ["mouseup", "click"]) {
        document.addEventListener(type, function () {
          if (afterTapTimer) setTimeout(runAfterTapWork, 0);
        }, true);
      }
    }
    if (!afterTapTimer) afterTapTimer = setTimeout(runAfterTapWork, AFTER_TAP_BOUND_MS);
  }

  function runAfterTapWork() {
    clearTimeout(afterTapTimer);
    afterTapTimer = 0;
    const queued = Array.from(afterTapWork);
    afterTapWork.clear();
    for (const run of queued) run();
  }

  /** Slack's composer: one line until it is tapped, then the row of tools.
   *  Anything written or attached keeps it open, so a draft is never left
   *  without a way to send it. The one rule for the composer's shape; a fold
   *  that follows a tap goes through afterTapLands, or the text field slides
   *  under the finger still on Send and the tap's click lands on it — which
   *  on iOS raised the keyboard again right after a send (the User,
   *  2026-09-22). */
  function updateComposerShape() {
    const form = document.getElementById("composer-form");
    const input = document.getElementById("composer-input");
    if (!form || !input) return;
    const open = document.activeElement === input ||
      Boolean(input.value.trim()) ||
      pendingAttachments.length > 0;
    form.dataset.expanded = open ? "1" : "";
  }

  function applyDockAfterTap() {
    afterTapLands(applyDockKeepingReader);
  }

  function applyDockKeepingReader() {
    keepingReaderAtLatest(applyDock);
  }

  function lineIcon(paths, size) {
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
          content: typeof row.content === "string" ? row.content.slice(0, keepChars) : ""
        });
      }
      return kept;
    });
  }

  /** Runs a stop was asked for that the desktop has not taken yet, from the
   *  queue itself: after a reload the in-memory mark is gone, the request is not. */
  function queuedStopRunIds() {
    return listOutboxEntries(undefined).then(function (entries) {
      return entries.filter(function (entry) {
        return entry && entry.kind === "run.cancel.requested" && entry.payload && entry.payload.runId;
      }).map(function (entry) {
        return entry.payload.runId;
      });
    }).catch(function () {
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
  async function loadActivity(options) {
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
    if (activityMemo && activityMemo.source === source && activityMemo.inputs.length === inputs.length &&
      activityMemo.inputs.every(function (value, index) { return value === inputs[index]; })) {
      return activityMemo.activity;
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
    activityMemo = { source: source, inputs: inputs, activity: activity };
    return activity;
  }

  /** A batch for a chat the phone's list does not have yet (created on the
   *  desktop while this app stayed open) asks for the list again, so the chat
   *  and anything it is waiting on show up without a trip to the background. */
  function refreshChatListSoon(conversationId) {
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

  async function renderHome(tab, revision) {
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
  async function refreshDockBadge(revision) {
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

  function activityRowAvatar(conversationId, handle) {
    const avatar = document.createElement("span");
    avatar.className = "mobile-chat-avatar act-avatar";
    paintAvatar(avatar, activityAvatarFor(conversationId, handle), conversationId);
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
    // never named as the author.
    const byText = row.handle
      ? " by " + [row.handle, row.machineName].filter(Boolean).join(" · ")
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
    preview.textContent = row.preview || (row.kind === "run" ? "Thinking…" : "");
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

  function loadClearedActivity() {
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
    activityMemo = undefined;
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
      void openConversation(row.conversationId, { threadRootId: row.threadRootId });
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
    if (row.kind === "choice") {
      // A choice is read and answered in full, so the row opens it.
      const chevron = document.createElement("span");
      chevron.className = "act-chevron";
      chevron.append(lineIcon(["m9 18 6-6-6-6"], 20));
      element.append(activityRowAvatar(row.conversationId, row.handle), col, chevron);
      makeRowOpen(element, function () {
        openActivityCardId = card.id;
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
      stop.setAttribute("aria-label", stopping ? "Stopping" : "Stop " + (row.handle || "this run"));
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
      void openConversation(row.conversationId, { threadRootId: row.threadRootId });
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
    const openCard = openActivityCardId
      ? data.pending.find(function (row) { return row.card.id === openActivityCardId; })
      : undefined;
    if (openActivityCardId && !openCard) {
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
          row.cancellable, row.stopping, avatarSignature(activityAvatarFor(row.conversationId, row.handle)),
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

  function getTimelineEntry(entryId) {
    return withTimeline("readonly", function (store) {
      return requestToPromise(store.get(entryId));
    });
  }

  /** The message a choice belongs to: stored under the chat's id and its own,
   *  so it is read directly rather than by reading the whole store. */
  async function findChoiceMessage(conversationId, sourceMessageId) {
    if (!sourceMessageId) return undefined;
    const direct = await getTimelineEntry(conversationId + ":" + sourceMessageId).catch(function () { return undefined; });
    if (direct) return direct;
    const entries = await listTimelineEntries(conversationId).catch(function () { return []; });
    const stored = entries.find(function (entry) {
      return entry.messageId === sourceMessageId || entry.sourceId === sourceMessageId;
    });
    if (stored) return stored;
    // A chat this phone never read: the server's list carries the message
    // that asks (up to the length Activity reads), so the question is shown
    // with it there too.
    const chat = loadChats().find(function (item) { return item.id === conversationId; });
    return chat && Array.isArray(chat.activity) ? chat.activity.find(function (row) {
      return row.messageId === sourceMessageId;
    }) : undefined;
  }

  /** A choice opened from Activity: the message it belongs to and the whole
   *  card, answered exactly as it is in the chat. */
  async function renderActivityItem(row) {
    const view = document.getElementById("activity-item");
    const body = document.getElementById("activity-item-body");
    if (!view || !body) return;
    if (!row) {
      activityItemRenderToken += 1;
      if (!view.hidden) {
        view.hidden = true;
        body.replaceChildren();
        delete body.dataset.signature;
      }
      return;
    }
    const card = row.card;
    const titleNode = document.getElementById("activity-item-title");
    const subNode = document.getElementById("activity-item-sub");
    if (titleNode) titleNode.textContent = row.chatTitle;
    if (subNode) subNode.textContent = "Waiting for you" + (row.handle ? " · asked by " + row.handle : "");
    view.hidden = false;
    view.dataset.conversationId = row.conversationId;
    const signature = JSON.stringify([card, isCardLocked(card.id), cardSentText(card.id), controlCardAnswering.has(card.id), controlCardErrors.get(card.id) || ""]);
    if (body.dataset.signature === signature) return;
    body.dataset.signature = signature;
    const token = ++activityItemRenderToken;
    const source = await findChoiceMessage(row.conversationId, card.sourceMessageId);
    // A later draw (the answer being sent, say) owns the view now.
    if (token !== activityItemRenderToken || openActivityCardId !== card.id) return;
    body.replaceChildren();
    if (source && source.content) {
      const message = document.createElement("div");
      message.className = "act-item-message";
      const head = document.createElement("div");
      head.className = "act-item-message-head";
      head.append(activityRowAvatar(row.conversationId, source.participantLabel || row.handle));
      const who = document.createElement("span");
      who.className = "message-handle";
      who.textContent = source.participantLabel || row.handle || "";
      const when = document.createElement("span");
      when.className = "message-status";
      when.textContent = formatClockTime(source.createdAt);
      head.append(who, when);
      const content = document.createElement("div");
      content.className = "message-content markdown-text";
      renderMessageContent(content, displayedMessageText(source.content));
      message.append(head, content);
      body.append(message);
    }
    body.append(controlCardElement(card));
  }

  function settingsGroup(title, rows) {
    const section = document.createElement("section");
    const heading = document.createElement("div");
    heading.className = "set-group-title";
    heading.textContent = title;
    const group = document.createElement("div");
    group.className = "set-group";
    for (const row of rows) group.append(row);
    section.append(heading, group);
    return section;
  }

  function settingsRow(title, sub, control) {
    const row = document.createElement("div");
    row.className = "set-row";
    const copy = document.createElement("div");
    copy.className = "set-copy";
    const strong = document.createElement("span");
    strong.className = "set-title";
    strong.textContent = title;
    copy.append(strong);
    if (sub) {
      const small = document.createElement("span");
      small.className = "set-sub";
      small.textContent = sub;
      copy.append(small);
    }
    row.append(copy);
    if (control) row.append(control);
    return row;
  }

  function settingsButton(label, onClick, disabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "set-button";
    button.textContent = label;
    button.disabled = Boolean(disabled);
    button.addEventListener("click", onClick);
    return button;
  }

  /** What this phone can change about itself. Only what it can actually do:
   *  iOS does not let a web app turn its own alerts off, so they are offered
   *  while undecided and otherwise described, not drawn as a switch. */
  function renderSettings() {
    const list = document.getElementById("settings-list");
    if (!list) return;
    const permission = "Notification" in globalThis ? Notification.permission : "unsupported";
    const hubPaired = isHubPairing(loadPairing());
    const pushable = hubPaired && "Notification" in globalThis && "PushManager" in globalThis;
    const signature = JSON.stringify([permission, pushable, pushEndpointRejected, alertsReconnect, hubPaired, hubMachines]);
    if (signature === lastSettingsRenderSignature) return;
    lastSettingsRenderSignature = signature;
    list.replaceChildren();

    list.append(settingsGroup("This phone", [
      hubPaired
        ? settingsRow("Paired with your server", "Chats, replies and alerts come from your own server, with or without your Mac.")
        : settingsRow("Not paired", "Scan the code from your Mac (Settings → Device Pairing) to connect this phone.")
    ]));

    let alertsSub;
    let alertsControl;
    if (pushEndpointRejected || !pushable || permission === "unsupported") {
      alertsSub = "Not available in this browser. Messages still arrive when you open the app.";
    } else if (permission === "granted") {
      alertsSub = alertsReconnect === "working"
        ? "Reconnecting this phone to alerts\u2026"
        : alertsReconnect === "ok"
          ? "On, and reconnected to this phone just now."
          : alertsReconnect === "failed"
            ? "On, but reconnecting did not go through. Try again in a moment."
            : "On. You hear about replies and questions while the app is closed.";
      alertsControl = settingsButton("Reconnect", function (event) {
        const button = event.currentTarget;
        button.disabled = true;
        alertsReconnect = "working";
        lastSettingsRenderSignature = "";
        void render();
        void reconnectMessageAlerts().then(function (result) {
          alertsReconnect = result;
          lastSettingsRenderSignature = "";
          void render();
        });
      }, alertsReconnect === "working");
    } else if (permission === "denied") {
      alertsSub = "Off. Turn them on for AccordAgents in your phone's settings.";
    } else {
      alertsSub = "When a member replies or needs you.";
      alertsControl = settingsButton("Turn on", function (event) {
        const button = event.currentTarget;
        button.disabled = true;
        void enableMessageAlerts().finally(function () {
          lastSettingsRenderSignature = "";
          void render();
        });
      });
    }
    list.append(settingsGroup("Notifications", [settingsRow("Message alerts", alertsSub, alertsControl)]));

    if (hubPaired && hubMachines.length > 0) {
      // The server wakes a machine itself when work waits for it; the button
      // asks it to now. This phone holds no key of its own.
      list.append(settingsGroup("Machines", hubMachines.map(function (machine) {
        const state = hubMachineWake.get(machine.machineId);
        const waking = machine.waking || (state && state.status === "waking");
        const detail = state && state.detail ? state.detail
          : machine.waking ? "Starting… It appears once its runtime connects."
            : machine.wakeError ? machine.wakeError
              : machine.lastSeenAt ? "Last seen " + relativeTime(machine.lastSeenAt) + " ago." : "Asleep? Wake it to keep working.";
        return settingsRow(machine.name || "Cloud machine", detail, machine.canWake ? settingsButton(waking ? "Waking…" : "Wake", function () {
          void wakeHubMachine(machine.machineId);
        }, Boolean(waking)) : undefined);
      })));
    }
  }

  /** Leaves the opened choice at once, so its old content is not what shows
   *  when Activity comes back. */
  function closeActivityItem() {
    openActivityCardId = undefined;
    activityItemRenderToken += 1;
    const view = document.getElementById("activity-item");
    const body = document.getElementById("activity-item-body");
    if (view) view.hidden = true;
    if (body) {
      body.replaceChildren();
      delete body.dataset.signature;
    }
  }

  function wireHomeDock() {
    for (const tab of document.querySelectorAll("[data-home-tab]")) {
      tab.addEventListener("click", function () {
        const name = tab.dataset.homeTab;
        if (name === homeTab() && name === "activity") {
          // Tapping the tab you are on goes back to the top of its list.
          const list = document.getElementById("activity-list");
          if (list) list.scrollTop = 0;
        }
        void switchHomeTab(name);
      });
    }
    const back = document.getElementById("activity-item-back");
    back?.addEventListener("click", function () {
      closeActivityItem();
      showScreen("activity");
      void render();
    });
    const open = document.getElementById("activity-item-open");
    open?.addEventListener("click", function () {
      const view = document.getElementById("activity-item");
      const conversationId = view && view.dataset.conversationId;
      closeActivityItem();
      if (conversationId) void openConversation(conversationId);
    });
  }

  // --- waking a machine ------------------------------------------------------
  // The phone holds no key for any machine: it asks the User's server, which
  // starts one itself when work waits for it, and now when asked.

  // The machines the server knows, and what it says about waking each.
  let hubMachines = [];
  const hubMachineWake = new Map();

  async function refreshHubMachines() {
    if (!isHubPairing(loadPairing())) return;
    const answer = await hubPhoneGet("/v1/phone/machines", {}).catch(function () { return undefined; });
    if (answer && Array.isArray(answer.machines) && JSON.stringify(answer.machines) !== JSON.stringify(hubMachines)) {
      hubMachines = answer.machines;
      lastSettingsRenderSignature = "";
      await render();
    }
  }

  /** Asks the server to start a stopped machine now. */
  async function wakeHubMachine(machineId) {
    hubMachineWake.set(machineId, { status: "waking", detail: "Asking your server to start the machine…" });
    lastSettingsRenderSignature = "";
    await render();
    try {
      const client = hubClient();
      if (!client) throw new Error("This phone is not paired with a server.");
      const answer = await client.postJson("/v1/phone/wake", { machineId: machineId });
      hubMachineWake.set(machineId, { status: answer && answer.started ? "started" : "error",
        detail: answer && answer.message ? String(answer.message) : "Start requested." });
    } catch (error) {
      hubMachineWake.set(machineId, { status: "error", detail: "Could not reach your server: " + String(error && error.message || error) });
    }
    lastSettingsRenderSignature = "";
    await render();
    void refreshHubMachines();
  }

  let renderRevision = 0;

  async function render(connectionStatus) {
    const revision = ++renderRevision;
    const state = document.getElementById("connection-state");
    const list = document.getElementById("message-list");
    const chatsScreen = document.getElementById("chats-screen");
    const timelineScreen = document.getElementById("timeline-screen");
    const title = document.getElementById("chat-title");
    const activeId = selectedConversationId();
    if (!state || !list || !chatsScreen || !timelineScreen) {
      return;
    }
    if (list.dataset.conversationId !== (activeId || "")) {
      // Navigation changes the heading before IDB finishes. Remove the old
      // chat's rows and stream controls in the same turn, including on a failed
      // read; they must never remain actionable under the new chat's identity.
      if (list.dataset.conversationId !== undefined) {
        // A thread opened from Activity is the one place a chat is entered
        // straight into a thread; everything else starts on the main list.
        setOpenThreadRootId(pendingThreadOpen && pendingThreadOpen.conversationId === activeId ? pendingThreadOpen.rootId : undefined);
        pendingThreadOpen = undefined;
        setOpenStreamRunId(undefined);
        renderStreamView([], connectionStatus);
      }
      list.dataset.conversationId = activeId || "";
      list.replaceChildren();
      renderThreadHeader(undefined);
      state.textContent = "";
      lastRowsFingerprint = undefined;
      lastScrolledConversationId = undefined;
    }
    if (hubPairingState && (!loadHubPairing() || hubPairingState.status === "revoked")) {
      // Pairing with the server, or why it did not work: in place of the
      // chats, with the code scanner to try again.
      renderUnpairedNotice(hubPairingState.status === "pairing" ? "Pairing with your server…" : hubPairingState.message,
        "hub-" + hubPairingState.status);
      showScreen("chats");
      return;
    }
    if (!loadPairing()) {
      // A phone that held a pairing made the old way is told why it has to
      // pair again, once and plainly; the old pairing itself is gone.
      if (oldPairingCleared()) {
        renderUnpairedNotice("This phone was paired the old way. Pair it again from Settings on your Mac.", "old-pairing");
      } else {
        renderUnpairedNotice("Scan the code from your Mac (Settings → Device Pairing) to connect this phone. " +
          "An installed app has its own storage, so it pairs separately from the browser.");
      }
      showScreen("chats");
      return;
    }
    // W5: offer the doorbell once paired. iOS only grants Notification
    // permission from a user gesture, so this is a visible button, shown only
    // while permission is still undecided.
    const alertsButton = document.getElementById("enable-alerts");
    if (alertsButton) {
      const canOffer = isHubPairing(loadPairing()) &&
        "Notification" in globalThis &&
        "PushManager" in globalThis &&
        Notification.permission === "default";
      // W-K: a refused subscription replaces the offer with a plain statement.
      // Quiet-wait and alerts-will-never-arrive must not look the same.
      if (pushEndpointRejected) {
        alertsButton.hidden = false;
        alertsButton.disabled = true;
        alertsButton.dataset.alertsState = "unavailable";
        alertsButton.textContent = "Alerts aren't available in this browser. Messages still arrive when you open the app.";
      } else {
        alertsButton.dataset.alertsState = canOffer ? "offered" : "hidden";
        alertsButton.hidden = !canOffer;
      }
      if (!pushEndpointRejected && !alertsButton.dataset.wired) {
        alertsButton.dataset.wired = "1";
        alertsButton.addEventListener("click", function () {
          alertsButton.disabled = true;
          void enableMessageAlerts().finally(function () {
            if (pushEndpointRejected) {
              // The refusal arrived during this click; leave the stated
              // message the render pass just wrote instead of hiding it.
              return;
            }
            alertsButton.disabled = false;
            alertsButton.hidden = !("Notification" in globalThis) || Notification.permission !== "default";
          });
        });
      }
    }
    renderChatList();
    const openHomeTab = homeTab();
    showScreen(activeId ? "timeline" : openHomeTab);
    if (!activeId) {
      // Reopening the same chat should land at the latest message again.
      lastScrolledConversationId = undefined;
      await renderHome(openHomeTab, revision);
      return;
    }
    const activeChat = loadChats().find(function (chat) {
      return chat.id === activeId;
    });
    // Inside a thread the heading says so from the first write: the chat's
    // name set here and "Thread" set again after the reads below made the
    // heading flip on every update while a member wrote into the thread (the
    // User, 2026-09-24).
    const heading = openThreadRootId() ? "Thread" : activeChat?.title || "AccordAgents";
    if (title && title.textContent !== heading) {
      title.textContent = heading;
    }
    // The back arrows and the composer's placeholder go with the heading,
    // not after the reads.
    renderThreadHeader(openThreadRootId());
    // Looking at the chat is what reads it. A chat opened behind a locked
    // screen is not being looked at.
    if (!document.hidden) {
      markConversationRead(activeId);
    }
    renderMembersSheetIfOpen(activeChat);
    const entries = await listOutboxEntries(activeId);
    const timelineEntries = await listTimelineEntries(activeId);
    // A server update, navigation or another tab may have superseded this
    // read. Committing it would replace the current chat with the old snapshot.
    if (revision !== renderRevision || activeId !== selectedConversationId()) return;
    if (!document.hidden) {
      markConversationViewed(activeId, timelineEntries.reduce(function (newest, entry) {
        const at = entry && (entry.receivedAt || entry.createdAt);
        return typeof at === "string" && at > newest ? at : newest;
      }, ""));
    }
    // The bar is under the chat too, so its Activity number must keep up in
    // there: while a chat is open it is the only place the User is told that
    // something elsewhere is waiting. Only the number, never the lists — and
    // counted after this look at the chat is recorded, so what was just read
    // is not still counted as news.
    void refreshDockBadge(revision);
    const messageEntries = entries.filter(isMessageOutboxEntry);
    const requestedStopRunIds = new Set(entries.filter(function (entry) {
      return entry.kind === "run.cancel.requested";
    }).map(function (entry) {
      return entry.payload.runId;
    }));
    const outboxContent = new Set(messageEntries.map(function (entry) {
      return entry.payload.content.trim();
    }));
    const visibleTimelineEntries = dedupeTimelineEntries(timelineEntries.filter(function (entry) {
      return !(entry.role === "you" && outboxContent.has(entry.content.trim()));
    }));
    state.textContent = connectionStatusText(connectionStatus);
    let rows = messageEntries.map(function (entry) {
      return {
        rowKey: "outbox\0" + entry.eventId,
        id: entry.eventId,
        conversationId: entry.conversationId,
        // Shown in the thread it was written in, not in the chat behind it.
        threadRootId: entry.payload && typeof entry.payload.threadRootId === "string"
          ? entry.payload.threadRootId
          : undefined,
        author: "you",
        content: entry.payload.content,
        // A picture just sent from this phone shows in its own pending row
        // rather than only after the desktop echoes it back.
        attachments: Array.isArray(entry.payload.attachments)
          ? entry.payload.attachments.map(function (attachment, index) {
            return {
              id: "outbox:" + entry.eventId + ":" + index,
              filename: attachment.filename || "image",
              mimeType: attachment.mimeType,
              dataBase64: attachment.dataBase64
            };
          })
          : undefined,
        status: statusText(entry.status),
        onItsWay: entry.status !== "acked" && entry.status !== "refused" && entry.status !== "superseded",
        createdAt: entry.createdAt
      };
    }).concat(visibleTimelineEntries.map(function (entry) {
      return {
        rowKey: timelineRenderRowKey(entry),
        id: entry.id,
        conversationId: entry.conversationId,
        // The stored entry and the rendered row are different shapes. Carrying
        // this across is what makes a picture appear at all: it was stored and
        // then dropped here, so a message with an image rendered as text.
        attachments: entry.attachments,
        author: entry.role === "you" ? "you" : entry.role === "system" ? "system" : "agent",
        // The desktop publishes the in-progress row the moment it accepts the
        // message, before routing has picked anyone, and can only guess a
        // handle from an explicit @mention in the text. With no mention there
        // is no one to name yet — saying "Agent" with a letter avatar showed a
        // participant who does not exist and then swapped identity mid-run.
        participantLabel: entry.participantLabel || "Agent",
        identified: Boolean(entry.participantLabel),
        // Scaffolding that names nobody says one thing — "accepted, an answer
        // is coming" — and says it before anyone is picked. Rendered as a
        // message row it pretended to be a message: an avatar slot, a status, a
        // running clock, all belonging to a member who did not exist yet. It
        // gets a small indication instead.
        //
        // Scaffolding that DOES name a member ("@drew is running...") is not
        // empty — it says who is working, which is exactly what the desktop
        // shows — so it keeps the member row, the clock and the shimmer.
        scaffolding: isScaffoldingEntry(entry) && !entry.participantLabel,
        // Scaffolding stands for a message, not a run that can be stopped.
        cancellable: !isScaffoldingEntry(entry),
        content: entry.content,
        status: entry.status === "error" ? "Error" : entry.status === "done" ? "Done" : "Running",
        createdAt: entry.createdAt,
        threadRootId: entry.threadRootId,
        sourceId: entry.sourceId || entry.id,
        // W-M: the run this row belongs to, so a live row can be opened as a
        // stream and the stream can keep following it as it grows. The mobile
        // event id rides along because the answering run has a fresh id of its
        // own: the frames it streams can only be bound to this row through the
        // source event they both answer.
        runId: entry.runId,
        stopRequested: requestedStopRunIds.has(entry.runId) || stopRequestedRunIds.has(entry.runId),
        mobileEventId: entry.mobileEventId
      };
    }));
    if (isHubPairing(loadPairing())) {
      rows = rows.concat(routedRows(activeId, messageEntries, timelineEntries, requestedStopRunIds));
    }
    rows = dedupeRenderRowsByKey(rows).sort(function (left, right) {
      return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    });
    renderStreamView(rows, connectionStatus);
    const openThread = openThreadRootId();
    const grouped = groupRowsIntoThreads(rows, openThread);
    rows = grouped.rows;
    renderThreadHeader(openThread);
    renderThreadReplyAction(openThread, rows.length);
    renderLoadEarlier(activeId, openThread);
    const previousThread = lastRenderedThreadRootId;
    const sameChat = lastScrolledConversationId === activeId;
    const openedConversation = !sameChat || openThread !== previousThread;
    lastRenderedThreadRootId = openThread;
    // Where the chat was being read when a message was opened on its own
    // screen, for the way back: Slack's message screen returns to the same
    // place, and landing at the latest message instead lost the User the
    // spot she was reading in a chat of thousands of rows.
    if (sameChat && openThread && !previousThread) {
      const surface = threadSurface();
      mainListScrollTop = surface ? surface.scrollTop : undefined;
    } else if (!sameChat) {
      mainListScrollTop = undefined;
    }
    // A question stands under the message that asked it, as on the desktop:
    // in the thread when it was asked in a thread, and in its place in the
    // history when that is further up. Only what has no message, a
    // permission, waits at the end of the chat (the User, 2026-10-01: a
    // question asked in a thread stood at the bottom of the main chat).
    renderCardIndex = Object.assign(buildCardIndex(activeId), { revision: revision });
    const tailCards = pendingControlCards(activeId).filter(function (card) {
      return card.kind !== "choice" || !card.sourceMessageId;
    });
    // Each row's change check is worked out once per redraw and used twice:
    // for whether anything changed, and for which rows to patch.
    const rowSignatures = rows.map(messageRowSignature);
    const rowsFingerprint = rows.map(function (row, index) {
      return (row.rowKey || row.id) + "\u0000" + rowSignatures[index];
    }).concat(tailCards.map(controlCardSignature)).join("\u0001");
    const rowsChanged = rowsFingerprint !== lastRowsFingerprint;
    lastRowsFingerprint = rowsFingerprint;
    // Measured BEFORE the rows are mounted: appending content is itself what
    // moves the end away, so asking afterwards always answers "not at the
    // bottom" and the view would never follow anything.
    // A card field being typed in stays where the finger left it while rows
    // come and go above it. Chrome anchors the scroll itself; Safari on the
    // iPhone does not, and the field slid under the keyboard mid-word.
    const typedField = typingInChatCard() ? document.activeElement : null;
    const typedTop = typedField ? typedField.getBoundingClientRect().top : 0;
    const wasAtBottom = isNearBottom(threadSurface());
    reconcileMessageRows(list, rows, rowSignatures);
    renderTailCards(list, tailCards);
    if (typedField && typedField.isConnected && document.activeElement === typedField) {
      const drift = typedField.getBoundingClientRect().top - typedTop;
      const surface = threadSurface();
      if (surface && Math.abs(drift) >= 1) surface.scrollTop += drift;
    }
    renderCardIndex = null;
    lastScrolledConversationId = activeId;
    if (!rowsChanged && !openedConversation) {
      return;
    }
    if (openedConversation) {
      if (sameChat && !openThread && previousThread && typeof mainListScrollTop === "number") {
        // Back from a message's own screen: the same place, and the pill says
        // whether anything new waits below it.
        const surface = threadSurface();
        if (surface) {
          surface.scrollTop = mainListScrollTop;
          setJumpToLatestVisible(!isNearBottom(surface));
        }
        mainListScrollTop = undefined;
        return;
      }
      scrollToLatestWhenSettled("auto");
      return;
    }
    // A card being typed in stays under the finger: following the end would
    // scroll the field away mid-word, now that cards are in the chat.
    if (typingInChatCard()) {
      setJumpToLatestVisible(!isNearBottom(threadSurface()));
      return;
    }
    // Whoever is at the end is following the conversation, so the view follows
    // too: the indication that a reply is coming, and the reply itself, arrive
    // in sight instead of below the fold. Reading history is the opposite
    // intent — leaving the end is the reader's decision and nothing may undo
    // it, so the pill offers the way back rather than taking it.
    if (wasAtBottom) {
      scrollToLatestWhenSettled("auto");
      return;
    }
    setJumpToLatestVisible(true);
  }

  // W-M(b,c,e,f): the live reply, rendered in its own view.
  //
  // There is no new pipeline here: the accumulated text is already what the
  // in-progress row carries, so opening the view mid-run shows everything so
  // far by construction, and every later ingest updates it through the same
  // render pass as the timeline.
  function renderStreamView(rows, connectionStatus) {
    const view = document.getElementById("stream-view");
    const body = document.getElementById("stream-body");
    const label = document.getElementById("stream-label");
    const state = document.getElementById("stream-state");
    const stop = document.getElementById("stream-stop");
    if (!view || !body || !label || !state || !stop) {
      return;
    }
    const follow = openStreamFollow();
    if (!follow) {
      view.hidden = true;
      return;
    }
    // Match by run id OR by the source's mobile event id, and prefer the
    // newest match: the placeholder row and the growing reply both answer the
    // same event, and the reply is the one worth showing.
    let row;
    for (const candidate of rows) {
      if (candidate.author !== "agent") {
        continue;
      }
      if (candidate.runId === follow.runId ||
        (follow.mobileEventId && candidate.mobileEventId === follow.mobileEventId)) {
        row = candidate;
      }
    }
    if (!row) {
      // The run is gone entirely — nothing honest left to show.
      setOpenStreamRunId(undefined);
      view.hidden = true;
      return;
    }
    view.hidden = false;
    label.textContent = row.participantLabel || "Agent";
    stop.hidden = !isCancellableMobileRow(row);
    stop.disabled = row.stopRequested === true;
    stop.dataset.runId = row.runId || "";
    stop.textContent = row.stopRequested ? "Stopping…" : "Stop";
    stop.setAttribute("aria-label", "Stop response from " + (row.participantLabel || "Agent"));
    // (e) When the run finishes the view stays and shows the finished answer;
    // leaving is the reader's decision, not ours.
    state.textContent = row.status === "Running"
      ? (connectionStatus === "synced" || connectionStatus === undefined ? "Writing…" : "Writing… (reconnecting)")
      : row.status;
    const text = isThinkingEntry(row) ? "" : displayedMessageText(row.content, "agent");
    if (body.dataset.text !== text) {
      body.dataset.text = text;
      body.textContent = text || "Nothing written yet.";
      // Follow the tail only while the reader is already at it.
      if (body.dataset.pinned !== "0") {
        body.scrollTop = body.scrollHeight;
      }
    }
  }

  function wireStreamView() {
    const view = document.getElementById("stream-view");
    const body = document.getElementById("stream-body");
    const close = document.getElementById("stream-close");
    const stop = document.getElementById("stream-stop");
    const list = document.getElementById("message-list");
    if (!view || !body || !close || !stop || !list || view.dataset.wired === "1") {
      return;
    }
    view.dataset.wired = "1";
    close.addEventListener("click", function () {
      setOpenStreamRunId(undefined);
      view.hidden = true;
    });
    stop.addEventListener("click", function () {
      const runId = stop.dataset.runId;
      if (!runId || stop.disabled) {
        return;
      }
      stop.disabled = true;
      stop.textContent = "Stopping…";
      void stopRunFromPhone(runId);
    });
    // Scrolling away from the tail stops the view yanking itself back down.
    body.addEventListener("scroll", function () {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
      body.dataset.pinned = atBottom ? "1" : "0";
    });
    list.addEventListener("click", function (event) {
      const row = event.target && event.target.closest ? event.target.closest(".message-row") : undefined;
      if (!row) {
        return;
      }
      // A card under a message is answered where it stands: a tap on it is
      // never a tap on the row, live or not.
      if (event.target.closest(".control-card")) {
        return;
      }
      // (f) A row that cannot be followed says why instead of opening a view
      // that would sit there empty.
      if (row.dataset.streamBlocked) {
        flashRowNotice(row, "No live connection");
        return;
      }
      if (row.dataset.streamable !== "1") {
        // Slack's shape, which the User asked for: a message opens on its own
        // screen, and the offer to answer it in a thread lives there rather
        // than under every message in the chat.
        // A tap meant for something inside the row -- a picture, a card, a
        // button, a link -- is not a tap on the message.
        const interactive = event.target && event.target.closest
          ? event.target.closest("button, a, img, input, textarea, select, label, .control-card")
          : undefined;
        if (interactive) {
          return;
        }
        const threadRoot = row.dataset.threadRoot;
        if (threadRoot && !openThreadRootId()) {
          setOpenThreadRootId(threadRoot);
          void render();
        }
        return;
      }
      const runId = row.dataset.streamRunId;
      if (!runId) {
        return;
      }
      setOpenStreamRunId(runId, row.dataset.streamMobileEventId || undefined);
      body.dataset.pinned = "1";
      body.dataset.text = "";
      void render();
    });
  }

  // W-M(a): only a live agent row with a run to follow can be opened. Applied
  // on create AND on update, because a row that ends while on screen is updated
  // in place and would otherwise keep advertising a run that is over.
  // W-M(f): a row can be followed live only when it already carries real text
  // the view can honestly show; otherwise the view would sit empty until the
  // server's progress brings some.
  function applyStreamableState(item, entry) {
    if (entry.scaffolding) {
      delete item.dataset.streamable;
      delete item.dataset.streamRunId;
      delete item.dataset.streamMobileEventId;
      delete item.dataset.streamBlocked;
      return;
    }
    if (entry.author === "agent" && entry.status === "Running" && entry.runId) {
      const followable = Boolean((entry.content || "").trim() && !isPlaceholderTimelineContent(entry.content));
      if (followable) {
        item.dataset.streamable = "1";
        item.dataset.streamRunId = entry.runId;
        delete item.dataset.streamBlocked;
      } else {
        delete item.dataset.streamable;
        delete item.dataset.streamRunId;
        item.dataset.streamBlocked = "no-live-connection";
      }
      if (entry.mobileEventId) {
        item.dataset.streamMobileEventId = entry.mobileEventId;
      } else {
        delete item.dataset.streamMobileEventId;
      }
      return;
    }
    delete item.dataset.streamable;
    delete item.dataset.streamRunId;
    delete item.dataset.streamMobileEventId;
    delete item.dataset.streamBlocked;
  }

  function messageRowSignature(entry) {
    return JSON.stringify({
      replyCount: entry.replyCount,
      author: entry.author,
      participantLabel: entry.participantLabel,
      avatar: entry.author === "agent" && entry.identified !== false ? avatarSignature(rowAvatar(entry)) : undefined,
      identified: entry.identified,
      scaffolding: entry.scaffolding,
      content: entry.content,
      answered: answeredCardsForMessage(entry).map(function (card) {
        return card.id + ":" + (card.outcome || "");
      }),
      pending: pendingCardsForMessage(entry).map(controlCardSignature),
      attachments: Array.isArray(entry.attachments)
        ? entry.attachments.map(function (attachment) { return attachment.id; })
        : undefined,
      status: entry.status,
      when: formatClockTime(entry.createdAt),
      runId: entry.runId,
      stopRequested: entry.stopRequested
    });
  }

  // A pending agent row with no text yet is a run that has started and not
  // produced output. The desktop shows an animated "Thinking" plus elapsed
  // time; match it rather than the flat placeholder sentence.
  function isThinkingEntry(entry) {
    return entry.author === "agent" &&
      entry.status === "Running" &&
      /\bis running\.\.\.$|^Running\.\.\.$/.test((entry.content || "").trim());
  }

  // W-M(f): the stated reason lives on the row itself for a moment — no
  // modal, no view that would hang empty.
  function flashRowNotice(row, text) {
    const status = row.querySelector(".message-status");
    if (!status || status.dataset.noticeTimer) {
      return;
    }
    const original = status.textContent;
    status.dataset.noticeTimer = "1";
    status.textContent = text;
    setTimeout(function () {
      delete status.dataset.noticeTimer;
      status.textContent = original;
    }, 1600);
  }

  function renderThinkingInto(container, entry) {
    if (container.dataset.thinking === "1") {
      return;
    }
    container.dataset.thinking = "1";
    container.textContent = "";
    const label = document.createElement("span");
    label.className = "thinking-label";
    label.textContent = "Thinking";
    const elapsed = document.createElement("span");
    elapsed.className = "thinking-elapsed";
    elapsed.dataset.startedAt = entry.createdAt || nowIso();
    elapsed.textContent = formatElapsed(entry.createdAt);
    container.append(label, elapsed);
  }

  function formatElapsed(startedAt) {
    const started = Date.parse(startedAt || "");
    const total = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
  }

  // Only the seconds text is touched, never the row, so ticking cannot cause
  // the list churn that made the view jump.
  function startThinkingClock() {
    clearInterval(activeThinkingClockTimer);
    activeThinkingClockTimer = setInterval(function () {
      for (const node of document.querySelectorAll(".thinking-elapsed")) {
        const next = formatElapsed(node.dataset.startedAt);
        if (node.textContent !== next) {
          node.textContent = next;
        }
      }
    }, 1000);
  }

  // The slot is held either way so the row does not jump sideways when the
  // participant becomes known; it simply carries no identity until then.
  // Same clock the desktop prints under a message. A finished message says
  // when it was written; only a message still in flight says what it is doing.
  // One formatter for every row: toLocaleTimeString builds a new one per
  // call, and every row's change check asks for its time on every redraw —
  // the single largest cost of drawing a chat, which a send waited behind.
  let clockFormatter;

  function formatClockTime(iso) {
    const time = Date.parse(iso || "");
    if (!Number.isFinite(time)) {
      return "";
    }
    if (!clockFormatter) clockFormatter = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false });
    return clockFormatter.format(new Date(time));
  }

  function messageStatusLabel(entry) {
    // A message still on its way says nothing about it; it is faded instead
    // (the User, 2026-09-24).
    if (entry.onItsWay) {
      return formatClockTime(entry.createdAt) || "";
    }
    if (entry.status === "Done" || entry.status === "Sent") {
      return formatClockTime(entry.createdAt) || entry.status;
    }
    return entry.status;
  }

  function rowHandleText(entry) {
    return entry.identified === false ? "" : (entry.participantLabel || "Agent");
  }

  // The member list can arrive after the row did, and a member's picture can
  // change on the desktop; the row's signature carries the resolved avatar so
  // the row is patched when either happens.
  function rowAvatar(entry) {
    const conversationId = entry.conversationId || selectedConversationId();
    return avatarForLabel(conversationMembers(conversationId), entry.participantLabel || "Agent");
  }

  function applyRowIdentity(avatar, entry) {
    if (entry.identified === false) {
      if (avatar.dataset.avatarSignature !== "") {
        avatar.textContent = "";
        avatar.removeAttribute("style");
        clearAvatarKindClasses(avatar);
        avatar.dataset.avatarSignature = "";
        delete avatar.dataset.avatarLoaded;
      }
      avatar.dataset.identified = "0";
      return;
    }
    const conversationId = entry.conversationId || selectedConversationId();
    paintAvatar(avatar, rowAvatar(entry), conversationId);
    avatar.dataset.identified = "1";
  }

  function renderScaffoldingInto(item) {
    const dots = document.createElement("div");
    dots.className = "message-typing";
    dots.setAttribute("role", "status");
    dots.setAttribute("aria-label", "Waiting for a reply");
    for (let index = 0; index < 3; index += 1) {
      dots.append(document.createElement("span"));
    }
    item.append(dots);
  }

  /** How long after a message a member it was for may still be shown as
   *  not started yet. */
  const ROUTED_ROW_MAX_MS = 30 * 60_000;

  /**
   * A member a message from this phone is for, whose home has not started it
   * yet: shown under the message as waiting for that home ("waking" while the
   * server is starting its machine), with Stop, which names the turn's own
   * run id so its home never starts it. Gone once the home's own row for the
   * turn arrives.
   */
  function routedRows(conversationId, messageEntries, timelineEntries, requestedStopRunIds) {
    const chat = loadChats().find(function (item) { return item.id === conversationId; });
    const members = chat && Array.isArray(chat.members) ? chat.members : [];
    const runIds = new Set(timelineEntries.map(function (entry) { return entry.runId; }).filter(Boolean));
    const stoppedLines = timelineEntries.filter(function (entry) {
      return entry.role === "system" && /stopped by user\.$/.test(String(entry.content || ""));
    });
    const rows = [];
    for (const entry of messageEntries) {
      if (!entry.hub || !entry.hubDelivery || !Array.isArray(entry.hubDelivery.targets)) continue;
      if (Date.now() - Date.parse(entry.createdAt) > ROUTED_ROW_MAX_MS) continue;
      for (const participantId of entry.hubDelivery.targets) {
        const runId = globalThis.AccordHubClient.phoneTurnRunId(entry.eventId, participantId);
        if (runIds.has(runId)) continue;
        const member = members.find(function (item) { return item.id === participantId; });
        if (!member) continue;
        const label = "@" + member.handle;
        if (stoppedLines.some(function (line) { return line.content.indexOf(label + " stopped") === 0 && line.createdAt >= entry.createdAt; })) continue;
        const machine = member.homeMachineId ? hubMachines.find(function (item) { return item.machineId === member.homeMachineId; }) : undefined;
        const where = member.homeMachineName || (machine && machine.name) || "its machine";
        // Not on the server yet (offline): nobody can start it, so the row
        // says what the message itself says.
        const content = entry.status !== "acked" ? "Waiting to sync…"
          : !member.homeMachineId ? "Waiting for your Mac to start it…"
          : machine && machine.waking ? "Waking " + where + "…" : "Waiting for " + where + "…";
        rows.push({
          rowKey: "routed\0" + runId,
          id: runId,
          conversationId: conversationId,
          threadRootId: entry.payload && typeof entry.payload.threadRootId === "string" ? entry.payload.threadRootId : undefined,
          author: "agent",
          participantLabel: label,
          identified: true,
          scaffolding: false,
          cancellable: true,
          content: content,
          status: "Running",
          createdAt: entry.createdAt + "~",
          sourceId: runId,
          runId: runId,
          routed: true,
          stopRequested: requestedStopRunIds.has(runId) || stopRequestedRunIds.has(runId)
        });
      }
    }
    return rows;
  }

  function isCancellableMobileRow(entry) {
    return entry.author === "agent" &&
      entry.status === "Running" &&
      Boolean(entry.runId) &&
      entry.cancellable !== false;
  }

  function syncMessageStopButton(meta, entry) {
    let button = meta.querySelector(".message-stop");
    const visible = isCancellableMobileRow(entry);
    if (!visible) {
      button?.remove();
      return;
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "message-stop";
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        const targetRunId = button.dataset.runId;
        if (!targetRunId || button.disabled) {
          return;
        }
        button.disabled = true;
        button.textContent = "Stopping…";
        void stopRunFromPhone(targetRunId);
      });
      meta.append(button);
    }
    button.dataset.runId = entry.runId;
    button.disabled = entry.stopRequested === true;
    button.textContent = entry.stopRequested ? "Stopping…" : "Stop";
    button.setAttribute("aria-label", "Stop response from " + rowHandleText(entry));
  }

  function createMessageRow(entry) {
    const item = document.createElement("li");
    item.className = "message-row";
    item.dataset.rowKey = entry.rowKey || entry.id;
    item.dataset.rowSignature = messageRowSignature(entry);
    item.dataset.status = entry.status;
    item.dataset.author = entry.author;
    // Which message this row is, for the screen a tap opens. Rows with nothing
    // the desktop can thread from -- scaffolding, a message still queued on
    // this phone -- carry none, so a tap on them does nothing.
    // Not a system note: the desktop offers a thread on every message but
    // those, and the phone offers exactly what the desktop does.
    if (entry.sourceId && !entry.scaffolding && entry.status !== "queued" && entry.author !== "system") {
      item.dataset.threadRoot = entry.sourceId;
    } else {
      delete item.dataset.threadRoot;
    }
    applyStreamableState(item, entry);
    if (entry.scaffolding) {
      item.dataset.scaffolding = "1";
      renderScaffoldingInto(item);
      return item;
    }
    if (entry.author === "agent") {
      const avatar = document.createElement("div");
      avatar.className = "message-avatar";
      applyRowIdentity(avatar, entry);
      const copy = document.createElement("div");
      copy.className = "message-copy";
      const meta = document.createElement("div");
      meta.className = "message-meta";
      const handle = document.createElement("span");
      handle.className = "message-handle";
      handle.textContent = rowHandleText(entry);
      const status = document.createElement("span");
      status.className = "message-status";
      status.textContent = messageStatusLabel(entry);
      const content = document.createElement("div");
      content.className = "message-content";
      if (isThinkingEntry(entry)) {
        renderThinkingInto(content, entry);
      } else {
        renderMessageContentIfChanged(content, entry.content, entry.author);
      }
      meta.append(handle, status);
      syncMessageStopButton(meta, entry);
      copy.append(meta, content);
      renderAttachmentsInto(attachmentsNodeFor(copy), entry);
      syncAnsweredCards(copy, entry);
      syncPendingCards(copy, entry);
      item.append(avatar, copy);
    } else {
      item.classList.toggle("is-on-its-way", Boolean(entry.onItsWay));
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      const content = document.createElement("div");
      content.className = "message-content";
      renderMessageContentIfChanged(content, entry.content, entry.author);
      const meta = document.createElement("div");
      meta.className = "message-status";
      meta.textContent = messageStatusLabel(entry);
      bubble.append(content, meta);
      renderAttachmentsInto(attachmentsNodeFor(bubble), entry);
      item.append(bubble);
    }
    appendThreadChip(item, entry);
    return item;
  }

  /** The question the User already answered stays with its own message, the
   *  way the desktop keeps the answered card under it; without this the phone
   *  would hide the protocol block from the bubble and leave no trace of what
   *  was asked or what was chosen (the User, 2026-09-20). */
  function answeredCardsForMessage(entry) {
    return cardsForMessage(entry).filter(function (card) {
      return card.status !== "pending" && card.kind === "choice";
    });
  }

  // The chat's cards by the message they belong to, read once per render: a
  // chat keeps every choice ever asked, and each row asks several times.
  let renderCardIndex = null;

  function cardIndexFor(conversationId) {
    // Only the render that built it may use it: a render cut short cannot
    // leave a stale index behind for the next one.
    if (renderCardIndex && renderCardIndex.conversationId === conversationId &&
      renderCardIndex.revision === renderRevision) return renderCardIndex;
    return buildCardIndex(conversationId);
  }

  function typingInChatCard() {
    const active = document.activeElement;
    return Boolean(active && active.tagName === "TEXTAREA" && active.closest && active.closest("#message-list .control-card"));
  }

  function buildCardIndex(conversationId) {
    const byMessage = new Map();
    const pending = [];
    for (const card of controlCardsFor(conversationId)) {
      if (!card) continue;
      if (card.status === "pending") pending.push(card);
      if (!card.sourceMessageId) continue;
      const list = byMessage.get(card.sourceMessageId);
      if (list) list.push(card);
      else byMessage.set(card.sourceMessageId, [card]);
    }
    return { conversationId: conversationId, byMessage: byMessage, pending: pending };
  }

  function cardsForMessage(entry) {
    if (!entry || entry.author !== "agent" || entry.scaffolding) return [];
    const conversationId = selectedConversationId();
    if (!conversationId) return [];
    const messageId = entry.messageId || entry.sourceId || entry.id;
    if (!messageId) return [];
    return cardIndexFor(conversationId).byMessage.get(messageId) || [];
  }

  /** The choices still waiting under this message. */
  function pendingCardsForMessage(entry) {
    return cardsForMessage(entry).filter(function (card) {
      return card.status === "pending" && card.kind === "choice";
    });
  }

  function answeredCardElement(card) {
    return compactCardElement(card, card.outcome || "", "control-card-answered", "Answered: ");
  }

  /** A choice or permission that is done with, folded to what was answered. */
  function compactCardElement(card, outcome, className, label) {
    const wrap = document.createElement("article");
    wrap.className = "control-card " + className;
    wrap.dataset.cardId = card.id;
    wrap.dataset.cardKind = card.kind;
    const head = document.createElement("div");
    head.className = "control-card-head";
    const title = document.createElement("span");
    title.className = "control-card-title";
    // Headed as the live card is, now that a permission folds as well.
    title.textContent = card.title || (card.kind === "permission" ? "Permission request" : "Choice");
    head.append(title);
    if (card.requesterLabel || card.machineName) {
      const who = document.createElement("span");
      who.className = "control-card-who";
      who.textContent = [card.requesterLabel, card.machineName].filter(Boolean).join(" · ");
      head.append(who);
    }
    wrap.append(head);
    if (card.summary) {
      const summary = document.createElement("p");
      summary.className = "control-card-summary";
      summary.textContent = card.summary;
      wrap.append(summary);
    }
    const state = document.createElement("p");
    state.className = "control-card-state";
    state.textContent = outcome === "Cancelled" ? "Cancelled" : outcome ? label + outcome : "";
    state.hidden = !state.textContent;
    wrap.append(state);
    return wrap;
  }

  /** Idempotent: the same message redrawn keeps its node unless the answer
   *  itself changed. */
  function syncAnsweredCards(container, entry) {
    const cards = answeredCardsForMessage(entry);
    const signature = cards.map(function (card) { return card.id + ":" + (card.outcome || ""); }).join("|");
    if (container.dataset.answeredCards === signature) return;
    container.dataset.answeredCards = signature;
    for (const node of container.querySelectorAll(".control-card-answered")) {
      node.remove();
    }
    for (const card of cards) {
      container.append(answeredCardElement(card));
    }
  }

  /** What a row's replies chip says; empty when it has no replies. */
  function threadChipLabel(entry) {
    if (!entry.replyCount) return "";
    return entry.replyCount === 1 ? "1 reply" : entry.replyCount + " replies";
  }

  function appendThreadChip(item, entry) {
    const threadRoot = entry.sourceId;
    if (!entry.replyCount) {
      return;
    }
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "thread-chip";
    chip.dataset.threadRoot = threadRoot;
    chip.textContent = threadChipLabel(entry);
    chip.addEventListener("click", function () {
      setOpenThreadRootId(threadRoot);
      void render();
    });
    item.append(chip);
  }

  /** A row patched in place keeps its replies' chip in step: drawn before
   *  its first reply was stored (a redraw between two rows of one batch), it
   *  never got the chip, and the thread could not be opened from it. */
  function syncThreadChip(item, entry) {
    const chip = Array.from(item.children).find(function (child) { return child.classList.contains("thread-chip"); });
    if (chip && chip.textContent === threadChipLabel(entry) && chip.dataset.threadRoot === entry.sourceId) return;
    if (chip) chip.remove();
    appendThreadChip(item, entry);
  }

  function updateMessageRow(item, entry) {
    if (item.dataset.author !== entry.author) {
      return false;
    }
    // Scaffolding and a message are different shapes; the reconciler replaces
    // the node rather than trying to morph one into the other.
    if ((item.dataset.scaffolding === "1") !== Boolean(entry.scaffolding)) {
      return false;
    }
    if (entry.scaffolding) {
      item.dataset.rowSignature = messageRowSignature(entry);
      item.dataset.status = entry.status;
      return true;
    }
    item.dataset.rowSignature = messageRowSignature(entry);
    item.dataset.status = entry.status;
    // Not a system note: the desktop offers a thread on every message but
    // those, and the phone offers exactly what the desktop does.
    if (entry.sourceId && !entry.scaffolding && entry.status !== "queued" && entry.author !== "system") {
      item.dataset.threadRoot = entry.sourceId;
    } else {
      delete item.dataset.threadRoot;
    }
    // Rows are updated in place, so this has to be re-applied here too: a row
    // that finished while on screen must stop looking openable.
    applyStreamableState(item, entry);
    if (entry.author === "agent") {
      const avatar = item.querySelector(".message-avatar");
      const handle = item.querySelector(".message-handle");
      const status = item.querySelector(".message-status");
      const content = item.querySelector(".message-content");
      if (!avatar || !handle || !status || !content) {
        return false;
      }
      applyRowIdentity(avatar, entry);
      handle.textContent = rowHandleText(entry);
      status.textContent = messageStatusLabel(entry);
      const meta = status.parentElement;
      if (!meta) {
        return false;
      }
      syncMessageStopButton(meta, entry);
      renderMessageContentIfChanged(content, entry.content, entry.author);
      renderAttachmentsInto(attachmentsNodeFor(content.parentElement || item), entry);
      // A question answered while its row is on screen keeps its card there.
      syncAnsweredCards(content.parentElement || item, entry);
      syncPendingCards(content.parentElement || item, entry);
      syncThreadChip(item, entry);
      return true;
    }
    const status = item.querySelector(".message-status");
    const content = item.querySelector(".message-content");
    if (!status || !content) {
      return false;
    }
    item.classList.toggle("is-on-its-way", Boolean(entry.onItsWay));
    status.textContent = messageStatusLabel(entry);
    renderMessageContentIfChanged(content, entry.content, entry.author);
    renderAttachmentsInto(attachmentsNodeFor(content.parentElement || item), entry);
    syncThreadChip(item, entry);
    return true;
  }

  // Nodes are consumed, not looked up by key. The old sweep asked "is this
  // node's key still wanted?", which keeps EVERY node carrying a wanted key —
  // so once two nodes ended up sharing one key, the loser was unreachable and
  // stayed on screen forever, showing an answer or a "Thinking" that the store
  // no longer had. Consuming one node per rendered row and removing whatever is
  // left over cannot leave an orphan behind, whatever the keys look like.
  function reconcileMessageRows(list, rows, signatures) {
    const existing = new Map();
    for (const child of Array.from(list.children)) {
      if (child.id === "control-cards") continue;
      const bucket = existing.get(child.dataset.rowKey);
      if (bucket) {
        bucket.push(child);
      } else {
        existing.set(child.dataset.rowKey, [child]);
      }
    }
    // Which node each row takes, decided before anything moves. The nodes no
    // row takes leave first: removed at the end instead, they made every row
    // below them move, and a moved row takes the focus, and the keyboard, from
    // a card being typed in under its message.
    const claimed = rows.map(function (entry) {
      const bucket = existing.get(entry.rowKey || entry.id);
      return bucket && bucket.length > 0 ? bucket.shift() : undefined;
    });
    const kept = new Set(claimed.filter(Boolean));
    for (const child of Array.from(list.children)) {
      if (!kept.has(child) && child.id !== "control-cards") {
        child.remove();
      }
    }
    let cursor = list.firstElementChild;
    rows.forEach(function (entry, index) {
      let item = claimed[index];
      if (!item || item.dataset.rowSignature !== (signatures ? signatures[index] : messageRowSignature(entry))) {
        if (item && updateMessageRow(item, entry)) {
          // Keep the existing DOM node mounted so PWA updates do not flash.
        } else {
          const replacement = createMessageRow(entry);
          if (item) {
            const wasCursor = item === cursor;
            item.replaceWith(replacement);
            if (wasCursor) {
              cursor = replacement;
            }
          }
          item = replacement;
        }
      }
      if (item !== cursor) {
        list.insertBefore(item, cursor);
      }
      cursor = item.nextElementSibling;
    });
  }

  // --- members of the open chat ---------------------------------------------
  // Everything shown here is already on the phone: the chat list carries each
  // member's role and home machine. Nothing is asked of the desktop.

  let membersSheetOpen = false;

  function memberKindLabel(kind) {
    if (kind === "claude-code") {
      return "Claude Code";
    }
    if (kind === "codex-cli") {
      return "Codex CLI";
    }
    if (kind === "gemini-cli") {
      return "Gemini CLI";
    }
    return "";
  }

  // Same wording as the desktop's run-location control, from the phone's
  // point of view: the desktop is "local".
  function memberLocationLabel(member) {
    if (member.homeMachineId) {
      return member.homeMachineName || "Machine";
    }
    return "Local · desktop";
  }

  function renderMembersSheet(chat) {
    const sheet = document.getElementById("members-sheet");
    const list = document.getElementById("members-sheet-list");
    const title = document.getElementById("members-sheet-title");
    const toggle = document.getElementById("chat-members-toggle");
    if (!sheet || !list) {
      return;
    }
    sheet.hidden = !membersSheetOpen;
    keepingReaderAtLatest(applyDock);
    if (toggle) {
      toggle.setAttribute("aria-expanded", membersSheetOpen ? "true" : "false");
    }
    if (!membersSheetOpen) {
      return;
    }
    const members = chat ? selectedConversationMembers() : [];
    if (title) {
      title.textContent = members.length === 1 ? "1 member" : members.length + " members";
    }
    list.replaceChildren();
    if (members.length === 0) {
      const empty = document.createElement("div");
      empty.className = "members-sheet-empty";
      empty.textContent = "No members in this chat yet.";
      list.append(empty);
      return;
    }
    members.forEach(function (member) {
      const row = document.createElement("div");
      row.className = "members-sheet-row";
      row.dataset.handle = member.handle;
      const avatar = document.createElement("span");
      avatar.className = "mobile-mention-avatar";
      paintAvatar(avatar, avatarForMember(member), selectedConversationId());
      const copy = document.createElement("span");
      copy.className = "members-sheet-copy";
      const name = document.createElement("strong");
      name.textContent = member.displayName;
      const role = document.createElement("span");
      role.className = "members-sheet-role";
      role.textContent = [member.roleLabel, memberKindLabel(member.kind)].filter(Boolean).join(" · ");
      const location = document.createElement("span");
      location.className = "members-sheet-location";
      location.textContent = memberLocationLabel(member);
      copy.append(name, role, location);
      row.append(avatar, copy);
      list.append(row);
    });
  }

  function renderMembersSheetIfOpen(chat) {
    if (membersSheetOpen) {
      renderMembersSheet(chat);
    }
  }

  function activeChatRecord() {
    const conversationId = selectedConversationId();
    return loadChats().find(function (chat) {
      return chat.id === conversationId;
    });
  }

  function openMembersSheet() {
    membersSheetOpen = true;
    renderMembersSheet(activeChatRecord());
  }

  function closeMembersSheet() {
    membersSheetOpen = false;
    renderMembersSheet(undefined);
  }

  function wireMembersSheet() {
    const toggle = document.getElementById("chat-members-toggle");
    const sheet = document.getElementById("members-sheet");
    const close = document.getElementById("members-sheet-close");
    if (!toggle || !sheet) {
      return;
    }
    toggle.addEventListener("click", function () {
      if (!selectedConversationId()) {
        return;
      }
      if (membersSheetOpen) {
        closeMembersSheet();
      } else {
        openMembersSheet();
      }
    });
    close?.addEventListener("click", closeMembersSheet);
    sheet.addEventListener("click", function (event) {
      if (event.target instanceof Element && event.target.dataset.membersClose === "1") {
        closeMembersSheet();
      }
    });
  }

  // --- earlier messages -----------------------------------------------------
  // The desktop answers a timeline request with its last page and says whether
  // there is more before it. Each tap asks for the page before the oldest
  // message the phone was given, and the view stays where the reader was.

  let loadEarlierBusy = false;

  function renderLoadEarlier(conversationId, openThread) {
    const button = document.getElementById("load-earlier");
    if (!button) {
      return;
    }
    const page = conversationId ? timelinePageFor(conversationId) : undefined;
    const pairing = loadPairing();
    const show = Boolean(page && page.hasMoreBefore && page.beforeMessageId) &&
      !openThread &&
      Boolean(pairing && canSync(pairing));
    button.hidden = !show;
    button.disabled = loadEarlierBusy;
    button.textContent = loadEarlierBusy ? "Loading…" : "Show earlier messages";
  }

  async function loadEarlierMessages() {
    const conversationId = selectedConversationId();
    const pairing = loadPairing();
    const page = conversationId ? timelinePageFor(conversationId) : undefined;
    if (!conversationId || !pairing || !canSync(pairing) || !page || !page.beforeMessageId || loadEarlierBusy) {
      return;
    }
    loadEarlierBusy = true;
    renderLoadEarlier(conversationId, openThreadRootId());
    const surface = threadSurface();
    const heightBefore = surface ? surface.scrollHeight : 0;
    const topBefore = surface ? surface.scrollTop : 0;
    let failed = false;
    try {
      await requestTimelineViaRelay(pairing, conversationId, {
        beforeMessageId: page.beforeMessageId,
        deferRender: true
      });
    } catch {
      failed = true;
    } finally {
      loadEarlierBusy = false;
    }
    if (selectedConversationId() !== conversationId) {
      return;
    }
    await render(failed ? "tunnel-reconnecting" : "synced");
    if (surface && !failed) {
      // Rows were added above the reader. Keep the message they were looking at
      // exactly where it was instead of letting the list jump under them.
      surface.scrollTop = topBefore + (surface.scrollHeight - heightBefore);
      setJumpToLatestVisible(!isNearBottom(surface));
    }
  }

  // --- pull to refresh ------------------------------------------------------
  // A downward drag from the very top of a list asks the desktop again. This
  // is the only manual refresh the phone has; before it, "Waiting to sync"
  // could only be waited out.

  const PULL_REFRESH_ARM_PX = 56;
  const PULL_REFRESH_MAX_PX = 84;

  function attachPullToRefresh(scroller, indicator, refresh) {
    if (!scroller || !indicator) {
      return;
    }
    let startY;
    let pulling = false;
    let distance = 0;
    let busy = false;
    function settle() {
      indicator.style.height = "0px";
      indicator.classList.remove("is-armed");
      distance = 0;
    }
    scroller.addEventListener("touchstart", function (event) {
      if (busy || scroller.scrollTop > 0 || event.touches.length !== 1) {
        pulling = false;
        return;
      }
      startY = event.touches[0].clientY;
      pulling = true;
      distance = 0;
    }, { passive: true });
    scroller.addEventListener("touchmove", function (event) {
      if (!pulling || busy) {
        return;
      }
      const dy = event.touches[0].clientY - startY;
      if (dy <= 0 || scroller.scrollTop > 0) {
        settle();
        return;
      }
      distance = Math.min(PULL_REFRESH_MAX_PX, dy * 0.55);
      indicator.style.height = distance + "px";
      indicator.classList.toggle("is-armed", distance >= PULL_REFRESH_ARM_PX);
    }, { passive: true });
    async function finish() {
      if (!pulling) {
        return;
      }
      pulling = false;
      if (distance < PULL_REFRESH_ARM_PX || busy) {
        settle();
        return;
      }
      busy = true;
      indicator.classList.add("is-refreshing");
      indicator.style.height = PULL_REFRESH_ARM_PX + "px";
      try {
        await refresh();
      } finally {
        busy = false;
        indicator.classList.remove("is-refreshing");
        settle();
      }
    }
    scroller.addEventListener("touchend", function () {
      void finish();
    });
    scroller.addEventListener("touchcancel", function () {
      pulling = false;
      settle();
    });
  }

  async function refreshChatList() {
    const pairing = loadPairing();
    if (!pairing || !canSync(pairing)) {
      await render();
      return;
    }
    try {
      await requestChatListViaRelay(pairing);
      await render("synced");
    } catch {
      await render("tunnel-reconnecting");
    }
  }

  async function refreshOpenTimeline() {
    const pairing = loadPairing();
    const conversationId = selectedConversationId();
    if (!pairing || !canSync(pairing) || !conversationId) {
      await render();
      return;
    }
    try {
      await whileLookingForMessages(async function () {
        await requestTimelineViaRelay(pairing, conversationId);
      });
      await render("synced");
    } catch {
      await render("tunnel-reconnecting");
    }
  }

  // --- coming back to the app -----------------------------------------------
  // iOS freezes the page in the background, and a request that was waiting
  // for news when it froze is usually dead. Coming back asks the server
  // straight away.

  let hiddenSince;
  let foregroundResyncPromise;

  function resyncAfterForeground() {
    if (foregroundResyncPromise) {
      return foregroundResyncPromise;
    }
    foregroundResyncPromise = (async function () {
      const awayMs = hiddenSince ? Date.now() - hiddenSince : 0;
      hiddenSince = undefined;
      recordRelayDebug({ event: "foreground-resync", awayMs });
      await adoptWorkerUnread();
      const pairing = loadPairing();
      if (!pairing || !canSync(pairing)) {
        await render();
        return;
      }
      // Back in front: what was missed is read from the server, and what
      // this phone still owes it goes.
      await flushOutbox().catch(function () { return undefined; });
      await requestChatListViaRelay(pairing).catch(function () { return []; });
      const openId = selectedConversationId();
      if (openId) await requestTimelineViaRelay(pairing, openId).catch(function () { return 0; });
      startServerChanges();
      void markHubNoticesSeen();
      await render("synced");
    })().finally(function () {
      foregroundResyncPromise = undefined;
    });
    return foregroundResyncPromise;
  }

  function wireForegroundResync() {
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        hiddenSince = Date.now();
        stopServerChanges();
        return;
      }
      void resyncAfterForeground();
    });
    window.addEventListener("pageshow", function (event) {
      if (event.persisted) {
        void resyncAfterForeground();
      }
    });
    window.addEventListener("online", function () {
      void resyncAfterForeground();
    });
  }

  /** Where a tapped notification lands: the Activity tab, showing what just
   *  happened across every chat. A chat can be one of many and a reply can be
   *  inside a thread, so the list is the one place that always holds it. */
  function openActivityFromNotification(list) {
    leaveOpenChat();
    setHomeTab("activity");
    // The list the notification was about: an approval waits on Pending, a
    // reply is among what finished. Left to the list last read, a tap on
    // "Approval needed" could land on Finished with the approval behind a
    // tab switch.
    if (list === "pending" || list === "finished") {
      setActivityTab(list);
    }
    void render("synced");
  }

  function wireWorkerMessages() {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker.addEventListener("message", function (event) {
      if (event.data && event.data.type === "accord-open-activity") {
        openActivityFromNotification(event.data.list);
      }
      // A push counted while this page was open: fold it in now, so the chat
      // on screen is not left on the icon as unread until the next return.
      if (event.data && event.data.type === "accord-unread-changed") {
        void adoptWorkerUnread().then(renderChatList).catch(function () { return undefined; });
      }
    });
  }

  // --- the "/" menu ---------------------------------------------------------
  // What the desktop composer lists after "/": /compact and /goal for one clear
  // member, saved prompts, and the skills the target member can run. The
  // desktop decides the list; the phone only asks with the draft so far.

  function activeSlashQuery(value) {
    const match = String(value || "").match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
    return match ? match[1] : undefined;
  }

  function replaceActiveSlashQuery(value, insertion) {
    const source = String(value || "");
    const match = source.match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
    if (!match || match.index === undefined) {
      return source + (source.endsWith(" ") || !source ? "" : " ") + insertion;
    }
    const prefix = source.slice(0, match.index);
    const leadingSpace = match[0].startsWith(" ") ? " " : "";
    return prefix + leadingSpace + insertion;
  }

  function replaceSlashAtCaret(value, insertion, caret) {
    const source = String(value || "");
    const position = Number.isFinite(caret)
      ? Math.max(0, Math.min(source.length, caret))
      : source.length;
    const replacedBefore = replaceActiveSlashQuery(source.slice(0, position), insertion);
    const after = source.slice(position);
    const suffix = replacedBefore.endsWith(" ") && after.startsWith(" ") ? after.slice(1) : after;
    return { value: replacedBefore + suffix, caret: replacedBefore.length };
  }

  function skillTokenPresent(value, frontmatterName) {
    const escaped = String(frontmatterName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|\\s)/" + escaped + "(?=\\s|$)").test(String(value || ""));
  }

  async function requestComposerOptionsViaRelay(pairing, conversationId, query, content) {
    // The catalog the desktop published on the server, answered there.
    const payload = await hubPhoneGet("/v1/phone/composer", { conversationId: conversationId, query: query, content: String(content || "").slice(0, 2_000) });
    if (!payload || payload.type !== "mobile.composer") {
      return { commands: [], prompts: [], skills: [] };
    }
    return {
      commands: Array.isArray(payload.commands) ? payload.commands : [],
      prompts: Array.isArray(payload.prompts) ? payload.prompts : [],
      skills: Array.isArray(payload.skills) ? payload.skills : []
    };
  }

  // A notification tapped while the app was closed opens it with the chat
  // named in the URL. The parameter is consumed once and removed, so a reload
  // does not keep re-opening that chat.
  function adoptOpenConversationFromLocation() {
    try {
      const url = new URL(globalThis.location.href);
      const open = url.searchParams.get("open");
      if (!open || !open.trim()) {
        return;
      }
      setOpenThreadRootId(undefined);
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, open.trim());
      url.searchParams.delete("open");
      history.replaceState(null, "", url.pathname + (url.search || "") + (url.hash || ""));
    } catch {
      return;
    }
  }

  function wireChatSearch() {
    const toggle = document.getElementById("chat-search-toggle");
    const box = document.getElementById("chat-search");
    const input = document.getElementById("chat-search-input");
    const close = document.getElementById("chat-search-close");
    if (!toggle || !box || !input) {
      return;
    }
    function setOpen(open) {
      box.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      // The bar steps aside while searching: with the keyboard up it would sit
      // on top of the results.
      const phone = document.querySelector(".mobile-phone");
      if (phone) phone.dataset.searching = open ? "1" : "0";
      if (open) {
        input.focus();
      } else {
        input.value = "";
        chatSearchQuery = "";
        renderChatList();
      }
    }
    // The search button lives in the bottom bar, so it can be tapped from
    // Activity, Settings, or from inside a chat: it searches the chat list, so
    // it goes there first. An open chat has to be part of that test — the
    // remembered tab inside a chat is usually Chats already, and then the box
    // would open on a screen the reader cannot see.
    toggle.addEventListener("click", function () {
      if (selectedConversationId() || homeTab() !== "chats") {
        void switchHomeTab("chats");
        setOpen(true);
        return;
      }
      setOpen(box.hidden);
    });
    close?.addEventListener("click", function () {
      setOpen(false);
    });
    input.addEventListener("input", function () {
      chatSearchQuery = input.value;
      renderChatList();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
      if (event.key === "Enter") {
        input.blur();
      }
    });
  }

  async function init() {
    // Before anything is drawn: a pairing made the old way is cleared, so the
    // first screen already says why this phone has to pair again.
    await clearOldPairing().catch(function () { return false; });
    readBootstrapFromLocation(globalThis.location);
    adoptOpenConversationFromLocation();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(function () {
        return undefined;
      });
    }
    const form = document.getElementById("composer-form");
    const input = document.getElementById("composer-input");
    const jump = document.getElementById("jump-to-latest");
    if (jump) {
      jump.addEventListener("click", function () {
        scrollToLatest("smooth");
      });
    }
    const surface = threadSurface();
    if (surface) {
      surface.addEventListener("scroll", function () {
        setJumpToLatestVisible(!isNearBottom(surface));
      }, { passive: true });
      // The chat's bottom edge also moves with no scroll at all: a card
      // arriving or growing, the keyboard, the bar coming and going.
      if (jump && typeof ResizeObserver === "function") {
        new ResizeObserver(function () {
          if (jump.classList.contains("is-visible")) placeJumpToLatest(jump);
        }).observe(surface);
      }
    }
    wireChatSearch();
    wireHomeDock();
    wireMembersSheet();
    wireImageViewer();
    wireWorkerMessages();
    // Opened from a notification while the app was not running: the worker
    // cannot postMessage to a page that does not exist yet, so it says it in
    // the URL instead.
    const opening = new URLSearchParams(location.search);
    if (opening.get("tab") === "activity") {
      leaveOpenChat();
      setHomeTab("activity");
      const list = opening.get("list");
      if (list === "pending" || list === "finished") {
        setActivityTab(list);
      }
      history.replaceState(undefined, "", location.pathname);
    }
    wireForegroundResync();
    document.getElementById("load-earlier")?.addEventListener("click", function () {
      void loadEarlierMessages();
    });
    attachPullToRefresh(document.getElementById("chat-list"), document.getElementById("chat-list-refresh"), refreshChatList);
    attachPullToRefresh(surface, document.getElementById("timeline-refresh"), refreshOpenTimeline);
    const backToTimeline = document.getElementById("back-to-timeline");
    if (backToTimeline) {
      backToTimeline.addEventListener("click", function () {
        setOpenThreadRootId(undefined);
        void render();
      });
    }
    const back = document.getElementById("back-to-chats");
    if (back) {
      back.addEventListener("click", function () {
        leaveOpenChat();
        void render();
      });
    }
    if (form && input) {
      // The bar under the composer leaves while the keyboard is up and comes
      // back when it goes. Either way the chat grows or shrinks by the bar's
      // height, so a reader who was at the latest message stays there.
      input.addEventListener("focus", applyDockKeepingReader);
      input.addEventListener("blur", applyDockAfterTap);
      let mentionIndex = 0;
      const mentionMenu = document.getElementById("mention-menu");
      const mentionButton = document.getElementById("mention-button");

      function mentionValueBeforeCaret() {
        const caret = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
        return input.value.slice(0, caret);
      }

      function closeMentionMenu() {
        if (mentionMenu) {
          mentionMenu.hidden = true;
          mentionMenu.textContent = "";
        }
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
      }

      function insertMention(member) {
        const caret = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
        const edit = replaceMentionAtCaret(input.value, member.mentionHandle, caret);
        input.value = edit.value;
        mentionIndex = 0;
        closeMentionMenu();
        input.focus();
        input.setSelectionRange(edit.caret, edit.caret);
      }

      function renderMentionMenu() {
        if (!mentionMenu) {
          return [];
        }
        const options = mentionOptions(mentionValueBeforeCaret(), selectedConversationMembers());
        mentionMenu.textContent = "";
        if (options.length === 0) {
          closeMentionMenu();
          return [];
        }
        mentionIndex = Math.min(mentionIndex, options.length - 1);
        const title = document.createElement("div");
        title.className = "mobile-mention-title";
        title.textContent = "Members";
        mentionMenu.append(title);
        options.forEach(function (member, index) {
          const option = document.createElement("button");
          option.type = "button";
          option.id = "mention-option-" + index;
          option.className = "mobile-mention-option" + (index === mentionIndex ? " is-selected" : "");
          option.setAttribute("role", "option");
          option.setAttribute("aria-selected", index === mentionIndex ? "true" : "false");
          option.addEventListener("pointerdown", function (event) {
            event.preventDefault();
          });
          option.addEventListener("click", function () {
            insertMention(member);
          });
          const avatar = document.createElement("span");
          avatar.className = "mobile-mention-avatar";
          paintAvatar(avatar, avatarForMember(member), selectedConversationId());
          const copy = document.createElement("span");
          copy.className = "mobile-mention-copy";
          const name = document.createElement("strong");
          name.textContent = member.displayName;
          const role = document.createElement("span");
          role.textContent = member.roleLabel;
          copy.append(name, role);
          option.append(avatar, copy);
          mentionMenu.append(option);
        });
        mentionMenu.hidden = false;
        input.setAttribute("aria-expanded", "true");
        input.setAttribute("aria-activedescendant", "mention-option-" + mentionIndex);
        mentionMenu.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
        return options;
      }

      // The "/" menu. The list is the desktop's — it knows the member the
      // draft addresses, the saved prompts and the skills that member can run —
      // so each keystroke after "/" asks it, debounced, and a stale answer is
      // dropped. Picking a skill is remembered so the message carries it the
      // way the desktop composer does, as long as its token is still in the
      // text when the message goes.
      const slashMenu = document.getElementById("slash-menu");
      let slashIndex = 0;
      let slashOptions = [];
      let slashRequestSeq = 0;
      let slashDebounceTimer;
      let slashRequestKey = "";
      let selectedSkillMentions = [];

      function slashMenuOpen() {
        return Boolean(slashMenu) && !slashMenu.hidden && slashOptions.length > 0;
      }

      function closeSlashMenu() {
        clearTimeout(slashDebounceTimer);
        slashRequestSeq += 1;
        slashRequestKey = "";
        slashOptions = [];
        if (slashMenu) {
          slashMenu.hidden = true;
          slashMenu.textContent = "";
        }
        if (!mentionMenu || mentionMenu.hidden) {
          input.setAttribute("aria-expanded", "false");
          input.removeAttribute("aria-activedescendant");
        }
      }

      function slashOptionLabel(option) {
        if (option.kind === "command") {
          return { title: option.item.label || "/" + option.item.id, detail: option.item.description || "" };
        }
        if (option.kind === "prompt") {
          return { title: "/" + option.item.trigger, detail: option.item.label || "" };
        }
        return { title: "/" + option.item.frontmatterName, detail: option.item.description || option.item.displayName || "" };
      }

      function renderSlashMenu(state) {
        if (!slashMenu) {
          return;
        }
        slashMenu.textContent = "";
        if (slashOptions.length === 0 && state === "ready") {
          closeSlashMenu();
          return;
        }
        slashIndex = Math.min(slashIndex, Math.max(0, slashOptions.length - 1));
        if (slashOptions.length === 0) {
          const note = document.createElement("div");
          note.className = "mobile-mention-title";
          note.dataset.slashState = state;
          note.textContent = state === "offline" ? "Commands need the desktop" : "Asking the desktop…";
          slashMenu.append(note);
        }
        const groups = [
          { kind: "command", title: "Commands" },
          { kind: "prompt", title: "Saved prompts" },
          { kind: "skill", title: "Skills" }
        ];
        let position = 0;
        for (const group of groups) {
          const members = slashOptions.filter(function (option) { return option.kind === group.kind; });
          if (members.length === 0) {
            continue;
          }
          const title = document.createElement("div");
          title.className = "mobile-mention-title";
          title.textContent = group.title;
          slashMenu.append(title);
          for (const option of members) {
            const index = slashOptions.indexOf(option);
            const button = document.createElement("button");
            button.type = "button";
            button.id = "slash-option-" + index;
            button.className = "mobile-mention-option mobile-slash-option" + (index === slashIndex ? " is-selected" : "");
            button.dataset.slashKind = option.kind;
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", index === slashIndex ? "true" : "false");
            button.addEventListener("pointerdown", function (event) {
              event.preventDefault();
            });
            button.addEventListener("click", function () {
              insertSlashOption(option);
            });
            const copy = document.createElement("span");
            copy.className = "mobile-mention-copy";
            const label = slashOptionLabel(option);
            const name = document.createElement("strong");
            name.textContent = label.title;
            const detail = document.createElement("span");
            detail.textContent = label.detail;
            copy.append(name, detail);
            button.append(copy);
            slashMenu.append(button);
            position += 1;
          }
        }
        slashMenu.hidden = false;
        input.setAttribute("aria-expanded", "true");
        if (position > 0) {
          input.setAttribute("aria-activedescendant", "slash-option-" + slashIndex);
          slashMenu.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
        }
      }

      function insertSlashOption(option) {
        const caret = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
        let insertion;
        if (option.kind === "command") {
          insertion = "/" + option.item.id + " ";
        } else if (option.kind === "prompt") {
          insertion = String(option.item.body || "").trim();
        } else {
          insertion = "/" + option.item.frontmatterName + " ";
          if (!selectedSkillMentions.some(function (mention) { return mention.skillId === option.item.skillId; })) {
            selectedSkillMentions.push(option.item);
          }
        }
        const edit = replaceSlashAtCaret(input.value, insertion, caret);
        input.value = edit.value;
        slashIndex = 0;
        closeSlashMenu();
        input.focus();
        input.setSelectionRange(edit.caret, edit.caret);
      }

      function updateSlashMenu() {
        const before = mentionValueBeforeCaret();
        const query = activeSlashQuery(before);
        if (query === undefined) {
          clearTimeout(slashDebounceTimer);
          slashRequestKey = "";
          if (slashMenu && !slashMenu.hidden) {
            closeSlashMenu();
          }
          return;
        }
        // A caret moving inside the same draft is not a new question.
        const requestKey = selectedConversationId() + "\0" + before;
        if (requestKey === slashRequestKey) {
          return;
        }
        slashRequestKey = requestKey;
        clearTimeout(slashDebounceTimer);
        const pairing = loadPairing();
        const conversationId = selectedConversationId();
        if (!pairing || !canSync(pairing) || !conversationId) {
          slashOptions = [];
          renderSlashMenu("offline");
          return;
        }
        renderSlashMenu("loading");
        const seq = ++slashRequestSeq;
        const content = input.value;
        slashDebounceTimer = setTimeout(function () {
          requestComposerOptionsViaRelay(pairing, conversationId, query, content).then(function (result) {
            if (seq !== slashRequestSeq || activeSlashQuery(mentionValueBeforeCaret()) !== query) {
              return;
            }
            slashOptions = [].concat(
              result.commands.map(function (item) { return { kind: "command", item }; }),
              result.prompts.map(function (item) { return { kind: "prompt", item }; }),
              result.skills.filter(function (item) {
                return item && item.capabilityState === "invocable" && !item.ambiguous;
              }).map(function (item) { return { kind: "skill", item }; })
            );
            renderSlashMenu("ready");
          }).catch(function () {
            if (seq === slashRequestSeq) {
              slashOptions = [];
              renderSlashMenu("offline");
            }
          });
        }, 120);
      }

      // The skills a message carries are the ones still named in it: deleting
      // the "/name" token drops the skill, as it does on the desktop.
      function takeSkillMentions(content) {
        const carried = selectedSkillMentions.filter(function (mention) {
          return skillTokenPresent(content, mention.frontmatterName);
        });
        selectedSkillMentions = [];
        return carried;
      }

      input.addEventListener("input", function () {
        mentionIndex = 0;
        renderMentionMenu();
        slashIndex = 0;
        updateSlashMenu();
      });
      document.addEventListener("selectionchange", function () {
        if (document.activeElement === input && mentionMenu && !mentionMenu.hidden) {
          renderMentionMenu();
        }
        if (document.activeElement === input && slashMenu && !slashMenu.hidden) {
          updateSlashMenu();
        }
      });
      // Every control in the composer row needs this, not just the mention one.
      // A tap on a button moves focus off the textarea, iOS puts the keyboard
      // away, and the click only lands afterwards — so the first tap looks like
      // it just closed the keyboard and did nothing.
      function keepFieldFocusedOnTap(element) {
        if (!element) {
          return;
        }
        element.addEventListener("pointerdown", function (event) {
          if (document.activeElement === input) {
            event.preventDefault();
          }
        });
      }

      if (mentionButton) {
        keepFieldFocusedOnTap(mentionButton);
        mentionButton.addEventListener("click", function () {
          const edit = mentionShortcutEdit(input.value, input.selectionStart, input.selectionEnd);
          input.value = edit.value;
          input.focus();
          input.setSelectionRange(edit.caret, edit.caret);
          mentionIndex = 0;
          renderMentionMenu();
        });
      }
      const attachButton = document.getElementById("attach-button");
      const imageInput = document.getElementById("composer-image-input");
      keepFieldFocusedOnTap(attachButton);
      keepFieldFocusedOnTap(document.getElementById("send-button"));
      if (attachButton && imageInput) {
        attachButton.addEventListener("click", function () {
          imageInput.click();
        });
        imageInput.addEventListener("change", async function () {
          const rejected = await addPendingAttachments(imageInput.files);
          // Clearing lets the same file be picked again after removing it.
          imageInput.value = "";
          renderPendingAttachments();
          if (rejected.length > 0) {
            const state = document.getElementById("connection-state");
            if (state) {
              state.textContent = "Not attached: " + rejected.join("; ");
            }
          }
        });
      }
      input.addEventListener("keydown", function (event) {
        if (slashMenuOpen()) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            slashIndex = (slashIndex + 1) % slashOptions.length;
            renderSlashMenu("ready");
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            slashIndex = (slashIndex - 1 + slashOptions.length) % slashOptions.length;
            renderSlashMenu("ready");
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            insertSlashOption(slashOptions[slashIndex] || slashOptions[0]);
            return;
          }
        }
        if (event.key === "Escape" && slashMenu && !slashMenu.hidden) {
          closeSlashMenu();
          return;
        }
        const options = mentionOptions(mentionValueBeforeCaret(), selectedConversationMembers());
        if (options.length > 0 && event.key === "ArrowDown") {
          event.preventDefault();
          mentionIndex = (mentionIndex + 1) % options.length;
          renderMentionMenu();
          return;
        }
        if (options.length > 0 && event.key === "ArrowUp") {
          event.preventDefault();
          mentionIndex = (mentionIndex - 1 + options.length) % options.length;
          renderMentionMenu();
          return;
        }
        if (options.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
          event.preventDefault();
          insertMention(options[mentionIndex] || options[0]);
          return;
        }
        if (event.key === "Escape") {
          closeMentionMenu();
        }
      });
      input.addEventListener("blur", function () {
        setTimeout(closeMentionMenu, 0);
        setTimeout(closeSlashMenu, 0);
      });
      // One tap, one send. The form's submit event is not enough on the phone:
      // the send button keeps the field focused so the keyboard does not shove
      // the layout mid-tap, and a tap that changes nothing on screen can be
      // dropped before it becomes a click -- which is how a tap came to only
      // put the keyboard away, leaving the message sitting there (the User,
      // 2026-09-21). The button therefore sends on pointerup as well, and
      // submitComposer makes the two paths one send: it empties the field and
      // takes the pictures before its first wait, so the second path finds
      // nothing. A flag held across the whole send did that too, and more: it
      // also dropped the next message typed while the first was still going
      // out over a slow connection, with nothing on screen to say so.
      const sendComposer = function () {
        return submitComposer();
      };
      input.addEventListener("focus", updateComposerShape);
      input.addEventListener("blur", function () {
        afterTapLands(updateComposerShape);
      });
      input.addEventListener("input", updateComposerShape);
      updateComposerShape();
      const sendButton = document.getElementById("send-button");
      if (sendButton) {
        sendButton.addEventListener("pointerup", function (event) {
          event.preventDefault();
          void sendComposer();
        });
      }
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        void sendComposer();
      });
      async function submitComposer() {
        const content = input.value.trim();
        const conversationId = selectedConversationId();
        // A picture on its own is a message.
        if ((!content && pendingAttachments.length === 0) || !conversationId) {
          return;
        }
        input.value = "";
        // The message is gone, so the keyboard has nothing left to do: it goes
        // down and gives the screen back, instead of sitting over the reply
        // the User just asked for. The composer goes back to one line with it
        // once the tap on Send has landed.
        input.blur();
        afterTapLands(updateComposerShape);
        closeSlashMenu();
        const attachments = takePendingAttachments();
        const skillMentions = takeSkillMentions(content);
        // A reply written with a thread open belongs to that thread. Without
        // this the desktop had nothing to place it by and put it in the main
        // timeline, where the User -- still looking at the thread -- could not
        // see her own message at all (the User, 2026-09-21).
        const threadRootId = openThreadRootId();
        const carriesExtras = attachments.length > 0 || skillMentions.length > 0 || Boolean(threadRootId);
        await enqueueMessage({
          content,
          conversationId,
          ...(threadRootId ? { threadRootId } : {}),
          ...(carriesExtras
            ? {
              payload: {
                content,
                ...(threadRootId ? { threadRootId } : {}),
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(skillMentions.length > 0 ? { skillMentions } : {})
              }
            }
            : {})
        });
        // The message goes out at once: drawing it is not what it waits on.
        const flushing = flushOutbox();
        await handOverBeforeDrawing(flushing);
        await render();
        // Sending is a deliberate action, so following it is expected.
        scrollToLatestWhenSettled("auto");
        const flushResult = await flushing;
        await render(flushResult.status);
      }
    }
    // Cached rows are visible before synchronization finishes. Their controls
    // and elapsed time must work throughout those network waits.
    wireStreamView();
    startThinkingClock();
    startSyncProgressClock();
    // Internal system rows stored before the desktop stopped sending them
    // would otherwise sit in the timeline forever: nothing ever asks the phone
    // to drop a row it once received.
    await dropStoredInternalSystemRows().catch(function () { return 0; });
    // What the queue holds, so a card can say whether its answer went out and
    // the periodic retry knows there is something to offer.
    await listOutboxEntries().catch(function () { return []; });
    await render();
    // What a push-woken worker counted while the app was closed, folded in
    // before the lists paint again; the icon number follows.
    await adoptWorkerUnread().catch(function () { return undefined; });
    // The phone talks to the User's server and to nothing else: no desktop
    // and no machine is addressed from here.
    const pairing = loadPairing();
    if (isHubPairing(pairing)) {
      await initHubSession(pairing);
    }
  }

  /** A phone paired with the User's server: what it owes goes out, the chats
   *  are read from the server, and it is rung by the server. */
  async function initHubSession(pairing) {
    const client = hubClient();
    if (client) {
      void client.health().then(function (health) {
        if (!(Number(health && health.protocol) >= HUB_PHONE_PROTOCOL)) {
          hubPairingState = { status: "outdated", message: "Update AccordAgents on your Mac: its server runs an older program than this app." };
          return render();
        }
        return undefined;
      }).catch(function () { return undefined; });
    }
    const flushResult = await flushOutbox().catch(function () { return { status: "unreachable" }; });
    try {
      await requestChatListViaRelay(pairing);
      await render("synced");
      const conversationId = selectedConversationId();
      if (conversationId) {
        await requestTimelineViaRelay(pairing, conversationId);
        await render("synced");
      }
    } catch (error) {
      await render(error && error.unavailable ? "unreachable" : flushResult.status);
    }
    void ensurePushSubscription().catch(function () { return undefined; });
    startHubProgressPolling();
    void refreshHubMachines();
    void markHubNoticesSeen();
    void pruneSentHubEntries().catch(function () { return undefined; });
  }

  globalThis.AccordAgentsMobile = {
    // W-K's harness drives the real user path — permission prompt, subscribe,
    // POST, render — rather than a stand-in for it.
    enableMessageAlerts,
    ensurePushSubscription,
    whileLookingForMessages,
    reconnectMessageAlerts,
    createOutboxEvent,
    enqueueMessage,
    enqueueRunCancel,
    stopRunFromPhone,
    flushOutbox,
    handleRelayChatListPayload,
    handleRelayTimelinePayload,
    reconcilePendingControlCards,
    retryPendingOutbox,
    isCardSent,
    isCardLocked,
    desktopOwesEntry,
    activeMentionQuery,
    mentionOptions,
    replaceActiveMention,
    mentionShortcutEdit,
    replaceMentionAtCaret,
    isCancellableMobileRow,
    requestChatListViaRelay,
    requestTimelineViaRelay,
    readBootstrapFromLocation,
    pairWithServer,
    flushOutboxViaHub,
    hubLogicalTs,
    resolvePhoneDelivery,
    loadHubPairing,
    listOutboxEntries,
    listTimelineEntries,
    dedupeTimelineEntries,
    reconcileMessageRows,
    timelineEntryDedupeKey,
    timelineRenderRowKey,
    updateMessageRow,
    loadPairing,
    connectionStatusText,
    renderMessageContent,
    timelineAttachmentsFromEvent,
    addPendingAttachments,
    takePendingAttachments,
    preparePickedImage,
    chatMatchesQuery,
    filterChatsByQuery,
    formatClockTime,
    messageStatusLabel,
    activeSlashQuery,
    replaceActiveSlashQuery,
    replaceSlashAtCaret,
    skillTokenPresent,
    requestComposerOptionsViaRelay,
    loadUnreadConversationIds,
    markConversationsUnread,
    markConversationRead,
    adoptWorkerUnread,
    resyncAfterForeground,
    loadEarlierMessages,
    timelinePageFor,
    saveTimelinePage,
    refreshChatList,
    refreshOpenTimeline,
    openImageViewer,
    closeImageViewer,
    openMembersSheet,
    closeMembersSheet,
    openActivityFromNotification
  };

  // iOS reports a height at first paint that is taller than what you can
  // actually see, so the composer starts half off the bottom of the screen —
  // and the page is deliberately unscrollable now, so nothing brings it back
  // until the keyboard opens and closes and forces a re-measure. Measure the
  // usable height ourselves instead of letting CSS inherit that first value.
  // Tracking visualViewport also means the composer rides above the keyboard
  // rather than sitting behind it.
  function trackUsableHeight() {
    const viewport = typeof window !== "undefined" ? window.visualViewport : null;
    let lastHeight = 0;
    let lastWidth = 0;
    function apply() {
      const width = window.innerWidth;
      // Never measure while the composer is focused: on iOS the keyboard is
      // covering part of the screen and every frame of its animation reports a
      // different height, so resizing on each one made the whole screen jump
      // the moment the input was tapped. A width change is a rotation, which
      // the keyboard cannot cause, so that one is honoured either way.
      if (composerHasFocus() && width === lastWidth) {
        return;
      }
      const height = viewport ? viewport.height : window.innerHeight;
      if (height <= 0 || (height === lastHeight && width === lastWidth)) {
        return;
      }
      lastHeight = height;
      lastWidth = width;
      // A reader sitting at the latest message stays there across a rotation.
      keepingReaderAtLatest(function () {
        document.documentElement.style.setProperty("--app-h", height + "px");
      });
    }
    // A single sample can land mid-animation — the keyboard sliding away, a
    // rotation still turning — and then stick, because nothing would come
    // along to correct it. Sample across the whole animation instead.
    function remeasure() {
      apply();
      applyDock();
      [150, 350, 600, 900].forEach(function (delay) {
        setTimeout(apply, delay);
      });
    }
    remeasure();
    // The height iOS reports at first paint is too tall; the real one only
    // exists after the first frame.
    requestAnimationFrame(apply);
    window.addEventListener("resize", remeasure);
    window.addEventListener("orientationchange", remeasure);
    // Coming back from the background is the other moment the height can be
    // stale with no resize to announce it.
    window.addEventListener("pageshow", remeasure);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        remeasure();
      }
    });
    // Not in the middle of the tap that moved the focus: the height taken
    // with the keyboard still up and the bar coming back would both move the
    // button under the finger before its release.
    document.addEventListener("focusout", function () {
      afterTapLands(remeasure);
    });
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", function () {
      trackUsableHeight();
      init().catch(function (error) {
        const state = document.getElementById("connection-state");
        if (state) {
          state.textContent = error instanceof Error ? error.message : String(error);
        }
      });
    });
  }
})();
