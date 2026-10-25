import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CHAT_CHANGES_EVENT_KIND, chatChangesLogScope } from "../main/services/chatChanges";
import { ChatEventLogService } from "../main/services/chatEventLog";
import { ChatSearchService } from "../main/services/chatSearch";
import { ChatService } from "../main/services/chat";
import type { ChatMessage, Conversation } from "../shared/types";
import { HubClient } from "../main/services/hubClient";
import { HubSync, hubChatChangeApplier, readGivenUp, type HubApplyOutcome, type HubDeliverOutcome } from "../main/services/hubSync";
import { StorageService } from "../main/services/storage";
import type { ChatEventEnvelope } from "../shared/chatEvents";
import { CHAT_COPY_HUB_POSITION_KEY, type CopiedConversation } from "../main/services/chatCopy";
import { HubFolder } from "./hubFolder";
import { HubLog } from "./hubLog";
import { hubApplyPolicy } from "./hubPolicy";
import { HUB_RETENTION_DEFAULTS, HubRetention } from "./hubRetention";
import { HubServer } from "./hubServer";

async function store(dir: string, name: string) {
  const storage = new StorageService({ dbPath: path.join(dir, `${name}.sqlite3`), sqliteExecutable: "sqlite3" });
  await storage.init();
  const log = new ChatEventLogService(storage);
  return { storage, log, identity: await log.getOrCreateDeviceIdentity() };
}

type Device = Awaited<ReturnType<typeof store>>;

async function setup(t: test.TestContext, options: { snapshotPageBytes?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-sync-"));
  const hubStore = await store(dir, "hub");
  const desktop = await store(dir, "desktop");
  const phone = await store(dir, "phone");
  await hubStore.storage.hub().setOwner({ deviceId: desktop.identity.originId, publicKeyDerBase64: desktop.identity.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  await hubStore.storage.hub().replaceRoster([{ deviceId: phone.identity.originId, publicKeyDerBase64: phone.identity.publicKeyDerBase64, role: "phone", name: "iPhone", addedAt: "" }], new Date().toISOString());
  const hubLog = new HubLog(hubStore.storage, () => new Date(), options.snapshotPageBytes);
  // The hub's copy of the chats, as the hub keeps it (a device starting again reads it).
  const folder = new HubFolder(hubStore.storage, hubApplyPolicy(hubStore.storage));
  hubLog.onAppended(({ changedConversationIds }) => folder.enqueue(changedConversationIds));
  const server = new HubServer({ hubId: "hub-sync", version: "test", storage: hubStore.storage, log: hubLog, search: new ChatSearchService(hubStore.storage), vapidPublicKey: "B" });
  const http = await server.listenHttp(0, "127.0.0.1");
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const keys = new Map([desktop, phone].map((device) => [device.identity.originId, device.identity.publicKeyDerBase64]));
  const syncs: HubSync[] = [];
  const link = (device: Device, applied: ChatEventEnvelope[], options: {
    trustedKey?: (originId: string) => Promise<string | undefined>;
    applyChatChange?: (event: ChatEventEnvelope) => Promise<HubApplyOutcome>;
    deliver?: (event: ChatEventEnvelope, fetchBody: () => Promise<void>) => Promise<HubDeliverOutcome>;
    onPushed?: (eventIds: string[]) => Promise<void>;
    log?: (event: string, payload: Record<string, unknown>) => void;
    mergeCopy?: (copied: CopiedConversation) => Promise<void>;
    ownScopes?: () => Promise<readonly string[]>;
    now?: () => number;
  } = {}) => {
    const sync = new HubSync({
      client: new HubClient({ url, identity: async () => device.identity, storage: device.storage }),
      storage: device.storage,
      localOriginId: async () => device.identity.originId,
      trustedKey: options.trustedKey ?? (async (originId) => keys.get(originId)),
      applyChatChange: options.applyChatChange ?? (async (event) => { applied.push(event); return "applied"; }),
      ...(options.deliver ? { deliver: options.deliver } : {}),
      ...(options.onPushed ? { onPushed: options.onPushed } : {}),
      ...(options.log ? { log: options.log } : {}),
      ...(options.mergeCopy ? { mergeCopy: options.mergeCopy } : {}),
      ...(options.ownScopes ? { ownScopes: options.ownScopes } : {}),
      ...(options.now ? { now: options.now } : {})
    });
    syncs.push(sync);
    return sync;
  };
  t.after(async () => {
    for (const sync of syncs) sync.stop();
    // A read in flight finishes before the files go.
    for (const sync of syncs) await sync.idle();
    await server.close();
    await folder.idle();
    folder.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dir, hubStore, hubLog, folder, desktop, phone, server, url, link };
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
  // The first pass may still be offering them again: it ends before the change.
  await phoneSync.idle();
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

// --- Bounded storage: nothing dropped for its age, starting again, gaps, bodies ---

const DAY = 24 * 60 * 60_000;

const createdChat = (conversationId: string) => ({
  conversationId, logScopeId: chatChangesLogScope(conversationId), kind: CHAT_CHANGES_EVENT_KIND,
  payload: { version: 1, conversationId, updatedAt: new Date().toISOString(), changes: [{ type: "conversation.created", conversation: { title: "Copy", kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: [] } } }] }
});

async function addMachine(s: Awaited<ReturnType<typeof setup>>, machine: Device, rendezvousId = "room-1") {
  await s.hubStore.storage.hub().replaceRoster([
    { deviceId: s.phone.identity.originId, publicKeyDerBase64: s.phone.identity.publicKeyDerBase64, role: "phone", name: "iPhone", addedAt: "" },
    { deviceId: machine.identity.originId, publicKeyDerBase64: machine.identity.publicKeyDerBase64, role: "machine", name: "Box", addedAt: "", machineId: "m-1", reader: true, rendezvousId }
  ], new Date().toISOString());
  s.server.invalidateRoster();
}

test("a place held for an unknown author is kept however old, and let go only once the roster says it was removed", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine);
  let clock = Date.now();
  const logs: string[] = [];
  // The phone does not know the machine's key (not yet, or never).
  const phoneSync = s.link(s.phone, [], { trustedKey: async () => undefined, now: () => clock, log: (event) => logs.push(event) });
  await machine.log.appendLocalEvent(change("chat-u", 1));
  await pushAll(s.link(machine, []), s, 1);
  phoneSync.start();
  await until(async () => (await s.phone.storage.hub().heldEvents(0, 10)).length === 1);
  await phoneSync.idle();
  // A month later it is still held: age is no reason to drop it.
  clock += 30 * DAY;
  phoneSync.nudgeHeld();
  await phoneSync.idle();
  assert.equal((await s.phone.storage.hub().heldEvents(0, 10)).length, 1);
  assert.ok(!logs.includes("hub.sync.held-released"));
  // The owner takes the machine off the roster: what was held for it goes.
  await s.hubStore.storage.hub().replaceRoster([{ deviceId: s.phone.identity.originId, publicKeyDerBase64: s.phone.identity.publicKeyDerBase64, role: "phone", name: "iPhone", addedAt: "" }], new Date().toISOString());
  s.server.invalidateRoster();
  clock += 11 * 60_000;
  phoneSync.nudgeHeld();
  await until(async () => (await s.phone.storage.hub().heldEvents(0, 10)).length === 0);
  assert.ok(logs.includes("hub.sync.held-released"));
});

test("a device the hub no longer holds enough for starts again from the hub's copy and reads on from there", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine);
  await s.desktop.log.appendLocalEvent(createdChat("chat-s"));
  for (const n of [2, 3]) await s.desktop.log.appendLocalEvent(change("chat-s", n));
  const desktopSync = s.link(s.desktop, []);
  await pushAll(desktopSync, s, 3);
  await s.folder.idle();
  // The machine is taken off and put back (its place released), and the
  // hub forgot what everyone else had read meanwhile.
  await s.hubStore.storage.hub().recordRead(s.desktop.identity.originId, 3, 3, { from: 0, count: 0 }, new Date().toISOString());
  await s.hubStore.storage.hub().replaceRoster([], new Date().toISOString());
  s.server.invalidateRoster();
  await new HubRetention({ storage: s.hubStore.storage, config: { ...HUB_RETENTION_DEFAULTS }, now: () => Date.now() + 40 * DAY }).runOnce();
  await addMachine(s, machine);
  const merged: CopiedConversation[] = [];
  const applied: ChatEventEnvelope[] = [];
  const logs: string[] = [];
  const machineSync = s.link(machine, applied, { mergeCopy: async (copied) => { merged.push(copied); }, log: (event) => logs.push(event) });
  machineSync.start();
  await until(() => logs.includes("hub.sync.resync.finished"));
  await machineSync.idle();
  assert.deepEqual(merged.map((copied) => copied.id), ["chat-s"]);
  assert.equal(await machine.storage.hub().clientState("pulled-hub-seq"), "3");
  // From there it reads on as usual.
  await s.desktop.log.appendLocalEvent(change("chat-s", 4));
  desktopSync.nudgePush();
  await until(() => applied.length === 1);
  assert.equal(applied[0].originSeq, 4);
  assert.equal(logs.filter((event) => event === "hub.sync.resync.started").length, 1, "once");
});

test("starting again merges every chat of the hub's copy and continues each chain from its mark", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine);
  await s.desktop.log.appendLocalEvent(createdChat("chat-c"));
  for (const n of [2, 3]) await s.desktop.log.appendLocalEvent(change("chat-c", n));
  await pushAll(s.link(s.desktop, []), s, 3);
  await s.folder.idle();
  // The machine was away while all of it was forgotten.
  await s.hubStore.storage.hub().recordRead(s.desktop.identity.originId, 3, 3, { from: 0, count: 0 }, new Date().toISOString());
  await s.hubStore.storage.hub().replaceRoster([], new Date().toISOString());
  await new HubRetention({ storage: s.hubStore.storage, config: { ...HUB_RETENTION_DEFAULTS }, now: () => Date.now() + 40 * DAY }).runOnce();
  assert.equal((await s.hubStore.storage.hub().logSize()).events, 1, "the chain's newest stays");
  await addMachine(s, machine);
  const merged: CopiedConversation[] = [];
  const machineSync = s.link(machine, [], { mergeCopy: async (copied) => { merged.push(copied); } });
  machineSync.start();
  await until(() => merged.length === 1);
  await machineSync.idle();
  assert.equal(merged[0].id, "chat-c");
  assert.deepEqual(merged[0].messages.map((item) => item.id), ["m2", "m3"]);
  // The copy's mark is where this device continues the desktop's chain.
  assert.equal(await machine.storage.deviceEvents().appliedHead(s.desktop.identity.originId, chatChangesLogScope("chat-c")), 3);
});

test("a large body is fetched only for an event this device takes", async (t) => {
  const s = await setup(t);
  const big = (room: string, conversationId: string) => ({
    conversationId, logScopeId: `device:${room}:${JSON.stringify([conversationId, "actions"])}`, kind: "machine.turn.request",
    payload: { text: `${conversationId}:${"y".repeat(90_000)}` }
  });
  for (const item of [big("room-2", "theirs"), big("room-1", "mine")]) {
    await s.desktop.log.appendLocalEvent({ ...item, payload: await s.desktop.storage.deviceEventBlobs().prepare(item.payload) });
  }
  await pushAll(s.link(s.desktop, []), s, 2);
  const delivered: string[] = [];
  const phoneSync = s.link(s.phone, [], {
    deliver: async (event, fetchBody) => {
      if (event.conversationId === "theirs") return "not-mine";
      await fetchBody();
      delivered.push(event.conversationId);
      return "delivered";
    }
  });
  phoneSync.start();
  await until(() => delivered.length === 1);
  await phoneSync.idle();
  const count = Number(execFileSync("sqlite3", [path.join(s.dir, "phone.sqlite3"), "select count(*) from device_event_blobs;"], { encoding: "utf8" }).trim());
  assert.equal(count, 1, "only the body of the event it took");
});

test("a new machine starts where its copy was made, before any command of its own channel the hub holds", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine, "room-1");
  await s.desktop.log.appendLocalEvent(change("chat-n", 1));
  // A command for the machine, queued while it was being set up.
  await s.desktop.log.appendLocalEvent({ conversationId: "chat-n", logScopeId: "device:room-1:[\"chat-n\",\"actions\"]", kind: "machine.turn.request", payload: { n: 1 } });
  await s.desktop.log.appendLocalEvent(change("chat-n", 2));
  await s.desktop.log.appendLocalEvent(change("chat-n", 3));
  await pushAll(s.link(s.desktop, []), s, 4);
  // Its copy of the chats was made at position 4.
  await machine.storage.hub().setClientState(CHAT_COPY_HUB_POSITION_KEY, JSON.stringify({ hubId: "hub-sync", hubSeq: 4 }));
  const delivered: string[] = [];
  const applied: ChatEventEnvelope[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const machineSync = s.link(machine, applied, {
    ownScopes: async () => ["device:room-1:"],
    deliver: async (event) => {
      if (!event.logScopeId.startsWith("device:")) return "not-mine";
      delivered.push(event.kind);
      return "delivered";
    },
    log: (event, payload) => logs.push([event, payload])
  });
  machineSync.start();
  await until(() => delivered.length === 1);
  await machineSync.idle();
  assert.deepEqual(logs.find(([event]) => event === "hub.sync.started-from-copy")?.[1], { copyHubSeq: 4, hubSeq: 1 });
  assert.deepEqual(applied.map((event) => event.originSeq), [2, 3], "what came after the start, not the start of the order");
});

test("a gap a channel finds is filled from the hub; a stretch the hub forgot is passed over", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine, "room-1");
  const scope = "device:room-1:[\"chat-g\",\"terminal:run-1\"]";
  for (const n of [1, 2, 3]) await s.desktop.log.appendLocalEvent({ conversationId: "chat-g", logScopeId: scope, kind: "machine.turn.cancel", payload: { n } });
  await pushAll(s.link(s.desktop, []), s, 3);
  const delivered: number[] = [];
  const machineSync = s.link(machine, [], {
    deliver: async (event) => { delivered.push(event.originSeq); return "delivered"; }
  });
  const gap = { originId: s.desktop.identity.originId, logScopeId: scope, fromSeq: 1, toSeq: 2 };
  assert.equal(await machineSync.repairGap(gap), "repaired");
  assert.deepEqual(delivered, [1, 2]);
  // Both ends read it, a day passed: the hub forgot the run.
  await s.hubStore.storage.hub().recordRead(s.desktop.identity.originId, 3, 3, { from: 0, count: 0 }, new Date().toISOString());
  await s.hubStore.storage.hub().recordRead(machine.identity.originId, 3, 3, { from: 0, count: 0 }, new Date().toISOString());
  await new HubRetention({ storage: s.hubStore.storage, config: { ...HUB_RETENTION_DEFAULTS }, now: () => Date.now() + 2 * DAY }).runOnce();
  assert.equal(await machineSync.repairGap(gap), "skipped");
  assert.equal(await machine.storage.deviceEvents().appliedHead(s.desktop.identity.originId, scope), 3, "the chain continues after what was forgotten");
});

test("an event the channel refuses for good does not leave its chain waiting for it", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine, "room-1");
  const scope = `device:room-1:${JSON.stringify(["chat-f", "actions"])}`;
  for (const n of [1, 2]) await s.desktop.log.appendLocalEvent({ conversationId: "chat-f", logScopeId: scope, kind: "machine.turn.cancel", payload: { n } });
  await pushAll(s.link(s.desktop, []), s, 2);
  const delivered: number[] = [];
  const logs: string[] = [];
  const machineSync = s.link(machine, [], {
    deliver: async (event) => {
      if (event.originSeq === 1) return "refused";
      delivered.push(event.originSeq);
      return "delivered";
    },
    log: (event) => logs.push(event)
  });
  assert.equal(await machineSync.repairGap({ originId: s.desktop.identity.originId, logScopeId: scope, fromSeq: 1, toSeq: 1 }), "skipped");
  assert.ok(logs.includes("hub.sync.gap-refused"));
  assert.equal(await machine.storage.deviceEvents().appliedHead(s.desktop.identity.originId, scope), 1, "past the refused event");
  assert.deepEqual(delivered, [], "nothing after it was asked for");
});

test("a chat taken from the hub's copy: a machine takes its shared content, the desktop only messages it lacks, and a deleted chat stays deleted", async (t) => {
  const s = await setup(t);
  const fakes = {
    settings: { async getPublicSettings() { return { chatRoleConfigs: [], chatParticipantConfigs: [] }; } },
    cliRunner: { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; }, async closeConversationSessions() { return undefined; } },
    debugLogs: { async write() { return undefined; } }
  };
  const service = (storage: StorageService) => {
    const chat = new ChatService(storage as never, fakes.settings as never, fakes.cliRunner as never, fakes.debugLogs as never);
    (chat as unknown as { ensureHistoryFiles(): Promise<string> }).ensureHistoryFiles = async () => "/mock/history";
    return chat;
  };
  const at = new Date().toISOString();
  const local: Conversation = {
    id: "chat-m", kind: "chat", title: "Local title", createdAt: at, updatedAt: at, findings: [],
    messages: [{ id: "mine", role: "user", content: "written here, newer", createdAt: at } as ChatMessage,
      { id: "reply", role: "participant", participantId: "p1", content: "", status: "pending", createdAt: at } as ChatMessage],
    metadata: { participants: [{ id: "p1", handle: "bot", kind: "claude-code", permissions: { shell: false } }], running: true } as never
  };
  const copied: CopiedConversation = {
    id: "chat-m", updatedAt: at, removed: [],
    shared: { title: "Server title", kind: "chat", createdAt: at, metadata: { participants: [{ id: "p1", handle: "bot", kind: "claude-code", permissions: { shell: true } }] } } as never,
    messages: [{ id: "mine", role: "user", content: "older text on the server", createdAt: at } as ChatMessage, { id: "theirs", role: "participant", participantId: "p1", content: "from a machine", createdAt: at } as ChatMessage,
      { id: "reply", role: "participant", participantId: "p1", content: "finished on the machine", status: "done", createdAt: at } as ChatMessage],
    authors: { mine: s.desktop.identity.originId, theirs: "device-machine", reply: "device-machine" }
  };
  // The desktop: its own fields and its own message stay; it gains the message it lacked.
  await s.desktop.storage.saveConversation(local);
  const desktopChat = service(s.desktop.storage);
  await desktopChat.mergeServerCopy(copied, { desktopOriginId: s.desktop.identity.originId, localOriginId: s.desktop.identity.originId, ownsSharedFields: true });
  const onDesktop = (await s.desktop.storage.getConversation("chat-m"))!;
  assert.equal(onDesktop.title, "Local title");
  assert.equal((onDesktop.metadata.participants as Array<{ permissions: { shell: boolean } }>)[0].permissions.shell, false, "no permission comes from the copy");
  assert.deepEqual(onDesktop.messages.map((message) => [message.id, message.content]),
    [["mine", "written here, newer"], ["reply", "finished on the machine"], ["theirs", "from a machine"]], "the machine's finished reply, its own message as it is");
  // The desktop takes no chat it does not have.
  await desktopChat.mergeServerCopy({ ...copied, id: "chat-new" }, { desktopOriginId: s.desktop.identity.originId, localOriginId: s.desktop.identity.originId, ownsSharedFields: true });
  assert.equal(await s.desktop.storage.getConversation("chat-new"), undefined);
  // A machine takes the copy's shared content, and keeps what it wrote itself.
  const machine = await store(s.dir, "machine-merge");
  await machine.storage.saveConversation({ ...local, messages: [{ id: "theirs", role: "participant", participantId: "p1", content: "the machine's own newer reply", createdAt: at } as ChatMessage] });
  const machineChat = service(machine.storage);
  await machineChat.mergeServerCopy({ ...copied, authors: { mine: s.desktop.identity.originId, theirs: machine.identity.originId, reply: machine.identity.originId } },
    { desktopOriginId: s.desktop.identity.originId, localOriginId: machine.identity.originId });
  const onMachine = (await machine.storage.getConversation("chat-m"))!;
  assert.equal(onMachine.title, "Server title");
  assert.equal(onMachine.messages.find((message) => message.id === "theirs")?.content, "the machine's own newer reply");
  assert.equal(onMachine.metadata.running, true, "its own run state stays");
  // A chat deleted here is not brought back.
  await machine.storage.conversationTombstones().mark("chat-gone", at);
  await machineChat.mergeServerCopy({ ...copied, id: "chat-gone" }, { desktopOriginId: s.desktop.identity.originId, localOriginId: machine.identity.originId });
  assert.equal(await machine.storage.getConversation("chat-gone"), undefined);
});

test("a start from the hub's copy that keeps being asked for is not repeated within half an hour; one that failed is taken up where it stopped", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine);
  await s.desktop.log.appendLocalEvent(createdChat("chat-r1"));
  await s.desktop.log.appendLocalEvent(createdChat("chat-r2"));
  await pushAll(s.link(s.desktop, []), s, 2);
  await s.folder.idle();
  let clock = Date.now();
  let failOn: string | undefined = "chat-r2";
  const merged: string[] = [];
  const machineSync = s.link(machine, [], {
    now: () => clock,
    mergeCopy: async (copied) => {
      if (copied.id === failOn) { failOn = undefined; throw new Error("this chat cannot be saved now"); }
      merged.push(copied.id);
    }
  });
  await assert.rejects(machineSync.resync(), /could not be merged/, "a chat that failed is tried again before reading on");
  assert.deepEqual(merged, ["chat-r1"], "the other chat went on");
  assert.equal(await machine.storage.hub().clientState("pulled-hub-seq"), undefined, "not read past it yet");
  await assert.rejects(machineSync.resync(), /too soon/, "after a wait");
  clock += 31_000;
  await machineSync.resync();
  assert.deepEqual(merged, ["chat-r1", "chat-r2"], "only the chat that failed, taken anew");
  assert.equal(await machine.storage.hub().clientState("pulled-hub-seq"), "2");
  await assert.rejects(machineSync.resync(), /too soon/, "not again within half an hour");
  clock += 31 * 60_000;
  await machineSync.resync();
  assert.deepEqual(merged, ["chat-r1", "chat-r2", "chat-r1", "chat-r2"]);
});

test("a large chat of the copy comes in parts and keeps who wrote each message", async (t) => {
  const s = await setup(t, { snapshotPageBytes: 900 });
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine);
  await s.desktop.log.appendLocalEvent(createdChat("chat-parts"));
  for (const n of [2, 3, 4, 5, 6, 7, 8]) await s.desktop.log.appendLocalEvent(change("chat-parts", n));
  await pushAll(s.link(s.desktop, []), s, 8);
  await s.folder.idle();
  const merged: CopiedConversation[] = [];
  const machineSync = s.link(machine, [], { mergeCopy: async (copied) => { merged.push(copied); } });
  await machineSync.resync();
  assert.equal(merged.length, 1);
  assert.deepEqual(new Set(merged[0].messages.map((message) => message.id)), new Set(["m2", "m3", "m4", "m5", "m6", "m7", "m8"]));
  for (const message of merged[0].messages) assert.equal(merged[0].authors?.[message.id], s.desktop.identity.originId, `${message.id} keeps its author`);
});

test("a gap below where a chain was continued is filled from what the hub still holds", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine, "room-1");
  const scope = `device:room-1:${JSON.stringify(["chat-am", "actions"])}`;
  for (const n of [1, 2, 3]) await s.desktop.log.appendLocalEvent({ conversationId: "chat-am", logScopeId: scope, kind: "machine.settings.sealed", payload: { n } });
  await pushAll(s.link(s.desktop, []), s, 3);
  // Later the chain was continued past a stretch the hub never had.
  await s.hubStore.storage.hub().markChain(s.desktop.identity.originId, scope, 6, "sha256:x");
  const delivered: number[] = [];
  const machineSync = s.link(machine, [], { deliver: async (event) => { delivered.push(event.originSeq); return "delivered"; } });
  assert.equal(await machineSync.repairGap({ originId: s.desktop.identity.originId, logScopeId: scope, fromSeq: 1, toSeq: 2 }), "repaired");
  assert.deepEqual(delivered, [1, 2], "handed in, not passed over");
});

test("a gap whose start was refused goes on past it, the next event applies; a forged event moves nothing", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine, "room-1");
  const scope = `device:room-1:${JSON.stringify(["chat-n2", "actions"])}`;
  for (const n of [1, 2]) await s.desktop.log.appendLocalEvent({ conversationId: "chat-n2", logScopeId: scope, kind: "machine.turn.cancel", payload: { n } });
  await pushAll(s.link(s.desktop, []), s, 2);
  const machineSync = s.link(machine, [], { deliver: async (event) => event.originSeq === 1 ? "refused" : "delivered" });
  assert.equal(await machineSync.repairGap({ originId: s.desktop.identity.originId, logScopeId: scope, fromSeq: 1, toSeq: 1 }), "skipped");
  // The next event of the chain, received now, is ready to apply.
  const [second] = await s.hubStore.storage.hub().chainEvents(s.desktop.identity.originId, scope, 2, 2, 10);
  await machine.storage.appendChatEvent(second.event, { ingress: { deviceId: s.desktop.identity.originId, channelId: "room-1" } });
  assert.deepEqual((await machine.storage.deviceEvents().ready("room-1")).map((event) => event.originSeq), [2]);
  // A hub that hands over an event its author did not sign moves nothing.
  const other = `device:room-1:${JSON.stringify(["chat-n3", "actions"])}`;
  await s.desktop.log.appendLocalEvent({ conversationId: "chat-n3", logScopeId: other, kind: "machine.turn.cancel", payload: { n: 1 } });
  await pushAll(s.link(s.desktop, []), s, 3);
  await (s.hubStore.storage as unknown as { runSql(sql: string): Promise<void> }).runSql(
    `update chat_events set envelope_json = json_set(envelope_json, '$.signature', 'forged') where log_scope_id = '${other.replace(/'/g, "''")}';`);
  assert.equal(await machineSync.repairGap({ originId: s.desktop.identity.originId, logScopeId: other, fromSeq: 1, toSeq: 1 }), "unavailable");
  assert.equal(await machine.storage.deviceEvents().appliedHead(s.desktop.identity.originId, other), 0);
});

test("passing over what the hub forgot stops at what this device already holds", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine, "room-1");
  const scope = `device:room-1:${JSON.stringify(["chat-pp", "terminal:run-pp"])}`;
  for (const n of [1, 2, 3, 4]) await s.desktop.log.appendLocalEvent({ conversationId: "chat-pp", logScopeId: scope, kind: "machine.turn.cancel", payload: { n } });
  await pushAll(s.link(s.desktop, []), s, 4);
  // This device holds 3 and 4, waiting on 1 and 2; the hub forgot all four.
  const held = await s.hubStore.storage.hub().chainEvents(s.desktop.identity.originId, scope, 3, 4, 10);
  for (const item of held) await machine.storage.appendChatEvent(item.event, { ingress: { deviceId: s.desktop.identity.originId, channelId: "room-1" } });
  await s.hubStore.storage.hub().recordRead(s.desktop.identity.originId, 4, 4, { from: 0, count: 0 }, new Date().toISOString());
  await s.hubStore.storage.hub().recordRead(machine.identity.originId, 4, 4, { from: 0, count: 0 }, new Date().toISOString());
  await new HubRetention({ storage: s.hubStore.storage, config: { ...HUB_RETENTION_DEFAULTS }, now: () => Date.now() + 2 * DAY }).runOnce();
  const machineSync = s.link(machine, [], { deliver: async () => "delivered" });
  assert.equal(await machineSync.repairGap({ originId: s.desktop.identity.originId, logScopeId: scope, fromSeq: 1, toSeq: 2 }), "skipped");
  assert.equal(await machine.storage.deviceEvents().appliedHead(s.desktop.identity.originId, scope), 2, "up to what it holds, not past it");
  assert.deepEqual((await machine.storage.deviceEvents().ready("room-1")).map((event) => event.originSeq), [3], "what it holds still applies");
});

test("a device whose chain start is gone sends it to a hub set up again from where it still holds it", async (t) => {
  const s = await setup(t);
  const scope = `device:room-1:${JSON.stringify(["chat-cs", "actions"])}`;
  for (const n of [1, 2, 3]) await s.desktop.log.appendLocalEvent({ conversationId: "chat-cs", logScopeId: scope, kind: "machine.settings.sealed", payload: { n } });
  // The first one was forgotten here (pushed long ago to a hub that is gone).
  await (s.desktop.storage as unknown as { runSql(sql: string): Promise<void> }).runSql(
    `delete from chat_events where log_scope_id = '${scope.replace(/'/g, "''")}' and origin_seq = 1;`);
  const logs: string[] = [];
  await pushAll(s.link(s.desktop, [], { log: (event) => logs.push(event) }), s, 2);
  assert.ok(logs.includes("hub.sync.chain-anchored"));
  const pulled = await s.hubStore.storage.hub().pull(0, 10);
  assert.deepEqual(pulled.events.map((item) => item.event.originSeq), [2, 3]);
  assert.equal((await s.hubStore.storage.hub().chainMark(s.desktop.identity.originId, scope))?.originSeq, 1);
});

test("a change held two weeks for anything but its author is given up, said in the log and to the server; one held for its author stays", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine);
  await s.desktop.log.appendLocalEvent(change("chat-gu", 1));
  await s.phone.log.appendLocalEvent(change("chat-gu2", 1));
  await pushAll(s.link(s.desktop, []), s, 1);
  await pushAll(s.link(s.phone, []), s, 2);
  let clock = Date.now();
  const logs: Array<[string, Record<string, unknown>]> = [];
  const machineSync = s.link(machine, [], {
    now: () => clock,
    // The phone is on the roster but this machine does not know it yet.
    trustedKey: async (originId) => originId === s.desktop.identity.originId ? s.desktop.identity.publicKeyDerBase64 : undefined,
    // The desktop's change is known, but cannot be applied here.
    applyChatChange: async () => { throw new Error("cannot be applied"); },
    log: (event, payload) => logs.push([event, payload])
  });
  machineSync.start();
  await until(async () => (await machine.storage.hub().heldEvents(0, 10)).length === 2);
  await machineSync.idle();
  clock += 13 * 24 * 60 * 60_000;
  machineSync.nudgeHeld();
  await machineSync.idle();
  assert.equal((await machine.storage.hub().heldEvents(0, 10)).length, 2, "not yet two weeks");
  clock += 2 * 24 * 60 * 60_000;
  machineSync.nudgeHeld();
  await until(() => logs.some(([event]) => event === "hub.sync.held-given-up"));
  await machineSync.idle();
  const line = logs.find(([event]) => event === "hub.sync.held-given-up")![1];
  assert.equal(line.originId, s.desktop.identity.originId);
  assert.equal(line.count, 1);
  assert.deepEqual((await machine.storage.hub().heldEvents(0, 10)).map((held) => held.reason), ["unknown-origin"]);
  // The next read says so to the server, which the owner reads.
  machineSync.nudgePull();
  await until(async () => Boolean((await s.hubStore.storage.hub().readerFloor(machine.identity.originId))?.gaveUpAt));
  assert.equal((await s.hubStore.storage.hub().readerFloor(machine.identity.originId))?.gaveUpCount, 1);
  assert.equal((await s.hubLog.readers()).readers.find((reader) => reader.deviceId === machine.identity.originId)?.givenUpCount, 1);
});

test("the two weeks count from when a place stops waiting for its author, and a newer version's change waits for the update", async (t) => {
  const s = await setup(t);
  const machine = await store(s.dir, "machine");
  await addMachine(s, machine);
  await s.desktop.log.appendLocalEvent(change("chat-clock", 1));
  await s.desktop.log.appendLocalEvent({ ...change("chat-newer", 1), payload: { ...change("chat-newer", 1).payload, version: 99 } });
  await pushAll(s.link(s.desktop, []), s, 2);
  let clock = Date.now();
  let known = false;
  const logs: string[] = [];
  const machineSync = s.link(machine, [], {
    now: () => clock,
    trustedKey: async () => known ? s.desktop.identity.publicKeyDerBase64 : undefined,
    applyChatChange: hubChatChangeApplier(machine.storage, { applyRemoteChatChanges: async () => { throw new Error("cannot be applied"); } }),
    log: (event) => logs.push(event)
  });
  machineSync.start();
  await until(async () => (await machine.storage.hub().heldEvents(0, 10)).length === 2);
  await machineSync.idle();
  // Three weeks unknown, then known: one fails to apply, one is a newer version's.
  clock += 21 * 24 * 60 * 60_000;
  known = true;
  machineSync.nudgeHeld();
  await until(async () => (await machine.storage.hub().heldEvents(0, 10)).every((held) => held.reason !== "unknown-origin"));
  await machineSync.idle();
  assert.deepEqual((await machine.storage.hub().heldEvents(0, 10)).map((held) => held.reason).sort(), ["error", "newer-version"]);
  machineSync.nudgeHeld();
  await machineSync.idle();
  assert.equal((await machine.storage.hub().heldEvents(0, 10)).length, 2, "not given up at once: its two weeks start now");
  clock += 15 * 24 * 60 * 60_000;
  machineSync.nudgeHeld();
  await until(() => logs.includes("hub.sync.held-given-up"));
  await machineSync.idle();
  assert.deepEqual((await machine.storage.hub().heldEvents(0, 10)).map((held) => held.reason), ["newer-version"], "the newer version's change still waits");
  assert.equal((await readGivenUp(machine.storage))[s.desktop.identity.originId]?.count, 1, "recorded with the give-up");
});
