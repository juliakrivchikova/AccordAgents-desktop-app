import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hubTurnRunId, type HubChatPage, type HubMachineSettings } from "../../shared/hubOps";
import { deriveMachineChannelKey } from "../../shared/machineChannelKey";
import { isMachineSettingsDocument, type MachineSettingsDocument, type MachineSettingsSnapshot } from "../../shared/machineLink";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import { HubOps } from "../../hub/hubOps";
import { HubLog } from "../../hub/hubLog";
import { HubServer } from "../../hub/hubServer";
import { ChatService } from "./chat";
import { ChatEventLogService } from "./chatEventLog";
import { ChatSearchService } from "./chatSearch";
import { HubClient } from "./hubClient";
import { signHubRequest, type HubSigningIdentity } from "./hubAuth";
import { openChannelPayload } from "./machineChannelSealing";
import { MachineLinkService } from "./machineLink";
import { MachineServerSettings } from "./machineServerSettings";
import { ServerChatLink } from "./serverChatLink";
import { StorageService } from "./storage";

/**
 * A cloud machine as a plain client of the User's server: a real server, the
 * computer's ChatService and the machine's ChatService, each with its own
 * storage and its own link to the server, and no other way between them.
 * Members' CLIs are played by the test.
 */

const desk: ChatParticipant = {
  id: "11111111-1111-4111-8111-111111111111", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code",
  permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
};
const remote: ChatParticipant = {
  id: "22222222-2222-4222-8222-222222222222", handle: "drew", roleConfigId: "software-engineer", kind: "codex-cli", homeMachineId: "box",
  permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow" })
};

/** ACCORD_TEST_TRACE=1 prints what the links do, with times. */
const started = Date.now();
function trace(device: string, event: string, payload: Record<string, unknown>): void {
  if (process.env.ACCORD_TEST_TRACE) process.stderr.write(`${Date.now() - started}ms ${device} ${event} ${JSON.stringify(payload).slice(0, 300)}\n`);
}

interface Turn { device: "desktop" | "machine"; participantId: string; triggerId: string; runId: string; signal?: AbortSignal; settingsAtStart?: number }

function chatService(storage: StorageService, turns: Turn[], device: Turn["device"], control: { hold: boolean; releases: Array<() => void>; settingsApplied?: () => number; closed?: string[] }): ChatService {
  const settings = {
    async getPublicSettings() {
      return { chatRoleConfigs: [], chatParticipantConfigs: [], providers: [{ kind: "claude-code", enabled: true }, { kind: "codex-cli", enabled: true }] };
    }
  };
  const cliRunner = { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; },
    async closeConversationSessions(conversationId: string) { control.closed?.push(conversationId); } };
  const chat = new ChatService(storage as never, settings as never, cliRunner as never, { async write(event: string, payload: Record<string, unknown>) { trace(device, event, payload); } } as never);
  (chat as unknown as { ensureHistoryFiles: () => Promise<string> }).ensureHistoryFiles = async () => tmpdir();
  (chat as unknown as { runParticipantTurn: (...args: unknown[]) => Promise<ChatMessage[]> }).runParticipantTurn = async (_conversation, participant, trigger, runId, signal, _progress, options) => {
    const turn: Turn = { device, participantId: (participant as ChatParticipant).id, triggerId: (trigger as ChatMessage).id, runId: runId as string,
      signal: signal as AbortSignal, settingsAtStart: control.settingsApplied?.() };
    turns.push(turn);
    if (control.hold) {
      await new Promise<void>((resolve) => {
        control.releases.push(resolve);
        (signal as AbortSignal | undefined)?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if ((signal as AbortSignal | undefined)?.aborted) throw new Error("Chat run cancelled.");
    const pending = (options as { existingPendingMessage?: ChatMessage }).existingPendingMessage as ChatMessage;
    pending.content = `${device} reply to ${(trigger as ChatMessage).content}`;
    pending.status = "done";
    return [pending];
  };
  return chat;
}

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-machine-server-"));
  // The computer: its identity owns the server.
  const desktopStorage = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  const desktopEvents = new ChatEventLogService(desktopStorage);
  const desktopIdentity = await desktopEvents.getOrCreateDeviceIdentity();
  // The machine: its own storage and identity.
  const machineStorage = new StorageService({ dbPath: path.join(dir, "machine.sqlite3") });
  const machineEvents = new ChatEventLogService(machineStorage);
  const machineIdentity = await machineEvents.getOrCreateDeviceIdentity();
  // The server, with the machine on its roster as the desktop's machine "box".
  const hubStorage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3") });
  await hubStorage.init();
  await hubStorage.hub().setOwner({ deviceId: desktopIdentity.originId, publicKeyDerBase64: desktopIdentity.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  await hubStorage.hub().replaceRoster([{ deviceId: machineIdentity.originId, publicKeyDerBase64: machineIdentity.publicKeyDerBase64, role: "machine", name: "Box",
    machineId: "box", addedAt: "" }], new Date().toISOString());
  const ops = new HubOps(hubStorage, (event, payload) => trace("hub", event, payload));
  const hubServer = new HubServer({ hubId: "hub-test", version: "test", storage: hubStorage, log: new HubLog(hubStorage), search: new ChatSearchService(hubStorage), vapidPublicKey: "BPUB", ops });
  const http = await hubServer.listenHttp(0, "127.0.0.1");
  const hubUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  const turns: Turn[] = [];
  const desktopControl = { hold: false, releases: [] as Array<() => void> };
  const applied: MachineSettingsDocument[] = [];
  const machineControl = { hold: false, releases: [] as Array<() => void>, settingsApplied: () => applied.length, takes: true, closed: [] as string[] };
  const desktopChat = chatService(desktopStorage, turns, "desktop", desktopControl);
  const machineChat = chatService(machineStorage, turns, "machine", machineControl);

  const desktopLink = new ServerChatLink({
    storage: desktopStorage, chat: desktopChat,
    identity: () => desktopEvents.getOrCreateDeviceIdentity(),
    hubConfig: async () => ({ url: hubUrl }),
    machineNames: async () => [{ id: "box", name: "Box" }],
    movesChats: true,
    log: (event, payload) => trace("desktop", event, payload)
  });
  const machineHub = new HubClient({ url: hubUrl, identity: () => machineEvents.getOrCreateDeviceIdentity(), storage: machineStorage });
  const desktopHub = new HubClient({ url: hubUrl, identity: () => desktopEvents.getOrCreateDeviceIdentity(), storage: desktopStorage });
  const machineLink = new ServerChatLink({
    storage: machineStorage, chat: machineChat,
    identity: () => machineEvents.getOrCreateDeviceIdentity(),
    hubConfig: async () => ({ url: hubUrl }),
    machineNames: async () => [],
    movesChats: false,
    log: (event, payload) => trace("machine", event, payload)
  });

  // The computer publishes the machine's settings on the server, sealed for
  // it alone, as MachineLinkService does after every settings save.
  const pairing = {
    version: 1, purpose: "machine-host", rendezvousId: "room-1", stableRoutingId: "room-1", relaySealKeyBase64: "unused", hubUrl,
    issuer: { originId: desktopIdentity.originId, publicKeyDerBase64: desktopIdentity.publicKeyDerBase64 }, capabilities: [], fingerprint: "f",
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  };
  let snapshot: MachineSettingsSnapshot = { version: 1, exportedAt: new Date().toISOString(), settingsJson: JSON.stringify({ marker: "first" }), agentEnvironment: [{ key: "TOKEN", value: "one" }] };
  const machineRecord = { id: "box", name: "Box", deviceId: machineIdentity.originId, devicePublicKeyDerBase64: machineIdentity.publicKeyDerBase64, pairingKey: "room-1", createdAt: new Date().toISOString() };
  const settingsLink = new MachineLinkService({
    async listMachines() { return [machineRecord]; },
    async saveMachine() { return undefined; },
    async removeMachine() { return undefined; },
    async getMachinePairing() { return pairing as never; },
    async exportMachineSettingsSnapshot() { return snapshot; }
  } as never, { async write() { return undefined; } }, {
    appVersion: "test", desktopDeviceId: desktopIdentity.originId, eventLog: desktopEvents,
    publishSettings: async (machineId, sealed) => { await desktopHub.putMachineSettings({ machineId, sealed }); },
    machineProjects: async () => ({ "/Users/me/project": "/home/box/project" })
  });
  const machineSettings = new MachineServerSettings({
    read: (since) => machineHub.machineSettings(since),
    open: async (sealed) => {
      const document = await openChannelPayload<unknown>(sealed, deriveMachineChannelKey(await machineEvents.getOrCreateDeviceIdentity(), desktopIdentity.publicKeyDerBase64, "room-1"));
      if (!isMachineSettingsDocument(document)) throw new Error("unreadable");
      return document;
    },
    apply: async (document) => {
      applied.push(document);
      machineChat.setMachineProjects(document.projects);
    },
    log: () => undefined
  });
  // As the machine runtime does: nothing new while it stops (`takes` false
  // plays a held or idle-fenced runtime), then its settings and project folder.
  machineChat.setServerTurnPreparation(async (turn) => {
    if (!machineControl.takes) return false;
    await machineSettings.refresh("turn");
    await machineChat.refreshMachineRepository(turn.conversationId);
    return true;
  });
  // The computer asks a machine member's turn once its settings are there.
  desktopChat.setRemoteTurnPreparation({ beforeRemoteTurn: () => settingsLink.syncSettings() });

  t.after(async () => {
    settingsLink.close();
    await machineLink.stop();
    await desktopLink.stop();
    await hubServer.close();
    // Saves already queued finish before the folders go.
    await Promise.all([desktopChat.settleChatSaves(), machineChat.settleChatSaves()]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const call = async <T>(who: HubSigningIdentity, method: string, pathWithQuery: string): Promise<T> => {
    const response = await fetch(`${hubUrl}${pathWithQuery}`, { method, headers: { authorization: signHubRequest(who, { method, pathWithQuery, body: "" }) } });
    return await response.json() as T;
  };
  const page = (conversationId: string) => call<HubChatPage>(desktopIdentity, "GET", `/v3/chat?conversationId=${conversationId}`);

  /** The machine as its runtime starts: which machine it is (the server's
   *  roster), its settings, then its chats and turns. */
  const startMachine = async () => {
    const me = await machineHub.me();
    assert.equal(me.role, "machine");
    machineChat.setHostMachineId(me.machineId);
    await machineSettings.refresh("start");
    await machineLink.start();
  };

  return {
    hubStorage, hubServer, desktopStorage, machineStorage, desktopChat, machineChat, desktopLink, machineLink, desktopIdentity, machineIdentity,
    turns, desktopControl, machineControl, applied, settingsLink, machineSettings, machineHub, desktopHub, page, startMachine,
    setSnapshot: (next: MachineSettingsSnapshot) => { snapshot = next; }
  };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      const pending = (value as { messages?: ChatMessage[] } | undefined)?.messages?.filter((message) => message.status === "pending");
      throw new Error(`Timed out; last: ${JSON.stringify(pending?.length ? { pending } : value).slice(0, 4_000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function localChat(id: string, extra: Partial<Conversation> = {}): Conversation {
  const at = "2026-10-28T08:00:00.000Z";
  return {
    id, title: "Plans", kind: "chat", createdAt: at, updatedAt: at, findings: [],
    messages: [{ id: `${id}-start`, role: "system", content: "Chat started.", createdAt: at, status: "done" }],
    metadata: { participants: [desk, remote], participantSessions: [], running: false, warnings: [] },
    ...extra
  } as Conversation;
}

const save = (chat: ChatService, conversation: Conversation) => (chat as unknown as { saveConversation(c: Conversation): Promise<void> }).saveConversation(conversation);

async function linked(t: test.TestContext, conversation: Conversation) {
  const h = await setup(t);
  await save(h.desktopChat, conversation);
  await h.desktopLink.start();
  await until(() => h.page(conversation.id), (page) => Boolean((page as { messages?: unknown[] }).messages?.length));
  await h.settingsLink.syncSettings();
  await h.startMachine();
  // The machine reads the chat from the server.
  await until(() => h.machineStorage.getConversation(conversation.id), (chat) => Boolean(chat));
  return h;
}

test("a message on the computer to a machine member is taken and answered by the machine; the computer shows its reply and drops its placeholder", async (t) => {
  const h = await linked(t, localChat("chat-a"));
  await h.desktopChat.sendMessage({ conversationId: "chat-a", content: "@drew hello" } as never);
  const done = await until(() => h.page("chat-a"), (page) => page.messages.some((message) => message.role === "participant" && message.status === "done"));
  const user = done.messages.find((message) => message.role === "user")!;
  const reply = done.messages.find((message) => message.role === "participant")!;
  assert.equal(reply.content, "machine reply to @drew hello");
  assert.equal(reply.metadata?.serverWriter, h.machineIdentity.originId, "the machine writes its member's reply");
  assert.deepEqual(h.turns.map((turn) => [turn.device, turn.runId]), [["machine", hubTurnRunId(user.id, remote.id)]], "run once, on the machine");
  const finished = await until(() => h.page("chat-a"), (page) => page.turns.some((turn) => turn.state === "finished"));
  assert.equal(finished.turns[0].executorDeviceId, h.machineIdentity.originId, "taken by the machine (the second mark)");
  assert.equal(finished.turns[0].outcome, "done");
  // The computer shows the machine's bubble, and its own placeholder is gone.
  const shown = await until(() => h.desktopStorage.getConversation("chat-a"), (chat) =>
    Boolean(chat?.messages.some((message) => message.id === reply.id && message.status === "done")) &&
    !chat!.messages.some((message) => message.metadata?.serverPlaceholder));
  assert.equal(shown!.messages.filter((message) => message.role === "participant").length, 1, "one bubble for the member");
  await until(async () => h.desktopChat.liveRunIds().length, (count) => count === 0);
});

test("Stop on the computer stops the machine's turn, shown as waiting until the machine confirms", async (t) => {
  const h = await linked(t, localChat("chat-b"));
  h.machineControl.hold = true;
  await h.desktopChat.sendMessage({ conversationId: "chat-b", content: "@drew long job" } as never);
  const started = await until(async () => h.turns, (turns) => turns.length === 1);
  assert.equal(started[0].device, "machine");
  const runId = started[0].runId;
  assert.equal(h.desktopChat.cancelRun(runId), true, "the computer's own run of the member stops");
  await until(async () => h.turns[0].signal?.aborted ?? false, (aborted) => aborted, 15_000);
  const stopped = await until(() => h.page("chat-b"), (page) => page.turns.some((turn) => turn.runId === runId && turn.state === "finished"));
  assert.equal(stopped.turns.find((turn) => turn.runId === runId)?.outcome, "stopped");
  assert.equal(stopped.turns.find((turn) => turn.runId === runId)?.executorDeviceId, h.machineIdentity.originId);
  await until(async () => h.desktopChat.liveRunIds().length + h.machineChat.liveRunIds().length, (count) => count === 0);
  const desktop = await h.desktopStorage.getConversation("chat-b");
  assert.equal(desktop!.messages.some((message) => message.metadata?.stopPending), false, "no Stop left waiting once the machine confirmed");
  assert.equal(desktop!.messages.some((message) => message.status === "pending"), false);
});

test("a machine member's request to a computer member runs on the computer, and its answer reaches the machine", async (t) => {
  const conversation = localChat("chat-c");
  conversation.messages.push({ id: "user-message", role: "user", content: "@drew ask taylor", createdAt: "2026-10-28T08:01:00.000Z", status: "done" } as ChatMessage);
  const h = await linked(t, conversation);
  await until(() => h.machineStorage.getConversation("chat-c"), (chat) => Boolean(chat?.messages.some((message) => message.id === "user-message")));
  const result = await h.machineChat.requestParticipantsFromTool({
    conversationId: "chat-c", participantId: remote.id, roleConfigId: remote.roleConfigId, roleConfigVersion: 1,
    capabilities: ["participants.request"], triggerMessageId: "user-message", triggerThreadId: "user-message",
    snapshotMaxSequence: 0, continuation: false, participantRequestDepth: 0
  } as never, { requests: [{ target: desk.handle, prompt: "Please review." }], timeoutMs: 20_000, resumeRequester: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  const items = (result as { batch: { items: Array<{ status: string; reply?: string }> } }).batch.items;
  assert.equal(items[0].status, "answered", JSON.stringify(items));
  assert.match(items[0].reply ?? "", /^desktop reply to /, "the computer's member answered");
  assert.deepEqual(h.turns.map((turn) => [turn.device, turn.participantId]), [["desktop", desk.id]], "run once, where the member lives");
  const page = await h.page("chat-c");
  const answer = page.messages.find((message) => message.role === "participant" && message.participantId === desk.id)!;
  assert.equal(answer.metadata?.serverWriter, h.desktopIdentity.originId, "written by the computer");
  const asked = page.turns.find((turn) => turn.participantId === desk.id)!;
  assert.equal(asked.requestedBy, h.machineIdentity.originId, "asked by the machine");
  assert.equal(asked.executorDeviceId, h.desktopIdentity.originId, "taken by the computer");
  await until(async () => h.desktopChat.liveRunIds().length + h.machineChat.liveRunIds().length, (count) => count === 0);
});

test("the machine applies the settings the computer published before it runs a member's turn, including where the chat's project is", async (t) => {
  const h = await linked(t, localChat("chat-d", { repoPath: "/Users/me/project" }));
  assert.equal(h.applied.length, 1, "read at start");
  assert.equal(JSON.parse(h.applied[0].settings.settingsJson).marker, "first");
  // The server never holds them in the clear.
  const stored = await (h.machineHub.machineSettings() as Promise<HubMachineSettings>);
  assert.ok(stored.sealed && !stored.sealed.includes("first") && !stored.sealed.includes("TOKEN"), "sealed for the machine");
  // A setting saved on the computer: told to the machine live, and in any
  // case read before its member's next turn.
  const frames: string[] = [];
  const stopLive = h.machineHub.live(() => undefined, undefined, (frame) => frames.push(frame.type));
  t.after(() => stopLive());
  await new Promise((resolve) => setTimeout(resolve, 300));
  h.setSnapshot({ version: 1, exportedAt: new Date().toISOString(), settingsJson: JSON.stringify({ marker: "second" }), agentEnvironment: [{ key: "TOKEN", value: "two" }] });
  await h.settingsLink.syncSettings();
  await until(async () => frames, (seen) => seen.includes("settings"), 5_000);
  await h.desktopChat.sendMessage({ conversationId: "chat-d", content: "@drew go" } as never);
  await until(() => h.page("chat-d"), (page) => page.messages.some((message) => message.role === "participant" && message.status === "done"));
  const turn = h.turns.find((item) => item.device === "machine")!;
  assert.ok((turn.settingsAtStart ?? 0) >= 2, "the newer settings were applied before the member started");
  assert.equal(JSON.parse(h.applied.at(-1)!.settings.settingsJson).marker, "second");
  assert.equal(h.applied.at(-1)!.settings.agentEnvironment[0].value, "two");
  const machineCopy = await h.machineStorage.getConversation("chat-d");
  assert.equal(machineCopy!.repoPath, "/home/box/project", "the member works in the machine's copy of the project");
  const desktopCopy = await h.desktopStorage.getConversation("chat-d");
  assert.equal(desktopCopy!.repoPath, "/Users/me/project", "the computer's chat keeps its own path");
  const serverCopy = await h.page("chat-d");
  assert.equal(serverCopy.conversation.repoPath, "/Users/me/project", "the machine's folder never reaches the server's copy");
  await until(async () => h.desktopChat.liveRunIds().length + h.machineChat.liveRunIds().length, (count) => count === 0);
});

test("a machine the server's roster does not name is told so, and a removed machine reads nothing more", async (t) => {
  const h = await linked(t, localChat("chat-e"));
  const stranger = new ChatEventLogService(new StorageService({ dbPath: path.join(tmpdir(), `stranger-${process.pid}-${Date.now()}.sqlite3`) }));
  const strangerHub = new HubClient({ url: (h.machineHub as unknown as { base: string }).base, identity: () => stranger.getOrCreateDeviceIdentity(), storage: h.machineStorage });
  await assert.rejects(strangerHub.me(), /not on the hub's roster/);
  await assert.rejects(strangerHub.machineSettings(), /not on the hub's roster/);
  // The computer cannot read a machine's settings, and a machine cannot put any.
  await assert.rejects(h.desktopHub.machineSettings(), /Only a machine reads its settings/);
  await assert.rejects(h.machineHub.putMachineSettings({ machineId: "box", sealed: "x" }), /Only the desktop that set up this hub/);
  // The computer takes the machine off the server's roster (it was removed).
  await h.hubStorage.hub().replaceRoster([], new Date().toISOString());
  h.hubServer.invalidateRoster();
  await assert.rejects(h.machineHub.me(), /not on the hub's roster/, "it is no machine of the User's any more");
  await assert.rejects(h.machineHub.machineSettings(), /not on the hub's roster/, "and reads none of its settings");
  await assert.rejects(h.machineHub.feed(0, 0), /not on the hub's roster/, "nor any chat");
});

test("a turn the machine has not taken is stopped on the server and never starts there; a waiting turn is taken once when the machine takes work again", async (t) => {
  const h = await linked(t, localChat("chat-f"));
  // The machine takes nothing new (its runtime is being replaced, or it stops
  // after being idle): the turn waits on the server.
  h.machineControl.takes = false;
  await h.desktopChat.sendMessage({ conversationId: "chat-f", content: "@drew first" } as never);
  const waiting = await until(() => h.page("chat-f"), (page) => page.turns.length === 1 && page.turns[0].state === "requested");
  const first = waiting.turns[0].runId;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(h.turns.length, 0, "the machine did not take it");
  assert.equal(h.desktopChat.cancelRun(first), true);
  const stopped = await until(() => h.page("chat-f"), (page) => page.turns.find((turn) => turn.runId === first)?.state === "stopped");
  assert.equal(stopped.turns.find((turn) => turn.runId === first)?.executorDeviceId, undefined, "nobody took it");
  await h.desktopChat.sendMessage({ conversationId: "chat-f", content: "@drew second" } as never);
  const both = await until(() => h.page("chat-f"), (page) => page.turns.length === 2);
  const second = both.turns.find((turn) => turn.runId !== first)!.runId;
  // The machine takes work again: the feed and a resume reach the same turn
  // together, as when its idle fence lifts while the feed reads.
  h.machineControl.takes = true;
  await Promise.all([h.machineChat.resumeServerTurns(), h.machineChat.resumeServerTurns()]);
  await until(() => h.page("chat-f"), (page) => page.turns.find((turn) => turn.runId === second)?.state === "finished");
  assert.deepEqual(h.turns.map((turn) => [turn.device, turn.runId]), [["machine", second]], "the stopped turn never ran; the waiting one ran once");
  await until(async () => h.desktopChat.liveRunIds().length + h.machineChat.liveRunIds().length, (count) => count === 0);
  const desktop = await until(() => h.desktopStorage.getConversation("chat-f"), (chat) => !chat!.messages.some((message) => message.status === "pending"));
  assert.ok(desktop!.messages.some((message) => message.role === "participant" && message.content === "machine reply to @drew second"));
});

test("a chat deleted on the computer is deleted on the machine too, through the server, with its members' sessions there closed", async (t) => {
  const h = await linked(t, localChat("chat-g"));
  await h.desktopChat.setArchived({ conversationId: "chat-g", archived: true } as never);
  assert.equal(await h.desktopChat.deleteConversation({ conversationId: "chat-g" }), true);
  await until(() => h.machineStorage.getConversation("chat-g"), (chat) => !chat);
  assert.equal(await h.machineStorage.conversationTombstones().isDeleted("chat-g"), true, "kept deleted on the machine");
  assert.ok(h.machineControl.closed.includes("chat-g"), "its members' sessions on the machine are closed");
  const server = await h.page("chat-g") as unknown as { error?: string; messages?: unknown[] };
  assert.equal(server.messages, undefined, "the server holds it no more");
  // Read again from the server (a resync), it does not come back.
  await h.machineChat.resumeServerTurns();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await h.machineStorage.getConversation("chat-g"), undefined);
});
