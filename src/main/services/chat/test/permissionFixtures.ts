// What the chat tests set up: members, conversations, storage and a ChatService around them.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
  APP_TOOL_PERMISSION_TOOL, AppMcpService
} from "../../appMcp";
import { ChatService } from "../../chat";
import { chatDependencies, chatParts } from "./chatParts";
import type { HubCard, HubFeedEntry, HubOp, HubOpEffect, HubTurn } from "../../../../shared/hubOps";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import {
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT, CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT
} from "../../../../shared/chatParticipantRequests";
import { CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT } from "../../../../shared/chatAutoWatch";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../../../shared/chatPromptContext";
import { EMPTY_MOBILE_CONTROL_SETTINGS } from "../../../../shared/mobilePairing";
import { preferredReadyAssistantProviderKind } from "../../../../shared/cliReadiness";
import { MAIN_SESSION_ROLE_ID } from "../../../../shared/mainSession";
import type {
  AgentHealth, AppSettings, ChatAppToolApproval, ChatBehaviorRuleConfig, ChatMessage, ChatParticipant, ChatParticipantConfig,
  ChatParticipantConfigUpdate, ChatProviderKind, ChatRoleChangeOperation, ChatRoleConfig, ChatRoleConfigUpdate, Conversation,
  ParticipantConfig, ProviderSettings
} from "../../../../shared/types";

export const NOW = "2026-05-17T12:00:00.000Z";

export const ROLE: ChatRoleConfig = {
  id: "engineer",
  label: "Engineer",
  instructions: "Answer directly.",
  version: 1,
  appToolCapabilities: [],
  updatedAt: NOW
};

/** The main session's built-in role (settings.ts), as every install has it. */
const MAIN_SESSION_ROLE: ChatRoleConfig = {
  id: MAIN_SESSION_ROLE_ID,
  label: "Main session",
  instructions: "Work on User's requests and delegate when it helps.",
  version: 1,
  appToolCapabilities: ["participants.manage", "participants.delegate", "accord.start"],
  participantDefaults: {
    autoWatch: false,
    requestParticipants: "allow",
    requestCompaction: "ask",
    manageRolesParticipants: "allow"
  },
  builtIn: true,
  updatedAt: NOW
};

/** Built-in roles are always in Settings (SettingsService.mergeDefaultRoles):
 *  the main session's too, whatever roles a test names. */
function withBuiltInMainSessionRole(roles: ChatRoleConfig[]): ChatRoleConfig[] {
  return roles.some((role) => role.id === MAIN_SESSION_ROLE_ID) ? roles : [...roles, MAIN_SESSION_ROLE];
}

export const ADMIN_ROLE: ChatRoleConfig = {
  id: "administrator",
  label: "Chat Assistant",
  instructions: "Help User set up chat participants.",
  version: 1,
  appToolCapabilities: ["participants.manage"],
  participantDefaults: {
    autoWatch: false,
    requestParticipants: "ask",
    manageRolesParticipants: "ask"
  },
  builtIn: true,
  updatedAt: NOW
};

export function toolPermissionActor(participant: ChatParticipant, conversation: Conversation, runId = "run-42") {
  return {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    agentMode: "default" as const,
    runId,
    triggerMessageId: "user-message"
  };
}

export async function pendingToolPermission(storage: { current: Conversation }, toolName: string): Promise<ChatAppToolApproval> {
  await waitFor(() => ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
    .some((approval) => approval.toolName === APP_TOOL_PERMISSION_TOOL && approval.status === "pending" &&
      (approval.request as { toolName?: string }).toolName === toolName));
  return ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
    .filter((approval) => (approval.request as { toolName?: string }).toolName === toolName)
    .find((approval) => approval.status === "pending")!;
}

export function removalTrio(metadata: Record<string, any> = {}) {
  const assistant = { ...chatParticipant("codex-cli"), id: "assistant-participant", handle: "assistant", roleConfigId: ADMIN_ROLE.id };
  const worker = { ...chatParticipant("claude-code"), id: "worker-participant", handle: "worker" };
  const target = { ...chatParticipant("codex-cli"), id: "target-participant", handle: "target" };
  const conversation = chatConversation([assistant, worker, target], metadata);
  return { assistant, worker, target, conversation };
}

/** Registers a member's turn the way runParticipantBatch does. */
export async function startMemberTurn(service: ChatService, storage: any, member: ChatParticipant, runId: string): Promise<Conversation> {
  const live = await storage.getConversation("conversation-1") as Conversation;
  chatParts(service).activeRuns.registerTargetRun(runId, new AbortController(), { conversationId: live.id, participantId: member.id, participantHandle: member.handle });
  await chatParts(service).activeRuns.beginChatRun(live, runId);
  await chatParts(service).store.waitForQueuedSave(live.id);
  return live;
}

export function memberRemovalFixture(options: { metadata?: Record<string, any>; messages?: ChatMessage[]; manage?: "ask" | "allow" } = {}) {
  // The manager's Manage members setting decides a removal as it does an
  // addition: "ask" puts it on a card, "allow" makes it without one.
  const managerRole: ChatRoleConfig = {
    ...ROLE,
    id: "removal-manager",
    label: "Removal Manager",
    participantDefaults: {
      autoWatch: false,
      requestParticipants: "ask",
      manageRolesParticipants: options.manage ?? "ask"
    }
  };
  const assistant = { ...chatParticipant("codex-cli"), id: "assistant-participant", handle: "assistant", roleConfigId: ADMIN_ROLE.id };
  const manager = { ...chatParticipant("claude-code"), id: "manager-participant", handle: "manager", roleConfigId: managerRole.id };
  const target = { ...chatParticipant("codex-cli"), id: "target-participant", handle: "target" };
  const conversation = chatConversation([assistant, manager, target], {
    participantSessions: [{
      participantId: target.id,
      sessionId: "target-session",
      roleConfigId: target.roleConfigId,
      roleConfigVersion: 1,
      roleLabel: ROLE.label,
      roleInstructions: ROLE.instructions,
      updatedAt: NOW
    }],
    ...options.metadata
  });
  conversation.messages.push(...(options.messages ?? []));
  const fixture = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, managerRole, ROLE], chatParticipantConfigs: [] }
  });
  return { ...fixture, conversation, assistant, manager, target, actor: participantManagerActor(conversation.id, manager) };
}

export function memberIds(conversation: Conversation): string[] {
  return (conversation.metadata.participants as ChatParticipant[]).map((participant) => participant.id);
}

export function queuedRemovalApproval(targetId: string, handle: string, patch: Partial<ChatAppToolApproval> = {}): ChatAppToolApproval {
  return {
    id: `queued-${handle}`,
    conversationId: "conversation-1",
    requesterParticipantId: "manager-participant",
    requesterHandle: "manager",
    requesterRoleConfigId: "removal-manager",
    toolName: APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
    capability: "participants.manage",
    status: "approved",
    approvalScope: "once",
    request: { kind: "participant_removal", operations: [{ type: "remove_participant_from_chat", participantId: targetId, handle }] },
    summary: `Remove @${handle} from this chat`,
    memberRemovalQueuedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  };
}

/** The card a machine member's machine raised on the User's server for an
 *  approval, as the desktop reads it in the feed (agreement Д9). */
export function machineCard(approval: ChatAppToolApproval, patch: Partial<HubCard> = {}): HubCard {
  const { memberRemovalQueuedAt: _removal, memberAdditionQueuedAt: _addition, homeMachineId: _home, ...shown } = approval;
  return {
    cardId: approval.id, conversationId: approval.conversationId, cardKind: "roster", participantId: approval.requesterParticipantId,
    raisedBy: "machine-device", raisedAt: NOW, state: "pending",
    card: { approval: { ...shown, status: shown.status === "auto-applied" ? "auto-applied" : "pending" } },
    ...patch
  };
}

/** The card answered on the server: by the User (from any device), or by
 *  the member's own machine for what its policy allowed (`auto`). */
export function answeredCard(card: HubCard, answer: Record<string, unknown>, answeredBy = "phone-device"): HubCard {
  return { ...card, state: "answered", answer, answeredBy, answeredAt: new Date().toISOString() };
}

/** What the desktop does with a card change it reads in the server's feed. */
export async function feedCard(service: ChatService, kind: "card.raise" | "card.answer" | "card.settle", card: HubCard, opId = `op-${randomUUID()}`): Promise<void> {
  const internals = service as any;
  const conversation = await chatDependencies(internals).storage.getConversation(card.conversationId);
  await chatParts(internals).store.withChatMutation(conversation, async () => {
    chatParts(internals).serverCardMirrors.mirrorServerCard(conversation, kind, card, opId);
    await chatParts(internals).store.saveConversation(conversation, { emitChanges: false });
  });
}

/** The asking member runs on a machine. */
export function homeOnMachine(storage: any, participantId = "manager-participant", machineId = "machine"): void {
  storage.current.metadata.participants = (storage.current.metadata.participants as ChatParticipant[]).map((participant) =>
    participant.id === participantId ? { ...participant, homeMachineId: machineId } : participant);
}

/** A member's turn in progress: its reply, still running, under the User's
 *  message (the run's pending bubble). */
export function runningReply(participant: ChatParticipant, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "reply-1",
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "",
    createdAt: NOW,
    status: "pending",
    ...patch,
    metadata: {
      threadId: "user-message",
      parentMessageId: "user-message",
      sourceMessageId: "user-message",
      runId: "turn-run-1",
      turnSegmentId: "turn-segment-1",
      participantRequestDepth: 0,
      ...patch.metadata
    }
  };
}

/** The turn the running reply belongs to, live in this process. */
export function liveTurn(service: ChatService, participant: ChatParticipant): void {
  chatParts(service).activeRuns.registerTargetRun("turn-run-1", new AbortController(), {
    conversationId: "conversation-1", participantId: participant.id, participantHandle: participant.handle
  });
  chatParts(service).activeRuns.setTargetRunPendingMessageId("turn-run-1", "reply-1");
}

export function turnActor(participant: ChatParticipant, patch: Record<string, unknown> = {}): any {
  return {
    ...participantRequestActor(participant),
    capabilities: [],
    runId: "turn-run-1",
    turnSegmentId: "turn-segment-1",
    ...patch
  };
}

export function pendingParticipantMessage(
  participant: ChatParticipant,
  id: string,
  runId: string,
  patch: Partial<{ status: "pending" | "done" | "error"; content: string; metadata: any }> = {}
): any {
  return {
    id,
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: patch.content ?? "",
    createdAt: NOW,
    status: patch.status ?? "pending",
    metadata: patch.metadata ?? { runId }
  };
}

export function testService(options: {
  conversation?: Conversation;
  run?: (...args: any[]) => Promise<any>;
  agents?: AgentHealth[];
  userSkills?: any;
  appMcp?: AppMcpService;
  onSnapshot?: (conversation: Conversation) => void;
  settings?: {
    chatRoleConfigs: ChatRoleConfig[];
    chatBehaviorRules?: ChatBehaviorRuleConfig[];
    chatParticipantConfigs?: ChatParticipantConfig[];
    chatParticipantRequestMaxDepth?: number;
    chatParticipantRequestPromptMaxChars?: number;
    chatAutoWatchWakeLimit?: number;
    chatPromptContext?: AppSettings["chatPromptContext"];
    cloudRuns?: Partial<AppSettings["cloudRuns"]>;
    mobileControl?: AppSettings["mobileControl"];
    providers?: ProviderSettings[];
    assistantProviderKind?: ChatProviderKind;
    lastSuccessfulChatProviderKind?: ChatProviderKind;
    newChatDefaults?: AppSettings["newChatDefaults"];
    /** A field a settings file from before may still hold (ignored). */
    legacyDefaultChatView?: string;
  };
  machines?: Array<{ id: string; name: string; awsInstanceId?: string; deviceId?: string; lastHello?: { providers: Array<{ kind: string; installed: boolean }> } }>;
  machineInstalls?: Array<{ machineId: string; projects?: Record<string, string>; target?: { hostKeyAlias?: string } }>;
} = {}): { service: ChatService; storage: any; settingsState: {
  chatRoleConfigs: ChatRoleConfig[];
  chatBehaviorRules: ChatBehaviorRuleConfig[];
  chatParticipantConfigs: ChatParticipantConfig[];
  batchWriteCount: number;
  recordedSuccessfulProviders: ChatProviderKind[];
}; tempRoot: string; debugEvents: Array<{ event: string; payload: Record<string, unknown> }> } {
  const tempRoot = path.join(tmpdir(), "accordagents-chat-permissions-test");
  const storage = {
    current: options.conversation ? clone(options.conversation) : undefined,
    async listConversations(): Promise<Array<{ id: string; title: string; kind: Conversation["kind"]; createdAt: string; updatedAt: string; running?: boolean }>> {
      return this.current ? [{
        id: this.current.id,
        title: this.current.title,
        kind: this.current.kind,
        createdAt: this.current.createdAt,
        updatedAt: this.current.updatedAt,
        running: this.current.metadata.running === true || Array.isArray(this.current.metadata.activeRunIds)
      }] : [];
    },
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      this.current = clone(conversation);
    },
    // What the User's server's feed asks of a device's storage.
    conversationTombstones() {
      return { isDeleted: async () => false, mark: async () => undefined, pendingCopies: async () => [] };
    },
    cancelRequests: new Map<string, string>(),
    async requestRunCancel(conversationId: string, runId: string): Promise<void> {
      this.cancelRequests.set(runId, conversationId);
    },
    async takeRunCancelRequests(runIds: string[]): Promise<string[]> {
      const matched = runIds.filter((runId) => this.cancelRequests.has(runId));
      for (const runId of matched) {
        this.cancelRequests.delete(runId);
      }
      return matched;
    }
  };
  const settingsState = {
    chatRoleConfigs: clone(withBuiltInMainSessionRole(options.settings?.chatRoleConfigs ?? [ROLE])),
    chatBehaviorRules: clone(options.settings?.chatBehaviorRules ?? []),
    chatParticipantConfigs: clone(options.settings?.chatParticipantConfigs ?? []),
    batchWriteCount: 0,
    recordedSuccessfulProviders: [] as ChatProviderKind[]
  };
  let assistantProviderKind = options.settings?.assistantProviderKind;
  const publicSettings = (): AppSettings => ({
    chatCustomAvatars: [],
    roundLimitDefault: 1,
    betaUpdates: false,
    chatShowMemberActions: true,
    crashReports: true,
    crashReportsNotice: false,
    cliAgentRunTimeoutMs: 24 * 60 * 60_000,
    chatAutoWatchWakeLimit: options.settings?.chatAutoWatchWakeLimit
      ?? CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT,
    chatParticipantRequestMaxDepth: options.settings?.chatParticipantRequestMaxDepth
      ?? CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
    chatParticipantRequestPromptMaxChars: options.settings?.chatParticipantRequestPromptMaxChars
      ?? CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT,
    chatPromptContext: options.settings?.chatPromptContext ?? DEFAULT_CHAT_PROMPT_CONTEXT,
    cloudRuns: {
      enabled: options.settings?.cloudRuns?.enabled ?? false,
      mode: options.settings?.cloudRuns?.mode ?? "ssh",
      worker: options.settings?.cloudRuns?.worker ?? {},
      hasAwsCredentials: options.settings?.cloudRuns?.hasAwsCredentials ?? false,
      awsInstanceType: options.settings?.cloudRuns?.awsInstanceType ?? "t3.small",
      awsRootVolumeSizeGb: options.settings?.cloudRuns?.awsRootVolumeSizeGb ?? 8,
      maxRuntimeMs: options.settings?.cloudRuns?.maxRuntimeMs ?? 24 * 60 * 60_000,
      pollIntervalMs: options.settings?.cloudRuns?.pollIntervalMs ?? 2_500,
      ...(options.settings?.cloudRuns?.awsHandle ? { awsHandle: options.settings.cloudRuns.awsHandle } : {})
    },
    mobileControl: options.settings?.mobileControl ?? EMPTY_MOBILE_CONTROL_SETTINGS,
    providers: clone(options.settings?.providers ?? [
      { kind: "codex-cli", label: "Codex CLI", enabled: true },
      { kind: "claude-code", label: "Claude Code", enabled: true }
    ]),
    chatRoleConfigs: clone(settingsState.chatRoleConfigs),
    chatBehaviorRules: clone(settingsState.chatBehaviorRules),
    chatSavedPrompts: [],
    chatParticipantConfigs: clone(settingsState.chatParticipantConfigs),
    chatParticipantSeedState: {},
    cliProviderHosts: [],
    assistantProviderKind,
    lastSuccessfulChatProviderKind: options.settings?.lastSuccessfulChatProviderKind,
    ...(options.settings?.newChatDefaults ? { newChatDefaults: options.settings.newChatDefaults } : {}),
    ...(options.settings?.legacyDefaultChatView ? { defaultChatView: options.settings.legacyDefaultChatView } : {})
  });
  const roleIdFromLabel = (label: string): string =>
    `custom-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "role"}-test`;
  const settings = {
    async getPublicSettings(): Promise<AppSettings> {
      return publicSettings();
    },
    async ensureAssistantProviderDefault(agents: AgentHealth[]): Promise<AppSettings> {
      assistantProviderKind = assistantProviderKind
        ?? options.settings?.lastSuccessfulChatProviderKind
        ?? preferredReadyAssistantProviderKind(agents, publicSettings().providers);
      return publicSettings();
    },
    async listMachines() {
      return clone(options.machines ?? []);
    },
    async listMachineInstalls() {
      return clone(options.machineInstalls ?? []);
    },
    async ensureGenericChatParticipantSeeds(): Promise<AppSettings> {
      return publicSettings();
    },
    async recordSuccessfulChatProvider(kind: ChatProviderKind): Promise<void> {
      settingsState.recordedSuccessfulProviders.push(kind);
    },
    async getChatParticipantRequestMaxDepth(): Promise<number> {
      return publicSettings().chatParticipantRequestMaxDepth;
    },
    async getChatParticipantRequestPromptMaxChars(): Promise<number> {
      return publicSettings().chatParticipantRequestPromptMaxChars;
    },
    async saveChatRoleConfig(update: ChatRoleConfigUpdate): Promise<AppSettings> {
      const existing = update.id ? settingsState.chatRoleConfigs.find((role) => role.id === update.id) : undefined;
      if (existing) {
        settingsState.chatRoleConfigs = settingsState.chatRoleConfigs.map((role) =>
          role.id === existing.id
            ? {
                ...role,
                label: update.label,
                instructions: update.instructions,
                appToolCapabilities: update.appToolCapabilities ?? role.appToolCapabilities,
                participantDefaults: update.participantDefaults ?? role.participantDefaults,
                version: role.version + 1,
                updatedAt: NOW
              }
            : role
        );
      } else {
        const id = roleIdFromLabel(update.label);
        settingsState.chatRoleConfigs.push({
          id,
          label: update.label,
          instructions: update.instructions,
          version: 1,
          builtIn: false,
          appToolCapabilities: update.appToolCapabilities,
          participantDefaults: update.participantDefaults,
          updatedAt: NOW
        });
      }
      return publicSettings();
    },
    async saveChatParticipantConfig(update: ChatParticipantConfigUpdate): Promise<AppSettings> {
      const next: ChatParticipantConfig = {
        id: update.id ?? `participant-${settingsState.chatParticipantConfigs.length + 1}`,
        handle: update.handle.replace(/^@/, ""),
        roleConfigId: update.roleConfigId,
        behaviorRuleIds: update.behaviorRuleIds ?? [],
        kind: update.kind,
        model: update.model,
        reasoningEffort: update.reasoningEffort,
        avatarId: update.avatarId,
        agentMode: update.agentMode,
        permissions: normalizeChatAgentPermissions(update.permissions),
        remoteExecution: update.remoteExecution,
        autoWatchEnabled: update.autoWatchEnabled,
        updatedAt: NOW
      };
      settingsState.chatParticipantConfigs = settingsState.chatParticipantConfigs.some((participant) => participant.id === next.id)
        ? settingsState.chatParticipantConfigs.map((participant) => participant.id === next.id ? next : participant)
        : [...settingsState.chatParticipantConfigs, next];
      return publicSettings();
    },
    async saveChatRoleParticipantConfigBatch(
      roleOperations: ChatRoleChangeOperation[],
      participantUpdates: ChatParticipantConfigUpdate[]
    ): Promise<{ settings: AppSettings; roleIdByDraftRoleRef: Record<string, string> }> {
      settingsState.batchWriteCount += 1;
      const roleIdByDraftRoleRef: Record<string, string> = {};
      for (const operation of roleOperations) {
        if (operation.type === "create_role") {
          const id = roleIdFromLabel(operation.role.label);
          if (operation.role.draftRoleRef) {
            roleIdByDraftRoleRef[operation.role.draftRoleRef] = id;
          }
          settingsState.chatRoleConfigs.push({
            id,
            label: operation.role.label,
            instructions: operation.role.instructions,
            version: 1,
            builtIn: false,
            appToolCapabilities: operation.role.appToolCapabilities,
            participantDefaults: operation.role.participantDefaults,
            updatedAt: NOW
          });
        } else if (operation.type === "edit_role") {
          settingsState.chatRoleConfigs = settingsState.chatRoleConfigs.map((role) =>
            role.id === operation.role.roleConfigId
              ? {
                  ...role,
                  label: operation.role.label,
                  instructions: operation.role.instructions,
                  appToolCapabilities: operation.role.appToolCapabilities ?? role.appToolCapabilities,
                  participantDefaults: operation.role.participantDefaults ?? role.participantDefaults,
                  version: role.version + 1,
                  updatedAt: NOW
                }
              : role
          );
        }
      }
      for (const update of participantUpdates) {
        await settings.saveChatParticipantConfig({
          ...update,
          roleConfigId: roleIdByDraftRoleRef[update.roleConfigId] ?? update.roleConfigId
        });
      }
      return { settings: publicSettings(), roleIdByDraftRoleRef };
    }
  };
  const cliRunner = {
    async detectAgents(): Promise<AgentHealth[]> {
      return clone(options.agents ?? []);
    },
    run: options.run ?? (async (participant: ParticipantConfig) => ({
      participant,
      ok: true,
      content: "ok",
      durationMs: 1
    }))
  };
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const debugLogs = {
    async write(event: string, payload: Record<string, unknown>): Promise<void> {
      debugEvents.push({ event, payload });
    }
  };
  return {
    service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never, options.appMcp as never, options.onSnapshot, options.userSkills as never),
    storage,
    settingsState,
    tempRoot,
    debugEvents
  };
}

export function chatParticipant(
  kind: ChatParticipant["kind"],
  permissionPatch: Partial<ReturnType<typeof defaultChatAgentPermissions>> = {}
): ChatParticipant {
  const permissions = normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    ...permissionPatch,
    shell: {
      ...defaultChatAgentPermissions().shell,
      ...permissionPatch.shell
    }
  });
  const identity = kind === "claude-code"
    ? { id: "claude-participant", handle: "drew" }
    : kind === "gemini-cli"
      ? { id: "gemini-participant", handle: "gemini" }
      : { id: "codex-participant", handle: "codex" };
  return {
    id: identity.id,
    handle: identity.handle,
    roleConfigId: ROLE.id,
    kind,
    agentMode: "default",
    permissions
  };
}

export function chatConversation(participants: ChatParticipant[], metadata: Record<string, any> = {}): Conversation {
  return {
    id: "conversation-1",
    title: "Test chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{
      id: "user-message",
      role: "user",
      content: "Please help.",
      createdAt: NOW,
      status: "done"
    }],
    findings: [],
    metadata: {
      participants,
      ...metadata
    }
  };
}

export function timelineMessage(
  id: string,
  content: string,
  patch: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    role: patch.role ?? "user",
    participantId: patch.participantId,
    participantLabel: patch.participantLabel,
    content,
    createdAt: patch.createdAt ?? NOW,
    status: patch.status ?? "done",
    metadata: patch.metadata
  };
}

export function participantReplyMessage(participant: ChatParticipant, id: string, content: string): ChatMessage {
  return timelineMessage(id, content, {
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    metadata: { threadId: "user-message" }
  });
}

export function inferredRequestMessages(conversation: Conversation): ChatMessage[] {
  return conversation.messages.filter((message) => message.metadata?.participantRequest?.source === "inferred");
}

export function completeParticipantRequest(message: ChatMessage): void {
  const batch = message.metadata?.participantRequest;
  assert.ok(batch);
  batch.status = "completed";
  batch.items = batch.items.map((item) => ({ ...item, status: "completed" }));
}

export function installedChatAgents(): AgentHealth[] {
  return [
    { kind: "codex-cli", label: "Codex CLI", installed: true },
    { kind: "claude-code", label: "Claude Code", installed: true }
  ];
}

export function permissionApproval(
  participant: ChatParticipant,
  request: ChatAppToolApproval["request"],
  patch: Partial<ChatAppToolApproval> = {}
): ChatAppToolApproval {
  return {
    id: patch.id ?? "approval-1",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: participant.roleConfigId,
    toolName: APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
    capability: "permissions.request",
    status: "pending",
    request,
    summary: "Grant permission",
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  };
}

export function participantRequestActor(participant: ChatParticipant): any {
  return {
    conversationId: "conversation-1",
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: ["participants.request"],
    triggerMessageId: "user-message",
    triggerThreadId: "user-message",
    snapshotMaxSequence: 0,
    continuation: false,
    participantRequestDepth: 0
  };
}

export function participantRequestApproval(
  participant: ChatParticipant,
  requests: Array<{ target: string; prompt: string; reason?: string }>,
  patch: Partial<ChatAppToolApproval> & { requestMessageId?: string; batchId?: string } = {}
): ChatAppToolApproval {
  const { requestMessageId, batchId, ...approvalPatch } = patch;
  return {
    id: approvalPatch.id ?? "participant-request-approval-1",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: participant.roleConfigId,
    toolName: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
    capability: "participants.request",
    status: "pending",
    request: {
      requests,
      resumeRequester: true,
      source: "mcp",
      requestMessageId,
      batchId
    },
    summary: "Request participant input",
    createdAt: NOW,
    updatedAt: NOW,
    ...approvalPatch
  };
}

export function participantManagerActor(conversationId: string, participant: ChatParticipant): {
  conversationId: string;
  participantId: string;
  roleConfigId: string;
  roleConfigVersion: number;
  capabilities: ["participants.manage"];
} {
  return {
    conversationId,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: ["participants.manage"]
  };
}

/** The User's server as a chat sees it, played by the test: what the chat
 *  writes is recorded, and each operation is accepted at once (a turn asked
 *  is requested, a claim is this device's). What other devices do there
 *  reaches the chat as feed entries (`fromServer`). */
export function fakeServerLink(deviceId = "desktop-device", machineNames: Record<string, string> = { "machine-1": "Cloud machine", machine: "Cloud machine" }) {
  const ops: HubOp[] = [];
  let seq = 1_000;
  const turnOf = (op: HubOp, state: HubTurn["state"]): HubTurn | undefined => op.kind === "turn.request" || op.kind === "turn.claim"
    ? { runId: op.runId, conversationId: op.conversationId, messageId: op.messageId, participantId: op.participantId, state,
      ...(state === "requested" ? { requestedBy: deviceId } : { executorDeviceId: deviceId }),
      ...(op.kind === "turn.request" && op.pendingMessageId ? { pendingMessageId: op.pendingMessageId } : {}),
      ...(op.kind === "turn.request" && op.request ? { request: op.request } : {}) }
    : undefined;
  const link = {
    ops,
    deviceId: () => deviceId,
    queueSql: (queued: HubOp[]) => { ops.push(...queued); return ""; },
    enqueue: async (queued: HubOp[]) => { ops.push(...queued); },
    nudge: () => undefined,
    messageAccepted: async () => ({ status: "accepted" as const, seq: ++seq }),
    opAnswered: async (opId: string) => {
      const op = ops.find((item) => item.opId === opId);
      if (op?.kind === "turn.request") return { status: "accepted" as const, seq: ++seq, turn: turnOf(op, "requested") };
      if (op?.kind === "turn.claim") return { status: "accepted" as const, seq: ++seq, claim: "claimed" as const, turn: turnOf(op, "claimed") };
      return { status: "accepted" as const, seq: ++seq };
    },
    waitingTurns: async () => ({ requested: [] as HubTurn[], claimed: [] as HubTurn[] }),
    machineName: (machineId: string) => machineNames[machineId]
  };
  return link;
}

let feedSeq = 0;

/** What another device did on the server, as this device's feed brings it. */
export function fromServer(conversationId: string, deviceId: string, effect: HubOpEffect): HubFeedEntry {
  feedSeq += 1;
  return { seq: 10_000 + feedSeq, opId: `feed-${feedSeq}`, deviceId, conversationId, acceptedAt: new Date().toISOString(), effect };
}

/** A member's device takes a turn asked on the server, writes its reply and
 *  ends the turn there, as the feed brings it to this device. */
export async function memberDeviceAnswers(service: ChatService, request: Extract<HubOp, { kind: "turn.request" }>, options: {
  deviceId?: string; content?: string; participant: ChatParticipant; contextUsage?: Record<string, unknown>; replyId?: string;
  /** More on the reply, as the member's device writes it. */
  metadata?: ChatMessage["metadata"];
}): Promise<ChatMessage> {
  const deviceId = options.deviceId ?? "machine-device";
  const base: HubTurn = { runId: request.runId, conversationId: request.conversationId, messageId: request.messageId, participantId: request.participantId,
    state: "claimed", executorDeviceId: deviceId, ...(request.pendingMessageId ? { pendingMessageId: request.pendingMessageId } : {}) };
  const reply: ChatMessage = {
    ...pendingParticipantMessage(options.participant, options.replyId ?? request.pendingMessageId ?? `reply-${request.runId}`, request.runId),
    status: "done", content: options.content ?? "MACHINE_REPLY",
    metadata: { runId: request.runId, sourceMessageId: request.messageId, parentMessageId: request.messageId, serverSeq: 20_000 + feedSeq, serverWriter: deviceId, ...options.metadata }
  };
  await service.applyServerEntries([fromServer(request.conversationId, deviceId, { kind: "turn.claim", turn: base })]);
  await service.applyServerEntries([fromServer(request.conversationId, deviceId, { kind: "message.create", message: reply })]);
  await service.applyServerEntries([fromServer(request.conversationId, deviceId, { kind: "turn.finish",
    turn: { ...base, state: "finished", outcome: "done", ...(options.contextUsage ? { contextUsage: options.contextUsage } : {}) } })]);
  return reply;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}

export async function flushMicrotasks(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

export function skillMention(kind: ChatParticipant["kind"]): unknown {
  return {
    skillId: "skill-1",
    displayName: "/accord",
    frontmatterName: "accord",
    description: "Accord",
    contentHash: "hash",
    capabilityState: "invocable",
    variants: [{
      providerKind: kind,
      scope: "personal",
      rootKind: "personal",
      sourceKey: "src",
      frontmatterName: "accord",
      contentHash: "hash",
      capabilityState: "invocable"
    }]
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
