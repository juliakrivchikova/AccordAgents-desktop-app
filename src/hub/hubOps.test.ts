import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatSearchService } from "../main/services/chatSearch";
import { createChatEventDeviceIdentity } from "../main/services/chatEventLog";
import { signHubRequest, type HubSigningIdentity } from "../main/services/hubAuth";
import { StorageService } from "../main/services/storage";
import { hubTurnRunId, type HubChatPage, type HubFeedResponse, type HubOp, type HubOpsResponse } from "../shared/hubOps";
import type { ChatMessage } from "../shared/types";
import { HubLog } from "./hubLog";
import { HubOps } from "./hubOps";
import { HubServer } from "./hubServer";

type Identity = ReturnType<typeof createChatEventDeviceIdentity>;

async function hub(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-ops-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const now = () => new Date().toISOString();
  const owner = createChatEventDeviceIdentity(now());
  const phone = createChatEventDeviceIdentity(now());
  const machine = createChatEventDeviceIdentity(now());
  await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Desktop", addedAt: now() });
  const logged: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const log = (event: string, payload: Record<string, unknown>) => { logged.push({ event, payload }); };
  const ops = new HubOps(storage, log);
  const server = new HubServer({
    hubId: "hub-test", version: "test", storage, log: new HubLog(storage), search: new ChatSearchService(storage), vapidPublicKey: "BPUB",
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
  const owner = createChatEventDeviceIdentity(new Date().toISOString());
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
  const stranger = createChatEventDeviceIdentity(new Date().toISOString());
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
