/**
 * The phone's durable log, exercised without a browser.
 *
 * IndexedDB is bound in mobile-app.js; the rules that matter - one contiguous
 * sequence per origin, a clock that cannot go backwards, an action and its
 * outgoing record landing together, and a queue nobody may empty on a device's
 * behalf - are here, where a disk failure can be injected on purpose.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createMobileEventLog, parseHlc } = require(path.resolve(import.meta.dirname, "../src/mobile/mobile-event-log.js"));

/** A store the tests can break on demand, with real transaction semantics:
 *  a thrown error inside runAtomic discards every write it made. */
function memoryPort() {
  const stores = new Map([["events", new Map()], ["outbox", new Map()], ["meta", new Map()], ["blobs", new Map()]]);
  const keyOf = (store, value) => (store === "meta" || store === "blobs" ? value.key : value.eventId);
  const port = {
    failOn: null,
    async runAtomic(names, work) {
      const staged = new Map();
      for (const name of names) staged.set(name, new Map(stores.get(name)));
      const tx = {
        async get(name, key) { return staged.get(name).get(key); },
        async getAll(name) { return [...staged.get(name).values()].map((value) => JSON.parse(JSON.stringify(value))); },
        async put(name, value) {
          if (port.failOn === name) throw new Error("QuotaExceededError: " + name);
          staged.get(name).set(keyOf(name, value), JSON.parse(JSON.stringify(value)));
        },
        async remove(name, key) { staged.get(name).delete(key); }
      };
      const result = await work(tx);
      for (const [name, values] of staged) stores.set(name, values);
      return result;
    },
    dump(name) { return [...stores.get(name).values()]; }
  };
  return port;
}

const log = (port, options = {}) => createMobileEventLog({
  port,
  stores: options.stores,
  originId: options.originId || "phone",
  now: options.now || (() => 1_700_000_000_000),
  newId: options.newId
});

test("an action and its outgoing record land together, or not at all", async () => {
  const port = memoryPort();
  const phone = log(port);
  // The queue write fails: recording the action alone would leave something no
  // peer will ever hear about.
  port.failOn = "outbox";
  await assert.rejects(phone.append({ conversationId: "chat", kind: "choice.answered", payload: { operationId: "op1", targetKey: "choice:m1" } }));
  assert.deepEqual(port.dump("events"), []);
  assert.deepEqual(port.dump("outbox"), []);

  port.failOn = null;
  const event = await phone.append({ conversationId: "chat", kind: "choice.answered", payload: { operationId: "op1", targetKey: "choice:m1" } });
  assert.equal(port.dump("events").length, 1);
  assert.equal(port.dump("outbox").length, 1);
  assert.equal(event.originSeq, 1, "the failed attempt did not consume a sequence number");
});

test("a reload continues this device's own sequence instead of forking it", async () => {
  const port = memoryPort();
  const first = log(port);
  await first.append({ conversationId: "chat", kind: "choice.answered", payload: { operationId: "a", targetKey: "t" } });
  await first.append({ conversationId: "chat", kind: "choice.answered", payload: { operationId: "b", targetKey: "t" } });
  assert.equal(first.sequence(), 2);

  // The app was closed and opened again against the same storage.
  const reopened = log(port);
  const next = await reopened.append({ conversationId: "chat", kind: "choice.answered", payload: { operationId: "c", targetKey: "t" } });
  assert.equal(next.originSeq, 3, "starting again from 1 would fork this origin's log");
  const seqs = port.dump("events").map((event) => event.originSeq).sort();
  assert.deepEqual(seqs, [1, 2, 3]);
});

test("the clock never goes backwards, not even after a reload with a stalled phone clock", async () => {
  const port = memoryPort();
  const early = log(port, { now: () => 1_700_000_000_000 });
  await early.append({ conversationId: "chat", kind: "choice.answered", payload: { operationId: "a", targetKey: "t" } });
  // Something from a machine whose wall clock is far ahead.
  await early.receive({
    eventId: "from-machine", conversationId: "chat", logScopeId: "chat:actions",
    originId: "cloud-box", originSeq: 1, logicalTs: "hlc:1800000000000:000004:cloud-box",
    kind: "choice.answered", payload: {}, createdAt: "2027-01-01T00:00:00.000Z"
  });
  const reopened = log(port, { now: () => 1_700_000_000_000 });
  const minted = await reopened.append({ conversationId: "chat", kind: "choice.answered", payload: { operationId: "b", targetKey: "t" } });
  assert.ok(minted.logicalTs > "hlc:1800000000000:000004:cloud-box",
    "a phone that has seen a later event cannot emit one that sorts before it");
  assert.equal(parseHlc(minted.logicalTs).originId, "phone");
});

test("a missing sequence is reported as a gap to repair, not skipped", async () => {
  const port = memoryPort();
  const phone = log(port);
  const from = (seq) => ({
    eventId: "m" + seq, conversationId: "chat", logScopeId: "chat:actions",
    originId: "cloud-box", originSeq: seq, logicalTs: "hlc:1700000000000:00000" + seq + ":cloud-box",
    kind: "choice.answered", payload: {}, createdAt: "2026-09-07T00:00:0" + seq + ".000Z"
  });
  assert.equal(await phone.receive(from(1)), "applied");
  assert.equal(await phone.receive(from(3)), "gap");
  assert.deepEqual(await phone.gaps(), [{ originId: "cloud-box", logScopeId: "chat:actions", fromSeq: 2, toSeq: 2 }]);
  assert.equal(await phone.receive(from(2)), "applied");
  assert.deepEqual(await phone.gaps(), []);
  assert.equal(await phone.receive(from(2)), "duplicate", "a repeat of a repaired event changes nothing");
});

test("the queue is emptied only for what every device acknowledged", async () => {
  const port = memoryPort();
  const phone = log(port);
  const first = await phone.append({ conversationId: "chat", kind: "choice.answered", payload: { operationId: "a", targetKey: "t" } });
  const second = await phone.append({ conversationId: "chat", kind: "choice.answered", payload: { operationId: "b", targetKey: "t" } });

  const roster = ["mac", "cloud-box"];
  await phone.acknowledge("mac", first.eventId);
  let decision = await phone.release(roster);
  assert.deepEqual(decision.releasable, [], "one device's acknowledgement is not every device's");
  // cloud-box is behind on both, mac only on the second: the device that is
  // furthest behind is named first.
  assert.deepEqual(decision.pressure.map((peer) => peer.peerId), ["cloud-box", "mac"]);
  assert.equal(decision.pressure[0].pendingEvents, 2);
  assert.equal(decision.pressure[1].pendingEvents, 1);
  assert.equal(port.dump("outbox").length, 2);

  await phone.acknowledge("cloud-box", first.eventId);
  decision = await phone.release(roster);
  assert.deepEqual(decision.releasable, [first.eventId]);
  assert.deepEqual(port.dump("outbox").map((entry) => entry.eventId), [second.eventId]);
  assert.deepEqual(decision.retained, [{ eventId: second.eventId, awaiting: ["cloud-box", "mac"] }]);
});

test("an event that is already held is not queued twice", async () => {
  const port = memoryPort();
  const phone = log(port);
  await phone.append({ conversationId: "chat", kind: "choice.answered", payload: { operationId: "a", targetKey: "t" }, eventId: "fixed" });
  await phone.append({ conversationId: "chat", kind: "choice.answered", payload: { operationId: "a", targetKey: "t" }, eventId: "fixed" });
  assert.equal(port.dump("events").length, 1);
  assert.equal(port.dump("outbox").length, 1);
  assert.equal(phone.sequence(), 1, "a retry of the same action does not consume another sequence number");
});

test("fragment bytes and outgoing event roll back together, then survive a partial roster ACK", async () => {
  const port = memoryPort();
  const phone = log(port, { stores: { blobs: "blobs" } });
  const payload = { type: "device.event.blob", blobHash: "sha256:" + "a".repeat(64), fragments: 2, byteLength: 400000 };
  const request = { eventId: "large", conversationId: "chat", kind: "message", payload,
    recipients: ["one", "two"], blobFragments: [0, 1].map(index => ({ reference: payload, index, bytesBase64: "eA==" })) };
  port.failOn = "outbox";
  await assert.rejects(phone.append(request), /QuotaExceeded/);
  assert.equal(port.dump("blobs").length, 0);
  assert.equal(port.dump("events").length, 0);
  port.failOn = null;
  await phone.append(request);
  await phone.acknowledge("one", "large");
  await phone.release(["one", "two"]);
  assert.equal(port.dump("blobs").length, 2, "offline peer is still owed every fragment");
  const restarted = log(port, { stores: { blobs: "blobs" } });
  await restarted.restore();
  await restarted.acknowledge("two", "large");
  await restarted.release(["one", "two"]);
  assert.equal(port.dump("blobs").length, 0);
});

test("applying an incoming body cannot delete the same body still owed to another peer", async () => {
  const port = memoryPort();
  const phone = log(port, { stores: { blobs: "blobs" } });
  const payload = { type: "device.event.blob", blobHash: "sha256:" + "b".repeat(64), fragments: 1, byteLength: 1 };
  await phone.append({ eventId: "outgoing", conversationId: "chat", kind: "message", payload,
    blobFragments: [{ reference: payload, index: 0, bytesBase64: "eA==" }], recipients: ["one"] });
  const incoming = { eventId: "incoming", originId: "two", logScopeId: "chat:actions", originSeq: 1,
    logicalTs: "0000000000001:000000:two", kind: "message", conversationId: "chat", payload, eventHash: "hash" };
  await phone.receive(incoming);
  port.failOn = "meta";
  await assert.rejects(phone.markApplied(incoming), /QuotaExceeded/);
  assert.equal(port.dump("blobs").length, 1, "failed receipt keeps the body available for retry");
  port.failOn = null;
  await phone.markApplied(incoming);
  assert.equal(port.dump("blobs").length, 1, "successful incoming receipt cannot release outgoing ownership");
  await phone.acknowledge("one", "outgoing");
  await phone.release(["one", "two"]);
  assert.equal(port.dump("blobs").length, 0, "non-recipient does not hold a private room event forever");
});
