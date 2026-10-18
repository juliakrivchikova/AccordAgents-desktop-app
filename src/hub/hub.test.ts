import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CHAT_CHANGES_EVENT_KIND, chatChangesLogScope, type ChatChangesPayload } from "../main/services/chatChanges";
import { ChatSearchService } from "../main/services/chatSearch";
import { createChatEventDeviceIdentity, createSignedChatEvent } from "../main/services/chatEventLog";
import { signHubRequest, type HubSigningIdentity } from "../main/services/hubAuth";
import { StorageService } from "../main/services/storage";
import type { ChatEventEnvelope } from "../shared/chatEvents";
import type { HubEventPullResponse, HubEventPushResponse } from "../shared/hubProtocol";
import type { ChatMessage } from "../shared/types";
import { HubFolder } from "./hubFolder";
import { hubApplyPolicy } from "./hubPolicy";
import { HubLog } from "./hubLog";
import { HubServer } from "./hubServer";

type Identity = ReturnType<typeof createChatEventDeviceIdentity>;

async function hub(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const owner = createChatEventDeviceIdentity(new Date().toISOString());
  await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  const log = new HubLog(storage);
  const policy = hubApplyPolicy(storage);
  const folder = new HubFolder(storage, policy);
  log.onAppended(({ changedConversationIds }) => folder.enqueue(changedConversationIds));
  const server = new HubServer({ hubId: "hub-test", version: "test", storage, log, search: new ChatSearchService(storage), vapidPublicKey: "BPUB" });
  const http = await server.listenHttp(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    await server.close();
    await folder.idle();
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
  return { dir, storage, log, folder, server, base, owner, call };
}

function changesEvent(identity: Identity, conversationId: string, originSeq: number, prevHash: string | undefined, changes: ChatChangesPayload["changes"]): ChatEventEnvelope {
  const payload: ChatChangesPayload = { version: 1, conversationId, updatedAt: new Date().toISOString(), changes };
  return createSignedChatEvent(identity, {
    conversationId, logScopeId: chatChangesLogScope(conversationId), kind: CHAT_CHANGES_EVENT_KIND, payload,
    originSeq, ...(prevHash ? { prevHash } : {}), createdAt: new Date().toISOString()
  });
}

function message(id: string, content: string): ChatMessage {
  return { id, role: "user", content, createdAt: new Date().toISOString() } as ChatMessage;
}

const created = (_id: string) => ({ type: "conversation.created" as const, conversation: { title: "Alerts", kind: "chat" as const, createdAt: new Date().toISOString(), metadata: { participants: [] } } });

test("only signed requests from devices on the roster are answered; health is open", async (t) => {
  const h = await hub(t);
  const health = await fetch(`${h.base}/v1/health`).then((response) => response.json()) as Record<string, unknown>;
  assert.equal(health.ok, true);
  assert.equal(health.head, 0);
  assert.equal((await fetch(`${h.base}/v1/events?after=0`)).status, 401, "unsigned");
  const stranger = createChatEventDeviceIdentity(new Date().toISOString());
  assert.equal((await h.call(stranger, "GET", "/v1/events?after=0")).status, 401, "not on the roster");
  assert.equal((await h.call(h.owner, "GET", "/v1/events?after=0")).status, 200);
  // The same signed request cannot be played again.
  const header = signHubRequest(h.owner, { method: "GET", pathWithQuery: "/v1/events?after=0" });
  assert.equal((await h.call(h.owner, "GET", "/v1/events?after=0", undefined, header)).status, 200);
  assert.equal((await h.call(h.owner, "GET", "/v1/events?after=0", undefined, header)).status, 401, "replayed");
  // A signature is for its own path: the same header on another path fails.
  assert.equal((await h.call(h.owner, "GET", "/v1/events?after=5", undefined, signHubRequest(h.owner, { method: "GET", pathWithQuery: "/v1/events?after=0" }))).status, 401);
});

test("the owner keeps the roster; a phone it adds can read, and a machine cannot search", async (t) => {
  const h = await hub(t);
  const phone = createChatEventDeviceIdentity(new Date().toISOString());
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  assert.equal((await h.call(phone, "GET", "/v1/events?after=0")).status, 401);
  const roster = await h.call(h.owner, "PUT", "/v1/roster", { devices: [
    // The owner sends itself too (as the desktop it is); it stays the owner.
    { deviceId: h.owner.originId, publicKeyDerBase64: h.owner.publicKeyDerBase64, role: "desktop", name: "Mac" },
    { deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "iPhone" },
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Box", machineId: "machine-1" }
  ] });
  assert.equal(roster.status, 200);
  assert.equal((roster.body.devices as unknown[]).length, 3, "owner kept");
  assert.equal((roster.body.devices as Array<{ deviceId: string; role: string }>).find((device) => device.deviceId === h.owner.originId)?.role, "owner");
  assert.equal((await h.call(phone, "GET", "/v1/events?after=0")).status, 200);
  assert.equal((await h.call(phone, "PUT", "/v1/roster", { devices: [] })).status, 403, "only the owner changes the roster");
  assert.equal((await h.call(machine, "GET", "/v1/search?q=x")).status, 403);
  // A roster entry whose id does not derive from its key is refused.
  assert.equal((await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: phone.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "phone", name: "x" }] })).status, 400);
});

test("events take one order: accepted once, repeated as duplicates, gaps and forgeries refused", async (t) => {
  const h = await hub(t);
  const first = changesEvent(h.owner, "chat-1", 1, undefined, [created("chat-1")]);
  const second = changesEvent(h.owner, "chat-1", 2, first.eventHash, [{ type: "message.created", message: message("m1", "disk is full on prod") }]);
  const third = changesEvent(h.owner, "chat-1", 3, second.eventHash, [{ type: "message.created", message: message("m2", "second") }]);
  let pushed = await h.call(h.owner, "POST", "/v1/events", { events: [first, third] });
  let results = (pushed.body as unknown as HubEventPushResponse).results;
  assert.deepEqual(results.map((result) => [result.status, result.hubSeq ?? result.expectedSeq]), [["accepted", 1], ["gap", 2]]);
  pushed = await h.call(h.owner, "POST", "/v1/events", { events: [first, second, third] });
  results = (pushed.body as unknown as HubEventPushResponse).results;
  assert.deepEqual(results.map((result) => [result.status, result.hubSeq]), [["duplicate", 1], ["accepted", 2], ["accepted", 3]]);
  assert.equal((pushed.body as unknown as HubEventPushResponse).head, 3);

  const tampered = { ...changesEvent(h.owner, "chat-1", 4, third.eventHash, []), kind: "something.else" };
  const phone = createChatEventDeviceIdentity(new Date().toISOString());
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "iPhone" }] });
  const notTheirs = changesEvent(h.owner, "chat-1", 4, third.eventHash, []);
  results = ((await h.call(h.owner, "POST", "/v1/events", { events: [tampered] })).body as unknown as HubEventPushResponse).results;
  assert.equal(results[0].status, "rejected", "a changed field breaks the signature");
  results = ((await h.call(phone, "POST", "/v1/events", { events: [notTheirs] })).body as unknown as HubEventPushResponse).results;
  assert.equal(results[0].status, "rejected", "a device pushes only its own events");
  const fork = changesEvent(h.owner, "chat-1", 3, second.eventHash, [{ type: "message.created", message: message("m9", "other") }]);
  results = ((await h.call(h.owner, "POST", "/v1/events", { events: [fork] })).body as unknown as HubEventPushResponse).results;
  assert.equal(results[0].status, "conflict", "another event already holds that place");

  // Any device reads the same order from any position.
  const pulled = (await h.call(phone, "GET", "/v1/events?after=1")).body as unknown as HubEventPullResponse;
  assert.deepEqual(pulled.events.map((item) => [item.hubSeq, item.event.eventId]), [[2, second.eventId], [3, third.eventId]]);
  assert.equal(pulled.head, 3);
  assert.deepEqual(((await h.call(phone, "GET", "/v1/events?after=3")).body as unknown as HubEventPullResponse).events, []);
});

test("the hub folds the chats it holds and finds them by their words", async (t) => {
  const h = await hub(t);
  const first = changesEvent(h.owner, "chat-2", 1, undefined, [created("chat-2")]);
  const second = changesEvent(h.owner, "chat-2", 2, first.eventHash, [{ type: "message.created", message: message("m1", "the grafana alert fired for checkout latency") }]);
  await h.call(h.owner, "POST", "/v1/events", { events: [first, second] });
  await h.folder.idle();
  const stored = await h.storage.getConversation("chat-2");
  assert.equal(stored?.title, "Alerts");
  assert.deepEqual(stored?.messages.map((item) => item.content), ["the grafana alert fired for checkout latency"]);
  const found = await h.call(h.owner, "GET", `/v1/search?q=${encodeURIComponent("checkout")}`);
  assert.equal(found.status, 200);
  assert.equal(found.body.status, "ok");
  assert.ok((found.body.matches as Array<{ conversationId: string }>).some((match) => match.conversationId === "chat-2"));
});

test("a change to a chat the hub does not hold yet waits until the chat arrives", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Box", machineId: "machine-1" }] });
  const early = changesEvent(machine, "chat-3", 1, undefined, [{ type: "message.created", message: message("n1", "from the machine") }]);
  await h.call(machine, "POST", "/v1/events", { events: [early] });
  await h.folder.idle();
  assert.equal(await h.storage.getConversation("chat-3"), undefined);
  await h.call(h.owner, "POST", "/v1/events", { events: [changesEvent(h.owner, "chat-3", 1, undefined, [created("chat-3")])] });
  await h.folder.idle();
  // The machine's change is folded behind the chat's creation, in the hub's order.
  const folded = await h.storage.getConversation("chat-3");
  assert.equal(folded?.title, "Alerts");
  assert.deepEqual(folded?.messages.map((item) => item.id), ["n1"], "the change that waited is in it");
});

test("more changes than one fold reads wait for a chat whose creation comes after them", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Box", machineId: "machine-1" }] });
  let prev: string | undefined;
  const early: ChatEventEnvelope[] = [];
  for (let n = 1; n <= 205; n += 1) {
    const event = changesEvent(machine, "chat-many", n, prev, [{ type: "message.created", message: message(`w${n}`, `waiting ${n}`) }]);
    early.push(event);
    prev = event.eventHash;
  }
  await h.call(machine, "POST", "/v1/events", { events: early.slice(0, 200) });
  await h.call(machine, "POST", "/v1/events", { events: early.slice(200) });
  await h.folder.idle();
  await h.call(h.owner, "POST", "/v1/events", { events: [changesEvent(h.owner, "chat-many", 1, undefined, [created("chat-many")])] });
  await h.folder.idle();
  assert.equal((await h.storage.getConversation("chat-many"))?.messages.length, 205);
});

test("names with control characters and commands under a chat change's scope are refused", async (t) => {
  const h = await hub(t);
  const valid = changesEvent(h.owner, "chat-n", 1, undefined, [created("chat-n")]);
  const withNul = { ...valid, eventId: `${valid.eventId}\u0000x` };
  const asCommand = createSignedChatEvent(h.owner, { conversationId: "chat-n", logScopeId: chatChangesLogScope("chat-n"), kind: "machine.trust.roster", payload: {}, originSeq: 1, createdAt: new Date().toISOString() });
  const results = ((await h.call(h.owner, "POST", "/v1/events", { events: [withNul, asCommand] })).body as unknown as HubEventPushResponse).results;
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal((await h.call(h.owner, "GET", "/v1/events?after=0")).body.head, 0);
});

test("events the first copy already holds are not placed again; one stored before a crash is placed and announced", async (t) => {
  const h = await hub(t);
  const first = changesEvent(h.owner, "chat-c", 1, undefined, [created("chat-c")]);
  const second = changesEvent(h.owner, "chat-c", 2, first.eventHash, []);
  await h.storage.applyChatCopyMarks([{ originId: h.owner.originId, logScopeId: chatChangesLogScope("chat-c"), originSeq: 2, eventHash: second.eventHash }], new Date().toISOString());
  let results = ((await h.call(h.owner, "POST", "/v1/events", { events: [first, second] })).body as unknown as HubEventPushResponse).results;
  assert.deepEqual(results.map((result) => result.status), ["duplicate", "duplicate"], "covered by the copy");
  assert.equal((await h.call(h.owner, "GET", "/v1/events?after=0")).body.head, 0, "and not in the order");
  // The hub stored an event but stopped before giving it its place.
  const third = changesEvent(h.owner, "chat-c", 3, second.eventHash, []);
  await h.storage.appendChatEvents([third]);
  const announced: number[] = [];
  h.log.onAppended(({ head }) => announced.push(head));
  results = ((await h.call(h.owner, "POST", "/v1/events", { events: [third] })).body as unknown as HubEventPushResponse).results;
  assert.equal(results[0].hubSeq, 1);
  assert.deepEqual(announced, [1], "devices are told about it");
});

test("a device's own events are not read back to it, and the page says how far it covers", async (t) => {
  const h = await hub(t);
  const phone = createChatEventDeviceIdentity(new Date().toISOString());
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "iPhone" }] });
  await h.call(h.owner, "POST", "/v1/events", { events: [changesEvent(h.owner, "chat-o", 1, undefined, [created("chat-o")])] });
  await h.call(phone, "POST", "/v1/events", { events: [changesEvent(phone, "chat-o", 1, undefined, [])] });
  const forOwner = (await h.call(h.owner, "GET", "/v1/events?after=0")).body as unknown as HubEventPullResponse;
  assert.deepEqual(forOwner.events.map((item) => item.event.originId), [phone.originId]);
  assert.equal(forOwner.through, 2);
  const forPhone = (await h.call(phone, "GET", "/v1/events?after=0")).body as unknown as HubEventPullResponse;
  assert.deepEqual(forPhone.events.map((item) => item.event.originId), [h.owner.originId]);
  assert.equal(forPhone.through, 2);
});

test("a device sits in a room only as what it is, and leaves when taken off the roster", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Box", machineId: "machine-1" }] });
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
  const stranger = createChatEventDeviceIdentity(new Date().toISOString());
  const unknown = await fetch(`${h.base}/v1/events`, { method: "POST", body: "{}", headers: { authorization: signHubRequest(stranger, { method: "POST", pathWithQuery: "/v1/events", body: "{}" }) } });
  assert.equal(unknown.status, 401);
});

test("the live socket says where the head is, at once and after every push", async (t) => {
  const h = await hub(t);
  const auth = signHubRequest(h.owner, { method: "GET", pathWithQuery: "/v1/live" });
  const socket = new WebSocket(`${h.base.replace("http", "ws")}/v1/live?auth=${encodeURIComponent(auth)}`);
  const heads: number[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      heads.push((JSON.parse(String(event.data)) as { head: number }).head);
      if (heads.length === 1) resolve();
    });
    socket.addEventListener("error", () => reject(new Error("socket failed")));
  });
  await h.call(h.owner, "POST", "/v1/events", { events: [changesEvent(h.owner, "chat-4", 1, undefined, [created("chat-4")])] });
  for (let i = 0; i < 50 && heads.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  socket.close();
  assert.deepEqual(heads, [0, 1]);
  const refused = new WebSocket(`${h.base.replace("http", "ws")}/v1/live?auth=${encodeURIComponent(auth)}`);
  const outcome = await new Promise<string>((resolve) => {
    refused.addEventListener("open", () => resolve("open"));
    refused.addEventListener("error", () => resolve("refused"));
  });
  assert.equal(outcome, "refused", "the same signature does not open a second socket");
});

test("a large payload travels as a blob whose fragments go first", async (t) => {
  const source = await hub(t);
  const h = await hub(t);
  // The sending device cuts the payload into fragments in its own store.
  const reference = await source.storage.deviceEventBlobs().prepare({ big: "x".repeat(100_000) }) as { blobHash: string; byteLength: number; fragments: number };
  const fragmentOf = async (index: number) => Buffer.from((await source.storage.deviceEventBlobs().fragment(reference as never, index))!.bytesBase64, "base64");
  const event = createSignedChatEvent(h.owner, { conversationId: "chat-5", logScopeId: "blob-test", kind: "test.blob", payload: reference, originSeq: 1, createdAt: new Date().toISOString() });
  let results = ((await h.call(h.owner, "POST", "/v1/events", { events: [event] })).body as unknown as HubEventPushResponse).results;
  assert.equal(results[0].status, "blob-missing");
  const blobPath = (index: number) => `/v1/blobs/${reference.blobHash}?bytes=${reference.byteLength}&fragments=${reference.fragments}&index=${index}`;
  for (let index = 0; index < reference.fragments; index += 1) {
    const bytes = await fragmentOf(index);
    const response = await fetch(`${h.base}${blobPath(index)}`, { method: "PUT", headers: { authorization: signHubRequest(h.owner, { method: "PUT", pathWithQuery: blobPath(index), body: bytes }) }, body: bytes });
    assert.equal(response.status, 200);
  }
  const corrupt = Buffer.alloc((await fragmentOf(0)).length, 1);
  const refused = await fetch(`${h.base}${blobPath(0)}`, { method: "PUT", headers: { authorization: signHubRequest(h.owner, { method: "PUT", pathWithQuery: blobPath(0), body: corrupt }) }, body: corrupt });
  results = ((await h.call(h.owner, "POST", "/v1/events", { events: [event] })).body as unknown as HubEventPushResponse).results;
  assert.equal(results[0].status, "accepted", `the event is accepted once its blob is whole (a conflicting fragment answered ${refused.status})`);
  const back = await fetch(`${h.base}${blobPath(0)}`, { headers: { authorization: signHubRequest(h.owner, { method: "GET", pathWithQuery: blobPath(0) }) } });
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), await fragmentOf(0));
});

test("a chain the desktop's first copy anchored continues without its earlier events", async (t) => {
  const h = await hub(t);
  const anchorEvent = changesEvent(h.owner, "chat-6", 7, "sha256:earlier", [created("chat-6")]);
  await h.storage.applyChatCopyMarks([{ originId: h.owner.originId, logScopeId: chatChangesLogScope("chat-6"), originSeq: 7, eventHash: anchorEvent.eventHash }], new Date().toISOString());
  const next = changesEvent(h.owner, "chat-6", 8, anchorEvent.eventHash, []);
  const results = ((await h.call(h.owner, "POST", "/v1/events", { events: [next] })).body as unknown as HubEventPushResponse).results;
  assert.equal(results[0].status, "accepted");
  const skipped = changesEvent(h.owner, "chat-7", 3, "sha256:x", []);
  assert.equal(((await h.call(h.owner, "POST", "/v1/events", { events: [skipped] })).body as unknown as HubEventPushResponse).results[0].status, "gap");
});

test("rooms pass live messages between the User's devices and keep nothing", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Box", machineId: "machine-1" }] });
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
  // Nothing was stored: the order is still empty.
  assert.equal((await h.call(h.owner, "GET", "/v1/events?after=0")).body.head, 0);
});
