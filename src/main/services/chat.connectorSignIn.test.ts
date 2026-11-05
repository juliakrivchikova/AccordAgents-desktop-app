import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatAppToolApproval, ChatParticipant, ChatRoleConfig, Conversation } from "../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { connectorSignInHost, matchMcpServer, parseConnectorSignInInput } from "../../shared/connectorSignIn";
import { approvalHasCard, controlCardFromApproval } from "../../shared/mobileControlCards";
import { wantedHubCards } from "../../shared/hubCards";
import { APP_CONNECTOR_SIGN_IN_TOOL } from "../../shared/appMcpToolContracts";
import { ChatService } from "./chat";

const NOW = "2026-01-01T00:00:00.000Z";
const ROLE: ChatRoleConfig = { id: "engineer", label: "Engineer", instructions: "Answer directly.", version: 1, updatedAt: NOW };
const AUTH_URL = "https://claude.ai/api/organizations/org/mcp/start-auth/sentry?state=abc";

test("a connector already connected answers at once, with no card", async () => {
  const { service, storage, cli } = testService({ "claude.ai Sentry": "connected" });
  const result = await service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  assert.equal(result.status, "connected");
  assert.equal(approvals(storage).length, 0);
  assert.deepEqual(cli.sent.map((request) => request.subtype), ["mcp_status"]);
});

test("a name the CLI does not list gives the names like it, never the whole list", async () => {
  const servers: Record<string, string> = { "claude.ai Sentry": "needs-auth", "claude.ai Slack": "needs-auth" };
  for (let index = 0; index < 40; index++) servers[`plugin:p${index}:tool${index}`] = "needs-auth";
  const { service, storage } = testService(servers);
  const result = await service.requestConnectorSignInFromTool(actor(), { connector: "sentry-io" });
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.similar, ["claude.ai Sentry"]);
  assert.equal(approvals(storage).length, 0);
});

test("signing in: the card carries the CLI's address, Done reconnects the server and the member gets connected", async () => {
  const { service, storage, cli } = testService({ "claude.ai Sentry": "needs-auth" });
  const asking = service.requestConnectorSignInFromTool(actor(), { connector: "Sentry", reason: "To read the crash in issue 42." });
  const card = await waitForCard(storage);
  assert.equal(card.toolName, APP_CONNECTOR_SIGN_IN_TOOL);
  assert.deepEqual(card.request, { kind: "connectorSignIn", connector: "claude.ai Sentry", action: "sign-in", authUrl: AUTH_URL, reason: "To read the crash in issue 42." });
  assert.equal(card.summary, "@admin needs you to sign in to claude.ai Sentry");
  assert.deepEqual(cli.sent.map((request) => request.subtype), ["mcp_status", "mcp_authenticate"]);

  // The User signs in in the browser, then presses Done.
  cli.servers["claude.ai Sentry"] = "needs-auth";
  cli.onReconnect = (name) => { cli.servers[name] = "connected"; };
  await service.respondToAppToolApproval({ conversationId: CHAT_ID, approvalId: card.id, approve: true });
  const result = await asking;

  assert.equal(result.status, "connected");
  assert.match(String(result.message), /available now, in this same reply/);
  assert.deepEqual(cli.sent.map((request) => request.subtype), ["mcp_status", "mcp_authenticate", "mcp_reconnect", "mcp_status"]);
  const answered = approvals(storage)[0];
  assert.equal(answered.status, "approved");
  assert.equal(typeof answered.consumedAt, "string");
  assert.equal(answered.error, undefined);
});

test("Done without finishing in the browser says the CLI still wants a sign-in", async () => {
  const { service, storage } = testService({ "claude.ai Sentry": "needs-auth" });
  const asking = service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  const card = await waitForCard(storage);
  await service.respondToAppToolApproval({ conversationId: CHAT_ID, approvalId: card.id, approve: true });
  const result = await asking;
  assert.equal(result.status, "needs-auth");
  assert.match(String(approvals(storage)[0].error), /still reports needs-auth/);
});

test("Not now declines, and nothing is reconnected", async () => {
  const { service, storage, cli } = testService({ "claude.ai Sentry": "needs-auth" });
  const asking = service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  const card = await waitForCard(storage);
  await service.respondToAppToolApproval({ conversationId: CHAT_ID, approvalId: card.id, approve: false });
  const result = await asking;
  assert.equal(result.status, "declined");
  assert.equal(approvals(storage)[0].status, "denied");
  assert.equal(cli.sent.some((request) => request.subtype === "mcp_reconnect"), false);
});

test("a server that failed to connect asks for a reconnect, with no address", async () => {
  const { service, storage, cli } = testService({ "local-db": "failed" });
  const asking = service.requestConnectorSignInFromTool(actor(), { connector: "local-db" });
  const card = await waitForCard(storage);
  assert.deepEqual(card.request, { kind: "connectorSignIn", connector: "local-db", action: "reconnect" });
  assert.equal(card.summary, "@admin can't reach local-db");
  assert.equal(cli.sent.some((request) => request.subtype === "mcp_authenticate"), false, "nothing to sign in to");
  cli.onReconnect = (name) => { cli.servers[name] = "connected"; };
  await service.respondToAppToolApproval({ conversationId: CHAT_ID, approvalId: card.id, approve: true });
  assert.equal((await asking).status, "connected");
});

test("asked again while its card waits, the member joins that card and its sign-in is not started again", async () => {
  const { service, storage, cli } = testService({ "claude.ai Sentry": "needs-auth" });
  const firstGivesUp = new AbortController();
  const first = service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" }, firstGivesUp.signal);
  const card = await waitForCard(storage);
  const second = service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  await waitFor(() => cli.sent.filter((request) => request.subtype === "mcp_status").length >= 2);
  await delay(20);
  assert.equal(cli.sent.filter((request) => request.subtype === "mcp_authenticate").length, 1, "a second sign-in would spoil the one the User may be in");
  assert.equal(approvals(storage).length, 1);

  firstGivesUp.abort();
  assert.equal((await first).status, "expired");
  assert.equal(approvals(storage)[0].status, "pending", "the other call still waits on it");

  cli.onReconnect = (name) => { cli.servers[name] = "connected"; };
  await service.respondToAppToolApproval({ conversationId: CHAT_ID, approvalId: card.id, approve: true });
  assert.equal((await second).status, "connected");
  assert.equal(cli.sent.filter((request) => request.subtype === "mcp_reconnect").length, 1);
});

test("Done keeps the card open, here and on the User's server, until what came of it is recorded", async () => {
  const { service, storage, cli } = testService({ "claude.ai Sentry": "needs-auth" });
  let finishReconnect!: () => void;
  const reconnecting = new Promise<void>((resolve) => { finishReconnect = resolve; });
  cli.reconnectGate = reconnecting;
  cli.onReconnect = (name) => { cli.servers[name] = "connected"; };
  const asking = service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  const card = await waitForCard(storage);
  await service.respondToAppToolApproval({ conversationId: CHAT_ID, approvalId: card.id, approve: true });
  await waitFor(() => cli.sent.some((request) => request.subtype === "mcp_reconnect"));
  const answered = approvals(storage)[0];
  assert.equal(answered.status, "approved");
  assert.equal(approvalHasCard(answered), true, "its server card is kept, not settled before the result");
  assert.equal(wantedHubCards(storage.current, { approval: () => true, message: () => true })[0]?.keepOnly, true);
  const phone = controlCardFromApproval(CHAT_ID, answered);
  assert.deepEqual([phone.status, phone.waiting, phone.outcome, phone.options.length], ["answered", true, "Reconnecting claude.ai Sentry…", 0]);
  finishReconnect();
  assert.equal((await asking).status, "connected");
  assert.equal(approvalHasCard(approvals(storage)[0]), false, "settled once recorded, with the result");
});

test("a turn that ends closes its card as closed, never as the User's Not now", async () => {
  const { service, storage } = testService({ "claude.ai Sentry": "needs-auth" });
  const asking = service.requestConnectorSignInFromTool(actor({ runId: "run-2" }), { connector: "claude.ai Sentry" });
  await waitForCard(storage);
  const chat = clone(storage.current);
  (service as any).markPendingAppToolApprovalsForRunTerminal(chat, "run-2", "Stopped by user.");
  storage.current = chat;
  const result = await asking;
  assert.equal(result.status, "expired");
  assert.equal(approvals(storage)[0].status, "cancelled");
  assert.equal(approvals(storage)[0].error, "Stopped by user.");
});

test("a member removed while its card waits: the card closes and the call ends", async () => {
  const { service, storage } = testService({ "claude.ai Sentry": "needs-auth" });
  const asking = service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  await waitForCard(storage);
  const chat = clone(storage.current);
  (service as any).cleanupRemovedParticipantState(chat, (chat.metadata.participants as ChatParticipant[])[0], NOW);
  storage.current = chat;
  assert.equal((await asking).status, "expired");
  assert.equal(approvals(storage)[0].status, "expired");
});

test("a server whose own sign-in returns to the member's computer says so where it cannot finish", async () => {
  const { service, storage, cli } = testService({ "github": "needs-auth" });
  cli.callbackExpected = true;
  const asking = service.requestConnectorSignInFromTool(actor(), { connector: "github" });
  const card = await waitForCard(storage);
  assert.equal((card.request as { callbackOnMemberComputer?: boolean }).callbackOnMemberComputer, true);
  const phone = controlCardFromApproval(CHAT_ID, card);
  assert.equal(phone.signInUrl, undefined, "a phone's browser never reaches the member's computer");
  assert.match(phone.summary, /cannot be done from this phone/);
  await service.respondToAppToolApproval({ conversationId: CHAT_ID, approvalId: card.id, approve: false });
  await asking;
});

test("a member's turn stopping closes its card unanswered", async () => {
  const { service, storage } = testService({ "claude.ai Sentry": "needs-auth" });
  const controller = new AbortController();
  (service as any).chatRunControllers.set("run-1", new Set([controller]));
  const asking = service.requestConnectorSignInFromTool(actor({ runId: "run-1" }), { connector: "claude.ai Sentry" });
  await waitForCard(storage);
  controller.abort();
  const result = await asking;
  assert.equal(result.status, "expired");
  assert.equal(approvals(storage)[0].status, "cancelled");
});

test("a sign-in address that is not a web page is never put on a card", async () => {
  const { service, storage, cli } = testService({ "claude.ai Sentry": "needs-auth" });
  cli.authUrl = "file:///etc/passwd";
  const result = await service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  assert.equal(result.status, "error");
  assert.equal(approvals(storage).length, 0);
});

test("only Claude Code members sign in from the chat; others are told how", async () => {
  const { service, storage, cli } = testService({ "claude.ai Sentry": "needs-auth" }, { kind: "codex-cli" });
  const result = await service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  assert.equal(result.status, "unsupported");
  assert.equal(cli.sent.length, 0);
  assert.equal(approvals(storage).length, 0);
});

test("a member with no live process here says so", async () => {
  const { service, cli } = testService({ "claude.ai Sentry": "needs-auth" });
  cli.live = false;
  const result = await service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  assert.equal(result.status, "unavailable");
});

test("the CLI's refusal reaches the member in its own words", async () => {
  const { service, cli } = testService({ "claude.ai Sentry": "needs-auth" });
  cli.refuse = "mcp_authenticate is not supported in this context (callback not registered)";
  const result = await service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  assert.equal(result.status, "error");
  assert.match(String(result.message), /callback not registered/);
});

test("a sign-in card survives the chat being read back from storage", async () => {
  const { service, storage } = testService({ "claude.ai Sentry": "needs-auth" });
  const asking = service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  const card = await waitForCard(storage);
  assert.equal((service as any).isChatAppToolApproval(card), true);
  await service.respondToAppToolApproval({ conversationId: CHAT_ID, approvalId: card.id, approve: false });
  await asking;
});

test("a card no call waits on any more (the app restarted) is closed, never answered into nothing", async () => {
  const { service, storage } = testService({ "claude.ai Sentry": "needs-auth" });
  const asking = service.requestConnectorSignInFromTool(actor(), { connector: "claude.ai Sentry" });
  const waitingCard = await waitForCard(storage);
  await service.hydrateContextUsage(clone(storage.current));
  assert.equal(approvals(storage)[0].status, "pending", "a card a call still waits on stays");

  // The same chat read by a new process: nothing waits on its card.
  const restarted = testService({ "claude.ai Sentry": "needs-auth" });
  restarted.storage.current = clone(storage.current);
  await restarted.service.hydrateContextUsage(clone(restarted.storage.current));
  assert.equal(approvals(restarted.storage)[0].status, "expired");
  assert.match(String(approvals(restarted.storage)[0].error), /No member is waiting/);

  const stuck = testService({ "claude.ai Sentry": "needs-auth" });
  stuck.storage.current = clone(storage.current);
  (stuck.storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0].status = "approved";
  await stuck.service.hydrateContextUsage(clone(stuck.storage.current));
  const closedAfterQuit = approvals(stuck.storage)[0];
  assert.equal(typeof closedAfterQuit.consumedAt, "string", "a Done whose reconnect the app quit before is closed");
  assert.match(String(closedAfterQuit.error), /closed before it could reconnect/);

  const answered = testService({ "claude.ai Sentry": "needs-auth" });
  answered.storage.current = clone(storage.current);
  await answered.service.respondToAppToolApproval({ conversationId: CHAT_ID, approvalId: waitingCard.id, approve: true });
  assert.equal(approvals(answered.storage)[0].status, "expired", "Done on such a card closes it");
  assert.equal(answered.cli.sent.length, 0, "and reconnects nothing");

  await service.respondToAppToolApproval({ conversationId: CHAT_ID, approvalId: waitingCard.id, approve: false });
  assert.equal((await asking).status, "declined");
});

test("the phone's card: Sign in opens the CLI's address, Done and Not now answer", () => {
  const approval = {
    id: "a1", conversationId: CHAT_ID, requesterParticipantId: "claude-1", requesterHandle: "claude", requesterRoleConfigId: ROLE.id,
    toolName: APP_CONNECTOR_SIGN_IN_TOOL, capability: "permissions.request", status: "pending",
    request: { kind: "connectorSignIn", connector: "claude.ai Sentry", action: "sign-in", authUrl: AUTH_URL, reason: "For issue 42." },
    summary: "@claude needs you to sign in to claude.ai Sentry", createdAt: NOW, updatedAt: NOW
  } as ChatAppToolApproval;
  const card = controlCardFromApproval(CHAT_ID, approval);
  assert.equal(card.title, "@claude needs you to sign in to claude.ai Sentry");
  assert.equal(card.signInUrl, AUTH_URL);
  assert.equal(card.summary, "For issue 42. Sign in opens claude.ai in your browser. When you have finished, tap Done.");
  assert.deepEqual(card.options, [{ id: "allow", label: "Done" }, { id: "deny", label: "Not now" }]);
  const reconnect = controlCardFromApproval(CHAT_ID, { ...approval, request: { kind: "connectorSignIn", connector: "local-db", action: "reconnect" } } as ChatAppToolApproval);
  assert.equal(reconnect.signInUrl, undefined);
  assert.deepEqual(reconnect.options.map((option) => option.label), ["Reconnect", "Not now"]);
});

test("the member's words: its connector, matched as the CLI names it", () => {
  const servers = [{ name: "claude.ai Sentry", status: "needs-auth" }, { name: "plugin:acme:sentry", status: "connected" }, { name: "late", status: "failed" }];
  assert.deepEqual(matchMcpServer(servers, "claude.ai sentry"), { kind: "match", server: servers[0] });
  assert.deepEqual(matchMcpServer(servers, "Sentry"), { kind: "ambiguous", names: ["claude.ai Sentry", "plugin:acme:sentry"] });
  assert.deepEqual(matchMcpServer(servers, "LATE"), { kind: "match", server: servers[2] });
  assert.deepEqual(matchMcpServer(servers, "datadog"), { kind: "none", suggestions: [] });
  assert.throws(() => parseConnectorSignInInput({}), /connector is required/);
  assert.deepEqual(parseConnectorSignInInput({ connector: " late ", reason: " why " }), { connector: "late", reason: "why" });
  assert.equal(connectorSignInHost("javascript:alert(1)"), undefined);
  assert.equal(connectorSignInHost(AUTH_URL), "claude.ai");
});

// --- helpers ------------------------------------------------------------------

const CHAT_ID = "chat-connector";

function actor(patch: Record<string, unknown> = {}): any {
  return {
    conversationId: CHAT_ID, participantId: "claude-admin", roleConfigId: ROLE.id, roleConfigVersion: 1,
    capabilities: ["permissions.request"], triggerMessageId: "m1", ...patch
  };
}

function approvals(storage: any): ChatAppToolApproval[] {
  return (storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[];
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await delay(5);
  }
  throw new Error("timed out waiting");
}

async function waitForCard(storage: any): Promise<ChatAppToolApproval> {
  await waitFor(() => approvals(storage).some((approval) => approval.status === "pending"));
  return approvals(storage).find((approval) => approval.status === "pending")!;
}

/** The member's live Claude Code process, as its control requests see it. */
function fakeCli(servers: Record<string, string>) {
  const cli = {
    servers,
    sent: [] as Array<Record<string, unknown>>,
    authUrl: AUTH_URL,
    live: true,
    refuse: undefined as string | undefined,
    onReconnect: undefined as ((name: string) => void) | undefined,
    reconnectGate: undefined as Promise<void> | undefined,
    callbackExpected: false,
    async memberClaudeControl(_conversationId: string, _participantId: string, request: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
      if (!cli.live) return undefined;
      cli.sent.push(request);
      if (cli.refuse && request.subtype === "mcp_authenticate") throw new Error(cli.refuse);
      if (request.subtype === "mcp_status") return { mcpServers: Object.entries(cli.servers).map(([name, status]) => ({ name, status })) };
      if (request.subtype === "mcp_authenticate") return { authUrl: cli.authUrl, requiresUserAction: true, callbackExpected: cli.callbackExpected };
      if (request.subtype === "mcp_reconnect") {
        await cli.reconnectGate;
        cli.onReconnect?.(String(request.serverName));
        return {};
      }
      throw new Error(`unexpected ${String(request.subtype)}`);
    }
  };
  return cli;
}

function testService(servers: Record<string, string>, participantPatch: Partial<ChatParticipant> = {}) {
  const participant: ChatParticipant = {
    id: "claude-admin", handle: "admin", roleConfigId: ROLE.id, kind: "claude-code", agentMode: "default",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions()), ...participantPatch
  };
  const conversation: Conversation = {
    id: CHAT_ID, title: "Connector test", kind: "chat", createdAt: NOW, updatedAt: NOW, findings: [],
    messages: [{ id: "m1", role: "user", content: "Look at the crash in Sentry.", createdAt: NOW } as any],
    metadata: { participants: [participant], participantSessions: [] }
  };
  const storage = {
    current: clone(conversation),
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(saved: Conversation): Promise<void> {
      this.current = clone(saved);
    },
    conversationTombstones() {
      return { isDeleted: async () => false, mark: async () => undefined, pendingCopies: async () => [] };
    }
  };
  const settings = {
    async getPublicSettings(): Promise<Record<string, unknown>> {
      return { chatRoleConfigs: [ROLE], chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT };
    }
  };
  const cli = fakeCli(servers);
  const cliRunner: any = {
    async detectAgents(): Promise<[]> { return []; },
    memberClaudeControl: cli.memberClaudeControl,
    async run(): Promise<Record<string, unknown>> { throw new Error("No turn expected in this test."); }
  };
  const debugLogs = { async write(): Promise<void> { return undefined; } };
  return { service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never), storage, cli };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
