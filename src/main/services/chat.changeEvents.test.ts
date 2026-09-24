import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { ChatMessage, Conversation } from "../../shared/types";
import { ChatService, type ChatChangeTransport } from "./chat";
import { createChatChangeTransport } from "./chatChangeTransport";
import { CHAT_CHANGES_EVENT_KIND, isChatChangesPayload, type ChatChangesPayload } from "./chatChanges";
import { ChatEventLogService } from "./chatEventLog";
import { StorageService } from "./storage";

const NOW = "2026-09-24T12:00:00.000Z";

interface Device {
  storage: StorageService;
  log: ChatEventLogService;
  originId: string;
  service: ChatService;
  committed: string[];
  failNextWrite: { value: boolean };
  restart(): void;
}

function fakes() {
  return {
    settings: { async getPublicSettings() { return { chatRoleConfigs: [], chatParticipantConfigs: [] }; } },
    cliRunner: {
      async detectAgents() { return []; },
      async contextUsageForSession() { return undefined; },
      async closeConversationSessions() { return undefined; }
    },
    debugLogs: { async write() { return undefined; } }
  };
}

async function device(dbPath: string, role: "desktop" | "machine", peer: () => string): Promise<Device> {
  const storage = new StorageService({ dbPath });
  const log = new ChatEventLogService(storage);
  const { originId } = await log.getOrCreateDeviceIdentity();
  const committed: string[] = [];
  const failNextWrite = { value: false };
  const makeService = () => {
    const { settings, cliRunner, debugLogs } = fakes();
    const service = new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never);
    (service as unknown as { ensureHistoryFiles(): Promise<string> }).ensureHistoryFiles = async () => "/mock/history";
    const inner = createChatChangeTransport({
      role,
      storage,
      log,
      recipients: () => [{ deviceId: peer(), channelId: "room" }],
      hostMachineId: () => "machine-1",
      desktopOriginId: () => (role === "machine" ? peer() : originId),
      machineOriginId: (machineId) => (machineId === "machine-1" && role === "desktop" ? peer() : undefined)
    });
    const transport: ChatChangeTransport = {
      ...inner,
      commit: async (payload, write) => {
        const outcome = await inner.commit(payload, async (also) => {
          if (failNextWrite.value) {
            failNextWrite.value = false;
            throw new Error("the process died before the transaction committed");
          }
          return write(also);
        });
        if (outcome.committed) committed.push(outcome.eventId);
        return outcome;
      }
    };
    service.setChatChangeTransport(transport);
    return service;
  };
  const result: Device = {
    storage, log, originId, service: makeService(), committed, failNextWrite,
    restart: () => { result.service = makeService(); }
  };
  return result;
}

async function pair() {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-chat-changes-"));
  const devices: { desktop?: Device; machine?: Device } = {};
  devices.desktop = await device(path.join(directory, "desktop.sqlite3"), "desktop", () => devices.machine!.originId);
  devices.machine = await device(path.join(directory, "machine.sqlite3"), "machine", () => devices.desktop!.originId);
  return {
    desktop: devices.desktop,
    machine: devices.machine,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

function chat(): Conversation {
  return {
    id: "chat-1",
    title: "Plan",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/repo",
    messages: [
      { id: "m1", role: "system", content: "Chat started.", createdAt: "2026-09-24T12:00:00.000Z", status: "done" },
      { id: "m2", role: "user", content: "Hello", createdAt: "2026-09-24T12:00:01.000Z", status: "done" }
    ],
    findings: [],
    metadata: {
      participants: [
        { id: "local", handle: "taylor", kind: "claude-cli" },
        { id: "remote", handle: "drew", kind: "codex-cli", homeMachineId: "machine-1" }
      ],
      participantSessions: [],
      running: false,
      warnings: []
    }
  } as Conversation;
}

async function save(target: Device, conversation: Conversation): Promise<void> {
  await (target.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(conversation);
}

async function event(from: Device, eventId: string): Promise<{ envelope: ChatEventEnvelope; payload: ChatChangesPayload }> {
  const envelope = await from.storage.getChatEvent(eventId);
  assert.ok(envelope, "the event is in the sender's log");
  assert.equal(envelope!.kind, CHAT_CHANGES_EVENT_KIND);
  const payload = await from.storage.deviceEventBlobs().hydrate(envelope!.payload);
  assert.ok(isChatChangesPayload(payload));
  return { envelope: envelope as ChatEventEnvelope, payload: payload as ChatChangesPayload };
}

async function deliver(from: Device, to: Device, eventId: string): Promise<string> {
  const { envelope, payload } = await event(from, eventId);
  return to.service.applyRemoteChatChanges(envelope, payload);
}

function types(payload: ChatChangesPayload): string[] {
  return payload.changes.map((change) => change.type + ("message" in change ? `:${change.message.id}` : "messageId" in change ? `:${change.messageId}` : ""));
}

test("a chat reaches the machine as events, the machine's reply comes back, and nothing is echoed", async () => {
  const { desktop, machine, cleanup } = await pair();
  try {
    await save(desktop, chat());
    assert.equal(desktop.committed.length, 1);
    const first = await event(desktop, desktop.committed[0]);
    assert.deepEqual(types(first.payload), ["conversation.created", "message.created:m1", "message.created:m2"]);
    const pending = await desktop.storage.deviceEvents().listPending("room", 0, machine.originId);
    assert.equal(pending.length, 1, "the event waits in the outbox for the machine, committed with the save");

    assert.equal(await deliver(desktop, machine, desktop.committed[0]), "applied");
    const copy = await machine.storage.getConversation("chat-1");
    assert.deepEqual(copy?.messages.map((message) => message.id), ["m1", "m2"]);
    assert.equal(machine.committed.length, 0, "an applied change is not emitted back");

    // The desktop starts a turn for the machine member: a pending bubble.
    const withBubble = (await desktop.storage.getConversation("chat-1"))!;
    const bubble: ChatMessage = { id: "m3", role: "participant", participantId: "remote", participantLabel: "@drew", content: "",
      createdAt: "2026-09-24T12:00:02.000Z", status: "pending", metadata: { runId: "run-1" } };
    withBubble.messages.push(bubble);
    await save(desktop, withBubble);
    assert.deepEqual(types((await event(desktop, desktop.committed[1])).payload), ["message.created:m3"]);
    await deliver(desktop, machine, desktop.committed[1]);

    // The machine owns that member's reply.
    const onMachine = (await machine.storage.getConversation("chat-1"))!;
    onMachine.messages[2] = { ...onMachine.messages[2], content: "Done", status: "done" };
    await save(machine, onMachine);
    assert.equal(machine.committed.length, 1);
    assert.deepEqual(types((await event(machine, machine.committed[0])).payload), ["message.updated:m3"]);
    await deliver(machine, desktop, machine.committed[0]);
    const onDesktop = (await desktop.storage.getConversation("chat-1"))!;
    assert.equal(onDesktop.messages[2].content, "Done");
    assert.equal(desktop.committed.length, 2, "the desktop did not echo the machine's reply");

    // A desktop-side sweep of that message stays on the desktop.
    onDesktop.messages[2] = { ...onDesktop.messages[2], status: "error", content: "Interrupted before completion." };
    await save(desktop, onDesktop);
    assert.equal(desktop.committed.length, 2, "not the desktop's message to change");

    // Delivering the same event again changes nothing.
    await deliver(desktop, machine, desktop.committed[1]);
    assert.deepEqual((await machine.storage.getConversation("chat-1"))?.messages.map((message) => message.id), ["m1", "m2", "m3"]);
  } finally { await cleanup(); }
});

test("after a desktop restart the next save sends only what it changed", async () => {
  const { desktop, cleanup } = await pair();
  try {
    await save(desktop, chat());
    desktop.restart();
    const stored = (await desktop.storage.getConversation("chat-1"))!;
    stored.messages.push({ id: "m9", role: "user", content: "After restart", createdAt: "2026-09-24T12:05:00.000Z", status: "done" });
    await save(desktop, stored);
    assert.equal(desktop.committed.length, 2);
    assert.deepEqual(types((await event(desktop, desktop.committed[1])).payload), ["message.created:m9"]);
  } finally { await cleanup(); }
});

test("a save that dies before its transaction commits leaves no event, and the change is sent by the next save", async () => {
  const { desktop, cleanup } = await pair();
  try {
    await save(desktop, chat());
    const stored = (await desktop.storage.getConversation("chat-1"))!;
    stored.messages.push({ id: "m5", role: "user", content: "Lost?", createdAt: "2026-09-24T12:01:00.000Z", status: "done" });
    desktop.failNextWrite.value = true;
    await assert.rejects(save(desktop, stored), /died before/);
    assert.equal(desktop.committed.length, 1);
    assert.equal((await desktop.storage.getConversation("chat-1"))?.messages.some((message) => message.id === "m5"), false);
    await save(desktop, stored);
    assert.deepEqual(types((await event(desktop, desktop.committed[1])).payload), ["message.created:m5"]);
  } finally { await cleanup(); }
});

test("device-local saves and saves with no one to send to record no event", async () => {
  const { desktop, cleanup } = await pair();
  try {
    await save(desktop, chat());
    const stored = (await desktop.storage.getConversation("chat-1"))!;
    stored.metadata.running = true;
    stored.metadata.activeRunIds = ["run-9"];
    await save(desktop, stored);
    assert.equal(desktop.committed.length, 1, "run bookkeeping is not chat content");
    desktop.service.setChatChangeTransport({
      ...createChatChangeTransport({ role: "desktop", storage: desktop.storage, log: desktop.log, recipients: () => [] }),
      commit: async () => { throw new Error("must not be called without recipients"); }
    });
    stored.messages.push({ id: "m7", role: "user", content: "Nobody listening", createdAt: "2026-09-24T12:02:00.000Z", status: "done" });
    await save(desktop, stored);
    assert.equal((await desktop.storage.getConversation("chat-1"))?.messages.at(-1)?.id, "m7");
  } finally { await cleanup(); }
});

test("a change for a chat the machine does not have is held until the chat arrives", async () => {
  const { desktop, machine, cleanup } = await pair();
  try {
    await save(desktop, chat());
    const stored = (await desktop.storage.getConversation("chat-1"))!;
    stored.messages.push({ id: "m4", role: "user", content: "Second", createdAt: "2026-09-24T12:03:00.000Z", status: "done" });
    await save(desktop, stored);
    assert.equal(await deliver(desktop, machine, desktop.committed[1]), "missing-conversation");
    assert.equal(await machine.storage.getConversation("chat-1"), undefined);
    assert.equal(await deliver(desktop, machine, desktop.committed[0]), "applied");
    assert.equal(await deliver(desktop, machine, desktop.committed[1]), "applied");
    assert.deepEqual((await machine.storage.getConversation("chat-1"))?.messages.map((message) => message.id), ["m1", "m2", "m4"]);
  } finally { await cleanup(); }
});
