import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type { CliMemorySyncValue } from "../../shared/cliMemory";
import type { HubChatPage } from "../../shared/hubOps";
import type { HubMemoryRequest, MemoryNote, MemoryOwnerListValue, MemoryResult, MemorySearchValue } from "../../shared/memory";
import type { ChatParticipant, Conversation } from "../../shared/types";
import { HubMemory } from "../../hub/hubMemory";
import { HubOps } from "../../hub/hubOps";
import { HubServer } from "../../hub/hubServer";
import { APP_MEMORY_READ_TOOL, APP_MEMORY_SEARCH_TOOL, APP_MEMORY_WRITE_TOOL } from "./appMcp";
import { ChatService } from "./chat";
import { chatParts } from "./chat/test/chatParts";
import { ChatSearchService } from "./chatSearch";
import { CliMemorySync } from "./cliMemorySync";
import { ProjectFolders, projectsOfChats, projectsOfMachine } from "./cliMemorySync/projects";
import { DeviceIdentityService } from "./deviceIdentity";
import { signHubRequest } from "./hubAuth";
import { callMemoryTool } from "./memoryTools";
import type { MemoryServerAccess } from "./memoryTools";
import { ServerChatLink } from "./serverChatLink";
import { StorageService } from "./storage";

/**
 * What members' CLIs remember on their own, kept in members' memory: a real
 * server, the computer and a cloud machine each with its own database, its
 * own link and its own CLI stores on disk (shared/cliMemory.ts).
 */

const permissions = normalizeChatAgentPermissions(defaultChatAgentPermissions());
const taylor: ChatParticipant = { id: "11111111-1111-4111-8111-111111111111", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code", permissions };
const drew: ChatParticipant = { id: "22222222-2222-4222-8222-222222222222", handle: "drew", roleConfigId: "software-engineer", kind: "codex-cli", homeMachineId: "box", permissions };
const CHAT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function trace(device: string, event: string, payload: Record<string, unknown>): void {
  if (process.env.ACCORD_TEST_TRACE) process.stderr.write(`${device} ${event} ${JSON.stringify(payload).slice(0, 300)}\n`);
}

function chatService(storage: StorageService, device: string): ChatService {
  const settings = { async getPublicSettings() { return { chatRoleConfigs: [], chatParticipantConfigs: [], providers: [] }; } };
  const cliRunner = { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; }, async closeConversationSessions() { return undefined; } };
  const chat = new ChatService(storage as never, settings as never, cliRunner as never, { async write(event: string, payload: Record<string, unknown>) { trace(device, event, payload); } } as never);
  (chatParts(chat).chatHistory as unknown as { ensureHistoryFiles: () => Promise<string> }).ensureHistoryFiles = async () => tmpdir();
  return chat;
}

function chat(id: string, repoPath: string, participants: ChatParticipant[]): Conversation {
  const at = "2026-11-27T08:00:00.000Z";
  return {
    id, title: id.slice(0, 4), kind: "chat", createdAt: at, updatedAt: at, findings: [], repoPath,
    messages: [{ id: `${id}-start`, role: "system", content: "Chat started.", createdAt: at, status: "done" }],
    metadata: { participants, participantSessions: [], running: false, warnings: [] }
  } as Conversation;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${String(JSON.stringify(value)).slice(0, 2_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function ok<T>(result: unknown): T {
  const answer = result as MemoryResult<T>;
  assert.ok(answer.ok, `expected success: ${JSON.stringify(answer)}`);
  return answer.value;
}

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  // A later write in the same millisecond still reads as a change.
  await new Promise((resolve) => setTimeout(resolve, 15));
}

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-cli-memory-"));
  const desktopStorage = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  const desktopIds = new DeviceIdentityService(desktopStorage);
  const desktopIdentity = await desktopIds.getOrCreateDeviceIdentity();
  const machineStorage = new StorageService({ dbPath: path.join(dir, "machine.sqlite3") });
  const machineIds = new DeviceIdentityService(machineStorage);
  const machineIdentity = await machineIds.getOrCreateDeviceIdentity();
  const hubStorage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3") });
  await hubStorage.init();
  await hubStorage.hub().setOwner({ deviceId: desktopIdentity.originId, publicKeyDerBase64: desktopIdentity.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  await hubStorage.hub().replaceRoster([{ deviceId: machineIdentity.originId, publicKeyDerBase64: machineIdentity.publicKeyDerBase64, role: "machine", name: "Box",
    machineId: "box", addedAt: "" }], new Date().toISOString());
  const hubLog: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const memory = new HubMemory(hubStorage, (event, payload) => { hubLog.push({ event, payload }); trace("hub", event, payload); });
  const server = new HubServer({ hubId: "hub-test", version: "test", storage: hubStorage, search: new ChatSearchService(hubStorage), vapidPublicKey: "BPUB",
    ops: new HubOps(hubStorage, (event, payload) => trace("hub", event, payload)), memory });
  const http = await server.listenHttp(0, "127.0.0.1");
  const hubUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  const desktopChat = chatService(desktopStorage, "desktop");
  const machineChat = chatService(machineStorage, "machine");
  machineChat.setHostMachineId("box");
  for (const conversation of [chat(CHAT_A, "/work/accord", [taylor, drew]), chat(CHAT_C, "/work/other", [taylor])]) {
    await (chatParts(desktopChat).store as unknown as { saveConversation(c: Conversation): Promise<void> }).saveConversation(conversation);
  }
  const desktopLink = new ServerChatLink({
    storage: desktopStorage, chat: desktopChat, identity: () => desktopIds.getOrCreateDeviceIdentity(),
    hubConfig: async () => ({ url: hubUrl }), machineNames: async () => [{ id: "box", name: "Box" }], movesChats: true, log: (event, payload) => trace("desktop", event, payload)
  });
  const machineLink = new ServerChatLink({
    storage: machineStorage, chat: machineChat, identity: () => machineIds.getOrCreateDeviceIdentity(),
    hubConfig: async () => ({ url: hubUrl }), machineNames: async () => [], movesChats: false, log: (event, payload) => trace("machine", event, payload)
  });
  const syncs: CliMemorySync[] = [];
  t.after(async () => {
    for (const sync of syncs) await sync.stop();
    await machineLink.stop();
    await desktopLink.stop();
    await server.close();
    await Promise.all([desktopChat.settleChatSaves(), machineChat.settleChatSaves()]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const page = async (conversationId: string): Promise<HubChatPage> => {
    const pathWithQuery = `/v3/chat?conversationId=${conversationId}`;
    const response = await fetch(`${hubUrl}${pathWithQuery}`, { headers: { authorization: signHubRequest(desktopIdentity, { method: "GET", pathWithQuery, body: "" }) } });
    return await response.json() as HubChatPage;
  };
  await desktopLink.start();
  for (const id of [CHAT_A, CHAT_C]) await until(() => page(id), (current) => Boolean(current.messages?.length));
  await machineLink.start();
  await until(async () => (await machineLink.status())?.ready, (ready) => ready === true);

  const desktopHome = path.join(dir, "desktop-home");
  const machineHome = path.join(dir, "machine-home");
  const requests = { desktop: 0, machine: 0 };
  const counted = (link: ServerChatLink, device: "desktop" | "machine"): MemoryServerAccess => ({
    memory: (request: HubMemoryRequest, cancel?: AbortSignal) => {
      if (request.action === "cli-sync") requests[device] += 1;
      return link.memory(request, cancel);
    }
  });
  /** The sync as the app builds it (a new one plays a restart of the app). */
  const desktopSync = () => {
    const sync = new CliMemorySync({
      access: () => counted(desktopLink, "desktop"), serverId: () => desktopLink.serverId(), database: () => desktopStorage.sqlExecutor(),
      env: async () => ({}), projects: async () => projectsOfChats(await desktopStorage.listConversations()), homeOverride: desktopHome,
      folders: new ProjectFolders(async () => undefined), log: (event, payload) => trace("desktop", event, payload)
    });
    syncs.push(sync);
    return sync;
  };
  const machineSync = () => {
    const sync = new CliMemorySync({
      access: () => counted(machineLink, "machine"), serverId: () => machineLink.serverId(), database: () => machineStorage.sqlExecutor(),
      env: async () => ({}), projects: async () => projectsOfMachine({ "/work/accord": "/srv/copies/accord", "/work/other": "/srv/copies/other" }, []),
      homeOverride: machineHome, folders: new ProjectFolders(async () => undefined), log: (event, payload) => trace("machine", event, payload)
    });
    syncs.push(sync);
    return sync;
  };
  const tool = (device: "desktop" | "machine", conversationId: string, member: ChatParticipant, name: string, args: Record<string, unknown> = {}) =>
    callMemoryTool(device === "desktop" ? desktopLink : machineLink, { conversationId, participantId: member.id }, name, args);
  const notes = async () => ok<MemoryOwnerListValue>(await desktopLink.memory({ action: "list" })).notes;
  const note = async (title: string) => {
    const found = (await notes()).find((item) => item.title === title);
    assert.ok(found, `no note titled ${title}: ${(await notes()).map((item) => item.title).join(" | ")}`);
    return ok<MemoryNote>(await desktopLink.memory({ action: "owner-read", noteId: found.id }));
  };
  return { desktopHome, machineHome, desktopSync, machineSync, requests, tool, notes, note, desktopLink, hubLog };
}

const accordFolder = (home: string, folder = "-work-accord") => path.join(home, ".claude", "projects", folder, "memory");

test("the CLIs' memories become notes once, in the right place, and only changes are sent again", async (t) => {
  const { desktopHome, desktopSync, requests, tool, notes, note } = await setup(t);
  const memory = accordFolder(desktopHome);
  await put(path.join(memory, "MEMORY.md"), "- [Reply in Russian](reply.md) — short\n- [Cloud runs status](cloud.md) — branch\n");
  await put(path.join(memory, "reply.md"), "---\nname: reply\ndescription: The User writes Russian.\nmetadata:\n  type: feedback\n---\nShort replies.\nOPENAI_API_KEY=sk-proj-abcdefghijklmnop1234\n");
  await put(path.join(memory, "cloud.md"), "---\nname: cloud\ndescription: branch feature/cloud-runs, merged\ntype: project\n---\nOpen: review.\n");
  // A folder of no project the app knows: a global note.
  await put(path.join(accordFolder(desktopHome, "-Users-x-mctb"), "laptop.md"), "---\nname: Private laptop\ntype: user\n---\nThis Mac is private.\n");
  await put(path.join(desktopHome, ".codex", "memories", "MEMORY.md"),
    "# Task Group: Accord phone QA\nscope: phone\napplies_to: cwd=/work/accord/.worktrees/phone; reuse_rule=x\n## Task 1: t\n\n# Task Group: Russian one-word answers\nscope: chat\napplies_to: cwd=/tmp/chat\n");
  await put(path.join(desktopHome, ".codex", "memories", "memory_summary.md"), "v1\n\n## User Profile\n\nExact.\n\n## What's in Memory\n\n- index\n");

  const sync = desktopSync();
  const first = await sync.syncNow();
  assert.deepEqual(first.outcomes, { created: 6 }, JSON.stringify(first));
  assert.equal(requests.desktop, 1, "one request for all of them");

  const reply = await note("Reply in Russian");
  assert.equal(reply.kind, "article");
  assert.equal(reply.scope, "project");
  assert.equal(reply.projectPath, "/work/accord");
  assert.deepEqual(reply.tags, ["cli-memory", "claude-code", "preference"]);
  assert.equal(reply.author, "claude-code-memory");
  assert.equal(reply.body, "The User writes Russian.\n\nShort replies.", "the secret line is left out");
  assert.equal(reply.source, "Claude Code memory: ~/.claude/projects/-work-accord/memory/reply.md on Desktop");
  assert.equal((await note("Cloud runs status")).kind, "status");
  assert.equal((await note("Private laptop")).scope, "global");
  const phone = await note("Accord phone QA");
  assert.deepEqual([phone.kind, phone.scope, phone.projectPath, phone.author], ["runbook", "project", "/work/accord", "codex-memory"]);
  assert.equal((await note("Russian one-word answers")).scope, "global");
  const summary = await note("Codex memory summary: the User's profile, preferences and tips");
  assert.doesNotMatch(summary.body, /What's in Memory/);

  // Members see them as any note of their scope: the project's only in its chats.
  const titles = async (conversationId: string) => ok<MemorySearchValue>(await tool("desktop", conversationId, taylor, APP_MEMORY_SEARCH_TOOL, { tags: ["cli-memory"] }))
    .notes.map((item) => item.title).sort();
  assert.deepEqual(await titles(CHAT_A), ["Accord phone QA", "Cloud runs status", "Codex memory summary: the User's profile, preferences and tips", "Private laptop", "Reply in Russian", "Russian one-word answers"]);
  assert.deepEqual(await titles(CHAT_C), ["Codex memory summary: the User's profile, preferences and tips", "Private laptop", "Russian one-word answers"]);

  // Nothing changed: no request, and none after a restart of the app either.
  assert.equal((await sync.syncNow()).sent, 0);
  await sync.stop();
  const restarted = desktopSync();
  assert.equal((await restarted.syncNow()).sent, 0);
  assert.equal(requests.desktop, 1);

  // A changed entry changes its note; a removed file changes nothing.
  await put(path.join(memory, "reply.md"), "---\nname: reply\ndescription: The User writes Russian.\ntype: feedback\n---\nVery short replies.\n");
  await unlink(path.join(memory, "cloud.md"));
  const changed = await restarted.syncNow();
  assert.deepEqual([changed.sent, changed.outcomes], [1, { updated: 1 }]);
  const updated = await note("Reply in Russian");
  assert.deepEqual([updated.version, updated.body, updated.id], [2, "The User writes Russian.\n\nVery short replies.", reply.id]);
  assert.equal((await notes()).length, 6, "the note of the removed file stays");
});

test("a note a member changed, wrote first, or the User deleted is never overwritten or made again", async (t) => {
  const { desktopHome, desktopSync, tool, note, desktopLink, hubLog } = await setup(t);
  const memory = accordFolder(desktopHome);
  // A member kept this already, before the sync ran (the main session moved her preferences).
  ok(await tool("desktop", CHAT_A, taylor, APP_MEMORY_WRITE_TOOL, { kind: "article", scope: "project", title: "Ask one question at a time", body: "Mine.", tags: ["preference"] }));
  await put(path.join(memory, "one.md"), "---\nname: Ask one question at a time\ntype: feedback\n---\nThe CLI's.\n");
  await put(path.join(memory, "edit.md"), "---\nname: Edited by a member\ntype: reference\n---\nv1\n");
  await put(path.join(memory, "gone.md"), "---\nname: Deleted by the User\ntype: reference\n---\nv1\n");
  const sync = desktopSync();
  assert.deepEqual((await sync.syncNow()).outcomes, { kept: 1, created: 2 });
  assert.equal((await note("Ask one question at a time")).body, "Mine.");

  const edited = await note("Edited by a member");
  ok(await tool("desktop", CHAT_A, taylor, APP_MEMORY_WRITE_TOOL, { noteId: edited.id, baseVersion: edited.version, body: "Corrected by taylor." }));
  const gone = await note("Deleted by the User");
  ok(await desktopLink.memory({ action: "delete", noteId: gone.id }));

  await put(path.join(memory, "one.md"), "---\nname: Ask one question at a time\ntype: feedback\n---\nThe CLI's, changed.\n");
  await put(path.join(memory, "edit.md"), "---\nname: Edited by a member\ntype: reference\n---\nv2\n");
  await put(path.join(memory, "gone.md"), "---\nname: Deleted by the User\ntype: reference\n---\nv2\n");
  assert.deepEqual((await sync.syncNow()).outcomes, { kept: 2, deleted: 1 });
  assert.equal((await note("Ask one question at a time")).body, "Mine.");
  const after = await note("Edited by a member");
  assert.deepEqual([after.body, after.updatedBy], ["Corrected by taylor.", "taylor"]);
  const all = ok<MemoryOwnerListValue>(await desktopLink.memory({ action: "list" })).notes;
  assert.ok(!all.some((item) => item.title === "Deleted by the User"), "a note the User deleted is not made again");
  assert.ok(hubLog.some((entry) => entry.event === "hub.memory.cli-entry-not-applied" && entry.payload.outcome === "kept"), "what was kept is logged");
});

test("the same entry on the computer and a cloud machine is one note; a machine fills only projects it hosts", async (t) => {
  const { desktopHome, machineHome, desktopSync, machineSync, notes, note, tool } = await setup(t);
  const entry = "---\nname: Release checklist\ntype: reference\n---\nSteps.\n";
  await put(path.join(accordFolder(desktopHome), "release.md"), entry);
  // The machine's copy of the same project, and a project none of its members is in.
  await put(path.join(accordFolder(machineHome, "-srv-copies-accord"), "release.md"), entry);
  await put(path.join(accordFolder(machineHome, "-srv-copies-other"), "other.md"), "---\nname: Not hosted here\ntype: reference\n---\nx\n");
  assert.deepEqual((await desktopSync().syncNow()).outcomes, { created: 1 });
  const machine = machineSync();
  assert.deepEqual((await machine.syncNow()).outcomes, { unchanged: 1, refused: 1 });
  assert.equal((await notes()).length, 1);

  // The machine's version of it changes the one note (no one else changed it).
  await put(path.join(accordFolder(machineHome, "-srv-copies-accord"), "release.md"), "---\nname: Release checklist\ntype: reference\n---\nSteps, then tag.\n");
  assert.deepEqual((await machine.syncNow()).outcomes, { updated: 1 });
  const release = await note("Release checklist");
  assert.equal(release.body, "Steps, then tag.");
  assert.match(release.source ?? "", / on Box$/);
  // The machine's member reads it like any project note.
  const read = ok<MemoryNote>(await tool("machine", CHAT_A, drew, APP_MEMORY_READ_TOOL, { noteId: release.id }));
  assert.equal(read.body, "Steps, then tag.");
  // A refused entry is not sent again until it changes (or the app restarts).
  assert.equal((await machine.syncNow()).sent, 0);
});

test("the server refuses bad entries and too many at once, and keeps a status of no project as an article", async (t) => {
  const { desktopLink } = await setup(t);
  const send = (entries: unknown[]) => desktopLink.memory<CliMemorySyncValue>({ action: "cli-sync", entries: entries as never });
  const base = { provider: "claude-code", file: "~/.claude/projects/x/memory/a.md", name: "x/a.md", kind: "status", title: "A status", body: "b", tags: [] };
  const value = ok<CliMemorySyncValue>(await send([base, { ...base, file: "f2", name: "n2", provider: "gemini" }, { ...base, file: "f3", name: "n3", body: " " }]));
  assert.deepEqual(value.results.map((result) => result.outcome), ["created", "refused", "refused"]);
  const created = ok<MemoryNote>(await desktopLink.memory({ action: "owner-read", noteId: value.results[0].noteId! }));
  assert.deepEqual([created.kind, created.scope], ["article", "global"]);
  const tooMany = await send(Array.from({ length: 101 }, () => base));
  assert.equal(tooMany.ok, false);
});
