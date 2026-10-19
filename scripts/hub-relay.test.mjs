// The relay as the User's hub serves it, held to the relay's own tests: the
// mailbox contract every relay implementation passes, the room behaviors of
// the reference relay, and the doorbell's ring path. The hub runs in this
// process on plain HTTP; the push service is a stand-in that records rings.
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

import { CONTRACT_CASES, CONTRACT_TTL_MS } from "./mailbox-contract-suite.mjs";

const dist = path.resolve(import.meta.dirname, "../dist/main");
const { StorageService } = await import(path.join(dist, "main/services/storage.js"));
const { ChatSearchService } = await import(path.join(dist, "main/services/chatSearch.js"));
const { HubLog } = await import(path.join(dist, "hub/hubLog.js"));
const { HubServer } = await import(path.join(dist, "hub/hubServer.js"));
const { HubRelayMailboxes, HubRelayRooms } = await import(path.join(dist, "hub/hubRelay.js"));
const { HubChangeFeed, HubPhoneApi } = await import(path.join(dist, "hub/hubPhone.js"));
const { createChatEventDeviceIdentity } = await import(path.join(dist, "main/services/chatEventLog.js"));
const { signHubRequest } = await import(path.join(dist, "main/services/hubAuth.js"));

const execFileAsync = promisify(execFile);
const PUSH_INTERVAL_MS = 1500;
const PUSH_ORIGIN = "https://fcm.googleapis.com";
const PUSH_PATH = "/fcm/send/ring-path-suite";

function vapidKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { publicKey: point.toString("base64url"), privateJwk: privateKey.export({ format: "jwk" }), subject: "mailto:relay@accordagents.test" };
}

async function startHub({ eventTtlMs, rings = [], pushStatus = { value: 201 }, openRegistration = true, now, owner, machines = [], phone = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-relay-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  if (owner) await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  if (machines.length) await storage.hub().replaceRoster(machines.map((device, index) => ({ deviceId: device.originId, publicKeyDerBase64: device.publicKeyDerBase64, role: "machine", name: `Machine ${index}`, machineId: `m-${index}`, addedAt: "" })), new Date().toISOString());
  const mailboxes = new HubRelayMailboxes({
    storage: storage.relay(),
    vapid: vapidKeys(),
    pushMinIntervalMs: PUSH_INTERVAL_MS,
    openRegistration,
    ...(now ? { now } : {}),
    ...(eventTtlMs ? { eventTtlMs } : {}),
    // Every push the hub sends lands here: the ring log.
    fetchImpl: async (url, init) => {
      rings.push({ at: Date.now(), url: String(url), authorization: String(init?.headers?.Authorization ?? "") });
      if (pushStatus.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, pushStatus.delayMs);
          init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
        });
      }
      return new Response("", { status: pushStatus.value });
    }
  });
  await mailboxes.start();
  const feed = new HubChangeFeed();
  const server = new HubServer({
    hubId: "hub-relay-test", version: "test", storage, log: new HubLog(storage), search: new ChatSearchService(storage), vapidPublicKey: "B",
    relay: { mailboxes, rooms: new HubRelayRooms() },
    ...(phone ? {
      phone: new HubPhoneApi({
        store: storage, relayStorage: storage.relay(), feed,
        machineNames: async () => new Map((await storage.hub().devices()).filter((device) => device.machineId).map((device) => [device.machineId, device.name]))
      })
    } : {})
  });
  const http = await server.listenHttp(0, "127.0.0.1");
  const port = http.address().port;
  const open = await server.listenHttp(0, "127.0.0.1", { openOnly: true });
  return {
    kind: "hub",
    baseUrl: `http://127.0.0.1:${port}`,
    roomUrl: `ws://127.0.0.1:${port}/v1/relay`,
    openUrl: `http://127.0.0.1:${open.address().port}`,
    dbPath: path.join(dir, "hub.sqlite3"),
    storage,
    feed,
    close: async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

test("hub mailbox contract", async (t) => {
  const target = await startHub({ eventTtlMs: CONTRACT_TTL_MS });
  try {
    for (const contractCase of CONTRACT_CASES) {
      await t.test(contractCase.name, async () => {
        await contractCase.run(target);
      });
    }
  } finally {
    await target.close();
  }
});

// ---------------------------------------------------------------- rooms

function frame(logicalMessageId, ciphertextChunk) {
  return { protocol: "accord-relay-v1", streamId: "stream-1", logicalMessageId, frameId: `${logicalMessageId}:0:1`, frameIndex: 0, frameCount: 1, ciphertextChunk };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    const closeWaiters = [];
    let closed;
    socket.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      const parsed = text === "accord-pong" ? text : JSON.parse(text);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(parsed);
        return;
      }
      inbox.push(parsed);
    });
    socket.on("close", (code, reason) => {
      closed = { code, reason: reason.toString("utf8") };
      for (const waiter of closeWaiters.splice(0)) waiter(closed);
    });
    socket.once("open", () => resolve({
      socket,
      nextJson: () => inbox.length > 0 ? Promise.resolve(inbox.shift()) : new Promise((nextResolve) => waiters.push(nextResolve)),
      pending: () => inbox.length,
      closedWith: () => closed ? Promise.resolve(closed) : new Promise((nextResolve) => closeWaiters.push(nextResolve))
    }));
    socket.once("error", reject);
  });
}

test("hub relay forwards sealed frames between paired desktop and phone, and stores none", async () => {
  const hub = await startHub();
  try {
    const desktop = await connect(`${hub.roomUrl}?rid=pair-1&role=desktop&cap=cap-1`);
    const phone = await connect(`${hub.roomUrl}?rid=pair-1&role=phone&cap=cap-1`);
    await phone.nextJson();
    await desktop.nextJson();
    await desktop.nextJson();
    const forwarded = desktop.nextJson();
    phone.socket.send(JSON.stringify(frame("message-1", "sealed-ciphertext")));
    assert.deepEqual(await forwarded, frame("message-1", "sealed-ciphertext"));
    desktop.socket.close();
    const gone = phone.nextJson();
    assert.deepEqual(await gone, { type: "relay.peer-disconnected", role: "desktop", rendezvousId: "pair-1", deviceId: "desktop" });
    const error = phone.nextJson();
    phone.socket.send(JSON.stringify(frame("message-after", "sealed-ciphertext")));
    assert.deepEqual(await error, { type: "relay.error", code: "peer-not-connected" });
    // Its keepalive is answered by the relay itself.
    const pong = phone.nextJson();
    phone.socket.send("accord-ping");
    assert.equal(await pong, "accord-pong");
    phone.socket.close();
  } finally {
    await hub.close();
  }
});

test("hub relay closes oversized and unsealed frames, and a capability that is not the room's", async () => {
  const hub = await startHub();
  try {
    const phone = await connect(`${hub.roomUrl}?rid=pair-3&role=phone&cap=cap-3`);
    await phone.nextJson();
    const closed = phone.closedWith();
    phone.socket.send(JSON.stringify(frame("message-too-large", "x".repeat(20_000))));
    assert.deepEqual(await closed, { code: 1009, reason: "relay frame exceeds provider floor" });

    const desktop = await connect(`${hub.roomUrl}?rid=pair-3b&role=desktop&cap=cap-a`);
    await desktop.nextJson();
    const intruder = await connect(`${hub.roomUrl}?rid=pair-3b&role=phone&cap=cap-b`);
    assert.deepEqual(await intruder.closedWith(), { code: 1008, reason: "capability mismatch" });
    const unsealed = desktop.closedWith();
    desktop.socket.send(JSON.stringify({ hello: "plain text" }));
    assert.deepEqual(await unsealed, { code: 1008, reason: "invalid sealed relay frame" });
  } finally {
    await hub.close();
  }
});

test("hub relay seats the newest connection and evicts the previous holder", async () => {
  const hub = await startHub();
  try {
    const first = await connect(`${hub.roomUrl}?rid=pair-4&role=phone&cap=cap-4`);
    await first.nextJson();
    const firstClosed = first.closedWith();
    const second = await connect(`${hub.roomUrl}?rid=pair-4&role=phone&cap=cap-4`);
    const seated = await second.nextJson();
    assert.deepEqual(await firstClosed, { code: 4001, reason: "replaced by newer connection" });
    assert.equal(seated.type, "relay.ready");
    assert.equal(seated.role, "phone");
    second.socket.close();
  } finally {
    await hub.close();
  }
});

test("hub relay addresses machines by device id and keeps the legacy pair untouched", async () => {
  const hub = await startHub();
  try {
    const desktop = await connect(`${hub.roomUrl}?rid=pair-5&role=desktop&cap=cap-5`);
    const desktopReady = await desktop.nextJson();
    assert.equal(desktopReady.type, "relay.ready");
    assert.equal(desktopReady.deviceId, "desktop");
    assert.deepEqual(desktopReady.peers, []);

    const phone = await connect(`${hub.roomUrl}?rid=pair-5&role=phone&cap=cap-5`);
    const phoneReady = await phone.nextJson();
    assert.equal(phoneReady.peerConnected, true);
    assert.deepEqual(await desktop.nextJson(), { type: "relay.peer-connected", role: "phone", rendezvousId: "pair-5", deviceId: "phone" });

    const machine = await connect(`${hub.roomUrl}?rid=pair-5&role=machine&cap=cap-5&did=device-m1`);
    const machineReady = await machine.nextJson();
    assert.equal(machineReady.type, "relay.ready");
    assert.equal(machineReady.deviceId, "device-m1");
    assert.equal(machineReady.peerConnected, true);
    assert.deepEqual(machineReady.peers.map((peer) => peer.deviceId).sort(), ["desktop", "phone"]);
    assert.deepEqual(await desktop.nextJson(), { type: "relay.peer-connected", role: "machine", rendezvousId: "pair-5", deviceId: "device-m1" });

    const toDesktop = desktop.nextJson();
    machine.socket.send(JSON.stringify({ ...frame("m-1", "sealed-from-machine"), to: "desktop" }));
    assert.deepEqual(await toDesktop, { ...frame("m-1", "sealed-from-machine"), to: "desktop" });

    const toMachine = machine.nextJson();
    desktop.socket.send(JSON.stringify({ ...frame("d-1", "sealed-to-machine"), to: "device-m1" }));
    assert.deepEqual(await toMachine, { ...frame("d-1", "sealed-to-machine"), to: "device-m1" });

    const toPhone = phone.nextJson();
    desktop.socket.send(JSON.stringify(frame("d-2", "sealed-legacy")));
    assert.deepEqual(await toPhone, frame("d-2", "sealed-legacy"));

    const missing = desktop.nextJson();
    desktop.socket.send(JSON.stringify({ ...frame("d-3", "sealed-nowhere"), to: "device-absent" }));
    assert.deepEqual(await missing, { type: "relay.error", code: "peer-not-connected", to: "device-absent" });

    const machineGone = desktop.nextJson();
    machine.socket.close();
    assert.deepEqual(await machineGone, { type: "relay.peer-disconnected", role: "machine", rendezvousId: "pair-5", deviceId: "device-m1" });
    assert.equal(phone.pending(), 0, "the phone never heard about the machine");
    desktop.socket.close();
    phone.socket.close();
  } finally {
    await hub.close();
  }
});

test("hub relay requires a device id for machines and seats newest per device id", async () => {
  const hub = await startHub();
  try {
    const rejected = await connect(`${hub.roomUrl}?rid=pair-6&role=machine&cap=cap-6`);
    assert.deepEqual(await rejected.closedWith(), { code: 1008, reason: "invalid relay pairing request" });
    const first = await connect(`${hub.roomUrl}?rid=pair-6&role=machine&cap=cap-6&did=device-m2`);
    await first.nextJson();
    const firstClosed = first.closedWith();
    const second = await connect(`${hub.roomUrl}?rid=pair-6&role=machine&cap=cap-6&did=device-m2`);
    const seated = await second.nextJson();
    assert.deepEqual(await firstClosed, { code: 4001, reason: "replaced by newer connection" });
    assert.equal(seated.deviceId, "device-m2");
    second.socket.close();
  } finally {
    await hub.close();
  }
});

// ---------------------------------------------------------------- doorbell

function credentials(label) {
  const sealKey = createHash("sha256").update(`accord-ring-${label}`, "utf8").digest();
  const token = createHmac("sha256", sealKey).update("accord-mailbox-auth-v1", "utf8").digest("base64url");
  const mailboxId = "mb-" + createHmac("sha256", sealKey).update("accord-mailbox-scope-v1", "utf8").digest("base64url").slice(0, 32);
  return { token, mailboxId, tokenHashBase64Url: createHash("sha256").update(token, "utf8").digest("base64url") };
}

function sealedEvent(overrides = {}) {
  return {
    eventId: "ring-event-1",
    conversationId: "conversation-ring",
    logScopeId: "conversation-ring",
    originId: "device-desktop",
    originSeq: 1,
    logicalTs: "0000000000000001:device-desktop:conversation-ring",
    kind: "mobile.timeline.events",
    payload: { v: 1, alg: "A256GCM", iv: randomBytes(12).toString("base64url"), ct: Buffer.from("sealed", "utf8").toString("base64url") },
    payloadHash: "sha256-payload",
    eventHash: "sha256-event",
    createdAt: "2026-08-16T00:00:00.000Z",
    ...overrides
  };
}

function caller(hub, creds) {
  return (pathname, { method = "GET", body, query = {} } = {}) => {
    const url = new URL(pathname, hub.baseUrl);
    url.searchParams.set("mailboxId", creds.mailboxId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return fetch(url, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${creds.token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  };
}

async function subscribe(call, creds) {
  assert.equal((await call("/v1/mailbox/register", { method: "POST", body: { tokenHashBase64Url: creds.tokenHashBase64Url } })).status, 200);
  assert.equal((await call("/v1/mailbox/push-subscription", {
    method: "POST",
    body: { subscription: { endpoint: `${PUSH_ORIGIN}${PUSH_PATH}`, keys: { p256dh: "p", auth: "a" } }, suppressOriginId: "device-phone" }
  })).status, 200);
}

test("hub doorbell: only a finished run rings, and a finish inside the window is deferred, not dropped", async () => {
  const rings = [];
  const pushStatus = { value: 201 };
  const hub = await startHub({ rings, pushStatus });
  const creds = credentials("hub");
  const call = caller(hub, creds);
  try {
    await subscribe(call, creds);
    assert.equal((await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "ring-progress", originSeq: 1 })] } })).status, 200);
    await delay(500);
    assert.equal(rings.length, 0, "an unmarked append never rings");
    assert.equal((await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "ring-finish-1", originSeq: 2 })], runFinished: true } })).status, 200);
    for (let i = 0; i < 20 && rings.length === 0; i += 1) await delay(100);
    assert.equal(rings.length, 1, "a marked append rings exactly once");
    const firstRingAt = rings[0].at;
    assert.equal((await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "ring-finish-2", originSeq: 3 })], runFinished: true } })).status, 200);
    await delay(300);
    assert.equal(rings.length, 1, "the second finish does not ring immediately");
    for (let i = 0; i < 60 && rings.length < 2; i += 1) await delay(200);
    assert.equal(rings.length, 2, "the deferred finish rings rather than being dropped");
    assert.ok(rings[1].at - firstRingAt >= PUSH_INTERVAL_MS - 250, `the deferred ring waits out the interval (waited ${rings[1].at - firstRingAt}ms)`);
    for (const ring of rings) {
      assert.equal(ring.url, `${PUSH_ORIGIN}${PUSH_PATH}`);
      assert.match(ring.authorization, /^vapid t=/);
    }
    const listing = await (await call("/v1/mailbox/events", { query: { afterArrival: 0, limit: 500 } })).json();
    assert.equal(listing.events.length, 3, "the deferred ring did not disturb stored events");

    pushStatus.value = 410;
    rings.length = 0;
    await delay(PUSH_INTERVAL_MS);
    assert.equal((await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "ring-finish-3", originSeq: 4 })], runFinished: true } })).status, 200);
    for (let i = 0; i < 30 && rings.length === 0; i += 1) await delay(100);
    assert.equal(rings.length, 1, "the ring was attempted once");
    pushStatus.value = 201;
    rings.length = 0;
    await delay(PUSH_INTERVAL_MS);
    assert.equal((await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "ring-finish-4", originSeq: 5 })], runFinished: true } })).status, 200);
    await delay(PUSH_INTERVAL_MS + 500);
    assert.equal(rings.length, 0, "a dropped subscription is not rung again and not retried");
  } finally {
    await hub.close();
  }
});

test("hub doorbell: rings for what the phone does not have", async () => {
  const rings = [];
  const hub = await startHub({ rings });
  const creds = credentials("read-cursor");
  const call = caller(hub, creds);
  let seq = 0;
  const finish = async (label) => {
    seq += 1;
    assert.equal((await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: `cursor-${label}`, originSeq: seq })], runFinished: true } })).status, 200);
  };
  const progress = async (label) => {
    seq += 1;
    assert.equal((await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: `cursor-${label}`, originSeq: seq })] } })).status, 200);
  };
  const waitForRings = async (count, ms = PUSH_INTERVAL_MS * 2 + 500) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && rings.length < count) await delay(100);
    return rings.length;
  };
  const phoneAcknowledges = async (cursor, extra = {}) => {
    const response = await call("/v1/mailbox/events", { query: { reader: "phone", afterArrival: cursor, limit: 500, ...extra } });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    await subscribe(call, creds);
    await finish("finish-1");
    assert.equal(await waitForRings(1, 2000), 1, "the answer rings once, straight away");
    await finish("finish-2");
    await phoneAcknowledges(2);
    assert.equal(await waitForRings(2), 1, "nothing is rung twice for what the phone already has");
    await finish("finish-3");
    await phoneAcknowledges(2);
    assert.equal(await waitForRings(2), 2, "a page the phone did not store is still rung for");
    await phoneAcknowledges(3);
    await finish("defer-a");
    assert.equal(await waitForRings(3), 3, "the first of the pair rings straight away");
    await finish("defer-b");
    await phoneAcknowledges(3);
    assert.equal(await waitForRings(4), 4, "a deferred ring survives a read that stored nothing");
    await phoneAcknowledges(5);
    await finish("finish-4");
    assert.equal((await call("/v1/mailbox/events", { query: { afterArrival: 6, limit: 500 } })).status, 200);
    assert.equal(await waitForRings(5), 5, "a desktop read does not silence the phone's doorbell");
    await phoneAcknowledges(6);
    await finish("finish-5");
    await phoneAcknowledges(7, { conversationId: "conversation-ring" });
    assert.equal(await waitForRings(6), 6, "a filtered read does not acknowledge the whole box");
    await phoneAcknowledges(7);
    await finish("finish-6");
    assert.equal((await call("/v1/mailbox/events", { query: { reader: "phone", tail: "true", limit: 1 } })).status, 200);
    assert.equal(await waitForRings(7), 7, "a tail read does not acknowledge the whole box");
    await phoneAcknowledges(8);
    await phoneAcknowledges(1e15);
    await finish("finish-7");
    assert.equal(await waitForRings(8), 8, "an absurd cursor cannot mute the doorbell");
    await phoneAcknowledges(9);
    await finish("quiet-finish-a");
    assert.equal(await waitForRings(9, 2000), 9, "the finished turn rings once");
    await finish("quiet-finish-b");
    await phoneAcknowledges(11);
    await progress("quiet-progress-1");
    await progress("quiet-progress-2");
    assert.equal(await waitForRings(10), 9, "the deferred ring stays quiet: its finish is already on the phone");
    await finish("quiet-finish-c");
    assert.equal(await waitForRings(10), 10, "the next finished turn still rings");
  } finally {
    await hub.close();
  }
});

test("hub doorbell: a finished turn's append does not wait for the push service", async () => {
  const rings = [];
  const pushStatus = { value: 201, delayMs: 3000 };
  const hub = await startHub({ rings, pushStatus });
  const creds = credentials("slow-push");
  const call = caller(hub, creds);
  const waitForRings = async (count, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && rings.length < count) await delay(50);
    return rings.length;
  };
  try {
    await subscribe(call, creds);
    const started = Date.now();
    const response = await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "slow-finish-1", originSeq: 1 })], runFinished: true } });
    const appendMs = Date.now() - started;
    assert.equal(response.status, 200);
    assert.ok(appendMs < 1500, `the append answers before the push service does (took ${appendMs}ms)`);
    assert.equal(await waitForRings(1, 2000), 1, "the ring still goes out");
    // While that push is out, the mailbox keeps answering.
    const readStarted = Date.now();
    assert.equal((await call("/v1/mailbox/events", { query: { afterArrival: 0 } })).status, 200);
    assert.ok(Date.now() - readStarted < 1500, "a read does not wait behind the ring");
    await delay(pushStatus.delayMs + PUSH_INTERVAL_MS);
    pushStatus.delayMs = 6000;
    assert.equal((await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "slow-finish-2", originSeq: 2 })], runFinished: true } })).status, 200);
    assert.equal(await waitForRings(2, 2000), 2, "the failing ring was attempted");
    pushStatus.delayMs = 0;
    await delay(5000 + PUSH_INTERVAL_MS);
    assert.equal((await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "slow-finish-3", originSeq: 3 })], runFinished: true } })).status, 200);
    assert.equal(await waitForRings(3, 2000), 3, "a ring that timed out leaves the next one alone");
  } finally {
    await hub.close();
  }
});

test("hub mailbox: a ring waiting when the hub stops is rung after it starts again", async () => {
  // Covered by the hub's restart path: pending rings are kept in its table.
  const rings = [];
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-relay-restart-"));
  try {
    const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
    await storage.init();
    const relay = storage.relay();
    const creds = credentials("restart");
    await relay.updateMailbox(creds.mailboxId, { tokenHash: creds.tokenHashBase64Url, epoch: "e", arrivalSeq: 1, pushFinishSeq: 1, pushAt: Date.now() + 300,
      pushSubscription: JSON.stringify({ endpoint: `${PUSH_ORIGIN}${PUSH_PATH}`, savedAt: "" }) });
    const mailboxes = new HubRelayMailboxes({ storage: relay, vapid: vapidKeys(), fetchImpl: async (url) => { rings.push(String(url)); return new Response("", { status: 201 }); } });
    await mailboxes.start();
    for (let i = 0; i < 30 && rings.length === 0; i += 1) await delay(100);
    mailboxes.close();
    assert.equal(rings.length, 1);
    assert.equal((await relay.mailbox(creds.mailboxId)).pushAt, null, "rung once, not again on the next start");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the User's server is hers

test("a new mailbox is taken only from a device the server knows; one already there keeps working", async () => {
  const owner = createChatEventDeviceIdentity();
  const machine = createChatEventDeviceIdentity();
  const stranger = createChatEventDeviceIdentity();
  const hub = await startHub({ openRegistration: false, owner, machines: [machine] });
  try {
    const creds = credentials("owner-only");
    const pathWithQuery = `/v1/mailbox/register?mailboxId=${creds.mailboxId}`;
    const body = JSON.stringify({ tokenHashBase64Url: creds.tokenHashBase64Url });
    const register = (signer) => fetch(`${hub.baseUrl}${pathWithQuery}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${creds.token}`,
        ...(signer ? { "x-accord-hub-authorization": signHubRequest(signer, { method: "POST", pathWithQuery, body }) } : {}) },
      body
    });
    let answer = await register(undefined);
    assert.equal(answer.status, 403);
    assert.equal((await answer.json()).error, "mailbox_registration_refused");
    assert.equal((await register(stranger)).status, 403, "a device the server does not know cannot either");
    answer = await register(owner);
    assert.equal(answer.status, 200, await answer.clone().text());
    assert.equal((await answer.json()).registered, true);
    // Registering again (a machine retrying, the phone) needs no signature.
    assert.equal((await register(undefined)).status, 200);
    // A machine of hers registers the mailboxes only it can name (its room
    // with another machine, with the phone).
    const own = credentials("machine-room");
    const machinePath = `/v1/mailbox/register?mailboxId=${own.mailboxId}`;
    const machineBody = JSON.stringify({ tokenHashBase64Url: own.tokenHashBase64Url });
    const byMachine = await fetch(`${hub.baseUrl}${machinePath}`, { method: "POST", body: machineBody,
      headers: { "content-type": "application/json", authorization: `Bearer ${own.token}`, "x-accord-hub-authorization": signHubRequest(machine, { method: "POST", pathWithQuery: machinePath, body: machineBody }) } });
    assert.equal(byMachine.status, 200);
    const tooBig = await fetch(`${hub.baseUrl}${pathWithQuery}`, { method: "POST", headers: { authorization: `Bearer ${creds.token}` }, body: Buffer.alloc(8 * 1024, 32) });
    assert.equal(tooBig.status, 413, "a registration is a few bytes");
  } finally {
    await hub.close();
  }
});

test("a request that is not the mailbox owner's is refused before its body is read", async () => {
  const hub = await startHub();
  const creds = credentials("preauth");
  const call = caller(hub, creds);
  try {
    assert.equal((await call("/v1/mailbox/register", { method: "POST", body: { tokenHashBase64Url: creds.tokenHashBase64Url } })).status, 200);
    const big = Buffer.alloc(8 * 1024 * 1024, 120);
    const started = Date.now();
    const wrong = await fetch(`${hub.baseUrl}/v1/mailbox/events?mailboxId=${creds.mailboxId}`, { method: "POST", headers: { authorization: "Bearer not-the-token" }, body: big });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error, "mailbox_unauthorized");
    const nobody = await fetch(`${hub.baseUrl}/v1/mailbox/events?mailboxId=mb-nobody-has-this`, { method: "POST", body: big });
    assert.equal(nobody.status, 401);
    assert.ok(Date.now() - started < 5_000);
    const tooLarge = await fetch(`${hub.baseUrl}/v1/mailbox/events?mailboxId=${creds.mailboxId}`, {
      method: "POST", headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" }, body: Buffer.alloc(33 * 1024 * 1024, 32)
    }).catch((error) => ({ status: 413, error }));
    assert.equal(tooLarge.status, 413);
    const oneHuge = await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "huge", payload: { v: 1, alg: "A256GCM", iv: "aaaa", ct: "a".repeat(3 * 1024 * 1024) } })] } });
    assert.equal(oneHuge.status, 400);
    assert.match((await oneHuge.json()).error, /too large/);
    // The mailbox still answers afterwards.
    assert.equal((await call("/v1/mailbox/events", { query: { afterArrival: 0 } })).status, 200);
  } finally {
    await hub.close();
  }
});

test("positions beyond any number, and routing fields with quotes, leave the store unharmed", async () => {
  const hub = await startHub();
  const creds = credentials("hostile");
  const call = caller(hub, creds);
  try {
    assert.equal((await call("/v1/mailbox/register", { method: "POST", body: { tokenHashBase64Url: creds.tokenHashBase64Url } })).status, 200);
    const odd = "it's'; drop table hub_relay_events; --";
    const appended = await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: odd, conversationId: odd, logScopeId: odd, originId: odd })] } });
    assert.equal(appended.status, 200);
    for (const afterArrival of ["1e400", "-1e400", "NaN", "abc", "9007199254740993"]) {
      const answer = await call("/v1/mailbox/events", { query: { afterArrival, originId: odd, afterSeq: afterArrival } });
      assert.equal(answer.status, 200, `afterArrival=${afterArrival}`);
    }
    const listed = await (await call("/v1/mailbox/events", { query: { afterArrival: 0, conversationId: odd } })).json();
    assert.deepEqual(listed.events.map((event) => [event.eventId, event.originId]), [[odd, odd]], "stored and read back as written");
    const newline = await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "a\n.shell echo x" })] } });
    assert.equal(newline.status, 400, "a control character in a routing field is refused");
    const deleted = await (await call("/v1/mailbox/delete", { method: "POST", body: { eventIds: [odd] } })).json();
    assert.deepEqual(deleted.deletedEventIds, [odd]);
    assert.equal((await (await call("/v1/mailbox/events", { query: { afterArrival: 0 } })).json()).events.length, 0);
  } finally {
    await hub.close();
  }
});

test("an append clears only the expired copies of what it brings; the rest stays unseen until the periodic sweep", async () => {
  let clock = Date.parse("2026-10-19T10:00:00.000Z");
  const ttl = 60_000;
  const hub = await startHub({ now: () => clock, eventTtlMs: ttl });
  const creds = credentials("expiry");
  const call = caller(hub, creds);
  const rows = async () => Number((await execFileAsync("sqlite3", [hub.dbPath, "select count(*) from hub_relay_events;"])).stdout.trim());
  try {
    assert.equal((await call("/v1/mailbox/register", { method: "POST", body: { tokenHashBase64Url: creds.tokenHashBase64Url } })).status, 200);
    await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "old-a" }), sealedEvent({ eventId: "old-b" })] } });
    clock += ttl + 1_000;
    const fresh = await (await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "new-c" })] } })).json();
    assert.deepEqual(fresh.appendedEventIds, ["new-c"]);
    assert.equal(await rows(), 3, "an unrelated expired envelope is not swept by an append");
    const listed = await (await call("/v1/mailbox/events", { query: { afterArrival: 0 } })).json();
    assert.deepEqual(listed.events.map((event) => event.eventId), ["new-c"], "an expired envelope is never listed");
    const again = await (await call("/v1/mailbox/events", { method: "POST", body: { events: [sealedEvent({ eventId: "old-a" })] } })).json();
    assert.deepEqual(again.appendedEventIds, ["old-a"], "a repeat of an expired id is a new envelope");
    assert.equal(await rows(), 3, "its expired copy went, the other one waits for the sweep");
  } finally {
    await hub.close();
  }
});

test("execution claims: taken, held against another owner, renewed by the same one, taken over once expired", async () => {
  let clock = Date.parse("2026-10-19T08:00:00.000Z");
  const hub = await startHub({ now: () => clock });
  const creds = credentials("claims");
  const call = caller(hub, creds);
  const claim = (ownerId, extra = {}) => call("/v1/mailbox/claims", { method: "POST", body: { conversationId: "c", eventId: "e", ownerId, ownerRole: "desktop", runId: `run-${ownerId}`, ttlMs: 30_000, ...extra } }).then((r) => r.json());
  try {
    assert.equal((await call("/v1/mailbox/register", { method: "POST", body: { tokenHashBase64Url: creds.tokenHashBase64Url } })).status, 200);
    const first = await claim("desktop-a");
    assert.equal(first.acquired, true);
    const contested = await claim("machine-b");
    assert.equal(contested.acquired, false);
    assert.equal(contested.claim.ownerId, "desktop-a");
    clock += 10_000;
    const renewed = await claim("desktop-a");
    assert.equal(renewed.acquired, true);
    assert.equal(renewed.claim.claimedAt, first.claim.claimedAt, "the same owner keeps when it first claimed");
    clock += 31_000;
    assert.equal((await claim("machine-b")).acquired, true, "an expired claim is taken over");
    assert.equal((await claim("x", { ttlMs: 1 })).acquired, false, "a short ttl is raised to the floor, not used as given");
    const bad = await call("/v1/mailbox/claims", { method: "POST", body: { conversationId: "c", eventId: "e" } });
    assert.equal(bad.status, 400);
  } finally {
    await hub.close();
  }
});

test("the relay's own paths answer as the relay's, and never over plain HTTP on the open port", async () => {
  const hub = await startHub();
  try {
    assert.deepEqual(await (await fetch(`${hub.baseUrl}/healthz`)).json(), { ok: true, provider: "accordagents-hub" });
    assert.equal((await (await fetch(`${hub.baseUrl}/v1/relay/manifest`)).json()).manifest.provider, "accordagents-hub");
    assert.equal((await fetch(`${hub.baseUrl}/v1/relay?rid=x`)).status, 426);
    assert.equal((await fetch(`${hub.baseUrl}/v1/relay`)).status, 400);
    assert.equal((await fetch(`${hub.openUrl}/v1/mailbox/events?mailboxId=x`)).status, 403);
    assert.equal((await fetch(`${hub.openUrl}/healthz`)).status, 403);
  } finally {
    await hub.close();
  }
});

// ---------------------------------------------------------------- phone reads

function chatFixture(id, { title, archived = false, messages = [], participants } = {}) {
  const at = "2026-10-19T10:00:00.000Z";
  return {
    id, kind: "chat", title: title ?? `Chat ${id}`, createdAt: at, updatedAt: at, findings: [],
    messages,
    metadata: {
      participants: participants ?? [{ id: "p1", handle: "nora", roleConfigId: "software-engineer", kind: "claude-code", homeMachineId: "m-0" }],
      ...(archived ? { archived: true, archivedAt: at } : {})
    }
  };
}

function messageFixture(id, role, content, extra = {}) {
  return { id, role, content, createdAt: "2026-10-19T10:00:00.000Z", status: "done", ...(role === "participant" ? { participantLabel: "@nora", participantId: "p1" } : {}), ...extra };
}

async function registerSigned(hub, creds, signer, extraBody = {}) {
  const pathWithQuery = `/v1/mailbox/register?mailboxId=${creds.mailboxId}`;
  const body = JSON.stringify({ tokenHashBase64Url: creds.tokenHashBase64Url, ...extraBody });
  return fetch(`${hub.baseUrl}${pathWithQuery}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${creds.token}`,
      ...(signer ? { "x-accord-hub-authorization": signHubRequest(signer, { method: "POST", pathWithQuery, body }) } : {}) },
    body
  });
}

function inTenMinutes() {
  return new Date(Date.now() + 10 * 60_000).toISOString();
}

function phoneGet(hub, creds, pathname, query = {}, headers = {}) {
  const url = new URL(pathname, hub.baseUrl);
  url.searchParams.set("mailboxId", creds.mailboxId);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return fetch(url, { headers: { authorization: `Bearer ${creds.token}`, ...headers } });
}

test("a paired phone reads the chat list and a chat's page from the server, within what its desktop allowed", async () => {
  const owner = createChatEventDeviceIdentity();
  const machine = createChatEventDeviceIdentity();
  const hub = await startHub({ openRegistration: false, owner, machines: [machine], phone: true });
  try {
    await hub.storage.saveConversation(chatFixture("chat-a", { title: "Alpha", messages: [
      messageFixture("a1", "user", "@nora hello from the phone"),
      messageFixture("a2", "participant", "Hi! Here is the answer.")
    ] }));
    await hub.storage.saveConversation(chatFixture("chat-b", { title: "Beta", messages: [messageFixture("b1", "user", "second chat")] }));
    await hub.storage.saveConversation(chatFixture("chat-old", { title: "Old", archived: true, messages: [messageFixture("o1", "user", "archived")] }));
    const phone = credentials("phone-device");
    assert.equal((await registerSigned(hub, phone, owner, { phoneScope: { scope: "device" }, phoneExpiresAt: inTenMinutes() })).status, 200);
    const invite = credentials("phone-invite");
    assert.equal((await registerSigned(hub, invite, owner, { phoneScope: { scope: "conversation", conversationId: "chat-b" }, phoneExpiresAt: inTenMinutes() })).status, 200);
    const plain = credentials("no-scope");
    assert.equal((await registerSigned(hub, plain, owner)).status, 200);
    const byMachine = credentials("machine-says-scope");
    assert.equal((await registerSigned(hub, byMachine, machine, { phoneScope: { scope: "device" }, phoneExpiresAt: inTenMinutes() })).status, 200);

    const boxBefore = await (await fetch(`${hub.baseUrl}/v1/mailbox/events?mailboxId=${phone.mailboxId}&afterArrival=0`, { headers: { authorization: `Bearer ${phone.token}` } })).json();
    assert.equal(boxBefore.phoneSeenAt, undefined, "not used by the phone yet");
    let answer = await phoneGet(hub, phone, "/v1/phone/chats");
    assert.equal(answer.status, 200, await answer.clone().text());
    const boxAfter = await (await fetch(`${hub.baseUrl}/v1/mailbox/events?mailboxId=${phone.mailboxId}&afterArrival=0`, { headers: { authorization: `Bearer ${phone.token}` } })).json();
    assert.ok(Date.parse(boxAfter.phoneSeenAt) > Date.now() - 60_000, "the desktop reading the box learns that the phone has used its link");
    let body = await answer.json();
    assert.equal(body.type, "mobile.chat-list");
    assert.deepEqual(body.chats.map((chat) => chat.title).sort(), ["Alpha", "Beta"], "every chat but the archived one");
    const alpha = body.chats.find((chat) => chat.id === "chat-a");
    assert.equal(alpha.snippet, "Hi! Here is the answer.");
    assert.equal(alpha.who, "nora:");
    assert.equal(alpha.members[0].roleLabel, "Software Engineer");
    assert.equal(alpha.members[0].homeMachineName, "Machine 0", "a machine's name from the server's roster");
    assert.equal(alpha.pendingCards, undefined, "the server cannot see every card, so it names none");

    answer = await phoneGet(hub, phone, "/v1/phone/timeline", { conversationId: "chat-a" });
    body = await answer.json();
    assert.equal(body.type, "mobile.timeline.events");
    assert.deepEqual(body.events.map((event) => event.content), ["@nora hello from the phone", "Hi! Here is the answer."]);
    assert.equal(body.page.hasMoreBefore, false);
    assert.equal(body.cards, undefined);
    answer = await phoneGet(hub, phone, "/v1/phone/timeline", { conversationId: "chat-old" });
    assert.equal(answer.status, 404, "an archived chat stays hidden");
    assert.equal((await answer.json()).error, "chat_not_found", "said as one chat missing, not as no server");

    body = await (await phoneGet(hub, invite, "/v1/phone/chats")).json();
    assert.deepEqual(body.chats.map((chat) => chat.id), ["chat-b"], "an invitation sees its one chat");
    assert.equal((await phoneGet(hub, invite, "/v1/phone/timeline", { conversationId: "chat-a" })).status, 404, "and nothing else");

    answer = await phoneGet(hub, plain, "/v1/phone/chats");
    assert.equal(answer.status, 403);
    assert.equal((await answer.json()).error, "phone_scope_missing", "a pairing the desktop said nothing about reads nothing");
    assert.equal((await phoneGet(hub, byMachine, "/v1/phone/chats")).status, 403, "a machine cannot grant reading");
    assert.equal((await phoneGet(hub, { ...phone, token: "wrong" }, "/v1/phone/chats")).status, 401);

    // Told again later (a desktop that updated): a pairing gains its scope.
    assert.equal((await registerSigned(hub, plain, owner, { phoneScope: { scope: "device" }, phoneExpiresAt: inTenMinutes() })).status, 200);
    assert.equal((await phoneGet(hub, plain, "/v1/phone/chats")).status, 200);

    // An unused link reads nothing past its window; one the desktop says a
    // phone used keeps reading; a machine cannot say so.
    const stale = credentials("stale-link");
    await registerSigned(hub, stale, owner, { phoneScope: { scope: "device" }, phoneExpiresAt: new Date(Date.now() - 1000).toISOString() });
    answer = await phoneGet(hub, stale, "/v1/phone/chats");
    assert.equal(answer.status, 401);
    assert.equal((await answer.json()).error, "phone_expired");
    await registerSigned(hub, stale, machine, { phoneScope: { scope: "device" }, phoneClaimed: true });
    assert.equal((await phoneGet(hub, stale, "/v1/phone/chats")).status, 401, "a machine cannot keep a link alive");
    await registerSigned(hub, stale, owner, { phoneScope: { scope: "device" }, phoneExpiresAt: new Date(Date.now() - 1000).toISOString(), phoneClaimed: true });
    assert.equal((await phoneGet(hub, stale, "/v1/phone/chats")).status, 200, "a used link outlives its window");
    await registerSigned(hub, stale, owner, { phoneScope: { scope: "device" }, phoneExpiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await phoneGet(hub, stale, "/v1/phone/chats")).status, 200, "and stays used");

    // Revoked: nothing more.
    const revoke = await fetch(`${hub.baseUrl}/v1/mailbox/revoke?mailboxId=${phone.mailboxId}`, { method: "POST", headers: { authorization: `Bearer ${phone.token}` } });
    assert.equal(revoke.status, 200);
    answer = await phoneGet(hub, phone, "/v1/phone/chats");
    assert.equal(answer.status, 401);
    assert.equal((await answer.json()).error, "phone_revoked");
  } finally {
    await hub.close();
  }
});

test("a phone waiting for news is answered when a chat's copy changes, and only with chats it may read", async () => {
  const owner = createChatEventDeviceIdentity();
  const hub = await startHub({ openRegistration: false, owner, phone: true });
  try {
    for (let index = 0; index < 60; index += 1) {
      await hub.storage.saveConversation(chatFixture(`chat-${index}`, { title: `Chat ${index} ${"x".repeat(200)}`, messages: [messageFixture(`m-${index}`, "user", "y".repeat(300))] }));
    }
    const phone = credentials("phone-feed");
    await registerSigned(hub, phone, owner, { phoneScope: { scope: "device" }, phoneExpiresAt: inTenMinutes() });
    const invite = credentials("invite-feed");
    await registerSigned(hub, invite, owner, { phoneScope: { scope: "conversation", conversationId: "chat-1" }, phoneExpiresAt: inTenMinutes() });
    // A position from no instance (or another one) is a reset.
    let body = await (await phoneGet(hub, phone, "/v1/phone/changes", { instance: "none", after: 0 })).json();
    assert.equal(body.reset, true);
    const { instance } = body;
    let seq = body.seq;
    const started = Date.now();
    const waiting = phoneGet(hub, phone, "/v1/phone/changes", { instance, after: seq, waitMs: 5000 });
    const invited = phoneGet(hub, invite, "/v1/phone/changes", { instance, after: seq, waitMs: 1500 });
    await delay(300);
    hub.feed.note("chat-7");
    body = await (await waiting).json();
    assert.ok(Date.now() - started < 3000, "answered when the change came, not at the end of the wait");
    assert.deepEqual(body.conversationIds, ["chat-7"]);
    assert.equal(body.reset, undefined);
    const invitedBody = await (await invited).json();
    assert.deepEqual(invitedBody.conversationIds, [], "another chat's change is not news to an invitation");
    assert.ok(Date.now() - started >= 1400, "nor does it end the invitation's wait early");
    seq = body.seq;
    // Nothing new: an empty answer at the end of the wait.
    body = await (await phoneGet(hub, phone, "/v1/phone/changes", { instance, after: seq, waitMs: 200 })).json();
    assert.deepEqual(body.conversationIds, []);
    // A big list travels compressed to a phone that accepts it.
    const listed = await phoneGet(hub, phone, "/v1/phone/chats", {}, { "accept-encoding": "gzip" });
    assert.equal(listed.headers.get("content-encoding"), "gzip");
    assert.equal((await listed.json()).chats.length, 60);
    // A chat that changed is read again for the list; the others come from
    // what was read before.
    await hub.storage.saveConversation(chatFixture("chat-3", { title: "Chat 3", messages: [messageFixture("m-3", "user", "y"), messageFixture("m-3b", "participant", "the newest line")] }));
    hub.feed.note("chat-3");
    const relisted = await (await phoneGet(hub, phone, "/v1/phone/chats")).json();
    assert.equal(relisted.chats.find((chat) => chat.id === "chat-3").snippet, "the newest line");
  } finally {
    await hub.close();
  }
});
