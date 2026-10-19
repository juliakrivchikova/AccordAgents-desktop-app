import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CHAT_CHANGES_EVENT_KIND, chatChangesLogScope } from "../main/services/chatChanges";
import { ChatEventLogService } from "../main/services/chatEventLog";
import { ChatSearchService } from "../main/services/chatSearch";
import { HubClient } from "../main/services/hubClient";
import { HubSync, type HubApplyOutcome, type HubDeliverOutcome } from "../main/services/hubSync";
import { StorageService } from "../main/services/storage";
import type { ChatEventEnvelope } from "../shared/chatEvents";
import { HubLog } from "./hubLog";
import { HubServer } from "./hubServer";

async function store(dir: string, name: string) {
  const storage = new StorageService({ dbPath: path.join(dir, `${name}.sqlite3`), sqliteExecutable: "sqlite3" });
  await storage.init();
  const log = new ChatEventLogService(storage);
  return { storage, log, identity: await log.getOrCreateDeviceIdentity() };
}

type Device = Awaited<ReturnType<typeof store>>;

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-sync-"));
  const hubStore = await store(dir, "hub");
  const desktop = await store(dir, "desktop");
  const phone = await store(dir, "phone");
  await hubStore.storage.hub().setOwner({ deviceId: desktop.identity.originId, publicKeyDerBase64: desktop.identity.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  await hubStore.storage.hub().replaceRoster([{ deviceId: phone.identity.originId, publicKeyDerBase64: phone.identity.publicKeyDerBase64, role: "phone", name: "iPhone", addedAt: "" }], new Date().toISOString());
  const hubLog = new HubLog(hubStore.storage);
  const server = new HubServer({ hubId: "hub-sync", version: "test", storage: hubStore.storage, log: hubLog, search: new ChatSearchService(hubStore.storage), vapidPublicKey: "B" });
  const http = await server.listenHttp(0, "127.0.0.1");
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const keys = new Map([desktop, phone].map((device) => [device.identity.originId, device.identity.publicKeyDerBase64]));
  const syncs: HubSync[] = [];
  const link = (device: Device, applied: ChatEventEnvelope[], options: {
    trustedKey?: (originId: string) => Promise<string | undefined>;
    applyChatChange?: (event: ChatEventEnvelope) => Promise<HubApplyOutcome>;
    deliver?: (event: ChatEventEnvelope) => Promise<HubDeliverOutcome>;
    onPushed?: (eventIds: string[]) => Promise<void>;
    log?: (event: string, payload: Record<string, unknown>) => void;
  } = {}) => {
    const sync = new HubSync({
      client: new HubClient({ url, identity: async () => device.identity, storage: device.storage }),
      storage: device.storage,
      localOriginId: async () => device.identity.originId,
      trustedKey: options.trustedKey ?? (async (originId) => keys.get(originId)),
      applyChatChange: options.applyChatChange ?? (async (event) => { applied.push(event); return "applied"; }),
      ...(options.deliver ? { deliver: options.deliver } : {}),
      ...(options.onPushed ? { onPushed: options.onPushed } : {}),
      ...(options.log ? { log: options.log } : {})
    });
    syncs.push(sync);
    return sync;
  };
  t.after(async () => {
    for (const sync of syncs) sync.stop();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, hubStore, desktop, phone, server, url, link };
}

const change = (conversationId: string, n: number, content = `message ${n}`) => ({
  conversationId, logScopeId: chatChangesLogScope(conversationId), kind: CHAT_CHANGES_EVENT_KIND,
  payload: { version: 1, conversationId, updatedAt: new Date().toISOString(), changes: [{ type: "message.created", message: { id: `m${n}`, role: "user", content, createdAt: new Date().toISOString() } }] }
});

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Pushes everything the device wrote and waits until the hub holds it. */
async function pushAll(sync: HubSync, s: Awaited<ReturnType<typeof setup>>, count: number): Promise<void> {
  sync.start();
  sync.nudgePush();
  await until(async () => (await s.hubStore.storage.hub().head()) >= count);
  await sync.idle();
}

test("what one device writes reaches another through the hub, live, once, in order", async (t) => {
  // As in Electron, whose Node has no WebSocket of its own.
  const builtIn = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: true, writable: true });
  t.after(() => { if (builtIn) Object.defineProperty(globalThis, "WebSocket", builtIn); });
  const s = await setup(t);
  const fromDesktop: ChatEventEnvelope[] = [];
  const onPhone: ChatEventEnvelope[] = [];
  const desktopSync = s.link(s.desktop, fromDesktop);
  const phoneSync = s.link(s.phone, onPhone);
  desktopSync.start();
  phoneSync.start();
  await until(() => desktopSync.isConnected() && phoneSync.isConnected());
  for (const n of [1, 2, 3]) {
    await s.desktop.log.appendLocalEvent(change("chat-a", n));
    desktopSync.nudgePush();
  }
  // The phone is told by the live socket and reads the news on its own.
  await until(() => onPhone.length === 3);
  assert.deepEqual(onPhone.map((event) => event.originSeq), [1, 2, 3]);
  assert.equal(fromDesktop.length, 0, "a device never applies its own events back");
  // A restart reads from where it stopped: nothing is applied twice.
  await phoneSync.idle();
  phoneSync.stop();
  const again: ChatEventEnvelope[] = [];
  const restarted = s.link(s.phone, again);
  restarted.start();
  await s.desktop.log.appendLocalEvent(change("chat-a", 4));
  desktopSync.nudgePush();
  await until(() => again.length === 1);
  assert.equal(again[0].originSeq, 4);
  // And the phone holds the events themselves, signed by the desktop.
  assert.equal((await s.phone.storage.listChatEvents("chat-a", chatChangesLogScope("chat-a"))).length, 4);
});

test("a hub that missed the start of a chain is sent it from where it stands", async (t) => {
  const s = await setup(t);
  for (const n of [1, 2, 3]) await s.desktop.log.appendLocalEvent(change("chat-b", n));
  // As if the first two had been pushed to a hub that has since lost them.
  const own = await s.desktop.storage.hub().ownEventsAfter(s.desktop.identity.originId, 0, 10);
  await s.desktop.storage.hub().setClientState("pushed-rowid", String(own[1].rowid));
  await pushAll(s.link(s.desktop, []), s, 3);
  const pulled = await s.hubStore.storage.hub().pull(0, 10);
  assert.deepEqual(pulled.events.map((item) => item.event.originSeq), [1, 2, 3], "the chain arrives whole and in order");
  assert.equal(await s.desktop.storage.hub().clientState("pushed-rowid"), String(own[2].rowid));
});

test("a gap in the middle of a page does not leave the rest of the page behind", async (t) => {
  const s = await setup(t);
  for (const n of [1, 2, 3]) await s.desktop.log.appendLocalEvent(change("chat-b", n));
  await s.desktop.log.appendLocalEvent(change("chat-a", 1));
  const own = await s.desktop.storage.hub().ownEventsAfter(s.desktop.identity.originId, 0, 10);
  // The page starts at chat-b #2: the hub lacks #1, and chat-a follows.
  await s.desktop.storage.hub().setClientState("pushed-rowid", String(own[0].rowid));
  await pushAll(s.link(s.desktop, []), s, 4);
  assert.equal((await s.hubStore.storage.hub().pull(0, 10)).events.length, 4);
  assert.equal(await s.desktop.storage.hub().clientState("pushed-rowid"), String(own[3].rowid));
});

test("an event the hub refuses is reported and never counted as delivered; the rest go on", async (t) => {
  const s = await setup(t);
  const pushed: string[] = [];
  const logs: string[] = [];
  // Under a chat change's scope, only a chat change may travel.
  const refused = await s.desktop.log.appendLocalEvent({ ...change("chat-r", 1), kind: "machine.trust.roster" });
  const kept = await s.desktop.log.appendLocalEvent(change("chat-k", 1));
  const sync = s.link(s.desktop, [], { onPushed: async (ids) => { pushed.push(...ids); }, log: (event) => logs.push(event) });
  await pushAll(sync, s, 1);
  assert.deepEqual(pushed, [kept.event.eventId]);
  assert.ok(!pushed.includes(refused.event.eventId));
  assert.ok(logs.includes("hub.sync.push-refused"));
});

test("an event from a device not known yet is held, and taken once it is known", async (t) => {
  const s = await setup(t);
  const applied: ChatEventEnvelope[] = [];
  let known: string | undefined;
  const phoneSync = s.link(s.phone, applied, { trustedKey: async () => known });
  await s.desktop.log.appendLocalEvent(change("chat-c", 1));
  await pushAll(s.link(s.desktop, []), s, 1);
  phoneSync.start();
  await until(async () => (await s.phone.storage.hub().heldEvents(0, 10)).length === 1);
  await phoneSync.idle();
  assert.deepEqual(applied, [], "not applied while the author is unknown");
  assert.equal((await s.phone.storage.listChatEvents("chat-c", chatChangesLogScope("chat-c"))).length, 0, "and not stored either");
  known = s.desktop.identity.publicKeyDerBase64;
  phoneSync.nudgeHeld();
  await until(() => applied.length === 1);
  await until(async () => (await s.phone.storage.hub().heldEvents(0, 10)).length === 0);
});

test("a chat change that has to wait is held and applied later, not dropped", async (t) => {
  const s = await setup(t);
  const applied: ChatEventEnvelope[] = [];
  let ready = false;
  const phoneSync = s.link(s.phone, applied, {
    applyChatChange: async (event) => {
      if (!ready) return "held";
      applied.push(event);
      return "applied";
    }
  });
  await s.desktop.log.appendLocalEvent(change("chat-w", 1));
  await s.desktop.log.appendLocalEvent(change("chat-x", 1));
  await pushAll(s.link(s.desktop, []), s, 2);
  phoneSync.start();
  await until(async () => (await s.phone.storage.hub().heldEvents(0, 10)).length === 2);
  ready = true;
  phoneSync.nudgeHeld();
  await until(() => applied.length === 2);
  assert.deepEqual(applied.map((event) => event.conversationId), ["chat-w", "chat-x"], "in the hub's order");
});

test("an event for a channel not set up yet waits for it; traffic of others is passed over", async (t) => {
  const s = await setup(t);
  const delivered: string[] = [];
  let channelReady = false;
  const phoneSync = s.link(s.phone, [], {
    deliver: async (event) => {
      if (event.conversationId === "theirs") return "not-mine";
      if (!channelReady) return "not-ready";
      delivered.push(event.conversationId);
      return "delivered";
    }
  });
  await s.desktop.log.appendLocalEvent({ conversationId: "mine", logScopeId: "device:room-1:[\"mine\",\"actions\"]", kind: "machine.turn.request", payload: { n: 1 } });
  await s.desktop.log.appendLocalEvent({ conversationId: "theirs", logScopeId: "device:room-2:[\"theirs\",\"actions\"]", kind: "machine.turn.request", payload: { n: 2 } });
  await pushAll(s.link(s.desktop, []), s, 2);
  phoneSync.start();
  await until(async () => (await s.phone.storage.hub().heldEvents(0, 10)).length === 1);
  await phoneSync.idle();
  assert.equal(await s.phone.storage.hub().clientState("pulled-hub-seq"), "2", "the read went on past the held place");
  channelReady = true;
  phoneSync.nudgeHeld();
  await until(() => delivered.length === 1);
  assert.deepEqual(delivered, ["mine"]);
});

test("one event that fails to apply does not stop the events after it", async (t) => {
  const s = await setup(t);
  const applied: string[] = [];
  const phoneSync = s.link(s.phone, [], {
    applyChatChange: async (event) => {
      if (event.conversationId === "broken") throw new Error("This chat cannot be read.");
      applied.push(event.conversationId);
      return "applied";
    }
  });
  await s.desktop.log.appendLocalEvent(change("broken", 1));
  await s.desktop.log.appendLocalEvent(change("fine", 1));
  await pushAll(s.link(s.desktop, []), s, 2);
  phoneSync.start();
  await until(() => applied.length === 1);
  assert.deepEqual(applied, ["fine"]);
  await until(async () => (await s.phone.storage.hub().heldEvents(0, 10))[0]?.reason === "error");
});

test("a large chat change travels through the hub as a body uploaded when the hub asks", async (t) => {
  const s = await setup(t);
  const onPhone: ChatEventEnvelope[] = [];
  const big = change("chat-big", 1, "x".repeat(100_000));
  await s.desktop.log.appendLocalEvent({ ...big, payload: await s.desktop.storage.deviceEventBlobs().prepare(big.payload) });
  await pushAll(s.link(s.desktop, []), s, 1);
  const phoneSync = s.link(s.phone, onPhone);
  phoneSync.start();
  await until(() => onPhone.length === 1);
  const payload = await s.phone.storage.deviceEventBlobs().hydrate(onPhone[0].payload) as typeof big.payload;
  assert.equal(payload.changes[0].message.content.length, 100_000);
});

test("a hub that is behind this device (restored) is read from its own head, not skipped", async (t) => {
  const s = await setup(t);
  const onPhone: ChatEventEnvelope[] = [];
  await s.phone.storage.hub().setClientState("pulled-hub-seq", "50");
  const phoneSync = s.link(s.phone, onPhone);
  phoneSync.start();
  await until(async () => (await s.phone.storage.hub().clientState("pulled-hub-seq")) === "0");
  await s.desktop.log.appendLocalEvent(change("chat-n", 1));
  await pushAll(s.link(s.desktop, []), s, 1);
  phoneSync.nudgePull();
  await until(() => onPhone.length === 1);
});

test("a held change of one chat does not keep another chat's held change waiting", async (t) => {
  const s = await setup(t);
  const applied: string[] = [];
  const available = new Set<string>();
  const phoneSync = s.link(s.phone, [], {
    applyChatChange: async (event) => {
      if (!available.has(event.conversationId)) return "held";
      applied.push(event.conversationId);
      return "applied";
    }
  });
  await s.desktop.log.appendLocalEvent(change("never", 1));
  await s.desktop.log.appendLocalEvent(change("later", 1));
  await pushAll(s.link(s.desktop, []), s, 2);
  phoneSync.start();
  await until(async () => (await s.phone.storage.hub().heldEvents(0, 10)).length === 2);
  available.add("later");
  phoneSync.nudgeHeld();
  await until(() => applied.length === 1);
  assert.deepEqual(applied, ["later"]);
});

test("a later change of a chat stays behind an earlier one that is held, then both apply in order", async (t) => {
  const s = await setup(t);
  const applied: number[] = [];
  let firstReady = false;
  const phoneSync = s.link(s.phone, [], {
    applyChatChange: async (event) => {
      if (event.originSeq === 1 && !firstReady) throw new Error("not readable yet");
      applied.push(event.originSeq);
      return "applied";
    }
  });
  await s.desktop.log.appendLocalEvent(change("ordered", 1));
  await s.desktop.log.appendLocalEvent(change("ordered", 2));
  await pushAll(s.link(s.desktop, []), s, 2);
  phoneSync.start();
  await until(async () => (await s.phone.storage.hub().heldEvents(0, 10)).length === 2);
  assert.deepEqual(applied, [], "the second waits behind the first");
  firstReady = true;
  phoneSync.nudgeHeld();
  await until(() => applied.length === 2);
  assert.deepEqual(applied, [1, 2]);
});

test("a TypeError from applying one event holds that event; it does not stall the read", async (t) => {
  const s = await setup(t);
  const applied: string[] = [];
  const phoneSync = s.link(s.phone, [], {
    applyChatChange: async (event) => {
      if (event.conversationId === "odd") throw new TypeError("Cannot read properties of undefined");
      applied.push(event.conversationId);
      return "applied";
    }
  });
  await s.desktop.log.appendLocalEvent(change("odd", 1));
  await s.desktop.log.appendLocalEvent(change("normal", 1));
  await pushAll(s.link(s.desktop, []), s, 2);
  phoneSync.start();
  await until(() => applied.length === 1);
  assert.deepEqual(applied, ["normal"]);
});

test("another hub at the same address is read from its start", async (t) => {
  const s = await setup(t);
  const onPhone: ChatEventEnvelope[] = [];
  await s.phone.storage.hub().setClientState("hub-id", "hub-before");
  await s.phone.storage.hub().setClientState("pulled-hub-seq", "1");
  await s.desktop.log.appendLocalEvent(change("fresh", 1));
  await s.desktop.log.appendLocalEvent(change("fresh", 2));
  await pushAll(s.link(s.desktop, []), s, 2);
  const phoneSync = s.link(s.phone, onPhone);
  phoneSync.start();
  await until(() => onPhone.length === 2);
  assert.equal(await s.phone.storage.hub().clientState("hub-id"), "hub-sync");
});

test("the hub's holding an event lets go only of the devices that read the hub", async (t) => {
  const s = await setup(t);
  const { event } = await s.desktop.log.appendLocalEvent(change("outbox", 1));
  const sql = (text: string) => (s.desktop.storage as unknown as { runSql(sql: string): Promise<void> }).runSql(text);
  const rows = (text: string) => (s.desktop.storage as unknown as { queryJson<T>(sql: string): Promise<T[]> }).queryJson<{ deviceId: string; acknowledged: string | null }>(text);
  await sql(`insert into device_event_outbox(event_id, device_id, channel_id) values ('${event.eventId}', 'device-hub', 'room-hub'), ('${event.eventId}', 'device-relay', 'room-relay');`);
  await s.desktop.storage.hub().acknowledgeOutbox([event.eventId], new Date().toISOString(), ["device-hub"]);
  const outbox = await rows(`select device_id as deviceId, acknowledged_at as acknowledged from device_event_outbox where event_id = '${event.eventId}' order by device_id;`);
  assert.deepEqual(outbox.map((row) => [row.deviceId, Boolean(row.acknowledged)]), [["device-hub", true], ["device-relay", false]]);
});

test("only the scopes the device names at each pass go to the hub (a relay machine's channel stays off it)", async (t) => {
  const s = await setup(t);
  const rooms = ["device:room-hub:"];
  await s.desktop.log.appendLocalEvent({ conversationId: "c", logScopeId: "device:room-hub:[\"c\",\"actions\"]", kind: "machine.turn.request", payload: { n: 1 } });
  await s.desktop.log.appendLocalEvent({ conversationId: "c", logScopeId: "device:room-relay:[\"c\",\"actions\"]", kind: "machine.turn.request", payload: { n: 2 } });
  await s.desktop.log.appendLocalEvent(change("shared", 1));
  const sync = new HubSync({
    client: new HubClient({ url: s.url, identity: async () => s.desktop.identity, storage: s.desktop.storage }),
    storage: s.desktop.storage,
    localOriginId: async () => s.desktop.identity.originId,
    trustedKey: async () => undefined,
    applyChatChange: async () => "applied",
    scopePrefixes: async () => ["chat-changes:", ...rooms]
  });
  t.after(() => sync.stop());
  sync.startPushing();
  await until(async () => (await s.hubStore.storage.hub().head()) === 2);
  await sync.idle();
  const scopes = (await s.hubStore.storage.hub().pull(0, 10)).events.map((item) => item.event.logScopeId);
  assert.deepEqual(scopes.sort(), ["chat-changes:shared", "device:room-hub:[\"c\",\"actions\"]"]);
});

test("a hub read without the live link still counts as reached, and one that stops answering does not", async (t) => {
  const s = await setup(t);
  const client = new HubClient({ url: s.url, identity: async () => s.desktop.identity, storage: s.desktop.storage });
  // A network that lets requests through and not the live socket.
  client.live = () => () => undefined;
  const sync = new HubSync({
    client,
    storage: s.desktop.storage,
    localOriginId: async () => s.desktop.identity.originId,
    trustedKey: async () => undefined,
    applyChatChange: async () => "applied"
  });
  t.after(() => sync.stop());
  assert.equal(sync.isReachable(), false, "nothing read yet");
  sync.start();
  await until(() => sync.isReachable());
  assert.equal(sync.isConnected(), false);
  await s.server.close();
  sync.nudgePull();
  await until(() => !sync.isReachable());
});
