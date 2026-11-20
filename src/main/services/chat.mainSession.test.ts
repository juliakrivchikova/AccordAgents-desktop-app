import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatService } from "./chat";
import { accordLaunchCardForMessage } from "../../shared/accordLaunchCard";
import { normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT, CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT } from "../../shared/chatParticipantRequests";
import { CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT } from "../../shared/chatAutoWatch";
import { EMPTY_MOBILE_CONTROL_SETTINGS } from "../../shared/mobilePairing";
import type {
  AppSettings,
  ChatAgentPermissions,
  ChatMessage,
  ChatParticipant,
  ChatParticipantRequestBatch,
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
  run?: (participant: ParticipantConfig, prompt: string, options: any) => Promise<any>;
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
    chatRoleConfigs: clone([MAIN_ROLE, GENERIC_ROLE, REVIEWER_ROLE]),
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
    async run(participant: ParticipantConfig, prompt: string, _repoPath: unknown, _diffMode: unknown, _kind: unknown, _signal: unknown, runOptions: any) {
      runs.push({ participant, prompt, options: runOptions });
      return options.run
        ? options.run(participant, prompt, runOptions)
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
  throw new Error("Timed out waiting for condition.");
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
  assert.equal(child.agentMode, "default", "never above the main session's mode");
  const granted = normalizeChatAgentPermissions(child.permissions);
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
  assert.deepEqual(batch.delegation, { start: "clean" });
  assert.equal(batch.items[0].targetParticipantId, child.id);
  assert.equal(batch.items[0].prompt, "Review src/app.ts and report the bugs you find.");
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
  assert.match(childRun.prompt, /^You were forked from @main's session/);
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

test("several delegations in one main-session turn each run, and each answer resumes the main session", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const worker = member("worker-id", "worker");
  const conversation = mainSessionChat([main, worker], { participantSessions: [sessionRecord(main, "main-thread")] });
  const { service, storage, runs } = testService({ conversation });

  const first = await service.delegateTaskFromTool(mainActor(), { task: "Write the tests." });
  const second = await service.delegateTaskFromTool(mainActor(), { task: "Update the docs.", roleConfigId: REVIEWER_ROLE.id });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(first.handle, "@codex");
  assert.equal(second.handle, "@code-reviewer");
  // An ordinary request in the same turn is not blocked by the delegations.
  const asked = await service.requestParticipantsFromTool(mainActor(), { requests: [{ target: "worker", prompt: "Check the build." }] });
  assert.equal(asked.ok, true, JSON.stringify(asked));

  await waitFor(() => [first.participantId, second.participantId, worker.id].every((id) => runs.some((run) => run.participant.id === id)));
  await waitFor(() => runs.filter((run) => run.participant.id === main.id && run.prompt.includes("Auto-resumed @main")).length === 3, 4000);
  await waitFor(() => delegationBatches(storage.current).length === 2 && delegationBatches(storage.current).every((batch) => Boolean(batch.autoResumeMessageId)));
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

test("delegation refuses the main session and Chat Assistant roles", async () => {
  const main = mainSession();
  const { service } = testService({ conversation: mainSessionChat([main]) });
  for (const roleConfigId of ["main-session", "administrator"]) {
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

// --- what other members are told -----------------------------------------------

test("members of a main-session chat ask the main session, not User, and do not start Accords", () => {
  const main = mainSession();
  const worker = member("worker-id", "worker");
  const conversation = mainSessionChat([main, worker]);
  const { service } = testService({ conversation });
  const internals = service as any;
  assert.equal(internals.mainSessionHandleForMember(conversation, worker), "main");
  assert.equal(internals.mainSessionHandleForMember(conversation, main), undefined);

  const workerInstructions = internals.nativeRoleInstructions(worker, sessionRecord(worker, "s", GENERIC_ROLE), "main") as string;
  assert.match(workerInstructions, /ask @main with `app_chat_request_participants` instead of asking User/);
  assert.match(workerInstructions, /Do not write a `User choice:` block unless @main asked you to put a question to User\./);
  assert.match(workerInstructions, /Do not start an Accord; when one is needed, ask @main\./);
  assert.match(workerInstructions, /"target": "main"/);
  assert.doesNotMatch(workerInstructions, /Ask User directly/);

  const mainInstructions = internals.nativeRoleInstructions(main, sessionRecord(main, "s"), undefined) as string;
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

test("in a main-session chat another member's '@x /accord' reply starts nothing; the main session's still does", async () => {
  const main = mainSession("codex-cli", { model: undefined });
  const worker = member("worker-id", "worker", { permissions: permissions({ requestParticipants: "allow" }) });
  const other = member("other-id", "other");
  const conversation = mainSessionChat([main, worker, other]);
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
  assert.ok((conversation.metadata.warnings as string[]).some((warning) => warning.includes("only the main session starts one")));

  const fromMain: ChatMessage = {
    id: "main-reply", role: "participant", participantId: main.id, participantLabel: "@main",
    content: "@other /accord on the rollout plan.", createdAt: NOW, status: "done", metadata: { threadId: "user-message", runId: "main-run" }
  };
  conversation.messages.push(fromMain);
  await (service as any).createImplicitParticipantRequestApproval(conversation, main, [fromMain]);
  assert.ok(conversation.messages.some((message) => message.metadata?.participantRequest?.requesterParticipantId === main.id));
  assert.equal(normalizeChatAgentPermissions(participantsOf(conversation).find((item) => item.id === other.id)!.permissions).requestParticipants, "allow");
});
