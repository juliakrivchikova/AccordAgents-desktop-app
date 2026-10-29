import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hubTurnRunId, type HubChatPage, type HubOp, type HubOpsResponse } from "../../shared/hubOps";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import { HubOps } from "../../hub/hubOps";
import { HubServer } from "../../hub/hubServer";
import { ChatService } from "./chat";
import { DeviceIdentityService, createDeviceIdentity } from "./deviceIdentity";
import { ChatSearchService } from "./chatSearch";
import { signHubRequest, type HubSigningIdentity } from "./hubAuth";
import { HUB_OP_TAKEN_BACK } from "./hubOpsClient";
import { ServerChatLink } from "./serverChatLink";
import { StorageService } from "./storage";

const desk: ChatParticipant = { id: "11111111-1111-4111-8111-111111111111", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code" };

/** A pass-through to the hub that can refuse everything (the server is
 *  unreachable) and let it through again. */
async function gate(target: string): Promise<{ url: string; block(): void; open(): void; close(): Promise<void> }> {
  let blocked = false;
  const server: Server = createServer((incoming, outgoing) => {
    if (blocked) {
      outgoing.writeHead(503).end();
      incoming.resume();
      return;
    }
    const url = new URL(incoming.url ?? "/", target);
    const forward = httpRequest(url, { method: incoming.method, headers: incoming.headers }, (answer) => {
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(outgoing);
    });
    forward.on("error", () => outgoing.writeHead(502).end());
    incoming.pipe(forward);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    block: () => { blocked = true; },
    open: () => { blocked = false; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}

interface Turn { participantId: string; triggerId: string; runId: string; signal?: AbortSignal }

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-server-turns-"));
  // The computer: its identity owns the server.
  const storage = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  const events = new DeviceIdentityService(storage);
  const identity = await events.getOrCreateDeviceIdentity();
  // The server.
  const hubStorage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3") });
  await hubStorage.init();
  await hubStorage.hub().setOwner({ deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  const phone = createDeviceIdentity(new Date().toISOString());
  await hubStorage.hub().replaceRoster([{ deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "Phone", addedAt: "", scope: { scope: "device" } }], new Date().toISOString());
  const ops = new HubOps(hubStorage);
  const hubServer = new HubServer({ hubId: "hub-test", version: "test", storage: hubStorage, search: new ChatSearchService(hubStorage), vapidPublicKey: "BPUB", ops });
  const http = await hubServer.listenHttp(0, "127.0.0.1");
  const hubUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const front = await gate(hubUrl);
  // The chat service, with the member's turn played by the test.
  const turns: Turn[] = [];
  let release: (() => void) | undefined;
  let holdTurns = false;
  const settings = { async getPublicSettings() { return { chatRoleConfigs: [], chatParticipantConfigs: [], providers: [{ kind: "claude-code", enabled: true }] }; } };
  const cliRunner = { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; }, async closeConversationSessions() { return undefined; } };
  const chat = new ChatService(storage as never, settings as never, cliRunner as never, { async write() { return undefined; } } as never);
  (chat as unknown as { runParticipantTurn: (...args: unknown[]) => Promise<ChatMessage[]> }).runParticipantTurn = async (_conversation, participant, trigger, runId, signal, _progress, options) => {
    const turn: Turn = { participantId: (participant as ChatParticipant).id, triggerId: (trigger as ChatMessage).id, runId: runId as string, signal: signal as AbortSignal };
    turns.push(turn);
    if (holdTurns) {
      await new Promise<void>((resolve) => {
        release = resolve;
        (signal as AbortSignal | undefined)?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if ((signal as AbortSignal | undefined)?.aborted) throw new Error("Chat run cancelled.");
    const pending = (options as { existingPendingMessage?: ChatMessage }).existingPendingMessage as ChatMessage;
    pending.content = `reply to ${(trigger as ChatMessage).content}`;
    pending.status = "done";
    return [pending];
  };
  const link = new ServerChatLink({
    storage, chat,
    identity: () => events.getOrCreateDeviceIdentity(),
    hubConfig: async () => ({ url: front.url }),
    machineNames: async () => [],
    movesChats: true,
    log: () => undefined
  });
  t.after(async () => {
    await link.stop();
    await front.close();
    await hubServer.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const call = async <T>(who: HubSigningIdentity, method: string, pathWithQuery: string, body?: unknown): Promise<T> => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${hubUrl}${pathWithQuery}`, { method, headers: { authorization: signHubRequest(who, { method, pathWithQuery, body: text }),
      ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: text }) });
    return await response.json() as T;
  };
  const page = (conversationId: string) => call<HubChatPage>(phone, "GET", `/v3/chat?conversationId=${conversationId}`);
  const phoneWrite = (op: HubOp) => call<HubOpsResponse>(phone, "POST", "/v3/ops", { ops: [op] });
  return {
    storage, chat, link, front, phone, identity, turns, page, phoneWrite,
    hold: () => { holdTurns = true; },
    release: () => { holdTurns = false; release?.(); }
  };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value).slice(0, 2_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function localChat(id: string, messages: ChatMessage[] = []): Conversation {
  const at = "2026-10-28T08:00:00.000Z";
  return {
    id, title: "Plans", kind: "chat", createdAt: at, updatedAt: at, findings: [],
    messages: [{ id: `${id}-start`, role: "system", content: "Chat started.", createdAt: at, status: "done" }, ...messages],
    metadata: { participants: [desk], participantSessions: [], running: false, warnings: [] }
  } as Conversation;
}

const save = (chat: ChatService, conversation: Conversation) => (chat as unknown as { saveConversation(c: Conversation): Promise<void> }).saveConversation(conversation);

test("the computer moves its chats to the server once, then a message it sends is accepted before its member starts and the reply is the server's", async (t) => {
  const h = await setup(t);
  await save(h.chat, localChat("chat-a"));
  await h.link.start();
  // Moved: the server has the chat as this computer held it.
  const moved = await until(() => h.page("chat-a"), (page) => Boolean((page as { messages?: unknown[] }).messages?.length));
  assert.equal(moved.conversation.title, "Plans");
  await h.chat.sendMessage({ conversationId: "chat-a", content: "@taylor hello" } as never);
  const done = await until(() => h.page("chat-a"), (page) => page.messages.some((message) => message.role === "participant" && message.status === "done"));
  const user = done.messages.find((message) => message.role === "user")!;
  const reply = done.messages.find((message) => message.role === "participant")!;
  assert.equal(reply.content, "reply to @taylor hello");
  assert.equal(reply.metadata?.serverWriter, h.identity.originId, "the member's reply is written by the device it runs on");
  assert.ok((user.metadata?.serverSeq ?? 0) < (reply.metadata?.serverSeq ?? 0), "the reply comes after the message in the server's order");
  assert.deepEqual(h.turns.map((turn) => turn.runId), [hubTurnRunId(user.id, desk.id)], "the turn the message asked, once");
  const turn = await until(() => h.page("chat-a"), (page) => page.turns.some((item) => item.state === "finished"));
  assert.equal(turn.turns[0].executorDeviceId, h.identity.originId);
  assert.equal(turn.turns[0].outcome, "done");
});

test("while the server is unreachable a message stays unsent and its member does not start; it goes once the server is back (Д13)", async (t) => {
  const h = await setup(t);
  await save(h.chat, localChat("chat-b"));
  await h.link.start();
  await until(() => h.page("chat-b"), (page) => Boolean((page as { messages?: unknown[] }).messages?.length));
  // The one-time move ends (every chat read back) before the server goes away.
  await until(async () => (await h.link.status())?.ready ?? false, (ready) => ready);
  h.front.block();
  await h.chat.sendMessage({ conversationId: "chat-b", content: "@taylor are you there" } as never);
  // Every failed attempt is recorded with its reason (Д12); meanwhile the
  // message waits, unsent, and its member does not start (Д13).
  const failures = await until(() => h.storage.hubClientOps().failures(), (list) => list.length > 0, 15_000);
  assert.match(failures[0].reason, /503/);
  assert.equal(h.turns.length, 0, "the member waits for the server");
  assert.ok(await h.storage.hubClientOps().count("queued") > 0, "the message waits, unsent");
  h.front.open();
  const done = await until(() => h.page("chat-b"), (page) => page.messages.some((message) => message.role === "participant" && message.status === "done"), 40_000);
  assert.equal(done.messages.filter((message) => message.role === "user").length, 1, "sent once");
  assert.equal(h.turns.length, 1);
});

test("a message written on the phone starts the computer's member through the server, and a Stop from the phone stops it", async (t) => {
  const h = await setup(t);
  await save(h.chat, localChat("chat-c"));
  await h.link.start();
  await until(() => h.page("chat-c"), (page) => Boolean((page as { messages?: unknown[] }).messages?.length));
  const at = new Date().toISOString();
  const sent = await h.phoneWrite({ opId: "op-phone-1", kind: "message.create", conversationId: "chat-c",
    message: { id: "phone-m1", role: "user", content: "@taylor from the phone", createdAt: at, metadata: { deliveryTargets: [desk.id] } } as ChatMessage });
  assert.equal(sent.results[0].status, "accepted");
  const done = await until(() => h.page("chat-c"), (page) => page.messages.some((message) => message.role === "participant" && message.status === "done"));
  assert.equal(done.messages.find((message) => message.role === "participant")?.content, "reply to @taylor from the phone");
  // The turn's end reaches the server right after the reply it wrote.
  const ended = await until(() => h.page("chat-c"), (page) => page.turns.some((turn) => turn.runId === hubTurnRunId("phone-m1", desk.id) && turn.state === "finished"));
  assert.equal(ended.messages.filter((message) => message.role === "participant").length, 1, "the turn ran once");
  // A second message whose turn the phone stops while it runs.
  h.hold();
  await h.phoneWrite({ opId: "op-phone-2", kind: "message.create", conversationId: "chat-c",
    message: { id: "phone-m2", role: "user", content: "@taylor long job", createdAt: new Date().toISOString(), metadata: { deliveryTargets: [desk.id] } } as ChatMessage });
  await until(async () => h.turns.length, (count) => count === 2);
  const runId = hubTurnRunId("phone-m2", desk.id);
  await h.phoneWrite({ opId: "op-phone-stop", kind: "turn.stop", conversationId: "chat-c", runId, messageId: "phone-m2", participantId: desk.id });
  await until(async () => h.turns[1].signal?.aborted ?? false, (aborted) => aborted, 10_000);
  const stopped = await until(() => h.page("chat-c"), (page) => page.turns.some((turn) => turn.runId === runId && turn.state === "finished"));
  assert.equal(stopped.turns.find((turn) => turn.runId === runId)?.outcome, "stopped");
  h.release();
});

test("a turn taken on the server and stopped while it waits behind the member's previous turn is ended there as stopped, never left taken", async (t) => {
  const h = await setup(t);
  // A Codex member: a second message waits for its running turn (a Claude
  // member takes it into the running session instead).
  const chat = localChat("chat-d");
  chat.metadata = { ...chat.metadata, participants: [{ ...desk, kind: "codex-cli" }] } as Conversation["metadata"];
  await save(h.chat, chat);
  await h.link.start();
  await until(async () => (await h.link.status())?.ready ?? false, (ready) => ready);
  h.hold();
  await h.chat.sendMessage({ conversationId: "chat-d", content: "@taylor first" } as never);
  await until(async () => h.turns.length, (count) => count === 1);
  await h.chat.sendMessage({ conversationId: "chat-d", content: "@taylor second" } as never);
  // The second is taken here at once and waits for the first to end.
  const second = await until(() => h.page("chat-d"), (page) => page.messages.some((message) => message.content === "@taylor second") &&
    page.turns.some((turn) => turn.messageId === page.messages.find((message) => message.content === "@taylor second")?.id && turn.state === "claimed"));
  const secondId = second.messages.find((message) => message.content === "@taylor second")!.id;
  const runId = hubTurnRunId(secondId, desk.id);
  await h.phoneWrite({ opId: "op-phone-stop-d", kind: "turn.stop", conversationId: "chat-d", runId, messageId: secondId, participantId: desk.id });
  const ended = await until(() => h.page("chat-d"), (page) => page.turns.some((turn) => turn.runId === runId && turn.state === "finished"));
  assert.equal(ended.turns.find((turn) => turn.runId === runId)?.outcome, "stopped");
  assert.equal(h.turns.length, 1, "the stopped turn never ran");
  // The first one ends as usual.
  h.release();
  const firstId = ended.messages.find((message) => message.content === "@taylor first")!.id;
  await until(() => h.page("chat-d"), (page) => page.turns.some((turn) => turn.runId === hubTurnRunId(firstId, desk.id) && turn.state === "finished"));
});

test("a claim stopped before it ran is never left taken: taken back if unsent, finished as stopped if the server gave it", async () => {
  const chat = new ChatService({} as never, {} as never, {} as never, { async write() { return undefined; } } as never);
  const turn = { conversationId: "chat-e", runId: "turn-m-p", messageId: "m", participantId: "p" };
  const run = async (withdrawal: unknown, answer?: unknown): Promise<string[]> => {
    const sent: HubOp[] = [];
    const link = {
      withdraw: async () => withdrawal,
      opAnswered: async () => answer,
      enqueue: async (ops: HubOp[]) => { sent.push(...ops); }
    };
    await (chat as unknown as { endAbortedServerTurn(link: unknown, turn: unknown, claimOpId?: string): Promise<void> }).endAbortedServerTurn(link, turn, "op-claim");
    return sent.map((op) => op.kind === "turn.finish" ? `finish:${op.outcome}` : op.kind);
  };
  assert.deepEqual(await run({ status: "withdrawn", attempted: false }), ["turn.stop"], "never sent: the turn is only stopped");
  assert.deepEqual(await run({ status: "missing" }), ["turn.stop"]);
  assert.deepEqual(await run({ status: "withdrawn", attempted: true }), ["turn.stop", "finish:stopped"], "a failed request may have carried it");
  assert.deepEqual(await run({ status: "in-flight" }, { status: "accepted", seq: 5, claim: "claimed" }), ["turn.stop", "finish:stopped"]);
  assert.deepEqual(await run({ status: "in-flight" }, { status: "rejected", reason: HUB_OP_TAKEN_BACK }), ["turn.stop", "finish:stopped"],
    "its request failed after it was taken back: it may have reached the server");
  assert.deepEqual(await run({ status: "answered", outcome: { status: "accepted", seq: 5, claim: "already-yours" } }), ["turn.stop", "finish:stopped"]);
  assert.deepEqual(await run({ status: "answered", outcome: { status: "accepted", seq: 5, claim: "stopped" } }), ["turn.stop"], "stopped there already");
  assert.deepEqual(await run({ status: "answered", outcome: { status: "rejected", reason: "no" } }), ["turn.stop"]);
});
