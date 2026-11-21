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
  forkCutFor, forkedChatTitle, forkedMainSessionFor, forkedMainSessionPermissions, forkLocalProviderUnavailable, forkSeenReplyOf, forkToNewChatLocalProviders,
  forkToNewChatReasonFromOffer, forkToNewChatReasonInChat, forkToNewChatSupportFromHello, forkToNewChatUnavailableReason, isMemberTurnEnd, lastMemberTurnEnd,
  localProviderUnavailableReason, memberAsItRunsNow, memberHasForkableSession, memberReplyFinishedAt
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
/** When the source chat's reply finished, on the clock of the device that ran it. */
const REPLY_FINISHED = "2026-11-21T12:00:30.000Z";

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
      // A reply from before replies recorded where their session stood: it
      // ended a turn (workedMs) half a minute after it was asked.
      { id: "old-reply", role: "participant", participantId: REVIEWER.id, participantLabel: "@reviewer", content: "Reviewed.", createdAt: NOW, status: "done",
        metadata: { workedMs: 30_000 } }
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
  const make = () => {
    const made = new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never);
    (made as any).ensureHistoryFiles = async () => tempRoot;
    return made;
  };
  const service = make();
  /** The app again after a quit (or a machine's runtime after a restart):
   *  a new service over the same storage. */
  const restart = (run?: (participant: ParticipantConfig, prompt: string, options: any) => Promise<any>) => {
    if (run) options.run = run;
    return make();
  };
  return { service, storage, runs, restart };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for condition: ${predicate.toString().slice(0, 200)}`);
}

/** The chat's lines with this text (system messages every device shows). */
function linesOf(conversation: Conversation | undefined, text: string): ChatMessage[] {
  return (conversation?.messages ?? []).filter((message) => message.role === "system" && message.content === text);
}

/** A fork's notice (postForkNotice): a line in the chat, which her server
 *  carries to every device, once per member and kind (its id says which);
 *  and the warning the device that ran it shows, once. `service`: the
 *  services that may still be writing, drained before counting. */
async function assertLineOnce(storage: { store: Map<string, Conversation> }, id: string, text: string, label = text, services: ChatService[] = []): Promise<void> {
  await waitFor(() => linesOf(storage.store.get(id), text).length > 0);
  // Writes still queued land before counting.
  for (const service of services) await service.settleChatSaves();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const service of services) await service.settleChatSaves();
  const lines = linesOf(storage.store.get(id), text);
  assert.equal(lines.length, 1, `${label}: once`);
  assert.equal(lines[0]!.metadata?.threadId, "system", label);
  assert.match(lines[0]!.id, /^fork-notice-(origin-unavailable|cut-missed|started-clean|starts-clean-next)-/, `${label}: one id per member and kind`);
  const warnings = (storage.store.get(id)?.metadata.warnings ?? []) as string[];
  assert.deepEqual(warnings.filter((warning) => warning === text), [text], `${label}: the warning on the device that ran it, once (${JSON.stringify(warnings)})`);
}

/** The chat as a cloud machine's runtime has it, its main session homed on
 *  that machine, and its turn run there as the server asks it
 *  (startServerTurn → runParticipantBatch). */
async function runOnMachine(service: ChatService, storage: { store: Map<string, Conversation> }, id: string, mainId: string, content: string, runId = `run-${content}`) {
  const stored = storage.store.get(id)!;
  const message: ChatMessage = { id: `user-${runId}`, role: "user", content, createdAt: new Date().toISOString(), status: "done" };
  stored.messages.push(message);
  storage.store.set(id, stored);
  const chat = await (service as any).requireChat(id) as Conversation;
  const participant = participantsOf(chat).find((item) => item.id === mainId)!;
  const warnings: string[] = [];
  await (service as any).runParticipantBatch(chat, [participant], message, runId, undefined, undefined, warnings, { targetRunIds: new Map([[participant.id, runId]]) });
  return warnings;
}

/** A chat made by Fork to new chat on the computer, as a machine reads it
 *  from the server: its main session runs on machine m-1. */
function forkedOnMachine(source: Conversation, sourceMember: ChatParticipant): Conversation {
  return {
    id: "new-chat",
    title: "Old chat (fork)",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/projects/app",
    messages: [],
    findings: [],
    metadata: {
      participants: [{ id: "main-id", handle: "main", roleConfigId: MAIN_ROLE.id, kind: sourceMember.kind, homeMachineId: "m-1", agentMode: "default", permissions: permissions(),
        forkOrigin: { conversationId: source.id, participantId: sourceMember.id, handle: sourceMember.handle, conversationTitle: source.title, kind: sourceMember.kind,
          seen: { messageId: "old-reply", finishedAt: REPLY_FINISHED } } }],
      participantSessions: [],
      mainSessionParticipantId: "main-id"
    }
  } as Conversation;
}

/** The fork notices a service says (postForkNotice), as it says them. */
function spyForkNotices(service: ChatService): string[] {
  const said: string[] = [];
  const post = (service as any).postForkNotice.bind(service);
  (service as any).postForkNotice = (conversation: Conversation, participant: ChatParticipant, kind: string, text: string) => {
    said.push(text);
    return post(conversation, participant, kind, text);
  };
  return said;
}

function asMachine(service: ChatService): ChatService {
  (service as any).machineRuntime = true;
  (service as any).hostMachineId = "m-1";
  return service;
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
  assert.deepEqual(main!.forkOrigin, { conversationId: source.id, participantId: REVIEWER.id, handle: "reviewer", conversationTitle: "Old chat", kind: "claude-code",
    seen: { messageId: "old-reply", finishedAt: REPLY_FINISHED } }, "with the reply she saw last: the copy ends with its turn");
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
  assert.deepEqual(first.options.forkCut, { finishedBy: REPLY_FINISHED }, "only up to the reply she saw, by its finish");
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

const NOT_ON_COMPUTER = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\": that session is not on your computer, so it starts a clean session.";

test("when the member's session is not on this computer any more, the main session starts clean and a line in the chat says so before its turn runs", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  let id = "";
  let linesWhileRunning = -1;
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      // Said before the turn ends: it may last hours, and the app may stop during it.
      await waitFor(() => linesOf(storage.store.get(id), NOT_ON_COMPUTER).length === 1);
      linesWhileRunning = 1;
      runOptions.onSessionId?.("clean-session");
      return { participant, ok: true, content: "Hello.", durationMs: 1, sessionId: "clean-session" };
    }
  });
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: REVIEWER.id } });
  id = created.conversation.id;
  storage.store.delete(source.id);
  const mainId = String(created.conversation.metadata.mainSessionParticipantId);
  await service.sendMessage({ conversationId: id, runId: "run-gone", content: "Hello.", targetParticipantIds: [mainId] });
  await waitFor(() => (storage.store.get(id)?.messages ?? []).some((message) => message.participantId === mainId && message.status === "done"));
  assert.equal(runs[0]!.options.forkFromSessionId, undefined);
  assert.equal(linesWhileRunning, 1, "in the chat while the turn ran");
  await assertLineOnce(storage, id, NOT_ON_COMPUTER, NOT_ON_COMPUTER, [service]);
  assert.deepEqual(storage.store.get(id)!.metadata.warnings ?? [], [NOT_ON_COMPUTER], "nothing else");
  // Its later turns say nothing more.
  await service.sendMessage({ conversationId: id, runId: "run-next", content: "Next.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 2);
  await assertLineOnce(storage, id, NOT_ON_COMPUTER, "after a later turn", [service]);
});

test("a first turn cut short by a quit, run again after the restart, says its line once", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  let release!: () => void;
  const { service, storage, runs, restart } = testService({
    conversations: [source],
    // The app quits during the first turn: it never ends, nor gets a session id.
    run: () => new Promise((resolve) => { release = () => resolve({ ok: false, content: "", error: "Chat run cancelled.", durationMs: 1 }); })
  });
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: REVIEWER.id } });
  const id = created.conversation.id;
  storage.store.delete(source.id);
  const mainId = String(created.conversation.metadata.mainSessionParticipantId);
  await service.sendMessage({ conversationId: id, runId: "run-first", content: "Hello.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 1 && linesOf(storage.store.get(id), NOT_ON_COMPUTER).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // After the restart its reply is no reply yet (cut short), and the turn runs again.
  const stored = storage.store.get(id)!;
  stored.messages = stored.messages.filter((message) => message.participantId !== mainId);
  storage.store.set(id, stored);
  const again = restart(async (participant, _prompt, runOptions) => {
    runOptions.onSessionId?.("clean-session");
    return { participant, ok: true, content: "Hello.", durationMs: 1, sessionId: "clean-session" };
  });
  const said = spyForkNotices(again);
  await again.sendMessage({ conversationId: id, runId: "run-again", content: "Hello again.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 2);
  await waitFor(() => (storage.store.get(id)?.messages ?? []).some((message) => message.participantId === mainId && message.status === "done"));
  assert.deepEqual(said, [NOT_ON_COMPUTER], "the turn run again says it again");
  await assertLineOnce(storage, id, NOT_ON_COMPUTER, "after the restart", [again]);
  release();
});

test("on a cloud machine: the member's session not there, the line names the machine and goes in the chat; once when the server hands the turn over again after the machine stopped mid-turn", async () => {
  const source = oldChat([ASSISTANT, { ...REVIEWER, homeMachineId: "m-1" }]);
  const forked = forkedOnMachine(source, REVIEWER);
  let release!: () => void;
  const { service, storage, runs, restart } = testService({
    conversations: [forked],
    // The machine stops during the first turn: it never ends, nor gets a session id.
    run: () => new Promise((resolve) => { release = () => resolve({ ok: false, content: "", error: "Chat run cancelled.", durationMs: 1 }); })
  });
  asMachine(service);
  const text = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\": that session is not on the cloud machine @main runs on, so it starts a clean session.";
  void runOnMachine(service, storage, forked.id, "main-id", "Hello.");
  await waitFor(() => runs.length === 1 && linesOf(storage.store.get(forked.id), text).length === 1);
  assert.equal(runs[0]!.options.forkFromSessionId, undefined);
  await service.settleChatSaves();
  assert.equal(sessionsOf(storage.store.get(forked.id)).length, 0, "no session record was written before it stopped");
  // The server hands the turn over again after the machine restarted (its reply never written).
  const stored = storage.store.get(forked.id)!;
  stored.messages = stored.messages.filter((message) => message.participantId !== "main-id");
  storage.store.set(forked.id, stored);
  const again = asMachine(restart(async (participant, _prompt, runOptions) => {
    runOptions.onSessionId?.("clean-session");
    return { participant, ok: true, content: "Hello.", durationMs: 1, sessionId: "clean-session" };
  }));
  const said = spyForkNotices(again);
  const warnings = await runOnMachine(again, storage, forked.id, "main-id", "Hello.", "run-Hello.-redelivered");
  assert.equal(runs.length, 2);
  assert.deepEqual(said, [text], "the turn handed over again says it again");
  assert.equal(warnings.includes(text), false, "not left for the turn's own warnings");
  await assertLineOnce(storage, forked.id, text, "redelivered", [again]);
  release();
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
  assert.deepEqual(sessionOf()!.forkFrom, { participantId: codexReviewer.id, sessionId: "src-cli-session", kind: "codex-cli", conversationId: source.id,
    cut: { finishedBy: REPLY_FINISHED }, failedAttempts: 1 }, "the retry ends where the first try was to");
  await service.sendMessage({ conversationId: id, runId: "run-retry", content: "Try again.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 2 && sessionOf()?.forkFrom === undefined);
  assert.equal(runs[1]!.options.forkFromSessionId, "src-cli-session", "the retry forks again");
  assert.deepEqual(runs[1]!.options.forkCut, { finishedBy: REPLY_FINISHED });
  const notice = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so its next turn starts a clean session.";
  await assertLineOnce(storage, id, notice);
  // The User asked it, and reads the line: its failed reply does not say it twice.
  const replies = storage.store.get(id)!.messages.filter((message) => message.participantId === mainId);
  assert.equal(replies.some((message) => message.content.includes("could not start from a copy")), false);
  await service.sendMessage({ conversationId: id, runId: "run-clean", content: "Clean now.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 3);
  assert.equal(runs[2]!.options.forkFromSessionId, undefined);
  await assertLineOnce(storage, id, notice, "after its clean turn");
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
  const notice = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so it started a clean session from the saved chat context.";
  await assertLineOnce(storage, id, notice, notice, [service]);
  assert.deepEqual(storage.store.get(id)!.metadata.warnings ?? [], [notice], "not the CLI's own restart warning");
});

test("on a cloud machine: a copy the CLI started clean, and the two-strike fallback, are lines in the chat", async () => {
  const source = oldChat([ASSISTANT, { ...REVIEWER, homeMachineId: "m-1" }]);
  const startedClean = forkedOnMachine(source, REVIEWER);
  {
    const { service, storage } = testService({
      conversations: [source, startedClean],
      run: async (participant, _prompt, runOptions) => {
        runOptions.onSessionId?.("fallback-session");
        return { participant, ok: true, content: "Done.", durationMs: 1, sessionId: "fallback-session", sessionRestarted: true };
      }
    });
    const warnings = await runOnMachine(asMachine(service), storage, startedClean.id, "main-id", "Go on.");
    const text = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so it started a clean session from the saved chat context.";
    await assertLineOnce(storage, startedClean.id, text, text, [service]);
    assert.deepEqual(warnings, [], "nothing left for the turn's own warnings");
  }
  {
    const codexReviewer: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined, homeMachineId: "m-1" };
    const codexSource = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
    const forked = forkedOnMachine(codexSource, codexReviewer);
    const { service, storage, runs } = testService({
      conversations: [codexSource, forked],
      run: async (participant, _prompt, runOptions) => runOptions.forkFromSessionId
        ? { participant, ok: false, content: "", error: "no rollout found for thread id src-cli-session", durationMs: 1 }
        : { participant, ok: true, content: "Clean.", durationMs: 1, sessionId: "clean-session" }
    });
    asMachine(service);
    // The first failure keeps the reply as it is; the second is the line.
    await runOnMachine(service, storage, forked.id, "main-id", "Go on.");
    await waitFor(() => sessionsOf(storage.store.get(forked.id)).find((item) => item.participantId === "main-id")?.forkFrom?.failedAttempts === 1);
    // A reply that failed counts as an answer: the retry is a later turn of the same session record.
    await runOnMachine(service, storage, forked.id, "main-id", "Try again.");
    assert.equal(runs.length, 2);
    const next = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\", so its next turn starts a clean session.";
    await assertLineOnce(storage, forked.id, next, next, [service]);
  }
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
        forkOrigin: { conversationId: source.id, participantId: boxed.id, handle: "reviewer", conversationTitle: "Old chat", kind: "claude-code",
          seen: { messageId: "old-reply", sessionCut: { sessionId: "src-cli-session", at: "assistant-uuid-1" } } } }],
      participantSessions: [],
      mainSessionParticipantId: "main-id"
    }
  } as Conversation;
  const { service } = testService({ conversations: [source, forked] });
  (service as any).machineRuntime = true;
  (service as any).hostMachineId = "m-1";
  const state = await (service as any).sessionForParticipant(forked, participantsOf(forked)[0]);
  assert.deepEqual(state.session.forkFrom, { participantId: boxed.id, sessionId: "src-cli-session", kind: "claude-code", conversationId: source.id,
    cut: { at: "assistant-uuid-1" } }, "up to the reply the User saw, at the point the machine recorded");
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
  const host = { id: "host-z", label: "Z.ai", cli: "claude-code" as const, vendor: "zai" as never, baseUrl: "https://example.invalid", hasApiKey: true, updatedAt: NOW };
  const cases: Array<[string, ChatParticipant]> = [
    ["a member the main session made, on this computer", { ...REVIEWER, delegatedByParticipantId: mainSession.id, agentMode: "auto" }],
    ["a member on a machine", { ...REVIEWER, id: "boxed", handle: "boxed", homeMachineId: "m-1", remoteExecution: "local" }],
    ["a Cloud run member on its machine", { ...REVIEWER, id: "cloudy", handle: "cloudy", homeMachineId: "m-1", cloudRun: { instanceId: "i-1" } as never }],
    ["a member on an added provider", { ...REVIEWER, id: "hosted", handle: "hosted", hostId: host.id, hostLabel: host.label, hostVendor: host.vendor }]
  ];
  for (const [label, member] of cases) {
    const source = oldChat([mainSession, member], {
      mainSessionParticipantId: mainSession.id,
      participantSessions: [sessionRecord(member, "src-cli-session")],
      // Its last reply, older than the messages held.
      lastMessageByParticipant: { [member.id]: { messageId: `far-${member.id}`, sequence: 1 } }
    });
    const { service } = testService({ conversations: [source], agents: READY_AGENTS, machines: [{ id: "m-1", name: "Box" }] });
    service.setMachineForkToNewChatSupport(() => "supported");
    const settings = (service as any).settings;
    const plain = settings.getPublicSettings;
    for (const read of ["getPublicSettings", "ensureGenericChatParticipantSeeds", "ensureAssistantProviderDefault"]) {
      settings[read] = async () => ({ ...(await plain()), cliProviderHosts: [host] });
    }
    const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: member.id } });
    const [desktopMain] = participantsOf(created.conversation);
    const offer = await service.newChatOptions([]);
    assert.ok(offer?.fork, `${label}: the computer tells the phone what it needs to fork`);
    const running = memberAsItRunsNow(member, mainSession);
    assert.equal(forkToNewChatReasonFromOffer({ running, answered: true, offer: offer!.fork! }), undefined, `${label}: offered on the phone too`);
    // Her server reads the reply the User saw by the computer's rule
    // (StorageService.conversationLastTurnEnd, checked below).
    const phoneMain = forkedMainSessionFor({
      mainSession: offer!.mainSession!, basePermissions: offer!.fork!.basePermissions, member: running,
      source: { id: source.id, title: source.title }, seen: lastMemberTurnEnd(source.messages, member.id), id: desktopMain!.id
    });
    assert.deepEqual(clone(phoneMain), clone(desktopMain), `${label}: the same member, rights, place and origin on both`);
    if (member.id === REVIEWER.id) {
      assert.deepEqual(desktopMain!.forkOrigin?.seen, { messageId: "old-reply", finishedAt: REPLY_FINISHED }, `${label}: the same reply she saw, on both`);
    }
  }
});

test("a member's copy is never placed on another provider: one whose added provider is gone is refused on the computer and the phone alike", async () => {
  const hostless = { ...REVIEWER, hostId: "host-gone", hostLabel: "Gone", homeMachineId: "m-1" };
  const source = oldChat([ASSISTANT, hostless], { lastMessageByParticipant: { [hostless.id]: { messageId: "old-reply", sequence: 1 } } });
  const { service } = testService({ conversations: [source], agents: READY_AGENTS, machines: [{ id: "m-1", name: "Box" }] });
  service.setMachineForkToNewChatSupport(() => "supported");
  await assert.rejects(service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: hostless.id } }),
    /cannot be forked to a new chat: Its provider no longer exists\./);
  const offer = await service.newChatOptions([]);
  assert.equal(forkToNewChatReasonFromOffer({ running: hostless, answered: true, offer: offer!.fork! }), "Its provider no longer exists.");
  // Nothing detected yet: still refused, rather than run on the CLI's own sign-in.
  assert.equal(forkToNewChatReasonInChat({ participant: { ...hostless, homeMachineId: undefined }, conversation: source, agents: [], providers: [], hosts: [],
    machineSupport: () => "supported" }), "Its provider no longer exists.");
});

test("a member ran when it has a finished reply (an error too), never by a reply still being written or a placeholder shown for a turn elsewhere", () => {
  const boxed = { ...REVIEWER, homeMachineId: "m-1" };
  const reply = (status: ChatMessage["status"], metadata?: Record<string, unknown>) =>
    [{ id: "r", role: "participant", participantId: boxed.id, status, ...(metadata ? { metadata } : {}) }];
  const pointer = { lastMessageByParticipant: { [boxed.id]: { messageId: "r", sequence: 1 } } };
  assert.equal(memberHasForkableSession(pointer, boxed, reply("pending")), false, "its first turn still running");
  assert.equal(memberHasForkableSession(pointer, boxed, reply("done", { serverPlaceholder: true })), false, "the bubble shown while its machine has the turn");
  assert.equal(memberHasForkableSession(pointer, boxed, reply("error")), true, "its CLI ran");
  assert.equal(memberHasForkableSession(pointer, boxed, []), true, "its last reply is older than the messages held");
  assert.equal(memberHasForkableSession({}, boxed, []), false);
  // A session moved here and not taken yet is a session to copy.
  const moved = { ...REVIEWER, sessionHandoff: { provider: "claude-code" as const, sessionId: "s", blob: { blobHash: "b" } as never, at: NOW } };
  assert.equal(memberHasForkableSession({ participantSessions: [] }, moved), true);
  assert.equal(forkToNewChatSupportFromHello(undefined), "unknown");
  assert.equal(forkToNewChatSupportFromHello({}), "outdated");
  assert.equal(forkToNewChatSupportFromHello({ forkToNewChatSupported: true }), "supported");
});

test("a member moved here whose session still waits on the server is taken before the copy is made from it", async () => {
  const moved: ChatParticipant = { ...REVIEWER, sessionHandoff: { provider: "claude-code", sessionId: "moved-session", blob: { blobHash: "b" } as never, at: NOW } };
  const source = oldChat([ASSISTANT, moved], { participantSessions: [] });
  const { service, storage, runs } = testService({ conversations: [source] });
  const taken: string[] = [];
  (service as any).takeSessionHandoff = async (conversation: Conversation, member: ChatParticipant) => {
    taken.push(`${conversation.id}:${member.id}`);
    const stored = storage.store.get(conversation.id)!;
    stored.metadata.participantSessions = [sessionRecord(moved, "moved-session")];
    storage.store.set(conversation.id, stored);
  };
  (service as any).storage.conversationAccess = async (id: string) => {
    const found = storage.store.get(id);
    return found ? { kind: found.kind, participants: clone(found.metadata.participants) } : undefined;
  };
  const { mainId } = await forkAndSend(service, storage);
  assert.deepEqual(taken.filter((key) => key.startsWith(`${source.id}:`)), [`${source.id}:${moved.id}`], "taken as its own next turn would take it");
  assert.equal(runs[0]!.participant.id, mainId);
  assert.equal(runs[0]!.options.forkFromSessionId, "moved-session");
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

/** The source chat after the reply the User saw: she asked again, and the
 *  member, still running, posted into the chat. */
function chatWithLaterWork(replyMetadata: Record<string, unknown>): Conversation {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const later = "2026-11-21T12:05:00.000Z";
  source.messages = [
    source.messages[0]!,
    { ...source.messages[1]!, metadata: { workedMs: 30_000, ...replyMetadata } },
    { id: "later-user", role: "user", content: "Now refactor it.", createdAt: later, status: "done" },
    { id: "later-post", role: "participant", participantId: REVIEWER.id, participantLabel: "@reviewer", content: "Started the refactor.", createdAt: later, status: "done",
      metadata: { appMessageSource: "app_chat_send_message" } },
    { id: "later-reply", role: "participant", participantId: REVIEWER.id, participantLabel: "@reviewer", content: "", createdAt: later, status: "pending" }
  ];
  return source;
}

test("the copy ends with the reply the User saw when she tapped Fork: what the member did after, and a turn still running, are not in it", async () => {
  const cut = { sessionId: "src-cli-session", at: "assistant-uuid-1" };
  const source = chatWithLaterWork({ sessionCut: cut });
  const { service, storage, runs } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      runOptions.onSessionId?.("fork-own-session");
      return { participant, ok: true, content: "On it.", durationMs: 1, sessionId: "fork-own-session", sessionCut: "fork-assistant-1" };
    }
  });
  const { id, mainId } = await forkAndSend(service, storage);
  const [main] = participantsOf(storage.store.get(id));
  assert.deepEqual(main!.forkOrigin?.seen, { messageId: "old-reply", sessionCut: cut, finishedAt: REPLY_FINISHED },
    "not the post nor the reply still being written");
  assert.equal(runs[0]!.options.forkFromSessionId, "src-cli-session");
  assert.deepEqual(runs[0]!.options.forkCut, { at: "assistant-uuid-1" }, "at the point that reply recorded");
  const reply = storage.store.get(id)!.messages.find((message) => message.participantId === mainId && message.role === "participant")!;
  assert.deepEqual(reply.metadata?.sessionCut, { sessionId: "fork-own-session", at: "fork-assistant-1" }, "its own reply records where its copy stands");
  assert.deepEqual(storage.store.get(id)!.metadata.warnings ?? [], [], "nothing to say: the copy is what she saw");
  assert.equal(storage.store.get(id)!.messages.some((message) => message.id.startsWith("fork-notice-")), false);
  assert.equal(storage.store.get(id)!.messages.some((message) => /may include what/.test(message.content)), false);
});

test("when the point cannot be named the whole session is copied and a line in the chat says so while the turn still runs, never a clean start", async () => {
  const unplaced = oldChat([ASSISTANT, REVIEWER]);
  unplaced.messages = [unplaced.messages[0]!, { ...unplaced.messages[1]!, metadata: undefined }];
  const compacted = "its session was compacted after that reply";
  const cases: Array<[string, Conversation, string | undefined, string]> = [
    ["no reply that ended a turn", unplaced, undefined, "the app found no reply of it that ended a turn"],
    ["the CLI could not keep the point", chatWithLaterWork({ sessionCut: { sessionId: "src-cli-session", at: "assistant-uuid-1" } }), compacted, compacted]
  ];
  for (const [label, source, cliReason, reason] of cases) {
    const note = `@main's copy of @reviewer's session may include what @reviewer did after you tapped Fork: ${reason}.`;
    let id = "";
    const lines = () => (storage.store.get(id)?.messages ?? []).filter((message) => message.role === "system" && message.content === note);
    let linesWhileRunning = -1;
    const { service, storage, runs } = testService({
      conversations: [source],
      run: async (participant, _prompt, runOptions) => {
        if (cliReason) runOptions.onForkCutMissed?.(cliReason);
        runOptions.onSessionId?.("fork-own-session");
        // Said before the turn ends: it may last hours, and the app may stop during it.
        await waitFor(() => lines().length === 1);
        linesWhileRunning = lines().length;
        return { participant, ok: true, content: "On it.", durationMs: 1, sessionId: "fork-own-session", ...(cliReason ? { forkCutMissed: cliReason } : {}) };
      }
    });
    const created = await service.createConversation({ participants: [], forkOf: { conversationId: "old-chat", participantId: REVIEWER.id } });
    id = created.conversation.id;
    const mainId = String(created.conversation.metadata.mainSessionParticipantId);
    await service.sendMessage({ conversationId: id, runId: `run-${label}`, content: "Go on.", targetParticipantIds: [mainId] });
    await waitFor(() => (storage.store.get(id)?.messages ?? []).some((message) => message.participantId === mainId && message.status !== "pending"));
    assert.equal(runs[0]!.options.forkFromSessionId, "src-cli-session", `${label}: still a copy`);
    assert.equal(linesWhileRunning, 1, `${label}: in the chat while the turn ran`);
    // A line in the chat, which her server carries to the phone and from a
    // cloud machine, and the warning the device that ran it shows.
    await assertLineOnce(storage, id, note, label, [service]);
    assert.deepEqual(storage.store.get(id)!.metadata.warnings ?? [], [note], label);
    if (!cliReason) assert.equal(runs[0]!.options.forkCut, undefined, `${label}: no point asked`);
  }
});

test("when the member's session changed after the reply she saw, the session that reply was in is copied up to it", async () => {
  const { service, storage, runs } = testService({ conversations: [chatWithLaterWork({ sessionCut: { sessionId: "older-session", at: "assistant-uuid-1" } })] });
  await forkAndSend(service, storage);
  assert.equal(runs[0]!.options.forkFromSessionId, "src-cli-session", "the member's session, as the fallback");
  assert.deepEqual(runs[0]!.options.forkCut, { at: "assistant-uuid-1", sessionId: "older-session" });
});

test("a fork whose source is gone says only that, not that its copy may hold more", async () => {
  const codexReviewer: ChatParticipant = { ...REVIEWER, kind: "codex-cli", model: undefined, reasoningEffort: undefined };
  const source = oldChat([ASSISTANT, codexReviewer], { participantSessions: [sessionRecord(codexReviewer, "src-cli-session")] });
  const { service, storage } = testService({
    conversations: [source],
    run: async (participant) => ({ participant, ok: false, content: "", error: "no rollout found for thread id src-cli-session", durationMs: 1,
      forkCutMissed: "that reply is not in its session" })
  });
  const { id, mainId } = await forkAndSend(service, storage);
  await waitFor(() => sessionsOf(storage.store.get(id)).find((item) => item.participantId === mainId)?.forkFrom?.failedAttempts === 1);
  assert.equal((storage.store.get(id)?.messages ?? []).some((message) => /may include what/.test(message.content)), false);
});

test("a reply that ends a turn records where its CLI session stood; one whose CLI did not say records nothing", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  let turn = 0;
  const { service, storage } = testService({
    conversations: [source],
    run: async (participant, _prompt, runOptions) => {
      turn += 1;
      runOptions.onSessionId?.("fork-own-session");
      return { participant, ok: true, content: `Turn ${turn}.`, durationMs: 1, sessionId: "fork-own-session", ...(turn === 1 ? { sessionCut: "turn-1-cut" } : {}) };
    }
  });
  const { id, mainId } = await forkAndSend(service, storage);
  await service.sendMessage({ conversationId: id, runId: "run-two", content: "Again.", targetParticipantIds: [mainId] });
  await waitFor(() => (storage.store.get(id)?.messages ?? []).filter((message) => message.participantId === mainId && message.status === "done").length === 2);
  const replies = storage.store.get(id)!.messages.filter((message) => message.participantId === mainId);
  assert.deepEqual(replies.map((message) => message.metadata?.sessionCut ?? null), [{ sessionId: "fork-own-session", at: "turn-1-cut" }, null]);
  assert.ok(replies.every((message) => typeof message.metadata?.workedMs === "number"));
});

test("the reply the User saw: a finished reply that ended a turn, its point or its finish, and where the copy ends from it", () => {
  const reply = (patch: Partial<ChatMessage>): ChatMessage => ({ id: "r", role: "participant", participantId: REVIEWER.id, content: "x", createdAt: NOW, status: "done", ...patch });
  assert.equal(isMemberTurnEnd(reply({ metadata: { workedMs: 5 } }), REVIEWER.id), true);
  assert.equal(isMemberTurnEnd(reply({ status: "error", metadata: { workedMs: 5 } }), REVIEWER.id), true, "a turn that failed ended too");
  assert.equal(isMemberTurnEnd(reply({ metadata: { sessionCut: { sessionId: "s", at: "a" } } }), REVIEWER.id), true);
  assert.equal(isMemberTurnEnd(reply({}), REVIEWER.id), false, "a post, a request or an Accord launch written during a turn");
  assert.equal(isMemberTurnEnd(reply({ status: "pending", metadata: { workedMs: 5 } }), REVIEWER.id), false);
  assert.equal(isMemberTurnEnd(reply({ metadata: { workedMs: 5, serverPlaceholder: true } }), REVIEWER.id), false);
  assert.equal(isMemberTurnEnd(reply({ metadata: { workedMs: 5 } }), ASSISTANT.id), false);
  // Its finish counts from its own turn's start when it waited behind another.
  assert.equal(memberReplyFinishedAt(reply({ metadata: { workedMs: 1_000, turnStartedAt: "2026-11-21T12:01:00.000Z" } })), "2026-11-21T12:01:01.000Z");
  assert.equal(memberReplyFinishedAt(reply({ metadata: { workedMs: 1_000 } })), "2026-11-21T12:00:01.000Z");
  assert.deepEqual(forkSeenReplyOf(reply({ metadata: { workedMs: 1_000, sessionCut: { sessionId: "s", at: "a", extra: 1 } as never } })),
    { messageId: "r", sessionCut: { sessionId: "s", at: "a" }, finishedAt: "2026-11-21T12:00:01.000Z" });
  assert.deepEqual(forkCutFor({ messageId: "r", sessionCut: { sessionId: "s", at: "a" }, finishedAt: REPLY_FINISHED }, "s"), { at: "a" });
  assert.deepEqual(forkCutFor({ messageId: "r", sessionCut: { sessionId: "old", at: "a" }, finishedAt: REPLY_FINISHED }, "s"), { at: "a", sessionId: "old" },
    "the session the reply was in, when the member's changed after it");
  assert.deepEqual(forkCutFor({ messageId: "r", finishedAt: REPLY_FINISHED }, "s"), { finishedBy: REPLY_FINISHED });
  assert.deepEqual(forkCutFor({ messageId: "r" }, "s"), { unknown: "its last reply does not say where it ended in its session" });
  assert.deepEqual(forkCutFor(undefined, "s"), { unknown: "the app found no reply of it that ended a turn" });
});

test("her server and the computer read the reply the User saw by the same rule", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-fork-seen-"));
  const storage = new StorageService({ dbPath: path.join(directory, "accordagents.sqlite3") });
  try {
    const variants: Array<[string, Conversation]> = [
      ["a recorded point, then a post and a running reply", chatWithLaterWork({ sessionCut: { sessionId: "src-cli-session", at: "assistant-uuid-1" } })],
      ["an older reply, by its finish", chatWithLaterWork({ turnStartedAt: "2026-11-21T12:00:10.000Z" })],
      ["a placeholder for a turn elsewhere is not it", (() => {
        const chat = chatWithLaterWork({});
        chat.messages.push({ id: "placeholder", role: "participant", participantId: REVIEWER.id, content: "", createdAt: NOW, status: "done", metadata: { workedMs: 1, serverPlaceholder: true } });
        return chat;
      })()],
      ["no reply that ended a turn", (() => {
        const chat = oldChat([ASSISTANT, REVIEWER]);
        chat.messages = [chat.messages[0]!, { ...chat.messages[1]!, metadata: undefined }];
        return chat;
      })()]
    ];
    for (const [label, chat] of variants) {
      await storage.saveConversation({ ...chat, id: `chat-${label}` });
      assert.deepEqual(await storage.conversationLastTurnEnd(`chat-${label}`, REVIEWER.id), lastMemberTurnEnd(chat.messages, REVIEWER.id), label);
    }
    assert.deepEqual(await storage.conversationLastTurnEnd("chat-an older reply, by its finish", REVIEWER.id), { messageId: "old-reply", finishedAt: "2026-11-21T12:00:40.000Z" });
    assert.equal(await storage.conversationLastTurnEnd("chat-no reply that ended a turn", REVIEWER.id), undefined);
    assert.equal(await storage.conversationLastTurnEnd("no-such-chat", REVIEWER.id), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a forked main session whose provider was changed before its first turn says so, not that the session is missing", async () => {
  const source = oldChat([ASSISTANT, REVIEWER]);
  const { service, storage, runs } = testService({ conversations: [source] });
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: source.id, participantId: REVIEWER.id } });
  const id = created.conversation.id;
  const mainId = String(created.conversation.metadata.mainSessionParticipantId);
  // Its provider changed in its settings before it ever ran.
  const stored = storage.store.get(id)!;
  stored.metadata.participants = participantsOf(stored).map((item) => item.id === mainId ? { ...item, kind: "codex-cli", model: undefined, reasoningEffort: undefined } : item);
  storage.store.set(id, stored);
  await service.sendMessage({ conversationId: id, runId: "run-other-cli", content: "Hello.", targetParticipantIds: [mainId] });
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0]!.options.forkFromSessionId, undefined);
  const text = "@main could not start from a copy of @reviewer's session in the chat \"Old chat\": @main now runs on Codex, not Claude Code, so it starts a clean session.";
  await assertLineOnce(storage, id, text, text, [service]);
});

test("a member's CLI session started anew says so as a warning, unless a fork's line says it instead", () => {
  const { service } = testService({ conversations: [] });
  const session = { ...sessionRecord(REVIEWER, "old-session") };
  const restarted = { participant: { id: REVIEWER.id, kind: "claude-code", label: "@reviewer" }, ok: true, content: "Done.", sessionId: "new-session", sessionRestarted: true };
  const warnings: string[] = [];
  (service as any).applyCliRunMetadata(session, restarted, REVIEWER, warnings);
  (service as any).applyCliRunMetadata(session, restarted, REVIEWER, warnings);
  assert.deepEqual(warnings, ["@reviewer: previous CLI session was unavailable, so a new session was started from saved chat context."], "once");
  assert.equal(session.sessionId, "new-session");
  const forked: string[] = [];
  (service as any).applyCliRunMetadata({ ...sessionRecord(REVIEWER, "") }, restarted, REVIEWER, forked, true);
  assert.deepEqual(forked, []);
});
