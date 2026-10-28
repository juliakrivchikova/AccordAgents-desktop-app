import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactMembersForConversation } from "../../shared/artifacts";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type { HubChatPage } from "../../shared/hubOps";
import type {
  ArtifactReadResult, ArtifactResult, ArtifactSummary, ChatParticipant, Conversation, PublishedArtifactReadResult
} from "../../shared/types";
import { HubOps } from "../../hub/hubOps";
import { HubLog } from "../../hub/hubLog";
import { HubServer } from "../../hub/hubServer";
import { createArtifactToolDispatcher } from "../appToolWiring";
import { APP_ARTIFACT_CREATE_TOOL, APP_ARTIFACT_REVISE_TOOL, APP_ARTIFACT_SIGN_TOOL } from "./appMcp";
import { ArtifactClient } from "./artifactClient";
import { ArtifactService } from "./artifacts";
import { ArtifactStore } from "./artifactStore";
import { ChatService } from "./chat";
import { ChatEventLogService } from "./chatEventLog";
import { ChatSearchService } from "./chatSearch";
import { signHubRequest } from "./hubAuth";
import { ServerChatLink } from "./serverChatLink";
import { StorageService } from "./storage";

/**
 * Documents on the User's server (agreement Д9): a real server, the computer
 * and a cloud machine each with its own database, its own copy of the
 * documents and its own link to the server, and no other way between them.
 * Members' tool calls go through the same dispatcher the App MCP tools use.
 */

const desk: ChatParticipant = {
  id: "11111111-1111-4111-8111-111111111111", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code",
  permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
};
const remote: ChatParticipant = {
  id: "22222222-2222-4222-8222-222222222222", handle: "drew", roleConfigId: "software-engineer", kind: "codex-cli", homeMachineId: "box",
  permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
};

function trace(device: string, event: string, payload: Record<string, unknown>): void {
  if (process.env.ACCORD_TEST_TRACE) process.stderr.write(`${device} ${event} ${JSON.stringify(payload).slice(0, 300)}\n`);
}

function chatService(storage: StorageService, device: string): ChatService {
  const settings = {
    async getPublicSettings() {
      return { chatRoleConfigs: [], chatParticipantConfigs: [], providers: [{ kind: "claude-code", enabled: true }, { kind: "codex-cli", enabled: true }] };
    }
  };
  const cliRunner = { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; }, async closeConversationSessions() { return undefined; } };
  const chat = new ChatService(storage as never, settings as never, cliRunner as never, { async write(event: string, payload: Record<string, unknown>) { trace(device, event, payload); } } as never);
  (chat as unknown as { ensureHistoryFiles: () => Promise<string> }).ensureHistoryFiles = async () => tmpdir();
  return chat;
}

function documents(storage: StorageService, dbPath: string, chat: ChatService, device: string, serverWaitMs?: number): ArtifactClient {
  return new ArtifactClient({
    store: new ArtifactStore(dbPath),
    getMembers: async (conversationId) => {
      const opened = await storage.openConversation(conversationId, 1);
      return opened?.conversation.kind === "chat" ? artifactMembersForConversation(opened.conversation) : undefined;
    },
    postNote: (conversationId, eventId, content) => chat.postArtifactChatNote(conversationId, eventId, content),
    hasChat: async (conversationId) => (await storage.openConversation(conversationId, 1))?.conversation.kind === "chat",
    logger: (event, payload) => trace(device, event, payload),
    ...(serverWaitMs !== undefined ? { serverWaitMs } : {})
  });
}

function localChat(id: string): Conversation {
  const at = "2026-10-28T08:00:00.000Z";
  return {
    id, title: "Plans", kind: "chat", createdAt: at, updatedAt: at, findings: [],
    messages: [{ id: `${id}-start`, role: "system", content: "Chat started.", createdAt: at, status: "done" }],
    metadata: { participants: [desk, remote], participantSessions: [], running: false, warnings: [] }
  } as Conversation;
}

const save = (chat: ChatService, conversation: Conversation) => (chat as unknown as { saveConversation(c: Conversation): Promise<void> }).saveConversation(conversation);

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${String(JSON.stringify(value)).slice(0, 3_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function value<T>(result: unknown): T {
  const answer = result as ArtifactResult<T>;
  assert.ok(answer.ok, `expected success: ${JSON.stringify(answer)}`);
  return answer.value;
}

function published(result: unknown): PublishedArtifactReadResult {
  const read = value<ArtifactReadResult>(result);
  assert.equal(read.lifecycle, "published");
  return read as PublishedArtifactReadResult;
}

/** What happens to the computer's documents before it first links (the
 *  documents it held before the server owned them). */
type BeforeLink = (service: ArtifactService, desktopDb: string) => Promise<void>;

/**
 * Stands between the devices and the server. While `old` is set it plays a
 * server not updated yet: no document routes (404) and document operations
 * refused as unknown; everything else passes through unchanged.
 */
async function proxy(target: () => number) {
  const state = { old: true };
  const forward = (incoming: IncomingMessage, body: Buffer, answer: (status: number, text: string) => void) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port: target(), path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, "content-length": String(body.length) } }, (reply) => {
      const parts: Buffer[] = [];
      reply.on("data", (part: Buffer) => parts.push(part));
      reply.on("end", () => answer(reply.statusCode ?? 502, Buffer.concat(parts).toString("utf8")));
    });
    outgoing.on("error", () => answer(502, JSON.stringify({ ok: false, error: "unreachable" })));
    outgoing.end(body);
  };
  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const parts: Buffer[] = [];
    incoming.on("data", (part: Buffer) => parts.push(part));
    incoming.on("end", () => {
      const body = Buffer.concat(parts);
      const send = (status: number, text: string) => { response.writeHead(status, { "content-type": "application/json" }); response.end(text); };
      const pathname = (incoming.url ?? "").split("?")[0];
      if (state.old && (pathname === "/v3/artifacts" || pathname === "/v3/artifact")) return send(404, JSON.stringify({ ok: false, error: "Not found." }));
      if (state.old && pathname === "/v3/ops" && body.includes('"kind":"artifact.')) {
        const ops = (JSON.parse(body.toString("utf8")) as { ops: Array<{ opId: string; kind: string }> }).ops;
        if (ops.every((op) => op.kind.startsWith("artifact."))) {
          return send(200, JSON.stringify({ results: ops.map((op) => ({ opId: op.opId, status: "rejected", reason: "Unknown operation kind." })), head: 0 }));
        }
      }
      forward(incoming, body, send);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { state, port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function setup(t: test.TestContext, conversation: Conversation, options: { beforeLink?: BeforeLink; desktopWaitMs?: number; oldServer?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-server-artifacts-"));
  const desktopDb = path.join(dir, "desktop.sqlite3");
  const machineDb = path.join(dir, "machine.sqlite3");
  const desktopStorage = new StorageService({ dbPath: desktopDb });
  const desktopEvents = new ChatEventLogService(desktopStorage);
  const desktopIdentity = await desktopEvents.getOrCreateDeviceIdentity();
  const machineStorage = new StorageService({ dbPath: machineDb });
  const machineEvents = new ChatEventLogService(machineStorage);
  const machineIdentity = await machineEvents.getOrCreateDeviceIdentity();
  const hubStorage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3") });
  await hubStorage.init();
  await hubStorage.hub().setOwner({ deviceId: desktopIdentity.originId, publicKeyDerBase64: desktopIdentity.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  await hubStorage.hub().replaceRoster([{ deviceId: machineIdentity.originId, publicKeyDerBase64: machineIdentity.publicKeyDerBase64, role: "machine", name: "Box",
    machineId: "box", addedAt: "" }], new Date().toISOString());
  const ops = new HubOps(hubStorage, (event, payload) => trace("hub", event, payload));
  const serve = async (port = 0) => {
    const server = new HubServer({ hubId: "hub-test", version: "test", storage: hubStorage, log: new HubLog(hubStorage), search: new ChatSearchService(hubStorage), vapidPublicKey: "BPUB", ops });
    const http = await server.listenHttp(port, "127.0.0.1");
    return { server, port: (http.address() as AddressInfo).port };
  };
  let hub = await serve();
  const between = options.oldServer ? await proxy(() => hub.port) : undefined;
  const hubUrl = `http://127.0.0.1:${between ? between.port : hub.port}`;

  const desktopChat = chatService(desktopStorage, "desktop");
  const machineChat = chatService(machineStorage, "machine");
  machineChat.setHostMachineId("box");
  await save(desktopChat, conversation);
  if (options.beforeLink) {
    await options.beforeLink(new ArtifactService({
      store: new ArtifactStore(desktopDb),
      getMembers: async () => artifactMembersForConversation(conversation)
    }), desktopDb);
  }
  const desktopArtifacts = documents(desktopStorage, desktopDb, desktopChat, "desktop", options.desktopWaitMs);
  const machineArtifacts = documents(machineStorage, machineDb, machineChat, "machine");
  desktopChat.setArtifactCleanup((conversationId) => desktopArtifacts.deleteConversationArtifacts(conversationId));
  machineChat.setArtifactCleanup((conversationId) => machineArtifacts.deleteConversationArtifacts(conversationId));

  const desktopLink = new ServerChatLink({
    storage: desktopStorage, chat: desktopChat, identity: () => desktopEvents.getOrCreateDeviceIdentity(),
    hubConfig: async () => ({ url: hubUrl }), machineNames: async () => [{ id: "box", name: "Box" }],
    movesChats: true, artifacts: desktopArtifacts, log: (event, payload) => trace("desktop", event, payload)
  });
  const machineLink = new ServerChatLink({
    storage: machineStorage, chat: machineChat, identity: () => machineEvents.getOrCreateDeviceIdentity(),
    hubConfig: async () => ({ url: hubUrl }), machineNames: async () => [],
    movesChats: false, artifacts: machineArtifacts, log: (event, payload) => trace("machine", event, payload)
  });

  t.after(async () => {
    await machineLink.stop();
    await desktopLink.stop();
    await between?.close();
    await hub.server.close();
    await Promise.all([desktopChat.settleChatSaves(), machineChat.settleChatSaves()]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const page = async (conversationId: string): Promise<HubChatPage> => {
    const pathWithQuery = `/v3/chat?conversationId=${conversationId}`;
    const response = await fetch(`${hubUrl}${pathWithQuery}`, { headers: { authorization: signHubRequest(desktopIdentity, { method: "GET", pathWithQuery, body: "" }) } });
    return await response.json() as HubChatPage;
  };
  const desktopTool = createArtifactToolDispatcher(desktopArtifacts);
  const machineTool = createArtifactToolDispatcher(machineArtifacts);

  await desktopLink.start();
  // Linked once the chat (and its documents) are on the server.
  await until(() => page(conversation.id), (current) => Boolean(current.messages?.length));
  await until(async () => (await desktopLink.status())?.ready, (ready) => ready === true);
  await machineLink.start();
  await until(() => machineStorage.getConversation(conversation.id), (chat) => Boolean(chat));
  await until(async () => (await machineLink.status())?.ready, (ready) => ready === true);

  return {
    dir, hubStorage, ops, desktopStorage, machineStorage, desktopChat, machineChat, desktopArtifacts, machineArtifacts,
    desktopLink, machineLink, desktopIdentity, machineIdentity, page, desktopTool, machineTool, between,
    stopHub: async () => { await hub.server.close(); },
    startHub: async () => { hub = await serve(hub.port); }
  };
}

test("a member on the computer creates and revises a document, a member on a machine signs it, and the computer sees the signature under the version signed", async (t) => {
  const h = await setup(t, localChat("chat-a"));
  // @taylor runs on the computer: its tool calls go through the computer.
  const created = published(await h.desktopTool("taylor", "chat-a", APP_ARTIFACT_CREATE_TOOL, {
    name: "Spec", content: "Version one", requiredSigners: ["drew", "user"], contributors: ["drew"]
  }));
  const artifactId = created.summary.id;
  // The computer's own next read sees its change at once.
  assert.equal(value<ArtifactSummary[]>(await h.desktopArtifacts.list("taylor", "chat-a")).length, 1);
  const revised = published(await h.desktopTool("taylor", "chat-a", APP_ARTIFACT_REVISE_TOOL, {
    artifactId, baseVersion: 1, baseVersionEventId: created.version.versionEventId, content: "Version two"
  }));
  assert.equal(revised.version.version, 2);

  // The machine's copy follows the server; @drew reads v2 there and signs it.
  const onMachine = await until(() => h.machineArtifacts.read("drew", { conversationId: "chat-a", artifactId }),
    (read) => read.ok && read.value.summary.headVersion === 2);
  const v2 = (onMachine as { ok: true; value: PublishedArtifactReadResult }).value.version;
  assert.equal(v2.content, "Version two");
  assert.equal(v2.versionEventId, revised.version.versionEventId, "the same revision identity on every device");
  assert.equal(v2.contentHash, revised.version.contentHash);
  const signed = value<ArtifactSummary>(await h.machineTool("drew", "chat-a", APP_ARTIFACT_SIGN_TOOL, {
    artifactId, version: 2, versionEventId: v2.versionEventId, contentHash: v2.contentHash
  }));
  assert.deepEqual(signed.approval.signedCurrent, ["drew"]);

  // The computer sees @drew's signature under v2, and none under v1.
  const onDesktop = await until(() => h.desktopArtifacts.read("user", { conversationId: "chat-a", artifactId, includeHistory: true }),
    (read) => read.ok && read.value.summary.approval.signedCurrent.includes("drew"));
  const read = (onDesktop as { ok: true; value: PublishedArtifactReadResult }).value;
  assert.deepEqual(read.version.signatures.map((signature) => [signature.signer, signature.versionEventId, signature.contentHash]),
    [["drew", revised.version.versionEventId, revised.version.contentHash]]);
  assert.deepEqual(read.history?.map((meta) => [meta.version, meta.signatures.map((signature) => signature.signer)]), [[1, []], [2, ["drew"]]]);
  assert.equal(read.summary.approval.state, "partially-signed", "the User has not signed yet");

  // Each change's chat note was written by the device that acted.
  const notes = await until(() => h.page("chat-a"), (current) => current.messages.filter((message) => message.metadata?.artifactEventId).length === 3);
  const byText = (pattern: RegExp) => notes.messages.find((message) => message.metadata?.artifactEventId && pattern.test(message.content));
  assert.equal(byText(/created artifact/)?.metadata?.serverWriter, h.desktopIdentity.originId);
  assert.equal(byText(/revised .*v2/)?.metadata?.serverWriter, h.desktopIdentity.originId);
  assert.equal(byText(/@drew signed .*v2/)?.metadata?.serverWriter, h.machineIdentity.originId);
  // And every device shows each note once.
  for (const storage of [h.desktopStorage, h.machineStorage]) {
    const chat = await until(() => storage.getConversation("chat-a"), (current) =>
      (current?.messages.filter((message) => message.metadata?.artifactEventId).length ?? 0) === 3);
    assert.equal(new Set(chat!.messages.map((message) => message.metadata?.artifactEventId).filter(Boolean)).size, 3);
  }
});

test("a stale revision is refused on both devices, with the current version to redo it on", async (t) => {
  const h = await setup(t, localChat("chat-b"));
  const created = published(await h.desktopArtifacts.create("user", {
    conversationId: "chat-b", name: "Plan", content: "Base", contributors: ["taylor", "drew"]
  }));
  const artifactId = created.summary.id;
  await until(() => h.machineArtifacts.read("drew", { conversationId: "chat-b", artifactId }), (read) => read.ok);
  // Both hold v1. The machine's member revises first.
  published(await h.machineTool("drew", "chat-b", APP_ARTIFACT_REVISE_TOOL, { artifactId, baseVersion: 1, content: "Machine edit" }));
  // The computer's member, still on v1, is refused by the server.
  const stale = await h.desktopTool("taylor", "chat-b", APP_ARTIFACT_REVISE_TOOL, { artifactId, baseVersion: 1, content: "Desk edit" }) as ArtifactResult<unknown>;
  assert.equal(stale.ok, false);
  assert.equal(!stale.ok && stale.error.code, "stale_version");
  assert.equal(!stale.ok && stale.error.currentVersion, 2);
  assert.equal(!stale.ok && stale.error.current?.content, "Machine edit");
  // And the machine's member, asking again on v1, is refused the same way.
  const again = await h.machineTool("drew", "chat-b", APP_ARTIFACT_REVISE_TOOL, { artifactId, baseVersion: 1, content: "Second machine edit" }) as ArtifactResult<unknown>;
  assert.equal(!again.ok && again.error.code, "stale_version");
  // Nothing of either refused edit is anywhere.
  const head = await until(() => h.desktopArtifacts.read("user", { conversationId: "chat-b", artifactId }), (read) => read.ok && read.value.summary.headVersion === 2);
  assert.equal((head as { ok: true; value: PublishedArtifactReadResult }).value.version.content, "Machine edit");
  assert.equal((await h.ops.artifacts.store.getById(artifactId))?.headVersion, 2);
  // Redone on v2, the computer's edit is v3 everywhere.
  published(await h.desktopTool("taylor", "chat-b", APP_ARTIFACT_REVISE_TOOL, { artifactId, baseVersion: 2, content: "Desk edit on v2" }));
  await until(() => h.machineArtifacts.read("drew", { conversationId: "chat-b", artifactId }), (read) => read.ok && read.value.summary.headVersion === 3);
});

test("a machine never acts as the User or for a member of the computer", async (t) => {
  const h = await setup(t, localChat("chat-c"));
  const asUser = await h.machineArtifacts.create("user", { conversationId: "chat-c", name: "Forged", content: "x" });
  assert.equal(!asUser.ok && asUser.error.code, "access_denied");
  const asDesk = await h.machineArtifacts.create("taylor", { conversationId: "chat-c", name: "Forged", content: "x" });
  assert.equal(!asDesk.ok && asDesk.error.code, "access_denied");
  const asDrewOnDesktop = await h.desktopArtifacts.create("drew", { conversationId: "chat-c", name: "Forged", content: "x" });
  assert.equal(!asDrewOnDesktop.ok && asDrewOnDesktop.error.code, "access_denied", "the computer does not act for a member on a machine either");
  assert.deepEqual(await h.ops.artifacts.store.listByConversation("chat-c"), []);
});

test("the one-time move carries the computer's documents to the server intact, and every device then holds them", async (t) => {
  let before: Awaited<ReturnType<ArtifactStore["exportConversation"]>> | undefined;
  const h = await setup(t, localChat("chat-d"), {
    beforeLink: async (service, desktopDb) => {
      // Documents the computer held before the server owned them: a published
      // one with two versions and signatures on both, and one collecting drafts.
      const plan = published(await service.create("user", { conversationId: "chat-d", name: "Plan", content: "One", requiredSigners: ["user", "taylor"] }));
      value(await service.sign("user", { conversationId: "chat-d", artifactId: plan.summary.id }));
      published(await service.revise("user", { conversationId: "chat-d", artifactId: plan.summary.id, baseVersion: 1, content: "Two" }));
      value(await service.sign("taylor", { conversationId: "chat-d", artifactId: plan.summary.id, version: 2 }));
      const collecting = value<ArtifactReadResult>(await service.create("user", {
        conversationId: "chat-d", name: "Ideas", initialState: "collecting_drafts", operationId: "collect-1",
        allowedDraftAuthors: ["taylor", "drew"], requiredDraftAuthors: ["taylor"],
        audiencePolicyByAuthor: { taylor: { allowedReaders: ["drew"], requiredReaders: [] }, drew: { allowedReaders: [], requiredReaders: [] } }
      }));
      const draft = value<{ id: string; editRevision: number }>(await service.saveDraft("taylor", {
        conversationId: "chat-d", artifactId: collecting.summary.id, expectedEditRevision: 0, content: "Taylor's idea", readers: ["drew"], operationId: "draft-1"
      }));
      value(await service.submitDraft("taylor", { conversationId: "chat-d", artifactId: collecting.summary.id, draftId: draft.id, expectedEditRevision: 1, operationId: "submit-1" }));
      before = await new ArtifactStore(desktopDb).exportConversation("chat-d");
    }
  });
  assert.ok(before);
  assert.equal(before.artifacts.length, 2);
  assert.equal(before.revisions.length, 2);
  assert.equal(before.signatures.length, 2);
  assert.equal(before.drafts.length, 1);
  assert.ok(before.operations.length >= 3);
  // The server holds exactly what the computer held.
  const onServer = await h.ops.artifacts.store.exportConversation("chat-d");
  const strip = (rows: typeof onServer) => ({ ...rows, artifacts: rows.artifacts.map((record) => ({ ...record })) });
  assert.deepEqual(strip(onServer), strip(before), "ids, revision ids and hashes, numbering, signatures, drafts and operations moved intact");
  // Every device holds them as the server does.
  const onMachine = await until(() => new ArtifactStore(path.join(h.dir, "machine.sqlite3")).exportConversation("chat-d"),
    (rows) => rows.artifacts.length === 2 && rows.signatures.length === 2);
  assert.deepEqual({ ...onMachine, operations: [] }, { ...before, operations: [] }, "operations stay on the server");
  const onDesktop = await new ArtifactStore(path.join(h.dir, "desktop.sqlite3")).exportConversation("chat-d");
  assert.deepEqual({ ...onDesktop, operations: [] }, { ...before, operations: [] });
  // A moved operation keeps answering the same: the same draft submitted
  // again with its id returns the original answer, not a refusal.
  const ideas = before.artifacts.find((record) => record.name === "Ideas")!;
  const retried = await h.desktopArtifacts.submitDraft("taylor", {
    conversationId: "chat-d", artifactId: ideas.id, draftId: before.drafts[0].id, expectedEditRevision: 1, operationId: "submit-1"
  });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  // And the move is not done twice: a restart of the link moves nothing more.
  const head = await h.ops.head();
  await h.desktopLink.stop();
  await h.desktopLink.start();
  await until(async () => (await h.desktopLink.status())?.ready, (ready) => ready === true);
  assert.equal(await h.ops.head(), head);
});

test("with the server unreachable a document change is not made and is said so; it is never sent later (Д13)", async (t) => {
  const h = await setup(t, localChat("chat-e"), { desktopWaitMs: 1_500 });
  await h.stopHub();
  const started = Date.now();
  const result = await h.desktopArtifacts.create("user", { conversationId: "chat-e", name: "Offline", content: "Not yet" });
  assert.equal(!result.ok && result.error.code, "server_unavailable", JSON.stringify(result));
  assert.ok(Date.now() - started < 20_000, "the caller is answered, not left waiting");
  assert.equal(value<ArtifactSummary[]>(await h.desktopArtifacts.list("user", "chat-e")).length, 0, "nothing shown as made here");
  assert.equal((await h.desktopStorage.hubClientOps().forConversation("chat-e")).filter((row) => row.kind.startsWith("artifact.")).length, 0,
    "the action was taken back, not left queued");
  // The server comes back: what was taken back never arrives.
  await h.startHub();
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.deepEqual(await h.ops.artifacts.store.listByConversation("chat-e"), []);
  // And the next change goes through.
  published(await h.desktopArtifacts.create("user", { conversationId: "chat-e", name: "Online", content: "Now" }));
});

test("a deleted chat's documents go from the server and from every device", async (t) => {
  const h = await setup(t, localChat("chat-f"));
  const created = published(await h.desktopArtifacts.create("user", { conversationId: "chat-f", name: "Doomed", content: "Soon gone" }));
  await until(() => h.machineArtifacts.read("drew", { conversationId: "chat-f", artifactId: created.summary.id }), (read) => read.ok);
  await h.desktopChat.setArchived({ conversationId: "chat-f", archived: true });
  assert.equal(await h.desktopChat.deleteConversation({ conversationId: "chat-f" }), true);
  await until(async () => h.ops.artifacts.store.getById(created.summary.id), (record) => record === undefined);
  await until(async () => new ArtifactStore(path.join(h.dir, "machine.sqlite3")).getById(created.summary.id), (record) => record === undefined);
  assert.equal(await new ArtifactStore(path.join(h.dir, "desktop.sqlite3")).getById(created.summary.id), undefined);
});

test("a device that lost its place in the feed reads every chat's documents again", async (t) => {
  const h = await setup(t, localChat("chat-g"));
  const created = published(await h.desktopArtifacts.create("user", { conversationId: "chat-g", name: "Kept", content: "One" }));
  await until(() => h.machineArtifacts.read("drew", { conversationId: "chat-g", artifactId: created.summary.id }), (read) => read.ok);
  await h.machineLink.stop();
  // Meanwhile the document changes, and the machine's copy is damaged.
  published(await h.desktopArtifacts.revise("user", { conversationId: "chat-g", artifactId: created.summary.id, baseVersion: 1, content: "Two" }));
  const machineStore = new ArtifactStore(path.join(h.dir, "machine.sqlite3"));
  await machineStore.applyServerStates("chat-g", [], new Map(), { replaceConversation: true });
  assert.equal(await machineStore.getById(created.summary.id), undefined);
  // Its place is forgotten: it reads everything again.
  await h.machineStorage.hub().setClientState("ops-cursor", "not-a-number");
  await h.machineLink.start();
  const read = await until(() => h.machineArtifacts.read("drew", { conversationId: "chat-g", artifactId: created.summary.id }),
    (current) => current.ok && current.value.summary.headVersion === 2);
  assert.equal((read as { ok: true; value: PublishedArtifactReadResult }).value.version.content, "Two");
});

test("a server not updated yet never makes the computer lose its documents: the chats link, and the documents move once it is", async (t) => {
  let planId = "";
  const h = await setup(t, localChat("chat-h"), {
    oldServer: true,
    beforeLink: async (service) => {
      planId = published(await service.create("user", { conversationId: "chat-h", name: "Plan", content: "Held here" })).summary.id;
    }
  });
  // The chats are linked; the documents stay here as they were.
  assert.equal((await h.desktopLink.status())?.ready, true);
  const kept = await h.desktopArtifacts.read("user", { conversationId: "chat-h", artifactId: planId });
  assert.equal(kept.ok && kept.value.lifecycle === "published" && kept.value.version.content, "Held here");
  assert.equal(await h.ops.artifacts.store.getById(planId), undefined);
  // A change is refused by that server, said plainly, and nothing changes here.
  const refused = await h.desktopArtifacts.revise("user", { conversationId: "chat-h", artifactId: planId, baseVersion: 1, content: "x" });
  assert.equal(refused.ok, false);
  assert.equal((await new ArtifactStore(path.join(h.dir, "desktop.sqlite3")).getById(planId))?.headVersion, 1);
  // The server is updated: the documents move, intact, and every device holds them.
  h.between!.state.old = false;
  await until(async () => h.ops.artifacts.store.getById(planId), (record) => record?.name === "Plan", 30_000);
  const onMachine = await until(() => h.machineArtifacts.read("drew", { conversationId: "chat-h", artifactId: planId }), (read) => read.ok, 30_000);
  assert.equal((onMachine as { ok: true; value: PublishedArtifactReadResult }).value.version.content, "Held here");
  published(await h.desktopArtifacts.revise("user", { conversationId: "chat-h", artifactId: planId, baseVersion: 1, content: "Changed" }));
});

test("a document action still queued when the device stopped is never sent when it starts again", async (t) => {
  const h = await setup(t, localChat("chat-i"));
  await h.machineLink.stop();
  // As a run that ended left it: written, never sent, nobody waiting.
  await h.machineStorage.hubClientOps().enqueue([{ opId: "op-left-behind", kind: "artifact.create", conversationId: "chat-i", actor: "drew",
    request: { conversationId: "chat-i", name: "Ghost", content: "never" } } as never], new Date().toISOString());
  await h.machineLink.start();
  await until(async () => (await h.machineLink.status())?.ready, (ready) => ready === true);
  assert.equal(await h.machineStorage.hubClientOps().get("op-left-behind"), undefined, "taken back at start");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.deepEqual(await h.ops.artifacts.store.listByConversation("chat-i"), []);
});
