import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { Conversation } from "../../shared/types";
import { ChatService } from "./chat";
import { createChatChangeTransport } from "./chatChangeTransport";
import { chatChangesLogScope } from "./chatChanges";
import { ChatEventLogService } from "./chatEventLog";
import { StorageService } from "./storage";

const ROOM = "room-1";
const FUTURE = "2999-01-01T00:00:00.000Z";

async function device(dbPath: string, peer: () => string) {
  const storage = new StorageService({ dbPath });
  const log = new ChatEventLogService(storage);
  const { originId } = await log.getOrCreateDeviceIdentity();
  const settings = { async getPublicSettings() { return { chatRoleConfigs: [], chatParticipantConfigs: [] }; } };
  const cliRunner = { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; }, async closeConversationSessions() { return undefined; } };
  const service = new ChatService(storage as never, settings as never, cliRunner as never, { async write() { return undefined; } } as never);
  (service as unknown as { ensureHistoryFiles(): Promise<string> }).ensureHistoryFiles = async () => "/mock/history";
  const committed: string[] = [];
  const inner = createChatChangeTransport({
    role: "desktop", storage, log,
    recipients: () => [{ deviceId: peer(), channelId: ROOM }]
  });
  service.setChatChangeTransport({
    ...inner,
    commit: async (payload, write) => {
      const outcome = await inner.commit(payload, write);
      if (outcome.committed) committed.push(outcome.eventId);
      return outcome;
    }
  });
  return { storage, log, originId, service, committed };
}

function chat(): Conversation {
  return {
    id: "chat-1", title: "Plan", kind: "chat", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T09:00:00.000Z",
    messages: [{ id: "m1", role: "user", content: "Hello", createdAt: "2026-10-01T09:00:01.000Z", status: "done" }],
    findings: [], metadata: { participants: [], participantSessions: [], running: false, warnings: [] }
  } as Conversation;
}

async function save(target: { service: ChatService }, conversation: Conversation): Promise<void> {
  await (target.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(conversation);
}

async function addMessage(target: { storage: StorageService; service: ChatService }, id: string, content: string): Promise<void> {
  const stored = (await target.storage.getConversation("chat-1"))!;
  stored.messages.push({ id, role: "user", content, createdAt: `2026-10-01T09:0${stored.messages.length}:00.000Z`, status: "done" });
  await save(target, stored);
}

async function acknowledge(sender: { storage: StorageService }, receiverId: string, eventId: string): Promise<void> {
  const event = (await sender.storage.getChatEvent(eventId))!;
  await sender.storage.deviceEvents().acknowledge(receiverId, { eventId, eventHash: event.eventHash, outcome: "applied", appliedAt: "2026-10-01T09:30:00.000Z" });
}

test("confirmed chat changes are forgotten; the newest of a chat, unconfirmed ones and recent ones are kept", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-chat-prune-"));
  try {
    const peerId = { value: "" };
    const desktop = await device(path.join(directory, "desktop.sqlite3"), () => peerId.value);
    const machine = await device(path.join(directory, "machine.sqlite3"), () => desktop.originId);
    peerId.value = machine.originId;
    await save(desktop, chat());
    await addMessage(desktop, "m2", "x".repeat(40 * 1024)); // a body stored on its own
    await addMessage(desktop, "m3", "Third");
    assert.equal(desktop.committed.length, 3);
    const blobs = async (storage: StorageService) => (await (storage as unknown as { queryJson<T>(sql: string): Promise<T[]> })
      .queryJson<{ count: number }>("select count(*) as count from device_event_blobs;"))[0].count;
    assert.equal(await blobs(desktop.storage), 1);

    // Nothing is confirmed yet: nothing is forgotten.
    assert.deepEqual(await desktop.storage.deviceEvents().pruneConfirmedChatChanges(desktop.originId, FUTURE), { events: 0, blobs: 0 });
    // Too recent: nothing is forgotten either, confirmed or not.
    for (const eventId of desktop.committed) await acknowledge(desktop, machine.originId, eventId);
    assert.deepEqual(await desktop.storage.deviceEvents().pruneConfirmedChatChanges(desktop.originId, "2000-01-01T00:00:00.000Z"), { events: 0, blobs: 0 });

    const pruned = await desktop.storage.deviceEvents().pruneConfirmedChatChanges(desktop.originId, FUTURE);
    assert.deepEqual(pruned, { events: 2, blobs: 1 }, "the first two, with the separately stored body; the newest stays");
    assert.equal(await desktop.storage.getChatEvent(desktop.committed[0]), undefined);
    assert.ok(await desktop.storage.getChatEvent(desktop.committed[2]), "the newest event of the chat is kept");
    assert.equal(await blobs(desktop.storage), 0);

    // The sequence continues from the kept newest event.
    await addMessage(desktop, "m4", "Fourth");
    const fourth = (await desktop.storage.getChatEvent(desktop.committed[3]))! as ChatEventEnvelope;
    const third = (await desktop.storage.getChatEvent(desktop.committed[2]))! as ChatEventEnvelope;
    assert.equal(fourth.originSeq, third.originSeq + 1);
    assert.equal(fourth.prevHash, third.eventHash);
    // Confirmed but no longer the newest, while the newest is not confirmed: only the confirmed one goes.
    assert.deepEqual(await desktop.storage.deviceEvents().pruneConfirmedChatChanges(desktop.originId, FUTURE), { events: 1, blobs: 0 });
    assert.ok(await desktop.storage.getChatEvent(desktop.committed[3]));
    assert.equal(await desktop.storage.deviceEvents().appliedHead(desktop.originId, chatChangesLogScope("chat-1")), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a receiver forgets what it applied, and an old event delivered again afterwards is confirmed, not applied", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-chat-prune-in-"));
  try {
    const peerId = { value: "" };
    const desktop = await device(path.join(directory, "desktop.sqlite3"), () => peerId.value);
    const machine = await device(path.join(directory, "machine.sqlite3"), () => desktop.originId);
    peerId.value = machine.originId;
    await save(desktop, chat());
    await addMessage(desktop, "m2", "Second");
    await addMessage(desktop, "m3", "Third");
    const ingress = { deviceId: desktop.originId, channelId: ROOM };
    for (const eventId of desktop.committed) {
      const event = (await desktop.storage.getChatEvent(eventId))! as ChatEventEnvelope;
      await machine.storage.appendChatEvent(event, { ingress });
      const [ready] = await machine.storage.deviceEvents().ready(ROOM, desktop.originId);
      assert.equal(ready.eventId, eventId);
      const payload = await machine.storage.deviceEventBlobs().hydrate(ready.payload);
      await machine.service.applyRemoteChatChanges(ready, payload as never);
      await machine.storage.deviceEvents().markApplied(ready, "applied", "2026-10-01T09:40:00.000Z");
    }
    assert.deepEqual(await machine.storage.deviceEvents().pruneConfirmedChatChanges(machine.originId, FUTURE), { events: 2, blobs: 0 });
    assert.deepEqual((await machine.storage.getConversation("chat-1"))?.messages.map((message) => message.id), ["m1", "m2", "m3"]);

    // The desktop never heard the acknowledgement and sends the first again.
    const first = (await desktop.storage.getChatEvent(desktop.committed[0]))! as ChatEventEnvelope;
    await machine.storage.appendChatEvent(first, { ingress });
    assert.deepEqual(await machine.storage.deviceEvents().ready(ROOM, desktop.originId), []);
    const settled = await machine.storage.deviceEvents().settleCovered(ROOM, desktop.originId, "2026-10-01T09:50:00.000Z");
    assert.deepEqual(settled.map((receipt) => receipt.eventId), [first.eventId]);
    assert.deepEqual((await machine.storage.getConversation("chat-1"))?.messages.map((message) => message.id), ["m1", "m2", "m3"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
