// A phone paired with the User's own server reads its chats from the
// server: the chat list, a chat's page and the news of what changed, within
// what its invite allowed. The server runs in this process on plain HTTP.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const dist = path.resolve(import.meta.dirname, "../dist/main");
const { StorageService } = await import(path.join(dist, "main/services/storage.js"));
const { ChatSearchService } = await import(path.join(dist, "main/services/chatSearch.js"));
const { HubServer } = await import(path.join(dist, "hub/hubServer.js"));
const { HubChangeFeed, HubPhoneApi } = await import(path.join(dist, "hub/hubPhone.js"));
const { HubProgress } = await import(path.join(dist, "hub/hubPhoneState.js"));
const { createDeviceIdentity } = await import(path.join(dist, "main/services/deviceIdentity.js"));
const { signHubRequest, signHubText, sha256Hex } = await import(path.join(dist, "main/services/hubAuth.js"));
const { hubPhoneInviteSigningText, hubPhoneEnrollmentSigningText } = await import(path.join(dist, "shared/hubProtocol.js"));

const HUB_ID = "hub-phone-http-test";

/** The server as src/hub/main.ts composes it for a phone: its store and
 *  the phone's views over it. */
async function startHub({ owner, machines = [] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-phone-http-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  if (owner) await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  if (machines.length) await storage.hub().replaceRoster(machines.map((device, index) => ({ deviceId: device.originId, publicKeyDerBase64: device.publicKeyDerBase64, role: "machine", name: `Machine ${index}`, machineId: `m-${index}`, addedAt: "" })), new Date().toISOString());
  const feed = new HubChangeFeed();
  const server = new HubServer({
    hubId: HUB_ID, version: "test", storage, search: new ChatSearchService(storage), vapidPublicKey: "B",
    phone: new HubPhoneApi({
      store: storage, feed, progress: new HubProgress(),
      machineNames: async () => new Map((await storage.hub().devices()).filter((device) => device.machineId).map((device) => [device.machineId, device.name]))
    })
  });
  const http = await server.listenHttp(0, "127.0.0.1");
  const open = await server.listenHttp(0, "127.0.0.1", { openOnly: true });
  return {
    baseUrl: `http://127.0.0.1:${http.address().port}`,
    openUrl: `http://127.0.0.1:${open.address().port}`,
    storage,
    feed,
    close: async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

test("the server's health answers on the open port; a phone's reads never travel over plain HTTP there", async () => {
  const owner = createDeviceIdentity();
  const hub = await startHub({ owner });
  try {
    const health = await (await fetch(`${hub.openUrl}/v1/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.hubId, HUB_ID);
    const { phone } = await enrollPhone(hub, owner, { scope: "device" });
    assert.equal((await phoneGet(hub, phone, "/v1/phone/chats")).status, 200, "on the TLS side the phone reads");
    assert.equal((await phoneGet({ baseUrl: hub.openUrl }, phone, "/v1/phone/chats")).status, 403, "never on the open port");
  } finally {
    await hub.close();
  }
});

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

function inTenMinutes() {
  return new Date(Date.now() + 10 * 60_000).toISOString();
}

/** A phone paired the way the desktop pairs one now: the owner signs a
 *  one-time invite, the phone shows its token and signs its acceptance. */
async function enrollPhone(hub, owner, scope) {
  const phone = createDeviceIdentity();
  const token = randomBytes(32).toString("base64url");
  const invite = { version: 1, inviteId: `invite-${randomBytes(8).toString("hex")}`, hubId: HUB_ID, issuerDeviceId: owner.originId,
    tokenHash: sha256Hex(token), scope, name: "Phone", issuedAt: new Date().toISOString(), expiresAt: inTenMinutes() };
  const inviteBody = JSON.stringify({ invite, signature: signHubText(owner, hubPhoneInviteSigningText(invite)) });
  const put = await fetch(`${hub.baseUrl}/v1/phone-invites`, { method: "PUT", body: inviteBody,
    headers: { "content-type": "application/json", authorization: signHubRequest(owner, { method: "PUT", pathWithQuery: "/v1/phone-invites", body: inviteBody }) } });
  assert.equal(put.status, 200, await put.clone().text());
  const enrollment = { version: 1, hubId: HUB_ID, tokenHash: invite.tokenHash, deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, name: "iPhone", enrolledAt: new Date().toISOString() };
  const enrolled = await fetch(`${hub.baseUrl}/v1/phone/enroll`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, enrollment, signature: signHubText(phone, hubPhoneEnrollmentSigningText(enrollment)) }) });
  assert.equal(enrolled.status, 200, await enrolled.clone().text());
  return { phone, invite, token, enrollment, answer: await enrolled.json() };
}

function phoneGet(hub, phone, pathname, query = {}, headers = {}) {
  const url = new URL(pathname, hub.baseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const pathWithQuery = `${url.pathname}${url.search}`;
  return fetch(url, { headers: { authorization: signHubRequest(phone, { method: "GET", pathWithQuery }), ...headers } });
}

test("a paired phone reads the chat list and a chat's page from the server, within what its invite allowed", async () => {
  const owner = createDeviceIdentity();
  const machine = createDeviceIdentity();
  const hub = await startHub({ owner, machines: [machine] });
  try {
    await hub.storage.saveConversation(chatFixture("chat-a", { title: "Alpha", messages: [
      messageFixture("a1", "user", "@nora hello from the phone"),
      messageFixture("a2", "participant", "Hi! Here is the answer.")
    ] }));
    await hub.storage.saveConversation(chatFixture("chat-b", { title: "Beta", messages: [messageFixture("b1", "user", "second chat")] }));
    await hub.storage.saveConversation(chatFixture("chat-old", { title: "Old", archived: true, messages: [messageFixture("o1", "user", "archived")] }));
    const { phone } = await enrollPhone(hub, owner, { scope: "device" });
    const { phone: invited } = await enrollPhone(hub, owner, { scope: "device" });

    let answer = await phoneGet(hub, phone, "/v1/phone/chats");
    assert.equal(answer.status, 200, await answer.clone().text());
    let body = await answer.json();
    assert.equal(body.type, "mobile.chat-list");
    assert.deepEqual(body.chats.map((chat) => chat.title).sort(), ["Alpha", "Beta"], "every chat but the archived one");
    const alpha = body.chats.find((chat) => chat.id === "chat-a");
    assert.equal(alpha.snippet, "Hi! Here is the answer.");
    assert.equal(alpha.who, "nora:");
    assert.equal(alpha.members[0].roleLabel, "Software Engineer");
    assert.equal(alpha.members[0].roleConfigId, "software-engineer", "what the phone resolves a draft's member by");
    assert.equal(alpha.members[0].homeMachineName, "Machine 0", "a machine's name from the server's roster");
    assert.deepEqual(alpha.pendingCards, [], "the server holds every card now, so it names them all (none here)");

    answer = await phoneGet(hub, phone, "/v1/phone/timeline", { conversationId: "chat-a" });
    body = await answer.json();
    assert.equal(body.type, "mobile.timeline.events");
    assert.deepEqual(body.events.map((event) => event.content), ["@nora hello from the phone", "Hi! Here is the answer."]);
    assert.equal(body.events[1].participantId, "p1", "the member that spoke, for the phone's own routing");
    assert.equal(body.page.hasMoreBefore, false);
    assert.deepEqual(body.cards, []);
    answer = await phoneGet(hub, phone, "/v1/phone/timeline", { conversationId: "chat-old" });
    assert.equal(answer.status, 404, "an archived chat stays hidden");
    assert.equal((await answer.json()).error, "chat_not_found", "said as one chat missing, not as no server");

    // A phone is paired for every chat: a one-chat invite, or a roster that
    // names a one-chat phone, is refused (the order has no per-chat fences).
    const oneChat = { version: 1, inviteId: "invite-one-chat-1", hubId: HUB_ID, issuerDeviceId: owner.originId,
      tokenHash: sha256Hex("y".repeat(43)), scope: { scope: "conversation", conversationId: "chat-b" }, name: "Phone", issuedAt: new Date().toISOString(), expiresAt: inTenMinutes() };
    const oneChatText = JSON.stringify({ invite: oneChat, signature: signHubText(owner, hubPhoneInviteSigningText(oneChat)) });
    assert.equal((await fetch(`${hub.baseUrl}/v1/phone-invites`, { method: "PUT", body: oneChatText,
      headers: { "content-type": "application/json", authorization: signHubRequest(owner, { method: "PUT", pathWithQuery: "/v1/phone-invites", body: oneChatText }) } })).status, 400);

    // Only a phone reads the phone's views, and only signed.
    assert.equal((await phoneGet(hub, machine, "/v1/phone/chats")).status, 403, "a machine is not a phone");
    assert.equal((await fetch(`${hub.baseUrl}/v1/phone/chats`)).status, 401, "unsigned");
    assert.equal((await phoneGet(hub, createDeviceIdentity(), "/v1/phone/chats")).status, 401, "not on the roster");

    // The owner's roster decides once it has settled the invite: listed, the
    // phone stays; settled and left out, it is gone at once.
    const putRoster = (devices, resolvedInviteIds) => {
      const text = JSON.stringify({ devices, resolvedInviteIds });
      return fetch(`${hub.baseUrl}/v1/roster`, { method: "PUT", body: text,
        headers: { "content-type": "application/json", authorization: signHubRequest(owner, { method: "PUT", pathWithQuery: "/v1/roster", body: text }) } });
    };
    const desktop = { deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, role: "desktop", name: "Mac" };
    const machineEntry = { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Machine 0", machineId: "m-0" };
    assert.equal((await putRoster([desktop, machineEntry], [])).status, 200);
    assert.equal((await phoneGet(hub, phone, "/v1/phone/chats")).status, 200, "a roster that has not settled its invite does not drop the phone");
    const devices = (await hub.storage.hub().devices());
    const phoneRow = devices.find((device) => device.deviceId === phone.originId);
    assert.equal(phoneRow.role, "phone");
    assert.deepEqual(phoneRow.scope, { scope: "device" });
    assert.equal((await putRoster([desktop, machineEntry], [phoneRow.inviteId])).status, 200);
    assert.equal((await phoneGet(hub, phone, "/v1/phone/chats")).status, 401, "settled and left out: removed");
    assert.equal((await phoneGet(hub, invited, "/v1/phone/chats")).status, 200, "the other phone's invite is not settled");
  } finally {
    await hub.close();
  }
});

test("a pairing code is spent once, by one phone, inside its window; the same phone asking again is told again", async () => {
  const owner = createDeviceIdentity();
  const machine = createDeviceIdentity();
  const hub = await startHub({ owner, machines: [machine] });
  try {
    const { phone, token, enrollment, answer } = await enrollPhone(hub, owner, { scope: "device" });
    assert.equal(answer.deviceId, phone.originId);
    assert.deepEqual(answer.scope, { scope: "device" });
    assert.equal(answer.certificate.token, token);
    // The same phone, its answer lost on the way, asks again: the same answer.
    const again = await fetch(`${hub.baseUrl}/v1/phone/enroll`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, enrollment: { ...enrollment, enrolledAt: new Date().toISOString() }, signature: signHubText(phone, hubPhoneEnrollmentSigningText({ ...enrollment, enrolledAt: new Date().toISOString() })) }) });
    assert.equal(again.status, 200);
    assert.deepEqual((await again.json()).certificate, answer.certificate, "the certificate it was given first");
    // Another key with the same code: refused.
    const thief = createDeviceIdentity();
    const stolen = { ...enrollment, deviceId: thief.originId, publicKeyDerBase64: thief.publicKeyDerBase64 };
    const refused = await fetch(`${hub.baseUrl}/v1/phone/enroll`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, enrollment: stolen, signature: signHubText(thief, hubPhoneEnrollmentSigningText(stolen)) }) });
    assert.equal(refused.status, 410);
    // A signature over another key, or a token the hub never issued: refused.
    const forged = await fetch(`${hub.baseUrl}/v1/phone/enroll`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, enrollment: stolen, signature: signHubText(phone, hubPhoneEnrollmentSigningText(stolen)) }) });
    assert.equal(forged.status, 400);
    const unknownToken = randomBytes(32).toString("base64url");
    const unknown = { ...enrollment, tokenHash: sha256Hex(unknownToken), deviceId: thief.originId, publicKeyDerBase64: thief.publicKeyDerBase64 };
    const nobody = await fetch(`${hub.baseUrl}/v1/phone/enroll`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: unknownToken, enrollment: unknown, signature: signHubText(thief, hubPhoneEnrollmentSigningText(unknown)) }) });
    assert.equal(nobody.status, 410);
    // Only the owner invites, with its own signature.
    const invite = { version: 1, inviteId: "invite-by-machine-1", hubId: HUB_ID, issuerDeviceId: machine.originId,
      tokenHash: sha256Hex("x".repeat(43)), scope: { scope: "device" }, name: "Phone", issuedAt: new Date().toISOString(), expiresAt: inTenMinutes() };
    const text = JSON.stringify({ invite, signature: signHubText(machine, hubPhoneInviteSigningText(invite)) });
    const byMachine = await fetch(`${hub.baseUrl}/v1/phone-invites`, { method: "PUT", body: text,
      headers: { "content-type": "application/json", authorization: signHubRequest(machine, { method: "PUT", pathWithQuery: "/v1/phone-invites", body: text }) } });
    assert.equal(byMachine.status, 403);
  } finally {
    await hub.close();
  }
});

test("a phone waiting for news is answered when a chat's copy changes", async () => {
  const owner = createDeviceIdentity();
  const hub = await startHub({ owner });
  try {
    for (let index = 0; index < 60; index += 1) {
      await hub.storage.saveConversation(chatFixture(`chat-${index}`, { title: `Chat ${index} ${"x".repeat(200)}`, messages: [messageFixture(`m-${index}`, "user", "y".repeat(300))] }));
    }
    const { phone } = await enrollPhone(hub, owner, { scope: "device" });
    // A position from no instance (or another one) is a reset.
    let body = await (await phoneGet(hub, phone, "/v1/phone/changes", { instance: "none", after: 0 })).json();
    assert.equal(body.reset, true);
    const { instance } = body;
    let seq = body.seq;
    const started = Date.now();
    const waiting = phoneGet(hub, phone, "/v1/phone/changes", { instance, after: seq, waitMs: 5000 });
    await delay(300);
    hub.feed.note("chat-7");
    body = await (await waiting).json();
    assert.ok(Date.now() - started < 3000, "answered when the change came, not at the end of the wait");
    assert.deepEqual(body.conversationIds, ["chat-7"]);
    assert.equal(body.reset, undefined);
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
