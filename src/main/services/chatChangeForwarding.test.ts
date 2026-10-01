import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { DeviceEventPacket } from "../../shared/deviceEventChannel";
import { CHAT_CHANGES_EVENT_KIND, chatChangesLogScope } from "./chatChanges";
import { ChatEventLogService } from "./chatEventLog";
import { DeviceEventChannel } from "./deviceEventChannel";
import { signDevicePacket } from "./devicePacketAuthentication";
import { StorageService } from "./storage";

const SCOPE = chatChangesLogScope("chat-1");

interface Device {
  storage: StorageService;
  log: ChatEventLogService;
  originId: string;
  publicKeyDerBase64: string;
}

async function device(directory: string, name: string): Promise<Device> {
  const storage = new StorageService({ dbPath: path.join(directory, `${name}.sqlite3`) });
  const log = new ChatEventLogService(storage);
  const identity = await log.getOrCreateDeviceIdentity();
  return { storage, log, originId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64 };
}

function channel(self: Device, peer: Device, room: string, sent: DeviceEventPacket[], extra: {
  applied?: string[];
  forwardTo?: (event: ChatEventEnvelope) => Array<{ deviceId: string; channelId: string }>;
  forwardedOriginKey?: (originId: string) => string | undefined;
  peerHoldsEveryChat?: boolean;
} = {}): DeviceEventChannel {
  return new DeviceEventChannel({
    storage: self.storage, eventLog: self.log, channelId: room,
    localDeviceId: self.originId, peerDeviceId: peer.originId, peerPublicKeyDerBase64: peer.publicKeyDerBase64,
    send: async (packet) => { sent.push(packet); },
    apply: async (event) => { extra.applied?.push(event.eventId); return "applied"; },
    ...(extra.forwardTo ? { forwardTo: extra.forwardTo } : {}),
    ...(extra.forwardedOriginKey ? { forwardedOriginKey: extra.forwardedOriginKey } : {}),
    ...(extra.peerHoldsEveryChat ? { peerHoldsEveryChat: true } : {}),
    onError: () => undefined
  });
}

/** A machine's chat change, addressed to the desktop only, as a machine commits one. */
async function machineChange(machine: Device, desktop: Device, room: string, text: string): Promise<ChatEventEnvelope> {
  const result = await machine.log.appendLocalEvent({
    conversationId: "chat-1", logScopeId: SCOPE, kind: CHAT_CHANGES_EVENT_KIND,
    payload: { version: 1, conversationId: "chat-1", updatedAt: "2026-10-01T10:00:00.000Z", changes: [
      { type: "message.created", message: { id: text, role: "participant", participantId: "remote", content: text, createdAt: "2026-10-01T10:00:00.000Z", status: "done" } }
    ] },
    recipients: [{ deviceId: desktop.originId, channelId: room }]
  });
  return result.event;
}

function events(sent: DeviceEventPacket[]): DeviceEventPacket[] {
  return sent.splice(0).filter((packet) => packet.type === "event");
}

test("a reply one machine wrote reaches another machine through the desktop, unchanged and signed by its author", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-chat-forward-"));
  const open: DeviceEventChannel[] = [];
  try {
    const desktop = await device(directory, "desktop");
    const machineA = await device(directory, "machine-a");
    const machineB = await device(directory, "machine-b");
    const stranger = await device(directory, "stranger");
    const fromA: DeviceEventPacket[] = [];
    const desktopToA: DeviceEventPacket[] = [];
    const desktopToB: DeviceEventPacket[] = [];
    const fromB: DeviceEventPacket[] = [];
    const appliedOnB: string[] = [];
    const aToDesktop = channel(machineA, desktop, "room-a", fromA);
    const desktopFromA = channel(desktop, machineA, "room-a", desktopToA, {
      forwardTo: (event) => event.originId === machineA.originId ? [{ deviceId: machineB.originId, channelId: "room-b" }] : []
    });
    const desktopWithB = channel(desktop, machineB, "room-b", desktopToB, { peerHoldsEveryChat: true });
    const bFromDesktop = channel(machineB, desktop, "room-b", fromB, {
      applied: appliedOnB,
      forwardedOriginKey: (originId) => originId === machineA.originId ? machineA.publicKeyDerBase64 : undefined
    });
    open.push(aToDesktop, desktopFromA, desktopWithB, bFromDesktop);

    const first = await machineChange(machineA, desktop, "room-a", "first");
    await aToDesktop.flush();
    for (const packet of events(fromA)) await desktopFromA.receive(packet);
    const forwardedRows = await desktop.storage.deviceEvents().listPending("room-b", 0, machineB.originId);
    assert.deepEqual(forwardedRows.map((row) => row.event.eventId), [first.eventId], "recorded for machine B with its arrival");

    await desktopWithB.flush();
    const forwarded = events(desktopToB);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].type === "event" ? forwarded[0].event.originId : "", machineA.originId, "the author's event, not a copy re-signed by the desktop");
    await bFromDesktop.receive(forwarded[0]);
    assert.deepEqual(appliedOnB, [first.eventId]);
    for (const packet of fromB.splice(0)) if (packet.type === "ack") await desktopWithB.receive(packet);
    assert.equal((await desktop.storage.deviceEvents().listPending("room-b", 0, machineB.originId)).length, 0, "acknowledged by machine B");

    // A device that does not know the author refuses it.
    const strangerFromDesktop = channel(stranger, desktop, "room-b", [], { forwardedOriginKey: () => undefined });
    open.push(strangerFromDesktop);
    await assert.rejects(strangerFromDesktop.receive({ ...forwarded[0], to: stranger.originId }), /signature or channel scope/);

    // A change that reached the desktop before machine B was known is served
    // to B on request, from what the desktop holds.
    const second = await machineChange(machineA, desktop, "room-a", "second");
    const third = await machineChange(machineA, desktop, "room-a", "third");
    await aToDesktop.flush();
    for (const packet of events(fromA)) await desktopFromA.receive(packet);
    await (desktop.storage as unknown as { runSql(sql: string): Promise<void> }).runSql(
      `delete from device_event_outbox where event_id = '${second.eventId}' and device_id = '${machineB.originId}';`);
    await desktopWithB.flush();
    const onlyThird = events(desktopToB);
    assert.deepEqual(onlyThird.map((packet) => packet.type === "event" ? packet.event.eventId : ""), [third.eventId]);
    await bFromDesktop.receive(onlyThird[0]);
    assert.deepEqual(appliedOnB, [first.eventId], "the third waits for the second");
    const resend = fromB.splice(0).find((packet) => packet.type === "resend");
    assert.ok(resend && resend.type === "resend");
    assert.deepEqual([resend.gap.originId, resend.gap.fromSeq, resend.gap.toSeq], [machineA.originId, second.originSeq, second.originSeq]);
    await desktopWithB.receive(resend);
    for (const packet of desktopToB.splice(0)) await bFromDesktop.receive(packet);
    assert.deepEqual(appliedOnB, [first.eventId, second.eventId, third.eventId]);

    // A phone is served only what was addressed to it, never another chat change.
    const phone = await device(directory, "phone");
    const toPhone: DeviceEventPacket[] = [];
    const desktopWithPhone = channel(desktop, phone, "room-b", toPhone);
    open.push(desktopWithPhone);
    const { protocol: _protocol, from: _from, to: _to, ...resendBody } = resend;
    await desktopWithPhone.receive(signDevicePacket({ ...resendBody, protocol: resend.protocol, from: phone.originId, to: desktop.originId },
      await phone.log.getOrCreateDeviceIdentity()));
    assert.deepEqual(toPhone.filter((packet) => packet.type === "event"), []);

    // Machine A is removed: B refuses its signature from then on, so what A
    // wrote is no longer offered to B.
    const fourth = await machineChange(machineA, desktop, "room-a", "fourth");
    await aToDesktop.flush();
    for (const packet of events(fromA)) await desktopFromA.receive(packet);
    const pendingForB = async () => (await desktop.storage.deviceEvents().listPending("room-b", 0, machineB.originId)).map((row) => row.event.eventId);
    assert.ok((await pendingForB()).includes(fourth.eventId));
    assert.ok(await desktop.storage.deviceEvents().forgetOrigin(machineA.originId) >= 1);
    assert.deepEqual(await pendingForB(), []);
  } finally {
    for (const item of open) item.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("after a copy, what other machines wrote beyond its marks is shared with the new machine, and nothing up to them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-chat-share-"));
  try {
    const desktop = await device(directory, "desktop");
    const machineA = await device(directory, "machine-a");
    const fromA: DeviceEventPacket[] = [];
    const aToDesktop = channel(machineA, desktop, "room-a", fromA);
    const desktopFromA = channel(desktop, machineA, "room-a", []);
    const changes: ChatEventEnvelope[] = [];
    for (const text of ["one", "two", "three"]) changes.push(await machineChange(machineA, desktop, "room-a", text));
    const other = await machineA.log.appendLocalEvent({
      conversationId: "chat-2", logScopeId: chatChangesLogScope("chat-2"), kind: CHAT_CHANGES_EVENT_KIND,
      payload: { version: 1, conversationId: "chat-2", updatedAt: "2026-10-01T10:00:00.000Z", changes: [] },
      recipients: [{ deviceId: desktop.originId, channelId: "room-a" }]
    });
    await aToDesktop.flush();
    for (const packet of events(fromA)) await desktopFromA.receive(packet);
    aToDesktop.close();
    desktopFromA.close();

    const shared = await desktop.storage.deviceEvents().shareChatChangesAfter(machineA.originId,
      [{ logScopeId: SCOPE, originSeq: changes[1].originSeq }], { deviceId: "device-new", channelId: "room-new" });
    assert.equal(shared, 2, "the third change of the first chat, and the chat without a mark");
    const rows = await desktop.storage.deviceEvents().listPending("room-new", 0, "device-new");
    assert.deepEqual(rows.map((row) => row.event.eventId).sort(), [changes[2].eventId, other.event.eventId].sort());
    assert.equal(await desktop.storage.deviceEvents().shareChatChangesAfter(machineA.originId,
      [{ logScopeId: SCOPE, originSeq: changes[1].originSeq }], { deviceId: "device-new", channelId: "room-new" }), 0, "running it again adds nothing");
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
