// What the main session's tests set up.
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
  AppSettings, ChatAgentPermissions, ChatMessage, ChatParticipant, ChatParticipantRequestBatch, ChatParticipantSession,
  ChatProviderKind, ChatRoleConfig, Conversation, ParticipantConfig
} from "../../../../shared/types";

// The main session of a chat (docs/main-session.md): it gives new members
// tasks without a card, never with broader rights than its own, can fork its
// CLI session for them, and is the only member that starts an Accord.

export const NOW = "2026-11-20T12:00:00.000Z";

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

export const GENERIC_ROLE: ChatRoleConfig = {
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

export const REVIEWER_ROLE: ChatRoleConfig = {
  id: "code-reviewer",
  label: "Code Reviewer",
  instructions: "Review code.",
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

export function mainSession(kind: ChatProviderKind = "claude-code", patch: Partial<ChatParticipant> = {}): ChatParticipant {
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

export function member(id: string, handle: string, patch: Partial<ChatParticipant> = {}): ChatParticipant {
  return { id, handle, roleConfigId: GENERIC_ROLE.id, kind: "codex-cli", agentMode: "default", permissions: permissions(), ...patch };
}

export function sessionRecord(participant: ChatParticipant, sessionId: string, role: ChatRoleConfig = MAIN_ROLE): ChatParticipantSession {
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

export function mainSessionChat(participants: ChatParticipant[], metadata: Record<string, unknown> = {}): Conversation {
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

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type RunCall = { participant: ParticipantConfig; prompt: string; options: any };

export function testService(options: {
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
    crashReportsNotice: false,
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
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  return { service, storage, runs, debugEvents };
}

export function mainActor(capabilities: string[] = ["participants.manage", "participants.delegate", "accord.start", "participants.request"], patch: Record<string, unknown> = {}): any {
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

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for condition: ${predicate.toString().slice(0, 200)}`);
}

export function participantsOf(conversation: Conversation): ChatParticipant[] {
  return conversation.metadata.participants as ChatParticipant[];
}

export function delegationBatches(conversation: Conversation): ChatParticipantRequestBatch[] {
  return conversation.messages.flatMap((message) => message.metadata?.participantRequest?.delegation ? [message.metadata.participantRequest] : []);
}

export const resumesOf = (runs: RunCall[], mainId: string) => runs.filter((run) => run.participant.id === mainId && run.prompt.includes("Auto-resumed @main"));

// --- review of 2026-11-20: rights one level down, the chain limit, scheduled tasks

/** A member the main session made that may add members (its task said so). */
export function delegatedManager(patch: Partial<ChatParticipant> = {}): ChatParticipant {
  return member("child-id", "child", {
    kind: "claude-code",
    delegatedByParticipantId: "main-id",
    permissions: permissions({ requestParticipants: "allow", manageRolesParticipants: "allow" }),
    ...patch
  });
}

export function childActor(capabilities: string[] = ["participants.manage", "participants.request"], patch: Record<string, unknown> = {}): any {
  return { ...mainActor(capabilities, patch), participantId: "child-id", roleConfigId: GENERIC_ROLE.id, participantRequestDepth: 1, ...patch };
}

// --- a request made with app_chat_request_participants, cut short by a quit -----

const REQUEST_KEY = "conversation-1\u0000request\u0000request-1";

/** A chat whose requester asked one member with app_chat_request_participants
 *  (resumeRequester) in its turn "turn-1" before the app quit, stored as the
 *  app stores it: `item` is how the request ended (a quit ends a running one
 *  interrupted, its reply stopped; one answered just before the quit skipped
 *  its resume; one still running has its reply pending). */
export function quitRequestChat(
  item: "interrupted" | "answered" | "running",
  options: { at?: string; resumeRequester?: boolean; source?: "mcp" | "inferred"; requester?: Partial<ChatParticipant>; resumeLine?: boolean;
    batch?: Partial<ChatParticipantRequestBatch> } = {}
): Conversation {
  const at = options.at ?? new Date(Date.now() - 5 * 60_000).toISOString();
  const main = mainSession("codex-cli", { model: undefined, ...options.requester });
  const helper = member("helper-id", "helper");
  const conversation = mainSessionChat([main, helper], { participantSessions: [sessionRecord(main, "main-thread")] });
  conversation.messages[0]!.createdAt = at;
  // Its own turn's reply, written as the turn began and finished after it asked.
  conversation.messages.push({ id: "main-reply", role: "participant", participantId: main.id, participantLabel: "@main", content: "asked", createdAt: at, status: "done",
    metadata: { sourceMessageId: "user-message", threadId: "user-message", runId: "run-1", turnSegmentId: "turn-1" } } as ChatMessage);
  const status = item === "running" ? "running" : item;
  conversation.messages.push({
    id: "request-1", role: "participant", participantId: main.id, participantLabel: "@main", content: "@helper Run the job.", createdAt: at, status: "done",
    metadata: { sourceMessageId: "user-message", threadId: "user-message", participantRequest: {
      id: "batch-1", requesterParticipantId: main.id, requesterHandle: "main", source: options.source ?? "mcp", resumeRequester: options.resumeRequester ?? true,
      status, depth: 1, requesterDepth: 0, chainRootId: "user-message", createdAt: at, updatedAt: at, triggerMessageId: "user-message", requesterTurnSegmentId: "turn-1",
      items: [{ targetParticipantId: "helper-id", targetHandle: "helper", prompt: "Run the job.", status: item, createdAt: at, updatedAt: at, replyMessageId: "helper-reply",
        ...(item === "interrupted" ? { error: "Request was interrupted before completion." } : {}) }],
      ...options.batch
    } }
  } as ChatMessage);
  conversation.messages.push({ id: "helper-reply", role: "participant", participantId: "helper-id", participantLabel: "@helper",
    content: item === "answered" ? "Job finished: 42." : item === "interrupted" ? "Interrupted before completion." : "",
    createdAt: at, status: item === "answered" ? "done" : item === "interrupted" ? "error" : "pending",
    metadata: { sourceMessageId: "request-1", chatThreadRootId: "request-1", runId: "helper-run",
      ...(item === "interrupted" ? { terminalReason: "user-stopped" as const } : {}) } } as ChatMessage);
  if (options.resumeLine) {
    conversation.messages.push({ id: "resume-line", role: "system", content: "Auto-resumed @main after member request.\nTarget replies/errors are in the transcript above.", createdAt: at, status: "done",
      metadata: { sourceMessageId: "request-1", parentMessageId: "request-1" } } as ChatMessage);
  }
  return conversation;
}

export const requestBatch = (conversation: Conversation) => conversation.messages.find((message) => message.id === "request-1")!.metadata!.participantRequest!;

/** Recovery looked at the chat and left this request alone (no line is said for it). */
export const leftAlone = (service: unknown, key = REQUEST_KEY) =>
  chatParts(service).requestRecovery.delegationRecoveryLookedChats.has("conversation-1") && !chatParts(service).requestRecovery.delegationGroupsRecovered.has(key);
