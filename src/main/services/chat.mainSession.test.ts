import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatService } from "./chat";
import { accordLaunchCardForMessage } from "../../shared/accordLaunchCard";
import { normalizeChatAgentPermissions } from "../../shared/agentPermissions";
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

test("a fork the CLI could not make is tried once more, then the member starts clean and the chat says so", async () => {
  for (const [kind, error] of [
    ["claude-code", "No conversation found with session ID: main-cli-session"],
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
        // Claude Code reports some id even when the source is gone.
        runOptions.onSessionId?.("never-made");
        return { participant, ok: false, content: "", error, durationMs: 1, sessionId: "never-made" };
      }
    });
    const result = await service.delegateTaskFromTool(mainActor(), { task: "Continue.", start: "fork" });
    assert.equal(result.ok, true, JSON.stringify(result));
    const childId = String(result.participantId);
    const sessionOf = () => (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === childId)!;
    const childRuns = () => runs.filter((run) => run.participant.id === childId);
    await waitFor(() => delegationBatches(storage.current)[0]?.items[0]?.status === "failed");
    await waitFor(() => sessionOf().forkFrom?.failedAttempts === 1);
    // The first failure: tried again at the next turn, never resumed from an id that is no session.
    assert.equal(sessionOf().sessionId, "", kind);
    assert.deepEqual(sessionOf().forkFrom, { participantId: main.id, sessionId: "main-cli-session", kind, failedAttempts: 1 }, kind);

    const ask = async (prompt: string) => {
      const asked = await service.requestParticipantsFromTool(mainActor(undefined, { triggerMessageId: `trigger-${prompt}` }), { requests: [{ target: String(result.handle), prompt }] });
      assert.equal(asked.ok, true, JSON.stringify(asked));
    };
    await ask("Try again.");
    await waitFor(() => childRuns().length === 2);
    await waitFor(() => sessionOf().forkFrom === undefined);
    assert.equal(childRuns()[1].options.forkFromSessionId, "main-cli-session", `${kind}: the retry forks again`);
    // The retry failed too: it is a member of its own now, and the chat says so.
    assert.equal(sessionOf().forkedFromParticipantId, undefined, kind);
    await waitFor(() => ((storage.current.metadata.warnings ?? []) as string[]).some((warning) => warning.includes("could not start from a copy of @main's session")));
    assert.ok((storage.current.metadata.warnings as string[]).includes(`@${String(result.handle).slice(1)} could not start from a copy of @main's session, so its next turn starts a clean session.`), kind);

    await ask("Once more, clean.");
    await waitFor(() => childRuns().length === 3);
    assert.equal(childRuns()[2].options.forkFromSessionId, undefined, `${kind}: no fork any more`);
    assert.doesNotMatch(childRuns()[2].prompt, /You were forked from/, kind);
    await waitFor(() => sessionOf().sessionId === "clean-session");
  }
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
  assert.match(fallback, /^You were to start from a copy of @main's session, but it could not be copied/);
  assert.match(fallback, /You are @refactor, role: Generic Member\. You are not the main session\./);
  assert.match(fallback, /Do only the task in the triggering message/);
  assert.match(fallback, /Answer directly\./, "its role's instructions");
  assert.match(fallback, /Continue the refactor\./, "and its task");

  await waitFor(() => (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === result.participantId)?.sessionId === "fallback-session");
  const session = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === result.participantId)!;
  assert.equal(session.forkFrom, undefined);
  assert.equal(session.forkedFromParticipantId, undefined, "not reminded later that it is a fork");
  await waitFor(() => ((storage.current.metadata.warnings ?? []) as string[]).length > 0);
  assert.deepEqual(storage.current.metadata.warnings, ["@refactor could not start from a copy of @main's session, so it started a clean session from the saved chat context."]);
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

test("the main session's inferred '@x /accord' gives its facilitator no more leave than its own", async () => {
  const main = mainSession("codex-cli", { model: undefined, permissions: permissions({ requestParticipants: "ask" }) });
  const other = member("other-id", "other", { permissions: permissions({ requestParticipants: "deny" }) });
  const conversation = mainSessionChat([main, other]);
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
