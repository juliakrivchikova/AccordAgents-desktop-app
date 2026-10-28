import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { ChatMessage, Conversation } from "../../shared/types";
import { ChatService } from "./chat";
import { createChatChangeTransport } from "./chatChangeTransport";
import { chatChangesLogScope, isChatChangesPayload, sharedConversationState, sharedMessage, type ChatChangesPayload } from "./chatChanges";
import { exportChatCopy, importChatCopy, machineChatCopyProvider, mergeCopiedConversation, type CopiedConversation } from "./chatCopy";
import { ChatEventLogService } from "./chatEventLog";
import { ArtifactService } from "./artifacts";
import { ArtifactStore } from "./artifactStore";
import { StorageService } from "./storage";

const NOW = "2026-10-01T09:00:00.000Z";
const ROOM = "room-1";

interface Device {
  storage: StorageService;
  originId: string;
  service: ChatService;
  committed: string[];
}

async function device(dbPath: string, role: "desktop" | "machine", peer: () => string): Promise<Device> {
  const storage = new StorageService({ dbPath });
  const log = new ChatEventLogService(storage);
  const { originId } = await log.getOrCreateDeviceIdentity();
  const settings = { async getPublicSettings() { return { chatRoleConfigs: [], chatParticipantConfigs: [] }; } };
  const cliRunner = {
    async detectAgents() { return []; },
    async contextUsageForSession() { return undefined; },
    async closeConversationSessions() { return undefined; }
  };
  const debugLogs = { async write() { return undefined; } };
  const service = new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never);
  (service as unknown as { ensureHistoryFiles(): Promise<string> }).ensureHistoryFiles = async () => "/mock/history";
  const committed: string[] = [];
  const inner = createChatChangeTransport({
    role,
    storage,
    log,
    recipients: () => [{ deviceId: peer(), channelId: ROOM }],
    hostMachineId: () => "machine-1",
    desktopOriginId: () => (role === "machine" ? peer() : originId),
    machineOriginId: (machineId) => (machineId === "machine-1" && role === "desktop" ? peer() : undefined)
  });
  service.setChatChangeTransport({
    ...inner,
    commit: async (payload, write) => {
      const outcome = await inner.commit(payload, write);
      if (outcome.committed) committed.push(outcome.eventId);
      return outcome;
    }
  });
  return { storage, originId, service, committed };
}

async function pair() {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-chat-copy-"));
  const devices: { desktop?: Device; machine?: Device } = {};
  devices.desktop = await device(path.join(directory, "desktop.sqlite3"), "desktop", () => devices.machine!.originId);
  devices.machine = await device(path.join(directory, "machine.sqlite3"), "machine", () => devices.desktop!.originId);
  return { directory, desktop: devices.desktop, machine: devices.machine, cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

function chat(id: string, messages: ChatMessage[]): Conversation {
  return {
    id,
    title: `Chat ${id}`,
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/Users/someone/project",
    messages,
    findings: [],
    metadata: {
      participants: [
        { id: "local", handle: "taylor", kind: "claude-cli" },
        { id: "remote", handle: "drew", kind: "codex-cli", homeMachineId: "machine-1" }
      ],
      participantSessions: [{ participantId: "local", sessionId: "desktop-session" }],
      running: false,
      warnings: []
    }
  } as Conversation;
}

function message(id: string, content: string, second: number, patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "user", content, createdAt: `2026-10-01T09:00:${String(second).padStart(2, "0")}.000Z`, status: "done", ...patch };
}

async function save(target: Device, conversation: Conversation): Promise<void> {
  await (target.service as unknown as { saveConversation(conversation: Conversation): Promise<void> }).saveConversation(conversation);
}

async function envelope(from: Device, eventId: string): Promise<ChatEventEnvelope> {
  const event = await from.storage.getChatEvent(eventId);
  assert.ok(event);
  return event as ChatEventEnvelope;
}

test("a new machine gets every chat in the copy and continues from its marks with events", async () => {
  const { directory, desktop, machine, cleanup } = await pair();
  try {
    await save(desktop, chat("chat-1", [message("m1", "Hello", 1), message("m2", "Second", 2)]));
    const first = (await desktop.storage.getConversation("chat-1"))!;
    first.messages.push(message("m3", "Third", 3));
    await save(desktop, first);
    await save(desktop, chat("chat-2", [message("n1", "Other chat", 4)]));
    await desktop.storage.conversationTombstones().mark("chat-gone", NOW);
    assert.equal(desktop.committed.length, 3);

    const copyDir = path.join(directory, "copy");
    const manifest = await exportChatCopy(desktop.storage, copyDir, { desktopOriginId: desktop.originId });
    assert.equal(manifest.conversations, 2);
    assert.equal(manifest.messages, 4);
    assert.ok(manifest.stateTables.includes("deleted_conversations"));
    const scope = chatChangesLogScope("chat-1");
    assert.deepEqual(manifest.marks.filter((mark) => mark.logScopeId === scope).map((mark) => [mark.originId, mark.originSeq]),
      [[desktop.originId, 2]]);

    // Committed after the copy was taken: reaches the machine as an event.
    const later = (await desktop.storage.getConversation("chat-1"))!;
    later.messages.push(message("m4", "After the copy", 5));
    await save(desktop, later);

    const summary = await importChatCopy(machine.storage, copyDir, { hostMachineId: "machine-1", localOriginId: machine.originId });
    assert.deepEqual({ conversations: summary.conversations, messages: summary.messages, skippedDeleted: summary.skippedDeleted },
      { conversations: 2, messages: 4, skippedDeleted: 0 });
    const copied = (await machine.storage.getConversation("chat-1"))!;
    assert.deepEqual(copied.messages.map((item) => item.id), ["m1", "m2", "m3"]);
    assert.deepEqual(copied.metadata.participantSessions, [], "provider sessions are the desktop's own");
    assert.equal((copied.messages[0].metadata as Record<string, unknown>).remoteAuthorOriginId, desktop.originId);
    assert.equal(await machine.storage.conversationTombstones().isDeleted("chat-gone"), true);
    assert.equal(await machine.storage.deviceEvents().appliedHead(desktop.originId, scope), 2);

    // The event the copy already contains arrives late, and so does the next.
    for (const eventId of [desktop.committed[1], desktop.committed[3]]) {
      await machine.storage.appendChatEvent(await envelope(desktop, eventId), { ingress: { deviceId: desktop.originId, channelId: ROOM } });
    }
    const settled = await machine.storage.deviceEvents().settleCovered(ROOM, desktop.originId, "2026-10-01T09:05:00.000Z");
    assert.deepEqual(settled.map((receipt) => receipt.eventId), [desktop.committed[1]], "contained in the copy: confirmed, not applied again");
    const ready = await machine.storage.deviceEvents().ready(ROOM, desktop.originId);
    assert.deepEqual(ready.map((event) => event.eventId), [desktop.committed[3]], "the next change continues from the copy's mark");
    const payload = await machine.storage.deviceEventBlobs().hydrate(ready[0].payload);
    assert.ok(isChatChangesPayload(payload));
    assert.equal(await machine.service.applyRemoteChatChanges(ready[0], payload as ChatChangesPayload), "applied");
    await machine.storage.deviceEvents().markApplied(ready[0], "applied", "2026-10-01T09:05:01.000Z");
    assert.deepEqual((await machine.storage.getConversation("chat-1"))?.messages.map((item) => item.id), ["m1", "m2", "m3", "m4"]);

    // The same copy imported again changes nothing.
    await importChatCopy(machine.storage, copyDir, { hostMachineId: "machine-1", localOriginId: machine.originId });
    assert.deepEqual((await machine.storage.getConversation("chat-1"))?.messages.map((item) => item.id), ["m1", "m2", "m3", "m4"]);
    assert.equal(await machine.storage.deviceEvents().appliedHead(desktop.originId, scope), 3);
    assert.equal(machine.committed.length, 0, "importing a copy emits nothing");
  } finally { await cleanup(); }
});

test("a copy merged into a machine's existing chat keeps that machine's own replies and state", () => {
  const local = chat("chat-1", [
    message("m1", "Hello", 1),
    message("r1", "Done on the machine", 2, { role: "participant", participantId: "remote", metadata: { runId: "run-1" } }),
    message("x1", "Removed here", 3)
  ]);
  local.title = "Old title";
  local.metadata.participantSessions = [{ participantId: "remote", sessionId: "machine-session" }];
  local.metadata.removedChatMessageIds = ["x1"];
  local.messages = local.messages.filter((item) => item.id !== "x1");
  const desktopSide = chat("chat-1", [
    message("m1", "Hello", 1),
    message("r1", "", 2, { role: "participant", participantId: "remote", status: "pending", metadata: { runId: "run-1" } }),
    message("m2", "From the desktop", 4),
    message("x1", "Removed here", 3)
  ]);
  desktopSide.title = "Renamed on the desktop";
  const copied: CopiedConversation = {
    id: "chat-1",
    updatedAt: "2026-10-01T09:10:00.000Z",
    shared: sharedConversationState(desktopSide),
    messages: desktopSide.messages.map((item) => sharedMessage(item, { withReactions: true })),
    removed: []
  };
  const merged = mergeCopiedConversation(local, copied, { desktopOriginId: "desktop-origin", hostMachineId: "machine-1" });
  assert.equal(merged.title, "Renamed on the desktop", "the desktop's shared fields win");
  assert.deepEqual(merged.messages.map((item) => [item.id, item.content]), [
    ["m1", "Hello"], ["r1", "Done on the machine"], ["m2", "From the desktop"]
  ], "this machine's own reply is kept, and a removal here is not undone");
  assert.deepEqual(merged.metadata.participantSessions, [{ participantId: "remote", sessionId: "machine-session" }]);
  assert.deepEqual(merged.metadata.removedChatMessageIds, ["x1"]);
  assert.equal(merged.repoPath, "/Users/someone/project", "without a copy of its own the machine names the project by the desktop's path");
});

test("a copy marks each message with the device that wrote it, keeps this machine's own, and its members' reactions", () => {
  const reactor = (actorId: string, actorKind: "user" | "participant") => ({ actorId, actorLabel: actorId, actorKind, at: NOW });
  const authored = (origin: string, extra: Record<string, unknown> = {}) => ({ remoteAuthorOriginId: origin, ...extra }) as ChatMessage["metadata"];
  const authorOf = (item: ChatMessage | undefined) => (item?.metadata as Record<string, unknown> | undefined)?.remoteAuthorOriginId;
  const local = chat("chat-1", [
    message("phone", "Typed on the phone into this machine", 1),
    message("m1", "Hello", 2, { metadata: authored("desktop-origin", { reactions: { "👍": [reactor("remote", "participant")] } }) })
  ]);
  const desktopSide = chat("chat-1", [
    message("phone", "Typed on the phone into this machine", 1, { metadata: authored("machine-origin") }),
    message("m1", "Hello", 2, { metadata: { reactions: { "🎉": [reactor("user", "user")] } } }),
    message("other", "From another machine", 3, { role: "participant", participantId: "elsewhere", metadata: authored("other-machine") })
  ]);
  const authors: Record<string, string> = { phone: "machine-origin", other: "other-machine" };
  const copied: CopiedConversation = {
    id: "chat-1", updatedAt: NOW, shared: sharedConversationState(desktopSide),
    messages: desktopSide.messages.map((item) => sharedMessage(item, { withReactions: true })), removed: [], authors
  };
  const merged = mergeCopiedConversation(local, copied, { desktopOriginId: "desktop-origin", hostMachineId: "machine-1", localOriginId: "machine-origin" });
  const byId = new Map(merged.messages.map((item) => [item.id, item]));
  assert.equal(authorOf(byId.get("phone")), undefined, "written here, so this machine may still change it");
  assert.equal(authorOf(byId.get("m1")), "desktop-origin");
  assert.equal(authorOf(byId.get("other")), "other-machine");
  assert.deepEqual(byId.get("m1")?.metadata?.reactions, { "🎉": [reactor("user", "user")], "👍": [reactor("remote", "participant")] },
    "the desktop's reactions, plus the one a member living here made");
});

test("a member that watches a copied chat from this machine starts caught up", () => {
  const desktopSide = chat("chat-1", [message("m1", "Old question", 1), message("m2", "Older answer", 2, { role: "participant", participantId: "local" })]);
  (desktopSide.metadata.participants as Array<{ id: string; autoWatch?: boolean }>)[1].autoWatch = true;
  const copied: CopiedConversation = {
    id: "chat-1", updatedAt: NOW, shared: sharedConversationState(desktopSide),
    messages: desktopSide.messages.map((item) => sharedMessage(item, { withReactions: true })), removed: []
  };
  const merged = mergeCopiedConversation(undefined, copied, { desktopOriginId: "desktop-origin", hostMachineId: "machine-1", now: () => new Date(NOW) });
  const watchers = merged.metadata.participantWatchers as Record<string, { lastSeenMessageId?: string; wakeChainDepth: number }>;
  assert.equal(watchers.remote.lastSeenMessageId, "m2", "nothing said before the copy wakes it");
  assert.equal(watchers.remote.wakeChainDepth, 0);
  assert.equal(watchers.local, undefined, "a member living elsewhere is watched there");
});

test("setup adopts the machine, waits for running saves, then exports; a failed export leaves nothing behind", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-chat-copy-provider-"));
  try {
    const steps: string[] = [];
    let failExport = false;
    const storage = {
      async listConversations() { steps.push("export"); if (failExport) throw new Error("database busy"); return []; },
      async getConversation() { return undefined; },
      async chatChangeMarks() { steps.push("marks"); return []; },
      async exportChatCopyState() { return { tables: [] }; }
    };
    const provider = machineChatCopyProvider({
      storage: storage as never,
      desktopOriginId: async () => "desktop-origin",
      adoptMachineIdentity: async (machineId, identity) => { steps.push(`adopt:${machineId}:${identity.originId}`); },
      settleChatSaves: async () => { steps.push("settle"); },
      attachmentsDir: "/desktop/chats",
      tempDir: directory
    });
    const copy = await provider.export("machine-1", { originId: "machine-origin", publicKeyDerBase64: "KEY" });
    assert.deepEqual(steps, ["adopt:machine-1:machine-origin", "settle", "marks", "export"]);
    assert.equal(copy.attachmentsDir, "/desktop/chats");
    assert.ok(existsSync(path.join(copy.dir, "manifest.json")));
    await copy.cleanup();
    assert.equal(existsSync(copy.dir), false);

    failExport = true;
    await assert.rejects(provider.export("machine-1", { originId: "machine-origin", publicKeyDerBase64: "KEY" }), /database busy/);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(directory), [], "the half-written export was removed");
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("a save that started before the machine became a recipient is waited for before the copy is taken", async () => {
  const { desktop, cleanup } = await pair();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transport = (desktop.service as unknown as { chatChangeTransport: Parameters<ChatService["setChatChangeTransport"]>[0] }).chatChangeTransport!;
    desktop.service.setChatChangeTransport({
      ...transport,
      commit: async (payload, write) => transport.commit(payload, async (also) => { await gate; return write(also); })
    });
    const saving = save(desktop, chat("chat-9", [message("m1", "Hello", 1)]));
    let settled = false;
    const waiting = desktop.service.settleChatSaves().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, "the copy must not start while that save is in flight");
    release();
    await saving;
    await waiting;
    assert.equal(settled, true);
  } finally { await cleanup(); }
});

test("documents do not travel in the chat copy: every device reads them from the User's server", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-chat-copy-artifacts-"));
  try {
    const desktopDb = path.join(directory, "desktop.sqlite3");
    const machineDb = path.join(directory, "machine.sqlite3");
    const desktop = new StorageService({ dbPath: desktopDb });
    await desktop.init();
    const desktopStore = new ArtifactStore(desktopDb);
    await desktopStore.init();
    const desktopLog = new ChatEventLogService(desktop);
    const desktopIdentity = await desktopLog.getOrCreateDeviceIdentity();
    await desktop.saveConversation(chat("chat-1", [message("m1", "Hello", 1)]));
    const artifacts = new ArtifactService({ store: desktopStore, getMembers: async () => ["user", "drew"] });
    const created = await artifacts.create("drew", { conversationId: "chat-1", name: "Plan", content: "Version one", requiredSigners: ["drew"] });
    assert.equal(created.ok, true, created.ok ? undefined : created.error?.message);
    const artifactId = created.ok ? created.value.summary.id : "";

    const copyDir = path.join(directory, "copy");
    const manifest = await exportChatCopy(desktop, copyDir, { desktopOriginId: desktopIdentity.originId });
    assert.deepEqual(manifest.stateTables, ["deleted_conversations"], "the copy carries which chats were deleted, and no documents");

    const machine = new StorageService({ dbPath: machineDb });
    await machine.init();
    const machineStore = new ArtifactStore(machineDb);
    await machineStore.init();
    const machineIdentity = await new ChatEventLogService(machine).getOrCreateDeviceIdentity();
    await importChatCopy(machine, copyDir, { hostMachineId: "machine-1", localOriginId: machineIdentity.originId });
    assert.equal((await machine.getConversation("chat-1"))?.messages[0].content, "Hello");
    assert.equal(await machineStore.getById(artifactId), undefined, "documents come from the server, not from the copy");
    assert.deepEqual(await machine.listChatEvents("chat-1", "chat:actions"), []);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("a message holding the Unicode line and paragraph separators survives the copy whole", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-chat-copy-separators-"));
  try {
    const desktop = new StorageService({ dbPath: path.join(directory, "desktop.sqlite3") });
    const text = "first\u2028second\u2029third\r\nfourth\u0010fifth";
    await desktop.saveConversation(chat("chat-1", [message("m1", text, 1)]));
    await desktop.saveConversation(chat("chat-2", [message("n1", "Other", 2)]));
    const copyDir = path.join(directory, "copy");
    await exportChatCopy(desktop, copyDir, { desktopOriginId: "desktop-origin" });
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path.join(copyDir, "conversations.jsonl"), "utf8");
    assert.equal(raw.split("\n").filter(Boolean).length, 2, "one line per chat");
    assert.equal(/[\u2028\u2029]/.test(raw), false, "no raw separator a line reader could split on");
    const machine = new StorageService({ dbPath: path.join(directory, "machine.sqlite3") });
    await importChatCopy(machine, copyDir, { hostMachineId: "machine-1", localOriginId: "machine-origin" });
    assert.equal((await machine.getConversation("chat-1"))?.messages[0].content, text);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
