/**
 * The phone's durable event log and outgoing queue.
 *
 * The PWA is a first-class emitter, not a remote control: what it does has to
 * survive being closed mid-action, reload, and being offline for a while. That
 * needs the same three things the desktop has - a contiguous sequence per
 * origin, a hybrid logical clock, and a queue bounded by acknowledgements -
 * and it needs the local action and the outgoing record to land together or
 * not at all.
 *
 * The storage port is injected so this logic can be exercised without a
 * browser; mobile-app.js binds it to IndexedDB, where runAtomic is one
 * transaction across both stores, so a failed queue write cannot leave an
 * action that no peer will ever hear about.
 *
 * The clock key format is the one in src/shared/hlc.ts
 * ("hlc:<13 digits>:<6 digits>:<originId>"), so a phone event and a machine
 * event interleave by the same rule everywhere. Changing one without the other
 * would split the order.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AccordMobileEventLog = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const WALL_DIGITS = 13;
  const COUNTER_DIGITS = 6;
  const COUNTER_LIMIT = 1000000;
  const DEFAULT_STORES = { events: "events", outbox: "outbox", meta: "meta" };
  const CLOCK_KEY = "eventClock";
  // Compact per-origin state that outlives the events themselves.
  const HEAD_PREFIX = "eventHead:";
  const APPLIED_PREFIX = "eventApplied:";
  const RECEIPT_PREFIX = "eventReceipts:";
  const MINTED_PREFIX = "eventMinted:";
  const HLC_PATTERN = /^hlc:(\d{13}):(\d{6}):(.+)$/;

  function pad(value, width) {
    return String(value).padStart(width, "0");
  }

  function formatHlc(parts) {
    return "hlc:" + pad(parts.wallMs, WALL_DIGITS) + ":" + pad(parts.counter, COUNTER_DIGITS) + ":" + parts.originId;
  }

  function parseHlc(value) {
    const match = HLC_PATTERN.exec(String(value || ""));
    return match ? { wallMs: Number(match[1]), counter: Number(match[2]), originId: match[3] } : undefined;
  }

  // One clock per device. tick mints, observe advances past what arrived, so a
  // phone that was offline cannot emit something that sorts before what it has
  // already seen.
  function createClock(originId, now) {
    let wallMs = 0;
    let counter = 0;
    const advance = function () {
      if (counter + 1 >= COUNTER_LIMIT) { wallMs += 1; counter = 0; return; }
      counter += 1;
    };
    return {
      current: function () { return { wallMs: wallMs, counter: counter, originId: originId }; },
      restore: function (parts) {
        if (!parts) return;
        if (parts.wallMs > wallMs || (parts.wallMs === wallMs && parts.counter > counter)) {
          wallMs = parts.wallMs;
          counter = parts.counter;
        }
      },
      tick: function () {
        const at = Math.max(0, Math.floor(now()));
        if (at > wallMs) { wallMs = at; counter = 0; } else advance();
        return formatHlc({ wallMs: wallMs, counter: counter, originId: originId });
      },
      observe: function (logicalTs) {
        const seen = parseHlc(logicalTs);
        if (!seen) return;
        const at = Math.max(0, Math.floor(now()));
        const wall = Math.max(at, wallMs, seen.wallMs);
        if (wall === wallMs && wall === seen.wallMs) { counter = Math.max(counter, seen.counter); advance(); }
        else if (wall === seen.wallMs) { wallMs = wall; counter = seen.counter; advance(); }
        else if (wall === wallMs) advance();
        else { wallMs = wall; counter = 0; }
      }
    };
  }

  function createMobileEventLog(options) {
    // The store names are given, because a device holds more than one of these
    // logs: what it sends to its desktop and what it sends to a machine are
    // separate queues with separate acknowledgements, and mixing their records
    // in one store would make a flush of one pick up the other's work.
    const stores = options.stores || DEFAULT_STORES;
    const EVENTS = stores.events || DEFAULT_STORES.events;
    const OUTBOX = stores.outbox || DEFAULT_STORES.outbox;
    const META = stores.meta || DEFAULT_STORES.meta;
    const port = options.port;
    const originId = options.originId;
    const now = options.now || function () { return Date.now(); };
    const newId = options.newId || function () {
      return "e-" + Math.random().toString(36).slice(2) + "-" + Date.now();
    };
    const clock = createClock(originId, now);
    // Signing is asynchronous and IndexedDB transactions close on any await
    // that is not an IndexedDB request. The sequence, the clock, the event and
    // its delivery rows are therefore written in one transaction, and the
    // signature — a pure function of those stored bytes — is attached in a
    // second. A crash in between leaves an event that is re-signed to exactly
    // the same bytes on the next start: no gap, no second event, and nothing
    // is ever sent unsigned.
    const sign = options.sign;
    const verify = options.verify;
    // A sequence belongs to an origin *and a scope*: a receiver applies this
    // device's events in contiguous order per scope, so one shared counter
    // across scopes would leave every scope but the first with a permanent gap.
    //
    // Heads are persisted rather than derived from the stored events, because
    // an event is dropped once it is fully delivered or fully applied. On the
    // User's real chat the phone would otherwise keep every machine result it
    // has ever received, and every read here walks the whole store.
    const heads = new Map();
    const RECEIPT_HISTORY = 200;
    let restored = false;

    function headKey(originId, logScopeId) { return HEAD_PREFIX + originId + "\u0000" + logScopeId; }
    function appliedKey(originId, logScopeId) { return APPLIED_PREFIX + originId + "\u0000" + logScopeId; }
    function receiptKey(originId) { return RECEIPT_PREFIX + originId; }
    function mintedKey() { return MINTED_PREFIX + originId; }
    const MINTED_HISTORY = 500;
    const appliedHeads = new Map();

    function appliedHeadOf(originId, logScopeId) {
      return appliedHeads.get(appliedKey(originId, logScopeId)) || { seq: 0 };
    }

    function headOf(originId, logScopeId) {
      return heads.get(headKey(originId, logScopeId)) || { seq: 0 };
    }

    function observeHead(originId, logScopeId, event) {
      const key = headKey(originId, logScopeId);
      const current = heads.get(key) || { seq: 0 };
      if (event.originSeq > current.seq) heads.set(key, { seq: event.originSeq, hash: event.eventHash });
    }

    // Reloads the clock and this device's sequence. Continuing from 1 after a
    // reload would fork this origin's log.
    async function restore() {
      await port.runAtomic([EVENTS, META], async function (tx) {
        const stored = await tx.get(META, CLOCK_KEY);
        if (stored && stored.value) clock.restore(parseHlc(stored.value));
        for (const record of await tx.getAll(META)) {
          if (typeof record.key !== "string" || !record.head) continue;
          if (record.key.indexOf(HEAD_PREFIX) === 0) heads.set(record.key, record.head);
          else if (record.key.indexOf(APPLIED_PREFIX) === 0) appliedHeads.set(record.key, record.head);
        }
        // Anything still held is a floor under the persisted heads: a record
        // written before heads existed, or a crash between the two writes.
        for (const event of await tx.getAll(EVENTS)) {
          observeHead(event.originId, event.logScopeId, event);
          clock.observe(event.logicalTs);
        }
      });
      restored = true;
      await completeUnsignedEvents();
    }

    /** Re-signs anything a crash left between the two transactions. */
    async function completeUnsignedEvents() {
      if (!sign) return;
      const pending = await port.runAtomic([EVENTS], function (tx) { return tx.getAll(EVENTS); });
      for (const event of pending) {
        if (event.originId !== originId || event.signature || !event.eventHash) continue;
        const signature = await sign(event.eventHash);
        await port.runAtomic([EVENTS], async function (tx) {
          const stored = await tx.get(EVENTS, event.eventId);
          if (!stored || stored.signature) return;
          stored.signature = signature;
          await tx.put(EVENTS, stored);
        });
      }
    }

    /** The bytes every device signs and verifies: the envelope without its
     *  payload and without the signature itself. */
    function unsignedBytes(event) {
      return {
        eventId: event.eventId,
        conversationId: event.conversationId,
        logScopeId: event.logScopeId,
        originId: event.originId,
        originSeq: event.originSeq,
        logicalTs: event.logicalTs,
        kind: event.kind,
        payloadHash: event.payloadHash,
        prevHash: event.prevHash === undefined ? null : event.prevHash,
        keyId: event.keyId,
        createdAt: event.createdAt
      };
    }

    async function ensureRestored() {
      if (!restored) await restore();
    }

    // Records what this device did and queues it for delivery in ONE
    // transaction. If the queue write fails the action is not recorded either:
    // an action nobody will hear about is worse than one the User can retry.
    async function append(request) {
      await ensureRestored();
      const existingById = request.eventId
        ? await port.runAtomic([EVENTS], function (tx) { return tx.get(EVENTS, request.eventId); })
        : undefined;
      // The same action asked for twice is the same event, not a second one.
      if (existingById) return existingById;
      // Including after it was delivered and dropped. Minting it again would
      // give the same id a new sequence and a new hash, and a peer that still
      // holds the first one refuses that as a conflict -- which then blocks
      // everything behind it. This remembers the identity, not the body.
      if (request.eventId) {
        const minted = await port.runAtomic([META], function (tx) { return tx.get(META, mintedKey()); });
        const seen = (minted && minted.minted || []).find(function (item) { return item.eventId === request.eventId; });
        if (seen) return { ...seen, delivered: true };
      }
      const logScopeId = request.logScopeId || "chat:actions";
      const head = headOf(originId, logScopeId);
      const seq = head.seq + 1;
      const logicalTs = clock.tick();
      const payloadHash = options.hashPayload ? await options.hashPayload(request.payload) : undefined;
      const event = {
        eventId: request.eventId || newId(),
        conversationId: request.conversationId,
        logScopeId: logScopeId,
        originId: originId,
        originSeq: seq,
        logicalTs: logicalTs,
        kind: request.kind,
        payload: request.payload,
        createdAt: new Date(now()).toISOString()
      };
      if (payloadHash) event.payloadHash = payloadHash;
      if (options.keyId) event.keyId = options.keyId;
      // This scope's hash chain: a receiver applies an origin's events only in
      // contiguous order, and the chain is what proves the order.
      if (head.hash) event.prevHash = head.hash;
      if (options.hashEvent) event.eventHash = await options.hashEvent(unsignedBytes(event));
      const recipients = (request.recipients || []).slice();
      let stored = true;
      await port.runAtomic([EVENTS, OUTBOX, META], async function (tx) {
        const existing = await tx.get(EVENTS, event.eventId);
        if (existing) { stored = false; return; }
        await tx.put(EVENTS, event);
        await tx.put(OUTBOX, {
          eventId: event.eventId,
          conversationId: event.conversationId,
          createdAt: event.createdAt,
          bytes: JSON.stringify(event).length,
          acknowledgedBy: [],
          recipients: recipients
        });
        await tx.put(META, { key: CLOCK_KEY, value: logicalTs });
        await tx.put(META, { key: headKey(originId, logScopeId), head: { seq: seq, hash: event.eventHash } });
        const minted = (await tx.get(META, mintedKey())) || { key: mintedKey(), minted: [] };
        minted.minted.push({ eventId: event.eventId, conversationId: event.conversationId, logScopeId: logScopeId,
          originId: originId, originSeq: seq, eventHash: event.eventHash, kind: event.kind });
        while (minted.minted.length > MINTED_HISTORY) minted.minted.shift();
        await tx.put(META, minted);
      });
      if (!stored) return port.runAtomic([EVENTS], function (tx) { return tx.get(EVENTS, event.eventId); });
      heads.set(headKey(originId, logScopeId), { seq: seq, hash: event.eventHash });
      if (sign && event.eventHash) {
        const signature = await sign(event.eventHash);
        await port.runAtomic([EVENTS], async function (tx) {
          const held = await tx.get(EVENTS, event.eventId);
          if (!held || held.signature) return;
          held.signature = signature;
          await tx.put(EVENTS, held);
        });
        event.signature = signature;
      }
      return event;
    }

    // Applies an event from another device. A missing sequence is a gap to
    // repair, never a hole to skip.
    async function receive(event) {
      await ensureRestored();
      // A shared room key says the sender is in the room, not who wrote this.
      // An event that does not verify is not stored, not applied and not
      // acknowledged; it is refused so a forged event cannot release history.
      if (verify && !await verify(event)) return "unverified";
      let status = "applied";
      const applied = appliedHeadOf(event.originId, event.logScopeId);
      await port.runAtomic([EVENTS, META], async function (tx) {
        const existing = await tx.get(EVENTS, event.eventId);
        if (existing) { status = "duplicate"; return; }
        // Already applied and dropped: repeating it must not put it back, or a
        // machine's re-offer after a reconnect would replay a finished turn.
        if (event.originSeq <= applied.seq) { status = "duplicate"; return; }
        const held = await tx.getAll(EVENTS);
        const highest = held
          .filter(function (item) { return item.originId === event.originId && item.logScopeId === event.logScopeId; })
          .reduce(function (max, item) { return Math.max(max, item.originSeq); }, applied.seq);
        if (event.originSeq > highest + 1) status = "gap";
        await tx.put(EVENTS, event);
        clock.observe(event.logicalTs);
        await tx.put(META, { key: CLOCK_KEY, value: formatHlc(clock.current()) });
      });
      return status;
    }

    // Missing sequences per origin and scope, so they can be asked for. What
    // has already been applied is behind us: the search starts at the head.
    async function gaps() {
      await ensureRestored();
      const events = await port.runAtomic([EVENTS], function (tx) { return tx.getAll(EVENTS); });
      const byScope = new Map();
      for (const event of events) {
        const key = event.originId + " " + event.logScopeId;
        const seen = byScope.get(key) || { originId: event.originId, logScopeId: event.logScopeId, seqs: new Set() };
        seen.seqs.add(event.originSeq);
        byScope.set(key, seen);
      }
      const missing = [];
      byScope.forEach(function (scope) {
        const highest = Math.max.apply(null, Array.from(scope.seqs));
        const start = appliedHeadOf(scope.originId, scope.logScopeId).seq + 1;
        let from = 0;
        for (let seq = start; seq <= highest; seq += 1) {
          if (!scope.seqs.has(seq)) { if (!from) from = seq; continue; }
          if (from) { missing.push({ originId: scope.originId, logScopeId: scope.logScopeId, fromSeq: from, toSeq: seq - 1 }); from = 0; }
        }
        if (from) missing.push({ originId: scope.originId, logScopeId: scope.logScopeId, fromSeq: from, toSeq: highest });
      });
      return missing;
    }

    async function acknowledge(peerId, eventId) {
      await port.runAtomic([OUTBOX], async function (tx) {
        const entry = await tx.get(OUTBOX, eventId);
        if (!entry) return;
        if (entry.acknowledgedBy.indexOf(peerId) < 0) entry.acknowledgedBy.push(peerId);
        await tx.put(OUTBOX, entry);
      });
    }

    // What may be forgotten, and who is behind. The same rule the desktop
    // uses: an entry is released only when every device in the roster has
    // acknowledged it, and a device that is merely away is pressure, never a
    // reason to discard.
    async function retention(roster) {
      const entries = await port.runAtomic([OUTBOX], function (tx) { return tx.getAll(OUTBOX); });
      const peers = Array.from(new Set((roster || []).filter(Boolean))).sort();
      const releasable = [];
      const retained = [];
      const pending = new Map();
      let heldBytes = 0;
      for (const entry of entries) {
        const awaiting = peers.filter(function (peer) { return entry.acknowledgedBy.indexOf(peer) < 0; });
        if (!awaiting.length) { releasable.push(entry.eventId); continue; }
        retained.push({ eventId: entry.eventId, awaiting: awaiting });
        heldBytes += entry.bytes || 0;
        awaiting.forEach(function (peer) {
          const current = pending.get(peer) || { peerId: peer, pendingEvents: 0, pendingBytes: 0, oldestCreatedAt: undefined };
          current.pendingEvents += 1;
          current.pendingBytes += entry.bytes || 0;
          if (!current.oldestCreatedAt || entry.createdAt < current.oldestCreatedAt) current.oldestCreatedAt = entry.createdAt;
          pending.set(peer, current);
        });
      }
      const pressure = Array.from(pending.values()).sort(function (left, right) {
        return right.pendingBytes - left.pendingBytes || left.peerId.localeCompare(right.peerId);
      });
      return { releasable: releasable, retained: retained, heldBytes: heldBytes, pressure: pressure };
    }

    /**
     * Records that an event from another device has been carried out here.
     *
     * The event body is then dropped: what the sender needs back is the
     * receipt, and what this device needs is the position it has reached.
     * Keeping every applied event would make the phone's store grow with
     * every machine result forever.
     */
    async function markApplied(event, outcome, appliedAt) {
      await ensureRestored();
      const receipt = {
        eventId: event.eventId,
        eventHash: event.eventHash,
        outcome: outcome === "superseded" ? "superseded" : "applied",
        appliedAt: appliedAt || new Date(now()).toISOString()
      };
      const key = appliedKey(event.originId, event.logScopeId);
      await port.runAtomic([EVENTS, META], async function (tx) {
        const stored = (await tx.get(META, key)) || { key: key, head: { seq: 0 } };
        const held = (await tx.get(META, receiptKey(event.originId))) || { key: receiptKey(event.originId), receipts: [] };
        const existing = held.receipts.find(function (item) { return item.eventId === receipt.eventId; });
        if (!existing) {
          held.receipts.push(receipt);
          while (held.receipts.length > RECEIPT_HISTORY) held.receipts.shift();
          await tx.put(META, held);
        }
        if (event.originSeq > stored.head.seq) {
          stored.head = { seq: event.originSeq, hash: event.eventHash };
          await tx.put(META, stored);
        }
        await tx.remove(EVENTS, event.eventId);
      });
      const current = appliedHeads.get(key) || { seq: 0 };
      if (event.originSeq > current.seq) appliedHeads.set(key, { seq: event.originSeq, hash: event.eventHash });
      return existingReceipt(event.originId, receipt.eventId).then(function (found) { return found || receipt; });
    }

    async function existingReceipt(originId, eventId) {
      const held = await port.runAtomic([META], function (tx) { return tx.get(META, receiptKey(originId)); });
      return (held && held.receipts || []).find(function (item) { return item.eventId === eventId; });
    }

    /**
     * What has arrived from a device and can be carried out now.
     *
     * Contiguous only: an event whose predecessor is missing waits for the
     * repair rather than being applied out of order.
     */
    async function inboundReady(originId) {
      await ensureRestored();
      const events = await port.runAtomic([EVENTS], function (tx) { return tx.getAll(EVENTS); });
      const byScope = new Map();
      for (const event of events) {
        if (event.originId !== originId) continue;
        const list = byScope.get(event.logScopeId) || [];
        list.push(event);
        byScope.set(event.logScopeId, list);
      }
      const ready = [];
      byScope.forEach(function (list, logScopeId) {
        list.sort(function (left, right) { return left.originSeq - right.originSeq; });
        let expected = appliedHeadOf(originId, logScopeId).seq + 1;
        for (const event of list) {
          if (event.originSeq !== expected) break;
          ready.push(event);
          expected += 1;
        }
      });
      return ready.sort(function (left, right) { return String(left.logicalTs).localeCompare(String(right.logicalTs)); });
    }

    // Drops only what every device has acknowledged.
    async function release(roster) {
      const decision = await retention(roster);
      if (!decision.releasable.length) return decision;
      await port.runAtomic([OUTBOX, EVENTS], async function (tx) {
        for (const eventId of decision.releasable) {
          await tx.remove(OUTBOX, eventId);
          // Every device has it; this copy is history, and the head keeps the
          // sequence going. Holding it would grow without bound.
          await tx.remove(EVENTS, eventId);
        }
      });
      return decision;
    }

    return {
      restore: restore,
      append: append,
      receive: receive,
      gaps: gaps,
      acknowledge: acknowledge,
      markApplied: markApplied,
      receipt: existingReceipt,
      inboundReady: inboundReady,
      appliedHead: appliedHeadOf,
      retention: retention,
      release: release,
      clock: function () { return formatHlc(clock.current()); },
      sequence: function (logScopeId) {
        return logScopeId === undefined
          ? Array.from(heads.values()).reduce(function (max, head) { return Math.max(max, head.seq); }, 0)
          : headOf(logScopeId).seq;
      },
      /** Everything still owed to a peer, oldest first, for a channel to send. */
      pendingFor: async function (peerId) {
        const rows = await port.runAtomic([OUTBOX, EVENTS], async function (tx) {
          const entries = await tx.getAll(OUTBOX);
          const events = [];
          for (const entry of entries) {
            const recipients = entry.recipients || [];
            if (recipients.length && recipients.indexOf(peerId) < 0) continue;
            if ((entry.acknowledgedBy || []).indexOf(peerId) >= 0) continue;
            const event = await tx.get(EVENTS, entry.eventId);
            if (event) events.push(event);
          }
          return events;
        });
        return rows
          .filter(function (event) { return Boolean(event.signature); })
          .sort(function (left, right) { return left.originSeq - right.originSeq; });
      },
      get: function (eventId) {
        return port.runAtomic([EVENTS], function (tx) { return tx.get(EVENTS, eventId); });
      }
    };
  }

  return { createMobileEventLog: createMobileEventLog, formatHlc: formatHlc, parseHlc: parseHlc };
});
