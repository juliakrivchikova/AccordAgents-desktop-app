import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatSearchService } from "../main/services/chatSearch";
import { createDeviceIdentity } from "../main/services/deviceIdentity";
import { signHubRequest, type HubSigningIdentity } from "../main/services/hubAuth";
import { StorageService } from "../main/services/storage";
import { hubTurnRunId, type HubChatPage, type HubFeedResponse, type HubOp, type HubOpsResponse } from "../shared/hubOps";
import type { ChatMessage } from "../shared/types";
import { HubOps } from "./hubOps";
import { HubServer } from "./hubServer";

type Identity = ReturnType<typeof createDeviceIdentity>;

async function hub(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-ops-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const now = () => new Date().toISOString();
  const owner = createDeviceIdentity(now());
  const phone = createDeviceIdentity(now());
  const machine = createDeviceIdentity(now());
  await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Desktop", addedAt: now() });
  const logged: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const log = (event: string, payload: Record<string, unknown>) => { logged.push({ event, payload }); };
  const ops = new HubOps(storage, log);
  const server = new HubServer({
    hubId: "hub-test", version: "test", storage, search: new ChatSearchService(storage), vapidPublicKey: "BPUB",
    ops, debugLog: log
  });
  const http = await server.listenHttp(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async <T = Record<string, unknown>>(identity: HubSigningIdentity, method: string, pathWithQuery: string, body?: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${base}${pathWithQuery}`, {
      method,
      headers: { authorization: signHubRequest(identity, { method, pathWithQuery, body: text }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: text })
    });
    return { status: response.status, body: await response.json() as T };
  };
  const roster = await call(owner, "PUT", "/v1/roster", { devices: [
    { deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "Phone", scope: { scope: "device" } },
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Box", machineId: "machine-1" }
  ] });
  assert.equal(roster.status, 200);
  const write = (identity: Identity, ...list: HubOp[]) => call<HubOpsResponse>(identity, "POST", "/v3/ops", { ops: list });
  return { storage, ops, owner, phone, machine, call, write, logged };
}

let counter = 0;
const id = (prefix: string) => `${prefix}-${++counter}`;

const members = [
  { id: "p-desk", handle: "desk", label: "Desk" },
  { id: "p-box", handle: "box", label: "Box", homeMachineId: "machine-1" }
];

function createChat(conversationId: string, title = "Plans"): HubOp {
  return { opId: id("op"), kind: "conversation.create", conversationId,
    conversation: { title, kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: members, warnings: ["local"] } } };
}

function userMessage(messageId: string, content: string, targets: string[] = []): ChatMessage {
  return { id: messageId, role: "user", content, createdAt: new Date().toISOString(), ...(targets.length ? { metadata: { deliveryTargets: targets } } : {}) } as ChatMessage;
}

function reply(messageId: string, participantId: string, status: ChatMessage["status"], content = ""): ChatMessage {
  return { id: messageId, role: "participant", participantId, content, status, createdAt: new Date().toISOString() } as ChatMessage;
}

test("a write is accepted once, with its place; the same id again is a duplicate with the same place", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  const created = await h.write(h.owner, createChat(chat));
  assert.equal(created.status, 200);
  assert.equal(created.body.results[0].status, "accepted");
  const send: HubOp = { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage("m1", "hello") };
  const first = await h.write(h.phone, send);
  const again = await h.write(h.phone, send);
  assert.equal(first.body.results[0].status, "accepted");
  assert.equal(again.body.results[0].status, "duplicate");
  assert.equal((again.body.results[0] as { seq: number }).seq, (first.body.results[0] as { seq: number }).seq);
  // Another device cannot reuse an id.
  const stolen = await h.write(h.machine, send);
  assert.equal(stolen.body.results[0].status, "rejected");
  const page = await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`);
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.messages.map((message) => message.id), ["m1"], "one message, not two");
  assert.equal(page.body.messages[0].metadata?.serverWriter, h.phone.originId);
  assert.equal(page.body.messages[0].metadata?.serverSeq, (first.body.results[0] as { seq: number }).seq);
  // A device's own bookkeeping never becomes the chat's.
  assert.equal((page.body.conversation.metadata as Record<string, unknown>).warnings, undefined);
});

test("every device may change the chat's own fields; only a member's home writes the member's messages", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  // Д2: the phone renames the chat and archives it, like the computer could.
  const rename = await h.write(h.phone, { opId: id("op"), kind: "conversation.update", conversationId: chat, title: "Renamed", metadata: { archived: true, running: true } });
  assert.equal(rename.body.results[0].status, "accepted");
  const page = await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`);
  assert.equal(page.body.conversation.title, "Renamed");
  assert.equal(page.body.conversation.metadata.archived, true);
  assert.equal(page.body.conversation.metadata.running, undefined, "only shared keys are taken");

  const byPhone = await h.write(h.phone, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("r-phone", "p-desk", "done", "fake") });
  assert.equal(byPhone.body.results[0].status, "rejected", "a phone does not write a member's reply");
  const byMachineForDesk = await h.write(h.machine, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("r-x", "p-desk", "pending") });
  assert.equal(byMachineForDesk.body.results[0].status, "rejected", "a machine writes only its own members");
  const byMachine = await h.write(h.machine, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("r-box", "p-box", "pending") });
  assert.equal(byMachine.body.results[0].status, "accepted");
  const byOwner = await h.write(h.owner, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("r-desk", "p-desk", "pending") });
  assert.equal(byOwner.body.results[0].status, "accepted");

  // Only the writer changes a message, and never its author.
  const foreign = await h.write(h.owner, { opId: id("op"), kind: "message.update", conversationId: chat, message: reply("r-box", "p-box", "done", "hijack") });
  assert.equal(foreign.body.results[0].status, "rejected");
  const reauthor = await h.write(h.machine, { opId: id("op"), kind: "message.update", conversationId: chat, message: reply("r-box", "p-desk", "done", "x") });
  assert.equal(reauthor.body.results[0].status, "rejected");
  const own = await h.write(h.machine, { opId: id("op"), kind: "message.update", conversationId: chat, message: reply("r-box", "p-box", "done", "answer") });
  assert.equal(own.body.results[0].status, "accepted");

  // Rejections are logged with their reason (Д12).
  assert.ok(h.logged.some((item) => item.event === "hub.op.rejected" && String(item.payload.reason).includes("Only the device this member runs on")));
});

test("reactions come from anyone and survive the writer's update; a removed message never comes back", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  await h.write(h.machine, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("r1", "p-box", "pending") });
  const react = await h.write(h.phone, { opId: id("op"), kind: "message.react", conversationId: chat, messageId: "r1",
    added: [{ emoji: "🔥", reactor: { actorId: "user", kind: "user", label: "You" } as never }], removed: [] });
  assert.equal(react.body.results[0].status, "accepted");
  await h.write(h.machine, { opId: id("op"), kind: "message.update", conversationId: chat, message: { ...reply("r1", "p-box", "done", "ok"), metadata: { reactions: {} } } as ChatMessage });
  let page = await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`);
  assert.equal(page.body.messages[0].metadata?.reactions?.["🔥"]?.length, 1, "the writer's update does not drop reactions");
  const removed = await h.write(h.phone, { opId: id("op"), kind: "message.remove", conversationId: chat, messageId: "r1" });
  assert.equal(removed.body.results[0].status, "accepted");
  const back = await h.write(h.machine, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("r1", "p-box", "done", "again") });
  assert.equal(back.body.results[0].status, "rejected");
  page = await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`);
  assert.deepEqual(page.body.messages, []);
});

test("a turn is taken once, only where its member runs; a Stop before that keeps it from starting", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  await h.write(h.phone, { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage("u1", "@box @desk go", ["p-box", "p-desk"]) });
  const boxRun = hubTurnRunId("u1", "p-box");
  const deskRun = hubTurnRunId("u1", "p-desk");
  const claim = (identity: Identity, runId: string, participantId: string) =>
    h.write(identity, { opId: id("op"), kind: "turn.claim", conversationId: chat, runId, messageId: "u1", participantId });

  const wrongHome = await claim(h.owner, boxRun, "p-box");
  assert.equal(wrongHome.body.results[0].status, "rejected", "the computer cannot take the machine's member");
  const taken = await claim(h.machine, boxRun, "p-box");
  assert.equal(taken.body.results[0].status, "accepted");
  assert.equal((taken.body.results[0] as { claim?: string }).claim, "claimed");
  const repeat = await claim(h.machine, boxRun, "p-box");
  assert.equal((repeat.body.results[0] as { claim?: string }).claim, "already-yours", "a restarted machine finds its own turn");

  // Stop before the computer took its turn: nobody ever takes it.
  const stop = await h.write(h.phone, { opId: id("op"), kind: "turn.stop", conversationId: chat, runId: deskRun, messageId: "u1", participantId: "p-desk" });
  assert.equal(stop.body.results[0].status, "accepted");
  const late = await claim(h.owner, deskRun, "p-desk");
  assert.equal((late.body.results[0] as { claim?: string }).claim, "stopped");

  // Stop while taken: the executor is asked to stop, then finishes it.
  const stopBox = await h.write(h.phone, { opId: id("op"), kind: "turn.stop", conversationId: chat, runId: boxRun, messageId: "u1", participantId: "p-box" });
  assert.ok((stopBox.body.results[0] as { turn?: { stopRequestedAt?: string } }).turn?.stopRequestedAt);
  const notYours = await h.write(h.owner, { opId: id("op"), kind: "turn.finish", conversationId: chat, runId: boxRun, outcome: "done" });
  assert.equal(notYours.body.results[0].status, "rejected");
  const finished = await h.write(h.machine, { opId: id("op"), kind: "turn.finish", conversationId: chat, runId: boxRun, outcome: "stopped" });
  assert.equal(finished.body.results[0].status, "accepted");

  const page = await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`);
  const turns = new Map(page.body.turns.map((turn) => [turn.runId, turn]));
  assert.equal(turns.get(boxRun)?.state, "finished");
  assert.equal(turns.get(boxRun)?.executorDeviceId, h.machine.originId);
  assert.equal(turns.get(deskRun)?.state, "stopped");
  assert.equal(turns.get(deskRun)?.executorDeviceId, undefined);
});

test("the feed gives every device the same order, waits for news, and says when it was forgotten", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const start = (await h.call<HubFeedResponse>(h.machine, "GET", "/v3/feed?after=0")).body;
  assert.equal(start.entries.length, 1);
  // Two devices write at once: one order, the same for everybody.
  await Promise.all([
    h.write(h.phone, { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage("a", "from phone") }),
    h.write(h.owner, { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage("b", "from desktop") })
  ]);
  const forMachine = (await h.call<HubFeedResponse>(h.machine, "GET", "/v3/feed?after=0")).body;
  const forPhone = (await h.call<HubFeedResponse>(h.phone, "GET", "/v3/feed?after=0")).body;
  assert.deepEqual(forMachine.entries.map((entry) => entry.seq), forPhone.entries.map((entry) => entry.seq));
  const page = (await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`)).body;
  const order = forMachine.entries.filter((entry) => entry.effect.kind === "message.create").map((entry) => (entry.effect as { message: ChatMessage }).message.id);
  assert.deepEqual(page.messages.map((message) => message.id), order, "the chat shows the server's order");

  // A wait ends as soon as something is accepted.
  const head = forMachine.head;
  const waiting = h.call<HubFeedResponse>(h.machine, "GET", `/v3/feed?after=${head}&waitMs=20000`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const startedAt = Date.now();
  await h.write(h.phone, { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage("c", "late") });
  const woken = (await waiting).body;
  assert.ok(Date.now() - startedAt < 5_000);
  assert.equal(woken.entries.length, 1);

  // Forgotten: the device reads its chats again.
  await h.storage.hubOps().execute(`insert into hub_ops_state(key, value) values ('pruned-through', '2') on conflict(key) do update set value = excluded.value;`);
  const gone = await h.call<{ gone?: boolean }>(h.machine, "GET", "/v3/feed?after=1");
  assert.equal(gone.status, 410);
  assert.equal(gone.body.gone, true);
});

test("a deleted chat is gone for everyone: later writes are refused and the feed says so", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const deleted = await h.write(h.phone, { opId: id("op"), kind: "conversation.delete", conversationId: chat });
  assert.equal(deleted.body.results[0].status, "accepted");
  const after = await h.write(h.owner, { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage("x", "too late") });
  assert.equal(after.body.results[0].status, "rejected");
  const feed = (await h.call<HubFeedResponse>(h.owner, "GET", "/v3/feed?after=0")).body;
  assert.equal(feed.entries.at(-1)?.effect.kind, "conversation.delete");
  assert.equal((await h.call(h.owner, "GET", `/v3/chat?conversationId=${chat}`)).status, 404);
});

test("a malformed operation is refused with its reason and logged, not stored", async (t) => {
  const h = await hub(t);
  const bad = await h.call<HubOpsResponse>(h.phone, "POST", "/v3/ops", { ops: [{ opId: "x1", kind: "message.create", conversationId: "../etc", message: {} }] });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.results[0].status, "rejected");
  assert.ok(h.logged.some((item) => item.event === "hub.op.rejected" && item.payload.opId === "x1"));
  const empty = await h.call(h.phone, "POST", "/v3/ops", { ops: [] });
  assert.equal(empty.status, 400);
  assert.ok(h.logged.some((item) => item.event === "hub.request" && item.payload.status === 400 && typeof item.payload.reason === "string"));
  assert.equal((await h.call<HubFeedResponse>(h.owner, "GET", "/v3/feed?after=0")).body.entries.length, 0);
});

test("the feed is kept until every computer and machine read it; a phone never holds it back", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  await h.write(h.phone, { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage("m1", "one") });
  const { HubRetention } = await import("./hubRetention");
  const later = Date.now() + 30 * 24 * 60 * 60_000;
  const retention = new HubRetention({ storage: h.storage, now: () => later });
  // The machine never read: nothing goes.
  await h.call(h.owner, "GET", "/v3/feed?after=2");
  let report = await retention.runOnce();
  assert.equal(report.ops.events, 0);
  // Both read past it (the phone never did): the feed forgets it.
  await h.call(h.machine, "GET", "/v3/feed?after=2");
  report = await retention.runOnce();
  assert.equal(report.ops.events, 2);
  assert.equal((await h.call(h.phone, "GET", "/v3/feed?after=0")).status, 410, "a reader behind it reads the chats again");
  assert.equal((await h.call<HubChatPage>(h.phone, "GET", `/v3/chat?conversationId=${chat}`)).body.messages.length, 1, "the chat itself stays");
});

test("without a server of her own, the same server runs inside the app on this computer only", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-embedded-hub-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const owner = createDeviceIdentity(new Date().toISOString());
  const { startEmbeddedHub } = await import("./embeddedHub");
  const start = () => startEmbeddedHub({ dataDir: dir, owner: { deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64 }, version: "test", log: () => undefined });
  const first = await start();
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const send = async (url: string, body: unknown) => {
    const text = JSON.stringify(body);
    const response = await fetch(`${url}/v3/ops`, { method: "POST", headers: { authorization: signHubRequest(owner, { method: "POST", pathWithQuery: "/v3/ops", body: text }), "content-type": "application/json" }, body: text });
    return await response.json() as HubOpsResponse;
  };
  const chat = id("chat");
  assert.equal((await send(first.url, { ops: [createChat(chat)] })).results[0].status, "accepted");
  await first.close();
  // Started again: the same server, the same chats.
  const second = await start();
  assert.equal(second.hubId, first.hubId);
  const pathWithQuery = `/v3/chat?conversationId=${chat}`;
  const page = await fetch(`${second.url}${pathWithQuery}`, { headers: { authorization: signHubRequest(owner, { method: "GET", pathWithQuery }) } });
  assert.equal(page.status, 200);
  await second.close();
  // Another identity cannot take it over.
  const stranger = createDeviceIdentity(new Date().toISOString());
  await assert.rejects(startEmbeddedHub({ dataDir: dir, owner: { deviceId: stranger.originId, publicKeyDerBase64: stranger.publicKeyDerBase64 }, version: "test", log: () => undefined }));
});

test("a User's message asks a turn of each member it names; the member's own device finds it after a restart", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const sent = await h.write(h.phone, { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage("u1", "@box @desk hi", ["p-box", "p-desk", "p-gone"]) });
  assert.equal(sent.body.results[0].status, "accepted");
  const feed = (await h.call<HubFeedResponse>(h.machine, "GET", "/v3/feed?after=0")).body;
  const created = feed.entries.find((entry) => entry.effect.kind === "message.create")?.effect as { turns?: Array<{ runId: string; state: string }> };
  assert.deepEqual(created.turns?.map((turn) => [turn.runId, turn.state]).sort(), [
    [hubTurnRunId("u1", "p-box"), "requested"], [hubTurnRunId("u1", "p-desk"), "requested"]
  ], "a member not in the chat asks nothing");
  // Each device sees only its own members' waiting work.
  const machineWork = (await h.call<{ turns: Array<{ runId: string }> }>(h.machine, "GET", "/v3/turns")).body.turns.map((turn) => turn.runId);
  const ownerWork = (await h.call<{ turns: Array<{ runId: string }> }>(h.owner, "GET", "/v3/turns")).body.turns.map((turn) => turn.runId);
  assert.deepEqual(machineWork, [hubTurnRunId("u1", "p-box")]);
  assert.deepEqual(ownerWork, [hubTurnRunId("u1", "p-desk")]);
  // Taken: no longer waiting.
  await h.write(h.machine, { opId: id("op"), kind: "turn.claim", conversationId: chat, runId: hubTurnRunId("u1", "p-box"), messageId: "u1", participantId: "p-box" });
  assert.deepEqual((await h.call<{ turns: unknown[] }>(h.machine, "GET", "/v3/turns")).body.turns, []);
});

test("any device asks a turn of a member elsewhere, naming the bubble it will take; its home takes it", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  await h.write(h.owner, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("r-desk", "p-desk", "done", "@box please check") });
  const runId = `turn-${id("x")}`;
  const asked = await h.write(h.owner, { opId: id("op"), kind: "turn.request", conversationId: chat, runId, messageId: "r-desk", participantId: "p-box",
    pendingMessageId: "bubble-1", request: { kind: "turn", continuation: false } });
  assert.equal(asked.body.results[0].status, "accepted");
  const claimed = await h.write(h.machine, { opId: id("op"), kind: "turn.claim", conversationId: chat, runId, messageId: "r-desk", participantId: "p-box" });
  const turn = (claimed.body.results[0] as { turn?: { pendingMessageId?: string; request?: Record<string, unknown>; requestedBy?: string } }).turn;
  assert.equal(turn?.pendingMessageId, "bubble-1");
  assert.deepEqual(turn?.request, { kind: "turn", continuation: false });
  assert.equal(turn?.requestedBy, h.owner.originId);
  // The machine writes the bubble under the id it was given.
  const bubble = await h.write(h.machine, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("bubble-1", "p-box", "pending") });
  assert.equal(bubble.body.results[0].status, "accepted");
  // A Stop on an asked-for turn nobody took keeps it from ever starting.
  const other = `turn-${id("x")}`;
  await h.write(h.owner, { opId: id("op"), kind: "turn.request", conversationId: chat, runId: other, messageId: "r-desk", participantId: "p-box" });
  await h.write(h.phone, { opId: id("op"), kind: "turn.stop", conversationId: chat, runId: other, messageId: "r-desk", participantId: "p-box" });
  const late = await h.write(h.machine, { opId: id("op"), kind: "turn.claim", conversationId: chat, runId: other, messageId: "r-desk", participantId: "p-box" });
  assert.equal((late.body.results[0] as { claim?: string }).claim, "stopped");
});

test("the computer moves its chats to the server once: its order wins, and messages only the server had keep their place", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  const t0 = Date.parse("2026-10-01T10:00:00Z");
  const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
  // The server already has the chat with one phone message (its old copy).
  await h.write(h.owner, createChat(chat, "Old"));
  await h.write(h.phone, { opId: id("op"), kind: "message.create", conversationId: chat, message: { ...userMessage("from-phone", "phone"), createdAt: at(2) } as ChatMessage });
  const fields = { title: "Moved", kind: "chat" as const, createdAt: at(0), metadata: { participants: members } };
  const page1 = [{ ...userMessage("a", "first"), createdAt: at(1) }, { ...reply("b", "p-box", "done", "box says"), createdAt: at(3) }] as ChatMessage[];
  const page2 = [{ ...userMessage("c", "third"), createdAt: at(4) }] as ChatMessage[];
  const byMachine = await h.write(h.machine, { opId: id("op"), kind: "chat.import", conversationId: chat, conversation: fields, messages: page1 });
  assert.equal(byMachine.body.results[0].status, "rejected", "only the computer that held the chats moves them");
  assert.equal((await h.write(h.owner, { opId: id("op"), kind: "chat.import", conversationId: chat, conversation: fields, messages: page1 })).body.results[0].status, "accepted");
  assert.equal((await h.write(h.owner, { opId: id("op"), kind: "chat.import", conversationId: chat, messages: page2, order: ["a", "b", "c"] })).body.results[0].status, "accepted");
  const page = (await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`)).body;
  assert.equal(page.conversation.title, "Moved");
  assert.deepEqual(page.messages.map((message) => message.id), ["a", "from-phone", "b", "c"]);
  // The box member's message is the machine's to change from now on.
  assert.equal(page.messages.find((message) => message.id === "b")?.metadata?.serverWriter, h.machine.originId);
  const update = await h.write(h.machine, { opId: id("op"), kind: "message.update", conversationId: chat, message: { ...reply("b", "p-box", "done", "edited"), createdAt: at(3) } as ChatMessage });
  assert.equal(update.body.results[0].status, "accepted");
  // New messages come after everything moved.
  await h.write(h.phone, { opId: id("op"), kind: "message.create", conversationId: chat, message: { ...userMessage("d", "new"), createdAt: at(0) } as ChatMessage });
  const after = (await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`)).body;
  assert.deepEqual(after.messages.map((message) => message.id), ["a", "from-phone", "b", "c", "d"]);
});

test("a card is raised by the member's device, answered once from any device, and settled by the device that raised it", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const card = { approval: { id: "ap-1", tool: "app_chat_request_participants" } };
  const byPhone = await h.write(h.phone, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-1", cardKind: "permission", participantId: "p-box", card });
  assert.equal(byPhone.body.results[0].status, "rejected", "only the member's device raises it");
  const raised = await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-1", cardKind: "permission", participantId: "p-box", card });
  assert.equal(raised.body.results[0].status, "accepted");
  const open = await h.call<{ cards: Array<{ cardId: string; state: string }> }>(h.phone, "GET", `/v3/cards?conversationId=${chat}`);
  assert.deepEqual(open.body.cards.map((item) => [item.cardId, item.state]), [["card-1", "pending"]]);
  const answered = await h.write(h.phone, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-1", answer: { approve: true } });
  assert.equal(answered.body.results[0].status, "accepted");
  const second = await h.write(h.owner, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-1", answer: { approve: false } });
  assert.equal(second.body.results[0].status, "rejected", "the first answer is the one");
  const notRaiser = await h.write(h.owner, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-1", outcome: { applied: true } });
  assert.equal(notRaiser.body.results[0].status, "rejected");
  // Raised again while answered: the answer stands, nothing changes.
  const whileAnswered = await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-1", cardKind: "permission", participantId: "p-box", card: { approval: { id: "ap-1", changed: true } } });
  assert.equal(whileAnswered.body.results[0].status, "accepted");
  assert.equal((whileAnswered.body.results[0] as { card?: { state: string; answer?: unknown } }).card?.state, "answered");
  const settled = await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-1", outcome: { applied: true } });
  assert.equal(settled.body.results[0].status, "accepted");
  assert.deepEqual((await h.call<{ cards: unknown[] }>(h.phone, "GET", `/v3/cards?conversationId=${chat}`)).body.cards, []);
  const feed = (await h.call<HubFeedResponse>(h.owner, "GET", "/v3/feed?after=0")).body;
  assert.deepEqual(feed.entries.filter((entry) => entry.effect.kind.startsWith("card.")).map((entry) => entry.effect.kind), ["card.raise", "card.answer", "card.settle"]);
});

test("a card always names its member: one naming nobody, someone not in the chat, or a member of another device is refused, and it keeps its member", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const card = { approval: { id: "ap-3" } };
  const raise = (who: typeof h.owner, extra: Record<string, unknown>) =>
    h.write(who, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-3", cardKind: "permission", card, ...extra } as unknown as HubOp);
  const nobody = await raise(h.machine, {});
  assert.equal(nobody.body.results[0].status, "rejected", "a card without its member");
  assert.match((nobody.body.results[0] as { reason: string }).reason, /names its member/);
  assert.equal((await raise(h.machine, { participantId: "p-gone" })).body.results[0].status, "rejected", "not a member of the chat");
  // The computer holds a copy of the machine member's card: never its to raise.
  assert.equal((await raise(h.owner, { participantId: "p-box" })).body.results[0].status, "rejected");
  // Nor the machine the computer's member's.
  assert.equal((await raise(h.machine, { participantId: "p-desk" })).body.results[0].status, "rejected");
  assert.equal((await raise(h.machine, { participantId: "p-box" })).body.results[0].status, "accepted");
  const choice = await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "choice:m-1", cardKind: "choice", participantId: "p-box",
    card: { choice: { id: "c-1" } } } as unknown as HubOp);
  assert.equal(choice.body.results[0].status, "rejected", "a choice names the message that asked it");
  const owner = await h.write(h.owner, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-desk", cardKind: "permission", participantId: "p-desk", card });
  assert.equal(owner.body.results[0].status, "accepted", "the computer raises its own member's card");
  const moved = await h.write(h.owner, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-desk", cardKind: "roster", participantId: "p-desk", card });
  assert.equal(moved.body.results[0].status, "rejected", "a card keeps its kind");
  const open = await h.call<{ cards: Array<{ cardId: string; participantId?: string; raisedBy: string }> }>(h.phone, "GET", `/v3/cards?conversationId=${chat}`);
  assert.deepEqual(open.body.cards.map((item) => [item.cardId, item.participantId]).sort(), [["card-3", "p-box"], ["card-desk", "p-desk"]]);
});

test("the User answers from her computer or phone; a machine only says its own member's policy allowed its own card", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const card = { approval: { id: "ap-4" } };
  await h.write(h.owner, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-desk-4", cardKind: "permission", participantId: "p-desk", card });
  await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-box-4", cardKind: "roster", participantId: "p-box", card });
  const status = (response: { body: HubOpsResponse }) => response.body.results[0].status;
  assert.equal(status(await h.write(h.machine, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-desk-4", answer: { approve: true } })), "rejected",
    "not another device's card");
  assert.equal(status(await h.write(h.machine, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-desk-4", answer: { approve: true, auto: true } })), "rejected");
  assert.equal(status(await h.write(h.machine, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-box-4", answer: { approve: true } })), "rejected",
    "nor its own as the User");
  assert.equal(status(await h.write(h.machine, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-box-4", answer: { approve: true, auto: true } })), "accepted");
  assert.equal(status(await h.write(h.owner, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-desk-4", answer: { approve: true } })), "accepted",
    "the computer answers its own member's card");
});

test("a settle that names an answer settles only that answer; a deleted chat takes its cards with it", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const card = { approval: { id: "ap-5" } };
  const raise = () => h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-5", cardKind: "permission", participantId: "p-box", card });
  await raise();
  const first = id("op");
  await h.write(h.phone, { opId: first, kind: "card.answer", conversationId: chat, cardId: "card-5", answer: { approve: true } });
  // Refused and asked again; the User answers again.
  await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-5", outcome: { result: "refused", answerOpId: first } });
  await raise();
  const stale = await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-5", outcome: { result: "applied", answerOpId: first } });
  assert.equal(stale.body.results[0].status, "rejected", "a settle of the earlier answer never closes the card asked again");
  const second = id("op");
  await h.write(h.owner, { opId: second, kind: "card.answer", conversationId: chat, cardId: "card-5", answer: { approve: true } });
  assert.equal((await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-5", outcome: { result: "refused", answerOpId: first } }))
    .body.results[0].status, "rejected");
  assert.equal((await h.storage.hubOps().card("card-5"))?.state, "answered", "the newer answer stands");
  assert.equal((await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-5", outcome: { result: "applied", answerOpId: second } }))
    .body.results[0].status, "accepted");
  // Open cards of a chat that is deleted go with it.
  await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-6", cardKind: "permission", participantId: "p-box", card });
  await h.write(h.owner, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "choice:m-6", cardKind: "choice", participantId: "p-desk", messageId: "m-6",
    card: { choice: { id: "c-6" }, sourceMessageId: "m-6" } });
  assert.equal((await h.storage.hubOps().openCards(chat)).length, 2);
  assert.equal((await h.write(h.owner, { opId: id("op"), kind: "conversation.delete", conversationId: chat })).body.results[0].status, "accepted");
  assert.deepEqual(await h.storage.hubOps().openCards(chat), []);
  assert.equal(await h.storage.hubOps().card("card-5"), undefined);
});

test("the phone reads a chat's newest cards first, without the mention approvals it does not show", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  for (const [cardId, cardKind, messageId] of [["old-1", "permission"], ["mention:m-1", "mention", "m-1"], ["new-1", "permission"]] as const) {
    await h.write(h.owner, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId, cardKind, participantId: "p-desk",
      ...(messageId ? { messageId } : {}), card: { approval: { id: cardId } } });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual((await h.storage.hubOps().openCards(chat, 1, { newestFirst: true, exceptKinds: ["mention"] })).map((card) => card.cardId), ["new-1"]);
  assert.deepEqual((await h.storage.hubOps().openCards(chat)).map((card) => card.cardId), ["old-1", "mention:m-1", "new-1"]);
});

test("a server whose cards table predates the answer's operation id keeps its cards and gets the column", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-cards-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "hub.sqlite3");
  execFileSync("sqlite3", [dbPath, `create table hub_cards (card_id text primary key, conversation_id text not null, card_kind text not null,
    participant_id text, message_id text, raised_by text not null, raised_at text not null, card_json text not null,
    state text not null check(state in ('pending', 'answered', 'settled')), answer_json text, answered_by text, answered_at text,
    outcome_json text, settled_at text);
    insert into hub_cards(card_id, conversation_id, card_kind, participant_id, raised_by, raised_at, card_json, state)
      values ('old-card', 'chat-old', 'permission', 'p-box', 'device-box', '2026-10-27T08:00:00.000Z', '{"approval":{"id":"old-card"}}', 'pending');`]);
  const store = new StorageService({ dbPath }).hubOps();
  const card = await store.card("old-card");
  assert.deepEqual([card?.state, card?.participantId, card?.answerOpId], ["pending", "p-box", undefined]);
  await store.execute(store.cardSql({ ...card!, state: "answered", answer: { approve: true }, answeredBy: "device-phone", answeredAt: "2026-10-28T08:00:00.000Z", answerOpId: "op-answer" }));
  assert.equal((await store.card("old-card"))?.answerOpId, "op-answer");
});

test("a card its device could not apply is settled with why, and raised again it is asked again from the start", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const card = { approval: { id: "ap-2" } };
  await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-2", cardKind: "permission", participantId: "p-box", card });
  const answerOp = id("op");
  assert.equal((await h.write(h.phone, { opId: answerOp, kind: "card.answer", conversationId: chat, cardId: "card-2", answer: { approve: true } })).body.results[0].status, "accepted");
  const refused = await h.write(h.machine,
    { opId: id("op"), kind: "card.settle", conversationId: chat, cardId: "card-2", outcome: { result: "refused", reason: "Approved on the desktop.", answerOpId: answerOp } },
    { opId: id("op"), kind: "card.raise", conversationId: chat, cardId: "card-2", cardKind: "permission", participantId: "p-box",
      card: { ...card, refusals: [{ operationId: answerOp, reason: "Approved on the desktop.", at: new Date().toISOString() }] } });
  assert.deepEqual(refused.body.results.map((result) => result.status), ["accepted", "accepted"]);
  const open = await h.call<{ cards: Array<{ cardId: string; state: string; answer?: unknown; answeredBy?: string; outcome?: unknown; card: Record<string, unknown> }> }>(h.phone, "GET", `/v3/cards?conversationId=${chat}`);
  assert.equal(open.body.cards.length, 1);
  assert.equal(open.body.cards[0].state, "pending", "asked again");
  assert.equal(open.body.cards[0].answer, undefined, "the refused answer is gone");
  assert.equal(open.body.cards[0].answeredBy, undefined);
  assert.equal(open.body.cards[0].outcome, undefined);
  assert.ok(Array.isArray(open.body.cards[0].card.refusals), "the card says why the answer was not taken");
  const again = await h.write(h.owner, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId: "card-2", answer: { approve: true } });
  assert.equal(again.body.results[0].status, "accepted", "answered again from another device");
});

// --- documents (artifacts) on the server (Д9) --------------------------------

type ArtifactAnswer = { ok: boolean; value?: Record<string, unknown> & { summary?: { id: string; headVersion: number; approval: { state: string; signedCurrent: string[] } }; version?: { version: number; versionEventId: string; contentHash: string; content: string; signatures: Array<{ signer: string }> }; id?: string; editRevision?: number }; error?: { code: string; message: string; current?: { version: number; content: string }; currentVersion?: number } };

function artifactOp(kind: string, chat: string, actor: string, request: Record<string, unknown>): HubOp {
  return { opId: id("op"), kind, conversationId: chat, actor, request: { conversationId: chat, ...request } } as unknown as HubOp;
}

function answerOf(response: { body: HubOpsResponse }): ArtifactAnswer {
  return (response.body.results[0] as { artifact?: { result?: ArtifactAnswer } }).artifact?.result as ArtifactAnswer;
}

test("documents: a stale revision is refused with the current version, and a signature stays bound to the version it was made on", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const created = answerOf(await h.write(h.owner, artifactOp("artifact.create", chat, "user", { name: "Spec", content: "One", requiredSigners: ["box"], contributors: ["box"] })));
  assert.equal(created.ok, true, JSON.stringify(created));
  const artifactId = created.value!.summary!.id;
  const v1 = created.value!.version!;
  // The machine's member signs v1, bound to its identity and body.
  const signed = await h.write(h.machine, artifactOp("artifact.sign", chat, "box", { artifactId, version: 1, versionEventId: v1.versionEventId, contentHash: v1.contentHash }));
  assert.equal(signed.body.results[0].status, "accepted");
  assert.equal(answerOf(signed).value!.summary === undefined, true, "a signature answers with the summary itself");
  assert.equal((answerOf(signed).value as unknown as { approval: { state: string } }).approval.state, "approved");
  const v2 = answerOf(await h.write(h.owner, artifactOp("artifact.revise", chat, "user", { artifactId, baseVersion: 1, content: "Two" }))).value!;
  assert.equal(v2.summary!.headVersion, 2);
  assert.equal(v2.summary!.approval.state, "unsigned", "a new version starts unsigned");
  // A revision on a base that moved is refused, carrying the current version.
  const stale = await h.write(h.machine, artifactOp("artifact.revise", chat, "box", { artifactId, baseVersion: 1, content: "Late" }));
  assert.equal(stale.body.results[0].status, "rejected");
  assert.equal(answerOf(stale).error?.code, "stale_version");
  assert.equal(answerOf(stale).error?.currentVersion, 2);
  assert.equal(answerOf(stale).error?.current?.content, "Two");
  // A signature naming v1's identity for "the current version" is refused.
  const mismatched = await h.write(h.machine, artifactOp("artifact.sign", chat, "box", { artifactId, versionEventId: v1.versionEventId, contentHash: v1.contentHash }));
  assert.equal(answerOf(mismatched).error?.code, "stale_version");
  // What the server holds: v1 keeps its signature, v2 has none.
  const state = await h.call<{ artifact: { signatures: Array<{ versionEventId: string; signer: string }>; projection: Array<{ version: number; versionEventId: string }> } }>(
    h.machine, "GET", `/v3/artifact?artifactId=${artifactId}`);
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.artifact.signatures.map((row) => [row.signer, row.versionEventId]), [["box", v1.versionEventId]]);
  assert.deepEqual(state.body.artifact.projection.map((row) => row.version), [1, 2]);
  const body = await h.call<{ revision: { content: string; contentHash: string } }>(h.machine, "GET", `/v3/artifact?artifactId=${artifactId}&revision=${v1.versionEventId}`);
  assert.equal(body.body.revision.content, "One");
  assert.equal(body.body.revision.contentHash, v1.contentHash);
  // A document the server does not have is said so in an answer (a device
  // never takes a failed request to mean a document is gone).
  const missing = await h.call<{ artifact?: unknown; head: number }>(h.machine, "GET", `/v3/artifact?artifactId=missing-document`);
  assert.equal(missing.status, 200);
  assert.equal(missing.body.artifact, undefined);
  const listed = await h.call<{ artifacts: Array<{ record: { id: string } }> }>(h.phone, "GET", `/v3/artifacts?conversationId=${chat}`);
  assert.deepEqual(listed.body.artifacts.map((item) => item.record.id), [artifactId]);
});

test("documents: who may act is the server's to decide — the User from her devices, a member only from the device it runs on", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const cases: Array<[string, Identity, string, string]> = [
    ["the machine as the User", h.machine, "user", "rejected"],
    ["the machine for a member of the computer", h.machine, "desk", "rejected"],
    ["the computer for a member of the machine", h.owner, "box", "rejected"],
    ["the machine for its own member", h.machine, "box", "accepted"],
    ["the computer for its own member", h.owner, "desk", "accepted"],
    ["the phone as the User", h.phone, "user", "accepted"]
  ];
  for (const [label, device, actor, expected] of cases) {
    const result = await h.write(device, artifactOp("artifact.create", chat, actor, { name: `Doc ${label}`, content: "x" }));
    assert.equal(result.body.results[0].status, expected, label);
    if (expected === "rejected") assert.equal(answerOf(result).error?.code, "access_denied", label);
  }
  // A request naming another chat, or holding a NUL, is not read at all.
  const crossed = await h.write(h.owner, { opId: id("op"), kind: "artifact.create", conversationId: chat, actor: "user",
    request: { conversationId: "another-chat", name: "x", content: "x" } } as unknown as HubOp);
  assert.match((crossed.body.results[0] as { reason: string }).reason, /another chat/);
  const nul = await h.write(h.owner, artifactOp("artifact.create", chat, "user", { name: "x", content: "a\u0000b" }));
  assert.match((nul.body.results[0] as { reason: string }).reason, /NUL/);
});

test("documents: drafts follow the roster and the readers' policy, and an operation id answers the same every time", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const collect = { name: "Ideas", initialState: "collecting_drafts", operationId: "collect-1",
    allowedDraftAuthors: ["desk", "box"], requiredDraftAuthors: ["desk", "box"],
    audiencePolicyByAuthor: { desk: { allowedReaders: ["box"], requiredReaders: [] }, box: { allowedReaders: [], requiredReaders: [] } } };
  const created = answerOf(await h.write(h.owner, artifactOp("artifact.create", chat, "user", collect)));
  assert.equal(created.ok, true, JSON.stringify(created));
  const artifactId = created.value!.summary!.id;
  // The same operation id again returns the same answer, not a second document.
  const again = answerOf(await h.write(h.owner, artifactOp("artifact.create", chat, "user", collect)));
  assert.equal(again.value!.summary!.id, artifactId);
  const reused = answerOf(await h.write(h.owner, artifactOp("artifact.create", chat, "user", { ...collect, name: "Other" })));
  assert.match(reused.error?.message ?? "", /already used with a different request/);
  // A reader the author's policy forbids is refused.
  const forbidden = answerOf(await h.write(h.machine, artifactOp("artifact.draft.save", chat, "box",
    { artifactId, expectedEditRevision: 0, content: "Box idea", readers: ["desk"], operationId: "box-save-1" })));
  assert.equal(forbidden.error?.code, "invalid_request");
  assert.match(forbidden.error?.message ?? "", /forbidden by the artifact audience policy/);
  const saved = answerOf(await h.write(h.machine, artifactOp("artifact.draft.save", chat, "box",
    { artifactId, expectedEditRevision: 0, content: "Box idea", readers: [], operationId: "box-save-2" })));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  // Only the User or the owner changes the roster.
  const roster = answerOf(await h.write(h.machine, artifactOp("artifact.roster", chat, "box", {
    artifactId, expectedDraftRosterRevision: 0, allowedDraftAuthors: ["box"], requiredDraftAuthors: ["box"],
    audiencePolicyByAuthor: { box: { allowedReaders: [], requiredReaders: [] } }, operationId: "roster-1" })));
  assert.equal(roster.error?.code, "access_denied");
  // Publication waits for every required draft.
  const early = answerOf(await h.write(h.machine, artifactOp("artifact.publish", chat, "box",
    { artifactId, content: "Merged", requiredSigners: [], sources: [{ draftId: saved.value!.id, disposition: "considered" }], operationId: "publish-1" })));
  assert.equal(early.error?.code, "access_denied", "only the owner (the User here) publishes");
  const notReady = answerOf(await h.write(h.phone, artifactOp("artifact.publish", chat, "user",
    { artifactId, content: "Merged", requiredSigners: [], sources: [{ draftId: saved.value!.id, disposition: "considered" }], operationId: "publish-2" })));
  assert.match(notReady.error?.message ?? "", /required drafts are submitted/);
});

test("documents: the computer's one-time move keeps every row as it was; a body that does not match its hash is refused, and a second move changes nothing", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const at = new Date().toISOString();
  const record = { id: "moved-plan", conversationId: chat, name: "Moved", owner: "user", contributors: [], requiredSigners: ["desk"], labels: [],
    lifecycle: "published", allowedDraftAuthors: [], requiredDraftAuthors: [], audiencePolicyByAuthor: {}, draftRosterRevision: 0, headVersion: 1,
    createdAt: at, updatedAt: at };
  const { createHash } = await import("node:crypto");
  const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const rows = {
    artifacts: [record],
    revisions: [
      { artifactId: "moved-plan", versionEventId: "rev-1", originalVersion: 1, contentHash: hash("Body"), content: "Body", author: "user", createdAt: at },
      { artifactId: "moved-plan", versionEventId: "rev-bad", originalVersion: 2, baseVersionEventId: "rev-1", contentHash: hash("Promised"), content: "Different", author: "user", createdAt: at }
    ],
    projection: [{ artifactId: "moved-plan", version: 1, versionEventId: "rev-1" }],
    signatures: [{ artifactId: "moved-plan", versionEventId: "rev-1", contentHash: hash("Body"), signer: "desk", signedAt: at }]
  };
  const byMachine = await h.write(h.machine, { opId: id("op"), kind: "artifact.import", conversationId: chat, rows } as unknown as HubOp);
  assert.equal(byMachine.body.results[0].status, "rejected", "only the computer that held the documents moves them");
  const moved = await h.write(h.owner, { opId: id("op"), kind: "artifact.import", conversationId: chat, rows } as unknown as HubOp);
  assert.equal(moved.body.results[0].status, "accepted");
  assert.deepEqual((answerOf(moved).value as { refused: string[] }).refused.length, 1, "the revision whose body does not match is refused");
  const state = (await h.call<{ artifact: { record: { name: string }; revisions: Array<{ versionEventId: string }>; signatures: Array<{ signer: string }> } }>(
    h.owner, "GET", "/v3/artifact?artifactId=moved-plan")).body.artifact;
  assert.equal(state.record.name, "Moved");
  assert.deepEqual(state.revisions.map((revision) => revision.versionEventId), ["rev-1"]);
  assert.deepEqual(state.signatures.map((signature) => signature.signer), ["desk"]);
  const head = (await h.call<HubFeedResponse>(h.owner, "GET", "/v3/feed?after=0")).body.head;
  const feed = (await h.call<HubFeedResponse>(h.owner, "GET", "/v3/feed?after=0")).body.entries.filter((entry) => entry.effect.kind === "artifact.import");
  assert.deepEqual(feed.map((entry) => (entry.effect as { artifactIds: string[] }).artifactIds), [["moved-plan"]]);
  // A second move of the same rows keeps what the server holds.
  const again = await h.write(h.owner, { opId: id("op"), kind: "artifact.import", conversationId: chat, rows: { ...rows, artifacts: [{ ...record, name: "Renamed meanwhile" }] } } as unknown as HubOp);
  assert.equal(again.body.results[0].status, "accepted");
  assert.equal((await h.call<{ artifact: { record: { name: string } } }>(h.owner, "GET", "/v3/artifact?artifactId=moved-plan")).body.artifact.record.name, "Moved");
  assert.ok((await h.call<HubFeedResponse>(h.owner, "GET", "/v3/feed?after=0")).body.head >= head);
});

test("documents: a chat deleted on the server takes its documents with it, and no late write brings them back", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const created = answerOf(await h.write(h.owner, artifactOp("artifact.create", chat, "user", { name: "Doomed", content: "x" })));
  const artifactId = created.value!.summary!.id;
  assert.equal((await h.write(h.owner, { opId: id("op"), kind: "conversation.delete", conversationId: chat })).body.results[0].status, "accepted");
  assert.equal((await h.call<{ artifact?: unknown }>(h.owner, "GET", `/v3/artifact?artifactId=${artifactId}`)).body.artifact, undefined);
  const late = await h.write(h.machine, artifactOp("artifact.create", chat, "box", { name: "Late", content: "x" }));
  assert.equal(late.body.results[0].status, "rejected");
  assert.deepEqual((await h.call<{ artifacts: unknown[] }>(h.owner, "GET", `/v3/artifacts?conversationId=${chat}`)).body.artifacts, []);
});
