import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { HubRetention, HUB_RETENTION_DEFAULTS } from "./hubRetention";
import { HubServer, certStamp } from "./hubServer";

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

test("a machine member's reply is folded from the machine it runs on, with no desktop involved; another machine cannot write it", async (t) => {
  const h = await hub(t);
  const home = createChatEventDeviceIdentity(new Date().toISOString());
  const other = createChatEventDeviceIdentity(new Date().toISOString());
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [
    { deviceId: home.originId, publicKeyDerBase64: home.publicKeyDerBase64, role: "machine", name: "Cloud box", machineId: "machine-home" },
    { deviceId: other.originId, publicKeyDerBase64: other.publicKeyDerBase64, role: "machine", name: "Other box", machineId: "machine-other" }
  ] });
  const member = { id: "p-bot", handle: "bot", kind: "claude-code", homeMachineId: "machine-home" };
  const bubble = { id: "reply-1", role: "participant", participantId: member.id, participantLabel: "@bot", content: "", status: "pending", createdAt: new Date().toISOString() } as ChatMessage;
  // The desktop creates the chat and the member's pending bubble, then goes away.
  const createdChat = changesEvent(h.owner, "chat-machine", 1, undefined, [{ type: "conversation.created", conversation: { title: "Cloud", kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: [member] } } }]);
  const pending = changesEvent(h.owner, "chat-machine", 2, createdChat.eventHash, [{ type: "message.created", message: bubble }]);
  await h.call(h.owner, "POST", "/v1/events", { events: [createdChat, pending] });
  // Another machine of the User's cannot write a reply for a member it does not host.
  const forged = changesEvent(other, "chat-machine", 1, undefined, [{ type: "message.updated", message: { ...bubble, content: "not mine to write", status: "done" } }]);
  await h.call(other, "POST", "/v1/events", { events: [forged] });
  await h.folder.idle();
  assert.equal((await h.storage.getConversation("chat-machine"))?.messages.find((item) => item.id === "reply-1")?.status, "pending");
  // The member's own machine writes it, and the phone's copy has it.
  const answered = changesEvent(home, "chat-machine", 1, undefined, [{ type: "message.updated", message: { ...bubble, content: "answered on the machine", status: "done" } }]);
  assert.equal((await h.call(home, "POST", "/v1/events", { events: [answered] })).status, 200);
  await h.folder.idle();
  const reply = (await h.storage.getConversation("chat-machine"))?.messages.find((item) => item.id === "reply-1");
  assert.equal(reply?.content, "answered on the machine");
  assert.equal(reply?.status, "done");
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

// --- Bounded storage (reader floors, retention, starting again) ---

const DAY = 24 * 60 * 60_000;
const retention = (h: Awaited<ReturnType<typeof hub>>, laterMs = 40 * DAY) => new HubRetention({
  storage: h.storage, config: { ...HUB_RETENTION_DEFAULTS, batch: 3 }, now: () => Date.now() + laterMs
});

/** A chain of `count` message changes to one chat (the first creates it). */
function changes(identity: Identity, conversationId: string, count: number, from = 1, prevHash?: string): ChatEventEnvelope[] {
  const events: ChatEventEnvelope[] = [];
  let prev = prevHash;
  for (let n = from; n < from + count; n += 1) {
    const event = changesEvent(identity, conversationId, n, prev, n === 1 ? [created(conversationId)] : [{ type: "message.created", message: message(`${conversationId}-m${n}`, `message ${n}`) }]);
    events.push(event);
    prev = event.eventHash;
  }
  return events;
}

/** A read that says what the device holds (a new client). */
const read = (after: number, held = 0) => `/v1/events?after=${after}&limit=200&held=${held}&heldSince=0&heldCount=${held ? 1 : 0}`;

async function rosterWithReader(h: Awaited<ReturnType<typeof hub>>, machine: Identity, extra: Array<Record<string, unknown>> = []) {
  return h.call(h.owner, "PUT", "/v1/roster", { devices: [
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Cloud box", machineId: "machine-1", reader: true, rendezvousId: "rv-box" },
    ...extra
  ] });
}

test("the hub forgets folded chat changes every reader read, and keeps what any reader still needs", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await rosterWithReader(h, machine);
  const events = changes(h.owner, "chat-r", 10);
  await h.call(h.owner, "POST", "/v1/events", { events });
  await h.folder.idle();
  // The owner read everything; the machine only up to 4.
  await h.call(h.owner, "GET", read(10));
  await h.call(machine, "GET", read(4));
  const first = await retention(h).runOnce();
  assert.equal(first.sharedFloor, 4);
  assert.equal(first.chatChanges.events, 4, "only what both readers read");
  const left = await h.storage.hub().pull(0, 200);
  assert.deepEqual(left.events.map((item) => item.hubSeq), [5, 6, 7, 8, 9, 10]);
  assert.equal((await h.storage.hub().logSize()).events, 6);
  assert.equal(await h.storage.hub().head(), 10, "the order does not look shorter");
  // Not yet a week old: nothing goes.
  await h.call(machine, "GET", read(10));
  assert.equal((await retention(h, 0).runOnce()).chatChanges.events, 0);
  // A machine holding a place keeps everything from it.
  await h.call(machine, "GET", read(10, 7));
  assert.equal((await retention(h).runOnce()).chatChanges.events, 2, "up to the held place");
  await h.call(machine, "GET", read(10));
  await retention(h).runOnce();
  // The newest event of the chain may go too: the hub continues from its mark.
  assert.equal((await h.storage.hub().logSize()).events, 0);
  assert.equal((await h.storage.getConversation("chat-r"))?.messages.length, 9, "the copy holds what was forgotten");
  const next = changes(h.owner, "chat-r", 1, 11, events[9].eventHash);
  const pushed = (await h.call(h.owner, "POST", "/v1/events", { events: [next[0]] })).body as unknown as HubEventPushResponse;
  assert.equal(pushed.results[0].status, "accepted");
  assert.equal(pushed.results[0].hubSeq, 11, "positions keep counting");
  // An event the hub forgot is not placed again.
  const again = (await h.call(h.owner, "POST", "/v1/events", { events: [events[3]] })).body as unknown as HubEventPushResponse;
  assert.equal(again.results[0].status, "duplicate");
  assert.equal((await h.storage.hub().logSize()).events, 1);
});

test("an unfolded change is never forgotten, and a phone holds nothing", async (t) => {
  const h = await hub(t);
  const phone = createChatEventDeviceIdentity(new Date().toISOString());
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [{ deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "iPhone" }] });
  // A change for a chat the hub does not hold yet waits, unfolded.
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [
    { deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "iPhone" },
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Box", machineId: "m" }
  ] });
  await h.call(machine, "POST", "/v1/events", { events: [changesEvent(machine, "chat-w", 1, undefined, [{ type: "message.created", message: message("w1", "early") }])] });
  await h.call(h.owner, "POST", "/v1/events", { events: changes(h.owner, "chat-x", 3) });
  await h.folder.idle();
  await h.call(h.owner, "GET", read(4));
  const report = await retention(h).runOnce();
  assert.equal(report.sharedFloor, 4, "the phone and a machine that never reads hold nothing");
  assert.equal(report.chatChanges.events, 3);
  assert.equal((await h.storage.hub().logSize()).events, 1, "the waiting change stays");
});

test("a device asking from before what was forgotten is told to start again, from a snapshot that pages the copy", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-snap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = await hub(t);
  // Small pages, so a chat goes in parts.
  const log = new HubLog(h.storage, () => new Date(), 600);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await rosterWithReader(h, machine);
  await h.call(h.owner, "POST", "/v1/events", { events: [...changes(h.owner, "chat-a", 6), ...changes(h.owner, "chat-b", 2)] });
  await h.folder.idle();
  await h.call(h.owner, "GET", read(8));
  await h.call(machine, "GET", read(8));
  await retention(h).runOnce();
  // Taken off and put back (its floor released): it no longer has a place here.
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [] });
  await rosterWithReader(h, machine);
  const device = (await h.storage.hub().devices()).find((item) => item.deviceId === machine.originId)!;
  await assert.rejects(log.pull(device, 0, 200, { held: 0, heldSince: 0, heldCount: 0 }), (error: Error) => error.name === "Error" && /starts again/.test(error.message));
  // Over HTTP it is a 410 that says so.
  const refused = await h.call(machine, "GET", read(0));
  assert.equal(refused.status, 410);
  assert.equal(refused.body.resync, true);
  assert.ok(Number(refused.body.prunedThrough) >= 8);
  // A device that does not say what it holds is read as before.
  assert.equal((await h.call(machine, "GET", "/v1/events?after=0")).status, 200);
  // The snapshot: where to start, the marks, and every chat (chat-a in parts).
  const pages: Array<{ hubSeq: number; marks?: unknown[]; conversations: Array<{ id: string; messages: unknown[]; more?: boolean }>; next?: string }> = [];
  let page: string | undefined;
  do {
    const response = await log.snapshot(device, { scopes: [], copy: true, ...(page ? { page } : {}) });
    pages.push(response);
    page = response.next;
  } while (page);
  assert.ok(pages.length > 2, "paged");
  assert.equal(pages[0].hubSeq, 8);
  assert.equal(pages[0].marks?.length, 2, "one mark per chat change chain");
  const messages = new Map<string, number>();
  for (const item of pages.flatMap((one) => one.conversations)) messages.set(item.id, (messages.get(item.id) ?? 0) + item.messages.length);
  assert.deepEqual(Object.fromEntries(messages), { "chat-a": 5, "chat-b": 1 }, "every message once");
  // Reading from the snapshot's position is a normal read again.
  assert.equal((await h.call(machine, "GET", read(8))).status, 200);
});

test("a snapshot starts before an unfolded change and before the device's own channel events", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await rosterWithReader(h, machine);
  await h.call(h.owner, "POST", "/v1/events", { events: changes(h.owner, "chat-s", 3) });
  // A command for the machine, written by the desktop before the machine started.
  const command = createSignedChatEvent(h.owner, { conversationId: "chat-s", logScopeId: `device:rv-box:${JSON.stringify(["chat-s", "actions"])}`, kind: "machine.turn.request", payload: { type: "machine.turn.request" }, originSeq: 1, createdAt: new Date().toISOString() });
  await h.call(h.owner, "POST", "/v1/events", { events: [command] });
  await h.call(h.owner, "POST", "/v1/events", { events: changes(h.owner, "chat-t", 2) });
  await h.folder.idle();
  const start = await h.call(machine, "GET", `/v1/snapshot?copy=0&atMost=6&scopes=${encodeURIComponent("device:rv-box:")}`);
  assert.equal(start.status, 200);
  assert.equal(start.body.hubSeq, 3, "just before the command");
  assert.equal((await h.call(machine, "GET", "/v1/snapshot?copy=0&atMost=2")).body.hubSeq, 2, "at most where its copy was made");
});

test("a channel's events go once both ends read them: a run's a day after its last event; a removed machine holds nothing", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await rosterWithReader(h, machine);
  const scope = (inner: string) => `device:rv-box:${JSON.stringify(["chat-p", inner])}`;
  const runEvents: ChatEventEnvelope[] = [];
  let prev: string | undefined;
  for (let n = 1; n <= 4; n += 1) {
    const event = createSignedChatEvent(machine, { conversationId: "chat-p", logScopeId: scope("terminal:run-1"), kind: n < 4 ? "machine.turn.progress.delta" : "machine.turn.finished", payload: { n }, originSeq: n, ...(prev ? { prevHash: prev } : {}), createdAt: new Date().toISOString() });
    runEvents.push(event);
    prev = event.eventHash;
  }
  const command = createSignedChatEvent(h.owner, { conversationId: "chat-p", logScopeId: scope("actions"), kind: "machine.turn.request", payload: {}, originSeq: 1, createdAt: new Date().toISOString() });
  await h.call(h.owner, "POST", "/v1/events", { events: [command] });
  await h.call(machine, "POST", "/v1/events", { events: runEvents });
  // The desktop read the run; the machine has not read the command yet.
  await h.call(h.owner, "GET", read(5));
  await h.call(machine, "GET", read(0));
  let report = await retention(h, 2 * DAY).runOnce();
  assert.equal(report.pairs.events, 0, "the machine has not read past them");
  await h.call(machine, "GET", read(5));
  report = await retention(h, 2 * DAY).runOnce();
  assert.equal(report.pairs.events, 4, "the run, a day after its end; the command is younger than three days");
  report = await retention(h, 4 * DAY).runOnce();
  assert.equal(report.pairs.events, 1);
  // A gap a late reader finds is answered with how far the hub forgot it.
  const gap = await h.call(h.owner, "GET", `/v1/chain?origin=${machine.originId}&scope=${encodeURIComponent(scope("terminal:run-1"))}&from=1&to=3`);
  assert.deepEqual(gap.body.events, []);
  assert.equal((gap.body.pruned as { originSeq: number }).originSeq, 4);
  // Taken off the roster, a machine no longer holds its channel.
  const late = createSignedChatEvent(h.owner, { conversationId: "chat-p", logScopeId: scope("actions"), kind: "machine.turn.request", payload: {}, originSeq: 2, prevHash: command.eventHash, createdAt: new Date().toISOString() });
  assert.equal(((await h.call(h.owner, "POST", "/v1/events", { events: [late] })).body as unknown as HubEventPushResponse).results[0].status, "accepted", "the chain continues from its mark");
  await h.call(h.owner, "GET", read(6));
  assert.equal((await retention(h, 4 * DAY).runOnce()).pairs.events, 0, "the machine still holds it");
  await h.call(h.owner, "PUT", "/v1/roster", { devices: [] });
  assert.equal((await h.storage.hub().readerFloors()).some((row) => row.deviceId === machine.originId), false, "its floor is released");
  assert.equal((await retention(h, 4 * DAY).runOnce()).pairs.events, 1);
});

test("the owner reads where every reader stands; nobody else may", async (t) => {
  const h = await hub(t);
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  await rosterWithReader(h, machine);
  await h.call(h.owner, "GET", read(0));
  let status = await h.call(h.owner, "GET", "/v1/readers");
  assert.equal(status.status, 200);
  const box = (status.body.readers as Array<{ deviceId: string; neverRead?: boolean; readAt?: string }>).find((item) => item.deviceId === machine.originId);
  assert.equal(box?.neverRead, true, "set up, never read");
  assert.ok(box?.readAt);
  await h.call(machine, "GET", "/v1/events?after=0&limit=200&held=3&heldSince=1000&heldCount=2");
  status = await h.call(h.owner, "GET", "/v1/readers");
  const read2 = (status.body.readers as Array<{ deviceId: string; neverRead?: boolean; heldCount?: number; floor: number }>).find((item) => item.deviceId === machine.originId);
  assert.equal(read2?.neverRead, undefined);
  assert.equal(read2?.heldCount, 2);
  assert.equal(read2?.floor, 0);
  assert.equal((await h.call(machine, "GET", "/v1/readers")).status, 403);
  // Any device may ask which devices are on the roster.
  const stranger = createChatEventDeviceIdentity(new Date().toISOString());
  const known = await h.call(machine, "GET", `/v1/devices/known?ids=${h.owner.originId},${stranger.originId}`);
  assert.deepEqual(known.body.known, [h.owner.originId]);
});

test("closing the hub ends connections that are still open at once", async (t) => {
  const h = await hub(t);
  const net = await import("node:net");
  const port = Number(new URL(h.base).port);
  // A request whose body never finishes, as a stalled phone would leave one.
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(`POST /v1/events HTTP/1.1\r\nHost: x\r\nAuthorization: ${signHubRequest(h.owner, { method: "POST", pathWithQuery: "/v1/events", body: "{}" })}\r\nContent-Length: 1000\r\n\r\n{`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = Date.now();
  await h.server.close();
  assert.ok(Date.now() - started < 2_000, `closed in ${Date.now() - started} ms`);
  socket.destroy();
});
