import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatSearchService } from "../main/services/chatSearch";
import { createDeviceIdentity } from "../main/services/deviceIdentity";
import { signHubRequest, type HubSigningIdentity } from "../main/services/hubAuth";
import { StorageService } from "../main/services/storage";
import { BLOB_FRAGMENT_MAX_BYTES } from "../shared/deviceEventBlobs";
import { HubOps } from "./hubOps";
import { HUB_RETENTION_DEFAULTS, hubRetentionConfig } from "./hubRetention";
import { HubServer, certStamp } from "./hubServer";

type Identity = ReturnType<typeof createDeviceIdentity>;

async function hub(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const owner = createDeviceIdentity(new Date().toISOString());
  await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  const ops = new HubOps(storage);
  const server = new HubServer({ hubId: "hub-test", version: "test", storage, search: new ChatSearchService(storage), vapidPublicKey: "BPUB", ops });
  const http = await server.listenHttp(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (identity: HubSigningIdentity, method: string, pathWithQuery: string, body?: unknown, header?: string) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${base}${pathWithQuery}`, {
      method,
      headers: { authorization: header ?? signHubRequest(identity, { method, pathWithQuery, body: text }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: text })
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { dir, storage, ops, server, base, owner, call };
}

const roster = (h: Awaited<ReturnType<typeof hub>>, devices: Array<{ identity: Identity; role: string; name: string; machineId?: string }>) =>
  h.call(h.owner, "PUT", "/v1/roster", { devices: devices.map(({ identity, ...rest }) => ({ deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64, ...rest })) });

test("only signed requests from devices on the roster are answered; health is open", async (t) => {
  const h = await hub(t);
  const health = await fetch(`${h.base}/v1/health`).then((response) => response.json()) as Record<string, unknown>;
  assert.equal(health.ok, true);
  assert.equal(health.head, 0, "the feed's newest place");
  assert.equal((await fetch(`${h.base}/v3/chats`)).status, 401, "unsigned");
  const stranger = createDeviceIdentity(new Date().toISOString());
  assert.equal((await h.call(stranger, "GET", "/v3/chats")).status, 401, "not on the roster");
  assert.equal((await h.call(h.owner, "GET", "/v3/chats")).status, 200);
  // The same signed request cannot be played again.
  const header = signHubRequest(h.owner, { method: "GET", pathWithQuery: "/v3/chats" });
  assert.equal((await h.call(h.owner, "GET", "/v3/chats", undefined, header)).status, 200);
  assert.equal((await h.call(h.owner, "GET", "/v3/chats", undefined, header)).status, 401, "replayed");
  // A signature is for its own path: the same header on another path fails.
  assert.equal((await h.call(h.owner, "GET", "/v3/feed?after=0", undefined, signHubRequest(h.owner, { method: "GET", pathWithQuery: "/v3/chats" }))).status, 401);
});

test("the owner keeps the roster; a phone it adds can read, and a machine cannot search", async (t) => {
  const h = await hub(t);
  const phone = createDeviceIdentity(new Date().toISOString());
  const machine = createDeviceIdentity(new Date().toISOString());
  assert.equal((await h.call(phone, "GET", "/v3/chats")).status, 401);
  const listed = await h.call(h.owner, "PUT", "/v1/roster", { devices: [
    // The owner sends itself too (as the desktop it is); it stays the owner.
    { deviceId: h.owner.originId, publicKeyDerBase64: h.owner.publicKeyDerBase64, role: "desktop", name: "Mac" },
    { deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "iPhone" },
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Box", machineId: "machine-1" }
  ] });
  assert.equal(listed.status, 200);
  assert.equal((listed.body.devices as unknown[]).length, 3, "owner kept");
  assert.equal((listed.body.devices as Array<{ deviceId: string; role: string }>).find((device) => device.deviceId === h.owner.originId)?.role, "owner");
  assert.equal((await h.call(phone, "GET", "/v3/chats")).status, 200);
  assert.equal((await h.call(phone, "PUT", "/v1/roster", { devices: [] })).status, 403, "only the owner changes the roster");
  assert.equal((await h.call(machine, "GET", "/v1/search?q=x")).status, 403);
  // A roster entry whose id does not derive from its key is refused.
  assert.equal((await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: phone.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "phone", name: "x" }] })).status, 400);
});

test("the owner reads when each device last read the server's feed; nobody else reads the roster", async (t) => {
  const h = await hub(t);
  const machine = createDeviceIdentity(new Date().toISOString());
  await roster(h, [{ identity: machine, role: "machine", name: "Box", machineId: "machine-1" }]);
  let read = await h.call(h.owner, "GET", "/v1/roster");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.feedReads, [], "nobody read yet");
  assert.equal((await h.call(machine, "GET", "/v3/feed?after=0")).status, 200);
  read = await h.call(h.owner, "GET", "/v1/roster");
  const reads = read.body.feedReads as Array<{ deviceId: string; readAt: string }>;
  assert.deepEqual(reads.map((item) => item.deviceId), [machine.originId]);
  assert.ok(Number.isFinite(Date.parse(reads[0].readAt)));
  assert.equal((await h.call(machine, "GET", "/v1/roster")).status, 403);
});

test("the old order's routes are gone", async (t) => {
  const h = await hub(t);
  const machine = createDeviceIdentity(new Date().toISOString());
  await roster(h, [{ identity: machine, role: "machine", name: "Box", machineId: "machine-1" }]);
  for (const route of ["/v1/events?after=0", "/v1/chain?origin=x&scope=y&from=1&to=2", "/v1/snapshot?copy=1", "/v1/readers", "/v1/devices/known?ids=x"]) {
    assert.equal((await h.call(h.owner, "GET", route)).status, 404, route);
    assert.equal((await h.call(machine, "GET", route)).status, 404, route);
  }
  assert.equal((await h.call(machine, "POST", "/v1/events", { events: [] })).status, 404);
});

test("a device sits in a room only as what it is, and leaves when taken off the roster", async (t) => {
  const h = await hub(t);
  const machine = createDeviceIdentity(new Date().toISOString());
  await roster(h, [{ identity: machine, role: "machine", name: "Box", machineId: "machine-1" }]);
  const open = (identity: HubSigningIdentity, role: string) => {
    const pathWithQuery = `/v1/room?rid=rv-roles&role=${role}`;
    const auth = signHubRequest(identity, { method: "GET", pathWithQuery });
    const socket = new WebSocket(`${h.base.replace("http", "ws")}${pathWithQuery}&auth=${encodeURIComponent(auth)}`);
    return new Promise<{ socket: WebSocket; outcome: string }>((resolve) => {
      socket.addEventListener("open", () => resolve({ socket, outcome: "open" }));
      socket.addEventListener("error", () => resolve({ socket, outcome: "refused" }));
    });
  };
  assert.equal((await open(machine, "desktop")).outcome, "refused", "a machine cannot pose as a desktop");
  const seated = await open(machine, "machine");
  assert.equal(seated.outcome, "open");
  const closed = new Promise<void>((resolve) => seated.socket.addEventListener("close", () => resolve()));
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [] });
  await closed;
});

test("a small request with a large body is refused before it is read in full", async (t) => {
  const h = await hub(t);
  const body = JSON.stringify({ devices: [], padding: "x".repeat(300 * 1024) });
  const response = await fetch(`${h.base}/v1/roster`, { method: "PUT", body, headers: { "content-type": "application/json", authorization: signHubRequest(h.owner, { method: "PUT", pathWithQuery: "/v1/roster", body }) } }).catch(() => undefined);
  assert.ok(!response || response.status === 413, `refused (${response?.status})`);
  const stranger = createDeviceIdentity(new Date().toISOString());
  const unknown = await fetch(`${h.base}/v3/ops`, { method: "POST", body: "{}", headers: { authorization: signHubRequest(stranger, { method: "POST", pathWithQuery: "/v3/ops", body: "{}" }) } });
  assert.equal(unknown.status, 401);
});

test("the live socket says where the server's feed stands, at once and after every accepted operation", async (t) => {
  const h = await hub(t);
  const auth = signHubRequest(h.owner, { method: "GET", pathWithQuery: "/v1/live" });
  const socket = new WebSocket(`${h.base.replace("http", "ws")}/v1/live?auth=${encodeURIComponent(auth)}`);
  const frames: Array<{ type: string; head: number }> = [];
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as { type: string; head: number });
      if (frames.length === 1) resolve();
    });
    socket.addEventListener("error", () => reject(new Error("socket failed")));
  });
  const opId = `op-${createHash("sha256").update(randomBytes(8)).digest("hex").slice(0, 16)}`;
  const written = await h.call(h.owner, "POST", "/v3/ops", { ops: [{ opId, kind: "conversation.create", conversationId: "chat-live",
    conversation: { title: "Live", kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: [] } } }] });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal((written.body.results as Array<{ status: string }>)[0]?.status, "accepted", JSON.stringify(written.body));
  for (let i = 0; i < 50 && frames.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  socket.close();
  assert.deepEqual(frames.map((frame) => [frame.type, frame.head]), [["ops", 0], ["ops", 1]], "no word of any other order");
  const refused = new WebSocket(`${h.base.replace("http", "ws")}/v1/live?auth=${encodeURIComponent(auth)}`);
  const outcome = await new Promise<string>((resolve) => {
    refused.addEventListener("open", () => resolve("open"));
    refused.addEventListener("error", () => resolve("refused"));
  });
  assert.equal(outcome, "refused", "the same signature does not open a second socket");
});

test("a body (a picture, an avatar) goes up in fragments and is read back; a wrong fragment never spoils a whole one", async (t) => {
  const h = await hub(t);
  const bytes = randomBytes(BLOB_FRAGMENT_MAX_BYTES + 1_000);
  const reference = { blobHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, byteLength: bytes.length, fragments: 2 };
  const blobPath = (index: number) => `/v1/blobs/${reference.blobHash}?bytes=${reference.byteLength}&fragments=${reference.fragments}&index=${index}`;
  const fragment = (index: number) => bytes.subarray(index * BLOB_FRAGMENT_MAX_BYTES, (index + 1) * BLOB_FRAGMENT_MAX_BYTES);
  const put = (index: number, body: Buffer) => fetch(`${h.base}${blobPath(index)}`, { method: "PUT", headers: { authorization: signHubRequest(h.owner, { method: "PUT", pathWithQuery: blobPath(index), body }) }, body });
  for (let index = 0; index < reference.fragments; index += 1) assert.equal((await put(index, fragment(index))).status, 200);
  await put(0, Buffer.alloc(fragment(0).length, 1));
  const back = await fetch(`${h.base}${blobPath(0)}`, { headers: { authorization: signHubRequest(h.owner, { method: "GET", pathWithQuery: blobPath(0) }) } });
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), fragment(0), "the whole body stands");
  assert.equal(await h.storage.deviceEventBlobs().verify({ type: "device.event.blob", ...reference }), true);
});

test("rooms pass live messages between the User's devices and keep nothing", async (t) => {
  const h = await hub(t);
  const machine = createDeviceIdentity(new Date().toISOString());
  await roster(h, [{ identity: machine, role: "machine", name: "Box", machineId: "machine-1" }]);
  const { HubTunnelClient } = await import("../main/services/hubTunnelClient");
  const desktopTunnel = new HubTunnelClient({ hubUrl: h.base, rendezvousId: "rv-test", role: "desktop", identity: async () => h.owner, reconnectDelayMs: 50 });
  const machineTunnel = new HubTunnelClient({ hubUrl: h.base, rendezvousId: "rv-test", role: "machine", identity: async () => machine, reconnectDelayMs: 50 });
  t.after(() => { desktopTunnel.close(); machineTunnel.close(); });
  const desktopPeers: string[] = [];
  const machineReceived: string[] = [];
  desktopTunnel.on("peer", (event) => desktopPeers.push(event.type === "peer-connected" ? `+${event.peer.deviceId}` : event.type === "peer-disconnected" ? `-${event.peer.deviceId}` : event.type));
  machineTunnel.on("message", (message) => machineReceived.push(message.ciphertext));
  await desktopTunnel.connect();
  const wait = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20)); };
  await wait(() => desktopPeers.includes("ready"));
  await machineTunnel.connect();
  await wait(() => desktopPeers.includes(`+${machine.originId}`));
  assert.ok(desktopPeers.includes(`+${machine.originId}`), "the desktop sees the machine arrive");
  await desktopTunnel.sendCiphertext({ logicalMessageId: "m1", ciphertext: "sealed-hello", to: machine.originId });
  await wait(() => machineReceived.length === 1);
  assert.deepEqual(machineReceived, ["sealed-hello"]);
  machineTunnel.close();
  await wait(() => desktopPeers.includes(`-${machine.originId}`));
  assert.ok(desktopPeers.includes(`-${machine.originId}`), "and leave");
  // Nothing was kept: the feed is still empty.
  assert.equal(await h.ops.head(), 0);
});

test("a device that takes its own seat again is announced to the room, so the others greet it again", async (t) => {
  const h = await hub(t);
  const machine = createDeviceIdentity(new Date().toISOString());
  await roster(h, [{ identity: machine, role: "machine", name: "Box", machineId: "machine-1" }]);
  const { HubTunnelClient } = await import("../main/services/hubTunnelClient");
  const desktopTunnel = new HubTunnelClient({ hubUrl: h.base, rendezvousId: "rv-seat", role: "desktop", identity: async () => h.owner, reconnectDelayMs: 50 });
  const first = new HubTunnelClient({ hubUrl: h.base, rendezvousId: "rv-seat", role: "machine", identity: async () => machine, reconnectDelayMs: 50 });
  // The machine's new process, while the server has not seen the old socket close.
  const second = new HubTunnelClient({ hubUrl: h.base, rendezvousId: "rv-seat", role: "machine", identity: async () => machine, reconnectDelayMs: 50 });
  t.after(() => { desktopTunnel.close(); first.close(); second.close(); });
  const desktopPeers: string[] = [];
  desktopTunnel.on("peer", (event) => desktopPeers.push(event.type === "peer-connected" ? `+${event.peer.deviceId}` : event.type === "peer-disconnected" ? `-${event.peer.deviceId}` : event.type));
  const wait = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20)); };
  await desktopTunnel.connect();
  await wait(() => desktopPeers.includes("ready"));
  await first.connect();
  await wait(() => desktopPeers.filter((item) => item === `+${machine.originId}`).length === 1);
  const firstStates: string[] = [];
  first.on("state", (state) => firstStates.push(state));
  await second.connect();
  await wait(() => desktopPeers.filter((item) => item === `+${machine.originId}`).length === 2);
  // The replaced connection is closed by the server; whatever its close
  // could cause has happened before the desktop's view is judged.
  await wait(() => firstStates.includes("closed"));
  assert.ok(firstStates.includes("closed"), "the older connection gives up its seat");
  await desktopTunnel.sendCiphertext({ logicalMessageId: "after", ciphertext: "ping", to: machine.originId }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(desktopPeers.filter((item) => item.endsWith(machine.originId)), [`+${machine.originId}`, `+${machine.originId}`],
    "the new connection is announced, and the replaced one does not read as the machine leaving");
});

test("a renewed certificate is noticed though its chain ends the same as before", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-cert-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = { cert: path.join(dir, "fullchain.pem"), key: path.join(dir, "privkey.pem") };
  const intermediate = "-----BEGIN CERTIFICATE-----\nINTERMEDIATE\n-----END CERTIFICATE-----\n";
  await writeFile(files.cert, `-----BEGIN CERTIFICATE-----\nLEAF-ONE\n-----END CERTIFICATE-----\n${intermediate}`);
  await writeFile(files.key, "KEY-ONE");
  const before = certStamp(files);
  await writeFile(files.cert, `-----BEGIN CERTIFICATE-----\nLEAF-TWO\n-----END CERTIFICATE-----\n${intermediate}`);
  await writeFile(files.key, "KEY-TWO");
  assert.notEqual(certStamp(files), before);
});

test("closing the hub ends connections that are still open at once", async (t) => {
  const h = await hub(t);
  const net = await import("node:net");
  const port = Number(new URL(h.base).port);
  // A request whose body never finishes, as a stalled phone would leave one.
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(`POST /v3/ops HTTP/1.1\r\nHost: x\r\nAuthorization: ${signHubRequest(h.owner, { method: "POST", pathWithQuery: "/v3/ops", body: "{}" })}\r\nContent-Length: 1000\r\n\r\n{`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = Date.now();
  await h.server.close();
  assert.ok(Date.now() - started < 2_000, `closed in ${Date.now() - started} ms`);
  socket.destroy();
});

test("retention thresholds come from the environment only as positive whole numbers", () => {
  const config = hubRetentionConfig({ ACCORDAGENTS_HUB_KEEP_FEED_MS: "60000", ACCORDAGENTS_HUB_RETENTION_BATCH: "-5", ACCORDAGENTS_HUB_RETENTION_MAX_BATCHES: "1.5" });
  assert.equal(config.feedMs, 60_000);
  assert.equal(config.batch, HUB_RETENTION_DEFAULTS.batch);
  assert.equal(config.maxBatches, HUB_RETENTION_DEFAULTS.maxBatches);
});
