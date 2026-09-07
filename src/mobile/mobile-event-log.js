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
  const EVENTS = "events";
  const OUTBOX = "outbox";
  const META = "meta";
  const CLOCK_KEY = "eventClock";
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
    const port = options.port;
    const originId = options.originId;
    const now = options.now || function () { return Date.now(); };
    const newId = options.newId || function () {
      return "e-" + Math.random().toString(36).slice(2) + "-" + Date.now();
    };
    const clock = createClock(originId, now);
    let ownSeq = 0;
    let restored = false;

    // Reloads the clock and this device's sequence. Continuing from 1 after a
    // reload would fork this origin's log.
    async function restore() {
      await port.runAtomic([EVENTS, META], async function (tx) {
        const stored = await tx.get(META, CLOCK_KEY);
        if (stored && stored.value) clock.restore(parseHlc(stored.value));
        const events = await tx.getAll(EVENTS);
        for (const event of events) {
          if (event.originId === originId && event.originSeq > ownSeq) ownSeq = event.originSeq;
          clock.observe(event.logicalTs);
        }
      });
      restored = true;
    }

    async function ensureRestored() {
      if (!restored) await restore();
    }

    // Records what this device did and queues it for delivery in ONE
    // transaction. If the queue write fails the action is not recorded either:
    // an action nobody will hear about is worse than one the User can retry.
    async function append(request) {
      await ensureRestored();
      const seq = ownSeq + 1;
      const logicalTs = clock.tick();
      const event = {
        eventId: request.eventId || newId(),
        conversationId: request.conversationId,
        logScopeId: request.logScopeId || "chat:actions",
        originId: originId,
        originSeq: seq,
        logicalTs: logicalTs,
        kind: request.kind,
        payload: request.payload,
        createdAt: new Date(now()).toISOString()
      };
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
      });
      if (stored) ownSeq = seq;
      return event;
    }

    // Applies an event from another device. A missing sequence is a gap to
    // repair, never a hole to skip.
    async function receive(event) {
      await ensureRestored();
      let status = "applied";
      await port.runAtomic([EVENTS, META], async function (tx) {
        const existing = await tx.get(EVENTS, event.eventId);
        if (existing) { status = "duplicate"; return; }
        const held = await tx.getAll(EVENTS);
        const highest = held
          .filter(function (item) { return item.originId === event.originId && item.logScopeId === event.logScopeId; })
          .reduce(function (max, item) { return Math.max(max, item.originSeq); }, 0);
        if (event.originSeq > highest + 1) status = "gap";
        await tx.put(EVENTS, event);
        clock.observe(event.logicalTs);
        await tx.put(META, { key: CLOCK_KEY, value: formatHlc(clock.current()) });
      });
      return status;
    }

    // Missing sequences per origin and scope, so they can be asked for.
    async function gaps() {
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
        let from = 0;
        for (let seq = 1; seq <= highest; seq += 1) {
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

    // Drops only what every device has acknowledged.
    async function release(roster) {
      const decision = await retention(roster);
      if (!decision.releasable.length) return decision;
      await port.runAtomic([OUTBOX], async function (tx) {
        for (const eventId of decision.releasable) await tx.remove(OUTBOX, eventId);
      });
      return decision;
    }

    return {
      restore: restore,
      append: append,
      receive: receive,
      gaps: gaps,
      acknowledge: acknowledge,
      retention: retention,
      release: release,
      clock: function () { return formatHlc(clock.current()); },
      sequence: function () { return ownSeq; }
    };
  }

  return { createMobileEventLog: createMobileEventLog, formatHlc: formatHlc, parseHlc: parseHlc };
});
