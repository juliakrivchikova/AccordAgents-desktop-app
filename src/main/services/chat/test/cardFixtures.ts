// What the card tests set up.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_SCRIPTS_REQUEST_CHANGE_TOOL, APP_TOOL_PERMISSION_TOOL } from "../../../../shared/appMcpToolContracts";
import type { HubOp } from "../../../../shared/hubOps";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, Conversation } from "../../../../shared/types";
import { HubOps } from "../../../../hub/hubOps";
import { HubServer } from "../../../../hub/hubServer";
import { ChatService } from "../../chat";
import { chatParts } from "./chatParts";
import { MachineChoiceExecutor, MachineMentionExecutor } from "../../chatActionNativeClaims";
import { DeviceIdentityService, createDeviceIdentity } from "../../deviceIdentity";
import { ChatSearchService } from "../../chatSearch";
import { HubClient } from "../../hubClient";
import { signHubRequest, type HubSigningIdentity } from "../../hubAuth";
import { MachineApprovalExecutor } from "../../machineApprovalExecutor";
import { ServerChatLink } from "../../serverChatLink";
import { StorageService } from "../../storage";

/**
 * Cards a member waits on, on the User's server (agreement Д9): a real
 * server, the computer's and a cloud machine's ChatService (each with its own
 * storage and link), and a phone that writes to the server as the phone app
 * does. The device a member runs on raises its cards, applies the first
 * answer (from any device) once, and settles them. Members' CLIs are played
 * by the test.
 */

export const desk: ChatParticipant = {
  id: "11111111-1111-4111-8111-111111111111", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code",
  permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
};

export const remote: ChatParticipant = {
  id: "22222222-2222-4222-8222-222222222222", handle: "drew", roleConfigId: "software-engineer", kind: "codex-cli", homeMachineId: "box",
  permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
};

/** ACCORD_TEST_TRACE=1 prints what the links do. */
const started = Date.now();

function trace(device: string, event: string, payload: Record<string, unknown>): void {
  if (process.env.ACCORD_TEST_TRACE) process.stderr.write(`${Date.now() - started}ms ${device} ${event} ${JSON.stringify(payload).slice(0, 300)}\n`);
}

export interface Turn { device: "desktop" | "machine"; participantId: string; triggerId: string; runId: string; signal?: AbortSignal }

/** What a test does while a member's turn runs (what its CLI does then).
 *  `showPending`: the turn's bubble is in the chat while it runs, as a real
 *  turn's is, so other devices see it (and can stop it). */
interface TurnControl { during?: (turn: Turn) => Promise<void>; showPending?: boolean }

export function chatService(storage: StorageService, turns: Turn[], device: Turn["device"], control: TurnControl = {}): ChatService {
  const settings = {
    async getPublicSettings() {
      return { chatRoleConfigs: [], chatParticipantConfigs: [], providers: [{ kind: "claude-code", enabled: true }, { kind: "codex-cli", enabled: true }] };
    }
  };
  const cliRunner = { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; }, async closeConversationSessions() { return undefined; },
    async closeWarmAgents() { return undefined; } };
  const chat = new ChatService(storage as never, settings as never, cliRunner as never, { async write(event: string, payload: Record<string, unknown>) { trace(device, event, payload); } } as never);
  (chatParts(chat).chatHistory as unknown as { ensureHistoryFiles: () => Promise<string> }).ensureHistoryFiles = async () => tmpdir();
  (chatParts(chat).participantTurn as unknown as { runParticipantTurn: (...args: unknown[]) => Promise<ChatMessage[]> }).runParticipantTurn = async (conversation, participant, trigger, runId, signal, _progress, options) => {
    const turn: Turn = { device, participantId: (participant as ChatParticipant).id, triggerId: (trigger as ChatMessage).id, runId: runId as string, signal: signal as AbortSignal | undefined };
    turns.push(turn);
    const existing = (options as { existingPendingMessage?: ChatMessage }).existingPendingMessage;
    const reply: ChatMessage = existing ?? {
      id: randomUUID(), role: "participant", participantId: (participant as ChatParticipant).id, participantLabel: `@${(participant as ChatParticipant).handle}`,
      content: "", createdAt: new Date().toISOString(), status: "pending",
      metadata: { runId: runId as string, ...(control.showPending ? { sourceMessageId: (trigger as ChatMessage).id, parentMessageId: (trigger as ChatMessage).id } : {}) }
    } as ChatMessage;
    if (!existing && control.showPending) {
      const chatInternals = chatParts(chat).store as unknown as { withChatMutation(c: Conversation, mutate: () => Promise<void>): Promise<void>; queueSnapshot(c: Conversation): void };
      await chatInternals.withChatMutation(conversation as Conversation, async () => {
        (conversation as Conversation).messages.push({ ...reply, metadata: { ...reply.metadata } });
        chatInternals.queueSnapshot(conversation as Conversation);
      });
    }
    await control.during?.(turn);
    if ((signal as AbortSignal | undefined)?.aborted) {
      if (!existing && control.showPending) {
        // As a stopped turn closes its bubble.
        const chatInternals = chatParts(chat).store as unknown as { withChatMutation(c: Conversation, mutate: () => Promise<void>): Promise<void>; queueSnapshot(c: Conversation): void };
        await chatInternals.withChatMutation(conversation as Conversation, async () => {
          const shown = (conversation as Conversation).messages.find((message) => message.id === reply.id);
          if (shown) Object.assign(shown, { status: "error", content: `@${(participant as ChatParticipant).handle} stopped by user.` });
          chatInternals.queueSnapshot(conversation as Conversation);
        });
      }
      throw new Error("Chat run cancelled.");
    }
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

export function appliers(storage: StorageService, chat: ChatService, codeApprover: string, name: string) {
  const runtimeIdentity = runtime(name);
  return {
    approval: new MachineApprovalExecutor({ storage, chat, runtimeIdentity, codeApprover: () => codeApprover }),
    choice: new MachineChoiceExecutor({ storage, chat, runtimeIdentity }),
    mention: new MachineMentionExecutor({ storage, chat, runtimeIdentity })
  };
}

export async function setup(t: test.TestContext) {
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
  const desktopControl: TurnControl = {};
  const desktopChat = chatService(desktopStorage, turns, "desktop", desktopControl);
  const machineControl: TurnControl = {};
  const machineChat = chatService(machineStorage, turns, "machine", machineControl);
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
    phone, phoneHub, turns, desktopControl, machineControl, scripts, call, card, phoneAnswers, startMachine, link };
}

export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value).slice(0, 3_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export const at = "2026-10-28T08:00:00.000Z";

export function chat(id: string, extra: Partial<Conversation["metadata"]> = {}, messages: ChatMessage[] = []): Conversation {
  return {
    id, title: "Plans", kind: "chat", createdAt: at, updatedAt: at, findings: [],
    messages: [{ id: `${id}-start`, role: "system", content: "Chat started.", createdAt: at, status: "done" }, ...messages],
    metadata: { participants: [desk, remote], participantSessions: [], running: false, warnings: [], ...extra }
  } as Conversation;
}

export function toolApproval(id: string, requester: ChatParticipant, conversationId: string): ChatAppToolApproval {
  return {
    id, conversationId, requesterParticipantId: requester.id, requesterHandle: requester.handle, requesterRoleConfigId: requester.roleConfigId,
    toolName: APP_TOOL_PERMISSION_TOOL, capability: "permissions.request", status: "pending",
    request: { kind: "toolPermission", toolName: "Bash", agentMode: "default" }, summary: "Use Bash", createdAt: at, updatedAt: at
  } as unknown as ChatAppToolApproval;
}

/** Claude Code's call waiting on this permission card in the member's
 *  process (requestToolPermissionFromTool), as while its member runs: an
 *  answer to a card no call waits on is not applied, it expires. */
export const callWaitsOn = (service: ChatService, approvalId: string) =>
  (chatParts(service).toolPermissions as unknown as { noteToolPermissionWaiter(id: string, change: 1): void }).noteToolPermissionWaiter(approvalId, 1);

export function scriptApproval(id: string, conversationId: string): ChatAppToolApproval {
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

export const save = (service: ChatService, conversation: Conversation) => (chatParts(service).store as unknown as { saveConversation(c: Conversation): Promise<void> }).saveConversation(conversation);

export const approvalOf = async (storage: StorageService, conversationId: string, approvalId: string) =>
  ((await storage.getConversation(conversationId))?.metadata.pendingAppToolApprovals as ChatAppToolApproval[] | undefined)?.find((item) => item.id === approvalId);

export async function linkedDesktop(t: test.TestContext, conversation: Conversation, beforeLink?: (h: Awaited<ReturnType<typeof setup>>) => void) {
  const h = await setup(t);
  await save(h.desktopChat, conversation);
  beforeLink?.(h);
  await h.desktopLink.start();
  await until(() => h.call<{ messages?: unknown[] }>(h.desktopIdentity, "GET", `/v3/chat?conversationId=${conversation.id}`), (page) => Boolean(page.messages?.length));
  return h;
}

export const serverTurn = (h: Awaited<ReturnType<typeof linkedDesktop>>, conversationId: string, runId: string) =>
  h.call<{ turns?: Array<{ runId: string; state: string; outcome?: string; executorDeviceId?: string; messageId: string }> }>(h.desktopIdentity, "GET", `/v3/chat?conversationId=${conversationId}`)
    .then((page) => page.turns?.find((item) => item.runId === runId));
