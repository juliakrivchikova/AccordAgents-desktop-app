import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatEventLogService } from "./chatEventLog";
import { DeviceEventMailbox } from "./deviceEventMailbox";
import { DeviceEventChannel } from "./deviceEventChannel";
import { StorageService } from "./storage";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type { DeviceEventPacket } from "../../shared/deviceEventChannel";
import { mailboxAuthHeaders } from "./mailboxAccess";
import { openMobileRelayPayload } from "./mobileRelaySealing";

test("mailbox catch-up works after sender exit; relay acceptance does not ACK the peer and cursor follows apply", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-device-mailbox-"));
  const sender = new StorageService({ dbPath: path.join(directory, "sender.sqlite3") });
  const receiverPath = path.join(directory, "receiver.sqlite3");
  const receiver = new StorageService({ dbPath: receiverPath });
  const eventLog = new ChatEventLogService(sender);
  const identity = await eventLog.getOrCreateDeviceIdentity();
  const pairing = {
    rendezvousId: "test-mailbox", relaySealKeyBase64: Buffer.alloc(32, 3).toString("base64url"),
    outboxUrl: "https://relay.invalid/v1/mailbox/events"
  } as MobilePairingPackage;
  const events: any[] = [];
  let failPost = true;
  let epoch = "first";
  const fakeFetch = async (input: any, init?: RequestInit): Promise<Response> => {
    assert.equal((init?.headers as Record<string, string>).authorization, mailboxAuthHeaders(pairing.relaySealKeyBase64).authorization);
    const url = new URL(String(input));
    if (init?.method === "POST") {
      if (failPost) return new Response("disk full", { status: 503 });
      const { events: incoming } = JSON.parse(String(init.body));
      assert.ok(Buffer.byteLength(String(init.body)) < 1024 * 1024);
      for (const event of incoming) {
        assert.equal(event.payload.alg, "A256GCM");
        assert.ok(!JSON.stringify(event).includes("private-text"));
        if (!events.some((entry) => entry.eventId === event.eventId)) events.push({ ...event, arrivalSeq: events.length + 1 });
      }
      return Response.json({ ackRole: "mailbox", eventIds: incoming.map((event: any) => event.eventId) });
    }
    return Response.json({ epoch, events: events.filter((event) => event.arrivalSeq > Number(url.searchParams.get("afterArrival"))).slice(0, 2) });
  };
  const received: DeviceEventPacket[] = [];
  let failApply = true;
  const receiverOptions = {
    storage: receiver, pairing, localDeviceId: "receiver", peerDeviceId: identity.originId,
    fetch: fakeFetch as typeof fetch, onError: () => undefined,
    receive: async (packet: DeviceEventPacket) => { if (failApply) throw new Error("receiver disk full"); received.push(packet); }
  };
  const a = new DeviceEventMailbox({
    storage: sender, pairing, localDeviceId: identity.originId, peerDeviceId: "receiver",
    fetch: fakeFetch as typeof fetch, receive: async () => undefined, onError: () => undefined
  });
  let b = new DeviceEventMailbox(receiverOptions);
  try {
    const payload = await sender.deviceEventBlobs().prepare({ text: "private-text ".repeat(80_000) });
    const event = (await eventLog.appendLocalEvent({ conversationId: "chat", logScopeId: "chat", kind: "message.created", payload,
      recipients: [{ deviceId: "receiver", channelId: pairing.rendezvousId }] })).event;
    await assert.rejects(a.flush(), /HTTP 503/);
    assert.equal((await sender.deviceEvents().listPending(pairing.rendezvousId))[0].deliveredAt, undefined);
    failPost = false;
    await a.flush();
    assert.ok((await sender.deviceEvents().listPending(pairing.rendezvousId))[0].deliveredAt);
    a.close(); // No sender is alive while the receiver catches up.
    await assert.rejects(b.poll(), /receiver disk full/);
    const readerId = `receiver:${identity.originId}`;
    assert.equal((await receiver.deviceEvents().mailboxCursor(pairing.rendezvousId, readerId)).arrivalSeq, 0);
    b.close();
    failApply = false;
    b = new DeviceEventMailbox({ ...receiverOptions, storage: new StorageService({ dbPath: receiverPath }) });
    await b.poll();
    assert.equal(received.at(-1)?.type, "event");
    assert.deepEqual((received.at(-1) as any).event, JSON.parse(JSON.stringify(event)));
    assert.equal((await receiver.deviceEvents().mailboxCursor(pairing.rendezvousId, readerId)).arrivalSeq, events.length);
    assert.equal((await sender.deviceEvents().listPending(pairing.rendezvousId)).length, 1, "only a machine receipt releases this source entry");
    const count = received.length;
    await b.poll();
    assert.equal(received.length, count);
    // A recreated mailbox resets its arrival cursor; it does not reset the
    // canonical signed event or the receiver's durable deduplication state.
    epoch = "second";
    const retained = events.at(-1);
    events.length = 0;
    events.push({ ...retained, arrivalSeq: 1 });
    await b.poll();
    assert.equal(received.length, count + 1);
    assert.equal((await receiver.deviceEvents().mailboxCursor(pairing.rendezvousId, readerId)).arrivalSeq, 1);
    assert.deepEqual(await openMobileRelayPayload(JSON.stringify(events[0].payload), pairing.relaySealKeyBase64), received.at(-1));
  } finally { a.close(); b.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an applied receipt survives failed delivery and receiver restart without pinning other chats", async () => {
  const pair = await mailboxDevices();
  try {
    pair.failedKinds.add("held");
    pair.failAcks.value = true;
    const held = await pair.publish("first", "held");
    const other = await pair.publish("other", "message");
    await pair.b.mailbox.poll();
    assert.deepEqual(pair.applied, [other.eventId]);
    assert.equal((await pair.b.storage.deviceEvents().pendingReceipts("room", pair.a.id)).length, 1);
    assert.ok((await pair.b.storage.deviceEvents().mailboxCursor("room", `${pair.b.id}:${pair.a.id}`)).arrivalSeq > 0);
    await pair.restartB();
    pair.failAcks.value = false;
    await pair.b.mailbox.flush();
    await pair.a.mailbox.poll();
    assert.deepEqual((await pair.a.storage.deviceEvents().listPending("room")).map(item => item.event.eventId), [held.eventId]);
    assert.deepEqual(pair.applied, [other.eventId], "receipt redelivery does not reapply its domain action");
  } finally { await pair.close(); }
});

test("header probes repair expired events and ACKs when enrolled peers never overlap online", async () => {
  const pair = await mailboxDevices();
  try {
    const event = await pair.publish("chat", "message");
    pair.expire(); // Relay accepted the event, but it expired before receiver returned.
    await pair.restartA();
    await pair.a.mailbox.flush(); // Only small headers, not the original body.
    assert.equal(pair.packets.at(-1)?.type, "probe");
    await pair.b.mailbox.poll(); // Receiver queues a repair request while origin is away.
    assert.equal(pair.packets.at(-1)?.type, "resend");
    await pair.a.mailbox.poll(); // Origin later returns with its retained signed event.
    await pair.b.mailbox.poll();
    assert.deepEqual(pair.applied, [event.eventId]);
    pair.expire(); // Lose the ACK before its intended reader comes back.
    await pair.restartA();
    await pair.a.mailbox.flush();
    pair.failAcks.value = true;
    await pair.b.mailbox.poll();
    assert.equal((await pair.b.storage.deviceEvents().pendingReceipts("room", pair.a.id)).length, 1);
    await pair.restartB();
    pair.failAcks.value = false;
    await pair.b.mailbox.flush();
    await pair.a.mailbox.poll();
    assert.equal((await pair.a.storage.deviceEvents().listPending("room")).length, 0);
    assert.deepEqual(pair.applied, [event.eventId]);
  } finally { await pair.close(); }
});

async function mailboxDevices() {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-mailbox-repair-"));
  const pairing = { rendezvousId: "room", relaySealKeyBase64: Buffer.alloc(32, 7).toString("base64url"),
    outboxUrl: "https://relay.invalid/v1/mailbox/events" } as MobilePairingPackage;
  const paths = [path.join(directory, "a.sqlite3"), path.join(directory, "b.sqlite3")];
  const identities = await Promise.all(paths.map(dbPath => new ChatEventLogService(new StorageService({ dbPath })).getOrCreateDeviceIdentity()));
  const events: any[] = [];
  const packets: DeviceEventPacket[] = [];
  const applied: string[] = [];
  const failedKinds = new Set<string>();
  const failAcks = { value: false };
  let arrival = 0;
  const fakeFetch = async (input: any, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST") {
      const incoming = JSON.parse(String(init.body)).events;
      for (const event of incoming) {
        const packet = await openMobileRelayPayload(JSON.stringify(event.payload), pairing.relaySealKeyBase64) as DeviceEventPacket;
        if (packet.type === "ack" && failAcks.value) return new Response("unavailable", { status: 503 });
        packets.push(packet);
        if (!events.some(entry => entry.eventId === event.eventId)) events.push({ ...event, arrivalSeq: ++arrival });
      }
      return Response.json({ ackRole: "mailbox", eventIds: incoming.map((event: any) => event.eventId) });
    }
    const cursor = Number(new URL(String(input)).searchParams.get("afterArrival"));
    return Response.json({ epoch: "same-epoch", events: events.filter(event => event.arrivalSeq > cursor).slice(0, 100) });
  };
  const make = (index: number) => {
    const storage = new StorageService({ dbPath: paths[index] });
    const id = identities[index].originId;
    const peer = identities[1 - index];
    const mailbox: DeviceEventMailbox = new DeviceEventMailbox({ storage, pairing, localDeviceId: id, peerDeviceId: peer.originId,
      fetch: fakeFetch as typeof fetch, receive: packet => channel.receive(packet), onError: () => undefined });
    const channel: DeviceEventChannel = new DeviceEventChannel({ storage, eventLog: new ChatEventLogService(storage), channelId: "room",
      localDeviceId: id, peerDeviceId: peer.originId, peerPublicKeyDerBase64: peer.publicKeyDerBase64,
      send: packet => mailbox.sendPacket(packet), onError: () => undefined, apply: async event => {
        if (failedKinds.has(event.kind)) throw new Error("domain persistence failed");
        applied.push(event.eventId); return "applied";
      } });
    return { id, storage, channel, mailbox };
  };
  const stop = async (device: ReturnType<typeof make>) => {
    device.channel.close(); await device.channel.flush().catch(() => undefined); device.mailbox.close();
    await (device.mailbox as any).posts;
  };
  const pair = {
    a: make(0), b: make(1), applied, packets, failedKinds, failAcks,
    expire: () => { events.length = 0; },
    restartA: async () => { await stop(pair.a); pair.a = make(0); },
    restartB: async () => { await stop(pair.b); pair.b = make(1); },
    publish: async (conversationId: string, kind: string) => {
      const event = await pair.a.channel.publish({ conversationId, kind, payload: { text: "private" } });
      await pair.a.channel.flush(); await pair.a.mailbox.flush(); return event;
    },
    close: async () => { await stop(pair.a); await stop(pair.b); await rm(directory, { recursive: true, force: true }); }
  };
  return pair;
}
