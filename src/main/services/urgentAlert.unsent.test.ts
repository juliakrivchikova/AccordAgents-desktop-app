import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { HubChatPage } from "../../shared/hubOps";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import { urgentAlertOfMessage, type UrgentAlertRaised, type UrgentAlertView } from "../../shared/urgentAlerts";
import { HubAlerts } from "../../hub/hubAlerts";
import { HubOps } from "../../hub/hubOps";
import { HubServer } from "../../hub/hubServer";
import { urgentAlertOutboxStore } from "../appToolWiring";
import { ChatService } from "./chat";
import { mergeStoredChatMessages } from "./chat/store/mergeStoredChat";
import { chatParts } from "./chat/test/chatParts";
import { MAIN_ROLE } from "./chat/test/forkFixtures";
import { DeviceIdentityService, createDeviceIdentity } from "./deviceIdentity";
import { ChatSearchService } from "./chatSearch";
import { signHubRequest, type HubSigningIdentity } from "./hubAuth";
import { ServerChatLink } from "./serverChatLink";
import { StorageService } from "./storage";
import { UrgentAlertOutbox, urgentAlertCardMessageId } from "./urgentAlertTools";

const member: ChatParticipant = { id: "22222222-2222-4222-8222-222222222222", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code" };

/** A pass-through to the server that can refuse everything (unreachable). */
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

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-unsent-alert-"));
  const storage = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  const identities = new DeviceIdentityService(storage);
  const identity = await identities.getOrCreateDeviceIdentity();
  // Her server, with urgent alerts and nothing set up (no Telegram, no phone).
  const hubStorage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3") });
  await hubStorage.init();
  await hubStorage.hub().setOwner({ deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  const phone = createDeviceIdentity(new Date().toISOString());
  await hubStorage.hub().replaceRoster([{ deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "Phone", addedAt: "", scope: { scope: "device" } }], new Date().toISOString());
  const ops = new HubOps(hubStorage);
  const alerts = new HubAlerts({ storage: hubStorage, ops, fetchImpl: (async () => { throw new Error("no outside channels in this test"); }) as typeof fetch });
  await alerts.start();
  const hubServer = new HubServer({ hubId: "hub-test", version: "test", storage: hubStorage, search: new ChatSearchService(hubStorage), vapidPublicKey: "BPUB", ops, alerts });
  const http = await hubServer.listenHttp(0, "127.0.0.1");
  const hubUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const front = await gate(hubUrl);
  const settings = {
    async getPublicSettings() { return { chatRoleConfigs: [MAIN_ROLE], chatParticipantConfigs: [], providers: [{ kind: "claude-code", enabled: true }] }; },
    async listMachines() { return []; }
  };
  const cliRunner = { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; }, async closeConversationSessions() { return undefined; } };
  const links: ServerChatLink[] = [];
  const outboxes: UrgentAlertOutbox[] = [];
  /** The computer's app; a restart builds it again on the same database. */
  const boot = () => {
    const chat = new ChatService(storage as never, settings as never, cliRunner as never, { async write() { return undefined; } } as never);
    const link = new ServerChatLink({
      storage, chat,
      identity: () => identities.getOrCreateDeviceIdentity(),
      hubConfig: async () => ({ url: front.url }),
      machineNames: async () => [],
      movesChats: true,
      log: () => undefined
    });
    const outbox = new UrgentAlertOutbox({ access: () => link, store: urgentAlertOutboxStore(storage.hub()), cards: chat.unsentAlertCards, log: () => undefined, retryMs: 100, raiseTimeoutMs: 2_000 });
    chat.unsentAlertCards.observeServerCards((conversationId, messageId, alert) => { void outbox.serverCardArrived(conversationId, messageId, alert); });
    links.push(link);
    outboxes.push(outbox);
    return { chat, link, outbox };
  };
  const device = boot();
  t.after(async () => {
    for (const each of outboxes) each.stop();
    for (const each of links) await each.stop();
    await alerts.close();
    await front.close();
    await hubServer.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const call = async <T>(who: HubSigningIdentity, method: string, pathWithQuery: string): Promise<T> => {
    const response = await fetch(`${hubUrl}${pathWithQuery}`, { method, headers: { authorization: signHubRequest(who, { method, pathWithQuery, body: "" }) } });
    return await response.json() as T;
  };
  /** What the phone reads of the chat (through the server). */
  const page = (conversationId: string) => call<HubChatPage>(phone, "GET", `/v3/chat?conversationId=${conversationId}`);
  const stored = async (conversationId: string) => (await storage.getConversation(conversationId))!;
  const restart = async () => {
    const next = boot();
    await next.link.start();
    next.outbox.start();
    return next;
  };
  return { storage, front, page, stored, restart, ...device };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value).slice(0, 2_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function localChat(id: string): Conversation {
  const at = "2026-11-27T08:00:00.000Z";
  return {
    id, title: "Deploy watch", kind: "chat", createdAt: at, updatedAt: at, findings: [],
    messages: [{ id: `${id}-start`, role: "system", content: "Chat started.", createdAt: at, status: "done" }],
    metadata: { participants: [member], participantSessions: [], running: false, warnings: [] }
  } as Conversation;
}

const save = (chat: ChatService, conversation: Conversation) => (chatParts(chat).store as unknown as { saveConversation(c: Conversation): Promise<void> }).saveConversation(conversation);
const cardsIn = (messages: ChatMessage[]) => messages.filter((message) => urgentAlertOfMessage(message));

async function linked(h: Awaited<ReturnType<typeof setup>>, conversationId: string): Promise<void> {
  await save(h.chat, localChat(conversationId));
  await h.link.start();
  await until(async () => (await h.link.status())?.ready ?? false, (ready) => ready);
  await until(() => h.page(conversationId), (page) => Boolean((page as { messages?: unknown[] }).messages?.length));
}

test("her server cannot be reached: the red card stands in the chat at once; once the server is back its own card takes the same place, one card on the computer and on the phone", async (t) => {
  const h = await setup(t);
  await linked(h, "chat-a");
  h.front.block();
  const result = await h.outbox.raise({ conversationId: "chat-a", participantId: member.id }, { message: "Production is down", requestId: "req-1" }) as { ok: boolean; value: UrgentAlertRaised; note: string };
  assert.equal(result.ok, true);
  assert.equal(result.value.state, "unsent");
  assert.match(result.note, /could not be reached/);
  const messageId = urgentAlertCardMessageId("chat-a", member.id, "req-1");
  const here = await h.stored("chat-a");
  const local = cardsIn(here.messages);
  assert.equal(local.length, 1, "the card stands here");
  assert.equal(local[0].id, messageId);
  assert.equal(urgentAlertOfMessage(local[0])?.state, "unsent");
  assert.equal(local[0].participantLabel, "@taylor");
  // A running turn's copy of the chat, read while the card was this computer's.
  const turnCopy = await h.stored("chat-a");
  h.front.open();
  const replaced = await until(() => h.stored("chat-a"), (chat) => cardsIn(chat.messages).some((message) => message.metadata?.serverWriter === "server"));
  const cards = cardsIn(replaced.messages);
  assert.equal(cards.length, 1, "one card, never two");
  assert.equal(cards[0].id, messageId, "the server's card took this one's place");
  assert.equal(urgentAlertOfMessage(cards[0])?.state, "not_set_up");
  assert.equal(cards[0].metadata?.serverPlaceholder, undefined);
  // The running turn saves its older copy: the server's card stays.
  const store = chatParts(h.chat).store as unknown as { withChatMutation<T>(c: Conversation, fn: () => Promise<T>): Promise<T>; saveConversation(c: Conversation): Promise<void> };
  await store.withChatMutation(turnCopy, () => store.saveConversation(turnCopy));
  const after = cardsIn((await h.stored("chat-a")).messages);
  assert.equal(after.length, 1);
  assert.equal(urgentAlertOfMessage(after[0])?.state, "not_set_up", "an older copy never brings the unsent card back");
  // The phone reads it from the server, once.
  const phonePage = await until(() => h.page("chat-a"), (page) => cardsIn(page.messages).length > 0);
  assert.equal(cardsIn(phonePage.messages).length, 1);
  assert.equal(cardsIn(phonePage.messages)[0].id, messageId);
});

test("Got it on the card while the server cannot be reached: it never goes out, and the card folds", async (t) => {
  const h = await setup(t);
  await linked(h, "chat-b");
  h.front.block();
  const result = await h.outbox.raise({ conversationId: "chat-b", participantId: member.id }, { message: "Disk is full on the database host", requestId: "req-2" }) as { value: UrgentAlertRaised };
  const closed = await h.outbox.close({ alertId: result.value.alertId });
  assert.ok(closed && "handled" in closed && closed.handled.ok);
  const card = cardsIn((await h.stored("chat-b")).messages)[0];
  const view = urgentAlertOfMessage(card) as UrgentAlertView;
  assert.equal(view.state, "acknowledged");
  assert.ok(view.closedAt);
  h.front.open();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const page = await h.page("chat-b");
  assert.equal(cardsIn(page.messages).length, 0, "not raised on the server");
  assert.equal(cardsIn((await h.stored("chat-b")).messages).length, 1, "the folded card stays here");
});

test("the app restarts while the server cannot be reached: the card is still there and the alert goes out once the server is back", async (t) => {
  const h = await setup(t);
  await linked(h, "chat-c");
  h.front.block();
  await h.outbox.raise({ conversationId: "chat-c", participantId: member.id }, { message: "Payments are failing", requestId: "req-3" });
  h.outbox.stop();
  await h.link.stop();
  const next = await h.restart();
  const kept = cardsIn((await h.stored("chat-c")).messages);
  assert.equal(kept.length, 1, "the card survives the restart");
  assert.equal(urgentAlertOfMessage(kept[0])?.state, "unsent");
  h.front.open();
  const replaced = await until(() => h.stored("chat-c"), (chat) => cardsIn(chat.messages).some((message) => message.metadata?.serverWriter === "server"), 30_000);
  assert.equal(cardsIn(replaced.messages).length, 1);
  assert.ok(next.outbox);
});

test("a card put up before this computer ever linked to the server stays out of the chats it moves there; the server's own card follows once the alert is raised", async (t) => {
  const h = await setup(t);
  await save(h.chat, localChat("chat-d"));
  // Not linked yet: the outbox has no server to ask.
  const early = new UrgentAlertOutbox({ access: () => undefined, store: urgentAlertOutboxStore(h.storage.hub()), cards: h.chat.unsentAlertCards, log: () => undefined, retryMs: 60_000 });
  const result = await early.raise({ conversationId: "chat-d", participantId: member.id }, { message: "Backups failed", requestId: "req-4" }) as { value: UrgentAlertRaised };
  assert.equal(result.value.state, "unsent");
  early.stop();
  await h.link.start();
  await until(async () => (await h.link.status())?.ready ?? false, (ready) => ready);
  const moved = await until(() => h.page("chat-d"), (page) => Boolean((page as { messages?: unknown[] }).messages?.length));
  assert.equal(moved.messages.some((message) => message.id === result.value.messageId), false, "the unsent card is not moved as a plain message");
  h.outbox.start();
  const raised = await until(() => h.page("chat-d"), (page) => cardsIn(page.messages).length > 0);
  assert.equal(cardsIn(raised.messages).length, 1);
  assert.equal(cardsIn(raised.messages)[0].id, result.value.messageId);
  const here = await until(() => h.stored("chat-d"), (chat) => cardsIn(chat.messages).some((message) => message.metadata?.serverWriter === "server"));
  assert.equal(cardsIn(here.messages).length, 1);
});

test("merging a running turn's copy: a placeholder never wins over the server's message, and an alert's card is always the stored one", () => {
  const at = "2026-11-27T09:00:00.000Z";
  const unsent = { id: "unsent-1", state: "unsent", createdAt: at, calls: [], phone: false, callMode: "answer", unsent: { reason: "unreachable", retrying: true } } as UrgentAlertView;
  const placeholder: ChatMessage = { id: "m1", role: "participant", participantId: member.id, content: "Down", createdAt: at, status: "done", metadata: { serverPlaceholder: true, urgentAlert: unsent } };
  const serverCard: ChatMessage = { ...placeholder, metadata: { serverSeq: 12, serverWriter: "server", urgentAlert: { ...unsent, id: "a1", state: "not_set_up", unsent: undefined } } };
  const [kept] = mergeStoredChatMessages([serverCard], [placeholder]);
  assert.equal(kept.metadata?.serverPlaceholder, undefined);
  assert.equal(kept.metadata?.urgentAlert?.state, "not_set_up");
  // A member's bubble written elsewhere takes its placeholder's place the same way.
  const bubble: ChatMessage = { id: "m2", role: "participant", participantId: member.id, content: "", createdAt: at, status: "done", metadata: { serverPlaceholder: true, runId: "r" } };
  const real: ChatMessage = { ...bubble, content: "the reply", metadata: { serverSeq: 13, serverWriter: "machine-1", runId: "r" } };
  const [replaced] = mergeStoredChatMessages([real], [bubble]);
  assert.equal(replaced.content, "the reply");
  assert.equal(replaced.metadata?.serverPlaceholder, undefined);
  // Two placeholders: the running copy as before; a stored card change still wins.
  const acknowledged = { ...placeholder, metadata: { ...placeholder.metadata, urgentAlert: { ...unsent, state: "acknowledged", ackSource: "app", closedAt: at } } } as ChatMessage;
  const [stillHere] = mergeStoredChatMessages([acknowledged], [placeholder]);
  assert.equal(stillHere.metadata?.serverPlaceholder, true);
  assert.equal(stillHere.metadata?.urgentAlert?.state, "acknowledged", "Got it pressed here is not undone by an older copy");
  // A stored placeholder without seq never replaces a running copy's server message.
  const [server] = mergeStoredChatMessages([placeholder], [serverCard]);
  assert.equal(server.metadata?.serverWriter, "server");
});
