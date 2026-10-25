import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePhoneTurnRunId, phoneTurnRunId } from "../../shared/hubProtocol";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import { ChatService } from "./chat";
import { createChatActionEffects } from "./chatActionEffects";
import { createChatChangeTransport } from "./chatChangeTransport";
import { copiedConversation } from "./chatCopy";
import { CHAT_CHANGES_EVENT_KIND, chatChangesLogScope, type ChatChangesPayload } from "./chatChanges";
import { ChatEventLogService, createChatEventDeviceIdentity, createSignedChatEvent } from "./chatEventLog";
import { StorageService } from "./storage";

const local: ChatParticipant = { id: "11111111-1111-4111-8111-111111111111", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code" };
const remote: ChatParticipant = { id: "22222222-2222-4222-8222-222222222222", handle: "drew", roleConfigId: "software-engineer", kind: "codex-cli", homeMachineId: "machine-1" };

interface Started { runId: string; participants: string[]; trigger: string; aborted: boolean }

async function device(dbPath: string, role: "desktop" | "machine", phoneId: string) {
  const storage = new StorageService({ dbPath });
  const log = new ChatEventLogService(storage);
  const { originId } = await log.getOrCreateDeviceIdentity();
  const started: Started[] = [];
  const make = () => {
    const settings = { async getPublicSettings() { return { chatRoleConfigs: [], chatParticipantConfigs: [] }; } };
    const cliRunner = { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; }, async closeConversationSessions() { return undefined; } };
    const service = new ChatService(storage as never, settings as never, cliRunner as never, { async write() { return undefined; } } as never);
    // The turn itself is the CLI's: here it only records that it started.
    (service as unknown as { runParticipantBatch: (...args: unknown[]) => Promise<void> }).runParticipantBatch = async (_conversation, participants, trigger, runId, signal) => {
      started.push({ runId: runId as string, participants: (participants as ChatParticipant[]).map((item) => item.id), trigger: (trigger as ChatMessage).id, aborted: Boolean((signal as AbortSignal | undefined)?.aborted) });
    };
    service.setChatChangeTransport(createChatChangeTransport({
      role, storage, log, recipients: () => [], alwaysEmit: () => true,
      hostMachineId: () => "machine-1", desktopOriginId: () => (role === "machine" ? "desktop-peer" : originId)
    }));
    if (role === "machine") service.setHostMachineId("machine-1");
    service.setPhoneOrigins((origin) => origin === phoneId);
    return service;
  };
  return { storage, log, originId, started, service: make(), restart() { this.service = make(); } };
}

function chat(): Conversation {
  const at = "2026-10-25T08:00:00.000Z";
  return {
    id: "chat-phone", title: "Phone", kind: "chat", createdAt: at, updatedAt: at, findings: [],
    messages: [{ id: "m0", role: "system", content: "Chat started.", createdAt: at, status: "done" }],
    metadata: { participants: [local, remote], participantSessions: [], running: false, warnings: [] }
  } as Conversation;
}

function phoneMessage(phone: ReturnType<typeof createChatEventDeviceIdentity>, seq: number, prevHash: string | undefined, message: ChatMessage): { envelope: ChatEventEnvelope; payload: ChatChangesPayload } {
  const payload: ChatChangesPayload = { version: 1, conversationId: "chat-phone", updatedAt: message.createdAt, changes: [{ type: "message.created", message }] };
  const envelope = createSignedChatEvent(phone, { conversationId: "chat-phone", logScopeId: chatChangesLogScope("chat-phone"), kind: CHAT_CHANGES_EVENT_KIND, payload, originSeq: seq,
    ...(prevHash ? { prevHash } : {}), createdAt: message.createdAt });
  return { envelope, payload };
}

test("a phone turn's run id reads back as the message and member it was built from", () => {
  const messageId = randomUUID();
  assert.deepEqual(parsePhoneTurnRunId(phoneTurnRunId(messageId, remote.id)), { messageId, participantId: remote.id });
  assert.equal(parsePhoneTurnRunId(`run-${messageId}`), undefined);
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

test("a phone's message starts each member at its own home only, once, however often it is applied", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-phone-turns-"));
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const desktop = await device(path.join(directory, "desktop.sqlite3"), "desktop", phone.originId);
    const machine = await device(path.join(directory, "machine.sqlite3"), "machine", phone.originId);
    for (const target of [desktop, machine]) {
      await (target.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(chat());
    }
    const messageId = randomUUID();
    const message: ChatMessage = { id: messageId, role: "user", content: "@taylor @drew both of you", createdAt: "2026-10-25T08:01:00.000Z", status: "done",
      metadata: { deliveryTargets: [local.id, remote.id], threadId: messageId } as ChatMessage["metadata"] };
    const { envelope, payload } = phoneMessage(phone, 1, undefined, message);
    assert.equal(await desktop.service.applyRemoteChatChanges(envelope, payload), "applied");
    assert.equal(await machine.service.applyRemoteChatChanges(envelope, payload), "applied");
    await settle();
    assert.deepEqual(desktop.started.map((item) => [item.runId, item.participants]), [[phoneTurnRunId(messageId, local.id), [local.id]]], "the desktop starts its own member");
    assert.deepEqual(machine.started.map((item) => [item.runId, item.participants]), [[phoneTurnRunId(messageId, remote.id), [remote.id]]], "the machine starts the member it hosts");
    // Applied again (a redelivery), and again after a restart: nothing more.
    await desktop.service.applyRemoteChatChanges(envelope, payload);
    desktop.restart();
    machine.restart();
    await desktop.service.startPhoneTurns("chat-phone", [message]);
    await machine.service.startPhoneTurns("chat-phone", [message]);
    await settle();
    assert.equal(desktop.started.length, 1, "claimed once on the desktop");
    assert.equal(machine.started.length, 1, "claimed once on the machine");
    // A message the desktop typed is not the phone's: nothing starts from it here.
    const typed = { ...message, id: randomUUID(), metadata: { deliveryTargets: [local.id] } as ChatMessage["metadata"] };
    const notPhone = createChatEventDeviceIdentity(new Date().toISOString());
    const other = phoneMessage(notPhone, 1, undefined, typed);
    await desktop.service.applyRemoteChatChanges(other.envelope, other.payload);
    await settle();
    assert.equal(desktop.started.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a Stop the phone gave before the turn started keeps it from starting, at its home, whichever arrives first", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-phone-stop-"));
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const machine = await device(path.join(directory, "machine.sqlite3"), "machine", phone.originId);
    await (machine.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(chat());
    const effects = createChatActionEffects({
      chat: machine.service as never,
      emitter: { beginExecution: async () => true, recordExecution: async () => undefined },
      storage: { getConversation: (id) => machine.storage.getConversation(id) },
      homeMachineId: () => "machine-1"
    });
    // The machine was asleep: it reads the Stop before the message's turn
    // could start (its chat:actions chain is not its chat change chain).
    const messageId = randomUUID();
    const runId = phoneTurnRunId(messageId, remote.id);
    assert.equal(await effects.owns("chat-phone", `run:${runId}`), true, "the member's home owns a Stop for its turn before it starts");
    assert.equal(await effects.owns("chat-phone", `run:${phoneTurnRunId(messageId, local.id)}`), false, "not one for the desktop's member");
    const effect = await effects.perform({ conversationId: "chat-phone", targetKey: `run:${runId}`, kind: "turn.stop.requested",
      payload: { operationId: `stop:${runId}`, targetKey: `run:${runId}` } });
    assert.equal(effect, "stopped the turn before it started");
    const message: ChatMessage = { id: messageId, role: "user", content: "@drew go", createdAt: "2026-10-25T08:02:00.000Z", status: "done",
      metadata: { deliveryTargets: [remote.id], threadId: messageId } as ChatMessage["metadata"] };
    const { envelope, payload } = phoneMessage(phone, 1, undefined, message);
    await machine.service.applyRemoteChatChanges(envelope, payload);
    await settle();
    assert.equal(machine.started.length, 0, "never started");
    const stored = await machine.storage.getConversation("chat-phone");
    assert.ok(stored?.messages.some((item) => item.role === "system" && item.content === "@drew stopped by user."), "said as a member stopped while queued");
    // The other order: the turn is being claimed when the Stop arrives
    // (the claim's write is held until the Stop has been carried out).
    const second = randomUUID();
    const secondRun = phoneTurnRunId(second, remote.id);
    const claims = machine.storage.phoneTurnClaims.bind(machine.storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let claiming = false;
    (machine.storage as unknown as { phoneTurnClaims: () => ReturnType<typeof claims> }).phoneTurnClaims = () => {
      const store = claims();
      const claim = store.claim.bind(store);
      store.claim = async (request) => { claiming = true; await gate; return claim(request); };
      return store;
    };
    const secondMessage = { ...message, id: second, createdAt: "2026-10-25T08:03:00.000Z", metadata: { deliveryTargets: [remote.id], threadId: second } as ChatMessage["metadata"] };
    const next = phoneMessage(phone, 2, envelope.eventHash, secondMessage);
    await machine.service.applyRemoteChatChanges(next.envelope, next.payload);
    for (let wait = 0; wait < 50 && !claiming; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(claiming, true, "the turn is being claimed");
    assert.equal(await effects.owns("chat-phone", `run:${secondRun}`), true);
    assert.equal(await effects.perform({ conversationId: "chat-phone", targetKey: `run:${secondRun}`, kind: "turn.stop.requested",
      payload: { operationId: `stop:${secondRun}`, targetKey: `run:${secondRun}` } }), "stopped the turn before it started");
    release();
    await settle();
    assert.equal(machine.started.filter((item) => item.runId === secondRun && !item.aborted).length, 0, "it never runs");
    const after = await machine.storage.getConversation("chat-phone");
    assert.equal(after?.messages.filter((item) => item.role === "system" && item.content === "@drew stopped by user." && item.metadata?.parentMessageId === second).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a phone message taken in before a stop is started by the next start of its home, once", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-phone-resume-"));
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const desktop = await device(path.join(directory, "desktop.sqlite3"), "desktop", phone.originId);
    await (desktop.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(chat());
    // Taken in by a program that stopped before it claimed anything (or one
    // that did not start phone turns at all).
    desktop.service.setPhoneOrigins(undefined);
    const messageId = randomUUID();
    const message: ChatMessage = { id: messageId, role: "user", content: "@taylor go", createdAt: "2026-10-25T08:04:00.000Z", status: "done",
      metadata: { deliveryTargets: [local.id], threadId: messageId } as ChatMessage["metadata"] };
    const { envelope, payload } = phoneMessage(phone, 1, undefined, message);
    // As the hub's reader does: the event is kept, then applied.
    await desktop.storage.appendChatEvent(envelope);
    assert.equal(await desktop.service.applyRemoteChatChanges(envelope, payload), "applied");
    await settle();
    assert.equal(desktop.started.length, 0);
    desktop.restart();
    const since = new Date(Date.now() - 60_000).toISOString();
    await desktop.service.resumePhoneTurns(since);
    await settle();
    assert.deepEqual(desktop.started.map((item) => item.runId), [phoneTurnRunId(messageId, local.id)]);
    await desktop.service.resumePhoneTurns(since);
    desktop.restart();
    await desktop.service.resumePhoneTurns(since);
    await settle();
    assert.equal(desktop.started.length, 1, "started once, however often its home looks again");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("@member /compact from the phone compacts that member at its home, as typed on the desktop", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-phone-compact-"));
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const desktop = await device(path.join(directory, "desktop.sqlite3"), "desktop", phone.originId);
    await (desktop.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(chat());
    const compacted: Array<{ handle?: string; instructions?: string; runId?: string }> = [];
    (desktop.service as unknown as { compactParticipant: (request: { handle?: string; instructions?: string; runId?: string }) => Promise<unknown> }).compactParticipant = async (request) => {
      compacted.push({ handle: request.handle, instructions: request.instructions, runId: request.runId });
      return {};
    };
    const messageId = randomUUID();
    const message: ChatMessage = { id: messageId, role: "user", content: "@taylor /compact keep the plan", createdAt: "2026-10-25T08:05:00.000Z", status: "done",
      metadata: { deliveryTargets: [local.id], threadId: messageId } as ChatMessage["metadata"] };
    const { envelope, payload } = phoneMessage(phone, 1, undefined, message);
    await desktop.service.applyRemoteChatChanges(envelope, payload);
    await settle();
    assert.deepEqual(compacted, [{ handle: "taylor", instructions: "keep the plan", runId: phoneTurnRunId(messageId, local.id) }]);
    assert.equal(desktop.started.length, 0, "not a turn with the words /compact in it");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a /goal for two members from the phone is refused in the chat, once, as on the desktop", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-phone-goal-"));
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const desktop = await device(path.join(directory, "desktop.sqlite3"), "desktop", phone.originId);
    await (desktop.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(chat());
    const messageId = randomUUID();
    const message: ChatMessage = { id: messageId, role: "user", content: "@taylor @drew /goal ship the release", createdAt: "2026-10-25T08:06:00.000Z", status: "done",
      metadata: { deliveryTargets: [local.id, remote.id], threadId: messageId } as ChatMessage["metadata"] };
    const { envelope, payload } = phoneMessage(phone, 1, undefined, message);
    await desktop.service.applyRemoteChatChanges(envelope, payload);
    await settle();
    await desktop.service.startPhoneTurns("chat-phone", [message]);
    await settle();
    assert.equal(desktop.started.length, 0);
    const stored = await desktop.storage.getConversation("chat-phone");
    assert.equal(stored?.messages.filter((item) => item.role === "system" && item.content === "/goal requires exactly one resolved chat member.").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a device reading the whole order afresh does not run the phone's old messages, nor a turn another home already ran", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-phone-replay-"));
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const machine = await device(path.join(directory, "machine.sqlite3"), "machine", phone.originId);
    await (machine.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(chat());
    // This machine began reading the server now: what the phone wrote an
    // hour ago is another home's (or long over).
    machine.service.setPhoneOrigins((origin) => origin === phone.originId, new Date().toISOString());
    const old = randomUUID();
    const oldMessage: ChatMessage = { id: old, role: "user", content: "@drew old instruction", createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), status: "done",
      metadata: { deliveryTargets: [remote.id], threadId: old } as ChatMessage["metadata"] };
    const first = phoneMessage(phone, 1, undefined, oldMessage);
    await machine.storage.appendChatEvent(first.envelope);
    await machine.service.applyRemoteChatChanges(first.envelope, first.payload);
    await settle();
    await machine.service.resumePhoneTurns(new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    await settle();
    assert.equal(machine.started.length, 0, "an old message is not run again");
    // A recent one whose turn the chat shows already (the member's earlier
    // home ran it): not run here either.
    const recent = randomUUID();
    const recentMessage: ChatMessage = { ...oldMessage, id: recent, content: "@drew recent", createdAt: new Date().toISOString(), metadata: { deliveryTargets: [remote.id], threadId: recent } as ChatMessage["metadata"] };
    const stored = await machine.storage.getConversation("chat-phone");
    stored!.messages.push(recentMessage, { id: randomUUID(), role: "participant", participantId: remote.id, content: "done elsewhere", createdAt: new Date().toISOString(), status: "done",
      metadata: { runId: phoneTurnRunId(recent, remote.id) } as ChatMessage["metadata"] });
    await (machine.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(stored!);
    await machine.service.startPhoneTurns("chat-phone", [recentMessage]);
    await settle();
    assert.equal(machine.started.length, 0, "a turn the chat shows is not run again");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a Stop given before the start is said once, however often the home looks again", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-phone-stop-once-"));
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const machine = await device(path.join(directory, "machine.sqlite3"), "machine", phone.originId);
    await (machine.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(chat());
    const effects = createChatActionEffects({
      chat: machine.service as never,
      emitter: { beginExecution: async () => true, recordExecution: async () => undefined },
      storage: { getConversation: (id) => machine.storage.getConversation(id) },
      homeMachineId: () => "machine-1"
    });
    const messageId = randomUUID();
    const runId = phoneTurnRunId(messageId, remote.id);
    await effects.perform({ conversationId: "chat-phone", targetKey: `run:${runId}`, kind: "turn.stop.requested", payload: { operationId: `stop:${runId}`, targetKey: `run:${runId}` } });
    const message: ChatMessage = { id: messageId, role: "user", content: "@drew go", createdAt: new Date().toISOString(), status: "done",
      metadata: { deliveryTargets: [remote.id], threadId: messageId } as ChatMessage["metadata"] };
    const { envelope, payload } = phoneMessage(phone, 1, undefined, message);
    await machine.storage.appendChatEvent(envelope);
    await machine.service.applyRemoteChatChanges(envelope, payload);
    await settle();
    for (let round = 0; round < 3; round += 1) {
      await machine.service.resumePhoneTurns(new Date(Date.now() - 60_000).toISOString());
      await settle();
    }
    const stored = await machine.storage.getConversation("chat-phone");
    assert.equal(stored?.messages.filter((item) => item.role === "system" && item.content === "@drew stopped by user.").length, 1);
    assert.equal(machine.started.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a phone's message a machine takes from the server's copy (it could not read it in order) starts its member there, once", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-phone-copy-"));
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const machine = await device(path.join(directory, "machine.sqlite3"), "machine", phone.originId);
    machine.service.setPhoneOrigins((origin) => origin === phone.originId, new Date(Date.now() - 60 * 60_000).toISOString());
    await (machine.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(chat());
    const recent = randomUUID();
    const old = randomUUID();
    const base = chat();
    const recentMessage: ChatMessage = { id: recent, role: "user", content: "@drew while you were away", createdAt: new Date().toISOString(), status: "done",
      metadata: { deliveryTargets: [remote.id], threadId: recent, remoteAuthorOriginId: phone.originId } as ChatMessage["metadata"] };
    const oldMessage: ChatMessage = { ...recentMessage, id: old, content: "@drew long ago", createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      metadata: { deliveryTargets: [remote.id], threadId: old, remoteAuthorOriginId: phone.originId } as ChatMessage["metadata"] };
    const copied = copiedConversation({ ...base, messages: [...base.messages, oldMessage, recentMessage] });
    await machine.service.mergeServerCopy(copied, { desktopOriginId: "desktop-peer", localOriginId: machine.originId });
    await settle();
    assert.deepEqual(machine.started.map((item) => item.runId), [phoneTurnRunId(recent, remote.id)], "the recent one, not the one from before it read the server");
    await machine.service.mergeServerCopy(copied, { desktopOriginId: "desktop-peer", localOriginId: machine.originId });
    await settle();
    assert.equal(machine.started.length, 1, "merging the same copy again starts nothing more");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
