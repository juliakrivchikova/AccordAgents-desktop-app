import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type { CliMemorySyncValue } from "../../shared/cliMemory";
import type { HubChatPage } from "../../shared/hubOps";
import type { HubDevice } from "../../shared/hubProtocol";
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
  const clock = { now: new Date("2026-11-27T09:00:00.000Z") };
  const memory = new HubMemory(hubStorage, (event, payload) => { hubLog.push({ event, payload }); trace("hub", event, payload); }, () => clock.now);
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
  // A pass looks only once both links name their server.
  for (const link of [desktopLink, machineLink]) await until(() => link.serverId().catch(() => undefined), (id) => Boolean(id));

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
  const desktopSync = (options: Partial<ConstructorParameters<typeof CliMemorySync>[0]> = {}) => {
    const sync = new CliMemorySync({
      access: () => counted(desktopLink, "desktop"), serverId: () => desktopLink.serverId(), database: () => desktopStorage.sqlExecutor(),
      env: async () => ({}), projects: async () => projectsOfChats(await desktopStorage.chatProjectPaths()), homeOverride: desktopHome,
      folders: new ProjectFolders(async () => undefined), log: (event, payload) => trace("desktop", event, payload), ...options
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
  return { desktopHome, machineHome, desktopSync, machineSync, requests, tool, notes, note, desktopLink, machineLink, hubLog, memory, clock, counted, hubStorage };
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
  await put(path.join(memory, "edit.md"), "---\nname: Edited by a member\ntype: reference\n---\nv2, changed\n");
  await put(path.join(memory, "gone.md"), "---\nname: Deleted by the User\ntype: reference\n---\nv2, changed\n");
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

test("a note the User deleted is not made again by another device, nor when the notes move to another server", async (t) => {
  const { desktopHome, machineHome, desktopSync, machineSync, notes, note, desktopLink, hubStorage } = await setup(t);
  const entry = "---\nname: Deploy steps\ntype: reference\n---\nStep one.\n";
  await put(path.join(accordFolder(desktopHome), "deploy.md"), entry);
  await put(path.join(accordFolder(desktopHome), "keep.md"), "---\nname: Kept note\ntype: reference\n---\nStays.\n");
  // The sync names its server: "A", then "B" plays a new server the notes moved to.
  const server = { id: "A" };
  const first = desktopSync({ serverId: async () => server.id });
  assert.deepEqual((await first.syncNow()).outcomes, { created: 2 });
  const deploy = await note("Deploy steps");
  ok(await desktopLink.memory({ action: "delete", noteId: deploy.id }));
  // A machine with the same entry: the deleted note is not made again.
  await put(path.join(accordFolder(machineHome, "-srv-copies-accord"), "deploy.md"), entry);
  assert.deepEqual((await machineSync().syncNow()).outcomes, { deleted: 1 });
  // On "B" this device has sent nothing yet: every entry goes with the note it
  // filled before. A new server holds the moved notes and nothing else: no
  // record of what filled them, and no mark of the note deleted before.
  server.id = "B";
  await hubStorage.sqlExecutor().runSql("delete from member_memory_cli_sources; delete from member_memory_cli_notes; delete from member_memory_deleted;");
  const kept = await note("Kept note");
  assert.deepEqual((await desktopSync({ serverId: async () => server.id }).syncNow()).outcomes, { unchanged: 1, deleted: 1 });
  assert.deepEqual((await notes()).map((item) => item.id), [kept.id]);
  // The computer naming a note this server never had (deleted before the move): not made again.
  const moved = ok<CliMemorySyncValue>(await desktopLink.memory({ action: "cli-sync", entries: [{ provider: "claude-code", file: "~/x/memory/old.md", name: "old.md",
    kind: "article", title: "Deleted before the move", body: "b", tags: [], projectPath: "/work/accord", knownNoteId: "0d0d0d0d-0000-4000-8000-000000000000" }] }));
  assert.equal(moved.results[0].outcome, "deleted");
  assert.equal((await notes()).length, 1);
});

test("a pass sends in pages under the server's limit, stops between pages, and runs once at a time", async (t) => {
  const { desktopHome, desktopSync, desktopLink, notes, counted } = await setup(t);
  const memory = accordFolder(desktopHome);
  // 13 entries of about 15 KB: two requests under 180 KB each.
  for (let index = 0; index < 13; index += 1) {
    await writeFile(path.join(await ensure(memory), `big-${String(index).padStart(2, "0")}.md`), `---\nname: Big ${index}\ntype: reference\n---\n${"line of memory text\n".repeat(790)}`);
  }
  let calls = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const access: MemoryServerAccess = { memory: async (request: HubMemoryRequest, cancel?: AbortSignal) => {
    calls += 1;
    if (calls === 1) await gate;
    return counted(desktopLink, "desktop").memory(request, cancel);
  } };
  const sync = desktopSync({ access: () => access, firstLookMs: 3_600_000, intervalMs: 3_600_000 });
  sync.start();
  const pass = sync.syncNow();
  assert.equal(sync.syncNow(), pass, "a second look joins the one under way");
  await until(async () => calls, (value) => value === 1);
  await sync.stop();
  release();
  const stopped = await pass;
  assert.deepEqual([calls, stopped.sent], [1, 0], "nothing more is sent or recorded after the stop");
  // After a restart: everything, in two requests; the page the server took before is not made twice.
  calls = 2;
  const again = await desktopSync({ access: () => access }).syncNow();
  assert.equal(again.sent, 13);
  assert.equal(calls, 4);
  assert.equal((await notes()).length, 13);
});

test("two entries with one title are two notes; an entry filed under a project stays there", async (t) => {
  const { desktopHome, desktopSync, notes, note, desktopLink } = await setup(t);
  const memory = accordFolder(desktopHome);
  await put(path.join(memory, "a.md"), "---\nname: Project status\ntype: reference\n---\nA says this.\n");
  await put(path.join(memory, "b.md"), "---\nname: Project status\ntype: reference\n---\nB says that.\n");
  const sync = desktopSync();
  assert.deepEqual((await sync.syncNow()).outcomes, { created: 2 });
  assert.deepEqual((await notes()).map((item) => item.title).sort(), ["Project status", "Project status (Desktop)"]);
  await put(path.join(memory, "a.md"), "---\nname: Project status\ntype: reference\n---\nA says this, changed.\n");
  assert.deepEqual((await sync.syncNow()).outcomes, { updated: 1 });
  assert.equal((await note("Project status")).body, "A says this, changed.");
  assert.equal((await note("Project status (Desktop)")).body, "B says that.");

  // The project's chats gone, the same entry comes without a project: its note keeps the project.
  const send = (projectPath?: string) => desktopLink.memory<CliMemorySyncValue>({ action: "cli-sync", entries: [{ provider: "codex", file: "~/.codex/memories/MEMORY.md#Group",
    name: "MEMORY.md#Group", kind: "runbook", title: "Group", body: "How.", tags: [], ...(projectPath ? { projectPath } : {}) }] });
  assert.equal(ok<CliMemorySyncValue>(await send("/work/accord")).results[0].outcome, "created");
  assert.equal(ok<CliMemorySyncValue>(await send()).results[0].outcome, "unchanged");
  assert.deepEqual([(await note("Group")).scope, (await note("Group")).projectPath], ["project", "/work/accord"]);
});

test("the server: no phone, no machine without members, and a status it archived is not doubled", async (t) => {
  const { desktopHome, machineHome, desktopSync, machineSync, memory, clock, tool, notes, note } = await setup(t);
  const device = (role: HubDevice["role"], machineId?: string): HubDevice => ({ deviceId: `device-${role}-${machineId ?? ""}`, publicKeyDerBase64: "", role, name: "X", addedAt: "", ...(machineId ? { machineId } : {}) });
  const entry = { provider: "claude-code", file: "f.md", name: "f.md", kind: "article", title: "From nowhere", body: "b", tags: [] };
  const phone = await memory.handle(device("phone"), { action: "cli-sync", entries: [entry] });
  assert.equal(!phone.ok && phone.error.code, "access_denied");
  const idle = ok<CliMemorySyncValue>(await memory.handle(device("machine", "idle"), { action: "cli-sync", entries: [entry] }));
  assert.deepEqual([idle.results[0].outcome, idle.results[0].reason], ["refused", "This machine hosts no member in any chat."]);
  const box = ok<CliMemorySyncValue>(await memory.handle(device("machine", "box"), { action: "cli-sync", entries: [entry, { ...entry, file: "g.md", name: "g.md", projectPath: "/work/other" }] }));
  assert.deepEqual(box.results.map((result) => result.outcome), ["created", "refused"], "a global note while it hosts a member; not a project it hosts none of");

  const status = "---\nname: Release status\ndescription: branch x, merged\ntype: project\n---\nOpen: QA.\n";
  await put(path.join(accordFolder(desktopHome), "release.md"), status);
  assert.deepEqual((await desktopSync().syncNow()).outcomes, { created: 1 });
  // A month later the server archives the status nobody updated.
  clock.now = new Date(clock.now.getTime() + 31 * 24 * 60 * 60_000);
  ok(await tool("desktop", CHAT_A, taylor, APP_MEMORY_SEARCH_TOOL, { query: "release" }));
  assert.ok((await notes()).every((item) => item.title !== "Release status"), "archived");
  // The machine's first send of the same entry: one note, still archived.
  await put(path.join(accordFolder(machineHome, "-srv-copies-accord"), "release.md"), status);
  const machine = machineSync();
  assert.deepEqual((await machine.syncNow()).outcomes, { unchanged: 1 });
  // A later change of the entry brings it back.
  await put(path.join(accordFolder(machineHome, "-srv-copies-accord"), "release.md"), status.replace("Open: QA.", "Open: QA and release."));
  assert.deepEqual((await machine.syncNow()).outcomes, { updated: 1 });
  assert.equal((await note("Release status")).archivedAt, undefined);
});

async function ensure(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}
