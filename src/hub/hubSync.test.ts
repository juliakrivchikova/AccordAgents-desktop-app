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
import { HubSync } from "../main/services/hubSync";
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
  const link = (device: Awaited<ReturnType<typeof store>>, applied: ChatEventEnvelope[]) => new HubSync({
    client: new HubClient({ url, identity: async () => device.identity, storage: device.storage }),
    storage: device.storage,
    localOriginId: async () => device.identity.originId,
    trustedKey: async (originId) => keys.get(originId),
    apply: async (event) => { applied.push(event); return "applied"; }
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, hubStore, desktop, phone, server, url, link };
}

const change = (conversationId: string, n: number) => ({
  conversationId, logScopeId: chatChangesLogScope(conversationId), kind: CHAT_CHANGES_EVENT_KIND,
  payload: { version: 1, conversationId, updatedAt: new Date().toISOString(), changes: [{ type: "message.created", message: { id: `m${n}`, role: "user", content: `message ${n}`, createdAt: new Date().toISOString() } }] }
});

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("what one device writes reaches another through the hub, live, once, in order", async (t) => {
  const s = await setup(t);
  const fromDesktop: ChatEventEnvelope[] = [];
  const onPhone: ChatEventEnvelope[] = [];
  const desktopSync = s.link(s.desktop, fromDesktop);
  const phoneSync = s.link(s.phone, onPhone);
  desktopSync.start();
  phoneSync.start();
  t.after(() => { desktopSync.stop(); phoneSync.stop(); });
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
  phoneSync.stop();
  const again: ChatEventEnvelope[] = [];
  const restarted = s.link(s.phone, again);
  restarted.start();
  t.after(() => restarted.stop());
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
  const sync = s.link(s.desktop, []);
  sync.nudgePush();
  await sync.idle();
  const pulled = await s.hubStore.storage.hub().pull(0, 10);
  assert.deepEqual(pulled.map((item) => item.event.originSeq), [1, 2, 3], "the chain arrives whole and in order");
  assert.equal(await s.desktop.storage.hub().clientState("pushed-rowid"), String(own[2].rowid));
});

test("an event from a device that is not the User's is stored nowhere and applied never", async (t) => {
  const s = await setup(t);
  const applied: ChatEventEnvelope[] = [];
  const phoneSync = new HubSync({
    client: new HubClient({ url: s.url, identity: async () => s.phone.identity, storage: s.phone.storage }),
    storage: s.phone.storage,
    localOriginId: async () => s.phone.identity.originId,
    // This phone does not know the desktop's key.
    trustedKey: async () => undefined,
    apply: async (event) => { applied.push(event); return "applied"; }
  });
  await s.desktop.log.appendLocalEvent(change("chat-c", 1));
  const desktopSync = s.link(s.desktop, []);
  desktopSync.nudgePush();
  await desktopSync.idle();
  phoneSync.nudgePull();
  await phoneSync.idle();
  assert.deepEqual(applied, []);
  assert.equal((await s.phone.storage.listChatEvents("chat-c", chatChangesLogScope("chat-c"))).length, 0);
});
