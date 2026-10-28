import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_SCRIPTS_REQUEST_CHANGE_TOOL, APP_TOOL_PERMISSION_TOOL } from "../../shared/appMcpToolContracts";
import { choiceCardId, mentionCardId, type HubMentionCardPayload } from "../../shared/hubCards";
import type { HubCard, HubFeedResponse, HubOp } from "../../shared/hubOps";
import { controlCardFromHubCard } from "../../shared/mobileControlCards";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import { HubOps } from "../../hub/hubOps";
import { HubServer } from "../../hub/hubServer";
import { ChatService } from "./chat";
import { MachineChoiceExecutor, MachineMentionExecutor } from "./chatActionNativeClaims";
import { DeviceIdentityService, createDeviceIdentity } from "./deviceIdentity";
import { ChatSearchService } from "./chatSearch";
import { HubClient } from "./hubClient";
import { signHubRequest, type HubSigningIdentity } from "./hubAuth";
import { MachineApprovalExecutor, SCRIPT_CODE_APPROVED_ON_DESKTOP, cardAnswerKey } from "./machineApprovalExecutor";
import { ServerChatLink } from "./serverChatLink";
import { StorageService } from "./storage";

/**
 * Cards a member waits on, on the User's server (agreement Д9): a real
 * server, the computer's and a cloud machine's ChatService (each with its own
 * storage and link), and a phone that writes to the server as the phone app
 * does. The device a member runs on raises its cards, applies the first
 * answer (from any device) once, and settles them. Members' CLIs are played
 * by the test.
 */

const desk: ChatParticipant = {
  id: "11111111-1111-4111-8111-111111111111", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code",
  permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
};
const remote: ChatParticipant = {
  id: "22222222-2222-4222-8222-222222222222", handle: "drew", roleConfigId: "software-engineer", kind: "codex-cli", homeMachineId: "box",
  permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
};

/** ACCORD_TEST_TRACE=1 prints what the links do. */
const started = Date.now();
function trace(device: string, event: string, payload: Record<string, unknown>): void {
  if (process.env.ACCORD_TEST_TRACE) process.stderr.write(`${Date.now() - started}ms ${device} ${event} ${JSON.stringify(payload).slice(0, 300)}\n`);
}

interface Turn { device: "desktop" | "machine"; participantId: string; triggerId: string; runId: string }

function chatService(storage: StorageService, turns: Turn[], device: Turn["device"]): ChatService {
  const settings = {
    async getPublicSettings() {
      return { chatRoleConfigs: [], chatParticipantConfigs: [], providers: [{ kind: "claude-code", enabled: true }, { kind: "codex-cli", enabled: true }] };
    }
  };
  const cliRunner = { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; }, async closeConversationSessions() { return undefined; },
    async closeWarmAgents() { return undefined; } };
  const chat = new ChatService(storage as never, settings as never, cliRunner as never, { async write(event: string, payload: Record<string, unknown>) { trace(device, event, payload); } } as never);
  (chat as unknown as { ensureHistoryFiles: () => Promise<string> }).ensureHistoryFiles = async () => tmpdir();
  (chat as unknown as { runParticipantTurn: (...args: unknown[]) => Promise<ChatMessage[]> }).runParticipantTurn = async (_conversation, participant, trigger, runId, _signal, _progress, options) => {
    turns.push({ device, participantId: (participant as ChatParticipant).id, triggerId: (trigger as ChatMessage).id, runId: runId as string });
    const existing = (options as { existingPendingMessage?: ChatMessage }).existingPendingMessage;
    const reply: ChatMessage = existing ?? {
      id: randomUUID(), role: "participant", participantId: (participant as ChatParticipant).id, participantLabel: `@${(participant as ChatParticipant).handle}`,
      content: "", createdAt: new Date().toISOString(), status: "pending", metadata: { runId: runId as string }
    } as ChatMessage;
    reply.content = `${device} reply to ${(trigger as ChatMessage).content}`;
    reply.status = "done";
    return [reply];
  };
  return chat;
}

const runtime = (name: string) => {
  const identity = { runtimeId: `${name}-${randomUUID()}`, pid: process.pid, startedAt: "test-start" };
  return async () => identity;
};

function appliers(storage: StorageService, chat: ChatService, codeApprover: string, name: string) {
  const runtimeIdentity = runtime(name);
  return {
    approval: new MachineApprovalExecutor({ storage, chat, runtimeIdentity, codeApprover: () => codeApprover }),
    choice: new MachineChoiceExecutor({ storage, chat, runtimeIdentity }),
    mention: new MachineMentionExecutor({ storage, chat, runtimeIdentity })
  };
}

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-cards-"));
  const desktopStorage = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  const desktopEvents = new DeviceIdentityService(desktopStorage);
  const desktopIdentity = await desktopEvents.getOrCreateDeviceIdentity();
  const machineStorage = new StorageService({ dbPath: path.join(dir, "machine.sqlite3") });
  const machineEvents = new DeviceIdentityService(machineStorage);
  const machineIdentity = await machineEvents.getOrCreateDeviceIdentity();
  const phone = createDeviceIdentity(new Date().toISOString());
  const hubStorage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3") });
  await hubStorage.init();
  await hubStorage.hub().setOwner({ deviceId: desktopIdentity.originId, publicKeyDerBase64: desktopIdentity.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  await hubStorage.hub().replaceRoster([
    { deviceId: machineIdentity.originId, publicKeyDerBase64: machineIdentity.publicKeyDerBase64, role: "machine", name: "Box", machineId: "box", addedAt: "" },
    { deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "Phone", scope: { scope: "device" }, inviteId: "invite-1", addedAt: "" }
  ], new Date().toISOString());
  const ops = new HubOps(hubStorage, (event, payload) => trace("hub", event, payload));
  const hubServer = new HubServer({ hubId: "hub-test", version: "test", storage: hubStorage, search: new ChatSearchService(hubStorage), vapidPublicKey: "BPUB", ops });
  const http = await hubServer.listenHttp(0, "127.0.0.1");
  const hubUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  const turns: Turn[] = [];
  const desktopChat = chatService(desktopStorage, turns, "desktop");
  const machineChat = chatService(machineStorage, turns, "machine");
  const desktopAppliers = appliers(desktopStorage, desktopChat, desktopIdentity.originId, "desktop");
  const machineAppliers = appliers(machineStorage, machineChat, desktopIdentity.originId, "machine");
  desktopChat.setCardAppliers(async () => desktopAppliers);
  machineChat.setCardAppliers(async () => machineAppliers);
  const scripts = { applied: 0, rejected: 0 };
  desktopChat.setScriptHost({
    async assertApprovable() { return undefined; },
    async applyApproved() { scripts.applied += 1; return "Saved the script."; },
    async rejectPending() { scripts.rejected += 1; }
  } as never);
  const link = (storage: StorageService, chat: ChatService, events: DeviceIdentityService, device: string, movesChats: boolean) => new ServerChatLink({
    storage, chat, identity: () => events.getOrCreateDeviceIdentity(), hubConfig: async () => ({ url: hubUrl }),
    machineNames: async () => [{ id: "box", name: "Box" }], movesChats, log: (event, payload) => trace(device, event, payload)
  });
  const desktopLink = link(desktopStorage, desktopChat, desktopEvents, "desktop", true);
  const machineLink = link(machineStorage, machineChat, machineEvents, "machine", false);
  const links = [desktopLink, machineLink];
  const phoneHub = new HubClient({ url: hubUrl, identity: async () => phone });

  t.after(async () => {
    for (const item of links) await item.stop();
    await hubServer.close();
    await Promise.all([desktopChat.settleChatSaves(), machineChat.settleChatSaves()]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const call = async <T>(who: HubSigningIdentity, method: string, pathWithQuery: string): Promise<T> => {
    const response = await fetch(`${hubUrl}${pathWithQuery}`, { method, headers: { authorization: signHubRequest(who, { method, pathWithQuery, body: "" }) } });
    return await response.json() as T;
  };
  const card = (cardId: string) => hubStorage.hubOps().card(cardId);
  /** The phone answers a card, as the phone app writes it. */
  const phoneAnswers = async (conversationId: string, cardId: string, answer: Record<string, unknown>) => {
    const op: HubOp = { opId: `op-${randomUUID()}`, kind: "card.answer", conversationId, cardId, answer };
    const response = await phoneHub.writeOps([op]);
    return { opId: op.opId, result: response.results[0] };
  };
  const startMachine = async () => {
    machineChat.setHostMachineId("box");
    await machineLink.start();
  };
  return { hubStorage, hubUrl, desktopStorage, machineStorage, desktopChat, machineChat, desktopLink, machineLink, links, desktopIdentity, machineIdentity, desktopEvents, machineEvents,
    phone, turns, scripts, call, card, phoneAnswers, startMachine, link };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value).slice(0, 3_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const at = "2026-10-28T08:00:00.000Z";

function chat(id: string, extra: Partial<Conversation["metadata"]> = {}, messages: ChatMessage[] = []): Conversation {
  return {
    id, title: "Plans", kind: "chat", createdAt: at, updatedAt: at, findings: [],
    messages: [{ id: `${id}-start`, role: "system", content: "Chat started.", createdAt: at, status: "done" }, ...messages],
    metadata: { participants: [desk, remote], participantSessions: [], running: false, warnings: [], ...extra }
  } as Conversation;
}

function toolApproval(id: string, requester: ChatParticipant, conversationId: string): ChatAppToolApproval {
  return {
    id, conversationId, requesterParticipantId: requester.id, requesterHandle: requester.handle, requesterRoleConfigId: requester.roleConfigId,
    toolName: APP_TOOL_PERMISSION_TOOL, capability: "permissions.request", status: "pending",
    request: { kind: "toolPermission", toolName: "Bash", agentMode: "default" }, summary: "Use Bash", createdAt: at, updatedAt: at
  } as unknown as ChatAppToolApproval;
}

function scriptApproval(id: string, conversationId: string): ChatAppToolApproval {
  return {
    id, conversationId, requesterParticipantId: desk.id, requesterHandle: desk.handle, requesterRoleConfigId: desk.roleConfigId,
    toolName: APP_SCRIPTS_REQUEST_CHANGE_TOOL, capability: "scripts.request", status: "pending",
    request: {
      kind: "script-change", op: "create", scriptId: "script-1", name: "Watcher", description: "Checks a feed.", hostId: "desktop", hostLabel: "This computer",
      hostPhrase: "on this computer", runtime: "node", entry: "main.js", schedule: { kind: "interval", minutes: 5 }, scheduleText: "every 5 minutes",
      timeoutSeconds: 60, secretNames: [], permissions: { chatIds: [conversationId], participantIds: [desk.id] }, chatLabels: {}, participantLabels: {},
      fileCount: 1, totalBytes: 10
    },
    summary: "Set up the script Watcher", createdAt: at, updatedAt: at
  } as unknown as ChatAppToolApproval;
}

const save = (service: ChatService, conversation: Conversation) => (service as unknown as { saveConversation(c: Conversation): Promise<void> }).saveConversation(conversation);
const approvalOf = async (storage: StorageService, conversationId: string, approvalId: string) =>
  ((await storage.getConversation(conversationId))?.metadata.pendingAppToolApprovals as ChatAppToolApproval[] | undefined)?.find((item) => item.id === approvalId);
const allowedLines = async (storage: StorageService, conversationId: string) =>
  (await storage.getConversation(conversationId))?.messages.filter((message) => message.role === "system" && message.content.startsWith("Allowed @taylor to use Bash")).length ?? 0;

async function linkedDesktop(t: test.TestContext, conversation: Conversation) {
  const h = await setup(t);
  await save(h.desktopChat, conversation);
  await h.desktopLink.start();
  await until(() => h.call<{ messages?: unknown[] }>(h.desktopIdentity, "GET", `/v3/chat?conversationId=${conversation.id}`), (page) => Boolean(page.messages?.length));
  return h;
}

test("a desktop member's approval is raised on the server, answered from the phone and applied once on the desktop; a second answer is refused", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-a", { pendingAppToolApprovals: [toolApproval(approvalId, desk, "cards-a")] } as never));
  const raised = await until(() => h.card(approvalId), (item) => item?.state === "pending");
  assert.equal(raised!.raisedBy, h.desktopIdentity.originId, "raised by the device its member runs on");
  assert.equal(raised!.cardKind, "permission");
  assert.equal(raised!.participantId, desk.id);
  assert.equal(controlCardFromHubCard(raised!)?.status, "pending", "the phone shows it to answer");

  const answered = await h.phoneAnswers("cards-a", approvalId, { approve: true });
  assert.equal(answered.result.status, "accepted");
  const settled = await until(() => h.card(approvalId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  assert.equal((await approvalOf(h.desktopStorage, "cards-a", approvalId))?.status, "approved");
  assert.equal(await allowedLines(h.desktopStorage, "cards-a"), 1, "applied once");
  const claim = await h.desktopStorage.nativeCommands().approvalEffect("cards-a", approvalId);
  assert.equal(claim?.eventId, cardAnswerKey(settled!), "claimed once, by that answer");

  const second = await h.phoneAnswers("cards-a", approvalId, { approve: false });
  assert.equal(second.result.status, "rejected", "the first answer is the one");
  assert.match((second.result as { reason: string }).reason, /already answered/);
  // Read again (a reconnect): nothing is applied twice.
  await h.desktopChat.resumeServerCards();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await allowedLines(h.desktopStorage, "cards-a"), 1);
  // The desktop's own card answered again is refused with the server's (or
  // its own) word, never applied.
  await assert.rejects(h.desktopChat.answerAppToolApprovalCard({ conversationId: "cards-a", approvalId, approve: true }), /already been answered/);
});

test("an answer given while the member's computer was off is applied once when it starts again; one that crossed its point of no return is not repeated", async (t) => {
  const first = randomUUID();
  const second = randomUUID();
  const h = await linkedDesktop(t, chat("cards-b", { pendingAppToolApprovals: [toolApproval(first, desk, "cards-b"), toolApproval(second, desk, "cards-b")] } as never));
  await until(() => Promise.all([h.card(first), h.card(second)]), (cards) => cards.every((item) => item?.state === "pending"));
  // The computer stops; the User answers both on the phone meanwhile.
  await h.desktopLink.stop();
  assert.equal((await h.phoneAnswers("cards-b", first, { approve: true })).result.status, "accepted");
  assert.equal((await h.phoneAnswers("cards-b", second, { approve: true })).result.status, "accepted");
  // The runtime that stopped had taken the second answer to the provider
  // already, and never confirmed it: its claim is on disk.
  const secondCard = await h.card(second);
  await h.desktopStorage.nativeCommands().claimApproval({ conversationId: "cards-b", approvalId: second, participantId: desk.id,
    eventId: cardAnswerKey(secondCard!), runtimeId: "the-runtime-that-stopped", pid: 1, startedAt: "earlier" });
  // It starts again: a new process, the same storage.
  const turns: Turn[] = [];
  const restarted = chatService(h.desktopStorage, turns, "desktop");
  const restartedAppliers = appliers(h.desktopStorage, restarted, h.desktopIdentity.originId, "desktop-2");
  restarted.setCardAppliers(async () => restartedAppliers);
  const link = h.link(h.desktopStorage, restarted, h.desktopEvents, "desktop-2", true);
  h.links.push(link);
  await link.start();
  const done = await until(() => Promise.all([h.card(first), h.card(second)]), (cards) => cards.every((item) => item?.state === "settled"));
  assert.equal((done[0]!.outcome as { result?: string }).result, "applied");
  assert.equal((await approvalOf(h.desktopStorage, "cards-b", first))?.status, "approved");
  assert.equal((done[1]!.outcome as { result?: string }).result, "uncertain", "said as not confirmed");
  const stuck = await approvalOf(h.desktopStorage, "cards-b", second);
  assert.equal(stuck?.status, "cancelled", "closed, never asked again");
  assert.match(stuck?.error ?? "", /not repeated/);
  assert.equal(await allowedLines(h.desktopStorage, "cards-b"), 1, "only the first was applied, once");
  // Started again: nothing more.
  await restarted.resumeServerCards();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await allowedLines(h.desktopStorage, "cards-b"), 1);
  assert.deepEqual((await h.call<{ cards: HubCard[] }>(h.desktopIdentity, "GET", "/v3/cards?conversationId=cards-b")).cards, [], "nothing left open");
});

test("the phone's approval of a script that installs code is refused, the card asked again with why; the desktop's approval applies it once", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-c", { pendingAppToolApprovals: [scriptApproval(approvalId, "cards-c")] } as never));
  await until(() => h.card(approvalId), (item) => item?.state === "pending");
  const phoneAnswer = await h.phoneAnswers("cards-c", approvalId, { approve: true });
  assert.equal(phoneAnswer.result.status, "accepted", "the server takes any device's answer");
  // Refused where the member runs: settled with why, then asked again.
  const again = await until(() => h.card(approvalId), (item) => item?.state === "pending" && Array.isArray((item.card as { refusals?: unknown[] }).refusals));
  const refusals = (again!.card as { refusals: Array<{ operationId: string; reason: string }> }).refusals;
  assert.deepEqual(refusals.map((item) => [item.operationId, item.reason]), [[phoneAnswer.opId, SCRIPT_CODE_APPROVED_ON_DESKTOP]]);
  assert.equal(again!.answer, undefined);
  const shown = controlCardFromHubCard(again!);
  assert.deepEqual(shown?.refusedAnswers, [{ operationId: phoneAnswer.opId, reason: SCRIPT_CODE_APPROVED_ON_DESKTOP }], "the phone that sent it says why");
  assert.equal(h.scripts.applied, 0, "nothing was installed");
  const feed = await h.call<HubFeedResponse>(h.desktopIdentity, "GET", "/v3/feed?after=0");
  const refusedSettle = feed.entries.find((entry) => entry.effect.kind === "card.settle" && entry.effect.card.cardId === approvalId);
  assert.equal(((refusedSettle?.effect as { card: HubCard }).card.outcome as { result?: string; answerOpId?: string }).result, "refused");
  const local = await approvalOf(h.desktopStorage, "cards-c", approvalId);
  assert.equal(local?.status, "pending", "still waiting for the desktop");
  assert.equal(local?.cardRefusals?.[0].reason, SCRIPT_CODE_APPROVED_ON_DESKTOP, "the desktop card says why too");
  // The desktop approves it, where the code is shown.
  await h.desktopChat.answerAppToolApprovalCard({ conversationId: "cards-c", approvalId, approve: true });
  assert.equal(h.scripts.applied, 1, "applied once, before the answer returned");
  assert.equal((await approvalOf(h.desktopStorage, "cards-c", approvalId))?.status, "approved");
  await until(() => h.card(approvalId), (item) => item?.state === "settled");
  assert.equal(h.scripts.applied, 1);
});

test("a machine member's choice answered on the desktop is applied once on the machine; the desktop never writes the machine's message", async (t) => {
  const h = await linkedDesktop(t, chat("cards-d"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-d"), (item) => Boolean(item));
  // The machine's member asks the User a choice in its reply.
  const machineCopy = (await h.machineStorage.getConversation("cards-d"))!;
  const asking: ChatMessage = {
    id: "choice-message", role: "participant", participantId: remote.id, participantLabel: "@drew", content: "Which store?", createdAt: new Date().toISOString(),
    status: "done", metadata: { pendingChoice: { id: "choice-1", title: "Store", question: "Which store?", status: "pending",
      options: [{ id: "sqlite", label: "SQLite" }, { id: "files", label: "Files" }] } }
  } as ChatMessage;
  machineCopy.messages.push(asking);
  await save(h.machineChat, machineCopy);
  const cardId = choiceCardId("choice-message");
  const raised = await until(() => h.card(cardId), (item) => item?.state === "pending");
  assert.equal(raised!.raisedBy, h.machineIdentity.originId, "raised by the machine its member runs on");
  // The desktop shows the choice and answers it through its card.
  await until(() => h.desktopStorage.getConversation("cards-d"), (item) => item?.messages.some((message) => message.metadata?.pendingChoice?.status === "pending") ?? false);
  await h.desktopChat.answerChoiceCard({ conversationId: "cards-d", sourceMessageId: "choice-message", choiceId: "choice-1", selectedOptionId: "files" });
  // Returned once the server took it and this copy shows it: never asked again meanwhile.
  const shownRight = (await h.desktopStorage.getConversation("cards-d"))?.messages.find((message) => message.id === "choice-message");
  assert.ok(shownRight?.metadata?.serverCard?.state === "answered" || shownRight?.metadata?.pendingChoice?.status === "selected",
    "the desktop shows its answer as soon as the answer returns");
  const settled = await until(() => h.card(cardId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  assert.equal(settled!.answeredBy, h.desktopIdentity.originId);
  await until(async () => h.turns, (turns) => turns.length === 1);
  assert.deepEqual(h.turns.map((turn) => [turn.device, turn.participantId]), [["machine", remote.id]], "the member continued once, on its machine");
  // Only the machine changed its member's message, on the server.
  const feed = await h.call<HubFeedResponse>(h.desktopIdentity, "GET", "/v3/feed?after=0");
  const writes = feed.entries.filter((entry) => (entry.effect.kind === "message.create" || entry.effect.kind === "message.update") &&
    entry.effect.message.id === "choice-message");
  assert.ok(writes.length >= 2, "written and then answered");
  assert.ok(writes.every((entry) => entry.deviceId === h.machineIdentity.originId), "never written by the desktop");
  const page = await h.call<{ messages: ChatMessage[] }>(h.desktopIdentity, "GET", "/v3/chat?conversationId=cards-d");
  const answeredChoice = page.messages.find((message) => message.id === "choice-message")?.metadata?.pendingChoice;
  assert.deepEqual([answeredChoice?.status, answeredChoice?.selectedOptionId], ["selected", "files"]);
  // The desktop shows what the machine wrote, and nothing waits.
  const desktopCopy = await until(() => h.desktopStorage.getConversation("cards-d"), (item) => {
    const message = item?.messages.find((entry) => entry.id === "choice-message");
    return message?.metadata?.pendingChoice?.status === "selected" && !message.metadata.serverCard;
  });
  assert.ok(desktopCopy);
  // A second answer (from the phone) is refused by the server.
  const late = await h.phoneAnswers("cards-d", cardId, { selectedOptionId: "sqlite" });
  assert.equal(late.result.status, "rejected");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(h.turns.length, 1, "continued once");
  await until(async () => h.desktopChat.liveRunIds().length + h.machineChat.liveRunIds().length, (count) => count === 0);
});

test("a machine member's approval is shown on the desktop as its card, answered from the phone, applied on the machine, and closed on the desktop", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-e"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-e"), (item) => Boolean(item));
  const machineCopy = (await h.machineStorage.getConversation("cards-e"))!;
  machineCopy.metadata = { ...machineCopy.metadata, pendingAppToolApprovals: [toolApproval(approvalId, remote, "cards-e")] } as Conversation["metadata"];
  await save(h.machineChat, machineCopy);
  await until(() => h.card(approvalId), (item) => item?.state === "pending" && item.raisedBy === h.machineIdentity.originId);
  // The desktop shows the machine member's card as its own kind of card.
  const mirror = await until(() => approvalOf(h.desktopStorage, "cards-e", approvalId), (item) => item?.status === "pending");
  assert.equal(mirror?.homeMachineId, "box");
  // A copy never raises another device's member's card.
  assert.equal((await h.card(approvalId))?.raisedBy, h.machineIdentity.originId);
  assert.equal((await h.phoneAnswers("cards-e", approvalId, { approve: true })).result.status, "accepted");
  await until(() => h.card(approvalId), (item) => item?.state === "settled");
  assert.equal((await approvalOf(h.machineStorage, "cards-e", approvalId))?.status, "approved", "applied on the machine");
  const lines = (await h.machineStorage.getConversation("cards-e"))?.messages.filter((message) => message.content.startsWith("Allowed @drew to use Bash")).length;
  assert.equal(lines, 1, "once");
  const closed = await until(() => approvalOf(h.desktopStorage, "cards-e", approvalId), (item) => item?.status === "approved" && !item.machineDecisionPending);
  assert.ok(closed, "the desktop's card closes with the machine's outcome");
  // The desktop's own answer to a card already answered is refused by the server.
  await assert.rejects(h.desktopChat.answerAppToolApprovalCard({ conversationId: "cards-e", approvalId, approve: false }), /already been answered/);
});

test("a machine member's request to remove a member is raised by its machine, approved on the phone, made by the desktop that owns the member list, and settled by the machine", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-f"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-f"), (item) => Boolean(item));
  const machineCopy = (await h.machineStorage.getConversation("cards-f"))!;
  const removal = {
    id: approvalId, conversationId: "cards-f", requesterParticipantId: remote.id, requesterHandle: remote.handle, requesterRoleConfigId: remote.roleConfigId,
    toolName: "app_participants_request_change", capability: "participants.manage", status: "pending",
    request: { kind: "participant_removal", reason: "Done here.", operations: [{ type: "remove_participant_from_chat", participantId: desk.id, handle: desk.handle }] },
    summary: "Remove @taylor from this chat", createdAt: at, updatedAt: at
  } as unknown as ChatAppToolApproval;
  machineCopy.metadata = { ...machineCopy.metadata, pendingAppToolApprovals: [removal] } as Conversation["metadata"];
  await save(h.machineChat, machineCopy);
  const raised = await until(() => h.card(approvalId), (item) => item?.state === "pending");
  assert.equal(raised!.cardKind, "roster");
  assert.equal(raised!.raisedBy, h.machineIdentity.originId);
  await until(() => approvalOf(h.desktopStorage, "cards-f", approvalId), (item) => item?.status === "pending" && item.homeMachineId === "box");
  assert.equal((await h.phoneAnswers("cards-f", approvalId, { approve: true })).result.status, "accepted");
  // The phone shows it approved and waiting for the Mac while it is made.
  const answered = await h.card(approvalId);
  assert.equal(controlCardFromHubCard(answered!)?.title, "Removal approved");
  // The desktop makes it.
  const desktopCopy = await until(() => h.desktopStorage.getConversation("cards-f"), (item) =>
    !((item?.metadata.participants ?? []) as ChatParticipant[]).some((member) => member.id === desk.id));
  assert.equal(desktopCopy!.messages.filter((message) => message.content === "Removed @taylor from this chat at @drew's request.").length, 1);
  // The machine applied the answer and, on the desktop's word, settles its card.
  const settled = await until(() => h.card(approvalId), (item) => item?.state === "settled");
  const outcome = settled!.outcome as { result?: string; approval?: ChatAppToolApproval };
  assert.equal(outcome.result, "applied");
  assert.deepEqual(outcome.approval?.appliedParticipantIds, [desk.id]);
  const onMachine = await approvalOf(h.machineStorage, "cards-f", approvalId);
  assert.equal(onMachine?.status, "approved");
  assert.equal(onMachine?.memberRemovalQueuedAt, undefined);
  const serverChat = await h.call<{ conversation: { metadata: { participants: ChatParticipant[] } } }>(h.desktopIdentity, "GET", "/v3/chat?conversationId=cards-f");
  assert.deepEqual(serverChat.conversation.metadata.participants.map((member) => member.id), [remote.id], "the member list on the server");
});

test("a machine member's choice answered while its machine was stopped is applied once when the machine starts again", async (t) => {
  const h = await linkedDesktop(t, chat("cards-g"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-g"), (item) => Boolean(item));
  const machineCopy = (await h.machineStorage.getConversation("cards-g"))!;
  machineCopy.messages.push({
    id: "choice-g", role: "participant", participantId: remote.id, participantLabel: "@drew", content: "Ship now?", createdAt: new Date().toISOString(),
    status: "done", metadata: { pendingChoice: { id: "choice-g1", title: "Ship", question: "Ship now?", status: "pending",
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } }
  } as ChatMessage);
  await save(h.machineChat, machineCopy);
  const cardId = choiceCardId("choice-g");
  await until(() => h.card(cardId), (item) => item?.state === "pending");
  // The machine stops; the User answers on the phone meanwhile.
  await h.machineLink.stop();
  const answer = await h.phoneAnswers("cards-g", cardId, { selectedOptionId: "yes" });
  assert.equal(answer.result.status, "accepted");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await h.card(cardId))?.state, "answered", "the answer waits on the server for the machine");
  assert.deepEqual(h.turns, [], "nobody else applies it");
  // The desktop shows it answered and waiting for the machine; it never
  // writes the machine member's message.
  await until(() => h.desktopStorage.getConversation("cards-g"), (item) =>
    item?.messages.find((message) => message.id === "choice-g")?.metadata?.serverCard?.state === "answered");
  // The machine starts again: a new process, the same storage.
  const restartedTurns: Turn[] = [];
  const restarted = chatService(h.machineStorage, restartedTurns, "machine");
  restarted.setHostMachineId("box");
  const restartedAppliers = appliers(h.machineStorage, restarted, h.desktopIdentity.originId, "machine-2");
  restarted.setCardAppliers(async () => restartedAppliers);
  const link = h.link(h.machineStorage, restarted, h.machineEvents, "machine-2", false);
  h.links.push(link);
  await link.start();
  const settled = await until(() => h.card(cardId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  await until(async () => restartedTurns, (turns) => turns.length === 1);
  assert.deepEqual(restartedTurns.map((turn) => [turn.device, turn.participantId]), [["machine", remote.id]], "continued once, on its machine");
  // Read again (a reconnect): nothing is applied twice.
  await restarted.resumeServerCards();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(restartedTurns.length + h.turns.length, 1);
  const desktopCopy = await until(() => h.desktopStorage.getConversation("cards-g"), (item) => {
    const message = item?.messages.find((entry) => entry.id === "choice-g");
    return message?.metadata?.pendingChoice?.status === "selected" && !message.metadata.serverCard;
  });
  assert.ok(desktopCopy, "the desktop shows the machine's answered choice, and nothing waits");
  await until(async () => restarted.liveRunIds().length, (count) => count === 0);
});

test("a desktop member's mentions waiting for approval are a card: approved on the desktop, the members it names are asked once", async (t) => {
  const asking: ChatMessage = {
    id: "mention-h", role: "participant", participantId: desk.id, participantLabel: "@taylor", content: "@drew please check this.", createdAt: at,
    status: "done", metadata: { mentions: ["drew"], pendingMentions: [{ targetParticipantId: remote.id, targetHandle: "drew", status: "pending" }] }
  } as ChatMessage;
  const h = await linkedDesktop(t, chat("cards-h", {}, [asking]));
  await h.startMachine();
  const cardId = mentionCardId("mention-h");
  const raised = await until(() => h.card(cardId), (item) => item?.state === "pending");
  assert.equal(raised!.cardKind, "mention");
  assert.equal(raised!.participantId, desk.id);
  assert.equal(raised!.messageId, "mention-h");
  assert.deepEqual((raised!.card as unknown as HubMentionCardPayload).mentions.map((mention) => mention.targetParticipantId), [remote.id]);
  assert.equal(controlCardFromHubCard(raised!), undefined, "the phone does not show mention approvals");
  await h.desktopChat.answerMentionsCard({ conversationId: "cards-h", sourceMessageId: "mention-h", targetParticipantIds: [remote.id], approve: true });
  const settled = await until(() => h.card(cardId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  const message = (await h.desktopStorage.getConversation("cards-h"))?.messages.find((item) => item.id === "mention-h");
  assert.deepEqual(message?.metadata?.pendingMentions?.map((mention) => mention.status), ["approved"]);
  const claim = await h.desktopStorage.nativeCommands().targetEffect("cards-h", `${cardId}:${remote.id}`);
  assert.equal(claim?.eventId, cardAnswerKey(settled!), "claimed once, by that answer");
  await assert.rejects(h.desktopChat.answerMentionsCard({ conversationId: "cards-h", sourceMessageId: "mention-h", targetParticipantIds: [remote.id], approve: true }),
    /already answered/);
  // The member it names was asked once, where it runs.
  await until(async () => h.turns, (turns) => turns.length === 1);
  assert.deepEqual(h.turns.map((turn) => [turn.device, turn.participantId]), [["machine", remote.id]]);
  await until(async () => h.desktopChat.liveRunIds().length + h.machineChat.liveRunIds().length, (count) => count === 0);
  assert.equal(h.turns.length, 1);
});

test("an answer refused after a restart still says why to the device that gave it", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-i", { pendingAppToolApprovals: [scriptApproval(approvalId, "cards-i")] } as never));
  await until(() => h.card(approvalId), (item) => item?.state === "pending");
  await h.desktopLink.stop();
  const phoneAnswer = await h.phoneAnswers("cards-i", approvalId, { approve: true });
  assert.equal(phoneAnswer.result.status, "accepted");
  assert.equal((await h.card(approvalId))?.answerOpId, phoneAnswer.opId, "the server keeps the operation the answer came in");
  // The computer starts again and reads the answered card from the server
  // (not from the feed): its refusal names the phone's operation.
  const restarted = chatService(h.desktopStorage, [], "desktop");
  const restartedAppliers = appliers(h.desktopStorage, restarted, h.desktopIdentity.originId, "desktop-3");
  restarted.setCardAppliers(async () => restartedAppliers);
  restarted.setScriptHost({ async assertApprovable() { return undefined; }, async applyApproved() { h.scripts.applied += 1; return "Saved."; },
    async rejectPending() { h.scripts.rejected += 1; } } as never);
  const link = h.link(h.desktopStorage, restarted, h.desktopEvents, "desktop-3", true);
  h.links.push(link);
  await link.start();
  const again = await until(() => h.card(approvalId), (item) => item?.state === "pending" && Array.isArray((item.card as { refusals?: unknown[] }).refusals));
  assert.deepEqual((again!.card as { refusals: Array<{ operationId: string; reason: string }> }).refusals.map((item) => [item.operationId, item.reason]),
    [[phoneAnswer.opId, SCRIPT_CODE_APPROVED_ON_DESKTOP]]);
  assert.equal(again!.answerOpId, undefined, "asked again from the start");
  assert.equal(h.scripts.applied, 0);
});

test("mentions approved one member at a time: each answer is applied once and the card is asked again for the rest", async (t) => {
  const third: ChatParticipant = { id: "33333333-3333-4333-8333-333333333333", handle: "morgan", roleConfigId: "software-engineer", kind: "claude-code",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions()) };
  const asking: ChatMessage = {
    id: "mention-j", role: "participant", participantId: desk.id, participantLabel: "@taylor", content: "@drew and @morgan please check this.", createdAt: at,
    status: "done", metadata: { mentions: ["drew", "morgan"], pendingMentions: [
      { targetParticipantId: remote.id, targetHandle: "drew", status: "pending" },
      { targetParticipantId: third.id, targetHandle: "morgan", status: "pending" }
    ] }
  } as ChatMessage;
  const h = await linkedDesktop(t, chat("cards-j", { participants: [desk, remote, third] } as never, [asking]));
  await h.startMachine();
  const cardId = mentionCardId("mention-j");
  await until(() => h.card(cardId), (item) => item?.state === "pending");
  // "Ask @morgan" on the desktop: morgan is asked; the card asks again for @drew.
  await h.desktopChat.answerMentionsCard({ conversationId: "cards-j", sourceMessageId: "mention-j", targetParticipantIds: [third.id], approve: true });
  const again = await until(() => h.card(cardId), (item) => item?.state === "pending" &&
    (item.card as unknown as HubMentionCardPayload).mentions.length === 1);
  assert.deepEqual((again!.card as unknown as HubMentionCardPayload).mentions.map((mention) => mention.targetParticipantId), [remote.id], "asked again for the rest");
  // "Ask @drew" from the phone this time.
  assert.equal((await h.phoneAnswers("cards-j", cardId, { approve: true, targetParticipantIds: [remote.id] })).result.status, "accepted");
  const settled = await until(() => h.card(cardId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  const message = (await h.desktopStorage.getConversation("cards-j"))?.messages.find((item) => item.id === "mention-j");
  assert.deepEqual(message?.metadata?.pendingMentions?.map((mention) => [mention.targetParticipantId, mention.status]),
    [[remote.id, "approved"], [third.id, "approved"]]);
  await until(async () => h.turns, (turns) => turns.length === 2);
  assert.deepEqual(h.turns.map((turn) => [turn.device, turn.participantId]).sort(), [["desktop", third.id], ["machine", remote.id]].sort(),
    "each member asked once, where it runs");
  await until(async () => h.desktopChat.liveRunIds().length + h.machineChat.liveRunIds().length, (count) => count === 0);
  assert.equal(h.turns.length, 2);
});

/** The machine starts again: a new process on the same storage. */
async function restartMachine(h: Awaited<ReturnType<typeof setup>>, name: string) {
  const turns: Turn[] = [];
  const restarted = chatService(h.machineStorage, turns, "machine");
  restarted.setHostMachineId("box");
  const restartedAppliers = appliers(h.machineStorage, restarted, h.desktopIdentity.originId, name);
  restarted.setCardAppliers(async () => restartedAppliers);
  const link = h.link(h.machineStorage, restarted, h.machineEvents, name, false);
  h.links.push(link);
  await link.start();
  return { chat: restarted, link, turns };
}

function removalOf(approvalId: string, conversationId: string): ChatAppToolApproval {
  return {
    id: approvalId, conversationId, requesterParticipantId: remote.id, requesterHandle: remote.handle, requesterRoleConfigId: remote.roleConfigId,
    toolName: "app_participants_request_change", capability: "participants.manage", status: "pending",
    request: { kind: "participant_removal", reason: "Done here.", operations: [{ type: "remove_participant_from_chat", participantId: desk.id, handle: desk.handle }] },
    summary: "Remove @taylor from this chat", createdAt: at, updatedAt: at
  } as unknown as ChatAppToolApproval;
}

test("a machine makes the removal its member asked for itself once the User approves, also with the desktop off, and never asks again after a restart (Д2)", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-k"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-k"), (item) => Boolean(item));
  const machineCopy = (await h.machineStorage.getConversation("cards-k"))!;
  machineCopy.metadata = { ...machineCopy.metadata, pendingAppToolApprovals: [removalOf(approvalId, "cards-k")] } as Conversation["metadata"];
  await save(h.machineChat, machineCopy);
  await until(() => h.card(approvalId), (item) => item?.state === "pending");
  // The desktop is off; the User approves on the phone; the machine makes the
  // change itself: no device has a special right to a chat's members.
  await h.desktopLink.stop();
  assert.equal((await h.phoneAnswers("cards-k", approvalId, { approve: true })).result.status, "accepted");
  const settled = await until(() => h.card(approvalId), (item) => item?.state === "settled", 20_000);
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  // The machine restarts (an idle stop, an upgrade): nothing is asked or made again.
  await h.machineLink.stop();
  const machine = await restartMachine(h, "machine-k");
  await machine.chat.resumeServerCards();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const feed = await h.call<HubFeedResponse>(h.desktopIdentity, "GET", "/v3/feed?after=0");
  const settledAt = feed.entries.find((entry) => entry.effect.kind === "card.settle" && entry.effect.card.cardId === approvalId)!.seq;
  assert.deepEqual(feed.entries.filter((entry) => entry.seq > settledAt && entry.effect.kind.startsWith("card.") && "card" in entry.effect &&
    (entry.effect as { card: HubCard }).card.cardId === approvalId).map((entry) => entry.effect.kind), [], "nothing raised or settled after it");
  // The desktop comes back and reads the chat as the machine left it.
  const desktopAgain = h.link(h.desktopStorage, h.desktopChat, h.desktopEvents, "desktop-k", true);
  h.links.push(desktopAgain);
  await desktopAgain.start();
  const desktopCopy = await until(() => h.desktopStorage.getConversation("cards-k"), (item) =>
    ((item?.metadata.participants ?? []) as ChatParticipant[]).every((member) => member.id !== desk.id));
  assert.deepEqual((desktopCopy!.metadata.participants as ChatParticipant[]).map((member) => member.id), [remote.id]);
  const page = await h.call<{ messages: ChatMessage[] }>(h.desktopIdentity, "GET", "/v3/chat?conversationId=cards-k");
  assert.equal(page.messages.filter((message) => message.content === "Removed @taylor from this chat at @drew's request.").length, 1, "made once");
  assert.equal(page.messages.filter((message) => message.content.startsWith("Could not remove")).length, 0, "nothing says it failed");
});
