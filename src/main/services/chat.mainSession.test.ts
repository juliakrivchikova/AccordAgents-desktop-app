import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatService } from "./chat";
import { accordLaunchCardForMessage } from "../../shared/accordLaunchCard";
import { chatParticipantRequestReplyRootMap } from "../../shared/chatParticipantRequestThreads";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { applyChatAccessOptionById, selectedChatAccessOption } from "../../shared/chatAccessModes";
import { buildGeminiExecInvocation } from "./geminiExec";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES, CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT, CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT } from "../../shared/chatParticipantRequests";
import { CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT } from "../../shared/chatAutoWatch";
import { EMPTY_MOBILE_CONTROL_SETTINGS } from "../../shared/mobilePairing";
import type {
  AppSettings,
  ChatAgentPermissions,
  ChatMessage,
  ChatParticipant,
  ChatParticipantRequestBatch,
  ChatParticipantRequestItem,
  ChatParticipantSession,
  ChatProviderKind,
  ChatRoleConfig,
  Conversation,
  ParticipantConfig
} from "../../shared/types";

// The main session of a chat (docs/main-session.md): it gives new members
// tasks without a card, never with broader rights than its own, can fork its
// CLI session for them, and is the only member that starts an Accord.

const NOW = "2026-11-20T12:00:00.000Z";

const MAIN_ROLE: ChatRoleConfig = {
  id: "main-session",
  label: "Main session",
  instructions: "You are the main session.",
  version: 1,
  builtIn: true,
  appToolCapabilities: ["participants.manage", "participants.delegate", "accord.start"],
  participantDefaults: { requestParticipants: "allow", manageRolesParticipants: "allow" },
  updatedAt: NOW
};
const GENERIC_ROLE: ChatRoleConfig = {
  id: "generic-participant",
  label: "Generic Member",
  instructions: "Answer directly.",
  version: 1,
  builtIn: true,
  updatedAt: NOW
};
const WORKFLOW_ROLE: ChatRoleConfig = {
  id: "workflow-manager",
  label: "Workflow Manager",
  instructions: "Run the workflow.",
  version: 1,
  builtIn: true,
  participantDefaults: { manageRolesParticipants: "allow" },
  updatedAt: NOW
};
const REVIEWER_ROLE: ChatRoleConfig = {
  id: "code-reviewer",
  label: "Code Reviewer",
  instructions: "Review code.",
  version: 1,
  builtIn: true,
  updatedAt: NOW
};

function permissions(patch: Partial<ChatAgentPermissions> = {}): ChatAgentPermissions {
  return normalizeChatAgentPermissions({
    repoRead: true,
    workspaceWrite: false,
    webAccess: false,
    requestParticipants: "ask",
    requestCompaction: "ask",
    shell: { enabled: false, rules: [] },
    ...patch
  });
}

function mainSession(kind: ChatProviderKind = "claude-code", patch: Partial<ChatParticipant> = {}): ChatParticipant {
  return {
    id: "main-id",
    handle: "main",
    roleConfigId: MAIN_ROLE.id,
    kind,
    model: kind === "claude-code" ? "opus" : undefined,
    agentMode: "default",
    permissions: permissions({
      workspaceWrite: true,
      requestParticipants: "allow",
      shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "git diff" }, { action: "deny", match: "prefix", pattern: "git push" }] }
    }),
    ...patch
  };
}

function member(id: string, handle: string, patch: Partial<ChatParticipant> = {}): ChatParticipant {
  return { id, handle, roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", agentMode: "default", permissions: permissions(), ...patch };
}

function sessionRecord(participant: ChatParticipant, sessionId: string, role: ChatRoleConfig = MAIN_ROLE): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId,
    roleConfigId: role.id,
    roleConfigVersion: role.version,
    roleAppToolCapabilities: role.appToolCapabilities,
    roleParticipantDefaults: role.participantDefaults,
    participantKind: participant.kind,
    roleLabel: role.label,
    roleInstructions: role.instructions,
    updatedAt: NOW
  };
}

function mainSessionChat(participants: ChatParticipant[], metadata: Record<string, unknown> = {}): Conversation {
  return {
    id: "conversation-1",
    title: "Main session chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{ id: "user-message", role: "user", content: "Please review the change.", createdAt: NOW, status: "done" }],
    findings: [],
    metadata: { participants, mainSessionParticipantId: "main-id", ...metadata }
  } as Conversation;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type RunCall = { participant: ParticipantConfig; prompt: string; options: any };

function testService(options: {
  conversation: Conversation;
  run?: (participant: ParticipantConfig, prompt: string, options: any, signal?: AbortSignal) => Promise<any>;
  userSkills?: unknown;
}) {
  const tempRoot = path.join(tmpdir(), "accordagents-main-session-test");
  const storage = {
    current: clone(options.conversation),
    async listConversations() {
      return [{ id: this.current.id, title: this.current.title, kind: this.current.kind, createdAt: this.current.createdAt, updatedAt: this.current.updatedAt }];
    },
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      this.current = clone(conversation);
    },
    async chatRequestBatches(id: string) {
      return this.current.id === id
        ? (this.current.messages ?? []).flatMap((message: ChatMessage) => message.metadata?.participantRequest ? [clone(message.metadata.participantRequest)] : [])
        : [];
    },
    conversationTombstones() {
      return { isDeleted: async () => false, mark: async () => undefined, pendingCopies: async () => [] };
    },
    async requestRunCancel(): Promise<void> {},
    async takeRunCancelRequests(): Promise<string[]> {
      return [];
    }
  };
  const publicSettings = (): AppSettings => ({
    chatCustomAvatars: [],
    roundLimitDefault: 1,
    betaUpdates: false,
    crashReports: true,
    cliAgentRunTimeoutMs: 24 * 60 * 60_000,
    chatAutoWatchWakeLimit: CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT,
    chatParticipantRequestMaxDepth: CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
    chatParticipantRequestPromptMaxChars: CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT,
    chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT,
    cloudRuns: { enabled: false, mode: "ssh", worker: {}, hasAwsCredentials: false, awsInstanceType: "t3.small", awsRootVolumeSizeGb: 8, maxRuntimeMs: 60_000, pollIntervalMs: 2_500 },
    mobileControl: EMPTY_MOBILE_CONTROL_SETTINGS,
    providers: [
      { kind: "codex-cli", label: "Codex CLI", enabled: true },
      { kind: "claude-code", label: "Claude Code", enabled: true },
      { kind: "gemini-cli", label: "Antigravity", enabled: true }
    ],
    chatRoleConfigs: clone([MAIN_ROLE, GENERIC_ROLE, REVIEWER_ROLE, WORKFLOW_ROLE]),
    chatBehaviorRules: [],
    chatSavedPrompts: [],
    chatParticipantConfigs: [],
    chatParticipantSeedState: {},
    cliProviderHosts: []
  } as unknown as AppSettings);
  const settings = {
    async getPublicSettings() { return publicSettings(); },
    async ensureAssistantProviderDefault() { return publicSettings(); },
    async listMachines() { return []; },
    async listMachineInstalls() { return []; },
    async ensureGenericChatParticipantSeeds() { return publicSettings(); },
    async recordSuccessfulChatProvider() {},
    async getChatParticipantRequestMaxDepth() { return CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT; },
    async getChatParticipantRequestPromptMaxChars() { return CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT; },
    async saveChatParticipantConfig() { return publicSettings(); }
  };
  const runs: RunCall[] = [];
  const cliRunner = {
    async detectAgents() { return []; },
    async run(participant: ParticipantConfig, prompt: string, _repoPath: unknown, _diffMode: unknown, _kind: unknown, signal: AbortSignal | undefined, runOptions: any) {
      runs.push({ participant, prompt, options: runOptions });
      return options.run
        ? options.run(participant, prompt, runOptions, signal)
        : { participant, ok: true, content: `Done by ${participant.id}.`, durationMs: 1 };
    }
  };
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const debugLogs = { async write(event: string, payload: Record<string, unknown>) { debugEvents.push({ event, payload }); } };
  const service = new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never, undefined, undefined, options.userSkills as never);
  (service as any).ensureHistoryFiles = async () => tempRoot;
  return { service, storage, runs, debugEvents };
}

function mainActor(capabilities: string[] = ["participants.manage", "participants.delegate", "accord.start", "participants.request"], patch: Record<string, unknown> = {}): any {
  return {
    conversationId: "conversation-1",
    participantId: "main-id",
    roleConfigId: MAIN_ROLE.id,
    roleConfigVersion: 1,
    capabilities,
    triggerMessageId: "user-message",
    triggerThreadId: "user-message",
    participantRequestDepth: 0,
    ...patch
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for condition: ${predicate.toString().slice(0, 200)}`);
}

function participantsOf(conversation: Conversation): ChatParticipant[] {
  return conversation.metadata.participants as ChatParticipant[];
}

function delegationBatches(conversation: Conversation): ChatParticipantRequestBatch[] {
  return conversation.messages.flatMap((message) => message.metadata?.participantRequest?.delegation ? [message.metadata.participantRequest] : []);
}

// --- capabilities --------------------------------------------------------------

test("delegate and start-Accord tools reach only the chat's own main session, whatever another member's role says", () => {
  const main = mainSession();
  const impostor = { ...member("impostor-id", "impostor"), roleConfigId: MAIN_ROLE.id, kind: "claude-code" as const };
  const conversation = mainSessionChat([main, impostor]);
  const { service } = testService({ conversation });
  const internals = service as any;
  const forMain = internals.appToolCapabilitiesForRun(conversation, main, sessionRecord(main, "s"), normalizeChatAgentPermissions(main.permissions));
  const forImpostor = internals.appToolCapabilitiesForRun(conversation, impostor, sessionRecord(impostor, "s"), normalizeChatAgentPermissions(impostor.permissions));
  assert.ok(forMain.includes("participants.delegate"));
  assert.ok(forMain.includes("accord.start"));
  assert.equal(forImpostor.includes("participants.delegate"), false);
  assert.equal(forImpostor.includes("accord.start"), false);
  // A chat without a main session gives them to nobody.
  const plain = { ...conversation, metadata: { participants: [main, impostor] } } as Conversation;
  assert.equal(internals.appToolCapabilitiesForRun(plain, main, sessionRecord(main, "s"), normalizeChatAgentPermissions(main.permissions)).includes("participants.delegate"), false);
});

// --- delegation ----------------------------------------------------------------

test("the main session adds a member without a card, within its own rights, and its task runs at once", async () => {
  const main = mainSession();
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")] });
  const { service, storage, runs, debugEvents } = testService({ conversation });

  const result = await service.delegateTaskFromTool(mainActor(), {
    title: "  Review   app.ts ",
    task: "Review src/app.ts and report the bugs you find.",
    // Asks for more than the main session has: web access and Auto.
    agentMode: "auto",
    permissions: { repoRead: true, workspaceWrite: true, webAccess: true, shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "rm" }, { action: "allow", match: "prefix", pattern: "git diff" }] } }
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "running");
  assert.equal(result.start, "clean");
  assert.equal(result.forked, false);
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.ok(child, "the member is in the chat");
  assert.equal(result.handle, `@${child.handle}`);
  assert.equal(child.handle, "claude", "the generic role is named after its CLI");
  assert.equal(child.kind, "claude-code", "the main session's provider");
  assert.equal(child.model, "opus", "and its model");
  assert.equal(child.roleConfigId, GENERIC_ROLE.id);
  assert.equal(child.taskTitle, "Review app.ts", "the member keeps the title it is named by, whatever a device has loaded");
  assert.equal(child.delegatedByParticipantId, main.id);
  assert.equal(child.agentMode, "default", "never above the main session's mode");
  const granted = normalizeChatAgentPermissions(child.permissions);
  assert.equal(granted.cliApprovals, true, "in its CLI's own mode (Accept edits), never Custom in the sessions view");
  assert.equal(granted.webAccess, false, "nothing the main session lacks");
  assert.equal(granted.workspaceWrite, true);
  assert.deepEqual(granted.shell.rules, [
    { action: "allow", match: "prefix", pattern: "git diff" },
    { action: "deny", match: "prefix", pattern: "git push" }
  ]);
  assert.equal(granted.requestParticipants, "allow", "it may ask the main session without a card");
  assert.equal(granted.manageRolesParticipants, "deny");

  // No card: the addition is recorded as auto-applied, and the chat says who added it.
  const approvals = (storage.current.metadata.pendingAppToolApprovals ?? []) as Array<{ status: string; appliedParticipantIds?: string[] }>;
  assert.deepEqual(approvals.map((approval) => approval.status), ["auto-applied"]);
  assert.deepEqual(approvals[0].appliedParticipantIds, [child.id]);
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.role === "system" && message.content === `Auto-applied member request from @main: Add @${child.handle}.`));

  // The task is a running request from the main session to the member.
  const [batch] = delegationBatches(storage.current);
  assert.equal(batch.requesterParticipantId, main.id);
  assert.equal(batch.resumeRequester, true);
  assert.deepEqual(batch.delegation, { start: "clean" }, "given outside a turn running here: resumed on its own");
  assert.equal(batch.items[0].targetParticipantId, child.id);
  assert.equal(batch.items[0].prompt, "Review src/app.ts and report the bugs you find.");
  assert.equal(batch.items[0].title, "Review app.ts", "the task's short title, kept on its item");
  assert.equal(result.requestId, batch.id);

  // The member runs its task, then the main session gets its answer in a fresh turn.
  await waitFor(() => runs.some((run) => run.participant.id === child.id));
  await waitFor(() => runs.some((run) => run.participant.id === main.id && run.prompt.includes("Auto-resumed @main")));
  const childRun = runs.find((run) => run.participant.id === child.id)!;
  assert.equal(childRun.options.forkFromSessionId, undefined, "a clean member starts its own session");
  assert.equal(childRun.options.sessionId || undefined, undefined);
  assert.match(childRun.prompt, /Review src\/app\.ts/);
  await waitFor(() => delegationBatches(storage.current)[0]?.autoResumeMessageId !== undefined);
  assert.deepEqual(debugEvents.filter((item) => item.event.endsWith(".error")), []);
});

test("only the main session delegates; a role is not enough", async () => {
  const main = mainSession();
  const impostor = { ...member("impostor-id", "impostor"), roleConfigId: MAIN_ROLE.id };
  const conversation = mainSessionChat([main, impostor]);
  const { service, storage } = testService({ conversation });
  const before = participantsOf(storage.current).length;

  const refused = await service.delegateTaskFromTool(mainActor(undefined, { participantId: impostor.id }), { task: "Do it." });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "not_main_session");
  const noCapability = await service.delegateTaskFromTool(mainActor(["participants.request"]), { task: "Do it." });
  assert.equal(noCapability.ok, false);
  assert.equal(noCapability.code, "not_main_session");
  assert.equal(participantsOf(storage.current).length, before, "nobody added");
});

test("a fork is refused across providers, for Antigravity, without a session, and from another device, and nothing is added", async () => {
  for (const [label, main, request, sessions] of [
    ["another provider", mainSession("claude-code"), { task: "T", start: "fork", kind: "codex-cli" }, [sessionRecord(mainSession(), "main-cli-session")]],
    ["Antigravity", mainSession("gemini-cli"), { task: "T", start: "fork" }, [sessionRecord(mainSession("gemini-cli"), "agy-conversation")]],
    ["no session yet", mainSession("codex-cli"), { task: "T", start: "fork" }, []]
  ] as const) {
    const conversation = mainSessionChat([main], { participantSessions: sessions });
    const { service, storage } = testService({ conversation });
    const result = await service.delegateTaskFromTool(mainActor(), request);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "fork_unavailable", label);
    assert.match(String(result.reason), /clean member/, label);
    assert.equal(participantsOf(storage.current).length, 1, `${label}: nothing added`);
  }
  // A session on another machine is not this device's to copy.
  const elsewhere = mainSession("claude-code", { homeMachineId: "machine-1" });
  const { service } = testService({ conversation: mainSessionChat([elsewhere]) });
  assert.match(String((service as any).forkUnavailableReason(elsewhere, sessionRecord(elsewhere, "s"), "claude-code", undefined)), /another machine/);
});

test("a fork starts from a copy of the main session's CLI session and then keeps its own", async () => {
  const main = mainSession("claude-code", { permissions: permissions({ repoRead: true, requestParticipants: "allow" }) });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")] });
  const { service, storage, runs } = testService({
    conversation,
    run: async (participant, _prompt, runOptions) => {
      if (participant.id !== main.id) {
        runOptions.onSessionId?.("child-own-session");
        return { participant, ok: true, content: "Reviewed.", durationMs: 1, sessionId: "child-own-session" };
      }
      return { participant, ok: true, content: "Thanks.", durationMs: 1 };
    }
  });

  const result = await service.delegateTaskFromTool(mainActor(), {
    task: "Take over the refactor we discussed.",
    start: "fork",
    handle: "refactor",
    // A fork runs in the main session's folder whatever is asked.
    permissions: { repoRead: false }
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.forked, true);
  assert.equal(result.handle, "@refactor");
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.equal(normalizeChatAgentPermissions(child.permissions).repoRead, true);
  const recorded = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((session) => session.participantId === child.id)!;
  assert.deepEqual(recorded.forkFrom, { participantId: main.id, sessionId: "main-cli-session", kind: "claude-code" });

  await waitFor(() => runs.some((run) => run.participant.id === child.id));
  const childRun = runs.find((run) => run.participant.id === child.id)!;
  assert.equal(childRun.options.forkFromSessionId, "main-cli-session");
  assert.equal(childRun.options.sessionId || undefined, undefined);
  // Both CLIs keep the source's instructions in a fork: the member is told who it is.
  assert.match(childRun.prompt, /^<<<APP [0-9a-f]{8}>>>\nYou were forked from @main's session/);
  assert.match(childRun.prompt, /You are @refactor, role: Generic Member\. You are not the main session/);
  assert.match(childRun.prompt, /Answer directly\./, "its role's instructions");

  await waitFor(() => {
    const session = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === child.id);
    return session?.sessionId === "child-own-session";
  });
  const after = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === child.id)!;
  assert.equal(after.forkFrom, undefined, "the fork is made once");
  assert.equal(after.forkedFromParticipantId, main.id);
  const mainSessionAfter = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === main.id)!;
  assert.equal(mainSessionAfter.sessionId, "main-cli-session", "the main session's own session is untouched");
});

test("a fork the CLI could not make starts clean in the same turn: the main session's task does not fail, and the chat says so once", async () => {
  for (const [kind, error] of [
    ["claude-code", "claude warm process exited with code 1: No conversation found with session ID: main-cli-session"],
    ["codex-cli", "no rollout found for thread id main-cli-session"]
  ] as const) {
    const main = mainSession(kind, kind === "codex-cli" ? { model: undefined } : {});
    const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")] });
    const { service, storage, runs } = testService({
      conversation,
      run: async (participant, _prompt, runOptions) => {
        if (participant.id === main.id) return { participant, ok: true, content: "Noted.", durationMs: 1 };
        if (!runOptions.forkFromSessionId) {
          runOptions.onSessionId?.("clean-session");
          return { participant, ok: true, content: "Done clean.", durationMs: 1, sessionId: "clean-session" };
        }
        return { participant, ok: false, content: `${participant.label} stopped before it returned a response.`, error, durationMs: 1, forkCopyFailed: true };
      }
    });
    const result = await service.delegateTaskFromTool(mainActor(), { task: "Continue.", start: "fork" });
    assert.equal(result.ok, true, JSON.stringify(result));
    const childId = String(result.participantId);
    const sessionOf = () => (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === childId)!;
    const childRuns = () => runs.filter((run) => run.participant.id === childId);
    await waitFor(() => delegationBatches(storage.current)[0]?.items[0]?.status === "answered");
    // One turn: the copy, then (its source gone) a clean session at once.
    assert.deepEqual(childRuns().map((run) => run.options.forkFromSessionId ?? null), ["main-cli-session", null], kind);
    assert.match(childRuns()[1].prompt, /^<<<APP [0-9a-f]{8}>>>\nYou were to start from a copy of @main's session, but it could not be copied/, `${kind}: told who it is`);
    await waitFor(() => sessionOf().sessionId === "clean-session");
    assert.equal(sessionOf().forkFrom, undefined, kind);
    assert.equal(sessionOf().forkedFromParticipantId, undefined, kind);
    const replies = storage.current.messages.filter((message: ChatMessage) => message.participantId === childId && message.role === "participant");
    assert.deepEqual(replies.map((message: ChatMessage) => [message.status, message.content]), [["done", "Done clean."]], `${kind}: the task's answer`);
    // A line in the chat (every device shows it; a warning stays on one).
    const notice = `@${String(result.handle).slice(1)} could not start from a copy of @main's session, so this turn started a clean session.`;
    const lines = () => storage.current.messages.filter((message: ChatMessage) => message.role === "system" && message.content === notice);
    await waitFor(() => lines().length > 0);
    assert.equal(lines()[0].metadata?.threadId, "system", kind);
    assert.equal(lines()[0].id, `fork-notice-started-clean-${childId}`, kind);
    assert.ok(((storage.current.metadata.warnings ?? []) as string[]).includes(notice), kind);

    const asked = await service.requestParticipantsFromTool(mainActor(undefined, { triggerMessageId: "trigger-again" }), { requests: [{ target: String(result.handle), prompt: "Once more." }] });
    assert.equal(asked.ok, true, JSON.stringify(asked));
    await waitFor(() => childRuns().length === 3);
    assert.equal(childRuns()[2].options.sessionId, "clean-session", `${kind}: its own session`);
    assert.equal(childRuns()[2].options.forkFromSessionId, undefined, `${kind}: no fork any more`);
    assert.doesNotMatch(childRuns()[2].prompt, /You were forked from/, kind);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lines().length, 1, `${kind}: once`);
  }
});

test("a delegated fork whose clean start fails too: the main session reads why in the failed reply, and the member's next turn starts as a new session", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  // The main session has read the chat through its first message: a fork's copy starts there.
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")],
    promptContextPointers: { [main.id]: { timeline: { messageId: "user-message", sequence: 0, createdAt: NOW } } } });
  let overloaded = true;
  const { service, storage, runs } = testService({
    conversation,
    run: async (participant, _prompt, runOptions) => {
      if (participant.id === main.id) return { participant, ok: true, content: "Noted.", durationMs: 1 };
      if (runOptions.forkFromSessionId) return { participant, ok: false, content: "", error: "no rollout found for thread id main-cli-session", durationMs: 1, forkCopyFailed: true };
      return overloaded
        ? { participant, ok: false, content: "Codex failed before it returned a response.", error: "The model is overloaded.", durationMs: 1 }
        : { participant, ok: true, content: "Done.", durationMs: 1, sessionId: "clean-session" };
    }
  });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Continue.", start: "fork" });
  assert.equal(result.ok, true, JSON.stringify(result));
  const childId = String(result.participantId);
  assert.ok(((storage.current.metadata.promptContextPointers ?? {}) as Record<string, unknown>)[childId], "the copy's chat context starts where the main session's did");
  await waitFor(() => delegationBatches(storage.current)[0]?.items[0]?.status === "failed");
  assert.equal(runs.filter((run) => run.participant.id === childId).length, 2, "the copy, then the clean start");
  const notice = `@${String(result.handle).slice(1)} could not start from a copy of @main's session, so this turn started a clean session.`;
  const failed = storage.current.messages.find((message: ChatMessage) => message.participantId === childId && message.status === "error");
  assert.ok(failed?.content.includes(notice), failed?.content);
  const pointers = (storage.current.metadata.promptContextPointers ?? {}) as Record<string, { timeline?: unknown; threads?: unknown; forgottenAt?: string }>;
  // Its chat context starts over: no pointer, only the marker that keeps an
  // older copy of the chat from bringing its pointers back.
  assert.equal(pointers[childId]?.timeline, undefined, "its chat context starts over");
  assert.equal(pointers[childId]?.threads, undefined);
  assert.ok(pointers[childId]?.forgottenAt);
  // Its next turn: a new session's first, given the chat from its start.
  overloaded = false;
  const asked = await service.requestParticipantsFromTool(mainActor(undefined, { triggerMessageId: "trigger-next" }), { requests: [{ target: String(result.handle), prompt: "Try again." }] });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  await waitFor(() => runs.filter((run) => run.participant.id === childId).length === 3);
  const next = runs.filter((run) => run.participant.id === childId)[2]!;
  assert.equal(next.options.forkFromSessionId, undefined);
  assert.ok(!next.options.sessionId, "no session of its own yet");
  assert.doesNotMatch(next.prompt, /You were forked from/);
});
test("a failure that is not a missing source does not count as a failed fork", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")] });
  const { service, storage } = testService({
    conversation,
    run: async (participant) => participant.id === main.id
      ? { participant, ok: true, content: "Noted.", durationMs: 1 }
      : { participant, ok: false, content: "", error: "Model not found: gpt-unknown", durationMs: 1 }
  });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Continue.", start: "fork" });
  assert.equal(result.ok, true, JSON.stringify(result));
  await waitFor(() => delegationBatches(storage.current)[0]?.items[0]?.status === "failed");
  const session = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === result.participantId)!;
  assert.deepEqual(session.forkFrom, { participantId: main.id, sessionId: "main-cli-session", kind: "codex-cli" }, "still a fork, no failed attempt counted");
});

test("a fork the CLI starts clean (its source is gone) is still told who it is, with its role, and the chat says it started clean", async () => {
  const main = mainSession("claude-code");
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-cli-session")] });
  const { service, storage, runs } = testService({
    conversation,
    run: async (participant, _prompt, runOptions) => {
      if (participant.id === main.id) return { participant, ok: true, content: "Noted.", durationMs: 1 };
      // The CLI's resume-miss fallback: a new session from resumeFallbackPrompt.
      runOptions.onSessionId?.("fallback-session");
      return { participant, ok: true, content: "Done.", durationMs: 1, sessionId: "fallback-session", sessionRestarted: true };
    }
  });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Continue the refactor.", start: "fork", handle: "refactor" });
  assert.equal(result.ok, true, JSON.stringify(result));
  await waitFor(() => runs.some((run) => run.participant.id === result.participantId));
  const fallback = String(runs.find((run) => run.participant.id === result.participantId)!.options.resumeFallbackPrompt);
  assert.match(fallback, /^<<<APP [0-9a-f]{8}>>>\nYou were to start from a copy of @main's session, but it could not be copied/);
  assert.match(fallback, /You are @refactor, role: Generic Member\. You are not the main session\./);
  assert.match(fallback, /Do only the task in the request below/);
  assert.match(fallback, /Answer directly\./, "its role's instructions");
  assert.match(fallback, /Continue the refactor\./, "and its task");

  await waitFor(() => (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === result.participantId)?.sessionId === "fallback-session");
  const session = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === result.participantId)!;
  assert.equal(session.forkFrom, undefined);
  assert.equal(session.forkedFromParticipantId, undefined, "not reminded later that it is a fork");
  const notice = "@refactor could not start from a copy of @main's session, so it started a clean session from the saved chat context.";
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.role === "system" && message.content === notice));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(storage.current.messages.filter((message: ChatMessage) => message.role === "system" && message.content === notice).length, 1, "once");
  assert.deepEqual(storage.current.metadata.warnings ?? [], [notice], "the warning the device that ran it shows, not the CLI's own restart warning");
});

test("a fork never takes the source's session id as its own", () => {
  const main = mainSession();
  const { service } = testService({ conversation: mainSessionChat([main]) });
  const session = { ...sessionRecord(member("c", "c"), ""), forkFrom: { participantId: main.id, sessionId: "main-cli-session", kind: "claude-code" as const } };
  const conversation = mainSessionChat([main]);
  (service as any).persistParticipantSessionId(conversation, session, "main-cli-session");
  assert.equal(session.sessionId, "");
  assert.ok(session.forkFrom);
  (service as any).applyCliRunMetadata(session, { participant: {}, ok: true, content: "", sessionId: "main-cli-session" }, member("c", "c"), []);
  assert.equal(session.sessionId, "");
  (service as any).applyCliRunMetadata(session, { participant: {}, ok: true, content: "", sessionId: "child-session" }, member("c", "c"), []);
  assert.equal(session.sessionId, "child-session");
  assert.equal(session.forkFrom, undefined);
});

// --- one resume for the tasks of one turn ---------------------------------------

/** A main-session turn running here, as runParticipantTurnSerialized marks it. */
function liveTurn(service: unknown, turnSegmentId: string): { end: () => void } {
  const internals = service as any;
  const key = `conversation-1\u0000${turnSegmentId}`;
  internals.liveTurnSegments.add(key);
  return {
    end: () => {
      internals.liveTurnSegments.delete(key);
      internals.resumeDelegationsOfEndedTurn(key);
    }
  };
}

/** A member run the test finishes when it says so (or that ends when stopped). */
function heldRuns() {
  const releases = new Map<string, (result: { ok: boolean; content?: string; error?: string }) => void>();
  const run = (participant: ParticipantConfig, _prompt: string, _options: any, signal?: AbortSignal) =>
    new Promise<any>((resolve) => {
      const finish = (result: { ok: boolean; content?: string; error?: string }) =>
        resolve({ participant, durationMs: 1, content: "", ...result });
      releases.set(participant.id, finish);
      signal?.addEventListener("abort", () => finish({ ok: false, error: "Chat run cancelled." }), { once: true });
    });
  return { run, release: (id: string, result: { ok: boolean; content?: string; error?: string }) => releases.get(id)?.(result), started: (id: string) => releases.has(id) };
}

const resumesOf = (runs: RunCall[], mainId: string) => runs.filter((run) => run.participant.id === mainId && run.prompt.includes("Auto-resumed @main"));

test("the tasks of one main-session turn resume it once, after the turn and the last task, with every answer", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const worker = member("worker-id", "worker");
  const conversation = mainSessionChat([main, worker], { participantSessions: [sessionRecord(main, "main-thread")] });
  const held = heldRuns();
  const { service, storage, runs, debugEvents } = testService({
    conversation,
    run: (participant, prompt, runOptions, signal) => participant.id === main.id || participant.id === worker.id
      ? Promise.resolve({ participant, ok: true, content: `Done by ${participant.id}.`, durationMs: 1 })
      : held.run(participant, prompt, runOptions, signal)
  });
  const turn = liveTurn(service, "turn-1");
  const actor = mainActor(undefined, { turnSegmentId: "turn-1" });

  const first = await service.delegateTaskFromTool(actor, { title: "Write tests", task: "Write the tests." });
  const second = await service.delegateTaskFromTool(actor, { title: "Update docs", task: "Update the docs.", roleConfigId: REVIEWER_ROLE.id });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(first.handle, "@codex");
  assert.equal(second.handle, "@code-reviewer");
  assert.deepEqual(delegationBatches(storage.current).map((batch) => batch.delegation), [{ start: "clean", turnId: "turn-1" }, { start: "clean", turnId: "turn-1" }]);
  // An ordinary request in the same turn is not held by the tasks: it resumes the main session on its own.
  const asked = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "Check the build." }] });
  assert.equal(asked.ok, true, JSON.stringify(asked));

  await waitFor(() => held.started(String(first.participantId)) && held.started(String(second.participantId)));
  // The first task ends while the turn still runs, the second after it.
  held.release(String(first.participantId), { ok: true, content: "Tests written." });
  await waitFor(() => delegationBatches(storage.current)[0]?.items[0]?.status === "answered");
  turn.end();
  await waitFor(() => debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.skipped" && event.payload.reason === "waiting-for-tasks-of-the-same-turn"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(runs, main.id).filter((run) => run.prompt.includes("tasks you gave")).length, 0, "not while a task of the turn still runs");

  held.release(String(second.participantId), { ok: true, content: "Docs updated." });
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(runs, main.id).filter((run) => run.prompt.includes("tasks you gave"));
  assert.equal(resumes.length, 1, "one resume for both tasks");
  assert.match(resumes[0]!.prompt, /All 2 tasks you gave in one turn have ended:/);
  assert.match(resumes[0]!.prompt, /- @codex \(task "Write tests"\): answered/);
  assert.match(resumes[0]!.prompt, /- @code-reviewer \(task "Update docs"\): answered/);
  assert.match(resumes[0]!.prompt, /Tests written\./, "the first task's reply");
  assert.match(resumes[0]!.prompt, /Docs updated\./, "and the second's");
  assert.equal((resumes[0]!.prompt.match(/Tests written\./g) ?? []).length, 1, "each reply once");
  const [one, two] = delegationBatches(storage.current);
  assert.equal(one!.autoResumeMessageId, two!.autoResumeMessageId, "both answered by the same reply");
  // In the classic view that reply is in the first task's thread, on every device.
  const firstRequest = storage.current.messages.find((message: ChatMessage) => message.metadata?.participantRequest?.id === one!.id)!;
  assert.equal(chatParticipantRequestReplyRootMap(storage.current).get(one!.autoResumeMessageId!), firstRequest.id);
  assert.equal(storage.current.messages.find((message: ChatMessage) => message.id === one!.autoResumeMessageId)?.metadata?.chatThreadRootId, firstRequest.id);
  assert.deepEqual(delegationBatches(storage.current).map((batch) => batch.status), ["completed", "completed"]);
  // The ordinary request resumed it on its own.
  await waitFor(() => resumesOf(runs, main.id).length === 2);
  assert.deepEqual(debugEvents.filter((item) => item.event.endsWith(".error")), []);
});

test("tasks that all end while their turn still runs resume the main session once, when the turn ends", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const { service, storage, runs, debugEvents } = testService({ conversation });
  const turn = liveTurn(service, "turn-2");
  const actor = mainActor(undefined, { turnSegmentId: "turn-2" });
  await service.delegateTaskFromTool(actor, { title: "One", task: "Do one." });
  await service.delegateTaskFromTool(actor, { title: "Two", task: "Do two." });
  await waitFor(() => delegationBatches(storage.current).every((batch) => batch.items[0]?.status === "answered"));
  await waitFor(() => debugEvents.filter((event) => event.payload.reason === "delegating-turn-running").length >= 2);
  assert.equal(resumesOf(runs, main.id).length, 0, "the turn still runs");
  turn.end();
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(runs, main.id).length, 1);
});

test("a task stopped by User and a task that failed still resume the main session once, with how each ended", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const held = heldRuns();
  const { service, storage, runs } = testService({
    conversation,
    run: (participant, prompt, runOptions, signal) => participant.id === main.id
      ? Promise.resolve({ participant, ok: true, content: "Noted.", durationMs: 1 })
      : held.run(participant, prompt, runOptions, signal)
  });
  const turn = liveTurn(service, "turn-3");
  const actor = mainActor(undefined, { turnSegmentId: "turn-3" });
  const stopped = await service.delegateTaskFromTool(actor, { title: "Long job", task: "Run the long job." });
  const failing = await service.delegateTaskFromTool(actor, { title: "Broken job", task: "Run the broken job." });
  const ok = await service.delegateTaskFromTool(actor, { title: "Quick job", task: "Run the quick job." });
  turn.end();
  await waitFor(() => [stopped, failing, ok].every((result) => held.started(String(result.participantId))));
  held.release(String(failing.participantId), { ok: false, error: "Model not found: gpt-unknown" });
  held.release(String(ok.participantId), { ok: true, content: "Quick job done." });
  // Stop on one member: its own run only.
  const runId = () => storage.current.messages.find((message) => message.participantId === stopped.participantId && message.status === "pending")?.metadata?.runId;
  await waitFor(() => Boolean(runId()));
  assert.equal(service.cancelRun(String(runId())), true);
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(runs, main.id);
  assert.equal(resumes.length, 1);
  const statuses = delegationBatches(storage.current).map((batch) => batch.items[0]!.status);
  assert.deepEqual(statuses, ["interrupted", "failed", "answered"]);
  assert.match(resumes[0]!.prompt, /\(task "Long job"\): stopped by User/);
  assert.match(resumes[0]!.prompt, /\(task "Broken job"\): failed/);
  assert.match(resumes[0]!.prompt, /\(task "Quick job"\): answered/);
  assert.match(resumes[0]!.prompt, /Quick job done\./);
});

test("a lone task the User stopped resumes the main session with the task list too, the task shown as stopped", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const held = heldRuns();
  const { service, storage, runs } = testService({
    conversation,
    run: (participant, prompt, runOptions, signal) => participant.id === main.id
      ? Promise.resolve({ participant, ok: true, content: "Noted.", durationMs: 1 })
      : held.run(participant, prompt, runOptions, signal)
  });
  const turn = liveTurn(service, "turn-lone");
  const lone = await service.delegateTaskFromTool(mainActor(undefined, { turnSegmentId: "turn-lone" }), { title: "Long job", task: "Run the long job." });
  assert.equal(lone.ok, true, JSON.stringify(lone));
  turn.end();
  await waitFor(() => held.started(String(lone.participantId)));
  const runId = () => storage.current.messages.find((message) => message.participantId === lone.participantId && message.status === "pending")?.metadata?.runId;
  await waitFor(() => Boolean(runId()));
  assert.equal(service.cancelRun(String(runId())), true);
  await waitFor(() => Boolean(delegationBatches(storage.current)[0]?.autoResumeMessageId));
  const resumes = resumesOf(runs, main.id);
  assert.equal(resumes.length, 1);
  assert.match(resumes[0]!.prompt, /The task you gave has ended:/);
  assert.match(resumes[0]!.prompt, /- @\w[\w-]* \(task "Long job"\): stopped by User/);
  assert.doesNotMatch(resumes[0]!.prompt, /Target replies\/errors are in the transcript above/, "not the generic line");
});

test("a combined resume cuts oversized replies: each to 12,000 characters, all to 60,000, each cut one saying where the rest is", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const letters = "abcdef";
  const { service, storage, runs } = testService({
    conversation,
    run: async (participant) => {
      if (participant.id === main.id) return { participant, ok: true, content: "Noted.", durationMs: 1 };
      const index = runs.filter((run) => run.participant.id !== main.id).length - 1;
      return { participant, ok: true, content: `reply-${index}:` + letters[index]!.repeat(15_000), durationMs: 1 };
    }
  });
  const turn = liveTurn(service, "turn-big");
  const actor = mainActor(undefined, { turnSegmentId: "turn-big" });
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const result = await service.delegateTaskFromTool(actor, { title: `Big ${index}`, task: `Write a long report ${index}.` });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  turn.end();
  await waitFor(() => delegationBatches(storage.current).length === 6 && delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)), 6000);
  const resumes = resumesOf(runs, main.id);
  assert.equal(resumes.length, 1);
  const prompt = resumes[0]!.prompt;
  const replyIds = delegationBatches(storage.current).map((batch) => batch.items[0]!.replyMessageId!);
  for (const id of replyIds) {
    assert.ok(prompt.includes(`…cut; read the full reply with app_chat_read_messages (message id ${id}).`), `the cut reply ${id} says where the rest is`);
  }
  const kept = [...letters].map((letter) => (prompt.match(new RegExp(`${letter}{100,}`, "g")) ?? []).reduce((sum, run) => sum + run.length, 0));
  assert.ok(kept.every((count) => count <= 12_000), `each reply at most 12,000 characters: ${kept.join(", ")}`);
  assert.ok(kept.reduce((sum, count) => sum + count, 0) <= 60_000, "all of them at most 60,000");
  assert.equal(kept.filter((count) => count === 0).length, 1, "the budget is spent before the last reply: only its note");
  assert.ok(prompt.length < 80_000, `the prompt stays small: ${prompt.length}`);
  // The stored replies are whole.
  assert.ok(storage.current.messages.filter((message: ChatMessage) => replyIds.includes(message.id)).every((message: ChatMessage) => message.content.length > 15_000));
});

/** A chat whose main session gave tasks in one turn ("turn-old") before the
 *  app restarted; `at`: when the tasks were given and the answered ones
 *  answered (a few minutes ago by default, so a restart may still resume). */
function restartedChat(statuses: Array<"answered" | "running">, at = new Date(Date.now() - 5 * 60_000).toISOString()): Conversation {
  const main = mainSession("codex-cli", { model: undefined });
  const members = statuses.map((_status, index) => member(`m${index}`, `m${index}`));
  const conversation = mainSessionChat([main, ...members], { participantSessions: [sessionRecord(main, "main-thread")] });
  conversation.messages[0]!.createdAt = at;
  statuses.forEach((status, index) => {
    const replyId = `reply-${index}`;
    conversation.messages.push({
      id: `request-${index}`, role: "participant", participantId: main.id, participantLabel: "@main", content: `@m${index} Task ${index}`, createdAt: at, status: "done",
      metadata: { sourceMessageId: "user-message", threadId: "user-message", participantRequest: {
        id: `batch-${index}`, requesterParticipantId: main.id, requesterHandle: "main", source: "mcp", resumeRequester: true, status, depth: 1, requesterDepth: 0,
        chainRootId: "user-message", createdAt: at, updatedAt: at, triggerMessageId: "user-message", delegation: { start: "clean", turnId: "turn-old" },
        items: [{ targetParticipantId: `m${index}`, targetHandle: `m${index}`, prompt: `Task ${index}`, title: `Task ${index}`, status, createdAt: at, updatedAt: at,
          ...(status === "answered" ? { replyMessageId: replyId } : {}) }]
      } }
    } as ChatMessage);
    if (status === "answered") {
      conversation.messages.push({ id: replyId, role: "participant", participantId: `m${index}`, participantLabel: `@m${index}`, content: `Answer ${index}.`, createdAt: at, status: "done",
        metadata: { sourceMessageId: `request-${index}`, chatThreadRootId: `request-${index}` } } as ChatMessage);
    }
  });
  return conversation;
}

test("after a restart a task that was still running ends, and the main session gets the answers its turn's other tasks gave, once", async () => {
  const { service, storage, runs } = testService({ conversation: restartedChat(["answered", "running", "answered"]) });
  // The first read after the restart finds no run for the second task.
  await (service as any).requireChat("conversation-1");
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(runs, "main-id");
  assert.equal(resumes.length, 1);
  assert.match(resumes[0]!.prompt, /\(task "Task 1"\): interrupted/);
  assert.match(resumes[0]!.prompt, /Answer 0\./);
  assert.match(resumes[0]!.prompt, /Answer 2\./);
});

test("after a restart that ended every task of a turn, the main session is not woken, as a lone task never was", async () => {
  const { service, storage, runs, debugEvents } = testService({ conversation: restartedChat(["running", "running"]) });
  await (service as any).requireChat("conversation-1");
  await waitFor(() => delegationBatches(storage.current).every((batch) => batch.items[0]?.status === "interrupted"));
  await waitFor(() => debugEvents.some((event) => event.payload.reason === "all-items-interrupted-before-completion"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(runs, "main-id").length, 0);
});

test("after a restart while the main session's turn ran, its tasks that had all answered resume it once, with every answer", async () => {
  // Both tasks answered while the turn still ran (held as delegating-turn-running);
  // the restart ended the turn, and nothing in memory remembers to look again.
  const { service, storage, runs } = testService({ conversation: restartedChat(["answered", "answered"]) });
  await service.hydrateContextUsage(clone(storage.current));
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(runs, "main-id");
  assert.equal(resumes.length, 1);
  assert.match(resumes[0]!.prompt, /All 2 tasks you gave in one turn have ended:/);
  assert.match(resumes[0]!.prompt, /Answer 0\./);
  assert.match(resumes[0]!.prompt, /Answer 1\./);
  // Later reads do not resume it again.
  await (service as any).requireChat("conversation-1");
  await service.hydrateContextUsage(clone(storage.current));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(runs, "main-id").length, 1);
});

test("a combined resume a restart cut short after it began is not made again: its tasks are settled and stop holding later looks", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  for (const message of conversation.messages) {
    if (message.metadata?.participantRequest) message.metadata.participantRequest.status = "resuming_requester";
  }
  // Its resume line was written: the resume turn ran, and may have done its work.
  conversation.messages.push({ id: "cut-trigger", role: "system", content: "Auto-resumed @main after member request.\nAll 2 tasks you gave in one turn have ended:",
    createdAt: new Date(Date.now() - 4 * 60_000).toISOString(), status: "done", metadata: { sourceMessageId: "request-0", parentMessageId: "request-0", threadId: "user-message" } } as ChatMessage);
  const { service, storage, runs, debugEvents } = testService({ conversation });
  await (service as any).requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0, "the resume turn is not replayed");
  assert.deepEqual(delegationBatches(storage.current).map((batch) => batch.status), ["answered", "answered"], "settled: no longer resuming");
  assert.equal(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.recovered"), false);
  assert.ok(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === "resume-already-made"));
});

test("a combined resume a restart lost before its resume line was written is made, once", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  for (const message of conversation.messages) {
    if (message.metadata?.participantRequest) message.metadata.participantRequest.status = "resuming_requester";
  }
  const { service, storage, runs } = testService({ conversation });
  await (service as any).requireChat("conversation-1");
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resumes = resumesOf(runs, "main-id");
  assert.equal(resumes.length, 1);
  assert.match(resumes[0]!.prompt, /Answer 0\./);
  assert.match(resumes[0]!.prompt, /Answer 1\./);
  assert.deepEqual(delegationBatches(storage.current).map((batch) => batch.status), ["completed", "completed"]);
});

test("tasks that ended more than a day before the restart do not wake the main session; they are settled quietly", async () => {
  const { service, storage, runs, debugEvents } = testService({ conversation: restartedChat(["answered", "answered"], new Date(Date.now() - 25 * 60 * 60_000).toISOString()) });
  await (service as any).requireChat("conversation-1");
  await service.hydrateContextUsage(clone(storage.current));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0);
  assert.ok(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === "too-old"));
  assert.equal(storage.current.messages.filter((message: ChatMessage) => message.role === "system").length, 0, "no resume line either");
});

test("a task a restart ended a day after its turn does not wake the main session with the others' answers", async () => {
  const { service, runs, debugEvents } = testService({ conversation: restartedChat(["answered", "running"], new Date(Date.now() - 25 * 60 * 60_000).toISOString()) });
  await (service as any).requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0);
  assert.ok(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === "too-old"));
});

test("after the User wrote again, a restart does not wake the main session with the tasks that ended before", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  conversation.messages.push({ id: "user-later", role: "user", content: "Never mind, do something else.", createdAt: new Date(Date.now() - 60_000).toISOString(), status: "done" } as ChatMessage);
  const { service, runs, debugEvents } = testService({ conversation });
  await (service as any).requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0);
  assert.ok(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === "moved-on"));
});

test("after a later turn of the main session, a restart does not wake it with the tasks that ended before", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  // A turn of its own after the tasks ended (another member asked it), not the turn that gave them.
  conversation.messages.push({ id: "main-later", role: "participant", participantId: "main-id", participantLabel: "@main", content: "Already merged both answers.",
    createdAt: new Date(Date.now() - 60_000).toISOString(), status: "done", metadata: { turnSegmentId: "turn-later" } } as ChatMessage);
  const { service, runs, debugEvents } = testService({ conversation });
  await (service as any).requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0);
  assert.ok(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.settled" && event.payload.reason === "moved-on"));
});

test("the turn that gave the tasks writing after they ended still lets a restart resume the main session", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  // A post of the turn that gave the tasks, after they answered: still that turn.
  conversation.messages.push({ id: "main-post", role: "participant", participantId: "main-id", participantLabel: "@main", content: "Both answered; merging.",
    createdAt: new Date(Date.now() - 60_000).toISOString(), status: "done", metadata: { turnSegmentId: "turn-old" } } as ChatMessage);
  const { service, storage, runs } = testService({ conversation });
  await (service as any).requireChat("conversation-1");
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  assert.equal(resumesOf(runs, "main-id").length, 1);
});

test("a restart looks at a chat's ended tasks once, not on every read of the chat", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  for (const message of conversation.messages) {
    if (message.metadata?.participantRequest) message.metadata.participantRequest.status = "failed";
  }
  conversation.messages.push({ id: "failed-trigger", role: "system", content: "Auto-resumed @main after member request.",
    createdAt: new Date(Date.now() - 4 * 60_000).toISOString(), status: "done", metadata: { sourceMessageId: "request-0", parentMessageId: "request-0", threadId: "user-message" } } as ChatMessage);
  const { service, storage } = testService({ conversation });
  const internals = service as any;
  let looks = 0;
  const original = internals.delegationGroupResumeWasMade.bind(service);
  internals.delegationGroupResumeWasMade = (...args: unknown[]) => { looks += 1; return original(...args); };
  for (let index = 0; index < 3; index += 1) await internals.requireChat("conversation-1");
  await service.hydrateContextUsage(clone(storage.current));
  assert.equal(looks, 1);
});

test("a combined resume that was made and failed is not made again by a restart", async () => {
  const conversation = restartedChat(["answered", "answered"]);
  for (const message of conversation.messages) {
    if (message.metadata?.participantRequest) message.metadata.participantRequest.status = "failed";
  }
  conversation.messages.push({ id: "failed-trigger", role: "system", content: "Auto-resumed @main after member request.",
    createdAt: NOW, status: "done", metadata: { sourceMessageId: "request-0", parentMessageId: "request-0", threadId: "user-message" } } as ChatMessage);
  const { service, runs, debugEvents } = testService({ conversation });
  await (service as any).requireChat("conversation-1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resumesOf(runs, "main-id").length, 0);
  assert.equal(debugEvents.some((event) => event.event === "chat.participant-request.auto-resume.recovered"), false);
});

test("a member's turn that is not a task of the main session does not wake it: the User writing in the member's session", async () => {
  // The User, 2026-11-21: the main session is woken only when its own tasks
  // end; what a member does otherwise it reads on its next turn.
  const main = mainSession("codex-cli", { model: undefined });
  const worker = member("worker-id", "worker");
  const conversation = mainSessionChat([main, worker], { participantSessions: [sessionRecord(main, "main-thread")] });
  const { service, storage, runs, debugEvents } = testService({ conversation });
  await service.sendMessage({ conversationId: conversation.id, runId: "to-worker", content: "Please also check dark mode", targetParticipantIds: [worker.id] });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.participantId === worker.id && message.status === "done"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(runs.map((run) => run.participant.id), [worker.id], "only the member ran");
  assert.equal(resumesOf(runs, main.id).length, 0, "the main session is not woken");
  assert.deepEqual(debugEvents.filter((item) => item.event.endsWith(".error")), []);
});

test("a task given after its turn ended (a CLI still at work in the background) resumes the main session on its own", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const { service, storage, runs } = testService({ conversation });
  const late = await service.delegateTaskFromTool(mainActor(undefined, { turnSegmentId: "turn-over" }), { title: "Late", task: "Do it later." });
  assert.equal(late.ok, true, JSON.stringify(late));
  assert.deepEqual(delegationBatches(storage.current)[0]!.delegation, { start: "clean" }, "no turn to wait for");
  await waitFor(() => Boolean(delegationBatches(storage.current)[0]?.autoResumeMessageId));
  assert.equal(resumesOf(runs, main.id).length, 1);
});

test("a cloud machine's main session: the tasks of its turn resume it once, on the machine", async () => {
  const main = mainSession("codex-cli", { model: undefined, homeMachineId: "machine-1" });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "main-thread")] });
  const { service, storage, runs } = testService({ conversation });
  service.setHostMachineId("machine-1");
  const turn = liveTurn(service, "turn-m");
  const actor = mainActor(undefined, { turnSegmentId: "turn-m" });
  const a = await service.delegateTaskFromTool(actor, { title: "Machine A", task: "Do A." });
  const b = await service.delegateTaskFromTool(actor, { title: "Machine B", task: "Do B." });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  const children = participantsOf(storage.current).filter((participant) => participant.id !== main.id);
  assert.ok(children.every((child) => child.homeMachineId === "machine-1"), "its members run on its machine");
  turn.end();
  await waitFor(() => delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumesOf(runs, main.id).length, 1);
});

test("a member the main session gives no permissions inherits its rights, and member management stays off", async () => {
  const main = mainSession("claude-code", { agentMode: "plan" });
  const { service, storage } = testService({ conversation: mainSessionChat([main], { participantSessions: [sessionRecord(main, "s")] }) });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Plan it." });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.equal(child.agentMode, "plan");
  const granted = normalizeChatAgentPermissions(child.permissions);
  assert.equal(granted.workspaceWrite, false, "plan mode has no edits, so the child has none");
  assert.equal(granted.shell.enabled, false);
  assert.equal(granted.manageRolesParticipants, "deny");
});

test("delegation refuses the main session, Chat Assistant and Workflow Manager roles", async () => {
  const main = mainSession();
  const { service } = testService({ conversation: mainSessionChat([main]) });
  for (const roleConfigId of ["main-session", "administrator", "workflow-manager"]) {
    const result = await service.delegateTaskFromTool(mainActor(), { task: "T", roleConfigId });
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_role");
  }
});

test("the main session adding a member broader than itself through the member tool gets a card instead", async () => {
  const main = mainSession();
  const { service, storage } = testService({ conversation: mainSessionChat([main]) });
  const actor = mainActor(["participants.manage"]);
  const broader = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "web", roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", permissions: permissions({ webAccess: true }) } }]
  });
  assert.equal(broader.status, "pending_user_approval");
  const within = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "reader", roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", permissions: permissions() } }]
  });
  assert.equal(within.status, "auto_applied");
  assert.deepEqual(participantsOf(storage.current).map((participant) => participant.handle), ["main", "reader"]);
});

// "No Custom in the sessions view" (the User, 2026-11-22): every member added
// to a chat with a main session runs in its CLI's own mode, whoever added it.
test("every member added to a chat with a main session runs in its CLI's own mode: on her approval card, by a member without a card, or by her from the roster", async () => {
  const main = mainSession();
  const { service, storage } = testService({ conversation: mainSessionChat([main]) });
  (service as any).cliRunner.detectAgents = async () => [
    { kind: "codex-cli", label: "Codex CLI", installed: true },
    { kind: "claude-code", label: "Claude Code", installed: true }
  ];
  const accessOf = (handle: string) => {
    const added = participantsOf(storage.current).find((participant) => participant.handle === handle)!;
    assert.equal(normalizeChatAgentPermissions(added.permissions).cliApprovals, true, `@${handle} in its CLI's own mode`);
    return selectedChatAccessOption(added.kind, added.agentMode, added.permissions)?.id;
  };
  const actor = mainActor(["participants.manage"]);
  // On her card (a member broader than the main session).
  const asked = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "web", roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", permissions: permissions({ webAccess: true }) } }]
  });
  assert.equal(asked.status, "pending_user_approval");
  const card = (storage.current.metadata.pendingAppToolApprovals as Array<{ id: string; status: string }>).find((approval) => approval.status === "pending")!;
  await service.respondToAppToolApproval({ conversationId: storage.current.id, approvalId: card.id, approve: true });
  await waitFor(() => participantsOf(storage.current).some((participant) => participant.handle === "web"));
  assert.equal(accessOf("web"), "read-only", "Codex without file edits: Read Only");
  // Without a card.
  const within = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "reader", roleConfigId: GENERIC_ROLE.id, kind: "claude-code", permissions: permissions() } }]
  });
  assert.equal(within.status, "auto_applied");
  assert.equal(accessOf("reader"), "manual");
  // By her, from the roster.
  await service.addParticipant({
    conversationId: storage.current.id,
    participant: { handle: "editor", roleConfigId: GENERIC_ROLE.id, kind: "claude-code", agentMode: "default", permissions: permissions({ workspaceWrite: true }) } as any
  });
  assert.equal(accessOf("editor"), "acceptEdits");
  const editor = participantsOf(storage.current).find((participant) => participant.handle === "editor")!;
  assert.equal(editor.delegatedByParticipantId, undefined, "hers: not held to the main session's rights");
});

test("a member added to a chat without a main session keeps the rights it was given", async () => {
  const conversation = { ...mainSessionChat([member("worker-id", "worker")]), metadata: { participants: [member("worker-id", "worker")] } } as Conversation;
  const { service, storage } = testService({ conversation });
  (service as any).cliRunner.detectAgents = async () => [{ kind: "codex-cli", label: "Codex CLI", installed: true }];
  await service.addParticipant({
    conversationId: conversation.id,
    participant: { handle: "classic", roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", agentMode: "default", permissions: permissions({ workspaceWrite: true }) } as any
  });
  const added = participantsOf(storage.current).find((participant) => participant.handle === "classic")!;
  assert.equal(normalizeChatAgentPermissions(added.permissions).cliApprovals, undefined);
});

test("a chat in the sessions view opened on the computer moves its classic-rights members into their CLI's own mode once, and is marked so a later change is not undone", async () => {
  const main = mainSession("claude-code", { permissions: { ...normalizeChatAgentPermissions(mainSession().permissions), cliApprovals: true } });
  const classic = member("worker-id", "worker", { kind: "claude-code", permissions: permissions({ workspaceWrite: true }) });
  const { service, storage } = testService({ conversation: mainSessionChat([main, classic], { chatView: "sessions" }) });
  await service.hydrateContextUsage(clone(storage.current));
  await waitFor(() => typeof storage.current.metadata.cliModesConvertedAt === "string");
  const worker = participantsOf(storage.current).find((participant) => participant.id === "worker-id")!;
  assert.equal(normalizeChatAgentPermissions(worker.permissions).cliApprovals, true);
  assert.equal(selectedChatAccessOption(worker.kind, worker.agentMode, worker.permissions)?.id, "acceptEdits", "the mode it ran in");
  // Something sets classic rights on it later: opening the chat again leaves it.
  storage.current.metadata.participants = participantsOf(storage.current).map((participant) =>
    participant.id === "worker-id" ? { ...participant, permissions: permissions({ workspaceWrite: true }) } : participant);
  const marked = storage.current.metadata.cliModesConvertedAt;
  await service.hydrateContextUsage(clone(storage.current));
  const fresh = testService({ conversation: clone(storage.current) });
  await fresh.service.hydrateContextUsage(clone(fresh.storage.current));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(normalizeChatAgentPermissions(participantsOf(fresh.storage.current).find((participant) => participant.id === "worker-id")!.permissions).cliApprovals, undefined,
    "marked: not converted again, also after a restart");
  assert.equal(fresh.storage.current.metadata.cliModesConvertedAt, marked);
});

test("a chat shown in the classic view, and any chat on a machine, is not converted when opened", async () => {
  const main = mainSession();
  const classic = member("worker-id", "worker", { kind: "claude-code" });
  const inClassic = testService({ conversation: mainSessionChat([main, classic], { chatView: "classic" }) });
  await inClassic.service.hydrateContextUsage(clone(inClassic.storage.current));
  const onMachine = testService({ conversation: mainSessionChat([main, classic], { chatView: "sessions" }) });
  onMachine.service.setHostMachineId("box");
  await onMachine.service.hydrateContextUsage(clone(onMachine.storage.current));
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const { storage } of [inClassic, onMachine]) {
    assert.equal(storage.current.metadata.cliModesConvertedAt, undefined);
    assert.equal(normalizeChatAgentPermissions(participantsOf(storage.current)[1].permissions).cliApprovals, undefined);
  }
});

// --- what other members are told -----------------------------------------------

test("members of a main-session chat ask the main session, not User, and do not start Accords", () => {
  const main = mainSession();
  const worker = member("worker-id", "worker");
  const conversation = mainSessionChat([main, worker]);
  const { service } = testService({ conversation });
  const internals = service as any;
  assert.equal(internals.mainSessionHandleForMember(conversation, worker), "main");
  assert.equal(internals.mainSessionHandleForMember(conversation, main), undefined);

  const access = { agentMode: "default", permissions: defaultChatAgentPermissions() };
  const workerInstructions = internals.sessionInstructions(conversation, worker, sessionRecord(worker, "s", GENERIC_ROLE), access, "/tmp/accordagents-history") as string;
  assert.match(workerInstructions, /ask @main with `app_chat_request_participants` instead of asking User/);
  assert.match(workerInstructions, /Do not write a `User choice:` block unless @main asked you to put a question to User\./);
  assert.match(workerInstructions, /Do not start an Accord; when one is needed, ask @main\./);
  assert.match(workerInstructions, /"target": "main"/);
  assert.doesNotMatch(workerInstructions, /Ask User directly/);

  const mainInstructions = internals.sessionInstructions(conversation, main, sessionRecord(main, "s"), access, "/tmp/accordagents-history") as string;
  assert.match(mainInstructions, /Ask User directly when goals/);
  assert.match(mainInstructions, /- When User must pick one option/);
  assert.doesNotMatch(mainInstructions, /ask @main/);
});

// --- Accord --------------------------------------------------------------------

function accordSkills() {
  const variant = (kind: ChatProviderKind) => ({ providerKind: kind, scope: "personal", rootKind: "personal", sourceKey: "src", frontmatterName: "accord", contentHash: "hash", capabilityState: "invocable" });
  const skill = {
    skillId: "skill-1", displayName: "/accord", frontmatterName: "accord", description: "Accord", contentHash: "hash", capabilityState: "invocable",
    variants: [variant("claude-code"), variant("codex-cli")]
  };
  return {
    async search() { return { skills: [skill] }; },
    async validateMentionForParticipant(mention: unknown) { return { ok: true, mention }; },
    async resolveInvocableSkillsForParticipant() { return [{ name: "accord", dir: "/tmp/accord-skill" }]; }
  };
}

test("the main session's Accord is launched as its own message and read as an Accord card", async () => {
  const main = mainSession();
  const worker = member("worker-id", "worker");
  const { service, storage, runs } = testService({ conversation: mainSessionChat([main, worker]), userSkills: accordSkills() });

  const result = await service.startAccordFromTool(mainActor(), { targets: ["@worker"], subject: "Pick the database." });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.facilitator, "@main", "the main session leads it by default");
  const launch = storage.current.messages.find((message: ChatMessage) => message.id === result.launchMessageId)!;
  assert.equal(launch.role, "participant", "written as the main session's, not as if User wrote it");
  assert.equal(launch.participantId, main.id);
  assert.equal(launch.metadata?.accordLaunchByMainSession, true);
  assert.deepEqual(accordLaunchCardForMessage(launch), { facilitator: "main", members: ["worker"], subject: "Pick the database." });
  // Another member's message of the same text is not a launch.
  assert.equal(accordLaunchCardForMessage({ role: launch.role, content: launch.content, metadata: {} }), undefined);
  await waitFor(() => runs.some((run) => run.participant.id === main.id && run.prompt.includes("/accord")));
});

test("the facilitator the main session names gets leave to ask members no broader than the main session's", async () => {
  const main = mainSession("claude-code", { permissions: permissions({ requestParticipants: "ask" }) });
  const lead = member("lead-id", "lead", { permissions: permissions({ requestParticipants: "deny" }) });
  const worker = member("worker-id", "worker");
  const { service, storage } = testService({ conversation: mainSessionChat([main, lead, worker]), userSkills: accordSkills() });
  const result = await service.startAccordFromTool(mainActor(), { targets: ["worker"], subject: "Agree on the plan.", facilitator: "lead" });
  assert.equal(result.ok, true, JSON.stringify(result));
  const leadAfter = participantsOf(storage.current).find((participant) => participant.id === lead.id)!;
  assert.equal(normalizeChatAgentPermissions(leadAfter.permissions).requestParticipants, "ask");
});

test("only the main session starts an Accord through the tool", async () => {
  const main = mainSession();
  const worker = member("worker-id", "worker");
  const { service, storage } = testService({ conversation: mainSessionChat([main, worker]), userSkills: accordSkills() });
  const result = await service.startAccordFromTool(mainActor(["accord.start"], { participantId: worker.id }), { targets: ["main"], subject: "X" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "not_main_session");
  assert.equal(storage.current.messages.length, 1);
});

test("in a main-session chat shown the classic way another member's '@x /accord' reply starts nothing; the main session's still does", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const worker = member("worker-id", "worker", { permissions: permissions({ requestParticipants: "allow" }) });
  const other = member("other-id", "other");
  const conversation = mainSessionChat([main, worker, other], { chatView: "classic" });
  const { service } = testService({ conversation });
  (service as any).startDeferredParticipantRequestRunners = () => undefined;

  const fromWorker: ChatMessage = {
    id: "worker-reply", role: "participant", participantId: worker.id, participantLabel: "@worker",
    content: "@other /accord on the rollout plan.", createdAt: NOW, status: "done", metadata: { threadId: "user-message", runId: "worker-run" }
  };
  conversation.messages.push(fromWorker);
  await (service as any).createImplicitParticipantRequestApproval(conversation, worker, [fromWorker]);
  assert.equal(conversation.messages.some((message) => message.metadata?.participantRequest), false, "no request, no Accord");
  assert.equal(normalizeChatAgentPermissions(participantsOf(conversation).find((item) => item.id === other.id)!.permissions).requestParticipants, "ask");
  assert.ok((conversation.metadata.warnings as string[]).some((warning) => warning.includes("only this chat's own session starts one")));

  const fromMain: ChatMessage = {
    id: "main-reply", role: "participant", participantId: main.id, participantLabel: "@main",
    content: "@other /accord on the rollout plan.", createdAt: NOW, status: "done", metadata: { threadId: "user-message", runId: "main-run" }
  };
  conversation.messages.push(fromMain);
  await (service as any).createImplicitParticipantRequestApproval(conversation, main, [fromMain]);
  assert.ok(conversation.messages.some((message) => message.metadata?.participantRequest?.requesterParticipantId === main.id));
  assert.equal(normalizeChatAgentPermissions(participantsOf(conversation).find((item) => item.id === other.id)!.permissions).requestParticipants, "allow");
});

test("in the sessions view an @handle in a member's reply or post starts nobody; the classic view still asks (the User, 2026-11-22)", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const worker = member("worker-id", "worker", { permissions: permissions({ requestParticipants: "allow" }) });
  const other = member("other-id", "other");
  const reply = (id: string, from: ChatParticipant, content: string, extra: Record<string, unknown> = {}): ChatMessage => ({
    id, role: "participant", participantId: from.id, participantLabel: `@${from.handle}`, content, createdAt: NOW, status: "done",
    metadata: { threadId: "user-message", runId: `${id}-run`, ...extra }
  });
  const requests = (conversation: Conversation) => conversation.messages.filter((message) => message.metadata?.participantRequest);

  for (const chatView of [undefined, "sessions"] as const) {
    const conversation = mainSessionChat([main, worker, other], chatView ? { chatView } : {});
    const { service } = testService({ conversation });
    (service as any).startDeferredParticipantRequestRunners = () => undefined;
    const messages = [
      reply("main-reply", main, "@worker please check the logs."),
      reply("worker-reply", worker, "Done. @other can you confirm the numbers?"),
      reply("worker-post", worker, "@main the build is green.", { appMessageSource: "app_chat_send_message" }),
      reply("main-accord", main, "@other /accord on the rollout plan."),
      reply("worker-accord", worker, "@other /accord on the rollout plan.")
    ];
    for (const message of messages) {
      conversation.messages.push(message);
      const from = message.participantId === main.id ? main : worker;
      const started = await (service as any).createImplicitParticipantRequestApproval(conversation, from, [message]);
      assert.deepEqual(started, [], `${chatView ?? "default view"}: ${message.id} starts nobody`);
    }
    assert.equal(requests(conversation).length, 0, "no task row, no turn");
    assert.deepEqual(conversation.metadata.warnings ?? [], [], "no warning either, the Accord one included");
    assert.equal(normalizeChatAgentPermissions(participantsOf(conversation).find((item) => item.id === other.id)!.permissions).requestParticipants, "ask",
      "no Accord leave either");
    assert.match((service as any).handleWritingLines(conversation).join("\n"), /starts nobody/);
  }

  const classic = mainSessionChat([main, worker, other], { chatView: "classic" });
  const { service } = testService({ conversation: classic });
  (service as any).startDeferredParticipantRequestRunners = () => undefined;
  const fromMain = reply("main-reply", main, "@worker please check the logs.");
  classic.messages.push(fromMain);
  await (service as any).createImplicitParticipantRequestApproval(classic, main, [fromMain]);
  assert.equal(requests(classic).length, 1, "the classic view still reads it as a request");
  assert.equal(requests(classic)[0]!.metadata?.participantRequest?.source, "inferred");
  assert.match((service as any).handleWritingLines(classic).join("\n"), /is a request for that participant to run/);
});

test("the main session's inferred '@x /accord' gives its facilitator no more leave than its own (the classic view)", async () => {
  const main = mainSession("codex-cli", { model: undefined, permissions: permissions({ requestParticipants: "ask" }) });
  const other = member("other-id", "other", { permissions: permissions({ requestParticipants: "deny" }) });
  const conversation = mainSessionChat([main, other], { chatView: "classic" });
  const { service } = testService({ conversation });
  (service as any).startDeferredParticipantRequestRunners = () => undefined;
  const fromMain: ChatMessage = {
    id: "main-reply", role: "participant", participantId: main.id, participantLabel: "@main",
    content: "@other /accord on the rollout plan.", createdAt: NOW, status: "done", metadata: { threadId: "user-message", runId: "main-run" }
  };
  conversation.messages.push(fromMain);
  await (service as any).createImplicitParticipantRequestApproval(conversation, main, [fromMain]);
  assert.equal(normalizeChatAgentPermissions(participantsOf(conversation).find((item) => item.id === other.id)!.permissions).requestParticipants, "ask");
});

// --- review of 2026-11-20: rights one level down, the chain limit, scheduled tasks

/** A member the main session made that may add members (its task said so). */
function delegatedManager(patch: Partial<ChatParticipant> = {}): ChatParticipant {
  return member("child-id", "child", {
    kind: "claude-code",
    delegatedByParticipantId: "main-id",
    permissions: permissions({ requestParticipants: "allow", manageRolesParticipants: "allow" }),
    ...patch
  });
}

function childActor(capabilities: string[] = ["participants.manage", "participants.request"], patch: Record<string, unknown> = {}): any {
  return { ...mainActor(capabilities, patch), participantId: "child-id", roleConfigId: GENERIC_ROLE.id, participantRequestDepth: 1, ...patch };
}

test("in a main-session chat a member's additions are held to its own rights and the main session's, or go to a card", async () => {
  const main = mainSession();
  const child = delegatedManager();
  const { service, storage } = testService({ conversation: mainSessionChat([main, child]) });
  const add = (handle: string, patch: Partial<ChatAgentPermissions>, agentMode: ChatParticipant["agentMode"] = "default") =>
    service.requestParticipantChangeFromTool(childActor(), {
      operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle, roleConfigId: GENERIC_ROLE.id, kind: "claude-code", agentMode, permissions: permissions(patch) } }]
    });
  // As broad as the main session (edits) but broader than the child: a card.
  assert.equal((await add("writer", { workspaceWrite: true })).status, "pending_user_approval");
  // Broader than both (web): a card.
  assert.equal((await add("web", { webAccess: true })).status, "pending_user_approval");
  assert.equal((await add("auto", {}, "auto")).status, "pending_user_approval");
  // Within both: no card, and it says who added it.
  const within = await add("reader", {});
  assert.equal(within.status, "auto_applied", JSON.stringify(within));
  const reader = participantsOf(storage.current).find((participant) => participant.handle === "reader")!;
  assert.equal(reader.delegatedByParticipantId, child.id);
  // The main session's own additions without a card say so too; ones the User adds say nothing.
  const fromMain = await service.requestParticipantChangeFromTool(mainActor(["participants.manage"]), {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "helper", roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", permissions: permissions() } }]
  });
  assert.equal(fromMain.status, "auto_applied");
  assert.equal(participantsOf(storage.current).find((participant) => participant.handle === "helper")!.delegatedByParticipantId, main.id);
});

test("the main session's task gives its member who added it, and that member runs no broader than the main session as it is now", async () => {
  const main = mainSession("claude-code", { agentMode: "auto", permissions: permissions({ workspaceWrite: true, webAccess: true, requestParticipants: "allow" }) });
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "s")] });
  const { service, storage, runs } = testService({ conversation });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Check the docs online.", agentMode: "auto", permissions: { webAccess: true, workspaceWrite: true } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.equal(child.delegatedByParticipantId, main.id);
  assert.equal(child.agentMode, "auto");
  await waitFor(() => runs.some((run) => run.participant.id === child.id));
  assert.equal(runs.find((run) => run.participant.id === child.id)!.options.agentMode, "auto", "as broad as the main session while it is");

  // The User lowers the main session to Plan with no web: its member's next
  // turn runs in Plan with no web, though its own settings are unchanged.
  const lowered = participantsOf(storage.current).map((participant) => participant.id === main.id
    ? { ...participant, agentMode: "plan" as const, permissions: permissions({ workspaceWrite: true, webAccess: false, requestParticipants: "allow" }) }
    : participant);
  storage.current = { ...storage.current, metadata: { ...storage.current.metadata, participants: lowered } };
  const asked = await service.requestParticipantsFromTool(mainActor(undefined, { triggerMessageId: "second-trigger" }), { requests: [{ target: child.handle, prompt: "Again." }] });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  await waitFor(() => runs.filter((run) => run.participant.id === child.id).length === 2);
  const second = runs.filter((run) => run.participant.id === child.id)[1];
  assert.equal(second.options.agentMode, "plan");
  assert.equal(normalizeChatAgentPermissions(second.options.permissions).webAccess, false);
  assert.equal(normalizeChatAgentPermissions(second.options.permissions).workspaceWrite, false, "plan mode has no edits");
  const stored = participantsOf(storage.current).find((participant) => participant.id === child.id)!;
  assert.equal(stored.agentMode, "auto", "its own settings are kept: raising the main session again gives them back");

  // It asks others no more freely than the main session can now, and a
  // member the User added herself is not held to the main session's.
  const own = member("own-id", "own", { kind: "claude-code", agentMode: "auto", permissions: permissions({ webAccess: true, requestParticipants: "allow" }) });
  const internals = service as any;
  const asking = participantsOf(storage.current).map((participant) => participant.id === main.id
    ? { ...participant, permissions: permissions({ requestParticipants: "ask" }) }
    : participant);
  const chatNow = { ...storage.current, metadata: { ...storage.current.metadata, participants: [...asking, own] } };
  assert.equal(normalizeChatAgentPermissions(internals.participantForRun(chatNow, stored).permissions).requestParticipants, "ask");
  assert.equal(internals.participantForRun(chatNow, stored).agentMode, "plan");
  assert.equal(internals.participantForRun(chatNow, own), own);
});

test("an Antigravity member in agy's own Accept edits or Auto, under a main session set from the classic controls, never runs with every confirmation skipped", () => {
  // The main session from the classic controls: edits on, no CLI mode.
  const main = mainSession("claude-code", { permissions: permissions({ workspaceWrite: true, requestParticipants: "allow" }) });
  const { service } = testService({ conversation: mainSessionChat([main]) });
  for (const id of ["accept-edits", "auto"]) {
    const own = applyChatAccessOptionById("gemini-cli", id, permissions({ workspaceWrite: true }));
    const agy = member(`agy-${id}`, `agy${id.length}`, { kind: "gemini-cli", delegatedByParticipantId: main.id, agentMode: own.agentMode, permissions: own.permissions });
    const chat = mainSessionChat([main, agy]);
    const run = (service as any).participantForRun(chat, agy) as ChatParticipant;
    const invocation = buildGeminiExecInvocation({
      participant: { ...agy, label: agy.handle } as never, prompt: "Go.", repoPath: "/work/app", kind: "chat",
      options: { agentMode: run.agentMode, permissions: run.permissions }
    } as never);
    assert.ok(!invocation.args.includes("--dangerously-skip-permissions"), `${id}: ${invocation.args.join(" ")}`);
    assert.ok(invocation.args.includes("--sandbox"), `${id}: the most restrictive run`);
    // Its own settings are kept for when the main session has the mode again.
    assert.equal(normalizeChatAgentPermissions(agy.permissions).cliApprovals, true);
  }
});

test("a member the main session made manages members no more freely than the main session can now", async () => {
  const main = mainSession("claude-code", { permissions: permissions({ workspaceWrite: true, requestParticipants: "allow", manageRolesParticipants: "ask" }) });
  const child = delegatedManager();
  const { service } = testService({ conversation: mainSessionChat([main, child]) });
  const result = await service.requestParticipantChangeFromTool(childActor(), {
    operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "reader", roleConfigId: GENERIC_ROLE.id, kind: "claude-code", permissions: permissions() } }]
  });
  assert.equal(result.status, "pending_user_approval");
});

test("the main session's tasks and members' questions to it are not held to the chain limit; other requests still are", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const child = delegatedManager({ kind: "codex-cli" });
  const other = member("other-id", "other");
  const conversation = mainSessionChat([main, child, other], { participantSessions: [sessionRecord(main, "s")] });
  // The chain already holds as many requests as the limit allows.
  for (let index = 0; index < CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES; index += 1) {
    conversation.messages.push({
      id: `request-${index}`, role: "participant", participantId: other.id, participantLabel: "@other", content: "Request", createdAt: NOW, status: "done",
      metadata: { participantRequest: {
        id: `batch-${index}`, requesterParticipantId: other.id, requesterHandle: other.handle, source: "mcp", resumeRequester: false, status: "completed",
        depth: 1, requesterDepth: 0, chainRootId: "user-message", createdAt: "2026-11-20T11:00:00.000Z", updatedAt: NOW, items: []
      } }
    } as ChatMessage);
  }
  const { service } = testService({ conversation });
  (service as any).startDeferredParticipantRequestRunners = () => undefined;
  const delegated = await service.delegateTaskFromTool(mainActor(), { task: "Write the tests." });
  assert.equal(delegated.ok, true, JSON.stringify(delegated));
  const question = await service.requestParticipantsFromTool(childActor(undefined, { triggerMessageId: "child-turn", chainRootId: "user-message" }), {
    requests: [{ target: "main", prompt: "Which database did User pick?" }]
  });
  assert.equal(question.ok, true, JSON.stringify(question));
  const toOther = await service.requestParticipantsFromTool(childActor(undefined, { triggerMessageId: "child-turn-2", chainRootId: "user-message" }), {
    requests: [{ target: "other", prompt: "Review this." }]
  });
  assert.equal(toOther.ok, false);
  assert.match(JSON.stringify(toOther), /member request chain limit/);
});

test("a member the main session made proposes a scheduled task on the normal card, as any member does", async () => {
  const main = mainSession();
  const conversation = mainSessionChat([main], { participantSessions: [sessionRecord(main, "s")] });
  const { service, storage } = testService({ conversation });
  (service as any).startDeferredParticipantRequestRunners = () => undefined;
  const delegated = await service.delegateTaskFromTool(mainActor(), { task: "Watch the build every minute." });
  assert.equal(delegated.ok, true, JSON.stringify(delegated));
  const childId = String(delegated.participantId);
  const request = {
    kind: "script-change", op: "create", scriptId: "script-0000-build", revisionId: "rev-00000001", contentHash: "h",
    name: "Build watcher", description: "d", hostId: "desktop", hostLabel: "This Mac", runtime: "node", entry: "w.mjs",
    schedule: { kind: "interval", everySeconds: 60 }, scheduleText: "Every minute", timeoutSeconds: 300,
    secretNames: [], permissions: { chatIds: [conversation.id], participantIds: [childId], maxWakeupsPerHour: 6 },
    chatLabels: {}, participantLabels: {}, fileCount: 1, totalBytes: 10
  };
  const calls: string[] = [];
  service.setScriptHost({
    proposeChange: async () => ({ kind: "approval", request: request as any, summary: "Add the scheduled task \"Build watcher\"", missingSecretNames: [] }),
    attachApproval: async () => { calls.push("attach"); },
    assertApprovable: async () => undefined,
    applyApproved: async () => { calls.push("apply"); return "Added the scheduled task \"Build watcher\"."; },
    rejectPending: async () => { calls.push("reject"); },
    listForAgent: async () => [],
    runs: async () => []
  } as any);
  const result = await service.scriptToolFromApp(childActor([], { participantId: childId }), "app_scripts_request_change", { op: "create" });
  assert.equal(result.status, "pending_user_approval", JSON.stringify(result));
  const pending = (storage.current.metadata.pendingAppToolApprovals as Array<{ id: string; status: string; requesterParticipantId: string }>).find((item) => item.id === result.approvalId)!;
  assert.equal(pending.status, "pending", "User approves it on its card");
  assert.equal(pending.requesterParticipantId, childId);
  assert.deepEqual(calls, ["attach"]);
});

test("members made before their task's title was kept with them get it once from the whole history: their delegation's, else their first task's line, never a handle", async () => {
  const main = mainSession();
  const drew = member("drew-id", "drew", { delegatedByParticipantId: main.id });
  const gera = member("gera-id", "gera");
  const sam = member("sam-id", "sam");
  const kept = member("kept-id", "kept", { taskTitle: "Already named" });
  const at = (minute: number): string => `2026-11-22T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const request = (id: string, minute: number, items: Array<Partial<ChatParticipantRequestItem> & { targetParticipantId: string; prompt: string }>, delegation = false): ChatMessage => ({
    id, role: "participant", participantId: main.id, content: `request ${id}`, createdAt: at(minute), status: "done",
    metadata: { participantRequest: {
      id: `batch-${id}`, requesterParticipantId: main.id, requesterHandle: "main", source: "mcp", resumeRequester: true, status: "completed", depth: 1,
      createdAt: at(minute), updatedAt: at(minute), ...(delegation ? { delegation: { start: "clean" as const } } : {}),
      items: items.map((item) => ({ targetHandle: "x", status: "answered" as const, createdAt: at(minute), updatedAt: at(minute), ...item }))
    } }
  } as ChatMessage);
  const conversation = mainSessionChat([main, drew, gera, sam, kept]);
  conversation.messages = [
    request("d-drew", 1, [{ targetParticipantId: drew.id, prompt: "Implement new chats in General.", title: "Новые чаты в General" }], true),
    request("g-1", 2, [{ targetParticipantId: gera.id, prompt: "Check the release feed. Then report the counts." }]),
    request("f-drew", 3, [{ targetParticipantId: drew.id, prompt: 'Two additions to your task "Новые чаты в General": the phone too.' }]),
    request("g-2", 4, [{ targetParticipantId: gera.id, prompt: "Create your own independent proposal for the title." }]),
    request("k-1", 5, [{ targetParticipantId: kept.id, prompt: "Something else entirely." }])
  ];
  const { service, storage } = testService({ conversation });

  await service.backfillSessionsTaskTitles(storage.current);
  const titles = Object.fromEntries(participantsOf(storage.current).map((participant) => [participant.handle, participant.taskTitle]));
  assert.deepEqual(titles, { main: undefined, drew: "Новые чаты в General", gera: "Check the release feed", sam: undefined, kept: "Already named" },
    "drew by its delegation, gera by its first task's line, sam (no task) keeps none and is shown as Agent, kept untouched");
  assert.equal(storage.current.metadata.sessionsTaskTitlesBackfilled, true, "done once");

  // Once done, it does nothing again, even for a member that lost its title.
  storage.current.metadata.participants = participantsOf(storage.current).map((participant) =>
    participant.id === gera.id ? { ...participant, taskTitle: undefined } : participant);
  await service.backfillSessionsTaskTitles(storage.current);
  assert.equal(participantsOf(storage.current).find((participant) => participant.id === gera.id)?.taskTitle, undefined);
});

