import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatService } from "./chat";
import { StorageService } from "./storage";
import { normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT, CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT } from "../../shared/chatParticipantRequests";
import { CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT } from "../../shared/chatAutoWatch";
import { EMPTY_MOBILE_CONTROL_SETTINGS } from "../../shared/mobilePairing";
import {
  forkedChatTitle, forkedMainSessionFor, forkedMainSessionPermissions, forkLocalProviderUnavailable, forkToNewChatLocalProviders, forkToNewChatUnavailableReason,
  localProviderUnavailableReason, memberAsItRunsNow, memberHasForkableSession
} from "../../shared/forkToNewChat";
import type {
  AgentHealth,
  AppSettings,
  ChatAgentPermissions,
  ChatMessage,
  ChatParticipant,
  ChatParticipantSession,
  ChatRoleConfig,
  Conversation,
  ParticipantConfig
} from "../../shared/types";

// Fork to new chat (src/shared/forkToNewChat.ts): any member of any chat
// becomes the main session of a new chat, starting from a copy of its CLI
// session at the new chat's first message.

const NOW = "2026-11-21T12:00:00.000Z";

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
const REVIEWER_ROLE: ChatRoleConfig = {
  id: "code-reviewer",
  label: "Code Reviewer",
  instructions: "Review code.",
  version: 1,
  builtIn: true,
  updatedAt: NOW
};
const ADMIN_ROLE: ChatRoleConfig = {
  id: "chat-administrator",
  label: "Chat Assistant",
  instructions: "Coordinate the chat.",
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

const REVIEWER: ChatParticipant = {
  id: "reviewer-id",
  handle: "reviewer",
  roleConfigId: REVIEWER_ROLE.id,
  kind: "claude-code",
  model: "sonnet",
  reasoningEffort: "high",
  agentMode: "default",
  permissions: permissions({
    workspaceWrite: true,
    webAccess: true,
    requestParticipants: "deny",
    cliApprovals: true,
    shell: { enabled: true, rules: [{ action: "deny", match: "prefix", pattern: "git push" }] }
  })
};
const ASSISTANT: ChatParticipant = { id: "admin-id", handle: "admin", roleConfigId: ADMIN_ROLE.id, kind: "codex-cli", agentMode: "default", permissions: permissions({ repoRead: false }) };

function sessionRecord(participant: ChatParticipant, sessionId: string, role: ChatRoleConfig = REVIEWER_ROLE): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId,
    roleConfigId: role.id,
    roleConfigVersion: role.version,
    participantKind: participant.kind,
    roleLabel: role.label,
    roleInstructions: role.instructions,
    updatedAt: NOW
  };
}

/** A chat from before the main session (with its Chat Assistant). */
function oldChat(participants: ChatParticipant[], metadata: Record<string, unknown> = {}): Conversation {
  return {
    id: "old-chat",
    title: "Old chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/projects/app",
    messages: [
      { id: "old-user", role: "user", content: "Review the change.", createdAt: NOW, status: "done" },
      { id: "old-reply", role: "participant", participantId: REVIEWER.id, participantLabel: "@reviewer", content: "Reviewed.", createdAt: NOW, status: "done" }
    ],
    findings: [],
    metadata: { participants, participantSessions: [sessionRecord(REVIEWER, "src-cli-session")], ...metadata }
  } as Conversation;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type RunCall = { participant: ParticipantConfig; prompt: string; options: any };

function testService(options: {
  conversations: Conversation[];
  agents?: AgentHealth[];
  machines?: Array<{ id: string; name: string; deviceId?: string }>;
  run?: (participant: ParticipantConfig, prompt: string, options: any) => Promise<any>;
}) {
  const tempRoot = path.join(tmpdir(), "accordagents-fork-to-new-chat-test");
  const store = new Map(options.conversations.map((conversation) => [conversation.id, clone(conversation)]));
  const storage = {
    store,
    async listConversations() {
      return [...store.values()].map((item) => ({ id: item.id, title: item.title, kind: item.kind, createdAt: item.createdAt, updatedAt: item.updatedAt }));
    },
    async getConversation(id: string): Promise<Conversation | undefined> {
      const found = store.get(id);
      return found ? clone(found) : undefined;
    },
    async conversationParticipantSessions(id: string): Promise<unknown[] | undefined> {
      const found = store.get(id);
      return found ? clone((found.metadata.participantSessions ?? []) as unknown[]) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      store.set(conversation.id, clone(conversation));
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
    chatRoleConfigs: clone([MAIN_ROLE, REVIEWER_ROLE, ADMIN_ROLE]),
    chatBehaviorRules: [],
    chatSavedPrompts: [],
    chatParticipantConfigs: [],
    chatParticipantSeedState: {},
    cliProviderHosts: [],
    defaultChatView: "sessions"
  } as unknown as AppSettings);
  const settings = {
    async getPublicSettings() { return publicSettings(); },
    async ensureAssistantProviderDefault() { return publicSettings(); },
    async listMachines() { return options.machines ?? []; },
    async listMachineInstalls() { return []; },
    async ensureGenericChatParticipantSeeds() { return publicSettings(); },
    async recordSuccessfulChatProvider() {},
    async getChatParticipantRequestMaxDepth() { return CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT; },
    async getChatParticipantRequestPromptMaxChars() { return CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT; },
    async saveChatParticipantConfig() { return publicSettings(); }
  };
  const runs: RunCall[] = [];
  const cliRunner = {
    async detectAgents() { return options.agents ?? []; },
    async run(participant: ParticipantConfig, prompt: string, _repoPath: unknown, _diffMode: unknown, _kind: unknown, _signal: AbortSignal | undefined, runOptions: any) {
      runs.push({ participant, prompt, options: runOptions });
      return options.run
        ? options.run(participant, prompt, runOptions)
        : { participant, ok: true, content: `Done by ${participant.id}.`, durationMs: 1 };
    }
  };
  const debugLogs = { async write() {} };
  const service = new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never);
  (service as any).ensureHistoryFiles = async () => tempRoot;
  return { service, storage, runs };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for condition: ${predicate.toString().slice(0, 200)}`);
}

function sessionsOf(conversation: Conversation | undefined): ChatParticipantSession[] {
  return (conversation?.metadata.participantSessions ?? []) as ChatParticipantSession[];
}

function participantsOf(conversation: Conversation | undefined): ChatParticipant[] {
  return (conversation?.metadata.participants ?? []) as ChatParticipant[];
}

/** Makes the fork and sends its first message; resolves once that turn ended. */
async function forkAndSend(service: ChatService, storage: ReturnType<typeof testService>["storage"], content = "Carry on from here.") {
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: "old-chat", participantId: REVIEWER.id } });
  const id = created.conversation.id;
  const mainId = String(created.conversation.metadata.mainSessionParticipantId);
  await service.sendMessage({ conversationId: id, runId: `run-${content}`, content, targetParticipantIds: [mainId] });
  await waitFor(() => (storage.store.get(id)?.messages ?? []).some((message: ChatMessage) => message.participantId === mainId && message.status !== "pending"));
  return { id, mainId };
}

test("a member of a chat from before becomes the main session of a new sessions-view chat in its project, with its provider, model, effort, access and place", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const { service, storage, runs } = testService({ conversations: [source] });
  const created = await service.createConversation({ participants: [], title: "ignored", repoPath: "/elsewhere", forkOf: { conversationId: source.id, participantId: REVIEWER.id } });
  const chat = created.conversation;
  assert.equal(chat.title, "Old chat (fork)");
  assert.equal(chat.repoPath, "/projects/app", "the member's project: its CLI session belongs to that folder");
  assert.equal(chat.metadata.chatView, "sessions", "the view Settings names for a new chat");
  const [main, ...others] = participantsOf(chat);
  assert.equal(others.length, 0, "the main session alone");
  assert.equal(chat.metadata.mainSessionParticipantId, main!.id);
  assert.equal(main!.roleConfigId, MAIN_ROLE.id);
  assert.equal(main!.handle, "main");
  assert.equal(main!.kind, "claude-code");
  assert.equal(main!.model, "sonnet");
  assert.equal(main!.reasoningEffort, "high");
  assert.equal(main!.agentMode, "default");
  assert.equal(main!.homeMachineId, undefined, "it runs where the member runs: this computer");
  const granted = normalizeChatAgentPermissions(main!.permissions);
  assert.equal(granted.repoRead, true);
  assert.equal(granted.workspaceWrite, true);
  assert.equal(granted.webAccess, true);
  assert.equal(granted.cliApprovals, true, "the CLI's own mode, as the member had it");
  assert.deepEqual(granted.shell, { enabled: true, rules: [{ action: "deny", match: "prefix", pattern: "git push" }] });
  assert.equal(granted.requestParticipants, "allow", "it asks members as the main session's role gives, not as the member could");
  assert.deepEqual(main!.forkOrigin, { conversationId: source.id, participantId: REVIEWER.id, handle: "reviewer", conversationTitle: "Old chat", kind: "claude-code" });
  assert.deepEqual(sessionsOf(chat), [], "nothing runs until the first message");
  assert.deepEqual(chat.messages.map((message) => message.role), ["system"], "it opens empty");
  assert.equal(runs.length, 0);
  assert.deepEqual(storage.store.get(source.id), source, "the member and its chat are untouched");
});

test("the new chat's first message forks the member's CLI session; the copy is told it is the main session of the new chat, and reminded later", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      runOptions.onSessionId?.("fork-own-session");
      return { participant, ok: true, content: "On it.", durationMs: 1, sessionId: "fork-own-session" };
    }
  });
  const { id, mainId } = await forkAndSend(service, storage);
  assert.equal(runs.length, 1);
  const first = runs[0]!;
  assert.equal(first.participant.id, mainId);
  assert.equal(first.options.forkFromSessionId, "src-cli-session");
  assert.equal(first.options.sessionId || undefined, undefined);
  assert.match(first.prompt, /^You were forked from @reviewer's session in the chat "Old chat": you keep everything it knew, but from now on you are the main session of a new chat, "Old chat \(fork\)"\./);
  assert.match(first.prompt, /You are @main, role: Main session\. The instructions this session started with for @reviewer no longer apply to you/);
  assert.match(first.prompt, /Your role instructions:\nYou are the main session\./, "the main session's role, not the member's");
  assert.doesNotMatch(first.prompt, /You are not the main session/);
  assert.doesNotMatch(first.prompt, /Do only the task/, "not a delegated member");
  assert.match(first.prompt, /Carry on from here\./);

  await waitFor(() => sessionsOf(storage.store.get(id)).some((session) => session.participantId === mainId && session.sessionId === "fork-own-session"));
  const session = sessionsOf(storage.store.get(id)).find((item) => item.participantId === mainId)!;
  assert.equal(session.forkFrom, undefined, "the fork is made once");
  assert.equal(session.forkedFromParticipantId, REVIEWER.id);

  await service.sendMessage({ conversationId: id, runId: "run-second", content: "And now the tests.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 2);
  const second = runs[1]!;
  assert.equal(second.options.forkFromSessionId, undefined);
  assert.equal(second.options.sessionId, "fork-own-session", "its own session from then on");
  assert.match(second.prompt, /Reminder: you are @main \(role: Main session\), the main session of this chat, forked from @reviewer's session in the chat "Old chat"/);
  assert.deepEqual(sessionsOf(storage.store.get(source.id)), [sessionRecord(REVIEWER, "src-cli-session")], "the member's own session is untouched");
});

test("a main session that already answered never becomes a copy again, even after it lost its session", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      runOptions.onSessionId?.(`own-${runs.length}`);
      return { participant, ok: true, content: "Ok.", durationMs: 1, sessionId: `own-${runs.length}` };
    }
  });
  const { id, mainId } = await forkAndSend(service, storage);
  await waitFor(() => sessionsOf(storage.store.get(id)).some((session) => session.participantId === mainId && Boolean(session.sessionId)));
  // Its session is dropped (as a move to a provider or machine does).
  const chat = storage.store.get(id)!;
  chat.metadata.participantSessions = [];
  storage.store.set(id, chat);
  await service.sendMessage({ conversationId: id, runId: "run-after-drop", content: "Next.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 2);
  assert.equal(runs[1]!.options.forkFromSessionId, undefined);
  assert.doesNotMatch(runs[1]!.prompt, /You were forked from/);
});

test("when the member's session is not on this computer any more, the main session starts clean and the chat says so", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const { service, storage, runs } = testService({ conversations: [source] });
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: REVIEWER.id } });
  storage.store.delete(source.id);
  const mainId = String(created.conversation.metadata.mainSessionParticipantId);
  await service.sendMessage({ conversationId: created.conversation.id, runId: "run-gone", content: "Hello.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0]!.options.forkFromSessionId, undefined);
  await waitFor(() => ((storage.store.get(created.conversation.id)?.metadata.warnings ?? []) as string[]).length > 0);
  assert.deepEqual(storage.store.get(created.conversation.id)!.metadata.warnings,
    ["@main could not start from a copy of @reviewer's session in the chat \"Old chat\": that session is not on this computer, so it started a clean session."]);
});

test("a fork the CLI cannot make (its source session gone) uses the two-strike fallback: tried once more, then a clean session, and the chat says so", async () => {
  const codexReviewer: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined };
  const source = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => runOptions.forkFromSessionId
      ? { participant, ok: false, content: "", error: "no rollout found for thread id src-cli-session", durationMs: 1 }
      : { participant, ok: true, content: "Clean.", durationMs: 1, sessionId: "clean-session" }
  });
  const { id, mainId } = await forkAndSend(service, storage);
  const sessionOf = () => sessionsOf(storage.store.get(id)).find((item) => item.participantId === mainId);
  await waitFor(() => sessionOf()?.forkFrom?.failedAttempts === 1);
  assert.deepEqual(sessionOf()!.forkFrom, { participantId: codexReviewer.id, sessionId: "src-cli-session", kind: "codex-cli", conversationId: source.id, failedAttempts: 1 });
  await service.sendMessage({ conversationId: id, runId: "run-retry", content: "Try again.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 2 && sessionOf()?.forkFrom === undefined);
  assert.equal(runs[1]!.options.forkFromSessionId, "src-cli-session", "the retry forks again");
  // The failed turn's own error is a warning too, as for any turn User asked.
  const warning = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so its next turn starts a clean session.";
  await waitFor(() => ((storage.store.get(id)?.metadata.warnings ?? []) as string[]).includes(warning));
  await service.sendMessage({ conversationId: id, runId: "run-clean", content: "Clean now.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 3);
  assert.equal(runs[2]!.options.forkFromSessionId, undefined);
});

test("Claude Code starting the copy clean (its source gone) still tells it it is the new chat's main session, with its role", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      runOptions.onSessionId?.("fallback-session");
      return { participant, ok: true, content: "Done.", durationMs: 1, sessionId: "fallback-session", sessionRestarted: true };
    }
  });
  const { id } = await forkAndSend(service, storage);
  const fallback = String(runs[0]!.options.resumeFallbackPrompt);
  assert.match(fallback, /^You were to start from a copy of @reviewer's session in the chat "Old chat", but it could not be copied/);
  assert.match(fallback, /You are @main, role: Main session: the main session of this chat\./);
  assert.match(fallback, /You are the main session\./, "its role's instructions");
  await waitFor(() => ((storage.store.get(id)?.metadata.warnings ?? []) as string[]).length > 0);
  assert.deepEqual(storage.store.get(id)!.metadata.warnings,
    ["@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so it started a clean session from the saved chat context."]);
});

test("a fork to a new chat is refused, with its reason, for Antigravity, a member that never ran, one waiting for a machine, an outdated or unseen machine, and a CLI not ready here", async () => {
  const cases: Array<[string, ChatParticipant, Record<string, unknown>, RegExp, { agents?: AgentHealth[]; support?: "supported" | "outdated" | "unknown" }?]> = [
    ["Antigravity", { ...REVIEWER, kind: "gemini-cli" }, {}, /Antigravity has no session fork/],
    ["never ran", REVIEWER, { participantSessions: [] }, /has not run yet/],
    ["fork not made yet", REVIEWER, { participantSessions: [{ ...sessionRecord(REVIEWER, ""), forkFrom: { participantId: "x", sessionId: "s", kind: "claude-code" } }] }, /has not run yet/],
    ["waiting for a machine", { ...REVIEWER, cloudRun: { instanceId: "i-1" } as never }, {}, /no machine to run on yet/],
    ["outdated machine", { ...REVIEWER, homeMachineId: "m-1" }, { lastMessageByParticipant: { [REVIEWER.id]: { messageId: "old-reply", sequence: 1 } } }, /older program/, { support: "outdated" }],
    ["unseen machine", { ...REVIEWER, homeMachineId: "m-1" }, { lastMessageByParticipant: { [REVIEWER.id]: { messageId: "old-reply", sequence: 1 } } }, /has not connected/, { support: "unknown" }],
    ["CLI not ready", REVIEWER, {}, /Claude Code/, { agents: [{ kind: "claude-code", label: "Claude Code", installed: false }, { kind: "codex-cli", label: "Codex CLI", installed: true }] }]
  ];
  for (const [label, member, metadata, reason, extra] of cases) {
    const source = oldChat([ASSISTANT, member], metadata);
    const { service, storage } = testService({ conversations: [source], agents: extra?.agents });
    if (extra?.support) service.setMachineForkToNewChatSupport(() => extra.support!);
    await assert.rejects(
      service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: member.id } }),
      (error: Error) => {
        assert.match(error.message, /^@reviewer cannot be forked to a new chat: /, label);
        assert.match(error.message, reason, label);
        return true;
      },
      label
    );
    assert.equal(storage.store.size, 1, `${label}: no chat made`);
  }
});

test("a member on a cloud machine is forked to a new chat whose main session runs on that same machine", async () => {
  const boxed: ChatParticipant = { ...REVIEWER, homeMachineId: "m-1" };
  // Its session is on the machine: this computer knows only that it answered.
  const source = oldChat([ASSISTANT, boxed], { participantSessions: [], lastMessageByParticipant: { [boxed.id]: { messageId: "old-reply", sequence: 1 } } });
  const { service } = testService({ conversations: [source] });
  const asked: string[] = [];
  service.setMachineForkToNewChatSupport((machineId) => { asked.push(machineId); return "supported"; });
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: boxed.id } });
  const [main] = participantsOf(created.conversation);
  assert.deepEqual(asked, ["m-1"]);
  assert.equal(main!.homeMachineId, "m-1", "a fork never crosses devices");
  assert.equal(main!.forkOrigin?.participantId, boxed.id);
});

test("the machine that runs the forked main session copies the member's session it holds", async () => {
  // As the machine's own copy of both chats has them (its runtime runs the
  // same service): the member's session record is there.
  const boxed: ChatParticipant = { ...REVIEWER, homeMachineId: "m-1" };
  const source = oldChat([ASSISTANT, boxed]);
  const forked: Conversation = {
    id: "new-chat",
    title: "Old chat (fork)",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/projects/app",
    messages: [{ id: "first", role: "user", content: "Go on.", createdAt: NOW, status: "done" }],
    findings: [],
    metadata: {
      participants: [{ id: "main-id", handle: "main", roleConfigId: MAIN_ROLE.id, kind: "claude-code", homeMachineId: "m-1", agentMode: "default", permissions: permissions(),
        forkOrigin: { conversationId: source.id, participantId: boxed.id, handle: "reviewer", conversationTitle: "Old chat", kind: "claude-code" } }],
      participantSessions: [],
      mainSessionParticipantId: "main-id"
    }
  } as Conversation;
  const { service } = testService({ conversations: [source, forked] });
  (service as any).machineRuntime = true;
  (service as any).hostMachineId = "m-1";
  const state = await (service as any).sessionForParticipant(forked, participantsOf(forked)[0]);
  assert.deepEqual(state.session.forkFrom, { participantId: boxed.id, sessionId: "src-cli-session", kind: "claude-code", conversationId: source.id });
  assert.equal(state.forkOriginUnavailable, undefined);
});

test("the menus and the service give the same reasons", () => {
  assert.equal(forkedChatTitle("Plan the release"), "Plan the release (fork)");
  assert.equal(forkedChatTitle("x".repeat(100)).length, 80, "within a title's length");
  assert.equal(forkToNewChatUnavailableReason({ participant: { kind: "codex-cli" }, hasSession: true }), undefined);
  assert.equal(forkToNewChatUnavailableReason({ participant: { kind: "codex-cli" }, hasSession: true, providerUnavailable: "Codex CLI requires sign-in." }), "Codex CLI requires sign-in.");
  assert.equal(forkToNewChatUnavailableReason({ participant: { kind: "claude-code", homeMachineId: "m" }, hasSession: true, machineSupport: "supported", providerUnavailable: "not here" }), undefined,
    "a machine's member runs on that machine's CLI");
  const metadata = { participantSessions: [sessionRecord(REVIEWER, "s-1")], lastMessageByParticipant: {} };
  assert.equal(memberHasForkableSession(metadata, REVIEWER), true);
  assert.equal(memberHasForkableSession(metadata, ASSISTANT), false);
  assert.equal(memberHasForkableSession(metadata, { ...ASSISTANT, homeMachineId: "m" }, [{ role: "participant", participantId: ASSISTANT.id }]), true);
});

test("the member's session record is read without the messages of its chat", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-fork-sessions-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  try {
    await storage.saveConversation(oldChat([ASSISTANT, REVIEWER]));
    assert.deepEqual(await storage.conversationParticipantSessions("old-chat"), [sessionRecord(REVIEWER, "src-cli-session")]);
    assert.equal(await storage.conversationParticipantSessions("no-such-chat"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const READY_AGENTS: AgentHealth[] = [
  { kind: "claude-code", label: "Claude Code", installed: true },
  { kind: "codex-cli", label: "Codex CLI", installed: true }
];

test("the phone makes the same main session the computer makes, from what the computer offers it", async () => {
  // A member the main session made, with more than the main session may
  // give: it is copied as it runs (never above the main session).
  const mainSession: ChatParticipant = { id: "main-src", handle: "main", roleConfigId: MAIN_ROLE.id, kind: "codex-cli", agentMode: "default",
    permissions: permissions({ workspaceWrite: false, webAccess: true, requestParticipants: "allow", shell: { enabled: true, rules: [{ action: "deny", match: "prefix", pattern: "rm" }] } }) };
  const delegated: ChatParticipant = { ...REVIEWER, delegatedByParticipantId: mainSession.id, agentMode: "auto" };
  const source = oldChat([mainSession, delegated], {
    mainSessionParticipantId: mainSession.id,
    participantSessions: [sessionRecord(delegated, "src-cli-session")]
  });
  const { service } = testService({ conversations: [source], agents: READY_AGENTS });
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: delegated.id } });
  const [desktopMain] = participantsOf(created.conversation);
  const granted = normalizeChatAgentPermissions(desktopMain!.permissions);
  assert.equal(granted.workspaceWrite, false, "never above the main session it was made by");
  assert.equal(desktopMain!.agentMode, "default", "its mode within the main session's");

  const offer = await service.newChatOptions([]);
  assert.ok(offer?.fork, "the computer tells the phone what it needs to fork");
  const phoneMain = forkedMainSessionFor({
    mainSession: offer!.mainSession!,
    basePermissions: offer!.fork!.basePermissions,
    member: memberAsItRunsNow(delegated, mainSession),
    source: { id: source.id, title: source.title },
    id: desktopMain!.id
  });
  assert.deepEqual(clone(phoneMain), clone(desktopMain), "the same member, rights, place and origin on both");
});

test("the computer's offer says why each of its CLIs cannot run a forked member, and what each machine's program can do", async () => {
  const notSignedIn: AgentHealth[] = [
    { kind: "claude-code", label: "Claude Code", installed: true, detection: "detected", runnable: "ready", authentication: "required" } as AgentHealth,
    { kind: "codex-cli", label: "Codex CLI", installed: true }
  ];
  const { service } = testService({ conversations: [], agents: notSignedIn, machines: [{ id: "m-new", name: "New" }, { id: "m-old", name: "Old" }] });
  service.setMachineForkToNewChatSupport((machineId) => machineId === "m-new" ? "supported" : "outdated");
  const offer = await service.newChatOptions([]);
  assert.deepEqual(offer?.fork?.machines, { "m-new": "supported", "m-old": "outdated" });
  const providers = [{ kind: "claude-code" as const, enabled: true }, { kind: "codex-cli" as const, enabled: true }];
  for (const member of [{ kind: "claude-code" as const }, { kind: "codex-cli" as const }, { kind: "claude-code" as const, hostId: "gone" }]) {
    assert.equal(forkLocalProviderUnavailable(member, offer!.fork!), localProviderUnavailableReason(member, notSignedIn, providers, []),
      `${member.kind}${member.hostId ? ` (${member.hostId})` : ""}: the computer's words`);
  }
  assert.ok(forkLocalProviderUnavailable({ kind: "claude-code" }, offer!.fork!), "a CLI not signed in refuses its member");
  // Nothing detected yet: nobody is refused for a CLI, as on the computer.
  const unjudged = forkToNewChatLocalProviders([], providers, []);
  assert.equal(forkLocalProviderUnavailable({ kind: "claude-code", hostId: "gone" }, unjudged), localProviderUnavailableReason({ kind: "claude-code", hostId: "gone" }, [], providers, []));
  assert.equal(offer!.fork!.basePermissions.requestParticipants, "allow", "the main session's role's say over members");
});

test("a forked main session never gets more than the member had, besides the main session's say over members", () => {
  const base = permissions({ repoRead: true, workspaceWrite: true, webAccess: true, requestParticipants: "allow", cliApprovals: true,
    providerNative: { "claude-code": { allowedTools: ["Bash(*)"] } }, shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "rm" }] } });
  const merged = forkedMainSessionPermissions(base, permissions({ repoRead: false, requestParticipants: "deny" }));
  assert.deepEqual(merged, permissions({ repoRead: false, requestParticipants: "allow" }));
});
