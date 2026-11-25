// What the fork tests set up.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatService } from "../../chat";
import { chatParts } from "./chatParts";
import { normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../../../shared/chatPromptContext";
import {
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT, CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT
} from "../../../../shared/chatParticipantRequests";
import { CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT } from "../../../../shared/chatAutoWatch";
import { EMPTY_MOBILE_CONTROL_SETTINGS } from "../../../../shared/mobilePairing";
import type {
  AgentHealth, AppSettings, ChatAgentPermissions, ChatMessage, ChatParticipant, ChatParticipantSession, ChatProviderKind,
  ChatRoleConfig, Conversation, ParticipantConfig
} from "../../../../shared/types";

// Fork to new chat (src/shared/forkToNewChat.ts): any member of any chat
// becomes the main session of a new chat, starting from a copy of its CLI
// session at the new chat's first message.

export const NOW = "2026-11-21T12:00:00.000Z";

/** When the source chat's reply finished, on the clock of the device that ran it. */
export const REPLY_FINISHED = "2026-11-21T12:00:30.000Z";

export const MAIN_ROLE: ChatRoleConfig = {
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

export function permissions(patch: Partial<ChatAgentPermissions> = {}): ChatAgentPermissions {
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

export const REVIEWER: ChatParticipant = {
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

export const ASSISTANT: ChatParticipant = { id: "admin-id", handle: "admin", roleConfigId: ADMIN_ROLE.id, kind: "codex-cli", agentMode: "default", permissions: permissions({ repoRead: false }) };

export function sessionRecord(participant: ChatParticipant, sessionId: string, role: ChatRoleConfig = REVIEWER_ROLE): ChatParticipantSession {
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
export function oldChat(participants: ChatParticipant[], metadata: Record<string, unknown> = {}): Conversation {
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

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type RunCall = { participant: ParticipantConfig; prompt: string; options: any };

export function testService(options: {
  conversations: Conversation[];
  agents?: AgentHealth[];
  machines?: Array<{ id: string; name: string; deviceId?: string }>;
  run?: (participant: ParticipantConfig, prompt: string, options: any) => Promise<any>;
  /** The readiness check itself fails (it could not run). */
  readinessFails?: boolean;
  /** Settings → General → New chats. */
  newChatDefaults?: AppSettings["newChatDefaults"];
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
    // A view Settings once named for new chats: never read any more.
    defaultChatView: "classic",
    ...(options.newChatDefaults ? { newChatDefaults: options.newChatDefaults } : {})
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
  // Which CLIs a readiness check covered: every CLI, or only these.
  const readinessChecks: Array<"all" | ChatProviderKind[]> = [];
  const cliRunner = {
    async detectAgents() { readinessChecks.push("all"); return options.agents ?? []; },
    async detectAgentKinds(kinds: ChatProviderKind[]) {
      readinessChecks.push([...kinds]);
      if (options.readinessFails) throw new Error("spawn claude EACCES /Users/someone/.local/bin/claude");
      return options.agents ?? [];
    },
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
    chatParts(made).chatHistory.ensureHistoryFiles = async () => tempRoot;
    return made;
  };
  const service = make();
  /** The app again after a quit (or a machine's runtime after a restart):
   *  a new service over the same storage. */
  const restart = (run?: (participant: ParticipantConfig, prompt: string, options: any) => Promise<any>) => {
    if (run) options.run = run;
    return make();
  };
  return { service, storage, runs, restart, readinessChecks };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for condition: ${predicate.toString().slice(0, 200)}`);
}

/** The chat's lines with this text (system messages every device shows). */
export function linesOf(conversation: Conversation | undefined, text: string): ChatMessage[] {
  return (conversation?.messages ?? []).filter((message) => message.role === "system" && message.content === text);
}

/** A fork's notice (postForkNotice): a line in the chat, which her server
 *  carries to every device, once per member and kind (its id says which);
 *  and the warning the device that ran it shows, once. `service`: the
 *  services that may still be writing, drained before counting. */
export async function assertLineOnce(storage: { store: Map<string, Conversation> }, id: string, text: string, label = text, services: ChatService[] = []): Promise<void> {
  await waitFor(() => linesOf(storage.store.get(id), text).length > 0);
  // Writes still queued land before counting.
  for (const service of services) await service.settleChatSaves();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const service of services) await service.settleChatSaves();
  const lines = linesOf(storage.store.get(id), text);
  assert.equal(lines.length, 1, `${label}: once`);
  assert.equal(lines[0]!.metadata?.threadId, "system", label);
  assert.match(lines[0]!.id, /^fork-notice-(origin-unavailable|cut-missed|started-clean)-/, `${label}: one id per member and kind`);
  const warnings = (storage.store.get(id)?.metadata.warnings ?? []) as string[];
  assert.deepEqual(warnings.filter((warning) => warning === text), [text], `${label}: the warning on the device that ran it, once (${JSON.stringify(warnings)})`);
}

export function sessionsOf(conversation: Conversation | undefined): ChatParticipantSession[] {
  return (conversation?.metadata.participantSessions ?? []) as ChatParticipantSession[];
}

export function participantsOf(conversation: Conversation | undefined): ChatParticipant[] {
  return (conversation?.metadata.participants ?? []) as ChatParticipant[];
}

/** Makes the fork and sends its first message; resolves once that turn ended. */
export async function forkAndSend(service: ChatService, storage: ReturnType<typeof testService>["storage"], content = "Carry on from here.") {
  const created = await service.createConversation({ participants: [], forkOf: { conversationId: "old-chat", participantId: REVIEWER.id } });
  const id = created.conversation.id;
  const mainId = String(created.conversation.metadata.mainSessionParticipantId);
  await service.sendMessage({ conversationId: id, runId: `run-${content}`, content, targetParticipantIds: [mainId] });
  await waitFor(() => (storage.store.get(id)?.messages ?? []).some((message: ChatMessage) => message.participantId === mainId && message.status !== "pending"));
  // A reply's status can be saved before its turn's last step (the member's
  // session record) lands: the turn has ended once its run is gone.
  await waitFor(() => ((storage.store.get(id)?.metadata.activeRunIds as string[] | undefined) ?? []).length === 0);
  return { id, mainId };
}

export const READY_AGENTS: AgentHealth[] = [
  { kind: "claude-code", label: "Claude Code", installed: true },
  { kind: "codex-cli", label: "Codex CLI", installed: true }
];

/** The source chat after the reply the User saw: she asked again, and the
 *  member, still running, posted into the chat. */
export function chatWithLaterWork(replyMetadata: Record<string, unknown>): Conversation {
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
