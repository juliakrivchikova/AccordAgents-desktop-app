import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type {
  AgentContextUsage,
  AgentHealth,
  AddChatParticipantRequest,
  ChatAgentMode,
  ChatAgentPermissions,
  ChatAppToolApproval,
  ChatAppToolApprovalPolicy,
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatAppToolCapability,
  ChatChoiceOption,
  ChatImageAttachment,
  ChatImageInput,
  ChatImageMimeType,
  ChatMessage,
  ChatParticipant,
  ChatParticipantRequestApprovalRequest,
  ChatParticipantRequestBatch,
  ChatParticipantRequestInput,
  ChatParticipantRequestItem,
  ChatParticipantRequestStatus,
  ChatParticipantSession,
  ChatPermissionChangeRequest,
  ChatPermissionGrant,
  ChatPendingChoice,
  ChatPendingMention,
  ChatProviderKind,
  ChatRosterAvailableOptions,
  ChatRosterAvailableProvider,
  ChatRosterCurrentParticipant,
  ChatRoleRuntime,
  ChatRoleConfig,
  ChatRosterChangeRequest,
  ChatShellPermissionRule,
  Conversation,
  CreateChatConversationRequest,
  ParticipantConfig,
  ReadChatAttachmentRequest,
  RenameChatConversationRequest,
  RespondToChatAppToolApprovalRequest,
  RespondToChatChoiceRequest,
  RespondToChatMentionsRequest,
  ReviewProgress,
  RepoFileMention,
  SendChatMessageRequest,
  StartReviewResult
} from "../../shared/types";
import {
  CHAT_PROVIDER_NATIVE_ALLOWED_TOOL_MAX_LENGTH,
  CHAT_SHELL_RULE_PATTERN_MAX_LENGTH,
  effectiveChatAgentPermissions,
  isChatShellPermissionPatternSafe,
  normalizeChatAgentMode,
  normalizeChatAgentPermissions
} from "../../shared/agentPermissions";
import { normalizeAgentContextUsage } from "../../shared/agentContext";
import {
  chatAppToolCapabilitiesEqual,
  hasChatAppToolCapability,
  normalizeChatAppToolCapabilities
} from "../../shared/appTools";
import { chatPermissionPromptLines } from "../../shared/permissionPrompt";
import { CliAgentRunner } from "./cliAgents";
import type { CliAgentOutputEvent, CliAgentRoleOptions } from "./cliAgents";
import {
  APP_CHAT_GET_CONTEXT_TOOL,
  APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL,
  APP_CHAT_GET_PARTICIPANTS_TOOL,
  APP_CHAT_LIST_ATTACHMENTS_TOOL,
  APP_CHAT_READ_ATTACHMENT_TOOL,
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
  APP_CHAT_READ_MESSAGES_TOOL,
  APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
  APP_ROSTER_DESCRIBE_OPTIONS_TOOL,
  APP_ROSTER_REQUEST_CHANGE_TOOL
} from "./appMcp";
import { DebugLogService } from "./debugLogs";
import type { ParticipantRunResult } from "./providers";
import { SettingsService } from "./settings";
import { StorageService } from "./storage";
import { clearChatRunMetadata } from "../../shared/chatRunState";
import { INTERRUPTED_RUN_WARNING, sanitizeWarningList } from "../../shared/warnings";

type ProgressCallback = (progress: ReviewProgress) => void;

interface ChatParticipantSessionState {
  session: ChatParticipantSession;
  instructionsRefreshed: boolean;
}

interface ChatPromptSectionSizes {
  staticEnvelope: number;
  dynamicHeader: number;
  trigger: number;
  mentions: number;
  attachments: number;
  currentRequest: number;
  total: number;
}

interface PreparedImageAttachments {
  attachments: ChatImageAttachment[];
  writtenPaths: string[];
}

interface ChatAttachmentRecord {
  message: ChatMessage;
  sequence: number;
  attachment: ChatImageAttachment;
}

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const CHAT_ROLE_RUNTIME_CONFIG_VERSION = 13;
const CHAT_WARM_AGENT_IDLE_TIMEOUT_MS = 10 * 60_000;
const CHAT_CUSTOM_CHOICE_OPTION_ID = "__custom__";
const CHAT_ADMINISTRATOR_ROLE_ID = "administrator";
const CHAT_ADMINISTRATOR_HANDLE = "admin";
const CHAT_ROSTER_CHANGE_MAX_OPERATIONS = 12;
const CHAT_PARTICIPANT_REQUEST_MAX_ITEMS = 4;
const CHAT_PARTICIPANT_REQUEST_MAX_DEPTH = 2;
const CHAT_PARTICIPANT_REQUEST_MAX_BATCHES_PER_TURN = 4;
const CHAT_PARTICIPANT_REQUEST_RATE_WINDOW_MS = 60_000;
const CHAT_PARTICIPANT_REQUEST_RATE_LIMIT = 8;
const CHAT_PARTICIPANT_REQUEST_WAIT_DEFAULT_MS = 120_000;
const CHAT_PARTICIPANT_REQUEST_WAIT_MAX_MS = 300_000;
const PARTICIPANT_REQUEST_SCRUTINY_APPENDIX =
  "Review for blockers, incorrect assumptions, missing edge cases, or simpler alternatives. If none, reply with only `No objections.` Do not restate the proposal.";
const CHAT_CONTEXT_MCP_TOOL_NAMES = [
  APP_CHAT_GET_CONTEXT_TOOL,
  APP_CHAT_GET_PARTICIPANTS_TOOL,
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
  APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL,
  APP_CHAT_READ_MESSAGES_TOOL,
  APP_CHAT_LIST_ATTACHMENTS_TOOL,
  APP_CHAT_READ_ATTACHMENT_TOOL
];
const CHAT_APP_MCP_TOOL_NAMES = [
  ...CHAT_CONTEXT_MCP_TOOL_NAMES,
  APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
  APP_ROSTER_DESCRIBE_OPTIONS_TOOL,
  APP_ROSTER_REQUEST_CHANGE_TOOL
];
const CHAT_CONTEXT_READ_DEFAULT_LIMIT = 50;
const CHAT_CONTEXT_READ_MAX_LIMIT = 200;
const CHAT_IMAGE_MAX_ATTACHMENTS = 5;
const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_IMAGE_MAX_DIMENSION = 8192;
const CHAT_IMAGE_MAX_PIXELS = 25_000_000;
const CHAT_IMAGE_MIME_TYPES: ChatImageMimeType[] = ["image/png", "image/jpeg", "image/webp"];
const CHAT_IMAGE_EXTENSION_BY_MIME: Record<ChatImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

interface ChatAppMcpGateway {
  issueToken(grant: {
    conversationId: string;
    participantId: string;
    roleConfigId: string;
    roleConfigVersion: number;
    capabilities: ChatAppToolCapability[];
    triggerMessageId?: string;
    triggerThreadId?: string;
    triggerParentMessageId?: string;
    triggerChatThreadRootId?: string;
    snapshotMaxSequence?: number;
    continuation?: boolean;
    runId?: string;
    participantRequestDepth?: number;
    participantRequestBatchId?: string;
    historyMarkdownPath?: string;
    historyJsonPath?: string;
  }): { url: string; token: string } | undefined;
  updateToken?(token: string, grant: ChatAppMcpTokenGrant): { url: string; token: string } | undefined;
}

type ChatAppMcpTokenGrant = Parameters<ChatAppMcpGateway["issueToken"]>[0];

interface ChatAppMcpActor {
  conversationId: string;
  participantId: string;
  roleConfigId: string;
  roleConfigVersion: number;
  capabilities: ChatAppToolCapability[];
  triggerMessageId?: string;
  triggerThreadId?: string;
  triggerParentMessageId?: string;
  triggerChatThreadRootId?: string;
  snapshotMaxSequence?: number;
  continuation?: boolean;
  runId?: string;
  participantRequestDepth?: number;
  participantRequestBatchId?: string;
  historyMarkdownPath?: string;
  historyJsonPath?: string;
}

interface ChatChoiceDraft {
  title?: string;
  question?: string;
  recommendedOptionId?: string;
  options: ChatChoiceOption[];
}

interface PreparedRosterChange {
  request: ChatRosterChangeRequest;
  participants: ChatParticipant[];
  summary: string;
}

interface PreparedPermissionChange {
  request: ChatPermissionChangeRequest;
  portablePermissions: ChatPermissionGrant[];
  shellRules: ChatShellPermissionRule[];
  providerNativeAllowedTools: string[];
  summary: string;
}

interface PreparedParticipantRequest {
  request: ChatParticipantRequestApprovalRequest;
  requester: ChatParticipant;
  targets: ChatParticipant[];
  batch: ChatParticipantRequestBatch;
  requestMessage: ChatMessage;
  summary: string;
  timeoutMs: number;
}

interface ParticipantRequestRunResult {
  batch: ChatParticipantRequestBatch;
  replies: Array<{
    targetHandle: string;
    messageId?: string;
    content?: string;
    error?: string;
  }>;
}

export class ChatService {
  private readonly saveQueues = new Map<string, Promise<void>>();
  private readonly runQueues = new Map<string, Promise<void>>();
  private readonly activeRunIds = new Set<string>();
  private readonly activeConversationRunIds = new Map<string, Set<string>>();
  private readonly backgroundRunnerCounts = new Map<string, number>();
  private readonly appMcpTokens = new Map<string, string>();
  private readonly participantRequestRunners = new Map<string, Promise<ParticipantRequestRunResult>>();
  private readonly participantRequestAutoResumes = new Set<string>();
  private readonly permissionApprovalAutoResumes = new Set<string>();
  private readonly participantTurnQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly cliRunner: CliAgentRunner,
    private readonly debugLogs: DebugLogService,
    private readonly appMcp?: ChatAppMcpGateway,
    private readonly onConversationSnapshot?: (conversation: Conversation) => void
  ) {}

  async hydrateContextUsage(conversation: Conversation): Promise<Conversation> {
    if (conversation.kind !== "chat") {
      return conversation;
    }
    const recoveredRunState = this.recoverStaleChatRun(conversation);
    let interruptedRequests = false;
    for (const message of conversation.messages) {
      if (this.markOrphanedParticipantRequestInterrupted(message)) {
        interruptedRequests = true;
      }
    }
    const participants = new Map(this.chatParticipants(conversation).map((participant) => [participant.id, participant]));
    const existingUsage = this.agentContextUsageByParticipant(conversation);
    let nextUsage: Record<string, AgentContextUsage> | undefined;
    for (const session of this.chatSessions(conversation)) {
      if (!session.sessionId || existingUsage[session.participantId]) {
        continue;
      }
      const participant = participants.get(session.participantId);
      if (!participant) {
        continue;
      }
      const usage = await this.cliRunner.contextUsageForSession(
        this.cliParticipantForSession(participant, session),
        session.sessionId
      );
      if (!usage) {
        continue;
      }
      nextUsage = {
        ...(nextUsage ?? existingUsage),
        [participant.id]: usage
      };
    }
    if (!nextUsage && !interruptedRequests && !recoveredRunState) {
      return conversation;
    }
    const hydrated = {
      ...conversation,
      metadata: {
        ...conversation.metadata,
        ...(nextUsage ? { agentContextUsageByParticipant: nextUsage } : {})
      }
    };
    if (interruptedRequests || recoveredRunState) {
      hydrated.updatedAt = new Date().toISOString();
      await this.saveConversation(hydrated);
    }
    return hydrated;
  }

  async createConversation(request: CreateChatConversationRequest): Promise<StartReviewResult> {
    const now = new Date().toISOString();
    const requestedParticipants = await this.validateParticipants(request.participants, [], true);
    const participants = await this.ensureAdministratorParticipant(requestedParticipants);
    const conversation: Conversation = {
      id: randomUUID(),
      title: this.normalizeChatTitle(request.title ?? ""),
      kind: "chat",
      createdAt: now,
      updatedAt: now,
      repoPath: request.repoPath?.trim() || undefined,
      messages: [
        this.message("system", this.chatIntro(participants), undefined, {
          threadId: "system"
        })
      ],
      findings: [],
      metadata: {
        participants,
        participantSessions: [],
        warnings: [],
        running: false
      }
    };
    await this.saveConversation(conversation);
    return { conversation, warnings: [] };
  }

  async renameConversation(request: RenameChatConversationRequest): Promise<Conversation | undefined> {
    return this.withChatRunLock(request.conversationId, async () => {
      await this.waitForQueuedSave(request.conversationId);
      const conversation = await this.storage.getConversation(request.conversationId);
      if (!conversation) {
        return undefined;
      }
      if (conversation.kind !== "chat") {
        throw new Error("Only chat conversations can be renamed.");
      }
      if (conversation.metadata.running === true || this.chatHasLiveWork(conversation.id)) {
        throw new Error("Chat name cannot be edited while participants are running.");
      }
      const title = this.normalizeChatTitle(request.title);
      if (title === conversation.title) {
        return conversation;
      }
      conversation.title = title;
      conversation.updatedAt = new Date().toISOString();
      await this.saveConversation(conversation);
      await this.ensureHistoryFiles(conversation);
      return conversation;
    }, {
      rejectIfQueued: true,
      queuedMessage: "Chat name cannot be edited while participants are running."
    });
  }

  async addParticipant(request: AddChatParticipantRequest): Promise<Conversation | undefined> {
    const conversation = await this.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return conversation;
    }
    const participants = this.chatParticipants(conversation);
    const nextParticipant = (await this.validateParticipants([request.participant], participants))[0];
    conversation.metadata = {
      ...conversation.metadata,
      participants: [...participants, nextParticipant]
    };
    conversation.updatedAt = new Date().toISOString();
    conversation.messages.push(
      this.message("system", `Added @${nextParticipant.handle} to the chat.`, undefined, {
        threadId: "system"
      })
    );
    await this.saveConversation(conversation);
    return conversation;
  }

  async requestRosterChangeFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.waitForQueuedSave(actor.conversationId);
    const conversation = await this.requireChat(actor.conversationId);
    const requester = this.chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }
    if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
      throw new Error("The issued app-tool token does not grant participant management.");
    }

    const prepared = await this.prepareRosterChange(conversation, this.normalizeRosterChangeRequest(rawRequest));
    const policy = this.matchingAppToolApprovalPolicy(conversation, requester, APP_ROSTER_REQUEST_CHANGE_TOOL, "participants.manage");
    if (policy) {
      const approval = this.newAppToolApproval(
        conversation,
        requester,
        APP_ROSTER_REQUEST_CHANGE_TOOL,
        "participants.manage",
        prepared.request,
        prepared.summary,
        "auto-applied"
      );
      const applied = this.applyPreparedRosterChange(conversation, prepared);
      approval.appliedParticipantIds = applied.map((participant) => participant.id);
      approval.updatedAt = new Date().toISOString();
      this.upsertAppToolApproval(conversation, approval);
      conversation.messages.push(this.message("system", `Auto-applied app tool request from @${requester.handle}: ${prepared.summary}.`, undefined, {
        threadId: "system"
      }));
      conversation.updatedAt = new Date().toISOString();
      await this.saveConversation(conversation);
      this.queueSnapshot(conversation);
      return {
        ok: true,
        status: "auto_applied",
        approvalId: approval.id,
        summary: prepared.summary,
        addedParticipants: applied.map((participant) => `@${participant.handle}`)
      };
    }

    const approval = this.newAppToolApproval(
      conversation,
      requester,
      APP_ROSTER_REQUEST_CHANGE_TOOL,
      "participants.manage",
      prepared.request,
      prepared.summary,
      "pending"
    );
    this.upsertAppToolApproval(conversation, approval);
    conversation.messages.push(this.message("system", `App tool approval needed from @${requester.handle}: ${prepared.summary}.`, undefined, {
      threadId: "system"
    }));
    conversation.updatedAt = new Date().toISOString();
    await this.saveConversation(conversation);
    this.queueSnapshot(conversation);
    return {
      ok: true,
      status: "pending_user_approval",
      approvalId: approval.id,
      summary: prepared.summary
    };
  }

  async requestPermissionChangeFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.waitForQueuedSave(actor.conversationId);
    const conversation = await this.requireChat(actor.conversationId);
    const requester = this.chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }
    if (!hasChatAppToolCapability(actor.capabilities, "permissions.request")) {
      throw new Error("The issued app-tool token does not grant permission requests.");
    }

    const prepared = this.preparePermissionChange(requester, this.normalizePermissionChangeRequest(rawRequest));
    if (!this.preparedPermissionChangeHasAdditions(prepared)) {
      return {
        ok: true,
        status: "already_granted",
        summary: prepared.summary
      };
    }

    const approval = this.newAppToolApproval(
      conversation,
      requester,
      APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
      "permissions.request",
      prepared.request,
      prepared.summary,
      "pending"
    );
    if (actor.runId && actor.triggerMessageId) {
      approval.resumeContext = {
        runId: actor.runId,
        triggerMessageId: actor.triggerMessageId,
        participantRequestBatchId: actor.participantRequestBatchId
      };
    }
    this.upsertAppToolApproval(conversation, approval);
    conversation.messages.push(this.message("system", `Permission approval needed for @${requester.handle}: ${prepared.summary}.`, undefined, {
      threadId: "system"
    }));
    conversation.updatedAt = new Date().toISOString();
    await this.saveConversation(conversation);
    this.queueSnapshot(conversation);
    return {
      ok: true,
      status: "pending_user_approval",
      approvalId: approval.id,
      summary: prepared.summary
    };
  }

  async requestParticipantsFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.waitForQueuedSave(actor.conversationId);
    const conversation = await this.requireChat(actor.conversationId);
    const requester = this.chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }

    let prepared: PreparedParticipantRequest;
    try {
      prepared = this.prepareParticipantRequest(conversation, requester, this.normalizeParticipantRequest(rawRequest), actor, "mcp");
    } catch (error) {
      return this.participantRequestFailedToolResult(error instanceof Error ? error.message : String(error));
    }
    conversation.messages.push(prepared.requestMessage);
    const pendingTargets = prepared.batch.items.filter((item) => item.status === "pending_approval");
    if (pendingTargets.length > 0) {
      const approval = this.newAppToolApproval(
        conversation,
        requester,
        APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
        "participants.request",
        {
          ...prepared.request,
          requests: prepared.request.requests.filter((request) =>
            pendingTargets.some((item) => item.targetHandle.toLowerCase() === request.target.replace(/^@/, "").toLowerCase())
          ),
          requestMessageId: prepared.requestMessage.id,
          batchId: prepared.batch.id
        },
        this.participantRequestSummary(requester.handle, pendingTargets.map((item) => item.targetHandle)),
        "pending"
      );
      this.upsertAppToolApproval(conversation, approval);
    }
    conversation.updatedAt = new Date().toISOString();
    await this.saveConversation(conversation);

    const hasRunningTargets = prepared.batch.items.some((item) => item.status === "running");
    if (!hasRunningTargets) {
      return this.participantRequestToolResult(conversation, prepared.requestMessage.id, {
        status: "pending_approval",
        approvalRequired: true
      });
    }

    const runner = this.startParticipantRequestRunner(conversation.id, prepared.requestMessage.id, actor.runId ?? randomUUID(), prepared.batch.depth);
    const result = await this.awaitParticipantRequestRunner(runner, prepared.timeoutMs);
    if (result.timedOut) {
      void runner.then(() => this.autoResumeParticipantRequest(conversation.id, prepared.requestMessage.id)).catch((error) => {
        void this.debugLogs.write("chat.participant-request.auto-resume.error", {
          conversationId: conversation.id,
          requestMessageId: prepared.requestMessage.id,
          message: error instanceof Error ? error.message : String(error)
        });
      });
      const latest = await this.requireChat(conversation.id);
      return this.participantRequestToolResult(latest, prepared.requestMessage.id, { status: "running" });
    }

    const latest = await this.requireChat(conversation.id);
    const latestBatch = latest.messages.find((message) => message.id === prepared.requestMessage.id)?.metadata?.participantRequest;
    const hasUnfinishedItems = latestBatch?.items.some((item) => item.status === "pending_approval" || item.status === "running" || item.status === "resuming_requester");
    if (!hasUnfinishedItems) {
      this.updateParticipantRequestBatch(latest, prepared.requestMessage.id, (batch) => ({
        ...batch,
        completedInToolCall: true,
        status: "completed",
        updatedAt: new Date().toISOString()
      }));
    }
    await this.saveConversation(latest);
    return this.participantRequestToolResult(latest, prepared.requestMessage.id, { status: hasUnfinishedItems ? "pending_approval" : "completed" });
  }

  async participantRequestStatusForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.waitForQueuedSave(actor.conversationId);
    const conversation = await this.requireChat(actor.conversationId);
    const requester = this.chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }
    const record = rawRequest && typeof rawRequest === "object" && !Array.isArray(rawRequest)
      ? rawRequest as { requestId?: unknown }
      : {};
    const requestId = typeof record.requestId === "string" ? record.requestId.trim() : "";
    let changed = false;
    for (const message of conversation.messages) {
      const batch = message.metadata?.participantRequest;
      if (!batch || (requestId && batch.id !== requestId)) {
        continue;
      }
      if (this.markOrphanedParticipantRequestInterrupted(message)) {
        changed = true;
      }
    }
    if (changed) {
      conversation.updatedAt = new Date().toISOString();
      await this.saveConversation(conversation);
    }
    const batches = conversation.messages
      .map((message) => message.metadata?.participantRequest)
      .filter((batch): batch is ChatParticipantRequestBatch => Boolean(batch))
      .filter((batch) => requestId ? batch.id === requestId : batch.requesterParticipantId === requester.id)
      .slice(-10)
      .reverse();
    return {
      ok: true,
      requests: batches.map((batch) => this.participantRequestBatchForTool(conversation, batch))
    };
  }

  async describeRosterOptionsForTool(actor: ChatAppMcpActor): Promise<ChatRosterAvailableOptions> {
    await this.waitForQueuedSave(actor.conversationId);
    const conversation = await this.requireChat(actor.conversationId);
    const participants = this.chatParticipants(conversation);
    const requester = participants.find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }
    if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
      throw new Error("The issued app-tool token does not grant participant management.");
    }

    const settings = await this.settings.getPublicSettings();
    const agents = await this.cliRunner.detectAgents().catch((): AgentHealth[] => []);
    const defaultKind = this.preferredChatProviderKind(settings.providers, agents);
    const providers: ChatRosterAvailableProvider[] = (["codex-cli", "claude-code"] as ChatProviderKind[]).map((kind) => {
      const provider = settings.providers.find((item) => item.kind === kind);
      const health = agents.find((item) => item.kind === kind);
      return {
        kind,
        label: provider?.label ?? health?.label ?? (kind === "codex-cli" ? "Codex CLI" : "Claude Code"),
        enabled: Boolean(provider?.enabled),
        installed: Boolean(health?.installed),
        selectedByDefault: kind === defaultKind,
        configuredModel: provider?.model?.trim() || undefined,
        version: health?.version,
        error: health?.error
      };
    });

    return {
      conversationId: conversation.id,
      requester: {
        ...this.rosterParticipantSummary(conversation, requester),
        appToolCapabilities: normalizeChatAppToolCapabilities(actor.capabilities)
      },
      currentParticipants: participants.map((participant) => this.rosterParticipantSummary(conversation, participant)),
      roles: settings.chatRoleConfigs.map((role) => ({
        id: role.id,
        label: role.label,
        version: role.version,
        builtIn: Boolean(role.builtIn),
        appToolCapabilities: normalizeChatAppToolCapabilities(role.appToolCapabilities)
      })),
      providers,
      agentModes: ["default", "plan", "auto"],
      defaults: {
        kind: defaultKind,
        agentMode: "default",
        permissions: normalizeChatAgentPermissions(undefined)
      },
      handleRules: {
        pattern: HANDLE_PATTERN.source,
        maxLength: 32,
        duplicatePolicy: "Handles must be unique within this chat; omit the leading @."
      },
      rosterChange: {
        supportedOperations: ["add"],
        maxOperations: CHAT_ROSTER_CHANGE_MAX_OPERATIONS,
        modelPolicy: "The model field is optional. Omit it to use the CLI/provider default, or use a provider's configuredModel when one is present."
      }
    };
  }

  async describeChatContextForTool(actor: ChatAppMcpActor): Promise<Record<string, unknown>> {
    await this.waitForQueuedSave(actor.conversationId);
    const conversation = await this.requireChat(actor.conversationId);
    const participants = this.chatParticipants(conversation);
    const requester = participants.find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }
    const triggerSequence = actor.triggerMessageId
      ? conversation.messages.findIndex((message) => message.id === actor.triggerMessageId)
      : -1;
    const triggerMessage = triggerSequence >= 0 ? conversation.messages[triggerSequence] : undefined;
    const historyFiles = this.historyFilePaths(conversation.id, actor);

    return {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        kind: conversation.kind,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        repoPath: conversation.repoPath
      },
      requester: {
        ...this.rosterParticipantSummary(conversation, requester),
        appToolCapabilities: normalizeChatAppToolCapabilities(actor.capabilities)
      },
      activeTurn: {
        triggerMessageId: actor.triggerMessageId,
        triggerThreadId: actor.triggerThreadId,
        triggerParentMessageId: actor.triggerParentMessageId,
        triggerChatThreadRootId: actor.triggerChatThreadRootId,
        snapshotMaxSequence: actor.snapshotMaxSequence,
        continuation: Boolean(actor.continuation),
        triggerMessage: triggerMessage ? this.chatMessageForTool(triggerMessage, triggerSequence) : undefined
      },
      contextSources: {
        preferredMessageTool: APP_CHAT_READ_MESSAGES_TOOL,
        preferredAttachmentListTool: APP_CHAT_LIST_ATTACHMENTS_TOOL,
        preferredAttachmentReadTool: APP_CHAT_READ_ATTACHMENT_TOOL,
        preferredParticipantTool: APP_CHAT_GET_PARTICIPANTS_TOOL,
        currentContextTool: APP_CHAT_GET_CONTEXT_TOOL,
        fallbackHistoryFiles: {
          markdownPath: historyFiles.markdownPath,
          jsonPath: historyFiles.jsonPath,
          purpose: "Temporary fallback and debugging artifact. Prefer MCP tools for dynamic context."
        }
      },
      messageReadDefaults: {
        defaultLimit: CHAT_CONTEXT_READ_DEFAULT_LIMIT,
        maxLimit: CHAT_CONTEXT_READ_MAX_LIMIT
      },
      availableAppMcpTools: this.appMcpToolNames(actor.capabilities)
    };
  }

  async describeChatParticipantsForTool(actor: ChatAppMcpActor): Promise<Record<string, unknown>> {
    await this.waitForQueuedSave(actor.conversationId);
    const conversation = await this.requireChat(actor.conversationId);
    const participants = this.chatParticipants(conversation);
    const requester = participants.find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }

    const settings = await this.settings.getPublicSettings();
    const agents = await this.cliRunner.detectAgents().catch((): AgentHealth[] => []);
    const providers = (["codex-cli", "claude-code"] as ChatProviderKind[]).map((kind) => {
      const provider = settings.providers.find((item) => item.kind === kind);
      const health = agents.find((item) => item.kind === kind);
      return {
        kind,
        label: provider?.label ?? health?.label ?? (kind === "codex-cli" ? "Codex CLI" : "Claude Code"),
        enabled: Boolean(provider?.enabled),
        installed: Boolean(health?.installed),
        configuredModel: provider?.model?.trim() || undefined,
        version: health?.version,
        error: health?.error
      };
    });
    const providerByKind = new Map(providers.map((provider) => [provider.kind, provider]));
    const roleById = new Map(settings.chatRoleConfigs.map((role) => [role.id, role]));

    return {
      conversationId: conversation.id,
      requesterParticipantId: requester.id,
      participants: participants.map((participant) => {
        const role = roleById.get(participant.roleConfigId);
        const provider = providerByKind.get(participant.kind);
        return {
          id: participant.id,
          handle: participant.handle,
          isRequester: participant.id === requester.id,
          roleConfigId: participant.roleConfigId,
          roleLabel: this.roleLabelForParticipant(conversation, participant),
          roleVersion: role?.version ?? participant.roleConfigVersion,
          appToolCapabilities: normalizeChatAppToolCapabilities(role?.appToolCapabilities),
          kind: participant.kind,
          model: participant.model,
          agentMode: normalizeChatAgentMode(participant.agentMode),
          permissions: normalizeChatAgentPermissions(participant.permissions),
          provider
        };
      }),
      providers
    };
  }

  async readChatMessagesForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.waitForQueuedSave(actor.conversationId);
    const conversation = await this.requireChat(actor.conversationId);
    const requester = this.chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }

    const request = this.normalizeChatMessageReadRequest(rawRequest);
    const sequencedMessages = conversation.messages.map((message, sequence) => ({ message, sequence }));
    const filteredMessages = sequencedMessages.filter(({ message, sequence }) => {
      if (typeof actor.snapshotMaxSequence === "number" && sequence > actor.snapshotMaxSequence) {
        return false;
      }
      if (request.threadId && message.metadata?.threadId !== request.threadId) {
        return false;
      }
      if (typeof request.beforeSequence === "number" && sequence >= request.beforeSequence) {
        return false;
      }
      if (typeof request.afterSequence === "number" && sequence <= request.afterSequence) {
        return false;
      }
      return true;
    });
    const selectedMessages = typeof request.afterSequence === "number"
      ? filteredMessages.slice(0, request.limit)
      : filteredMessages.slice(Math.max(0, filteredMessages.length - request.limit));
    const oldestSequence = selectedMessages[0]?.sequence;
    const newestSequence = selectedMessages[selectedMessages.length - 1]?.sequence;
    const readableTotalMessages = typeof actor.snapshotMaxSequence === "number"
      ? Math.min(conversation.messages.length, actor.snapshotMaxSequence + 1)
      : conversation.messages.length;

    return {
      conversationId: conversation.id,
      requesterParticipantId: requester.id,
      filters: {
        threadId: request.threadId,
        beforeSequence: request.beforeSequence,
        afterSequence: request.afterSequence,
        limit: request.limit
      },
      messages: selectedMessages.map(({ message, sequence }) => this.chatMessageForTool(message, sequence)),
      page: {
        oldestSequence,
        newestSequence,
        hasMoreBefore: typeof oldestSequence === "number"
          ? filteredMessages.some((item) => item.sequence < oldestSequence)
          : false,
        hasMoreAfter: typeof newestSequence === "number"
          ? filteredMessages.some((item) => item.sequence > newestSequence)
          : false,
        totalMessages: readableTotalMessages,
        totalMatchingMessages: filteredMessages.length
      }
    };
  }

  async readChatAttachment(request: ReadChatAttachmentRequest): Promise<{ attachment: ChatImageAttachment; dataBase64: string }> {
    await this.waitForQueuedSave(request.conversationId);
    const conversation = await this.requireChat(request.conversationId);
    const record = this.findImageAttachmentRecord(conversation, request.attachmentId);
    if (!record) {
      throw new Error("Attachment was not found in this conversation.");
    }
    const dataBase64 = await this.readAttachmentBase64(conversation.id, record.attachment);
    return {
      attachment: record.attachment,
      dataBase64
    };
  }

  async listChatAttachmentsForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.waitForQueuedSave(actor.conversationId);
    const conversation = await this.requireChat(actor.conversationId);
    const requester = this.chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }
    const request = this.normalizeChatAttachmentListRequest(rawRequest);
    const records = this.visibleImageAttachmentRecords(conversation, actor)
      .filter((record) => !request.messageId || record.message.id === request.messageId)
      .filter((record) => !request.threadId || record.message.metadata?.threadId === request.threadId)
      .slice(-request.limit);

    return {
      conversationId: conversation.id,
      requesterParticipantId: requester.id,
      filters: {
        messageId: request.messageId,
        threadId: request.threadId,
        limit: request.limit
      },
      attachments: records.map((record) => ({
        messageId: record.message.id,
        sequence: record.sequence,
        author: this.messageAuthor(record.message),
        threadId: record.message.metadata?.threadId,
        attachment: this.chatImageAttachmentForTool(record.attachment),
        readTool: APP_CHAT_READ_ATTACHMENT_TOOL,
        readArguments: { attachmentId: record.attachment.id }
      }))
    };
  }

  async readChatAttachmentForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.waitForQueuedSave(actor.conversationId);
    const conversation = await this.requireChat(actor.conversationId);
    const requester = this.chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }
    const request = this.normalizeChatAttachmentReadRequest(rawRequest);
    const record = this.visibleImageAttachmentRecords(conversation, actor).find((item) => item.attachment.id === request.attachmentId);
    if (!record) {
      void this.debugLogs.write("chat.attachments.mcp-read-denied", {
        conversationId: actor.conversationId,
        participantId: actor.participantId,
        attachmentId: request.attachmentId,
        snapshotMaxSequence: actor.snapshotMaxSequence
      });
      throw new Error(
        "AttachmentReadDenied. Problem: this attachment is not visible to the current participant turn. Cause: the attachment id is absent, belongs to another conversation, or is newer than this turn snapshot. Fix: call app_chat_list_attachments for visible attachment IDs, or ask User to resend the image."
      );
    }
    const dataBase64 = await this.readAttachmentBase64(conversation.id, record.attachment);
    return {
      conversationId: conversation.id,
      requesterParticipantId: requester.id,
      messageId: record.message.id,
      sequence: record.sequence,
      author: this.messageAuthor(record.message),
      threadId: record.message.metadata?.threadId,
      attachment: this.chatImageAttachmentForTool(record.attachment),
      dataBase64
    };
  }

  async respondToAppToolApproval(
    request: RespondToChatAppToolApprovalRequest,
    progress?: ProgressCallback
  ): Promise<Conversation | undefined> {
    const conversation = await this.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return conversation;
    }
    const approval = this.chatAppToolApprovals(conversation).find((item) => item.id === request.approvalId);
    if (!approval) {
      throw new Error("App tool approval request was not found.");
    }
    if (approval.status !== "pending") {
      throw new Error("App tool approval request has already been answered.");
    }
    const now = new Date().toISOString();
    if (!request.approve) {
      if (approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL && this.isParticipantRequestApprovalRequest(approval.request)) {
        this.applyParticipantRequestApprovalDecision(conversation, approval, "denied", request.scope);
      }
      this.upsertAppToolApproval(conversation, {
        ...approval,
        status: "denied",
        updatedAt: now
      });
      conversation.updatedAt = now;
      await this.saveConversation(conversation);
      const deniedParticipantRequest = this.isParticipantRequestApprovalRequest(approval.request) ? approval.request : undefined;
      if (approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL && deniedParticipantRequest?.requestMessageId) {
        const requestMessageId = deniedParticipantRequest.requestMessageId;
        void this.autoResumeParticipantRequest(conversation.id, requestMessageId, progress).catch((error) => {
          void this.debugLogs.write("chat.participant-request.deny-auto-resume.error", {
            conversationId: conversation.id,
            requestMessageId,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
      return conversation;
    }

    const scope = request.scope === "chat" ? "chat" : "once";
    if (approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL && this.isParticipantRequestApprovalRequest(approval.request)) {
      const participantScope = approval.request.source === "inferred" ? "once" : scope;
      this.upsertAppToolApproval(conversation, {
        ...approval,
        status: "approved",
        approvalScope: participantScope,
        appliedParticipantIds: this.participantRequestApprovalTargetIds(conversation, approval.request),
        updatedAt: now
      });
      if (participantScope === "chat") {
        const targetIds = this.participantRequestApprovalTargetIds(conversation, approval.request);
        for (const targetParticipantId of targetIds) {
          this.upsertAppToolApprovalPolicy(conversation, {
            id: randomUUID(),
            participantId: approval.requesterParticipantId,
            roleConfigId: approval.requesterRoleConfigId,
            toolName: approval.toolName,
            capability: approval.capability,
            targetParticipantId,
            scope: "chat",
            createdAt: now,
            updatedAt: now
          });
        }
      }
      const requestMessageId = approval.request.requestMessageId;
      if (requestMessageId) {
        this.applyParticipantRequestApprovalDecision(conversation, approval, "approved", participantScope);
      }
      conversation.updatedAt = now;
      await this.saveConversation(conversation);
      if (requestMessageId) {
        const batch = conversation.messages.find((message) => message.id === requestMessageId)?.metadata?.participantRequest;
        const runner = this.startParticipantRequestRunner(conversation.id, requestMessageId, randomUUID(), batch?.depth ?? 1);
        void runner.then(() => this.autoResumeParticipantRequest(conversation.id, requestMessageId, progress)).catch((error) => {
          void this.debugLogs.write("chat.participant-request.approval-run.error", {
            conversationId: conversation.id,
            requestMessageId,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
      return conversation;
    }
    const isPermissionApproval = approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL;
    const requester = this.chatParticipants(conversation).find((participant) => participant.id === approval.requesterParticipantId);
    let prepared: PreparedPermissionChange | PreparedRosterChange | undefined;
    try {
      prepared = isPermissionApproval
        ? this.preparePermissionChange(requester, approval.request)
        : await this.prepareRosterChange(conversation, approval.request as ChatRosterChangeRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.upsertAppToolApproval(conversation, {
        ...approval,
        status: "denied",
        updatedAt: now
      });
      conversation.messages.push(this.message(
        "system",
        `Could not approve app tool request from @${approval.requesterHandle}: ${message}`,
        undefined,
        { threadId: "system" }
      ));
      conversation.updatedAt = now;
      await this.saveConversation(conversation);
      return conversation;
    }
    if (!prepared) {
      return conversation;
    }
    const applied = isPermissionApproval
      ? scope === "once"
        ? [requester].filter((participant): participant is ChatParticipant => Boolean(participant))
        : [this.applyPreparedPermissionChange(conversation, approval.requesterParticipantId, prepared as PreparedPermissionChange)]
      : this.applyPreparedRosterChange(conversation, prepared as PreparedRosterChange);
    const updatedApproval: ChatAppToolApproval = {
      ...approval,
      status: "approved",
      request: isPermissionApproval ? (prepared as PreparedPermissionChange).request : approval.request,
      approvalScope: scope,
      appliedParticipantIds: applied.map((participant) => participant.id),
      updatedAt: now
    };
    this.upsertAppToolApproval(conversation, updatedApproval);
    if (scope === "chat" && approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL) {
      this.upsertAppToolApprovalPolicy(conversation, {
        id: randomUUID(),
        participantId: approval.requesterParticipantId,
        roleConfigId: approval.requesterRoleConfigId,
        toolName: approval.toolName,
        capability: approval.capability,
        scope: "chat",
        createdAt: now,
        updatedAt: now
      });
    }
    const permissionGrantList = isPermissionApproval
      ? this.formatPermissionChangeGrantList((prepared as PreparedPermissionChange).request)
      : undefined;
    const approvalMessage = isPermissionApproval
      ? scope === "chat"
        ? `Granted @${approval.requesterHandle} ${permissionGrantList} for this chat.`
        : `Granted @${approval.requesterHandle} ${permissionGrantList} once.`
      : scope === "chat"
        ? `Allowed for this chat and applied app tool request from @${approval.requesterHandle}: ${approval.summary}.`
        : `Allowed once and applied app tool request from @${approval.requesterHandle}: ${approval.summary}.`;
    conversation.messages.push(this.message(
      "system",
      approvalMessage,
      undefined,
      { threadId: "system" }
    ));
    conversation.updatedAt = now;
    await this.saveConversation(conversation);
    if (isPermissionApproval && updatedApproval.resumeContext) {
      void this.autoResumePermissionApproval(conversation.id, updatedApproval.id, progress).catch((error) => {
        this.emitProgress(updatedApproval.resumeContext?.runId ?? updatedApproval.id, progress, "error", error instanceof Error ? error.message : String(error));
        void this.debugLogs.write("chat.permission-approval.auto-resume.error", {
          conversationId: conversation.id,
          approvalId: updatedApproval.id,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return conversation;
  }

  async sendMessage(request: SendChatMessageRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const runId = request.runId ?? randomUUID();
    const warnings: string[] = [];
    return this.withChatRunLock(request.conversationId, async () => {
      const conversation = await this.requireChat(request.conversationId);
      const content = request.content.trim();
      const preparedImages = await this.prepareImageAttachments(conversation.id, request.imageAttachments);
      if (!content && preparedImages.attachments.length === 0) {
        throw new Error("Message is required.");
      }
      const repoFileMentions = await this.validateRepoFileMentions(conversation, request.repoFileMentions, warnings, content);
      const chatThreadRootId = request.chatThreadRootId?.trim() || undefined;
      const threadId = request.threadId?.trim() || randomUUID();
      const userMessage = this.message("user", content, undefined, {
        threadId,
        parentMessageId: request.parentMessageId,
        chatThreadRootId,
        ...(repoFileMentions.length > 0 ? { repoFileMentions } : {}),
        ...(preparedImages.attachments.length > 0 ? { imageAttachments: preparedImages.attachments } : {})
      });
      if (!request.threadId?.trim()) {
        userMessage.metadata = { ...userMessage.metadata, threadId: userMessage.id };
      }
      conversation.messages.push(userMessage);
      try {
        await this.beginChatRun(conversation, runId);
      } catch (error) {
        await this.rollbackPreparedImageAttachments(conversation.id, preparedImages, "ConversationSaveFailed", error);
        throw error;
      }
      try {
        let dispatch = this.resolveMentionTargets(conversation, content);
        for (const unknown of dispatch.unknownHandles) {
          const warning = `No participant named @${unknown}.`;
          warnings.push(warning);
          conversation.messages.push(this.message("system", warning, undefined, {
            threadId: userMessage.metadata?.threadId ?? threadId,
            parentMessageId: userMessage.id,
            chatThreadRootId
          }));
        }
        if (dispatch.targets.length === 0 && dispatch.unknownHandles.length === 0) {
          const adminTarget = this.defaultAdministratorDispatchTarget(conversation);
          if (adminTarget) {
            dispatch = { ...dispatch, targets: [adminTarget] };
          }
        }
        if (dispatch.targets.length === 0) {
          return { conversation, warnings };
        }

        this.emitProgress(runId, progress, "initial", `Running ${dispatch.targets.length} chat participant${dispatch.targets.length === 1 ? "" : "s"}.`, {
          total: dispatch.targets.length,
          completed: 0
        });
        await this.runParticipantBatch(conversation, dispatch.targets, userMessage, runId, signal, progress, warnings);
        this.emitProgress(runId, progress, "done", "Chat turn finished.", {
          completed: dispatch.targets.length,
          total: dispatch.targets.length
        });
        return { conversation, warnings };
      } catch (error) {
        this.emitChatRunFailure(runId, progress, error);
        throw error;
      } finally {
        await this.endChatRun(conversation, runId);
      }
    });
  }

  async respondToMentions(request: RespondToChatMentionsRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const runId = request.runId ?? randomUUID();
    const warnings: string[] = [];
    return this.withChatRunLock(request.conversationId, async () => {
      const conversation = await this.requireChat(request.conversationId);
      const sourceMessage = conversation.messages.find((message) => message.id === request.sourceMessageId);
      if (!sourceMessage) {
        throw new Error("Source message was not found.");
      }
      const pendingMentions = sourceMessage.metadata?.pendingMentions ?? [];
      const requestedIds = new Set(request.targetParticipantIds);
      const selectedMentions = pendingMentions.filter((mention) => requestedIds.has(mention.targetParticipantId));
      const continuationOnly = request.approve && request.continueRequester && selectedMentions.length === 0 && Boolean(sourceMessage.participantId);
      if (selectedMentions.length === 0 && request.approve && !continuationOnly) {
        throw new Error("Select at least one pending mention.");
      }

      if (!request.approve) {
        this.updatePendingMentionStatus(sourceMessage, new Set(pendingMentions.map((mention) => mention.targetParticipantId)), "rejected");
        conversation.updatedAt = new Date().toISOString();
        await this.saveConversation(conversation);
        return { conversation, warnings };
      }

      if (selectedMentions.length > 0) {
        this.updatePendingMentionStatus(sourceMessage, requestedIds, "approved");
      }
      await this.beginChatRun(conversation, runId);
      try {
        const participants = this.chatParticipants(conversation);
        const targets = selectedMentions
          .map((mention) => participants.find((participant) => participant.id === mention.targetParticipantId))
          .filter((participant): participant is ChatParticipant => Boolean(participant));
        if (targets.length > 0) {
          this.emitProgress(runId, progress, "initial", `Running ${targets.length} approved mention${targets.length === 1 ? "" : "s"}.`, {
            total: targets.length,
            completed: 0
          });
          await this.runParticipantBatch(conversation, targets, sourceMessage, runId, signal, progress, warnings);
        }

        if (request.continueRequester && sourceMessage.participantId) {
          const requester = participants.find((participant) => participant.id === sourceMessage.participantId);
          if (requester) {
            this.emitProgress(runId, progress, "debate", `Returning to @${requester.handle}.`, {
              participantLabel: `@${requester.handle}`
            });
            const messages = await this.runParticipantTurnSerialized(conversation, requester, sourceMessage, runId, signal, progress, {
              continuation: true,
              warnings
            });
            await this.refreshStoredChatState(conversation);
            this.appendParticipantTurnMessages(conversation, requester, messages, {
              runId,
              triggerMessageId: sourceMessage.id
            });
            conversation.updatedAt = new Date().toISOString();
            this.queueSnapshot(conversation);
            await this.ensureHistoryFiles(conversation);
          }
        }

        this.emitProgress(runId, progress, "done", "Approved mention flow finished.");
        return { conversation, warnings };
      } catch (error) {
        this.emitChatRunFailure(runId, progress, error);
        throw error;
      } finally {
        await this.endChatRun(conversation, runId);
      }
    });
  }

  async respondToChoice(request: RespondToChatChoiceRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const runId = request.runId ?? randomUUID();
    const warnings: string[] = [];
    return this.withChatRunLock(request.conversationId, async () => {
      const conversation = await this.requireChat(request.conversationId);
      const sourceMessage = conversation.messages.find((message) => message.id === request.sourceMessageId);
      if (!sourceMessage) {
        throw new Error("Source message was not found.");
      }
      const choice = sourceMessage.metadata?.pendingChoice;
      if (!choice || choice.id !== request.choiceId) {
        throw new Error("Choice request was not found.");
      }
      if (choice.status !== "pending") {
        throw new Error("Choice request has already been answered.");
      }
      const selectedOptionId = request.selectedOptionId?.trim();
      const customAnswer = request.customAnswer?.trim();
      const note = request.note?.trim();
      const isCustomAnswer = selectedOptionId === CHAT_CUSTOM_CHOICE_OPTION_ID;
      const selectedOption = isCustomAnswer ? undefined : choice.options.find((option) => option.id === selectedOptionId);
      if (isCustomAnswer && !customAnswer) {
        throw new Error("Custom choice answer is required.");
      }
      if (!isCustomAnswer && !selectedOption) {
        throw new Error("Selected option was not found.");
      }
      if (!sourceMessage.participantId) {
        throw new Error("Choice request is not attached to a chat participant.");
      }
      const requester = this.chatParticipants(conversation).find((participant) => participant.id === sourceMessage.participantId);
      if (!requester) {
        throw new Error("Choice requester is no longer in this chat.");
      }

      this.updatePendingChoiceSelection(sourceMessage, choice.id, selectedOption?.id ?? CHAT_CUSTOM_CHOICE_OPTION_ID, customAnswer, note);
      const rootId = sourceMessage.metadata?.chatThreadRootId ?? sourceMessage.id;
      const userMessage = this.message("user", this.formatChoiceSelectionForChat(sourceMessage, choice, selectedOption, customAnswer, note), undefined, {
        threadId: sourceMessage.metadata?.threadId ?? rootId,
        parentMessageId: sourceMessage.id,
        chatThreadRootId: rootId,
        sourceMessageId: sourceMessage.id
      });
      conversation.messages.push(userMessage);
      await this.beginChatRun(conversation, runId);
      try {
        this.emitProgress(runId, progress, "debate", `Returning choice to @${requester.handle}.`, {
          participantLabel: `@${requester.handle}`
        });
        const messages = await this.runParticipantTurnSerialized(conversation, requester, userMessage, runId, signal, progress, {
          continuation: true,
          warnings
        });
        await this.refreshStoredChatState(conversation);
        this.appendParticipantTurnMessages(conversation, requester, messages, {
          runId,
          triggerMessageId: userMessage.id
        });
        conversation.updatedAt = new Date().toISOString();
        this.queueSnapshot(conversation);
        await this.ensureHistoryFiles(conversation);
        this.emitProgress(runId, progress, "done", "Choice response finished.");
        return { conversation, warnings };
      } catch (error) {
        this.emitChatRunFailure(runId, progress, error);
        throw error;
      } finally {
        await this.endChatRun(conversation, runId);
      }
    });
  }

  private async validateRepoFileMentions(
    conversation: Conversation,
    rawMentions: RepoFileMention[] | undefined,
    warnings: string[],
    content?: string
  ): Promise<RepoFileMention[]> {
    const candidates: Array<{ path: unknown; source: "request" | "content" }> = [];
    if (Array.isArray(rawMentions)) {
      candidates.push(...rawMentions.map((mention) => ({ path: mention?.path, source: "request" as const })));
    }
    candidates.push(...this.extractRepoFileMentionPaths(content).map((mentionPath) => ({ path: mentionPath, source: "content" as const })));
    if (candidates.length === 0) {
      return [];
    }
    if (!conversation.repoPath) {
      warnings.push("Skipped repository file mentions because this chat has no selected repository.");
      return [];
    }

    let repoRealPath: string;
    try {
      repoRealPath = await realpath(conversation.repoPath);
    } catch {
      warnings.push("Skipped repository file mentions because the selected repository no longer exists.");
      return [];
    }

    const mentions: RepoFileMention[] = [];
    const seen = new Set<string>();
    for (const item of candidates) {
      const normalizedPath = this.normalizeRepoFileMentionPath(item.path);
      if (!normalizedPath) {
        if (item.source === "request" || this.shouldWarnForParsedRepoFileMention(String(item.path ?? ""))) {
          warnings.push("Skipped repository file mention because the path is invalid.");
        }
        continue;
      }
      if (seen.has(normalizedPath)) {
        continue;
      }
      seen.add(normalizedPath);

      const absolutePath = path.resolve(conversation.repoPath, normalizedPath);
      if (!this.isPathInside(path.resolve(conversation.repoPath), absolutePath)) {
        warnings.push(`Skipped repository file mention ${normalizedPath}: path escapes repository.`);
        continue;
      }

      try {
        const linkInfo = await lstat(absolutePath);
        if (linkInfo.isDirectory()) {
          warnings.push(`Skipped repository file mention ${normalizedPath}: path is a directory.`);
          continue;
        }
        const realFilePath = await realpath(absolutePath);
        if (!this.isPathInside(repoRealPath, realFilePath)) {
          warnings.push(`Skipped repository file mention ${normalizedPath}: path escapes repository.`);
          continue;
        }
        const fileInfo = await stat(absolutePath);
        if (!fileInfo.isFile()) {
          warnings.push(`Skipped repository file mention ${normalizedPath}: path is not a regular file.`);
          continue;
        }
      } catch {
        if (item.source === "request" || this.shouldWarnForParsedRepoFileMention(normalizedPath)) {
          warnings.push(`Skipped repository file mention ${normalizedPath}: file no longer exists.`);
        }
        continue;
      }
      mentions.push({ path: normalizedPath });
    }
    return mentions;
  }

  private normalizeRepoFileMentionPath(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes("\0") || trimmed.includes("\\") || trimmed.startsWith("/")) {
      return undefined;
    }
    const normalized = path.posix.normalize(trimmed);
    if (
      !normalized ||
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.split("/").includes("..")
    ) {
      return undefined;
    }
    return normalized;
  }

  private extractRepoFileMentionPaths(content: string | undefined): string[] {
    if (!content) {
      return [];
    }
    const paths: string[] = [];
    const seen = new Set<string>();
    const matches = this.withoutFencedCode(content).matchAll(/(^|\s)#([^\s`#]+)/g);
    for (const match of matches) {
      const normalizedPath = this.normalizeRepoFileMentionPath(this.trimRepoFileMentionToken(match[2] ?? ""));
      if (!normalizedPath || seen.has(normalizedPath)) {
        continue;
      }
      seen.add(normalizedPath);
      paths.push(normalizedPath);
    }
    return paths;
  }

  private trimRepoFileMentionToken(token: string): string {
    return token.replace(/[.,;:!?)]+$/g, "");
  }

  private shouldWarnForParsedRepoFileMention(pathValue: string): boolean {
    return pathValue.includes("/") || pathValue.includes(".");
  }

  private isPathInside(parentPath: string, childPath: string): boolean {
    const relative = path.relative(parentPath, childPath);
    return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private async runParticipantBatch(
    conversation: Conversation,
    participants: ChatParticipant[],
    triggerMessage: ChatMessage,
    runId: string,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    warnings: string[]
  ): Promise<void> {
    let completed = 0;
    const turnSnapshot = this.clone(conversation);
    const workspacePath = await this.ensureHistoryFiles(turnSnapshot);
    const labels = participants.map((participant) => `@${participant.handle}`);
    this.emitProgress(runId, progress, "debate", `${this.formatHandleList(labels)} ${participants.length === 1 ? "is" : "are"} responding in parallel.`, {
      completed,
      total: participants.length
    });
    let appendQueue = Promise.resolve();
    const appendCompletedTurn = async (participant: ChatParticipant, messages: ChatMessage[]): Promise<void> => {
      const nextAppend = appendQueue.then(async () => {
        await this.refreshStoredChatState(conversation);
        this.appendParticipantTurnMessages(conversation, participant, messages, {
          runId,
          triggerMessageId: triggerMessage.id
        });
        conversation.updatedAt = new Date().toISOString();
        this.queueSnapshot(conversation);
      });
      appendQueue = nextAppend.catch(() => undefined);
      await nextAppend;
    };
    await Promise.all(
      participants.map(async (participant) => {
        const messages = await this.runParticipantTurnSerialized(conversation, participant, triggerMessage, runId, signal, progress, {
          warnings,
          promptConversation: turnSnapshot,
          workspacePath
        });
        await appendCompletedTurn(participant, messages);
        completed += 1;
        this.emitProgress(runId, progress, "debate", `@${participant.handle} finished.`, {
          participantLabel: `@${participant.handle}`,
          completed,
          total: participants.length
        });
      })
    );
    await this.ensureHistoryFiles(conversation);
  }

  private async runParticipantTurn(
    conversation: Conversation,
    participant: ChatParticipant,
    triggerMessage: ChatMessage,
    runId: string,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    options: {
      continuation?: boolean;
      warnings: string[];
      promptConversation?: Conversation;
      workspacePath?: string;
      participantRequestDepth?: number;
      participantRequestBatchId?: string;
    }
  ): Promise<ChatMessage[]> {
    const sessionState = await this.sessionForParticipant(conversation, participant);
    const session = sessionState.session;
    const promptConversation = options.promptConversation ?? conversation;
    const workspacePath = options.workspacePath ?? await this.ensureHistoryFiles(promptConversation);
    const isResumingSession = Boolean(session.sessionId);
    const agentMode = this.agentModeForSession(session, participant);
    const oneTimePermissionApprovals = this.oneTimePermissionApprovalsForParticipant(conversation, participant);
    const appliedOneTimePermissionApprovalIds: string[] = [];
    const permissions = this.participantPermissionsForRun(
      conversation,
      participant,
      oneTimePermissionApprovals,
      appliedOneTimePermissionApprovalIds
    );
    session.participantPermissions = normalizeChatAgentPermissions(permissions);
    const usePromptRole = session.roleRuntime === "prompt-fallback";
    const includeRefreshedRoleInstructions = isResumingSession && sessionState.instructionsRefreshed;
    const primaryIncludeRoleInstructions = (usePromptRole && !isResumingSession) || includeRefreshedRoleInstructions;
    const primary = this.buildPromptParts(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
      includeRoleInstructions: primaryIncludeRoleInstructions,
      agentMode,
      permissions
    });
    const prompt = primary.prompt;
    const promptFallbackPrompt = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
      includeRoleInstructions: true,
      agentMode,
      permissions
    });
    const resumeFallbackPrompt = isResumingSession
      ? this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
          includeRoleInstructions: usePromptRole || includeRefreshedRoleInstructions,
          agentMode,
          permissions
        })
      : undefined;
    const role = usePromptRole ? undefined : this.cliRoleOptions(participant, session, promptFallbackPrompt);
    void this.debugLogs.write("chat.prompt.size", {
      conversationId: conversation.id,
      participantId: participant.id,
      participantHandle: participant.handle,
      runId,
      includeRoleInstructions: primaryIncludeRoleInstructions,
      resuming: isResumingSession,
      instructionsRefreshed: sessionState.instructionsRefreshed,
      sections: primary.sections,
      promptFallbackSize: promptFallbackPrompt.length,
      resumeFallbackSize: resumeFallbackPrompt?.length ?? 0,
      roleInstructionsSize: role?.instructions.length ?? 0
    });
    const runPath = this.runPathForParticipant(conversation, workspacePath, agentMode, permissions);
    const cliParticipant = this.cliParticipantForSession(participant, session);
    const pendingMessage = this.message(
      "participant",
      "",
      cliParticipant,
      {
        threadId: triggerMessage.metadata?.threadId ?? triggerMessage.id,
        parentMessageId: triggerMessage.id,
        chatThreadRootId: triggerMessage.metadata?.chatThreadRootId,
        sourceMessageId: triggerMessage.id,
        requesterParticipantId: options.continuation ? triggerMessage.participantId : undefined,
        approvedContinuation: options.continuation || undefined
      },
      "pending"
    );
    conversation.messages.push(pendingMessage);
    this.queueSnapshot(conversation);
    const progressSink = this.createAgentProgressSink(
      runId,
      progress,
      participant,
      pendingMessage.id,
      (cumulative: string): boolean => {
        return Boolean(
          this.chatResponseGuardViolation(cumulative, triggerMessage) ??
            this.confirmationBrevityViolation(cumulative, triggerMessage, Boolean(options.continuation))
        );
      }
    );
    const appToolCapabilities = normalizeChatAppToolCapabilities([
      ...normalizeChatAppToolCapabilities(session.roleAppToolCapabilities),
      "permissions.request"
    ]);
    const appMcpGrant: ChatAppMcpTokenGrant = {
      conversationId: conversation.id,
      participantId: participant.id,
      roleConfigId: session.roleConfigId,
      roleConfigVersion: session.roleConfigVersion,
      capabilities: appToolCapabilities,
      triggerMessageId: triggerMessage.id,
      triggerThreadId: triggerMessage.metadata?.threadId ?? triggerMessage.id,
      triggerParentMessageId: triggerMessage.metadata?.parentMessageId,
      triggerChatThreadRootId: triggerMessage.metadata?.chatThreadRootId,
      snapshotMaxSequence: Math.max(0, promptConversation.messages.length - 1),
      continuation: Boolean(options.continuation),
      runId,
      participantRequestDepth: options.participantRequestDepth ?? 0,
      participantRequestBatchId: options.participantRequestBatchId,
      historyMarkdownPath: path.join(workspacePath, "history.md"),
      historyJsonPath: path.join(workspacePath, "history.json")
    };
    const appMcp = this.issueAppMcpConnection(conversation, participant, appMcpGrant);
    const appMcpToolNames = this.appMcpToolNames(appToolCapabilities);
    const triggerAttachments = this.imageAttachments(triggerMessage);
    if (triggerAttachments.length > 0) {
      void this.debugLogs.write("chat.attachments.direct-delivery-skipped", {
        conversationId: conversation.id,
        participantId: participant.id,
        participantKind: participant.kind,
        runId,
        triggerMessageId: triggerMessage.id,
        attachmentIds: triggerAttachments.map((attachment) => attachment.id),
        reason: "Native CLI image input is not enabled until runner capability is verified; App MCP image read is available."
      });
    }
    this.emitProgress(runId, progress, "debate", `@${participant.handle} is responding.`, {
      participantLabel: `@${participant.handle}`,
      agentProgress: {
        participantId: participant.id,
        participantLabel: `@${participant.handle}`,
        state: "running",
        messageId: pendingMessage.id
      }
    });
    try {
      progressSink.beginAttempt();
      let result = await this.cliRunner.run(cliParticipant, prompt, runPath, undefined, "chat", signal, {
        persistSession: true,
        sessionId: session.sessionId,
        extraReadableDirs: [workspacePath],
        resumeFallbackPrompt,
        role,
        appMcp: appMcp
          ? {
              ...appMcp,
              toolNames: appMcpToolNames
            }
          : undefined,
        agentMode,
        permissions,
        onOutput: progressSink.emit,
        warm: {
          conversationId: conversation.id,
          participantId: participant.id,
          contextKey: this.warmAgentContextKey(conversation, participant, session, runPath, workspacePath, permissions),
          idleTimeoutMs: CHAT_WARM_AGENT_IDLE_TIMEOUT_MS
        }
      });
      this.applyCliRunMetadata(session, result, participant, options.warnings);
      const guardViolation = result.ok ? this.chatResponseGuardViolation(result.content, triggerMessage) : undefined;
      if (guardViolation) {
        options.warnings.push(`@${participant.handle}: rejected response that mentioned ${guardViolation}; retried in the same chat session.`);
        const retryUsesPromptRole = session.roleRuntime === "prompt-fallback";
        const retryIsResumingSession = Boolean(session.sessionId);
        const retryIncludeRoleInstructions = (retryUsesPromptRole && !retryIsResumingSession) || (retryIsResumingSession && sessionState.instructionsRefreshed);
        const retryPromptBase = retryIncludeRoleInstructions
          ? this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
              includeRoleInstructions: true,
              agentMode,
              permissions
            })
          : this.buildRetryEnvelope(triggerMessage, Boolean(options.continuation));
        const retryPromptFallbackBase = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
          includeRoleInstructions: true,
          agentMode,
          permissions
        });
        const retryPrompt = this.chatGuardRetryPrompt(retryPromptBase, guardViolation);
        const retryRole = retryUsesPromptRole
          ? undefined
          : this.cliRoleOptions(participant, session, this.chatGuardRetryPrompt(retryPromptFallbackBase, guardViolation));
        progressSink.beginAttempt();
        result = await this.cliRunner.run(cliParticipant, retryPrompt, runPath, undefined, "chat", signal, {
          persistSession: true,
          sessionId: session.sessionId,
          extraReadableDirs: [workspacePath],
          resumeFallbackPrompt,
          role: retryRole,
          appMcp: appMcp
            ? {
                ...appMcp,
                toolNames: appMcpToolNames
              }
            : undefined,
          agentMode,
          permissions,
          onOutput: progressSink.emit,
          warm: {
            conversationId: conversation.id,
            participantId: participant.id,
            contextKey: this.warmAgentContextKey(conversation, participant, session, runPath, workspacePath, permissions),
            idleTimeoutMs: CHAT_WARM_AGENT_IDLE_TIMEOUT_MS
          }
        });
        this.applyCliRunMetadata(session, result, participant, options.warnings);
        const retryViolation = result.ok ? this.chatResponseGuardViolation(result.content, triggerMessage) : undefined;
        if (retryViolation) {
          const error = `Blocked chat response because it mentioned ${retryViolation}.`;
          options.warnings.push(`@${participant.handle}: ${error}`);
          result = {
            ...result,
            ok: false,
            content: `@${participant.handle} response was blocked because it discussed internal CLI mechanics instead of answering in chat.`,
            error
          };
        }
      }
      const confirmationViolation = result.ok
        ? this.confirmationBrevityViolation(result.content, triggerMessage, Boolean(options.continuation))
        : undefined;
      if (confirmationViolation) {
        options.warnings.push(`@${participant.handle}: rejected verbose affirmative confirmation; retried in the same chat session.`);
        const retryUsesPromptRole = session.roleRuntime === "prompt-fallback";
        const retryIsResumingSession = Boolean(session.sessionId);
        const retryIncludeRoleInstructions = (retryUsesPromptRole && !retryIsResumingSession) || (retryIsResumingSession && sessionState.instructionsRefreshed);
        const retryPromptBase = retryIncludeRoleInstructions
          ? this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
              includeRoleInstructions: true,
              agentMode,
              permissions
            })
          : this.buildRetryEnvelope(triggerMessage, Boolean(options.continuation));
        const retryPromptFallbackBase = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
          includeRoleInstructions: true,
          agentMode,
          permissions
        });
        const retryPrompt = this.confirmationBrevityRetryPrompt(retryPromptBase);
        const retryRole = retryUsesPromptRole
          ? undefined
          : this.cliRoleOptions(participant, session, this.confirmationBrevityRetryPrompt(retryPromptFallbackBase));
        progressSink.beginAttempt();
        result = await this.cliRunner.run(cliParticipant, retryPrompt, runPath, undefined, "chat", signal, {
          persistSession: true,
          sessionId: session.sessionId,
          extraReadableDirs: [workspacePath],
          resumeFallbackPrompt,
          role: retryRole,
          appMcp: appMcp
            ? {
                ...appMcp,
                toolNames: appMcpToolNames
              }
            : undefined,
          agentMode,
          permissions,
          onOutput: progressSink.emit,
          warm: {
            conversationId: conversation.id,
            participantId: participant.id,
            contextKey: this.warmAgentContextKey(conversation, participant, session, runPath, workspacePath, permissions),
            idleTimeoutMs: CHAT_WARM_AGENT_IDLE_TIMEOUT_MS
          }
        });
        this.applyCliRunMetadata(session, result, participant, options.warnings);
        const retryGuardViolation = result.ok ? this.chatResponseGuardViolation(result.content, triggerMessage) : undefined;
        if (retryGuardViolation) {
          const error = `Blocked chat response because it mentioned ${retryGuardViolation}.`;
          options.warnings.push(`@${participant.handle}: ${error}`);
          result = {
            ...result,
            ok: false,
            content: `@${participant.handle} response was blocked because it discussed internal CLI mechanics instead of answering in chat.`,
            error
          };
        } else {
          const retryConfirmationViolation = result.ok
            ? this.confirmationBrevityViolation(result.content, triggerMessage, Boolean(options.continuation))
            : undefined;
          if (retryConfirmationViolation) {
            options.warnings.push(`@${participant.handle}: still returned a verbose affirmative confirmation after retry.`);
          }
        }
      }
      if (!signal?.aborted) {
        this.consumeOneTimePermissionApprovals(conversation, participant, appliedOneTimePermissionApprovalIds);
      }
      const now = new Date().toISOString();
      session.updatedAt = now;
      this.updateParticipantContextUsage(conversation, participant.id, result.contextUsage);
      pendingMessage.content = result.content;
      pendingMessage.status = result.ok ? "done" : "error";
      if (!result.ok && result.error) {
        options.warnings.push(`@${participant.handle}: ${result.error}`);
      }
      if (result.ok) {
        const pendingMentions: ChatPendingMention[] = [];
        const pendingChoice = this.pendingChoiceFromAgentReply(result.content);
        const requesterContinuationRequested = false;
        if (pendingMentions.length > 0 || pendingChoice) {
          pendingMessage.metadata = {
            ...pendingMessage.metadata,
            mentions: pendingMentions.length > 0 ? pendingMentions.map((mention) => mention.targetHandle) : undefined,
            pendingMentions: pendingMentions.length > 0 ? pendingMentions : undefined,
            pendingChoice,
            requesterContinuationRequested: requesterContinuationRequested || undefined
          };
        }
        session.lastSyncedMessageId = pendingMessage.id;
      }
      this.upsertSession(conversation, session);
      this.lockParticipantRoleVersion(conversation, participant, session.roleConfigVersion);
      return [pendingMessage];
    } finally {
      if (pendingMessage.status === "pending") {
        pendingMessage.status = "error";
        if (!pendingMessage.content) {
          pendingMessage.content = `@${participant.handle} run was interrupted before a response was produced.`;
        }
      }
      // Push the finalized message ahead of the sink "finished" event so the renderer
      // sees the final content before live progress is cleared, avoiding a flash of empty body.
      this.queueSnapshot(conversation);
      progressSink.finish();
    }
  }

  private appendParticipantTurnMessages(
    conversation: Conversation,
    participant: ChatParticipant,
    messages: ChatMessage[],
    resumeContext?: ChatAppToolApproval["resumeContext"]
  ): void {
    const existingIds = new Set(conversation.messages.map((message) => message.id));
    for (const message of messages) {
      if (!existingIds.has(message.id)) {
        conversation.messages.push(message);
      }
    }
    this.createImplicitParticipantRequestApproval(conversation, participant, messages);
    this.createImplicitPermissionApproval(conversation, participant, messages, resumeContext);
  }

  private buildPrompt(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    triggerMessage: ChatMessage,
    workspacePath: string,
    continuation: boolean,
    options: { includeRoleInstructions: boolean; agentMode: ChatAgentMode; permissions: ChatAgentPermissions }
  ): string {
    return this.buildPromptParts(conversation, participant, session, triggerMessage, workspacePath, continuation, options).prompt;
  }

  private buildPromptParts(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    triggerMessage: ChatMessage,
    workspacePath: string,
    continuation: boolean,
    options: { includeRoleInstructions: boolean; agentMode: ChatAgentMode; permissions: ChatAgentPermissions }
  ): { prompt: string; sections: ChatPromptSectionSizes } {
    const canRequestPermissions = this.canRequestPermissionChanges(session);
    const dynamicHeader = [
      this.participantRepositoryLine(conversation, options.agentMode, options.permissions),
      this.participantPermissionPolicy(options.agentMode, options.permissions, canRequestPermissions)
    ].filter(Boolean).join("\n");

    let staticEnvelope = "";
    if (options.includeRoleInstructions) {
      const historyMarkdownPath = path.join(workspacePath, "history.md");
      const historyJsonPath = path.join(workspacePath, "history.json");
      staticEnvelope = [
        `You are @${participant.handle}. Continue the same chat session.`,
        `Role: ${session.roleLabel}.`,
        this.promptFallbackStaticInstructions(session),
        dynamicHeader,
        `App MCP is the source of truth for chat context. History files at ${historyMarkdownPath} and ${historyJsonPath} are debug-only fallbacks.`
      ].join("\n");
    }
    const triggerBlock = [
      "Triggering message identifiers:",
      this.triggeringMessageIdentifiers(triggerMessage),
      "Triggering message:",
      this.formatMessage(triggerMessage, false)
    ].join("\n\n");
    const mentionsBlock = this.repoFileMentionsPromptSection(triggerMessage, options.agentMode, options.permissions, canRequestPermissions);
    const attachmentsBlock = this.imageAttachmentsPromptSection(triggerMessage);
    const currentRequestBlock = [
      continuation
        ? "Current request: control has returned to you after the approved participants have replied. Produce your next answer."
        : "Current request: answer the triggering message above.",
      "Write your next message in this chat."
    ].join("\n\n");

    const orderedBlocks = [
      staticEnvelope || dynamicHeader,
      triggerBlock,
      mentionsBlock,
      attachmentsBlock,
      currentRequestBlock
    ].filter(Boolean);
    const prompt = orderedBlocks.join("\n\n");

    return {
      prompt,
      sections: {
        staticEnvelope: staticEnvelope.length,
        dynamicHeader: staticEnvelope ? 0 : dynamicHeader.length,
        trigger: triggerBlock.length,
        mentions: mentionsBlock.length,
        attachments: attachmentsBlock.length,
        currentRequest: currentRequestBlock.length,
        total: prompt.length
      }
    };
  }

  private buildRetryEnvelope(triggerMessage: ChatMessage, continuation: boolean): string {
    return [
      "Triggering message identifiers:",
      this.triggeringMessageIdentifiers(triggerMessage),
      "Triggering message:",
      this.formatMessage(triggerMessage, false),
      this.imageAttachmentsPromptSection(triggerMessage),
      continuation
        ? "Current request: control has returned to you after the approved participants have replied. Produce your next answer."
        : "Current request: answer the triggering message above.",
      "Write your next message in this chat."
    ].join("\n\n");
  }

  private triggeringMessageIdentifiers(message: ChatMessage): string {
    return [
      `Message ID: ${message.id}`,
      message.metadata?.threadId ? `Thread ID: ${message.metadata.threadId}` : "",
      message.metadata?.parentMessageId ? `Parent message ID: ${message.metadata.parentMessageId}` : "",
      message.metadata?.chatThreadRootId ? `Chat thread root ID: ${message.metadata.chatThreadRootId}` : ""
    ].filter(Boolean).join("\n");
  }

  private repoFileMentionsPromptSection(
    message: ChatMessage,
    agentMode: ChatAgentMode,
    runPermissions: ChatAgentPermissions,
    _canRequestPermissions: boolean
  ): string {
    const mentions = this.repoFileMentions(message);
    if (mentions.length === 0) {
      return "";
    }
    const permissions = effectiveChatAgentPermissions(agentMode, runPermissions);
    const header = "Referenced repository files (paths relative to repo root):";
    const paths = mentions.map((mention) => `- ${mention.path}`);
    const guidance = permissions.repoRead
      ? "You may read these."
      : "repoRead is not granted; see permissions policy above for the escalation path.";
    return [header, ...paths, guidance].join("\n");
  }

  private cliRoleOptions(
    participant: ChatParticipant,
    session: ChatParticipantSession,
    promptFallbackPrompt: string
  ): CliAgentRoleOptions {
    return {
      name: this.roleRuntimeName(participant, session),
      description: `${session.roleLabel} participant @${participant.handle} in AI Consensus Chat.`,
      instructions: this.nativeRoleInstructions(participant, session),
      promptFallbackPrompt
    };
  }

  private nativeRoleInstructions(
    participant: ChatParticipant,
    session: ChatParticipantSession
  ): string {
    return [
      `You are @${participant.handle} in AI Consensus Chat.`,
      `Role: ${session.roleLabel}.`,
      "Use this role for the whole CLI session.",
      "",
      "Role instructions:",
      session.roleInstructions,
      "",
      this.staticChatInstructions(session)
    ].join("\n");
  }

  private promptFallbackStaticInstructions(session: ChatParticipantSession): string {
    return [
      "Role instructions:",
      session.roleInstructions,
      "",
      this.staticChatInstructions(session)
    ].join("\n");
  }

  private staticChatInstructions(session: ChatParticipantSession): string {
    return [
      "Chat participant boundaries:",
      "- You are one participant in a multi-participant chat.",
      "- User is the human conversation owner, requirements authority, and clarification source. User messages appear as `User` in the transcript.",
      "- Ask User directly when goals, requirements, preferences, acceptance criteria, or user intent are unclear.",
      "- Do not ask another participant for user-owned clarification.",
      "",
      "App MCP policy:",
      this.appToolPromptPolicy(session),
      "",
      "Response rules:",
      "- The user strongly prefers concise replies. Do not repeat accepted context or restate proposals when a short verdict, blocker, or delta is enough.",
      "- You may cite participant handles in normal prose for attribution; for cross-participant asks, use `app_chat_request_participants` rather than plain `@mentions` when another participant is expected to answer.",
      "- When replying to a participant request addressed to you, answer in the active thread; if request matching is ambiguous, ask for clarification rather than guessing.",
      "- Do not emit `Participant requests:` or `Return to requester after replies:` protocol blocks. They are legacy text and are not the current dispatch mechanism.",
      "- When a participant request MCP call returns `pending_approval` or `running`, end your turn unless User explicitly asked you to continue without that answer. The app will return control to you when replies or errors arrive.",
      "- Do not repeatedly poll participant request status in the same turn. Use the status tool only to recover a previous request after a timeout, interruption, approval delay, or resumed session.",
      "- When User must pick one option before you can continue, include one dedicated `User choice:` block after your explanation. Format it as lines `T: short title`, `Q: question`, `O1: option label | optional description`, `O2: option label | optional description`, and optionally `R: O1`. Use at least two options. Ask at most one user choice in a message.",
      "- The UI also lets User write a custom answer instead of choosing your suggestions. After User confirms, the app will send the selected option or custom answer back to you in this chat.",
      `- ${this.confirmationBrevityPolicy()}`,
      "- Answer in the active thread. Do not assume a mentioned participant has answered until their reply appears in the transcript.",
      "- Answer only in this chat message. Do not mention ExitPlanMode, plan files, tool availability, or recording/writing outside the chat unless User directly asks about those mechanics.",
      "- If you make a decision, arbitration, plan, or summary, include it in this reply. Do not say it is posted above or recorded elsewhere unless you cite the exact existing chat message.",
      "- When you change files in this turn, summarize the changed files and how you verified them in this chat reply.",
      "- Follow each turn's chat prompt for the triggering message, current repository and permission state, MCP context guidance, fallback history paths, and current request."
    ].join("\n");
  }

  private appToolPromptPolicy(session: ChatParticipantSession): string {
    const permissionPolicyLines = this.canRequestPermissionChanges(session)
      ? [
          "Permission MCP tool: `app_permissions_request_change` is available when this participant needs User approval for blocked capabilities.",
          "Required permission workflow: if the current task needs a blocked capability, call `app_permissions_request_change` before answering that the work cannot be done. Use `{ \"kind\": \"portable\", \"permissions\": [\"repoRead\"], \"reason\": \"Need to inspect the referenced repository files.\" }` for repository reads, `{ \"kind\": \"portable\", \"permissions\": [\"webAccess\"], \"reason\": \"Need live web lookup to answer User's trademark question.\" }` for web access, `{ \"kind\": \"portable\", \"permissions\": [\"workspaceWrite\"], \"reason\": \"Need to edit files for the requested change.\" }` for file edits, `{ \"kind\": \"shellRules\", \"rules\": [{ \"action\": \"allow\", \"match\": \"prefix\", \"pattern\": \"git diff\" }], \"reason\": \"Need to inspect diffs.\" }` for shell rules, or `{ \"kind\": \"providerNative\", \"provider\": \"claude-code\", \"allowedTools\": [\"mcp__server__tool\"], \"reason\": \"Need this Claude Code tool.\" }` for Claude-native tool grants.",
          "After a permission MCP call, the app will ask User to approve. If the result is pending approval, say only that the permission request is awaiting User approval; do not claim the permission was granted until the tool result or a later app message confirms approval."
        ]
      : [
          "Permission changes are not directly available to this participant. If the current task needs a blocked capability, explain the specific capability needed before refusing."
        ];
    const lines = [
      "App MCP tools: use the connected `ai_consensus` MCP server for app-managed requests. Do not try to change app state by editing files, shelling out, or asking User in prose when an app MCP tool exists.",
      "Read-only chat MCP tools: `app_chat_get_context`, `app_chat_get_participants`, `app_chat_read_messages`, `app_chat_list_attachments`, and `app_chat_read_attachment`. Prefer them over history files for roster, thread, messages, and screenshots.",
      "If a message lists attached images, call `app_chat_read_attachment` with the attachment ID before reasoning about visual details.",
      "Participant request MCP tools: `app_chat_request_participants` and `app_chat_get_participant_request_status` are available for asking current chat participants for input and recovering their replies. Request JSON is `{ \"requests\": [{ \"target\": \"codex\", \"prompt\": \"Concrete question\", \"reason\": \"Optional reason\" }], \"timeoutMs\": 120000, \"resumeRequester\": true }`.",
      "Participant request statuses include `pending_approval`, `running`, `answered`, `completed`, `failed`, `denied`, and `interrupted`. User may need to approve before targets run; chat grants are scoped to this requester and target.",
      "If `app_chat_request_participants` returns replies before timeout, use them in this turn. If it returns `pending_approval` or `running`, stop after a brief status note; the app will auto-resume you after replies or errors arrive.",
      ...permissionPolicyLines
    ];
    if (!hasChatAppToolCapability(session.roleAppToolCapabilities, "participants.manage")) {
      return [
        ...lines,
        "Roster management app tools are not available to this participant."
      ].join("\n");
    }
    return [
      ...lines,
      "App tools: `app_roster_describe_options` is available for read-only discovery of current roles, CLI providers, configured models, current roster, defaults, and validation rules.",
      "App tools: `app_roster_request_change` is available for User-requested participant roster changes.",
      "Call `app_roster_describe_options` first when you need exact role IDs, provider availability, configured models, or handle constraints.",
      "When using it, send JSON with `operations`, where each operation is `{ \"type\": \"add\", \"participant\": { \"handle\", \"roleConfigId\", \"kind\" } }`.",
      "The app will validate the request and either create a User approval item or auto-apply it if User already allowed roster management for this chat."
    ].join("\n");
  }

  private appMcpToolNames(capabilities: ChatAppToolCapability[]): string[] {
    return CHAT_APP_MCP_TOOL_NAMES.filter((toolName) => {
      if (CHAT_CONTEXT_MCP_TOOL_NAMES.includes(toolName)) {
        return true;
      }
      if (toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL) {
        return hasChatAppToolCapability(capabilities, "permissions.request");
      }
      return hasChatAppToolCapability(capabilities, "participants.manage");
    });
  }

  private canRequestPermissionChanges(session: ChatParticipantSession): boolean {
    return Boolean(this.appMcp) && hasChatAppToolCapability([
      ...normalizeChatAppToolCapabilities(session.roleAppToolCapabilities),
      "permissions.request"
    ], "permissions.request");
  }

  private issueAppMcpConnection(
    conversation: Conversation,
    participant: ChatParticipant,
    grant: ChatAppMcpTokenGrant
  ): { url: string; token: string } | undefined {
    if (!this.appMcp) {
      return undefined;
    }
    const key = `${conversation.id}:${participant.id}`;
    const existingToken = this.appMcpTokens.get(key);
    if (existingToken && this.appMcp.updateToken) {
      const updated = this.appMcp.updateToken(existingToken, grant);
      if (updated) {
        return updated;
      }
      this.appMcpTokens.delete(key);
    }
    const issued = this.appMcp.issueToken(grant);
    if (issued) {
      this.appMcpTokens.set(key, issued.token);
    }
    return issued;
  }

  private roleRuntimeName(participant: ChatParticipant, session: ChatParticipantSession): string {
    const base = `ai-consensus-${participant.handle}-${session.roleConfigId}-${participant.id.slice(0, 8)}`
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/g, "");
    return base || `ai-consensus-${participant.id.slice(0, 8)}`;
  }

  private applyCliRunMetadata(
    session: ChatParticipantSession,
    result: ParticipantRunResult,
    participant: ChatParticipant,
    warnings: string[]
  ): void {
    if (this.isKnownRoleRuntime(result.roleRuntime)) {
      session.roleRuntime = result.roleRuntime;
    }
    if (result.sessionId) {
      session.sessionId = result.sessionId;
    }
    if (result.sessionRestarted) {
      const warning = `@${participant.handle}: previous CLI session was unavailable, so a new session was started from saved chat context.`;
      if (!warnings.includes(warning)) {
        warnings.push(warning);
      }
    }
    for (const warning of result.warnings ?? []) {
      warnings.push(warning);
    }
  }

  private async sessionForParticipant(conversation: Conversation, participant: ChatParticipant): Promise<ChatParticipantSessionState> {
    const existing = this.chatSessions(conversation).find((session) => session.participantId === participant.id);
    const runtimeConfigVersion = this.runtimeConfigVersionFor(participant);
    if (existing) {
      const role = await this.roleForConfigId(existing.roleConfigId);
      if (!role) {
        void this.debugLogs.write("chat.session.role-snapshot-refresh-skipped", {
          conversationId: conversation.id,
          participantId: participant.id,
          roleConfigId: existing.roleConfigId
        });
      }
      return {
        session: this.refreshExistingSessionForParticipant(existing, participant, role, runtimeConfigVersion),
        instructionsRefreshed: Boolean(role && this.roleSnapshotChanged(existing, role)) || existing.runtimeConfigVersion !== runtimeConfigVersion
      };
    }
    const role = await this.roleForParticipant(participant);
    return {
      session: await this.newSessionForParticipant(participant, role, runtimeConfigVersion),
      instructionsRefreshed: false
    };
  }

  private async newSessionForParticipant(
    participant: ChatParticipant,
    knownRole?: ChatRoleConfig,
    knownRuntimeConfigVersion?: number
  ): Promise<ChatParticipantSession> {
    const role = knownRole ?? await this.roleForParticipant(participant);
    const runtimeConfigVersion = knownRuntimeConfigVersion ?? this.runtimeConfigVersionFor(participant);
    return {
      participantId: participant.id,
      sessionId: "",
      roleConfigId: role.id,
      roleConfigVersion: role.version,
      roleAppToolCapabilities: normalizeChatAppToolCapabilities(role.appToolCapabilities),
      roleRuntime: this.preferredRoleRuntimeFor(participant),
      participantKind: participant.kind,
      participantModel: participant.model?.trim() || undefined,
      participantAgentMode: normalizeChatAgentMode(participant.agentMode),
      participantPermissions: normalizeChatAgentPermissions(participant.permissions),
      runtimeConfigVersion,
      roleLabel: role.label,
      roleInstructions: role.instructions,
      updatedAt: new Date().toISOString()
    };
  }

  private refreshExistingSessionForParticipant(
    existing: ChatParticipantSession,
    participant: ChatParticipant,
    role: ChatRoleConfig | undefined,
    runtimeConfigVersion: number
  ): ChatParticipantSession {
    const participantKind = existing.participantKind ?? participant.kind;
    return {
      ...existing,
      roleConfigVersion: role?.version ?? existing.roleConfigVersion,
      roleAppToolCapabilities: role
        ? normalizeChatAppToolCapabilities(role.appToolCapabilities)
        : normalizeChatAppToolCapabilities(existing.roleAppToolCapabilities),
      roleRuntime: this.isKnownRoleRuntime(existing.roleRuntime)
        ? existing.roleRuntime
        : this.preferredRoleRuntimeForKind(participantKind),
      participantKind,
      participantModel: this.normalizedModel(existing.participantModel) || undefined,
      participantAgentMode: normalizeChatAgentMode(existing.participantAgentMode ?? participant.agentMode),
      participantPermissions: normalizeChatAgentPermissions(existing.participantPermissions ?? participant.permissions),
      runtimeConfigVersion,
      roleLabel: role?.label ?? existing.roleLabel,
      roleInstructions: role?.instructions ?? existing.roleInstructions,
      updatedAt: new Date().toISOString()
    };
  }

  private roleSnapshotChanged(session: ChatParticipantSession, role: ChatRoleConfig): boolean {
    return (
      session.roleConfigVersion !== role.version ||
      session.roleLabel !== role.label ||
      session.roleInstructions !== role.instructions ||
      !chatAppToolCapabilitiesEqual(session.roleAppToolCapabilities, role.appToolCapabilities)
    );
  }

  private runtimeConfigVersionFor(_participant: ChatParticipant): number {
    return CHAT_ROLE_RUNTIME_CONFIG_VERSION;
  }

  private preferredRoleRuntimeFor(participant: ChatParticipant): ChatRoleRuntime {
    return this.preferredRoleRuntimeForKind(participant.kind);
  }

  private preferredRoleRuntimeForKind(kind: ChatProviderKind): ChatRoleRuntime {
    return kind === "claude-code" ? "claude-agent" : "codex-developer-instructions";
  }

  private isKnownRoleRuntime(value: ChatRoleRuntime | undefined): value is ChatRoleRuntime {
    return value === "claude-agent" || value === "codex-developer-instructions" || value === "prompt-fallback";
  }

  private normalizedModel(value: string | undefined): string {
    return value?.trim() ?? "";
  }

  private agentModeForSession(session: ChatParticipantSession, participant: ChatParticipant): ChatAgentMode {
    return normalizeChatAgentMode(session.participantAgentMode ?? participant.agentMode);
  }

  private cliParticipantForSession(participant: ChatParticipant, session: ChatParticipantSession): ParticipantConfig {
    return {
      id: participant.id,
      kind: session.participantKind ?? participant.kind,
      label: `@${participant.handle}`,
      model: this.normalizedModel(session.participantModel) || undefined
    };
  }

  private runPathForParticipant(
    conversation: Conversation,
    workspacePath: string,
    agentMode: ChatAgentMode,
    runPermissions: ChatAgentPermissions
  ): string {
    const permissions = effectiveChatAgentPermissions(agentMode, runPermissions);
    return permissions.repoRead && conversation.repoPath ? conversation.repoPath : workspacePath;
  }

  private participantRepositoryLine(
    conversation: Conversation,
    agentMode: ChatAgentMode,
    runPermissions: ChatAgentPermissions
  ): string {
    const permissions = effectiveChatAgentPermissions(agentMode, runPermissions);
    if (!conversation.repoPath) {
      return "Repository: none selected.";
    }
    return `Repository: ${conversation.repoPath} (repoRead ${permissions.repoRead ? "allowed" : "blocked"}).`;
  }

  private participantPermissionPolicy(
    agentMode: ChatAgentMode,
    runPermissions: ChatAgentPermissions,
    canRequestPermissions: boolean
  ): string {
    const permissions = effectiveChatAgentPermissions(agentMode, runPermissions);
    const permissionLines = chatPermissionPromptLines({ agentMode, permissions, canRequestPermissions });
    return [
      `Permissions: shell commands ${permissions.shell.enabled ? "allowed" : "blocked"}, workspace edits ${permissions.workspaceWrite ? "allowed" : "blocked"}, web access ${permissions.webAccess ? "allowed" : "blocked"}.`,
      this.repoReadEscalationLine(permissions.repoRead, canRequestPermissions),
      permissionLines.shell,
      permissionLines.workspace,
      permissionLines.web
    ].filter(Boolean).join(" ");
  }

  private repoReadEscalationLine(repoReadGranted: boolean, canRequestPermissions: boolean): string {
    if (repoReadGranted) {
      return "";
    }
    return canRequestPermissions
      ? "If you need repository file contents, call `app_permissions_request_change` for `repoRead` before refusing."
      : "If you need repository file contents, explain that `repoRead` is needed before refusing.";
  }

  private warmAgentContextKey(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    runPath: string,
    workspacePath: string,
    runPermissions: ChatAgentPermissions
  ): string {
    return JSON.stringify({
      conversationId: conversation.id,
      participantId: participant.id,
      participantKind: session.participantKind ?? participant.kind,
      participantModel: this.normalizedModel(session.participantModel),
      participantAgentMode: this.agentModeForSession(session, participant),
      participantPermissions: normalizeChatAgentPermissions(runPermissions),
      roleConfigId: session.roleConfigId,
      roleConfigVersion: session.roleConfigVersion,
      roleAppToolCapabilities: normalizeChatAppToolCapabilities(session.roleAppToolCapabilities),
      roleRuntime: session.roleRuntime ?? "",
      runtimeConfigVersion: session.runtimeConfigVersion ?? 0,
      runPath,
      workspacePath
    });
  }

  private async roleForParticipant(participant: ChatParticipant): Promise<ChatRoleConfig> {
    const role = await this.roleForConfigId(participant.roleConfigId);
    if (!role) {
      throw new Error(`Unknown role for @${participant.handle}.`);
    }
    return role;
  }

  private async roleForConfigId(roleConfigId: string): Promise<ChatRoleConfig | undefined> {
    const roles = (await this.settings.getPublicSettings()).chatRoleConfigs;
    return roles.find((item) => item.id === roleConfigId);
  }

  private chatResponseGuardViolation(content: string, triggerMessage: ChatMessage): string | undefined {
    if (this.chatMechanicsWereRequested(triggerMessage.content)) {
      return undefined;
    }
    const searchable = this.withoutFencedCode(content);
    const forbidden: Array<{ label: string; pattern: RegExp }> = [
      { label: "ExitPlanMode", pattern: /\bExitPlanMode\b/i },
      { label: "Plan Mode", pattern: /\bplan mode\b/i },
      { label: "plan files", pattern: /\bplan file\b/i },
      { label: "tool availability", pattern: /\b(?:write|edit|bash|read|grep|glob|ls)\s+tool\b|\btools?\s+(?:is|are|was|were)\s+not\s+enabled\b|\bnot\s+enabled\s+in\s+this\s+context\b/i },
      { label: "out-of-chat writing", pattern: /\b(?:recorded|written|saved)\s+(?:in|to)\s+(?:the\s+)?(?:plan|file|elsewhere)\b/i },
      { label: "posted-above deflection", pattern: /\bposted above\b/i }
    ];
    return forbidden.find((item) => item.pattern.test(searchable))?.label;
  }

  private chatMechanicsWereRequested(content: string): boolean {
    return /\b(?:ExitPlanMode|plan mode|plan file|write tool|edit tool|bash tool|tool availability|permission mode|enabled tools?)\b/i.test(content);
  }

  private chatGuardRetryPrompt(prompt: string, violation: string): string {
    return [
      `Your previous draft was rejected because it mentioned ${violation}, which is forbidden for AI Consensus chat participants unless User directly asks about app or CLI mechanics.`,
      "Rewrite the response as a normal chat message. Do not mention tools, permission modes, plan files, ExitPlanMode, or writing/recording outside the chat. Include the actual answer, decision, or request in this reply.",
      prompt
    ].join("\n\n");
  }

  private confirmationBrevityPolicy(): string {
    return "Confirmation brevity policy: when the triggering request asks whether you agree, confirm, approve, acknowledge, sign off, review for objections, or confirm/correct/add anything, reply with only a short verdict such as `Yes, agree.`, `Confirmed.`, or `No objections.` Do not restate, summarize, or re-list the proposal you are confirming. If you have a real objection, caveat, correction, or short additive observation, start with `Objection:`, `Concern:`, `Correction:`, or `Note:` and include only the new material.";
  }

  private confirmationBrevityRetryPrompt(prompt: string): string {
    return [
      "Your previous draft was rejected because the triggering request only asked for agreement or confirmation, and you replied with a verbose affirmative restatement.",
      "Rewrite with only one short confirmation sentence, such as `Yes, agree.`, `Confirmed.`, or `No objections.` Do not restate, summarize, or re-list the prior proposal. If you have a real objection, caveat, correction, or short additive observation, start with `Objection:`, `Concern:`, `Correction:`, or `Note:` and include only that new material.",
      prompt
    ].join("\n\n");
  }

  private confirmationBrevityViolation(content: string, triggerMessage: ChatMessage, continuation: boolean): string | undefined {
    if (continuation || !this.confirmationRequestWasAsked(triggerMessage.content)) {
      return undefined;
    }
    const searchable = this.withoutFencedCode(content).trim();
    if (!searchable || this.hasMaterialConfirmationObjection(searchable) || !this.startsWithAffirmativeConfirmation(searchable)) {
      return undefined;
    }
    const wordCount = searchable.match(/\S+/g)?.length ?? 0;
    const hasExtraStructure = /\n|```|^\s*(?:[-*]|\d+[.)])\s+/m.test(content);
    return wordCount > 8 || hasExtraStructure ? "verbose affirmative confirmation" : undefined;
  }

  private confirmationRequestWasAsked(content: string): boolean {
    const searchable = this.withoutFencedCode(content);
    return [
      /\bdo\s+you\s+agree\b/i,
      /\bagree\??\s*$/i,
      /\b(?:can|could|please|pls|kindly|would\s+you)\s+(?:confirm|approve|acknowledge|validate)\b/i,
      /\bconfirm\??\s*$/i,
      /\bconfirm\s+(?:this|that|it|whether|if)\b/i,
      /\bconfirm\s+or\s+(?:correct|add|object)\b/i,
      /\b(?:any|no)\s+objections?\b/i,
      /\breview\b[^.!?\n]{0,80}\b(?:objections?|corrections?|blockers?)\b/i,
      /\bare\s+you\s+(?:ok|okay|aligned|good)\s+with\b/i,
      /\bdoes\s+this\s+(?:look|seem)\s+(?:right|correct|good)\b/i,
      /\bis\s+this\s+(?:right|correct|ok|okay)\b/i,
      /\b(?:sign\s*off|lgtm)\b/i
    ].some((pattern) => pattern.test(searchable));
  }

  private startsWithAffirmativeConfirmation(content: string): boolean {
    const first = content.trim().replace(/^>\s*/, "").slice(0, 160);
    return /^(?:yes\b|agree(?:d)?\b|confirmed?\b|confirm\b|ack(?:nowledged)?\b|lgtm\b|sounds good\b|no objections?\b|i agree\b|i confirm\b|i approve\b)/i.test(first);
  }

  private hasMaterialConfirmationObjection(content: string): boolean {
    const withoutNoObjections = content.replace(/\bno\s+objections?\b/gi, "");
    if (/\b(?:note|correction|addition)\s*:/i.test(withoutNoObjections)) {
      return true;
    }
    return /\b(?:objection|concern|caveat|but|however|except|unless|disagree|reject|unclear|unsupported|blocker|risk|issue|problem|missing|incorrect|wrong|invalid|unsafe|not convinced|cannot confirm|can't confirm|do not agree|don't agree|i disagree)\b/i.test(withoutNoObjections);
  }

  private lockParticipantRoleVersion(conversation: Conversation, participant: ChatParticipant, version: number): void {
    const participants = this.chatParticipants(conversation).map((item) =>
      item.id === participant.id ? { ...item, roleConfigVersion: version } : item
    );
    conversation.metadata = { ...conversation.metadata, participants };
  }

  private upsertSession(conversation: Conversation, session: ChatParticipantSession): void {
    const sessions = this.chatSessions(conversation);
    const next = sessions.some((item) => item.participantId === session.participantId)
      ? sessions.map((item) => (item.participantId === session.participantId ? session : item))
      : [...sessions, session];
    conversation.metadata = { ...conversation.metadata, participantSessions: next };
  }

  private updateParticipantContextUsage(
    conversation: Conversation,
    participantId: string,
    usage: AgentContextUsage | undefined
  ): void {
    if (!usage) {
      return;
    }
    conversation.metadata = {
      ...conversation.metadata,
      agentContextUsageByParticipant: {
        ...this.agentContextUsageByParticipant(conversation),
        [participantId]: usage
      }
    };
  }

  private async refreshStoredChatState(conversation: Conversation): Promise<void> {
    const stored = await this.storage.getConversation(conversation.id);
    if (!stored || stored.kind !== "chat") {
      return;
    }
    if (stored.updatedAt <= conversation.updatedAt && stored.messages.length <= conversation.messages.length) {
      return;
    }
    conversation.messages = this.mergeStoredChatMessages(stored.messages, conversation.messages);
    conversation.metadata = this.mergeStoredChatMetadata(stored.metadata, conversation.metadata);
    conversation.updatedAt = stored.updatedAt > conversation.updatedAt ? stored.updatedAt : conversation.updatedAt;
  }

  private mergeStoredChatMessages(storedMessages: ChatMessage[], currentMessages: ChatMessage[]): ChatMessage[] {
    const currentById = new Map(currentMessages.map((message) => [message.id, message]));
    const merged = storedMessages.map((message) => currentById.get(message.id) ?? message);
    const storedIds = new Set(storedMessages.map((message) => message.id));
    for (const message of currentMessages) {
      if (!storedIds.has(message.id)) {
        merged.push(message);
      }
    }
    return merged;
  }

  private mergeStoredChatMetadata(
    storedMetadata: Record<string, unknown>,
    currentMetadata: Record<string, unknown>
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = {
      ...storedMetadata,
      ...currentMetadata
    };
    const participants = this.mergeMetadataItemsByKey(
      storedMetadata.participants,
      currentMetadata.participants,
      "id",
      (stored, current) => ({
        ...stored,
        ...(typeof current.roleConfigVersion === "number" ? { roleConfigVersion: current.roleConfigVersion } : {})
      })
    );
    if (participants) {
      merged.participants = participants;
    }
    const sessions = this.mergeMetadataItemsByKey(
      storedMetadata.participantSessions,
      currentMetadata.participantSessions,
      "participantId",
      (_stored, current) => current
    );
    if (sessions) {
      merged.participantSessions = sessions;
    }
    const contextUsage = this.mergeMetadataRecords(
      storedMetadata.agentContextUsageByParticipant,
      currentMetadata.agentContextUsageByParticipant
    );
    if (contextUsage) {
      merged.agentContextUsageByParticipant = contextUsage;
    }
    const approvals = this.mergeMetadataItemsByKey(
      storedMetadata.pendingAppToolApprovals,
      currentMetadata.pendingAppToolApprovals,
      "id",
      (stored, current) => this.newerMetadataItem(stored, current)
    );
    if (approvals) {
      merged.pendingAppToolApprovals = approvals;
    }
    const policies = this.mergeMetadataItemsByKey(
      storedMetadata.appToolApprovalPolicies,
      currentMetadata.appToolApprovalPolicies,
      "id",
      (stored, current) => this.newerMetadataItem(stored, current)
    );
    if (policies) {
      merged.appToolApprovalPolicies = policies;
    }
    return merged;
  }

  private mergeMetadataItemsByKey(
    storedValue: unknown,
    currentValue: unknown,
    key: string,
    mergeItem: (stored: Record<string, unknown>, current: Record<string, unknown>) => Record<string, unknown>
  ): Record<string, unknown>[] | undefined {
    const storedItems = Array.isArray(storedValue) ? storedValue.filter(this.isMetadataRecord) : [];
    const currentItems = Array.isArray(currentValue) ? currentValue.filter(this.isMetadataRecord) : [];
    if (storedItems.length === 0 && currentItems.length === 0) {
      return undefined;
    }
    const currentByKey = new Map(
      currentItems
        .map((item) => [this.metadataStringKey(item, key), item] as const)
        .filter(([itemKey]) => Boolean(itemKey))
    );
    const merged = storedItems.map((storedItem) => {
      const itemKey = this.metadataStringKey(storedItem, key);
      const currentItem = itemKey ? currentByKey.get(itemKey) : undefined;
      return currentItem ? mergeItem(storedItem, currentItem) : storedItem;
    });
    const storedKeys = new Set(storedItems.map((item) => this.metadataStringKey(item, key)).filter(Boolean));
    for (const currentItem of currentItems) {
      const itemKey = this.metadataStringKey(currentItem, key);
      if (!itemKey || !storedKeys.has(itemKey)) {
        merged.push(currentItem);
      }
    }
    return merged;
  }

  private mergeMetadataRecords(storedValue: unknown, currentValue: unknown): Record<string, unknown> | undefined {
    const stored = this.isMetadataRecord(storedValue) ? storedValue : undefined;
    const current = this.isMetadataRecord(currentValue) ? currentValue : undefined;
    if (!stored && !current) {
      return undefined;
    }
    return {
      ...(stored ?? {}),
      ...(current ?? {})
    };
  }

  private newerMetadataItem(
    stored: Record<string, unknown>,
    current: Record<string, unknown>
  ): Record<string, unknown> {
    const storedUpdatedAt = typeof stored.updatedAt === "string" ? stored.updatedAt : "";
    const currentUpdatedAt = typeof current.updatedAt === "string" ? current.updatedAt : "";
    return currentUpdatedAt >= storedUpdatedAt ? current : stored;
  }

  private metadataStringKey(item: Record<string, unknown>, key: string): string | undefined {
    const value = item[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  private isMetadataRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  private async waitForQueuedSave(conversationId: string): Promise<void> {
    await this.saveQueues.get(conversationId)?.catch(() => undefined);
  }

  private async validateParticipants(
    items: CreateChatConversationRequest["participants"],
    existing: ChatParticipant[] = [],
    allowEmpty = false
  ): Promise<ChatParticipant[]> {
    if (items.length === 0 && existing.length === 0 && !allowEmpty) {
      throw new Error("Add at least one chat participant.");
    }
    const roles = (await this.settings.getPublicSettings()).chatRoleConfigs;
    const handles = new Set(existing.map((participant) => participant.handle.toLowerCase()));
    return items.map((item) => {
      const handle = item.handle.trim().replace(/^@/, "");
      if (!HANDLE_PATTERN.test(handle)) {
        throw new Error("Participant names may use letters, numbers, underscores, and hyphens only.");
      }
      const normalized = handle.toLowerCase();
      if (handles.has(normalized)) {
        throw new Error(`Duplicate participant name: @${handle}.`);
      }
      handles.add(normalized);
      if (item.kind !== "codex-cli" && item.kind !== "claude-code") {
        throw new Error("Chat MVP supports local CLI participants only.");
      }
      if (!roles.some((role) => role.id === item.roleConfigId)) {
        throw new Error(`Unknown role for @${handle}.`);
      }
      return {
        id: randomUUID(),
        handle,
        roleConfigId: item.roleConfigId,
        kind: item.kind as ChatProviderKind,
        model: item.model?.trim() || undefined,
        avatarId: item.avatarId?.trim() || undefined,
        agentMode: normalizeChatAgentMode(item.agentMode),
        permissions: normalizeChatAgentPermissions(item.permissions)
      };
    });
  }

  private async ensureAdministratorParticipant(participants: ChatParticipant[]): Promise<ChatParticipant[]> {
    if (participants.some((participant) => participant.roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID)) {
      return participants;
    }
    const settings = await this.settings.getPublicSettings();
    const adminRole = settings.chatRoleConfigs.find((role) => role.id === CHAT_ADMINISTRATOR_ROLE_ID);
    if (!adminRole) {
      return participants;
    }
    const existingHandles = new Set(participants.map((participant) => participant.handle.toLowerCase()));
    const handle = this.uniqueHandle(CHAT_ADMINISTRATOR_HANDLE, existingHandles);
    const kind = await this.defaultAdministratorProviderKind(settings.providers);
    const [administrator] = await this.validateParticipants([
      {
        handle,
        roleConfigId: adminRole.id,
        kind,
        avatarId: undefined,
        agentMode: "default",
        permissions: {
          repoRead: true,
          workspaceWrite: false,
          webAccess: false,
          shell: {
            enabled: false,
            rules: []
          }
        }
      }
    ], participants);
    return administrator ? [administrator, ...participants] : participants;
  }

  private async defaultAdministratorProviderKind(providers: Array<{ kind: string; enabled: boolean }>): Promise<ChatProviderKind> {
    const agents = await this.cliRunner.detectAgents().catch(() => []);
    return this.preferredChatProviderKind(providers, agents);
  }

  private preferredChatProviderKind(providers: Array<{ kind: string; enabled: boolean }>, agents: AgentHealth[]): ChatProviderKind {
    const codexInstalled = agents.some((agent) => agent.kind === "codex-cli" && agent.installed);
    const claudeInstalled = agents.some((agent) => agent.kind === "claude-code" && agent.installed);
    const codexEnabled = providers.some((provider) => provider.kind === "codex-cli" && provider.enabled);
    const claudeEnabled = providers.some((provider) => provider.kind === "claude-code" && provider.enabled);
    if (codexInstalled && codexEnabled) {
      return "codex-cli";
    }
    if (claudeInstalled && claudeEnabled) {
      return "claude-code";
    }
    if (codexInstalled) {
      return "codex-cli";
    }
    if (claudeInstalled) {
      return "claude-code";
    }
    return claudeEnabled ? "claude-code" : "codex-cli";
  }

  private uniqueHandle(base: string, existingHandles: Set<string>): string {
    let candidate = base;
    let suffix = 2;
    while (existingHandles.has(candidate.toLowerCase())) {
      const suffixText = `-${suffix}`;
      candidate = `${base.slice(0, 32 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    return candidate;
  }

  private defaultAdministratorDispatchTarget(conversation: Conversation): ChatParticipant | undefined {
    const participants = this.chatParticipants(conversation);
    if (participants.length !== 1) {
      return undefined;
    }
    const [participant] = participants;
    return participant?.roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID ? participant : undefined;
  }

  private rosterParticipantSummary(conversation: Conversation, participant: ChatParticipant): ChatRosterCurrentParticipant {
    return {
      id: participant.id,
      handle: participant.handle,
      roleConfigId: participant.roleConfigId,
      roleLabel: this.roleLabelForParticipant(conversation, participant),
      kind: participant.kind,
      model: participant.model,
      agentMode: normalizeChatAgentMode(participant.agentMode)
    };
  }

  private normalizeRosterChangeRequest(raw: unknown): ChatRosterChangeRequest {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Roster change request must be an object.");
    }
    const record = raw as { reason?: unknown; operations?: unknown };
    if (!Array.isArray(record.operations) || record.operations.length === 0) {
      throw new Error("Roster change request needs at least one operation.");
    }
    if (record.operations.length > CHAT_ROSTER_CHANGE_MAX_OPERATIONS) {
      throw new Error("Roster change request is too large.");
    }
    return {
      reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 500) || undefined : undefined,
      operations: record.operations.map((operation, index) => {
        if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
          throw new Error(`Roster operation ${index + 1} must be an object.`);
        }
        const operationRecord = operation as { type?: unknown; participant?: unknown };
        if (operationRecord.type !== "add") {
          throw new Error("Only add roster operations are supported in this version.");
        }
        const participant = operationRecord.participant;
        if (!participant || typeof participant !== "object" || Array.isArray(participant)) {
          throw new Error(`Roster operation ${index + 1} needs a participant object.`);
        }
        const participantRecord = participant as Record<string, unknown>;
        const handle = typeof participantRecord.handle === "string" ? participantRecord.handle.trim() : "";
        const roleConfigId = typeof participantRecord.roleConfigId === "string" ? participantRecord.roleConfigId.trim() : "";
        const kind = participantRecord.kind;
        if (kind !== "codex-cli" && kind !== "claude-code") {
          throw new Error(`Roster operation ${index + 1} has an unsupported CLI kind.`);
        }
        return {
          type: "add",
          participant: {
            handle,
            roleConfigId,
            kind,
            model: typeof participantRecord.model === "string" ? participantRecord.model.trim() || undefined : undefined,
            avatarId: typeof participantRecord.avatarId === "string" ? participantRecord.avatarId.trim() || undefined : undefined,
            agentMode: normalizeChatAgentMode(participantRecord.agentMode),
            permissions: normalizeChatAgentPermissions(participantRecord.permissions)
          }
        };
      })
    };
  }

  private async prepareRosterChange(conversation: Conversation, request: ChatRosterChangeRequest): Promise<PreparedRosterChange> {
    const existing = this.chatParticipants(conversation);
    const participantInputs = request.operations.map((operation) => operation.participant);
    const participants = await this.validateParticipants(participantInputs, existing);
    const normalizedRequest: ChatRosterChangeRequest = {
      reason: request.reason,
      operations: participants.map((participant) => ({
        type: "add",
        participant: {
          handle: participant.handle,
          roleConfigId: participant.roleConfigId,
          kind: participant.kind,
          model: participant.model,
          avatarId: participant.avatarId,
          agentMode: normalizeChatAgentMode(participant.agentMode),
          permissions: normalizeChatAgentPermissions(participant.permissions)
        }
      }))
    };
    return {
      request: normalizedRequest,
      participants,
      summary: `Add ${this.formatHandleList(participants.map((participant) => `@${participant.handle}`))}`
    };
  }

  private applyPreparedRosterChange(conversation: Conversation, prepared: PreparedRosterChange): ChatParticipant[] {
    const participants = this.chatParticipants(conversation);
    conversation.metadata = {
      ...conversation.metadata,
      participants: [...participants, ...prepared.participants]
    };
    return prepared.participants;
  }

  private createImplicitPermissionApproval(
    conversation: Conversation,
    participant: ChatParticipant,
    messages: ChatMessage[],
    resumeContext?: ChatAppToolApproval["resumeContext"]
  ): void {
    const request = this.implicitPermissionChangeRequest(participant, messages);
    if (!request) {
      return;
    }
    const prepared = this.preparePermissionChange(participant, request);
    if (!this.preparedPermissionChangeHasAdditions(prepared) || this.hasPendingPermissionApproval(conversation, participant, prepared.request)) {
      return;
    }
    const approval = this.newAppToolApproval(
      conversation,
      participant,
      APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
      "permissions.request",
      prepared.request,
      prepared.summary,
      "pending"
    );
    if (resumeContext) {
      approval.resumeContext = resumeContext;
    }
    this.upsertAppToolApproval(conversation, approval);
    conversation.messages.push(this.message("system", `Permission approval needed for @${participant.handle}: ${prepared.summary}.`, undefined, {
      threadId: "system"
    }));
  }

  private createImplicitParticipantRequestApproval(
    conversation: Conversation,
    participant: ChatParticipant,
    messages: ChatMessage[]
  ): void {
    for (const sourceMessage of messages) {
      if (
        sourceMessage.role !== "participant" ||
        sourceMessage.participantId !== participant.id ||
        sourceMessage.status === "error" ||
        sourceMessage.metadata?.participantRequest
      ) {
        continue;
      }

      const inferred = this.inferParticipantRequestTargets(conversation, participant, sourceMessage.content);
      if (inferred.length === 0) {
        continue;
      }
      const targetHandles = inferred.map((item) => item.targetHandle);
      if (this.hasActiveParticipantRequestForTargets(conversation, participant, sourceMessage.id, targetHandles)) {
        void this.debugLogs.write("chat.participant-request.inferred-skipped-existing", {
          conversationId: conversation.id,
          messageId: sourceMessage.id,
          requesterParticipantId: participant.id,
          requesterHandle: participant.handle,
          targets: targetHandles
        });
        continue;
      }

      let prepared: PreparedParticipantRequest;
      try {
        prepared = this.prepareParticipantRequest(
          conversation,
          participant,
          {
            requests: inferred.map((item) => ({
              target: item.targetHandle,
              prompt: this.inferredParticipantRequestPrompt(participant.handle, item.snippet),
              reason: `Inferred from @${participant.handle}'s chat reply.`
            })),
            timeoutMs: CHAT_PARTICIPANT_REQUEST_WAIT_DEFAULT_MS,
            resumeRequester: true
          },
          {
            conversationId: conversation.id,
            participantId: participant.id,
            roleConfigId: participant.roleConfigId,
            roleConfigVersion: participant.roleConfigVersion ?? 0,
            capabilities: ["participants.request"],
            triggerMessageId: sourceMessage.id,
            triggerThreadId: sourceMessage.metadata?.threadId ?? sourceMessage.id,
            triggerParentMessageId: sourceMessage.metadata?.parentMessageId,
            triggerChatThreadRootId: sourceMessage.metadata?.chatThreadRootId,
            snapshotMaxSequence: Math.max(0, conversation.messages.length - 1),
            continuation: false,
            participantRequestDepth: 0
          },
          "inferred",
          { ignoreApprovalPolicies: true }
        );
      } catch (error) {
        void this.debugLogs.write("chat.participant-request.inferred-create-error", {
          conversationId: conversation.id,
          messageId: sourceMessage.id,
          requesterParticipantId: participant.id,
          requesterHandle: participant.handle,
          targets: targetHandles,
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      conversation.messages.push(prepared.requestMessage);
      const pendingTargets = prepared.batch.items.filter((item) => item.status === "pending_approval");
      if (pendingTargets.length === 0) {
        continue;
      }
      const approval = this.newAppToolApproval(
        conversation,
        participant,
        APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
        "participants.request",
        {
          ...prepared.request,
          requests: prepared.request.requests.filter((request) =>
            pendingTargets.some((item) => item.targetHandle.toLowerCase() === request.target.replace(/^@/, "").toLowerCase())
          ),
          requestMessageId: prepared.requestMessage.id,
          batchId: prepared.batch.id
        },
        this.participantRequestSummary(participant.handle, pendingTargets.map((item) => item.targetHandle)),
        "pending"
      );
      this.upsertAppToolApproval(conversation, approval);
      void this.debugLogs.write("chat.participant-request.inferred-created", {
        conversationId: conversation.id,
        messageId: sourceMessage.id,
        requestMessageId: prepared.requestMessage.id,
        requesterParticipantId: participant.id,
        requesterHandle: participant.handle,
        targets: pendingTargets.map((item) => item.targetHandle)
      });
    }
  }

  private hasActiveParticipantRequestForTargets(
    conversation: Conversation,
    requester: ChatParticipant,
    sourceMessageId: string,
    targetHandles: string[]
  ): boolean {
    const targets = new Set(targetHandles.map((handle) => handle.toLowerCase()));
    return this.participantRequestBatches(conversation).some((batch) => {
      if (batch.requesterParticipantId !== requester.id) {
        return false;
      }
      if (batch.triggerMessageId === sourceMessageId) {
        return this.participantRequestHasUnfinishedItems(batch);
      }
      if (!this.participantRequestHasUnfinishedItems(batch)) {
        return false;
      }
      return batch.items.some((item) =>
        targets.has(item.targetHandle.toLowerCase()) &&
        ["pending_approval", "running", "resuming_requester"].includes(item.status)
      );
    });
  }

  private inferredParticipantRequestPrompt(requesterHandle: string, snippet: string): string {
    const base = [
      `@${requesterHandle} appeared to request your input in this chat reply.`,
      `Relevant excerpt: ${snippet}`,
      "Respond directly to the request, focusing only on the points that need your input."
    ].join("\n");
    if (!this.confirmationRequestWasAsked(snippet)) {
      return base;
    }
    return [base, "", PARTICIPANT_REQUEST_SCRUTINY_APPENDIX].join("\n");
  }

  private participantRequestPromptForTarget(prompt: string): string {
    if (prompt.includes(PARTICIPANT_REQUEST_SCRUTINY_APPENDIX)) {
      return prompt;
    }
    if (!this.confirmationRequestWasAsked(prompt)) {
      return prompt;
    }
    return [prompt, "", PARTICIPANT_REQUEST_SCRUTINY_APPENDIX].join("\n");
  }

  private implicitPermissionChangeRequest(
    participant: ChatParticipant,
    messages: ChatMessage[]
  ): ChatPermissionChangeRequest | undefined {
    const permissions = normalizeChatAgentPermissions(participant.permissions);
    const content = messages
      .filter((message) => message.role === "participant" && message.participantId === participant.id)
      .map((message) => message.content)
      .join("\n");
    const requested = new Set<ChatPermissionGrant>();
    if (!permissions.webAccess && this.responseAsksForWebAccess(content)) {
      requested.add("webAccess");
    }
    if (!permissions.workspaceWrite && this.responseAsksForWorkspaceWrite(content)) {
      requested.add("workspaceWrite");
    }
    if (!permissions.repoRead && this.responseAsksForRepoRead(content)) {
      requested.add("repoRead");
    }
    if (requested.size === 0) {
      return undefined;
    }
    return {
      kind: "portable",
      reason: `@${participant.handle} reported that the current request needs ${this.formatPermissionGrantList(Array.from(requested))}.`,
      permissions: Array.from(requested)
    };
  }

  private responseAsksForWebAccess(content: string): boolean {
    return (
      /\b(?:need|needs|needed|require|requires|required|would need|needs? to use)\b[\s\S]{0,160}\bweb (?:access|search|lookup|lookups|results?|use)\b/i.test(content) ||
      /\bweb access\b[\s\S]{0,120}\b(?:blocked|not enabled|not available|needed|required)\b/i.test(content) ||
      /\bdo not use web search\b/i.test(content)
    );
  }

  private responseAsksForWorkspaceWrite(content: string): boolean {
    return (
      /\b(?:need|needs|needed|require|requires|required|would need)\b[\s\S]{0,160}\b(?:edit|write|update|modify|change) (?:files?|access|permission)\b/i.test(content) ||
      /\b(?:can(?:not|'t)|unable to)\b[\s\S]{0,80}\b(?:edit|write|update|modify)\b/i.test(content) ||
      /\bworkspace (?:edits?|write)\b[\s\S]{0,120}\b(?:blocked|not enabled|not available|needed|required)\b/i.test(content)
    );
  }

  private responseAsksForRepoRead(content: string): boolean {
    return (
      /\b(?:need|needs|needed|require|requires|required|would need)\b[\s\S]{0,160}\b(?:repo|repository) read (?:access|permission)\b/i.test(content) ||
      /\b(?:can(?:not|'t)|unable to)\b[\s\S]{0,100}\b(?:read|inspect|open) (?:repo|repository) files?\b/i.test(content) ||
      /\brepo(?:sitory)? read\b[\s\S]{0,120}\b(?:blocked|not enabled|not available|needed|required)\b/i.test(content)
    );
  }

  private hasPendingPermissionApproval(
    conversation: Conversation,
    participant: ChatParticipant,
    request: ChatPermissionChangeRequest
  ): boolean {
    return this.chatAppToolApprovals(conversation).some((approval) => {
      if (
        approval.status !== "pending" ||
        approval.toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL ||
        approval.requesterParticipantId !== participant.id ||
        !this.isPermissionChangeRequest(approval.request)
      ) {
        return false;
      }
      return this.permissionChangeRequestCovers(approval.request as ChatPermissionChangeRequest, request);
    });
  }

  private normalizePermissionChangeRequest(raw: unknown): ChatPermissionChangeRequest {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Permission change request must be an object.");
    }
    const record = raw as Record<string, unknown>;
    if (record.kind === "shellRules") {
      return this.normalizeShellRulesPermissionChangeRequest(record);
    }
    if (record.kind === "providerNative") {
      return this.normalizeProviderNativePermissionChangeRequest(record);
    }
    if (record.kind === "portable" || Array.isArray(record.permissions)) {
      return this.normalizePortablePermissionChangeRequest(record);
    }
    throw new Error("Permission change request has an unsupported kind.");
  }

  private normalizePortablePermissionChangeRequest(record: Record<string, unknown>): ChatPermissionChangeRequest {
    if (!Array.isArray(record.permissions) || record.permissions.length === 0) {
      throw new Error("Permission change request needs at least one permission.");
    }
    const permissions = new Set<ChatPermissionGrant>();
    for (const permission of record.permissions) {
      if (permission === "workspaceWrite" || permission === "webAccess" || permission === "repoRead") {
        permissions.add(permission);
      } else {
        throw new Error(`Unsupported permission request: ${String(permission)}.`);
      }
    }
    return {
      kind: "portable",
      reason: this.normalizePermissionChangeReason(record.reason),
      permissions: Array.from(permissions)
    };
  }

  private normalizeShellRulesPermissionChangeRequest(record: Record<string, unknown>): ChatPermissionChangeRequest {
    if (!Array.isArray(record.rules) || record.rules.length === 0) {
      throw new Error("Shell permission request needs at least one rule.");
    }
    const rules: ChatShellPermissionRule[] = [];
    const seen = new Set<string>();
    for (const item of record.rules) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Shell permission rules must be objects.");
      }
      const candidate = item as Partial<ChatShellPermissionRule>;
      const action = candidate.action === "allow" || candidate.action === "ask" || candidate.action === "deny"
        ? candidate.action
        : undefined;
      const match = candidate.match === "exact" || candidate.match === "prefix"
        ? candidate.match
        : undefined;
      const pattern = typeof candidate.pattern === "string" ? candidate.pattern.trim() : "";
      if (!action || !match || pattern.length > CHAT_SHELL_RULE_PATTERN_MAX_LENGTH || !isChatShellPermissionPatternSafe(pattern)) {
        throw new Error("Shell permission rules need action, match, and a safe command pattern.");
      }
      const key = this.shellPermissionRuleKey({ action, match, pattern });
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rules.push({ action, match, pattern });
    }
    if (rules.length === 0) {
      throw new Error("Shell permission request needs at least one unique rule.");
    }
    return {
      kind: "shellRules",
      reason: this.normalizePermissionChangeReason(record.reason),
      rules
    };
  }

  private normalizeProviderNativePermissionChangeRequest(record: Record<string, unknown>): ChatPermissionChangeRequest {
    if (record.provider !== "claude-code") {
      throw new Error("Provider-native permission requests currently support only claude-code.");
    }
    if (!Array.isArray(record.allowedTools) || record.allowedTools.length === 0) {
      throw new Error("Provider-native permission request needs at least one allowed tool token.");
    }
    const allowedTools: string[] = [];
    const seen = new Set<string>();
    for (const item of record.allowedTools) {
      if (typeof item !== "string") {
        throw new Error("Provider-native allowed tool tokens must be strings.");
      }
      const token = item.trim();
      if (!token || token.length > CHAT_PROVIDER_NATIVE_ALLOWED_TOOL_MAX_LENGTH) {
        throw new Error("Provider-native allowed tool tokens must be non-empty and reasonably short.");
      }
      if (seen.has(token)) {
        continue;
      }
      seen.add(token);
      allowedTools.push(token);
    }
    if (allowedTools.length === 0) {
      throw new Error("Provider-native permission request needs at least one unique allowed tool token.");
    }
    return {
      kind: "providerNative",
      reason: this.normalizePermissionChangeReason(record.reason),
      provider: "claude-code",
      allowedTools
    };
  }

  private normalizePermissionChangeReason(reason: unknown): string | undefined {
    return typeof reason === "string" ? reason.trim().slice(0, 500) || undefined : undefined;
  }

  private preparePermissionChange(
    requester: ChatParticipant | undefined,
    request: ChatAppToolApprovalRequest
  ): PreparedPermissionChange {
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }
    if (!this.isPermissionChangeRequest(request)) {
      throw new Error("Permission approval request is invalid.");
    }
    const normalizedRequest = this.normalizePermissionChangeRequest(request);
    const mode = normalizeChatAgentMode(requester.agentMode);
    if (mode === "plan" && normalizedRequest.kind === "portable" && normalizedRequest.permissions.includes("workspaceWrite")) {
      throw new Error("Plan mode blocks file edits for this participant. Switch the participant to default or auto mode before granting edit access.");
    }
    if (mode === "plan" && normalizedRequest.kind === "shellRules") {
      throw new Error("Plan mode blocks shell commands for this participant. Switch the participant to default or auto mode before granting shell access.");
    }
    if (mode === "plan" && normalizedRequest.kind === "providerNative") {
      throw new Error("Plan mode blocks provider-native tool grants for this participant. Switch the participant to default or auto mode before granting provider-native access.");
    }
    const current = normalizeChatAgentPermissions(requester.permissions);
    if (normalizedRequest.kind === "portable") {
      const portablePermissions = normalizedRequest.permissions.filter((permission) => !current[permission]);
      const summaryPermissions = portablePermissions.length > 0 ? portablePermissions : normalizedRequest.permissions;
      return {
        request: normalizedRequest,
        portablePermissions,
        shellRules: [],
        providerNativeAllowedTools: [],
        summary: `Grant @${requester.handle} ${this.formatPermissionGrantList(summaryPermissions)}`
      };
    }
    if (normalizedRequest.kind === "shellRules") {
      for (const rule of normalizedRequest.rules) {
        if (this.isDeniedShellPermissionRule(rule)) {
          throw new Error(`Shell permission rule is too broad: ${rule.pattern}.`);
        }
      }
      const currentRuleKeys = current.shell.enabled
        ? new Set(current.shell.rules.map((rule) => this.shellPermissionRuleKey(rule)))
        : new Set<string>();
      const shellRules = normalizedRequest.rules.filter((rule) => !currentRuleKeys.has(this.shellPermissionRuleKey(rule)));
      const summaryRules = shellRules.length > 0 ? shellRules : normalizedRequest.rules;
      return {
        request: normalizedRequest,
        portablePermissions: [],
        shellRules,
        providerNativeAllowedTools: [],
        summary: `Grant @${requester.handle} ${this.formatShellPermissionRuleList(summaryRules)}`
      };
    }
    if (normalizedRequest.provider !== requester.kind) {
      throw new Error("Provider-native Claude grants can only be approved for Claude Code participants.");
    }
    for (const token of normalizedRequest.allowedTools) {
      if (this.isDeniedProviderNativeAllowedTool(token)) {
        throw new Error(`Provider-native allowed tool token is too broad: ${token}.`);
      }
    }
    const currentAllowedTools = new Set(current.providerNative?.["claude-code"]?.allowedTools ?? []);
    const providerNativeAllowedTools = normalizedRequest.allowedTools.filter((token) => !currentAllowedTools.has(token));
    const summaryAllowedTools = providerNativeAllowedTools.length > 0 ? providerNativeAllowedTools : normalizedRequest.allowedTools;
    return {
      request: normalizedRequest,
      portablePermissions: [],
      shellRules: [],
      providerNativeAllowedTools,
      summary: `Grant @${requester.handle} ${this.formatProviderNativeAllowedToolList(summaryAllowedTools)}`
    };
  }

  private applyPreparedPermissionChange(
    conversation: Conversation,
    requesterParticipantId: string,
    prepared: PreparedPermissionChange
  ): ChatParticipant {
    const participants = this.chatParticipants(conversation);
    const target = participants.find((participant) => participant.id === requesterParticipantId);
    if (!target) {
      throw new Error("The requesting participant is no longer in this chat.");
    }
    const nextPermissions = this.applyPermissionChangeToPermissions(
      normalizeChatAgentPermissions(target.permissions),
      prepared.request
    );
    const nextParticipant: ChatParticipant = {
      ...target,
      permissions: nextPermissions
    };
    conversation.metadata = {
      ...conversation.metadata,
      participants: participants.map((participant) => participant.id === target.id ? nextParticipant : participant)
    };
    return nextParticipant;
  }

  private normalizeParticipantRequest(raw: unknown): {
    requests: ChatParticipantRequestInput[];
    timeoutMs: number;
    resumeRequester: boolean;
  } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Participant request must be an object.");
    }
    const record = raw as { requests?: unknown; timeoutMs?: unknown; resumeRequester?: unknown };
    if (!Array.isArray(record.requests) || record.requests.length === 0) {
      throw new Error("Participant request needs at least one target.");
    }
    if (record.requests.length > CHAT_PARTICIPANT_REQUEST_MAX_ITEMS) {
      throw new Error(`Participant request can target at most ${CHAT_PARTICIPANT_REQUEST_MAX_ITEMS} participants.`);
    }
    const requests: ChatParticipantRequestInput[] = [];
    for (const item of record.requests) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Each participant request item must be an object.");
      }
      const candidate = item as { target?: unknown; prompt?: unknown; reason?: unknown };
      const target = typeof candidate.target === "string" ? candidate.target.trim().replace(/^@/, "") : "";
      const prompt = typeof candidate.prompt === "string" ? candidate.prompt.trim() : "";
      if (!HANDLE_PATTERN.test(target)) {
        throw new Error(`Invalid participant target: ${String(candidate.target ?? "")}.`);
      }
      if (!prompt) {
        throw new Error(`Participant request for @${target} needs a prompt.`);
      }
      requests.push({
        target,
        prompt: prompt.slice(0, 2000),
        reason: typeof candidate.reason === "string" ? candidate.reason.trim().slice(0, 500) || undefined : undefined
      });
    }
    return {
      requests,
      timeoutMs: this.optionalBoundedPositiveInteger(
        record.timeoutMs,
        "timeoutMs",
        CHAT_PARTICIPANT_REQUEST_WAIT_DEFAULT_MS,
        CHAT_PARTICIPANT_REQUEST_WAIT_MAX_MS
      ),
      resumeRequester: typeof record.resumeRequester === "boolean" ? record.resumeRequester : true
    };
  }

  private prepareParticipantRequest(
    conversation: Conversation,
    requester: ChatParticipant,
    normalized: { requests: ChatParticipantRequestInput[]; timeoutMs: number; resumeRequester: boolean },
    actor: ChatAppMcpActor,
    source: "mcp" | "inferred",
    options: { ignoreApprovalPolicies?: boolean } = {}
  ): PreparedParticipantRequest {
    const depth = (actor.participantRequestDepth ?? 0) + 1;
    const limitError = this.participantRequestLimitError(conversation, requester, actor, depth);
    if (limitError) {
      throw new Error(limitError);
    }
    const participants = this.chatParticipants(conversation);
    const targets = new Map<string, ChatParticipant>();
    const requests: ChatParticipantRequestInput[] = [];
    for (const request of normalized.requests) {
      const target = participants.find((participant) => participant.handle.toLowerCase() === request.target.toLowerCase());
      if (!target) {
        throw new Error(`No participant named @${request.target}.`);
      }
      if (target.id === requester.id) {
        throw new Error("A participant cannot request itself.");
      }
      if (targets.has(target.id)) {
        continue;
      }
      targets.set(target.id, target);
      requests.push({ ...request, target: target.handle });
    }
    if (targets.size === 0) {
      throw new Error("Participant request did not include any runnable targets.");
    }

    const now = new Date().toISOString();
    const batchId = randomUUID();
    const items: ChatParticipantRequestItem[] = Array.from(targets.values()).map((target) => {
      const request = requests.find((item) => item.target.toLowerCase() === target.handle.toLowerCase());
      return {
        targetParticipantId: target.id,
        targetHandle: target.handle,
        prompt: request?.prompt ?? "",
        reason: request?.reason,
        status: !options.ignoreApprovalPolicies && this.matchingAppToolApprovalPolicy(conversation, requester, APP_CHAT_REQUEST_PARTICIPANTS_TOOL, "participants.request", target.id)
          ? "running"
          : "pending_approval",
        createdAt: now,
        updatedAt: now
      };
    });
    const batch: ChatParticipantRequestBatch = {
      id: batchId,
      requesterParticipantId: requester.id,
      requesterHandle: requester.handle,
      source,
      resumeRequester: source === "inferred" ? true : normalized.resumeRequester,
      status: this.rollupParticipantRequestStatus(items),
      depth,
      createdAt: now,
      updatedAt: now,
      triggerMessageId: actor.triggerMessageId,
      items
    };
    const requestMessage = this.message(
      "participant",
      this.formatParticipantRequestMessage(requester.handle, items),
      { id: requester.id, kind: requester.kind, label: `@${requester.handle}`, model: requester.model },
      {
        threadId: actor.triggerThreadId ?? actor.triggerMessageId ?? batchId,
        parentMessageId: actor.triggerMessageId,
        chatThreadRootId: actor.triggerChatThreadRootId,
        sourceMessageId: actor.triggerMessageId,
        participantRequest: batch
      }
    );
    const request: ChatParticipantRequestApprovalRequest = {
      requests,
      resumeRequester: batch.resumeRequester,
      source,
      requestMessageId: requestMessage.id,
      batchId
    };
    return {
      request,
      requester,
      targets: Array.from(targets.values()),
      batch,
      requestMessage,
      summary: this.participantRequestSummary(requester.handle, Array.from(targets.values()).map((target) => target.handle)),
      timeoutMs: normalized.timeoutMs
    };
  }

  private participantRequestLimitError(
    conversation: Conversation,
    requester: ChatParticipant,
    actor: ChatAppMcpActor,
    depth: number
  ): string | undefined {
    if (depth > CHAT_PARTICIPANT_REQUEST_MAX_DEPTH) {
      return `max depth (${CHAT_PARTICIPANT_REQUEST_MAX_DEPTH}) reached`;
    }
    const sameTurnMcpBatches = actor.triggerMessageId
      ? this.participantRequestBatches(conversation).filter((batch) =>
          batch.requesterParticipantId === requester.id &&
          batch.triggerMessageId === actor.triggerMessageId &&
          batch.source === "mcp"
        )
      : [];
    if (sameTurnMcpBatches.some((batch) => this.participantRequestHasUnfinishedItems(batch))) {
      return "one active request batch is already attached to this requester turn";
    }
    if (sameTurnMcpBatches.length >= CHAT_PARTICIPANT_REQUEST_MAX_BATCHES_PER_TURN) {
      return `participant request turn limit (${CHAT_PARTICIPANT_REQUEST_MAX_BATCHES_PER_TURN}) reached`;
    }
    const threshold = Date.now() - CHAT_PARTICIPANT_REQUEST_RATE_WINDOW_MS;
    const recent = this.participantRequestBatches(conversation).filter((batch) => Date.parse(batch.createdAt) >= threshold);
    if (recent.length >= CHAT_PARTICIPANT_REQUEST_RATE_LIMIT) {
      return `participant request rate limit (${CHAT_PARTICIPANT_REQUEST_RATE_LIMIT}/minute) reached`;
    }
    return undefined;
  }

  private participantRequestSummary(requesterHandle: string, targetHandles: string[]): string {
    return `@${requesterHandle} asks ${this.formatHandleList(targetHandles.map((handle) => `@${handle}`))}`;
  }

  private participantRequestApprovalTargetIds(
    conversation: Conversation,
    request: ChatParticipantRequestApprovalRequest
  ): string[] {
    const participants = this.chatParticipants(conversation);
    const ids: string[] = [];
    for (const item of request.requests) {
      const targetHandle = item.target.replace(/^@/, "");
      const target = participants.find((participant) => participant.handle.toLowerCase() === targetHandle.toLowerCase());
      if (target && !ids.includes(target.id)) {
        ids.push(target.id);
      }
    }
    return ids;
  }

  private applyParticipantRequestApprovalDecision(
    conversation: Conversation,
    approval: ChatAppToolApproval,
    decision: "approved" | "denied",
    _scope?: ChatAppToolApprovalScope
  ): void {
    if (!this.isParticipantRequestApprovalRequest(approval.request) || !approval.request.requestMessageId) {
      return;
    }
    const targetIds = new Set(this.participantRequestApprovalTargetIds(conversation, approval.request));
    const now = new Date().toISOString();
    this.updateParticipantRequestBatch(conversation, approval.request.requestMessageId, (batch) => {
      const items = batch.items.map((item) => {
        if (!targetIds.has(item.targetParticipantId) || item.status !== "pending_approval") {
          return item;
        }
        return {
          ...item,
          status: decision === "approved" ? "running" as const : "denied" as const,
          updatedAt: now
        };
      });
      return {
        ...batch,
        items,
        status: this.rollupParticipantRequestStatus(items),
        updatedAt: now
      };
    });
  }

  private formatParticipantRequestMessage(_requesterHandle: string, items: ChatParticipantRequestItem[]): string {
    return items.map((item) => `@${item.targetHandle} ${this.participantRequestPromptForTarget(item.prompt)}`.trim()).join("\n");
  }

  private rollupParticipantRequestStatus(items: ChatParticipantRequestItem[], forced?: ChatParticipantRequestStatus): ChatParticipantRequestStatus {
    if (forced) {
      return forced;
    }
    if (items.some((item) => item.status === "pending_approval")) {
      return "pending_approval";
    }
    if (items.some((item) => item.status === "running")) {
      return "running";
    }
    if (items.some((item) => item.status === "resuming_requester")) {
      return "resuming_requester";
    }
    for (const status of ["failed", "denied", "interrupted", "completed", "answered"] as ChatParticipantRequestStatus[]) {
      if (items.some((item) => item.status === status)) {
        return status;
      }
    }
    return "completed";
  }

  private updateParticipantRequestBatch(
    conversation: Conversation,
    requestMessageId: string,
    update: (batch: ChatParticipantRequestBatch) => ChatParticipantRequestBatch
  ): ChatParticipantRequestBatch | undefined {
    let updated: ChatParticipantRequestBatch | undefined;
    conversation.messages = conversation.messages.map((message) => {
      if (message.id !== requestMessageId || !message.metadata?.participantRequest) {
        return message;
      }
      updated = update(message.metadata.participantRequest);
      return {
        ...message,
        metadata: {
          ...message.metadata,
          participantRequest: updated
        }
      };
    });
    return updated;
  }

  private startParticipantRequestRunner(
    conversationId: string,
    requestMessageId: string,
    runId: string,
    depth: number
  ): Promise<ParticipantRequestRunResult> {
    const existing = this.participantRequestRunners.get(requestMessageId);
    if (existing) {
      return existing;
    }
    this.incrementBackgroundRunner(conversationId);
    const runner = this.runParticipantRequest(conversationId, requestMessageId, runId, depth)
      .finally(() => {
        this.participantRequestRunners.delete(requestMessageId);
        this.decrementBackgroundRunner(conversationId);
      });
    this.participantRequestRunners.set(requestMessageId, runner);
    return runner;
  }

  private async runParticipantRequest(
    conversationId: string,
    requestMessageId: string,
    runId: string,
    depth: number
  ): Promise<ParticipantRequestRunResult> {
    const warnings: string[] = [];
    const conversation = await this.requireChat(conversationId);
    const requestMessage = conversation.messages.find((message) => message.id === requestMessageId);
    const batch = requestMessage?.metadata?.participantRequest;
    if (!requestMessage || !batch) {
      throw new Error("Participant request message was not found.");
    }
    const participants = this.chatParticipants(conversation);
    const runnableItems = batch.items.filter((item) => item.status === "running");
    const replies: ParticipantRequestRunResult["replies"] = [];
    await Promise.all(runnableItems.map(async (item) => {
      const target = participants.find((participant) => participant.id === item.targetParticipantId);
      if (!target) {
        const now = new Date().toISOString();
        this.updateParticipantRequestBatch(conversation, requestMessageId, (current) => ({
          ...current,
          items: current.items.map((candidate) => candidate.targetParticipantId === item.targetParticipantId
            ? { ...candidate, status: "failed", error: "Target participant is no longer in this chat.", updatedAt: now }
            : candidate),
          updatedAt: now
        }));
        return;
      }
      try {
        const targetTriggerMessage: ChatMessage = {
          ...requestMessage,
          metadata: {
            ...requestMessage.metadata,
            chatThreadRootId: requestMessage.metadata?.chatThreadRootId ?? requestMessage.id
          }
        };
        const messages = await this.runParticipantTurnSerialized(conversation, target, targetTriggerMessage, runId, undefined, undefined, {
          warnings,
          participantRequestDepth: depth,
          participantRequestBatchId: batch.id
        });
        await this.refreshStoredChatState(conversation);
        this.appendParticipantTurnMessages(conversation, target, messages, {
          runId,
          triggerMessageId: targetTriggerMessage.id,
          participantRequestBatchId: batch.id
        });
        const reply = messages[0];
        const waitingOnPermissionApproval = this.hasPendingPermissionApprovalForParticipantTurn(
          conversation,
          target,
          requestMessage.id,
          batch.id
        );
        const now = new Date().toISOString();
        this.updateParticipantRequestBatch(conversation, requestMessageId, (current) => ({
          ...current,
          items: current.items.map((candidate) => candidate.targetParticipantId === item.targetParticipantId
            ? {
                ...candidate,
                status: waitingOnPermissionApproval
                  ? "running"
                  : reply?.status === "error"
                    ? "failed"
                    : "answered",
                replyMessageId: reply?.id,
                error: !waitingOnPermissionApproval && reply?.status === "error" ? reply.content : undefined,
                updatedAt: now
              }
            : candidate),
          updatedAt: now
        }));
        replies.push({
          targetHandle: target.handle,
          messageId: reply?.id,
          content: reply?.content,
          error: reply?.status === "error" ? reply.content : undefined
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const now = new Date().toISOString();
        this.updateParticipantRequestBatch(conversation, requestMessageId, (current) => ({
          ...current,
          items: current.items.map((candidate) => candidate.targetParticipantId === item.targetParticipantId
            ? { ...candidate, status: "failed", error: message, updatedAt: now }
            : candidate),
          updatedAt: now
        }));
        replies.push({ targetHandle: target.handle, error: message });
      }
      conversation.updatedAt = new Date().toISOString();
      this.queueSnapshot(conversation);
    }));
    const updatedBatch = this.updateParticipantRequestBatch(conversation, requestMessageId, (current) => {
      const status = this.rollupParticipantRequestStatus(current.items);
      return {
        ...current,
        status: status === "answered" ? "answered" : status,
        updatedAt: new Date().toISOString()
      };
    }) ?? batch;
    conversation.updatedAt = new Date().toISOString();
    await this.ensureHistoryFiles(conversation);
    await this.saveConversation(conversation);
    return { batch: updatedBatch, replies };
  }

  private async awaitParticipantRequestRunner(
    runner: Promise<ParticipantRequestRunResult>,
    timeoutMs: number
  ): Promise<{ timedOut: true } | { timedOut: false; result: ParticipantRequestRunResult }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        runner.then((result) => ({ timedOut: false as const, result })),
        new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
          timer.unref();
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async autoResumePermissionApproval(
    conversationId: string,
    approvalId: string,
    progress?: ProgressCallback
  ): Promise<void> {
    const approvalResumeKey = `approval:${approvalId}`;
    if (this.permissionApprovalAutoResumes.has(approvalResumeKey)) {
      return;
    }
    this.permissionApprovalAutoResumes.add(approvalResumeKey);
    let triggerResumeKey: string | undefined;
    try {
      await this.withChatRunLock(conversationId, async () => {
        const conversation = await this.requireChat(conversationId);
        const approval = this.chatAppToolApprovals(conversation).find((item) => item.id === approvalId);
        if (
          !approval ||
          approval.status !== "approved" ||
          approval.toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL ||
          !approval.resumeContext ||
          !this.isPermissionChangeRequest(approval.request)
        ) {
          return;
        }
        if (this.hasPendingPermissionApprovalForResume(conversation, approval)) {
          return;
        }
        const requester = this.chatParticipants(conversation).find((participant) => participant.id === approval.requesterParticipantId);
        const trigger = conversation.messages.find((message) => message.id === approval.resumeContext?.triggerMessageId);
        if (!requester || !trigger) {
          return;
        }
        const participantRequestMessage = approval.resumeContext.participantRequestBatchId
          ? this.participantRequestMessageForResumeContext(
              conversation,
              approval.resumeContext.triggerMessageId,
              approval.resumeContext.participantRequestBatchId
            )
          : undefined;
        const participantRequestBatch = participantRequestMessage?.metadata?.participantRequest;
        triggerResumeKey = `trigger:${conversation.id}:${approval.requesterParticipantId}:${trigger.id}`;
        if (this.permissionApprovalAutoResumes.has(triggerResumeKey)) {
          return;
        }
        this.permissionApprovalAutoResumes.add(triggerResumeKey);
        const resumeRunId = approval.resumeContext.runId || randomUUID();
        const participantLabel = `@${requester.handle}`;
        this.emitProgress(resumeRunId, progress, "initial", `Resuming ${participantLabel} after permission approval.`, {
          participantLabel
        });
        const now = new Date().toISOString();
        conversation.messages.push(this.message(
          "system",
          `Auto-resumed @${requester.handle} after permission approval.`,
          undefined,
          {
            threadId: trigger.metadata?.threadId ?? trigger.id,
            parentMessageId: trigger.id,
            chatThreadRootId: trigger.metadata?.chatThreadRootId,
            sourceMessageId: trigger.id
          }
        ));
        await this.beginChatRun(conversation, resumeRunId);
        try {
          const messages = await this.runParticipantTurnSerialized(conversation, requester, trigger, resumeRunId, undefined, progress, {
            warnings: [],
            participantRequestDepth: participantRequestBatch?.depth,
            participantRequestBatchId: participantRequestBatch?.id
          });
          await this.refreshStoredChatState(conversation);
          this.appendParticipantTurnMessages(conversation, requester, messages, {
            runId: resumeRunId,
            triggerMessageId: trigger.id,
            participantRequestBatchId: participantRequestBatch?.id
          });
          const participantRequestResumeMessageId = participantRequestMessage && participantRequestBatch
            ? this.applyPermissionResumeToParticipantRequest(conversation, participantRequestMessage.id, participantRequestBatch.id, requester, messages)
            : undefined;
          conversation.updatedAt = new Date().toISOString();
          this.queueSnapshot(conversation);
          await this.ensureHistoryFiles(conversation);
          this.emitProgress(resumeRunId, progress, "done", "Permission approval resume finished.");
          if (participantRequestResumeMessageId) {
            void this.autoResumeParticipantRequest(conversation.id, participantRequestResumeMessageId, progress).catch((error) => {
              void this.debugLogs.write("chat.permission-approval.participant-request-auto-resume.error", {
                conversationId: conversation.id,
                requestMessageId: participantRequestResumeMessageId,
                approvalId: approval.id,
                message: error instanceof Error ? error.message : String(error)
              });
            });
          }
        } catch (error) {
          this.emitChatRunFailure(resumeRunId, progress, error);
          throw error;
        } finally {
          await this.endChatRun(conversation, resumeRunId);
        }
      });
    } finally {
      if (triggerResumeKey) {
        this.permissionApprovalAutoResumes.delete(triggerResumeKey);
      }
      this.permissionApprovalAutoResumes.delete(approvalResumeKey);
    }
  }

  private hasPendingPermissionApprovalForResume(conversation: Conversation, approval: ChatAppToolApproval): boolean {
    const triggerMessageId = approval.resumeContext?.triggerMessageId;
    if (!triggerMessageId) {
      return false;
    }
    return this.chatAppToolApprovals(conversation).some((item) =>
      item.id !== approval.id &&
      item.status === "pending" &&
      item.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
      item.requesterParticipantId === approval.requesterParticipantId &&
      item.resumeContext?.triggerMessageId === triggerMessageId
    );
  }

  private hasPendingPermissionApprovalForParticipantTurn(
    conversation: Conversation,
    participant: ChatParticipant,
    triggerMessageId: string,
    participantRequestBatchId?: string
  ): boolean {
    return this.chatAppToolApprovals(conversation).some((approval) =>
      approval.status === "pending" &&
      approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
      approval.requesterParticipantId === participant.id &&
      approval.resumeContext?.triggerMessageId === triggerMessageId &&
      (!participantRequestBatchId || approval.resumeContext?.participantRequestBatchId === participantRequestBatchId)
    );
  }

  private participantRequestMessageForResumeContext(
    conversation: Conversation,
    triggerMessageId: string,
    batchId: string
  ): ChatMessage | undefined {
    const triggerMessage = conversation.messages.find((message) => message.id === triggerMessageId);
    if (triggerMessage?.metadata?.participantRequest?.id === batchId) {
      return triggerMessage;
    }
    return conversation.messages.find((message) => message.metadata?.participantRequest?.id === batchId);
  }

  private applyPermissionResumeToParticipantRequest(
    conversation: Conversation,
    requestMessageId: string,
    batchId: string,
    target: ChatParticipant,
    messages: ChatMessage[]
  ): string | undefined {
    const reply = messages[0];
    const now = new Date().toISOString();
    const updatedBatch = this.updateParticipantRequestBatch(conversation, requestMessageId, (current) => {
      if (current.id !== batchId) {
        return current;
      }
      const items = current.items.map((item) => {
        if (item.targetParticipantId !== target.id) {
          return item;
        }
        return {
          ...item,
          status: reply?.status === "error" ? "failed" as const : "answered" as const,
          replyMessageId: reply?.id,
          error: reply?.status === "error" ? reply.content : undefined,
          updatedAt: now
        };
      });
      return {
        ...current,
        completedInToolCall: false,
        items,
        status: this.rollupParticipantRequestStatus(items),
        updatedAt: now
      };
    });
    if (!updatedBatch || updatedBatch.id !== batchId || !updatedBatch.resumeRequester || updatedBatch.autoResumeMessageId) {
      return undefined;
    }
    return this.participantRequestHasUnfinishedItems(updatedBatch) ? undefined : requestMessageId;
  }

  private async autoResumeParticipantRequest(conversationId: string, requestMessageId: string, progress?: ProgressCallback): Promise<void> {
    if (this.participantRequestAutoResumes.has(requestMessageId)) {
      return;
    }
    this.participantRequestAutoResumes.add(requestMessageId);
    try {
      await this.withChatRunLock(conversationId, async () => {
        const conversation = await this.requireChat(conversationId);
        const requestMessage = conversation.messages.find((message) => message.id === requestMessageId);
        const batch = requestMessage?.metadata?.participantRequest;
        if (!requestMessage || !batch || !batch.resumeRequester || batch.completedInToolCall || batch.autoResumeMessageId) {
          return;
        }
        if (this.participantRequestHasUnfinishedItems(batch)) {
          return;
        }
        if (batch.items.length > 0 && batch.items.every((item) => item.status === "denied")) {
          return;
        }
        const requester = this.chatParticipants(conversation).find((participant) => participant.id === batch.requesterParticipantId);
        if (!requester) {
          return;
        }
        const now = new Date().toISOString();
        this.updateParticipantRequestBatch(conversation, requestMessageId, (current) => ({
          ...current,
          status: "resuming_requester",
          updatedAt: now
        }));
        const trigger = this.message(
          "system",
          [
            `Auto-resumed @${requester.handle} after participant request.`,
            "Target replies/errors are in the transcript above. Continue from your request using the available answers and errors."
          ].join("\n"),
          undefined,
          {
            threadId: requestMessage.metadata?.threadId ?? requestMessage.id,
            parentMessageId: requestMessage.id,
            chatThreadRootId: requestMessage.metadata?.chatThreadRootId ?? requestMessage.id,
            sourceMessageId: requestMessage.id
          }
        );
        conversation.messages.push(trigger);
        const resumeRunId = randomUUID();
        await this.beginChatRun(conversation, resumeRunId);
        try {
          const messages = await this.runParticipantTurnSerialized(conversation, requester, trigger, resumeRunId, undefined, progress, {
            continuation: true,
            warnings: [],
            participantRequestDepth: batch.depth,
            participantRequestBatchId: batch.id
          });
          await this.refreshStoredChatState(conversation);
          this.appendParticipantTurnMessages(conversation, requester, messages, {
            runId: resumeRunId,
            triggerMessageId: trigger.id,
            participantRequestBatchId: batch.id
          });
          this.updateParticipantRequestBatch(conversation, requestMessageId, (current) => ({
            ...current,
            status: "completed",
            autoResumeMessageId: messages[0]?.id,
            updatedAt: new Date().toISOString()
          }));
          conversation.updatedAt = new Date().toISOString();
          this.queueSnapshot(conversation);
          await this.ensureHistoryFiles(conversation);
        } catch (error) {
          this.markParticipantRequestAutoResumeFailed(conversation, requestMessageId, error);
          this.emitChatRunFailure(resumeRunId, progress, error);
          throw error;
        } finally {
          await this.endChatRun(conversation, resumeRunId);
        }
      });
    } finally {
      this.participantRequestAutoResumes.delete(requestMessageId);
    }
  }

  private async runParticipantTurnSerialized(
    conversation: Conversation,
    participant: ChatParticipant,
    triggerMessage: ChatMessage,
    runId: string,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    options: {
      continuation?: boolean;
      warnings: string[];
      promptConversation?: Conversation;
      workspacePath?: string;
      participantRequestDepth?: number;
      participantRequestBatchId?: string;
    }
  ): Promise<ChatMessage[]> {
    const key = `${conversation.id}:${participant.id}`;
    const previous = this.participantTurnQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => current);
    this.participantTurnQueues.set(key, chained);
    await previous.catch(() => undefined);
    try {
      return await this.runParticipantTurn(conversation, participant, triggerMessage, runId, signal, progress, options);
    } finally {
      release();
      if (this.participantTurnQueues.get(key) === chained) {
        this.participantTurnQueues.delete(key);
      }
    }
  }

  private participantRequestToolResult(
    conversation: Conversation,
    requestMessageId: string,
    extra: Record<string, unknown>
  ): Record<string, unknown> {
    const message = conversation.messages.find((item) => item.id === requestMessageId);
    const batch = message?.metadata?.participantRequest;
    if (!batch) {
      return { ok: false, status: "failed", error: "Participant request was not found." };
    }
    return {
      ok: true,
      requestId: batch.id,
      requestMessageId,
      batch: this.participantRequestBatchForTool(conversation, batch),
      ...extra
    };
  }

  private participantRequestFailedToolResult(error: string): Record<string, unknown> {
    return {
      ok: false,
      status: "failed",
      error
    };
  }

  private participantRequestBatchForTool(conversation: Conversation, batch: ChatParticipantRequestBatch): Record<string, unknown> {
    return {
      id: batch.id,
      status: batch.status,
      source: batch.source,
      resumeRequester: batch.resumeRequester,
      requester: `@${batch.requesterHandle}`,
      items: batch.items.map((item) => {
        const reply = item.replyMessageId ? conversation.messages.find((message) => message.id === item.replyMessageId) : undefined;
        return {
          target: `@${item.targetHandle}`,
          prompt: item.prompt,
          reason: item.reason,
          status: item.status,
          replyMessageId: item.replyMessageId,
          reply: reply?.content,
          error: item.error
        };
      })
    };
  }

  private markOrphanedParticipantRequestInterrupted(message: ChatMessage): boolean {
    const batch = message.metadata?.participantRequest;
    if (!batch || (batch.status !== "running" && batch.status !== "resuming_requester")) {
      return false;
    }
    if (this.participantRequestRunners.has(message.id) || this.participantRequestAutoResumes.has(message.id)) {
      return false;
    }
    const now = new Date().toISOString();
    const nextItems = batch.items.map((item) =>
      item.status === "running" || item.status === "resuming_requester"
        ? { ...item, status: "interrupted" as ChatParticipantRequestStatus, updatedAt: now, error: item.error ?? "Request was interrupted before completion." }
        : item
    );
    message.metadata = {
      ...message.metadata,
      participantRequest: {
        ...batch,
        status: "interrupted",
        items: nextItems,
        updatedAt: now,
        error: batch.error ?? "Request was interrupted before completion."
      }
    };
    return true;
  }

  private markParticipantRequestAutoResumeFailed(conversation: Conversation, requestMessageId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.updateParticipantRequestBatch(conversation, requestMessageId, (batch) => ({
      ...batch,
      status: "failed",
      updatedAt: new Date().toISOString(),
      error: message || "Requester auto-resume failed before completion."
    }));
    conversation.updatedAt = new Date().toISOString();
  }

  private participantRequestBatches(conversation: Conversation): ChatParticipantRequestBatch[] {
    return conversation.messages
      .map((message) => message.metadata?.participantRequest)
      .filter((batch): batch is ChatParticipantRequestBatch => Boolean(batch));
  }

  private participantRequestHasUnfinishedItems(batch: ChatParticipantRequestBatch): boolean {
    return batch.items.some((item) =>
      item.status === "pending_approval" ||
      item.status === "running" ||
      item.status === "resuming_requester"
    );
  }

  private participantPermissionsForRun(
    conversation: Conversation,
    participant: ChatParticipant,
    oneTimeApprovals: ChatAppToolApproval[] = this.oneTimePermissionApprovalsForParticipant(conversation, participant),
    appliedOneTimeApprovalIds?: string[]
  ): ChatAgentPermissions {
    let permissions = normalizeChatAgentPermissions(participant.permissions);
    for (const approval of oneTimeApprovals) {
      if (!this.isPermissionChangeRequest(approval.request)) {
        continue;
      }
      try {
        permissions = this.applyPermissionChangeToPermissions(permissions, approval.request);
        appliedOneTimeApprovalIds?.push(approval.id);
      } catch (error) {
        void this.debugLogs.write("chat.permissions.once-overlay.invalid", {
          conversationId: conversation.id,
          approvalId: approval.id,
          participantId: participant.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return permissions;
  }

  private consumeOneTimePermissionApprovals(
    conversation: Conversation,
    participant: ChatParticipant,
    approvalIds: string[]
  ): void {
    if (approvalIds.length === 0) {
      return;
    }
    const approvalIdSet = new Set(approvalIds);
    const approvals = this.chatAppToolApprovals(conversation);
    const now = new Date().toISOString();
    let changed = false;
    const nextApprovals = approvals.map((approval) => {
      if (!approvalIdSet.has(approval.id) || !this.isUnconsumedOneTimePermissionApproval(approval, participant)) {
        return approval;
      }
      changed = true;
      return {
        ...approval,
        consumedAt: now,
        updatedAt: now
      };
    });
    if (!changed) {
      return;
    }
    conversation.metadata = {
      ...conversation.metadata,
      pendingAppToolApprovals: nextApprovals
    };
  }

  private oneTimePermissionApprovalsForParticipant(
    conversation: Conversation,
    participant: ChatParticipant
  ): ChatAppToolApproval[] {
    return this.chatAppToolApprovals(conversation).filter((approval) =>
      this.isUnconsumedOneTimePermissionApproval(approval, participant)
    );
  }

  private isUnconsumedOneTimePermissionApproval(
    approval: ChatAppToolApproval,
    participant: ChatParticipant
  ): boolean {
    return (
      approval.status === "approved" &&
      approval.approvalScope === "once" &&
      !approval.consumedAt &&
      approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
      approval.capability === "permissions.request" &&
      approval.requesterParticipantId === participant.id &&
      approval.requesterRoleConfigId === participant.roleConfigId &&
      this.isPermissionChangeRequest(approval.request)
    );
  }

  private preparedPermissionChangeHasAdditions(prepared: PreparedPermissionChange): boolean {
    return (
      prepared.portablePermissions.length > 0 ||
      prepared.shellRules.length > 0 ||
      prepared.providerNativeAllowedTools.length > 0
    );
  }

  private permissionChangeRequestCovers(existing: ChatPermissionChangeRequest, requested: ChatPermissionChangeRequest): boolean {
    try {
      const normalizedExisting = this.normalizePermissionChangeRequest(existing);
      const normalizedRequested = this.normalizePermissionChangeRequest(requested);
      if (normalizedExisting.kind !== normalizedRequested.kind) {
        return false;
      }
      if (normalizedRequested.kind === "portable") {
        return normalizedExisting.kind === "portable" &&
          normalizedRequested.permissions.every((permission) => normalizedExisting.permissions.includes(permission));
      }
      if (normalizedRequested.kind === "shellRules") {
        if (normalizedExisting.kind !== "shellRules") {
          return false;
        }
        const existingRules = new Set(normalizedExisting.rules.map((rule) => this.shellPermissionRuleKey(rule)));
        return normalizedRequested.rules.every((rule) => existingRules.has(this.shellPermissionRuleKey(rule)));
      }
      return normalizedExisting.kind === "providerNative" &&
        normalizedExisting.provider === normalizedRequested.provider &&
        normalizedRequested.allowedTools.every((token) => normalizedExisting.allowedTools.includes(token));
    } catch {
      return false;
    }
  }

  private applyPermissionChangeToPermissions(
    permissions: ChatAgentPermissions,
    request: ChatPermissionChangeRequest
  ): ChatAgentPermissions {
    const normalizedRequest = this.normalizePermissionChangeRequest(request);
    if (normalizedRequest.kind === "portable") {
      return {
        ...permissions,
        repoRead: permissions.repoRead || normalizedRequest.permissions.includes("repoRead"),
        workspaceWrite: permissions.workspaceWrite || normalizedRequest.permissions.includes("workspaceWrite"),
        webAccess: permissions.webAccess || normalizedRequest.permissions.includes("webAccess")
      };
    }
    if (normalizedRequest.kind === "shellRules") {
      return {
        ...permissions,
        shell: {
          enabled: true,
          rules: this.mergeShellPermissionRules(permissions.shell.rules, normalizedRequest.rules)
        }
      };
    }
    const allowedTools = this.mergeProviderNativeAllowedTools(
      permissions.providerNative?.["claude-code"]?.allowedTools ?? [],
      normalizedRequest.allowedTools
    );
    return {
      ...permissions,
      providerNative: {
        ...permissions.providerNative,
        "claude-code": {
          allowedTools
        }
      }
    };
  }

  private mergeShellPermissionRules(
    existing: ChatShellPermissionRule[],
    additions: ChatShellPermissionRule[]
  ): ChatShellPermissionRule[] {
    const rules = existing.map((rule) => ({ ...rule }));
    const seen = new Set(rules.map((rule) => this.shellPermissionRuleKey(rule)));
    for (const rule of additions) {
      const key = this.shellPermissionRuleKey(rule);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rules.push({ ...rule });
    }
    return rules;
  }

  private mergeProviderNativeAllowedTools(existing: string[], additions: string[]): string[] {
    const allowedTools = [...existing];
    const seen = new Set(allowedTools);
    for (const token of additions) {
      if (seen.has(token)) {
        continue;
      }
      seen.add(token);
      allowedTools.push(token);
    }
    return allowedTools;
  }

  private shellPermissionRuleKey(rule: ChatShellPermissionRule): string {
    return `${rule.action}\0${rule.match}\0${rule.pattern}`;
  }

  private isDeniedShellPermissionRule(rule: ChatShellPermissionRule): boolean {
    // Provider-native wildcard tokens such as Bash(*) are rejected before this path;
    // shell rules carry the command pattern only.
    return rule.pattern.trim() === "*";
  }

  private isDeniedProviderNativeAllowedTool(token: string): boolean {
    const trimmed = token.trim();
    return (
      trimmed === "*" ||
      trimmed === "Bash(*)" ||
      trimmed === "Bash(*:*)" ||
      /^mcp__.+__\*$/.test(trimmed)
    );
  }

  private formatPermissionChangeGrantList(request: ChatPermissionChangeRequest): string {
    if (request.kind === "portable") {
      return this.formatPermissionGrantList(request.permissions);
    }
    if (request.kind === "shellRules") {
      return this.formatShellPermissionRuleList(request.rules);
    }
    return this.formatProviderNativeAllowedToolList(request.allowedTools);
  }

  private formatPermissionGrantList(permissions: ChatPermissionGrant[]): string {
    const labels = permissions.map((permission) => {
      if (permission === "repoRead") {
        return "repository read access";
      }
      return permission === "workspaceWrite" ? "file editing" : "web access";
    });
    return this.formatHandleList(labels);
  }

  private formatShellPermissionRuleList(rules: ChatShellPermissionRule[]): string {
    const labels = rules.map((rule) => `shell ${rule.action} ${rule.match} ${JSON.stringify(rule.pattern)}`);
    return this.formatHandleList(labels);
  }

  private formatProviderNativeAllowedToolList(allowedTools: string[]): string {
    const labels = allowedTools.map((token) => `Claude native tool ${JSON.stringify(token)}`);
    return this.formatHandleList(labels);
  }

  private newAppToolApproval(
    conversation: Conversation,
    requester: ChatParticipant,
    toolName: string,
    capability: ChatAppToolCapability,
    request: ChatAppToolApprovalRequest,
    summary: string,
    status: ChatAppToolApproval["status"]
  ): ChatAppToolApproval {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      conversationId: conversation.id,
      requesterParticipantId: requester.id,
      requesterHandle: requester.handle,
      requesterRoleConfigId: requester.roleConfigId,
      toolName,
      capability,
      status,
      request,
      summary,
      createdAt: now,
      updatedAt: now
    };
  }

  private upsertAppToolApproval(conversation: Conversation, approval: ChatAppToolApproval): void {
    const approvals = this.chatAppToolApprovals(conversation);
    conversation.metadata = {
      ...conversation.metadata,
      pendingAppToolApprovals: approvals.some((item) => item.id === approval.id)
        ? approvals.map((item) => (item.id === approval.id ? approval : item))
        : [...approvals, approval]
    };
  }

  private matchingAppToolApprovalPolicy(
    conversation: Conversation,
    participant: ChatParticipant,
    toolName: string,
    capability: ChatAppToolCapability,
    targetParticipantId?: string
  ): ChatAppToolApprovalPolicy | undefined {
    return this.chatAppToolApprovalPolicies(conversation).find((policy) =>
      policy.participantId === participant.id &&
      policy.roleConfigId === participant.roleConfigId &&
      policy.toolName === toolName &&
      policy.capability === capability &&
      (targetParticipantId ? policy.targetParticipantId === targetParticipantId : !policy.targetParticipantId) &&
      policy.scope === "chat"
    );
  }

  private upsertAppToolApprovalPolicy(conversation: Conversation, policy: ChatAppToolApprovalPolicy): void {
    const policies = this.chatAppToolApprovalPolicies(conversation);
    const existing = policies.find((item) =>
      item.participantId === policy.participantId &&
      item.roleConfigId === policy.roleConfigId &&
      item.toolName === policy.toolName &&
      item.capability === policy.capability &&
      item.targetParticipantId === policy.targetParticipantId &&
      item.scope === policy.scope
    );
    conversation.metadata = {
      ...conversation.metadata,
      appToolApprovalPolicies: existing
        ? policies.map((item) => (item.id === existing.id ? { ...item, updatedAt: policy.updatedAt } : item))
        : [...policies, policy]
    };
  }

  private pendingMentionsFromAgentReply(conversation: Conversation, sourceParticipant: ChatParticipant, content: string): ChatPendingMention[] {
    const participants = this.chatParticipants(conversation);
    const handles = this.extractParticipantRequestMentions(content);
    const mentions = new Map<string, ChatPendingMention>();
    for (const handle of handles) {
      const target = participants.find((participant) => participant.handle.toLowerCase() === handle.toLowerCase());
      if (!target || target.id === sourceParticipant.id) {
        continue;
      }
      mentions.set(target.id, {
        targetParticipantId: target.id,
        targetHandle: target.handle,
        status: "pending"
      });
    }
    return Array.from(mentions.values());
  }

  private inferParticipantRequestTargets(
    conversation: Conversation,
    sourceParticipant: ChatParticipant,
    content: string
  ): Array<{ targetHandle: string; snippet: string }> {
    const participants = this.chatParticipants(conversation)
      .filter((participant) => participant.id !== sourceParticipant.id);
    const cleaned = this.stripInferenceIgnoredText(content);
    const inferred: Array<{ targetHandle: string; snippet: string }> = [];
    for (const participant of participants) {
      const pattern = new RegExp(`@${this.escapeRegExp(participant.handle)}\\b`, "i");
      const match = cleaned.match(pattern);
      if (!match || typeof match.index !== "number") {
        continue;
      }
      const start = Math.max(0, match.index - 80);
      const end = Math.min(cleaned.length, match.index + participant.handle.length + 140);
      const snippet = cleaned.slice(start, end).replace(/\s+/g, " ").trim();
      if (this.isActionableParticipantMention(snippet, participant.handle)) {
        inferred.push({ targetHandle: participant.handle, snippet });
      }
      if (inferred.length >= CHAT_PARTICIPANT_REQUEST_MAX_ITEMS) {
        break;
      }
    }
    return inferred;
  }

  private stripInferenceIgnoredText(content: string): string {
    return this.withoutFencedCode(content)
      .replace(/`[^`\n]+`/g, "")
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith(">") &&
          !/^participant requests\s*:/i.test(trimmed) &&
          !/^return to requester after replies\s*:/i.test(trimmed) &&
          !/^(?:user|system)\s*:\s+/i.test(trimmed)
        );
      })
      .join("\n");
  }

  private isActionableParticipantMention(snippet: string, handle: string): boolean {
    const escaped = this.escapeRegExp(handle);
    const nonAction = [
      new RegExp(`\\b(?:as|per|from|according to|quoting|citing)\\s+@${escaped}\\b`, "i"),
      new RegExp(`\\b(?:thanks|thank you|agree with|disagree with|good catch)\\s+@${escaped}\\b`, "i"),
      new RegExp(`@${escaped}\\b\\s+(?:said|noted|wrote|answered|suggested|recommended|agreed|confirmed|covered)\\b`, "i")
    ];
    if (nonAction.some((pattern) => pattern.test(snippet))) {
      return false;
    }
    const action = [
      new RegExp(`@${escaped}\\b[^.!?\\n]{0,120}\\?`, "i"),
      new RegExp(`@${escaped}\\b\\s*(?:,|:|—|-)\\s*(?:your move|thoughts?|please|can|could|would|will|check|confirm|review|verify|validate|concur|respond|answer|comment|clarify)\\b`, "i"),
      new RegExp(`\\b(?:can|could|please|pls|would|will)\\s+@${escaped}\\b`, "i"),
      new RegExp(`@${escaped}\\b[^.!?\\n]{0,120}\\b(?:confirm|check|review|verify|validate|concur|respond|answer|comment|clarify)\\b`, "i"),
      new RegExp(`\\b(?:confirm|check|review|verify|validate|concur|respond|answer|comment|clarify)\\b[^.!?\\n]{0,120}@${escaped}\\b`, "i")
    ];
    return action.some((pattern) => pattern.test(snippet));
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private pendingChoiceFromAgentReply(content: string): ChatPendingChoice | undefined {
    const draft = this.extractUserChoiceDraft(content);
    if (!draft) {
      return undefined;
    }
    return {
      id: `choice-${randomUUID()}`,
      title: (draft.title || draft.question || "Choose an option").trim().slice(0, 120),
      question: (draft.question || draft.title || "Choose an option.").trim(),
      options: draft.options,
      recommendedOptionId: draft.recommendedOptionId,
      status: "pending",
      selectedAt: undefined
    };
  }

  private extractUserChoiceDraft(content: string): ChatChoiceDraft | undefined {
    const lines = this.withoutFencedCode(content).replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^\s*user choice\s*:\s*(.*)$/i);
      if (!match) {
        continue;
      }
      const blockLines: string[] = [];
      const inline = match[1].trim();
      if (inline && !/^none\.?$/i.test(inline)) {
        blockLines.push(`Q: ${inline}`);
      }
      for (let next = index + 1; next < lines.length; next += 1) {
        const trimmed = lines[next].trim();
        if (!trimmed) {
          if (blockLines.length > 0) {
            break;
          }
          continue;
        }
        if (/^#{1,6}\s+/.test(trimmed) || /^participant requests\s*:/i.test(trimmed) || /^return to requester after replies\s*:/i.test(trimmed)) {
          break;
        }
        if (/^user choice\s*:/i.test(trimmed)) {
          break;
        }
        if (this.isUserChoiceProtocolLine(trimmed)) {
          blockLines.push(trimmed);
          continue;
        }
        break;
      }
      const draft = this.parseUserChoiceBlock(blockLines);
      if (draft) {
        return draft;
      }
    }
    return undefined;
  }

  private isUserChoiceProtocolLine(line: string): boolean {
    const normalized = this.stripListMarker(line);
    return /^(?:T|TITLE|Q|QUESTION|R|RECOMMENDED|O\d+)\s*[:|]/i.test(normalized) || /^(?:[-*]|\d+[.)])\s+\S/.test(line);
  }

  private parseUserChoiceBlock(lines: string[]): ChatChoiceDraft | undefined {
    const draft: ChatChoiceDraft = { options: [] };
    let nextOptionIndex = 1;
    const usedOptionIds = new Set<string>();

    for (const line of lines) {
      const normalized = this.stripListMarker(line);
      if (!normalized) {
        continue;
      }
      const field = normalized.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*[:|]\s*(.*)$/);
      if (field) {
        const key = field[1].toUpperCase();
        const value = field[2].trim();
        if (!value) {
          continue;
        }
        if (key === "T" || key === "TITLE") {
          draft.title = value;
          continue;
        }
        if (key === "Q" || key === "QUESTION") {
          draft.question = value;
          continue;
        }
        if (key === "R" || key === "RECOMMENDED") {
          draft.recommendedOptionId = value;
          continue;
        }
        if (/^O\d+$/i.test(key)) {
          this.addChoiceOption(draft, key.toUpperCase(), value, usedOptionIds);
          nextOptionIndex = Math.max(nextOptionIndex, Number(key.slice(1)) + 1 || nextOptionIndex);
          continue;
        }
      }
      while (usedOptionIds.has(`O${nextOptionIndex}`)) {
        nextOptionIndex += 1;
      }
      this.addChoiceOption(draft, `O${nextOptionIndex}`, normalized, usedOptionIds);
      nextOptionIndex += 1;
    }

    if (draft.options.length < 2 || !(draft.question?.trim() || draft.title?.trim())) {
      return undefined;
    }
    draft.recommendedOptionId = this.resolveRecommendedChoiceOptionId(draft.recommendedOptionId, draft.options);
    return draft;
  }

  private addChoiceOption(draft: ChatChoiceDraft, optionId: string, value: string, usedOptionIds: Set<string>): void {
    const parsed = this.parseChoiceOptionText(value);
    if (!parsed.label) {
      return;
    }
    let id = optionId.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (!id || usedOptionIds.has(id)) {
      let index = draft.options.length + 1;
      while (usedOptionIds.has(`O${index}`)) {
        index += 1;
      }
      id = `O${index}`;
    }
    usedOptionIds.add(id);
    draft.options.push({ id, ...parsed });
  }

  private parseChoiceOptionText(value: string): { label: string; description?: string } {
    const parts = value.split(/\s+\|\s+/);
    const label = parts.shift()?.trim() ?? "";
    const description = parts.join(" | ").trim();
    return {
      label,
      description: description || undefined
    };
  }

  private resolveRecommendedChoiceOptionId(value: string | undefined, options: ChatChoiceOption[]): string | undefined {
    const normalized = value?.trim();
    if (!normalized) {
      return undefined;
    }
    const byId = options.find((option) => option.id.toLowerCase() === normalized.toLowerCase());
    if (byId) {
      return byId.id;
    }
    const byLabel = options.find((option) => option.label.toLowerCase() === normalized.toLowerCase());
    return byLabel?.id;
  }

  private stripListMarker(line: string): string {
    return line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
  }

  private extractParticipantRequestMentions(content: string): string[] {
    const lines = this.withoutFencedCode(content).split(/\r?\n/);
    const requestLines: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^\s*participant requests\s*:\s*(.*)$/i);
      if (!match) {
        continue;
      }
      const inline = match[1].trim();
      if (inline) {
        if (/^none\.?$/i.test(inline)) {
          return [];
        }
        requestLines.push(inline);
      }
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next];
        const trimmed = line.trim();
        if (!trimmed) {
          if (requestLines.length > 0) {
            break;
          }
          continue;
        }
        if (/^#{1,6}\s+/.test(trimmed)) {
          break;
        }
        if (/^participant requests\s*:/i.test(trimmed)) {
          break;
        }
        if (/^(?:[-*]|\d+[.)])\s+/.test(trimmed)) {
          if (/^(?:[-*]|\d+[.)])\s+none\.?$/i.test(trimmed)) {
            return [];
          }
          requestLines.push(trimmed);
          continue;
        }
        break;
      }
      break;
    }
    return this.extractMentions(requestLines.join("\n"));
  }

  private requesterContinuationRequested(content: string): boolean {
    return this.withoutFencedCode(content)
      .split(/\r?\n/)
      .some((line) => /^\s*return to requester after replies\s*:\s*(?:yes|true)\s*$/i.test(line));
  }

  private resolveMentionTargets(conversation: Conversation, content: string): { targets: ChatParticipant[]; unknownHandles: string[] } {
    const participants = this.chatParticipants(conversation);
    const targets = new Map<string, ChatParticipant>();
    const unknownHandles: string[] = [];
    for (const handle of this.extractMentions(content)) {
      const participant = participants.find((item) => item.handle.toLowerCase() === handle.toLowerCase());
      if (participant) {
        targets.set(participant.id, participant);
      } else if (!unknownHandles.some((item) => item.toLowerCase() === handle.toLowerCase())) {
        unknownHandles.push(handle);
      }
    }
    return { targets: Array.from(targets.values()), unknownHandles };
  }

  private extractMentions(content: string): string[] {
    const matches = this.withoutFencedCode(content).matchAll(/@([A-Za-z0-9_-]{1,32})/g);
    return Array.from(matches, (match) => match[1]);
  }

  private withoutFencedCode(content: string): string {
    return content.replace(/```[\s\S]*?```/g, "");
  }

  private updatePendingMentionStatus(sourceMessage: ChatMessage, targetIds: Set<string>, status: ChatPendingMention["status"]): void {
    const now = new Date().toISOString();
    sourceMessage.metadata = {
      ...sourceMessage.metadata,
      pendingMentions: (sourceMessage.metadata?.pendingMentions ?? []).map((mention) =>
        targetIds.has(mention.targetParticipantId)
          ? {
              ...mention,
              status,
              approvedAt: status === "approved" ? now : mention.approvedAt
            }
          : mention
      )
    };
  }

  private updatePendingChoiceSelection(
    sourceMessage: ChatMessage,
    choiceId: string,
    selectedOptionId: string,
    customAnswer?: string,
    note?: string
  ): void {
    const choice = sourceMessage.metadata?.pendingChoice;
    if (!choice || choice.id !== choiceId) {
      return;
    }
    sourceMessage.metadata = {
      ...sourceMessage.metadata,
      pendingChoice: {
        ...choice,
        status: "selected",
        selectedOptionId,
        customAnswer: customAnswer || undefined,
        note: note || undefined,
        selectedAt: new Date().toISOString()
      }
    };
  }

  private formatChoiceSelectionForChat(
    sourceMessage: ChatMessage,
    choice: ChatPendingChoice,
    selectedOption: ChatChoiceOption | undefined,
    customAnswer?: string,
    note?: string
  ): string {
    const requester = sourceMessage.participantLabel ?? "the requester";
    const isCustomAnswer = !selectedOption && Boolean(customAnswer?.trim());
    return [
      `Choice selected for ${requester}.`,
      "",
      `Choice: ${choice.title}`,
      `Question: ${choice.question}`,
      selectedOption ? `Selected option: ${selectedOption.label}` : "",
      selectedOption?.description ? `Option context: ${selectedOption.description}` : "",
      isCustomAnswer ? "Selected option: Write your own answer" : "",
      customAnswer?.trim() ? `Custom answer: ${customAnswer.trim()}` : "",
      note?.trim() ? `Note: ${note.trim()}` : ""
    ].filter(Boolean).join("\n");
  }

  private async ensureHistoryFiles(conversation: Conversation): Promise<string> {
    const dir = path.join(app.getPath("userData"), "chats", conversation.id);
    await mkdir(dir, { recursive: true });
    const markdown = this.historyMarkdown(conversation);
    await Promise.all([
      writeFile(path.join(dir, "history.md"), markdown, "utf8"),
      writeFile(path.join(dir, "history.json"), `${JSON.stringify(conversation, null, 2)}\n`, "utf8")
    ]);
    return dir;
  }

  private historyFilePaths(
    conversationId: string,
    actor?: Pick<ChatAppMcpActor, "historyMarkdownPath" | "historyJsonPath">
  ): { markdownPath: string; jsonPath: string } {
    const dir = path.join(app.getPath("userData"), "chats", conversationId);
    return {
      markdownPath: actor?.historyMarkdownPath ?? path.join(dir, "history.md"),
      jsonPath: actor?.historyJsonPath ?? path.join(dir, "history.json")
    };
  }

  private historyMarkdown(conversation: Conversation): string {
    const participants = this.chatParticipants(conversation);
    return [
      `# ${conversation.title}`,
      "",
      `Conversation ID: ${conversation.id}`,
      conversation.repoPath ? `Repository: ${conversation.repoPath}` : "Repository: none",
      "",
      "## Participants",
      "- User: human conversation owner, requirements authority, and clarification source",
      ...participants.map((participant) => `- @${participant.handle}: ${this.roleLabelForParticipant(conversation, participant)} (${participant.kind})`),
      "",
      "## Messages",
      ...conversation.messages.map((message) => [
        `### ${message.createdAt} ${this.messageAuthor(message)}`,
        `Message ID: ${message.id}`,
        message.metadata?.threadId ? `Thread ID: ${message.metadata.threadId}` : "",
        message.metadata?.parentMessageId ? `Parent message ID: ${message.metadata.parentMessageId}` : "",
        message.metadata?.chatThreadRootId ? `Chat thread root ID: ${message.metadata.chatThreadRootId}` : "",
        "",
        message.content.trim() || (this.imageAttachments(message).length > 0 ? "(image-only message)" : ""),
        this.repoFileMentionsMarkdown(message),
        this.imageAttachmentsMarkdown(message),
        ""
      ].filter(Boolean).join("\n"))
    ].join("\n");
  }

  private roleLabelForParticipant(conversation: Conversation, participant: ChatParticipant): string {
    const session = this.chatSessions(conversation).find((item) => item.participantId === participant.id);
    return session?.roleLabel ?? participant.roleConfigId;
  }

  private formatMessage(message: ChatMessage, includeRepoFileMentions = true): string {
    const content = message.content.trim() || (this.imageAttachments(message).length > 0 ? "(image-only message)" : "");
    return [
      `[${message.createdAt}] ${this.messageAuthor(message)}`,
      content,
      includeRepoFileMentions ? this.repoFileMentionsMarkdown(message) : "",
      this.imageAttachmentsMarkdown(message)
    ].filter(Boolean).join("\n");
  }

  private repoFileMentionsMarkdown(message: ChatMessage): string {
    const mentions = this.repoFileMentions(message);
    if (mentions.length === 0) {
      return "";
    }
    return [
      "Referenced repository files:",
      ...mentions.map((mention) => `- ${mention.path}`)
    ].join("\n");
  }

  private repoFileMentions(message: ChatMessage): RepoFileMention[] {
    const seen = new Set<string>();
    const mentions: RepoFileMention[] = [];
    for (const mention of message.metadata?.repoFileMentions ?? []) {
      const normalizedPath = this.normalizeRepoFileMentionPath(mention.path);
      if (!normalizedPath || seen.has(normalizedPath)) {
        continue;
      }
      seen.add(normalizedPath);
      mentions.push({ path: normalizedPath });
    }
    return mentions;
  }

  private imageAttachments(message: ChatMessage): ChatImageAttachment[] {
    const seen = new Set<string>();
    const attachments: ChatImageAttachment[] = [];
    for (const attachment of message.metadata?.imageAttachments ?? []) {
      if (!this.isStoredChatImageAttachment(attachment) || seen.has(attachment.id)) {
        continue;
      }
      seen.add(attachment.id);
      attachments.push(attachment);
    }
    return attachments;
  }

  private chatImageAttachmentForTool(attachment: ChatImageAttachment): Omit<ChatImageAttachment, "storageKey"> {
    const { storageKey: _storageKey, ...safeAttachment } = attachment;
    return safeAttachment;
  }

  private imageAttachmentsMarkdown(message: ChatMessage): string {
    const attachments = this.imageAttachments(message);
    if (attachments.length === 0) {
      return "";
    }
    return [
      "Attached images:",
      ...attachments.map((attachment) =>
        `- ${attachment.filename} (${attachment.mimeType}, ${this.formatBytes(attachment.sizeBytes)}, ${attachment.width}x${attachment.height}, id: ${attachment.id})`
      )
    ].join("\n");
  }

  private imageAttachmentsPromptSection(message: ChatMessage): string {
    const attachments = this.imageAttachments(message);
    if (attachments.length === 0) {
      return "";
    }
    return [
      "Attached images for the triggering message:",
      ...attachments.map((attachment) =>
        `- ${attachment.filename} (${attachment.mimeType}, ${this.formatBytes(attachment.sizeBytes)}, ${attachment.width}x${attachment.height}) attachmentId=${attachment.id}`
      ),
      `Use \`${APP_CHAT_READ_ATTACHMENT_TOOL}\` with JSON like { "attachmentId": "${attachments[0].id}" } to inspect the image content. Use \`${APP_CHAT_LIST_ATTACHMENTS_TOOL}\` if you need to rediscover visible attachment IDs.`
    ].join("\n");
  }

  private visibleImageAttachmentRecords(conversation: Conversation, actor: ChatAppMcpActor): ChatAttachmentRecord[] {
    const records: ChatAttachmentRecord[] = [];
    conversation.messages.forEach((message, sequence) => {
      if (typeof actor.snapshotMaxSequence === "number" && sequence > actor.snapshotMaxSequence) {
        return;
      }
      for (const attachment of this.imageAttachments(message)) {
        records.push({ message, sequence, attachment });
      }
    });
    return records;
  }

  private findImageAttachmentRecord(conversation: Conversation, attachmentId: string): ChatAttachmentRecord | undefined {
    const normalizedId = attachmentId.trim();
    for (const [sequence, message] of conversation.messages.entries()) {
      const attachment = this.imageAttachments(message).find((item) => item.id === normalizedId);
      if (attachment) {
        return { message, sequence, attachment };
      }
    }
    return undefined;
  }

  private normalizeChatAttachmentListRequest(raw: unknown): { messageId?: string; threadId?: string; limit: number } {
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const messageId = typeof record.messageId === "string" && record.messageId.trim() ? record.messageId.trim() : undefined;
    const threadId = typeof record.threadId === "string" && record.threadId.trim() ? record.threadId.trim() : undefined;
    const rawLimit = typeof record.limit === "number" ? record.limit : CHAT_CONTEXT_READ_DEFAULT_LIMIT;
    return {
      messageId,
      threadId,
      limit: Math.min(100, Math.max(1, Math.floor(rawLimit)))
    };
  }

  private normalizeChatAttachmentReadRequest(raw: unknown): { attachmentId: string } {
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const attachmentId = typeof record.attachmentId === "string" ? record.attachmentId.trim() : "";
    if (!attachmentId) {
      throw new Error("AttachmentReadDenied. Problem: attachmentId is required. Cause: the read request did not include an attachmentId. Fix: call app_chat_list_attachments and pass one returned attachmentId.");
    }
    return { attachmentId };
  }

  private async readAttachmentBase64(conversationId: string, attachment: ChatImageAttachment): Promise<string> {
    const filePath = this.attachmentPath(conversationId, attachment.storageKey);
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      void this.debugLogs.write("chat.attachments.missing", {
        conversationId,
        attachmentId: attachment.id,
        message: error instanceof Error ? error.message : String(error)
      });
      throw new Error(
        "AttachmentMissing. Problem: the attachment metadata exists, but the image file could not be read. Cause: the attachment file is missing or inaccessible in app storage. Fix: ask User to resend the image."
      );
    }
    return bytes.toString("base64");
  }

  private async prepareImageAttachments(conversationId: string, inputs: ChatImageInput[] | undefined): Promise<PreparedImageAttachments> {
    if (!inputs || inputs.length === 0) {
      return { attachments: [], writtenPaths: [] };
    }
    if (!Array.isArray(inputs)) {
      throw new Error("Image attachments must be an array.");
    }
    if (inputs.length > CHAT_IMAGE_MAX_ATTACHMENTS) {
      throw new Error(`Too many images. Attach at most ${CHAT_IMAGE_MAX_ATTACHMENTS} images per message.`);
    }

    const prepared: PreparedImageAttachments = { attachments: [], writtenPaths: [] };
    try {
      for (let index = 0; index < inputs.length; index += 1) {
        const persisted = await this.prepareImageAttachment(conversationId, inputs[index], index);
        prepared.attachments.push(persisted.attachment);
        prepared.writtenPaths.push(persisted.filePath);
      }
      return prepared;
    } catch (error) {
      await this.rollbackPreparedImageAttachments(conversationId, prepared, "AttachmentPersistFailed", error);
      throw error;
    }
  }

  private async prepareImageAttachment(
    conversationId: string,
    input: ChatImageInput,
    index: number
  ): Promise<{ attachment: ChatImageAttachment; filePath: string }> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Image attachment input is invalid.");
    }
    const mimeType = this.normalizeChatImageMimeType(input.mimeType);
    const bytes = this.decodeImageInputBase64(input.dataBase64);
    if (bytes.length === 0) {
      throw new Error("ImageDecodeFailed. Problem: image data is empty. Cause: the pasted or selected image did not produce bytes. Fix: paste or choose the image again.");
    }
    if (bytes.length > CHAT_IMAGE_MAX_BYTES) {
      throw new Error(`ImageTooLarge. Problem: image ${index + 1} is ${this.formatBytes(bytes.length)}. Cause: v1 accepts images up to ${this.formatBytes(CHAT_IMAGE_MAX_BYTES)}. Fix: crop or compress the image and try again.`);
    }
    const detectedMimeType = this.detectChatImageMimeType(bytes);
    if (!detectedMimeType || detectedMimeType !== mimeType) {
      void this.debugLogs.write("chat.attachments.validation-failed", {
        conversationId,
        reason: "mime-mismatch",
        providedMimeType: input.mimeType,
        detectedMimeType
      });
      throw new Error("UnsupportedImageType. Problem: image MIME type does not match the file bytes. Cause: the attachment is not a PNG, JPEG, or WebP image. Fix: paste or choose a PNG, JPEG, or WebP image.");
    }
    const dimensions = this.chatImageDimensions(bytes, mimeType);
    if (!dimensions) {
      void this.debugLogs.write("chat.attachments.validation-failed", {
        conversationId,
        reason: "dimensions-unreadable",
        mimeType
      });
      throw new Error("ImageDecodeFailed. Problem: image dimensions could not be read. Cause: the image is malformed or uses an unsupported encoding. Fix: export it as PNG, JPEG, or WebP and try again.");
    }
    if (
      dimensions.width > CHAT_IMAGE_MAX_DIMENSION ||
      dimensions.height > CHAT_IMAGE_MAX_DIMENSION ||
      dimensions.width * dimensions.height > CHAT_IMAGE_MAX_PIXELS
    ) {
      throw new Error(`ImageTooManyPixels. Problem: image is ${dimensions.width}x${dimensions.height}. Cause: v1 accepts images up to ${CHAT_IMAGE_MAX_DIMENSION}px per side and ${CHAT_IMAGE_MAX_PIXELS.toLocaleString()} pixels. Fix: crop or scale the image and try again.`);
    }

    const attachmentId = randomUUID();
    const extension = CHAT_IMAGE_EXTENSION_BY_MIME[mimeType];
    const storageKey = `attachments/${attachmentId}.${extension}`;
    const filePath = this.attachmentPath(conversationId, storageKey);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      await writeFile(tempPath, bytes);
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      void this.debugLogs.write("chat.attachments.persistence-failed", {
        conversationId,
        attachmentId,
        message: error instanceof Error ? error.message : String(error)
      });
      throw new Error("AttachmentPersistFailed. Problem: the image could not be saved. Cause: app attachment storage is unavailable or full. Fix: retry, or check local disk permissions and free space.");
    }

    return {
      filePath,
      attachment: {
        id: attachmentId,
        filename: this.normalizeChatImageFilename(input.filename, extension, index),
        mimeType,
        sizeBytes: bytes.length,
        width: dimensions.width,
        height: dimensions.height,
        storageKey,
        createdAt: new Date().toISOString()
      }
    };
  }

  private async rollbackPreparedImageAttachments(
    conversationId: string,
    prepared: PreparedImageAttachments,
    reason: string,
    cause: unknown
  ): Promise<void> {
    if (prepared.writtenPaths.length === 0) {
      return;
    }
    await Promise.all(prepared.writtenPaths.map((filePath) => rm(filePath, { force: true }).catch(() => undefined)));
    void this.debugLogs.write("chat.attachments.rollback", {
      conversationId,
      reason,
      attachmentIds: prepared.attachments.map((attachment) => attachment.id),
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }

  private normalizeChatImageMimeType(value: string): ChatImageMimeType {
    const normalized = value.toLowerCase().trim();
    if (CHAT_IMAGE_MIME_TYPES.includes(normalized as ChatImageMimeType)) {
      return normalized as ChatImageMimeType;
    }
    throw new Error("UnsupportedImageType. Problem: this image type is not supported. Cause: v1 accepts PNG, JPEG, and WebP images only. Fix: paste or choose a PNG, JPEG, or WebP image.");
  }

  private decodeImageInputBase64(value: string): Buffer {
    if (typeof value !== "string") {
      throw new Error("ImageDecodeFailed. Problem: image payload is invalid. Cause: the renderer did not send base64 image data. Fix: paste or choose the image again.");
    }
    const trimmed = value.trim();
    const withoutDataUrl = trimmed.replace(/^data:image\/(?:png|jpeg|jpg|webp);base64,/i, "");
    if (!/^[A-Za-z0-9+/=\s]+$/.test(withoutDataUrl)) {
      throw new Error("ImageDecodeFailed. Problem: image payload is not valid base64. Cause: the pasted or selected image was not encoded correctly. Fix: paste or choose the image again.");
    }
    return Buffer.from(withoutDataUrl.replace(/\s/g, ""), "base64");
  }

  private detectChatImageMimeType(bytes: Buffer): ChatImageMimeType | undefined {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }
    return undefined;
  }

  private chatImageDimensions(bytes: Buffer, mimeType: ChatImageMimeType): { width: number; height: number } | undefined {
    if (mimeType === "image/png") {
      return this.pngImageDimensions(bytes);
    }
    if (mimeType === "image/jpeg") {
      return this.jpegImageDimensions(bytes);
    }
    return this.webpImageDimensions(bytes);
  }

  private pngImageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
    if (bytes.length < 24 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
      return undefined;
    }
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20)
    };
  }

  private jpegImageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      offset += 2;
      if (marker === 0xd9 || marker === 0xda) {
        break;
      }
      if (offset + 2 > bytes.length) {
        break;
      }
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) {
        break;
      }
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return {
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5)
        };
      }
      offset += segmentLength;
    }
    return undefined;
  }

  private webpImageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
    const chunkType = bytes.length >= 16 ? bytes.subarray(12, 16).toString("ascii") : "";
    if (chunkType === "VP8X" && bytes.length >= 30) {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3)
      };
    }
    if (chunkType === "VP8 " && bytes.length >= 30) {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff
      };
    }
    if (chunkType === "VP8L" && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1
      };
    }
    return undefined;
  }

  private normalizeChatImageFilename(filename: string | undefined, extension: string, index: number): string {
    const fallback = `image-${index + 1}.${extension}`;
    const base = typeof filename === "string" && filename.trim()
      ? path.basename(filename.trim()).replace(/[^\w .@()-]/g, "_").replace(/\s+/g, " ").slice(0, 120)
      : fallback;
    if (base.toLowerCase().endsWith(`.${extension}`) || (extension === "jpg" && base.toLowerCase().endsWith(".jpeg"))) {
      return base;
    }
    return `${base.replace(/\.[^.]+$/, "")}.${extension}`;
  }

  private attachmentPath(conversationId: string, storageKey: string): string {
    if (!/^attachments\/[A-Za-z0-9-]+\.(?:png|jpg|webp)$/.test(storageKey)) {
      throw new Error("Attachment storage key is invalid.");
    }
    return path.join(app.getPath("userData"), "chats", conversationId, storageKey);
  }

  private isStoredChatImageAttachment(value: unknown): value is ChatImageAttachment {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const record = value as Partial<ChatImageAttachment>;
    return (
      typeof record.id === "string" &&
      typeof record.filename === "string" &&
      CHAT_IMAGE_MIME_TYPES.includes(record.mimeType as ChatImageMimeType) &&
      typeof record.sizeBytes === "number" &&
      typeof record.width === "number" &&
      typeof record.height === "number" &&
      typeof record.storageKey === "string" &&
      typeof record.createdAt === "string"
    );
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    }
    if (bytes >= 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }
    return `${bytes} B`;
  }

  private chatMessageForTool(message: ChatMessage, sequence: number): Record<string, unknown> {
    const attachments = this.imageAttachments(message);
    const metadata = message.metadata
      ? {
          ...message.metadata,
          imageAttachments: attachments.length > 0 ? attachments.map((attachment) => this.chatImageAttachmentForTool(attachment)) : undefined
        }
      : undefined;
    return {
      sequence,
      id: message.id,
      role: message.role,
      author: this.messageAuthor(message),
      participantId: message.participantId,
      participantLabel: message.participantLabel,
      content: message.content,
      createdAt: message.createdAt,
      status: message.status,
      metadata,
      imageAttachments: attachments.map((attachment) => ({
        ...this.chatImageAttachmentForTool(attachment),
        readTool: APP_CHAT_READ_ATTACHMENT_TOOL,
        readArguments: { attachmentId: attachment.id }
      }))
    };
  }

  private messageAuthor(message: ChatMessage): string {
    if (message.role === "user") {
      return "User";
    }
    if (message.role === "participant") {
      return message.participantLabel ?? "Participant";
    }
    return message.role;
  }

  private chatIntro(participants: ChatParticipant[]): string {
    return [
      "Chat started.",
      "Participants:",
      "- User",
      ...participants.map((participant) => `- @${participant.handle}`)
    ].join("\n");
  }

  private normalizeChatTitle(value: string): string {
    return value.trim().slice(0, 80) || "Chat";
  }

  private formatHandleList(handles: string[]): string {
    if (handles.length <= 2) {
      return handles.join(handles.length === 2 ? " and " : "");
    }
    return `${handles.slice(0, -1).join(", ")}, and ${handles[handles.length - 1]}`;
  }

  private chatParticipants(conversation: Conversation): ChatParticipant[] {
    const value = conversation.metadata.participants;
    return Array.isArray(value) ? value.filter((item): item is ChatParticipant => this.isChatParticipant(item)) : [];
  }

  private chatAppToolApprovals(conversation: Conversation): ChatAppToolApproval[] {
    const value = conversation.metadata.pendingAppToolApprovals;
    return Array.isArray(value) ? value.filter((item): item is ChatAppToolApproval => this.isChatAppToolApproval(item)) : [];
  }

  private chatAppToolApprovalPolicies(conversation: Conversation): ChatAppToolApprovalPolicy[] {
    const value = conversation.metadata.appToolApprovalPolicies;
    return Array.isArray(value)
      ? value.filter((item): item is ChatAppToolApprovalPolicy => this.isChatAppToolApprovalPolicy(item))
      : [];
  }

  private chatSessions(conversation: Conversation): ChatParticipantSession[] {
    const value = conversation.metadata.participantSessions;
    return Array.isArray(value)
      ? value.filter((item): item is ChatParticipantSession => {
          const session = item as Partial<ChatParticipantSession>;
          return typeof session.participantId === "string" && typeof session.sessionId === "string";
        })
      : [];
  }

  private normalizeChatMessageReadRequest(raw: unknown): {
    threadId?: string;
    beforeSequence?: number;
    afterSequence?: number;
    limit: number;
  } {
    if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
      throw new Error("Chat message read request must be an object.");
    }
    const record = (raw ?? {}) as Record<string, unknown>;
    const threadId = typeof record.threadId === "string"
      ? record.threadId.trim().slice(0, 200) || undefined
      : undefined;
    return {
      threadId,
      beforeSequence: this.optionalNonNegativeInteger(record.beforeSequence, "beforeSequence"),
      afterSequence: this.optionalNonNegativeInteger(record.afterSequence, "afterSequence"),
      limit: this.optionalBoundedPositiveInteger(
        record.limit,
        "limit",
        CHAT_CONTEXT_READ_DEFAULT_LIMIT,
        CHAT_CONTEXT_READ_MAX_LIMIT
      )
    };
  }

  private optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative integer.`);
    }
    return value;
  }

  private optionalBoundedPositiveInteger(value: unknown, field: string, fallback: number, max: number): number {
    if (value === undefined || value === null) {
      return fallback;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`${field} must be a positive integer.`);
    }
    return Math.min(value, max);
  }

  private agentContextUsageByParticipant(conversation: Conversation): Record<string, AgentContextUsage> {
    const value = conversation.metadata.agentContextUsageByParticipant;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const usageByParticipant: Record<string, AgentContextUsage> = {};
    for (const [participantId, usage] of Object.entries(value)) {
      const normalized = normalizeAgentContextUsage(usage);
      if (normalized) {
        usageByParticipant[participantId] = normalized;
      }
    }
    return usageByParticipant;
  }

  private isChatParticipant(item: unknown): item is ChatParticipant {
    const participant = item as Partial<ChatParticipant>;
    return (
      typeof participant.id === "string" &&
      typeof participant.handle === "string" &&
      typeof participant.roleConfigId === "string" &&
      (participant.kind === "codex-cli" || participant.kind === "claude-code")
    );
  }

  private isChatAppToolApproval(item: unknown): item is ChatAppToolApproval {
    const approval = item as Partial<ChatAppToolApproval>;
    const isRosterApproval =
      approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL &&
      approval.capability === "participants.manage" &&
      this.isRosterChangeRequest(approval.request);
    const isPermissionApproval =
      approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
      approval.capability === "permissions.request" &&
      this.isPermissionChangeRequest(approval.request);
    const isParticipantRequestApproval =
      approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL &&
      approval.capability === "participants.request" &&
      this.isParticipantRequestApprovalRequest(approval.request);
    return (
      typeof approval.id === "string" &&
      typeof approval.conversationId === "string" &&
      typeof approval.requesterParticipantId === "string" &&
      typeof approval.requesterHandle === "string" &&
      typeof approval.requesterRoleConfigId === "string" &&
      (isRosterApproval || isPermissionApproval || isParticipantRequestApproval) &&
      (approval.status === "pending" || approval.status === "approved" || approval.status === "denied" || approval.status === "auto-applied") &&
      typeof approval.summary === "string" &&
      typeof approval.createdAt === "string" &&
      typeof approval.updatedAt === "string"
    );
  }

  private isRosterChangeRequest(request: unknown): request is ChatRosterChangeRequest {
    return Boolean(
      request &&
      typeof request === "object" &&
      !Array.isArray(request) &&
      Array.isArray((request as Partial<ChatRosterChangeRequest>).operations)
    );
  }

  private isPermissionChangeRequest(request: unknown): request is ChatPermissionChangeRequest {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return false;
    }
    const record = request as Record<string, unknown>;
    if (record.kind === "shellRules") {
      const rules = record.rules;
      return Array.isArray(rules) && rules.length > 0 && rules.every((item) =>
        Boolean(
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          ((item as Partial<ChatShellPermissionRule>).action === "allow" ||
            (item as Partial<ChatShellPermissionRule>).action === "ask" ||
            (item as Partial<ChatShellPermissionRule>).action === "deny") &&
          ((item as Partial<ChatShellPermissionRule>).match === "exact" ||
            (item as Partial<ChatShellPermissionRule>).match === "prefix") &&
          typeof (item as Partial<ChatShellPermissionRule>).pattern === "string"
        )
      );
    }
    if (record.kind === "providerNative") {
      return record.provider === "claude-code" &&
        Array.isArray(record.allowedTools) &&
        record.allowedTools.length > 0 &&
        record.allowedTools.every((token) => typeof token === "string");
    }
    const permissions = record.permissions;
    return (record.kind === "portable" || record.kind === undefined) &&
      Array.isArray(permissions) &&
      permissions.length > 0 &&
      permissions.every((permission) => permission === "workspaceWrite" || permission === "webAccess" || permission === "repoRead");
  }

  private isParticipantRequestApprovalRequest(request: unknown): request is ChatParticipantRequestApprovalRequest {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return false;
    }
    const requests = (request as Partial<ChatParticipantRequestApprovalRequest>).requests;
    return Array.isArray(requests) && requests.every((item) =>
      Boolean(
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as Partial<ChatParticipantRequestInput>).target === "string" &&
        typeof (item as Partial<ChatParticipantRequestInput>).prompt === "string"
      )
    );
  }

  private isChatAppToolApprovalPolicy(item: unknown): item is ChatAppToolApprovalPolicy {
    const policy = item as Partial<ChatAppToolApprovalPolicy>;
    return (
      typeof policy.id === "string" &&
      typeof policy.participantId === "string" &&
      typeof policy.roleConfigId === "string" &&
      ((
        policy.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL &&
        policy.capability === "participants.manage" &&
        typeof policy.targetParticipantId !== "string"
      ) || (
        policy.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL &&
        policy.capability === "participants.request" &&
        typeof policy.targetParticipantId === "string"
      )) &&
      policy.scope === "chat" &&
      typeof policy.createdAt === "string" &&
      typeof policy.updatedAt === "string"
    );
  }

  private async requireChat(conversationId: string): Promise<Conversation> {
    const conversation = await this.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") {
      throw new Error("Chat conversation was not found.");
    }
    if (this.recoverStaleChatRun(conversation)) {
      await this.saveConversation(conversation);
    }
    return conversation;
  }

  private recoverStaleChatRun(conversation: Conversation): boolean {
    const runId = this.chatRunId(conversation);
    if (runId && this.activeRunIds.has(runId)) {
      return false;
    }
    if (this.chatHasLiveWork(conversation.id)) {
      return false;
    }
    const wasRunning = conversation.metadata.running === true;
    let pendingSwept = false;
    for (const message of conversation.messages) {
      if (message.status === "pending" && message.role === "participant") {
        message.status = "error";
        if (!message.content) {
          message.content = "Interrupted before completion.";
        }
        pendingSwept = true;
      }
    }
    if (!wasRunning && !pendingSwept) {
      return false;
    }
    if (wasRunning) {
      const warnings = sanitizeWarningList(conversation.metadata.warnings);
      if (!warnings.includes(INTERRUPTED_RUN_WARNING)) {
        warnings.push(INTERRUPTED_RUN_WARNING);
      }
      conversation.metadata = this.clearedChatRunMetadata({
        ...conversation.metadata,
        warnings
      });
    }
    conversation.updatedAt = new Date().toISOString();
    return true;
  }

  private chatRunId(conversation: Conversation): string | undefined {
    const runId = conversation.metadata.runId;
    return typeof runId === "string" && runId.trim() ? runId : undefined;
  }

  private clearedChatRunMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    return clearChatRunMetadata(metadata);
  }

  private message(
    role: ChatMessage["role"],
    content: string,
    participant?: ParticipantConfig,
    metadata?: ChatMessage["metadata"],
    status: ChatMessage["status"] = "done"
  ): ChatMessage {
    return {
      id: randomUUID(),
      role,
      participantId: participant?.id,
      participantLabel: participant?.label,
      content,
      createdAt: new Date().toISOString(),
      status,
      metadata
    };
  }

  private queueSnapshot(conversation: Conversation): void {
    const snapshot = this.clone(conversation);
    this.onConversationSnapshot?.(snapshot);
    const previous = this.saveQueues.get(conversation.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.storage.saveConversation(snapshot))
      .catch((error) => {
        void this.debugLogs.write("chat.persistence.error", {
          conversationId: conversation.id,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    this.saveQueues.set(conversation.id, next);
    void next.finally(() => {
      if (this.saveQueues.get(conversation.id) === next) {
        this.saveQueues.delete(conversation.id);
      }
    });
  }

  private async withChatRunLock<T>(
    conversationId: string,
    run: () => Promise<T>,
    options: { rejectIfQueued?: boolean; queuedMessage?: string } = {}
  ): Promise<T> {
    const previous = this.runQueues.get(conversationId);
    if (previous && options.rejectIfQueued) {
      throw new Error(options.queuedMessage ?? "Chat is busy.");
    }
    const previousRun = previous ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previousRun.catch(() => undefined).then(() => current);
    this.runQueues.set(conversationId, chained);
    await previousRun.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (this.runQueues.get(conversationId) === chained) {
        this.runQueues.delete(conversationId);
      }
    }
  }

  private async beginChatRun(conversation: Conversation, runId: string): Promise<void> {
    this.rememberActiveChatRun(conversation.id, runId);
    try {
      conversation.metadata = { ...conversation.metadata, running: true, runId };
      conversation.updatedAt = new Date().toISOString();
      await this.saveConversation(conversation);
    } catch (error) {
      this.forgetActiveChatRun(conversation.id, runId);
      throw error;
    }
  }

  private async endChatRun(conversation: Conversation, runId: string): Promise<void> {
    await this.refreshStoredChatState(conversation).finally(() => {
      this.forgetActiveChatRun(conversation.id, runId);
    });
    if (this.chatRunId(conversation) !== runId) {
      return;
    }
    if (this.chatHasLiveWork(conversation.id)) {
      await this.waitForQueuedSave(conversation.id);
      return;
    }
    conversation.metadata = this.clearedChatRunMetadata(conversation.metadata);
    conversation.updatedAt = new Date().toISOString();
    await this.saveConversation(conversation);
  }

  private rememberActiveChatRun(conversationId: string, runId: string): void {
    this.activeRunIds.add(runId);
    const runIds = this.activeConversationRunIds.get(conversationId) ?? new Set<string>();
    runIds.add(runId);
    this.activeConversationRunIds.set(conversationId, runIds);
  }

  private forgetActiveChatRun(conversationId: string, runId: string): void {
    this.activeRunIds.delete(runId);
    const runIds = this.activeConversationRunIds.get(conversationId);
    if (!runIds) {
      return;
    }
    runIds.delete(runId);
    if (runIds.size === 0) {
      this.activeConversationRunIds.delete(conversationId);
    }
  }

  private chatHasLiveWork(conversationId: string): boolean {
    return (
      (this.activeConversationRunIds.get(conversationId)?.size ?? 0) > 0 ||
      (this.backgroundRunnerCounts.get(conversationId) ?? 0) > 0
    );
  }

  private incrementBackgroundRunner(conversationId: string): void {
    this.backgroundRunnerCounts.set(conversationId, (this.backgroundRunnerCounts.get(conversationId) ?? 0) + 1);
  }

  private decrementBackgroundRunner(conversationId: string): void {
    const nextCount = (this.backgroundRunnerCounts.get(conversationId) ?? 0) - 1;
    if (nextCount > 0) {
      this.backgroundRunnerCounts.set(conversationId, nextCount);
      return;
    }
    this.backgroundRunnerCounts.delete(conversationId);
    void this.tryClearRunningIfIdle(conversationId).catch((error) => {
      void this.debugLogs.write("chat.background-runner.clear-idle.error", {
        conversationId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async tryClearRunningIfIdle(conversationId: string): Promise<void> {
    if (this.chatHasLiveWork(conversationId)) {
      return;
    }
    await this.withChatRunLock(conversationId, async () => {
      if (this.chatHasLiveWork(conversationId)) {
        return;
      }
      await this.waitForQueuedSave(conversationId);
      const conversation = await this.storage.getConversation(conversationId);
      if (!conversation || conversation.kind !== "chat" || conversation.metadata.running !== true) {
        return;
      }
      if (this.chatHasLiveWork(conversationId)) {
        return;
      }
      conversation.metadata = this.clearedChatRunMetadata(conversation.metadata);
      conversation.updatedAt = new Date().toISOString();
      await this.saveConversation(conversation);
    });
  }

  private emitChatRunFailure(runId: string, progress: ProgressCallback | undefined, error: unknown): void {
    this.emitProgress(runId, progress, "error", error instanceof Error ? error.message : String(error));
  }

  private async saveConversation(conversation: Conversation): Promise<void> {
    const pending = this.saveQueues.get(conversation.id);
    if (pending) {
      await pending.catch(() => undefined);
    }
    const snapshot = this.clone(conversation);
    await this.storage.saveConversation(snapshot);
    this.onConversationSnapshot?.(snapshot);
  }

  private clone(conversation: Conversation): Conversation {
    return JSON.parse(JSON.stringify(conversation)) as Conversation;
  }

  private createAgentProgressSink(
    runId: string,
    progress: ProgressCallback | undefined,
    participant: ChatParticipant,
    messageId: string,
    guardViolationCheck?: (cumulative: string) => boolean
  ): {
    emit: (event: CliAgentOutputEvent) => void;
    beginAttempt: () => void;
    finish: () => void;
  } {
    if (!progress) {
      return {
        emit: () => undefined,
        beginAttempt: () => undefined,
        finish: () => undefined
      };
    }
    const participantLabel = `@${participant.handle}`;
    const THROTTLE_MS = 100;
    let finished = false;
    let cumulative = "";
    let activity: string | undefined;
    let suppressed = false;
    let lastFlush = 0;
    let pendingTimer: NodeJS.Timeout | undefined;
    let dirty = false;

    const flush = (): void => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
      }
      if (finished || !dirty) {
        return;
      }
      dirty = false;
      lastFlush = Date.now();
      const partialContent = !suppressed && cumulative ? cumulative : undefined;
      this.emitProgress(runId, progress, "debate", `${participantLabel} is responding.`, {
        participantLabel,
        agentProgress: {
          participantId: participant.id,
          participantLabel,
          state: "running",
          messageId,
          activity,
          partialContent
        }
      });
    };

    const scheduleFlush = (): void => {
      if (finished || pendingTimer) {
        return;
      }
      const elapsed = Date.now() - lastFlush;
      if (elapsed >= THROTTLE_MS) {
        flush();
      } else {
        pendingTimer = setTimeout(flush, THROTTLE_MS - elapsed);
        pendingTimer.unref?.();
      }
    };

    const emitNow = (event: CliAgentOutputEvent): void => {
      if (finished) {
        return;
      }
      if (event.kind === "text") {
        const next = event.cumulative ?? cumulative + event.text;
        if (next === cumulative) {
          return;
        }
        cumulative = next;
        if (!suppressed && guardViolationCheck && guardViolationCheck(cumulative)) {
          suppressed = true;
        }
        dirty = true;
        scheduleFlush();
        return;
      }
      const label = event.text.trim();
      if (!label) {
        return;
      }
      if (label === activity) {
        return;
      }
      activity = label;
      dirty = true;
      scheduleFlush();
    };

    const beginAttempt = (): void => {
      if (finished) {
        return;
      }
      cumulative = "";
      suppressed = false;
      activity = undefined;
      // Emit a snapshot so the renderer clears any prior partial content on retry.
      dirty = true;
      flush();
    };

    const finish = (): void => {
      if (finished) {
        return;
      }
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
      }
      finished = true;
      this.emitProgress(runId, progress, "debate", `${participantLabel} finished.`, {
        participantLabel,
        agentProgress: {
          participantId: participant.id,
          participantLabel,
          state: "finished",
          messageId
        }
      });
    };

    return {
      emit: emitNow,
      beginAttempt,
      finish
    };
  }

  private emitProgress(
    runId: string,
    progress: ProgressCallback | undefined,
    phase: ReviewProgress["phase"],
    message: string,
    details: Partial<Omit<ReviewProgress, "runId" | "phase" | "message" | "createdAt">> = {}
  ): void {
    progress?.({
      runId,
      phase,
      message,
      createdAt: new Date().toISOString(),
      ...details
    });
  }
}
