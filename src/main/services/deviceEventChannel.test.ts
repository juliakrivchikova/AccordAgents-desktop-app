import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceEventChannel } from "./deviceEventChannel";
import { ChatEventLogService } from "./chatEventLog";
import { StorageService } from "./storage";
import { DeviceEventStorage } from "./deviceEventStorage";
import { isDeviceEventBlobReference } from "../../shared/deviceEventBlobs";
import type { DeviceEventPacket } from "../../shared/deviceEventChannel";
import { openMobileRelayPayload, sealMobileRelayPayload } from "./mobileRelaySealing";

test("a sealed device event survives sender restart, gap repair, receiver apply failure and a lost ACK without a second application", async () => {
  const pair = await devices();
  try {
    const first = await pair.a.publish({ conversationId: "chat", kind: "message.created", payload: { text: "one" } });
    const second = await pair.a.publish({ conversationId: "chat", kind: "message.updated", payload: { text: "two" } });
    await pair.a.flush();
    pair.a.close();
    const events = pair.sentA.filter((packet) => packet.type === "event");
    assert.equal(events.length, 2);
    await pair.b.receive(events[1]);
    assert.equal(pair.applied.length, 0);
    assert.equal(pair.sentB.at(-1)?.type, "resend");
    pair.failApply.value = true;
    await assert.rejects(pair.b.receive(events[0]), /disk full/);
    assert.equal(pair.sentB.filter((packet) => packet.type === "ack").length, 0);
    pair.b.close();
    pair.failApply.value = false;
    pair.reopen();
    await pair.a.flush();
    const resent = pair.sentA.filter((packet) => packet.type === "event");
    assert.deepEqual(resent[0].event, JSON.parse(JSON.stringify(first)));
    await pair.b.receive(resent[0]);
    assert.deepEqual(pair.applied, [first.eventId, second.eventId]);
    // Lose all ACKs, restart the receiver again, and redeliver the exact event.
    pair.b.close();
    pair.reopenReceiver();
    await pair.b.receive(resent[0]);
    assert.deepEqual(pair.applied, [first.eventId, second.eventId]);
    const receipts = pair.sentB.filter((packet) => packet.type === "ack");
    for (const receipt of receipts) await pair.a.receive(receipt);
    assert.equal((await pair.storageA.deviceEvents().listPending("room")).length, 0);
  } finally { await pair.cleanup(); }
});

test("a body larger than 10 MiB uses bounded sealed fragments and cannot apply or ACK before every byte is durable", async () => {
  const pair = await devices();
  try {
    const payload = { text: "Ж".repeat(6 * 1024 * 1024), suffix: "complete" };
    const event = await pair.a.publish({ conversationId: "chat", kind: "message.created", payload });
    assert.ok(isDeviceEventBlobReference(event.payload));
    assert.ok(Buffer.byteLength(JSON.stringify(event)) < 2000, "the log contains a bounded reference, not the full body");
    await pair.a.flush();
    const fragments = pair.sentA.filter((packet) => packet.type === "fragment");
    const message = pair.sentA.find((packet) => packet.type === "event")!;
    assert.ok(fragments.length > 30);
    const sealKey = Buffer.alloc(32, 4).toString("base64url");
    for (const fragment of fragments) {
      const sealed = await sealMobileRelayPayload(fragment, sealKey);
      assert.ok(Buffer.byteLength(sealed) < 1024 * 1024, "each sealed packet fits below the mailbox page and relay logical limit");
    }
    await pair.b.receive(message); // Referencing event can arrive first.
    for (const fragment of fragments.slice(0, -1).reverse()) await pair.b.receive(fragment);
    assert.equal(pair.applied.length, 0);
    assert.equal(pair.sentB.filter((packet) => packet.type === "ack").length, 0);
    pair.b.close();
    pair.reopenReceiver();
    const last = fragments.at(-1)!;
    const sealed = await sealMobileRelayPayload(last, sealKey);
    await pair.b.receive(await openMobileRelayPayload(sealed, sealKey));
    assert.equal(pair.applied.length, 1);
    assert.deepEqual(pair.lastPayload.value, payload);
    assert.equal(pair.sentB.filter((packet) => packet.type === "ack").length, 1);
  } finally { await pair.cleanup(); }
});

test("failed fragment persistence and conflicting fragment bytes are never treated as complete", async () => {
  const pair = await devices();
  try {
    const event = await pair.a.publish({ conversationId: "chat", kind: "message.created", payload: { text: "x".repeat(900_000) } });
    await pair.a.flush();
    const fragments = pair.sentA.filter((packet) => packet.type === "fragment");
    await pair.b.receive(pair.sentA.find((packet) => packet.type === "event"));
    await pair.sqlB(`create trigger reject_fragment before insert on device_event_blob_fragments
      begin select raise(abort, 'SQLITE_FULL fragment'); end;`);
    await assert.rejects(pair.b.receive(fragments[0]));
    assert.equal(pair.applied.length, 0);
    await pair.sqlB("drop trigger reject_fragment;");
    await pair.b.receive(fragments[0]);
    await assert.rejects(pair.b.receive({ ...fragments[0], fragment: {
      ...fragments[0].fragment, bytesBase64: Buffer.alloc(384 * 1024, 9).toString("base64")
    } }));
    for (const fragment of fragments.slice(1)) await pair.b.receive(fragment);
    assert.deepEqual(pair.applied, [event.eventId]);
  } finally { await pair.cleanup(); }
});

test("a surviving manifest requests its expired fragments from retained origin history", async () => {
  const pair = await devices();
  try {
    const event = await pair.a.publish({ conversationId: "chat", kind: "message.created", payload: { text: "x".repeat(900_000) } });
    await pair.a.flush();
    const manifest = pair.sentA.find(packet => packet.type === "event")!;
    pair.a.close();
    // Only the manifest survives the temporary relay buffer. The receiver
    // has no origin-sequence gap, but cannot ACK until it repairs the body.
    await pair.b.receive(manifest);
    const request = pair.sentB.find(packet => packet.type === "resend");
    assert.ok(request && request.type === "resend");
    assert.equal(request.gap.fromSeq, event.originSeq);
    assert.equal(request.gap.toSeq, event.originSeq);
    assert.equal(pair.applied.length, 0);
    pair.reopen();
    await pair.a.receive(request);
    const repair = pair.sentA.splice(0);
    assert.ok(repair.some(packet => packet.type === "fragment"));
    assert.ok(repair.every(packet => packet.deliveryId === request.requestId), "repair gets new buffer arrivals after an old cursor");
    for (const packet of repair) await pair.b.receive(packet);
    assert.deepEqual(pair.applied, [event.eventId]);
  } finally { await pair.cleanup(); }
});

test("a deferred native outcome does not block other chats and is acknowledged only after its owner confirms storage", async () => {
  const pair = await devices();
  try {
    pair.deferredKinds.add("native.finished");
    const terminal = await pair.a.publish({ conversationId: "first", kind: "native.finished", payload: { text: "done" } });
    const other = await pair.a.publish({ conversationId: "other", kind: "message.created", payload: { text: "other chat" } });
    await pair.a.flush();
    for (const packet of pair.sentA.filter(packet => packet.type === "event")) await pair.b.receive(packet);
    assert.deepEqual(pair.applied, [other.eventId]);
    assert.ok(!pair.sentB.some(packet => packet.type === "ack" && packet.receipt.eventId === terminal.eventId));
    await pair.sqlB(`create trigger reject_receipt before update on device_event_inbox
      begin select raise(abort, 'SQLITE_FULL receipt'); end;`);
    await assert.rejects(pair.b.confirmApplied(terminal));
    assert.ok(!pair.sentB.some(packet => packet.type === "ack" && packet.receipt.eventId === terminal.eventId));
    await pair.sqlB("drop trigger reject_receipt;");
    await pair.b.confirmApplied(terminal);
    assert.ok(pair.sentB.some(packet => packet.type === "ack" && packet.receipt.eventId === terminal.eventId));
    pair.reopenReceiver();
    await pair.b.receive(pair.sentA.find(packet => packet.type === "event" && packet.event.eventId === terminal.eventId));
    assert.deepEqual(pair.applied, [other.eventId], "an acknowledged deferred outcome is not applied again after restart");
  } finally { await pair.cleanup(); }
});

test("a failing projection in one chat does not prevent another chat's durable application", async () => {
  const pair = await devices();
  try {
    pair.failedKinds.add("native.finished");
    const failed = await pair.a.publish({ conversationId: "first", kind: "native.finished", payload: { text: "held" } });
    const other = await pair.a.publish({ conversationId: "other", kind: "message.created", payload: { text: "independent" } });
    await pair.a.flush();
    const packets = pair.sentA.filter(packet => packet.type === "event");
    await assert.rejects(pair.b.receive(packets[0]), /disk full/);
    // The failing action now waits out its backoff, so the next delivery is
    // not failed again by it.
    await pair.b.receive(packets[1]);
    assert.deepEqual(pair.applied, [other.eventId]);
    assert.ok(!pair.sentB.some(packet => packet.type === "ack" && packet.receipt.eventId === failed.eventId));
    pair.failedKinds.clear();
    await pair.b.receive(pair.sentA.find(packet => packet.type === "event" && packet.event.eventId === failed.eventId));
    assert.deepEqual(pair.applied, [other.eventId, failed.eventId]);
  } finally { await pair.cleanup(); }
});

test("overlapping live and mailbox copies reuse durable receipts without rewriting every duplicate", async () => {
  const pair = await devices();
  try {
    const event = await pair.a.publish({ conversationId: "chat", kind: "message.created", payload: { text: "stream chunk" } });
    await pair.a.flush();
    const packet = pair.sentA.find(packet => packet.type === "event")!;
    await pair.b.receive(packet);
    const receipt = pair.sentB.find(packet => packet.type === "ack")!;
    await pair.a.receive(receipt);
    await pair.sqlB(`create trigger forbid_duplicate_event before insert on chat_events
      begin select raise(abort, 'unexpected duplicate event write'); end;`);
    await (pair.storageA as any).runSql(`create trigger forbid_duplicate_ack before update on device_event_outbox
      begin select raise(abort, 'unexpected duplicate ACK write'); end;`);
    for (let i = 0; i < 25; i++) { await pair.b.receive(packet); await pair.a.receive(receipt); }
    assert.deepEqual(pair.applied, [event.eventId]);
    // A repair requested after a lost ACK still gets a fresh receipt even
    // inside the ordinary duplicate debounce window.
    const beforeRepair = pair.sentB.filter(packet => packet.type === "ack").length;
    await pair.b.receive({ ...packet, deliveryId: "explicit-repair" });
    assert.equal(pair.sentB.filter(packet => packet.type === "ack").length, beforeRepair + 1);
    assert.deepEqual(pair.applied, [event.eventId]);
    await pair.sqlB("drop trigger forbid_duplicate_event;");
    pair.reopenReceiver();
    await pair.b.receive(packet);
    assert.deepEqual(pair.applied, [event.eventId], "restart rebuilds the receipt from SQLite without reapplying");
    if (packet.type === "event") await assert.rejects(pair.b.receive({ ...packet, event: { ...packet.event, payload: { text: "forged" } } }), /signature/);
  } finally { await pair.cleanup(); }
});

test("held actions wait out a backoff instead of being retried on every delivery", async () => {
  // A cloud machine held ~500 answers to choices from chats it does not host and
  // re-tried every one on each incoming packet: about 10,000 attempts a minute,
  // until the runtime ran out of memory and stopped answering the desktop.
  const pair = await devices();
  try {
    pair.deferredKinds.add("choice.answered");
    pair.failedKinds.add("machine.settings");
    for (let i = 0; i < 20; i++) await pair.a.publish({ conversationId: `foreign-${i}`, kind: "choice.answered", payload: { i } });
    for (let i = 0; i < 5; i++) await pair.a.publish({ conversationId: `settings-${i}`, kind: "machine.settings", payload: { i } });
    await pair.a.flush();
    for (const packet of pair.sentA.filter(packet => packet.type === "event")) await pair.b.receive(packet).catch(() => undefined);
    const heldDeferred = pair.attempts.get("choice.answered") ?? 0;
    const heldFailed = pair.attempts.get("machine.settings") ?? 0;
    assert.ok(heldDeferred >= 20 && heldFailed >= 5, "every held action was tried once on arrival");
    pair.sentA.length = 0;
    for (let i = 0; i < 30; i++) {
      await pair.a.publish({ conversationId: "busy", kind: "message.created", payload: { text: `chunk ${i}` } });
      await pair.a.flush();
      for (const packet of pair.sentA.splice(0).filter(packet => packet.type === "event")) await pair.b.receive(packet).catch(() => undefined);
    }
    assert.equal(pair.applied.length, 30, "unrelated traffic still applies");
    assert.ok((pair.attempts.get("choice.answered") ?? 0) - heldDeferred <= 40,
      `deferred answers were retried ${(pair.attempts.get("choice.answered") ?? 0) - heldDeferred} times across 30 deliveries`);
    assert.ok((pair.attempts.get("machine.settings") ?? 0) - heldFailed <= 10,
      `failing actions were retried ${(pair.attempts.get("machine.settings") ?? 0) - heldFailed} times across 30 deliveries`);
  } finally { await pair.cleanup(); }
});

test("a held action is retried once its backoff is due, or at once when the peer redelivers it", async () => {
  const pair = await devices();
  try {
    pair.heldRetryBaseMs.value = 1_500;
    pair.reopenReceiver();
    pair.deferredKinds.add("choice.answered");
    const answer = await pair.a.publish({ conversationId: "late", kind: "choice.answered", payload: { choice: "x" } });
    await pair.a.flush();
    const packet = pair.sentA.find(packet => packet.type === "event" && packet.event.eventId === answer.eventId)!;
    await pair.b.receive(packet);
    assert.equal(pair.applied.length, 0);
    pair.deferredKinds.clear();
    // Inside the backoff an unrelated delivery leaves it alone...
    const other = await pair.a.publish({ conversationId: "other", kind: "message.created", payload: { text: "x" } });
    await pair.a.flush();
    await pair.b.receive(pair.sentA.find(packet => packet.type === "event" && packet.event.eventId === other.eventId)!);
    assert.deepEqual(pair.applied, [other.eventId]);
    // ...and once it is due, the next pass applies it.
    await new Promise(resolve => setTimeout(resolve, 1_600));
    const later = await pair.a.publish({ conversationId: "other", kind: "message.created", payload: { text: "y" } });
    await pair.a.flush();
    await pair.b.receive(pair.sentA.find(packet => packet.type === "event" && packet.event.eventId === later.eventId)!);
    assert.deepEqual(pair.applied, [other.eventId, answer.eventId, later.eventId]);

    // A redelivered copy of a held action is tried straight away.
    pair.deferredKinds.add("choice.answered");
    const second = await pair.a.publish({ conversationId: "late", kind: "choice.answered", payload: { choice: "y" } });
    await pair.a.flush();
    const secondPacket = pair.sentA.find(packet => packet.type === "event" && packet.event.eventId === second.eventId)!;
    pair.heldRetryBaseMs.value = 60_000;
    pair.reopenReceiver();
    await pair.b.receive(secondPacket);
    pair.deferredKinds.clear();
    await pair.b.receive(secondPacket);
    assert.ok(pair.applied.includes(second.eventId));
  } finally { await pair.cleanup(); }
});

test("an action confirmed by its owner leaves nothing waiting behind", async () => {
  const pair = await devices();
  try {
    pair.deferredKinds.add("machine.turn.finished");
    const finished = await pair.a.publish({ conversationId: "chat", kind: "machine.turn.finished", payload: { text: "done" } });
    await pair.a.flush();
    await pair.b.receive(pair.sentA.find(packet => packet.type === "event" && packet.event.eventId === finished.eventId)!);
    const channel = pair.b as unknown as { heldRetry: Map<string, unknown>; receivePending: boolean; drain(): Promise<void> };
    assert.equal(channel.heldRetry.size, 1);
    await pair.b.confirmApplied(finished);
    assert.equal(channel.heldRetry.size, 0, "a confirmed action is not kept for retry");
    await channel.drain();
    assert.equal(channel.receivePending, false, "nothing keeps the periodic pass busy afterwards");
  } finally { await pair.cleanup(); }
});

async function devices() {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-device-channel-"));
  const pathA = path.join(directory, "a.sqlite3");
  const pathB = path.join(directory, "b.sqlite3");
  const storageA = new StorageService({ dbPath: pathA });
  const storageB = new StorageService({ dbPath: pathB });
  const logA = new ChatEventLogService(storageA);
  const logB = new ChatEventLogService(storageB);
  const identityA = await logA.getOrCreateDeviceIdentity();
  const identityB = await logB.getOrCreateDeviceIdentity();
  const sentA: DeviceEventPacket[] = [];
  const sentB: DeviceEventPacket[] = [];
  const applied: string[] = [];
  const failApply = { value: false };
  const deferredKinds = new Set<string>();
  const failedKinds = new Set<string>();
  const attempts = new Map<string, number>();
  const heldRetryBaseMs = { value: undefined as number | undefined };
  const lastPayload = { value: undefined as unknown };
  const errors: Error[] = [];
  const makeA = () => {
    const storage = new StorageService({ dbPath: pathA });
    return new DeviceEventChannel({ storage, eventLog: new ChatEventLogService(storage), channelId: "room",
      localDeviceId: identityA.originId, peerDeviceId: identityB.originId, peerPublicKeyDerBase64: identityB.publicKeyDerBase64,
      send: async (packet) => { sentA.push(packet); }, apply: async () => "applied", onError: (error) => { errors.push(error); } });
  };
  const makeB = () => {
    const storage = new StorageService({ dbPath: pathB });
    return new DeviceEventChannel({ storage, eventLog: new ChatEventLogService(storage), channelId: "room",
      localDeviceId: identityB.originId, peerDeviceId: identityA.originId, peerPublicKeyDerBase64: identityA.publicKeyDerBase64,
      ...(heldRetryBaseMs.value !== undefined ? { heldRetryBaseMs: heldRetryBaseMs.value } : {}),
      send: async (packet) => { sentB.push(packet); }, apply: async (event, payload) => {
        attempts.set(event.kind, (attempts.get(event.kind) ?? 0) + 1);
        if (failApply.value || failedKinds.has(event.kind)) throw new Error("disk full while storing projection");
        if (deferredKinds.has(event.kind)) return "deferred";
        applied.push(event.eventId); lastPayload.value = payload; return "applied";
      }, onError: (error) => { errors.push(error); } });
  };
  const pair = {
    a: makeA(), b: makeB(), sentA, sentB, applied, failApply, deferredKinds, failedKinds, lastPayload, storageA, attempts, heldRetryBaseMs,
    sqlB: (sql: string): Promise<void> => (storageB as any).runSql(sql),
    reopen: () => { pair.a.close(); pair.b.close(); sentA.length = 0; pair.a = makeA(); pair.b = makeB(); },
    reopenReceiver: () => { pair.b.close(); pair.b = makeB(); },
    cleanup: async () => { pair.a.close(); pair.b.close(); await pair.a.flush().catch(() => undefined); await pair.b.flush().catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
  };
  return pair;
}

test("a retry pass reads only identities while every waiting event is still inside its backoff", async () => {
  // An unreachable peer let 942 events wait on the User's desktop; each five-second pass re-read
  // every envelope and kept the one database connection busy, so a Cancel took 18 seconds.
  const pair = await devices();
  const listPending = DeviceEventStorage.prototype.listPending;
  try {
    for (const text of ["one", "two", "three"]) {
      await pair.a.publish({ conversationId: "chat", kind: "message.created", payload: { text } });
    }
    await pair.a.flush();
    assert.equal(pair.sentA.filter((packet) => packet.type === "event").length, 3);
    const storage = (pair.a as unknown as { options: { storage: StorageService } }).options.storage;
    const getChatEvent = storage.getChatEvent.bind(storage);
    let envelopeReads = 0;
    storage.getChatEvent = async (eventId) => { envelopeReads += 1; return getChatEvent(eventId); };
    DeviceEventStorage.prototype.listPending = async () => { throw new Error("a retry pass must not read every waiting envelope"); };
    await pair.a.flush();
    assert.equal(envelopeReads, 0, "nothing is due again yet, so no envelope is read");
    assert.equal(pair.sentA.filter((packet) => packet.type === "event").length, 3, "nothing is re-sent inside the backoff");
    assert.equal((await pair.storageA.deviceEvents().listPendingHeaders("room")).length, 3, "all three still wait for an ACK");
  } finally {
    DeviceEventStorage.prototype.listPending = listPending;
    await pair.cleanup();
  }
});

test("a shared room key cannot forge another device's application ACK", async () => {
  const pair = await devices();
  try {
    const event = await pair.a.publish({ conversationId: "ack-authority", kind: "message.created", payload: { text: "retained" } });
    await pair.a.flush();
    await pair.b.receive(pair.sentA.find(packet => packet.type === "event" && packet.event.eventId === event.eventId));
    const ack = pair.sentB.find(packet => packet.type === "ack" && packet.receipt.eventId === event.eventId)!;
    assert.ok(ack.signature);
    const { signature: _signature, ...forged } = ack;
    await assert.rejects(pair.a.receive(forged), /signature/);
    await assert.rejects(pair.a.receive({ ...ack, deliveryId: "changed-after-signing" }), /signature/);
    assert.equal((await pair.storageA.deviceEvents().listPending("room")).length, 1);
    await pair.a.receive(ack);
    assert.equal((await pair.storageA.deviceEvents().listPending("room")).length, 0);
  } finally { await pair.cleanup(); }
});
