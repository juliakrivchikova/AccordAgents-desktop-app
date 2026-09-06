import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceEventChannel } from "./deviceEventChannel";
import { ChatEventLogService } from "./chatEventLog";
import { StorageService } from "./storage";
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
    for (const packet of pair.sentA.filter(packet => packet.type === "event")) await assert.rejects(pair.b.receive(packet), /disk full/);
    assert.deepEqual(pair.applied, [other.eventId]);
    assert.ok(!pair.sentB.some(packet => packet.type === "ack" && packet.receipt.eventId === failed.eventId));
    pair.failedKinds.clear();
    await pair.b.receive(pair.sentA.find(packet => packet.type === "event" && packet.event.eventId === failed.eventId));
    assert.deepEqual(pair.applied, [other.eventId, failed.eventId]);
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
      send: async (packet) => { sentB.push(packet); }, apply: async (event, payload) => {
        if (failApply.value || failedKinds.has(event.kind)) throw new Error("disk full while storing projection");
        if (deferredKinds.has(event.kind)) return "deferred";
        applied.push(event.eventId); lastPayload.value = payload; return "applied";
      }, onError: (error) => { errors.push(error); } });
  };
  const pair = {
    a: makeA(), b: makeB(), sentA, sentB, applied, failApply, deferredKinds, failedKinds, lastPayload, storageA,
    sqlB: (sql: string): Promise<void> => (storageB as any).runSql(sql),
    reopen: () => { pair.a.close(); pair.b.close(); sentA.length = 0; pair.a = makeA(); pair.b = makeB(); },
    reopenReceiver: () => { pair.b.close(); pair.b = makeB(); },
    cleanup: async () => { pair.a.close(); pair.b.close(); await pair.a.flush().catch(() => undefined); await pair.b.flush().catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
  };
  return pair;
}
