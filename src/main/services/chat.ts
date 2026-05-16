import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type {
  AgentContextUsage,
  AgentHealth,
  AddChatParticipantRequest,
  ChatAgentPermissions,
  ChatAppToolApproval,
  ChatAppToolApprovalPolicy,
  ChatAppToolApprovalRequest,
  ChatAppToolCapability,
  ChatChoiceOption,
  ChatMessage,
  ChatParticipant,
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
  Conversation,
  CreateChatConversationRequest,
  ParticipantConfig,
  RespondToChatAppToolApprovalRequest,
  RespondToChatChoiceRequest,
  RespondToChatMentionsRequest,
  ReviewProgress,
  SendChatMessageRequest,
  StartReviewResult
} from "../../shared/types";
import {
  chatAgentPermissionsEqual,
  effectiveChatAgentPermissions,
  normalizeChatAgentMode,
  normalizeChatAgentPermissions
} from "../../shared/agentPermissions";
import { normalizeAgentContextUsage } from "../../shared/agentContext";
import {
  chatAppToolCapabilitiesEqual,
  hasChatAppToolCapability,
  normalizeChatAppToolCapabilities
} from "../../shared/appTools";
import { CliAgentRunner } from "./cliAgents";
import type { CliAgentOutputEvent, CliAgentRoleOptions } from "./cliAgents";
import {
  APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
  APP_ROSTER_DESCRIBE_OPTIONS_TOOL,
  APP_ROSTER_REQUEST_CHANGE_TOOL
} from "./appMcp";
import { DebugLogService } from "./debugLogs";
import type { ParticipantRunResult } from "./providers";
import { SettingsService } from "./settings";
import { StorageService } from "./storage";

type ProgressCallback = (progress: ReviewProgress) => void;

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const CHAT_ROLE_RUNTIME_CONFIG_VERSION = 9;
const CHAT_WARM_AGENT_IDLE_TIMEOUT_MS = 10 * 60_000;
const CHAT_CUSTOM_CHOICE_OPTION_ID = "__custom__";
const CHAT_ADMINISTRATOR_ROLE_ID = "administrator";
const CHAT_ADMINISTRATOR_HANDLE = "admin";
const CHAT_ROSTER_CHANGE_MAX_OPERATIONS = 12;
const CHAT_APP_MCP_TOOL_NAMES = [
  APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
  APP_ROSTER_DESCRIBE_OPTIONS_TOOL,
  APP_ROSTER_REQUEST_CHANGE_TOOL
];

interface ChatAppMcpGateway {
  issueToken(grant: {
    conversationId: string;
    participantId: string;
    roleConfigId: string;
    roleConfigVersion: number;
    capabilities: ChatAppToolCapability[];
  }): { url: string; token: string } | undefined;
}

interface ChatAppMcpActor {
  conversationId: string;
  participantId: string;
  roleConfigId: string;
  roleConfigVersion: number;
  capabilities: ChatAppToolCapability[];
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
  permissions: ChatPermissionGrant[];
  summary: string;
}

export class ChatService {
  private readonly saveQueues = new Map<string, Promise<void>>();

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
        {
          id: participant.id,
          kind: participant.kind,
          label: `@${participant.handle}`,
          model: session.participantModel ?? participant.model
        },
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
    if (!nextUsage) {
      return conversation;
    }
    return {
      ...conversation,
      metadata: {
        ...conversation.metadata,
        agentContextUsageByParticipant: nextUsage
      }
    };
  }

  async createConversation(request: CreateChatConversationRequest): Promise<StartReviewResult> {
    const now = new Date().toISOString();
    const requestedParticipants = await this.validateParticipants(request.participants, [], true);
    const participants = await this.ensureAdministratorParticipant(requestedParticipants);
    const conversation: Conversation = {
      id: randomUUID(),
      title: request.title?.trim() || "Chat",
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
    await this.requireParticipantCapability(requester, "participants.manage");
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
    if (prepared.permissions.length === 0) {
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

  async describeRosterOptionsForTool(actor: ChatAppMcpActor): Promise<ChatRosterAvailableOptions> {
    await this.waitForQueuedSave(actor.conversationId);
    const conversation = await this.requireChat(actor.conversationId);
    const participants = this.chatParticipants(conversation);
    const requester = participants.find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting participant is no longer in this chat.");
    }
    await this.requireParticipantCapability(requester, "participants.manage");
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

  async respondToAppToolApproval(request: RespondToChatAppToolApprovalRequest): Promise<Conversation | undefined> {
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
      this.upsertAppToolApproval(conversation, {
        ...approval,
        status: "denied",
        updatedAt: now
      });
      conversation.messages.push(this.message("system", `Denied app tool request from @${approval.requesterHandle}: ${approval.summary}.`, undefined, {
        threadId: "system"
      }));
      conversation.updatedAt = now;
      await this.saveConversation(conversation);
      return conversation;
    }

    const scope = request.scope === "chat" ? "chat" : "once";
    const requester = this.chatParticipants(conversation).find((participant) => participant.id === approval.requesterParticipantId);
    const isPermissionApproval = approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL;
    const prepared = isPermissionApproval
      ? this.preparePermissionChange(requester, approval.request)
      : await this.prepareRosterChange(conversation, approval.request as ChatRosterChangeRequest);
    const applied = isPermissionApproval
      ? scope === "once"
        ? [requester].filter((participant): participant is ChatParticipant => Boolean(participant))
        : [this.applyPreparedPermissionChange(conversation, approval.requesterParticipantId, prepared as PreparedPermissionChange)]
      : this.applyPreparedRosterChange(conversation, prepared as PreparedRosterChange);
    this.upsertAppToolApproval(conversation, {
      ...approval,
      status: "approved",
      approvalScope: scope,
      appliedParticipantIds: applied.map((participant) => participant.id),
      updatedAt: now
    });
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
    const approvalMessage = isPermissionApproval
      ? scope === "chat"
        ? `Granted @${approval.requesterHandle} ${this.formatPermissionGrantList((prepared as PreparedPermissionChange).request.permissions)} for this chat.`
        : `Granted @${approval.requesterHandle} ${this.formatPermissionGrantList((prepared as PreparedPermissionChange).request.permissions)} once.`
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
    return conversation;
  }

  async sendMessage(request: SendChatMessageRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const runId = request.runId ?? randomUUID();
    const warnings: string[] = [];
    const conversation = await this.requireChat(request.conversationId);
    const content = request.content.trim();
    if (!content) {
      throw new Error("Message is required.");
    }
    const chatThreadRootId = request.chatThreadRootId?.trim() || undefined;
    const threadId = request.threadId?.trim() || randomUUID();
    const userMessage = this.message("user", content, undefined, {
      threadId,
      parentMessageId: request.parentMessageId,
      chatThreadRootId
    });
    if (!request.threadId?.trim()) {
      userMessage.metadata = { ...userMessage.metadata, threadId: userMessage.id };
    }
    conversation.messages.push(userMessage);
    conversation.metadata = { ...conversation.metadata, running: true, runId };
    conversation.updatedAt = new Date().toISOString();
    this.queueSnapshot(conversation);

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
      conversation.metadata = { ...conversation.metadata, running: false };
      await this.saveConversation(conversation);
      return { conversation, warnings };
    }

    this.emitProgress(runId, progress, "initial", `Running ${dispatch.targets.length} chat participant${dispatch.targets.length === 1 ? "" : "s"}.`, {
      total: dispatch.targets.length,
      completed: 0
    });
    await this.runParticipantBatch(conversation, dispatch.targets, userMessage, runId, signal, progress, warnings);
    conversation.metadata = { ...conversation.metadata, running: false };
    conversation.updatedAt = new Date().toISOString();
    await this.saveConversation(conversation);
    this.emitProgress(runId, progress, "done", "Chat turn finished.", {
      completed: dispatch.targets.length,
      total: dispatch.targets.length
    });
    return { conversation, warnings };
  }

  async respondToMentions(request: RespondToChatMentionsRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const runId = request.runId ?? randomUUID();
    const warnings: string[] = [];
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
    conversation.metadata = { ...conversation.metadata, running: true, runId };
    conversation.updatedAt = new Date().toISOString();
    this.queueSnapshot(conversation);

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
        const messages = await this.runParticipantTurn(conversation, requester, sourceMessage, runId, signal, progress, {
          continuation: true,
          warnings
        });
        await this.refreshStoredChatState(conversation);
        this.appendParticipantTurnMessages(conversation, requester, messages);
        conversation.updatedAt = new Date().toISOString();
        this.queueSnapshot(conversation);
        await this.ensureHistoryFiles(conversation);
      }
    }

    conversation.metadata = { ...conversation.metadata, running: false };
    conversation.updatedAt = new Date().toISOString();
    await this.saveConversation(conversation);
    this.emitProgress(runId, progress, "done", "Approved mention flow finished.");
    return { conversation, warnings };
  }

  async respondToChoice(request: RespondToChatChoiceRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const runId = request.runId ?? randomUUID();
    const warnings: string[] = [];
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
    conversation.metadata = { ...conversation.metadata, running: true, runId };
    conversation.updatedAt = new Date().toISOString();
    this.queueSnapshot(conversation);

    this.emitProgress(runId, progress, "debate", `Returning choice to @${requester.handle}.`, {
      participantLabel: `@${requester.handle}`
    });
    const messages = await this.runParticipantTurn(conversation, requester, userMessage, runId, signal, progress, {
      continuation: true,
      warnings
    });
    await this.refreshStoredChatState(conversation);
    this.appendParticipantTurnMessages(conversation, requester, messages);
    conversation.metadata = { ...conversation.metadata, running: false };
    conversation.updatedAt = new Date().toISOString();
    this.queueSnapshot(conversation);
    await this.ensureHistoryFiles(conversation);
    await this.saveConversation(conversation);
    this.emitProgress(runId, progress, "done", "Choice response finished.");
    return { conversation, warnings };
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
    const results = await Promise.all(
      participants.map(async (participant) => {
        const messages = await this.runParticipantTurn(conversation, participant, triggerMessage, runId, signal, progress, {
          warnings,
          promptConversation: turnSnapshot,
          workspacePath
        });
        completed += 1;
        this.emitProgress(runId, progress, "debate", `@${participant.handle} finished.`, {
          participantLabel: `@${participant.handle}`,
          completed,
          total: participants.length
        });
        return { participant, messages };
      })
    );
    await this.refreshStoredChatState(conversation);
    for (const result of results) {
      this.appendParticipantTurnMessages(conversation, result.participant, result.messages);
      conversation.updatedAt = new Date().toISOString();
      this.queueSnapshot(conversation);
    }
    await this.ensureHistoryFiles(conversation);
  }

  private async runParticipantTurn(
    conversation: Conversation,
    participant: ChatParticipant,
    triggerMessage: ChatMessage,
    runId: string,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    options: { continuation?: boolean; warnings: string[]; promptConversation?: Conversation; workspacePath?: string }
  ): Promise<ChatMessage[]> {
    let session = await this.sessionForParticipant(conversation, participant);
    const promptConversation = options.promptConversation ?? conversation;
    const workspacePath = options.workspacePath ?? await this.ensureHistoryFiles(promptConversation);
    const isResumingSession = Boolean(session.sessionId);
    const availableRoles = (await this.settings.getPublicSettings()).chatRoleConfigs;
    const agentMode = normalizeChatAgentMode(participant.agentMode);
    const permissions = this.participantPermissionsForRun(conversation, participant);
    this.consumeOneTimePermissionApprovals(conversation, participant);
    const usePromptRole = session.roleRuntime === "prompt-fallback";
    const prompt = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), availableRoles, {
      includeRoleInstructions: usePromptRole && !isResumingSession,
      permissions
    });
    const promptFallbackPrompt = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), availableRoles, {
      includeRoleInstructions: true,
      permissions
    });
    const resumeFallbackPrompt = isResumingSession
      ? this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), availableRoles, {
          includeRoleInstructions: usePromptRole,
          permissions
        })
      : undefined;
    const role = usePromptRole ? undefined : this.cliRoleOptions(participant, session, promptFallbackPrompt, permissions);
    const runPath = this.runPathForParticipant(conversation, participant, workspacePath, permissions);
    const cliParticipant: ParticipantConfig = {
      id: participant.id,
      kind: participant.kind,
      label: `@${participant.handle}`,
      model: participant.model
    };
    const progressSink = this.createAgentProgressSink(runId, progress, participant);
    const appToolCapabilities = normalizeChatAppToolCapabilities([
      ...normalizeChatAppToolCapabilities(session.roleAppToolCapabilities),
      "permissions.request"
    ]);
    const appMcp = this.appMcp?.issueToken({
      conversationId: conversation.id,
      participantId: participant.id,
      roleConfigId: session.roleConfigId,
      roleConfigVersion: session.roleConfigVersion,
      capabilities: appToolCapabilities
    });
    const appMcpToolNames = this.appMcpToolNames(appToolCapabilities);
    this.emitProgress(runId, progress, "debate", `@${participant.handle} is responding.`, {
      participantLabel: `@${participant.handle}`,
      agentProgress: {
        participantId: participant.id,
        participantLabel: `@${participant.handle}`,
        state: "running"
      }
    });
    try {
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
      this.applyCliRunMetadata(session, result, options.warnings);
      const guardViolation = result.ok ? this.chatResponseGuardViolation(result.content, triggerMessage) : undefined;
      if (guardViolation) {
        options.warnings.push(`@${participant.handle}: rejected response that mentioned ${guardViolation}; restarted the chat session and retried.`);
        session = await this.newSessionForParticipant(participant);
        const retryUsesPromptRole = session.roleRuntime === "prompt-fallback";
        const retryPromptBase = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), availableRoles, {
          includeRoleInstructions: retryUsesPromptRole,
          permissions
        });
        const retryPromptFallbackBase = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), availableRoles, {
          includeRoleInstructions: true,
          permissions
        });
        const retryPrompt = this.chatGuardRetryPrompt(retryPromptBase, guardViolation);
        const retryRole = retryUsesPromptRole
          ? undefined
          : this.cliRoleOptions(participant, session, this.chatGuardRetryPrompt(retryPromptFallbackBase, guardViolation), permissions);
        result = await this.cliRunner.run(cliParticipant, retryPrompt, runPath, undefined, "chat", signal, {
          persistSession: true,
          extraReadableDirs: [workspacePath],
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
        this.applyCliRunMetadata(session, result, options.warnings);
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
        options.warnings.push(`@${participant.handle}: rejected verbose affirmative confirmation; restarted the chat session and retried.`);
        session = await this.newSessionForParticipant(participant);
        const retryUsesPromptRole = session.roleRuntime === "prompt-fallback";
        const retryPromptBase = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), availableRoles, {
          includeRoleInstructions: retryUsesPromptRole,
          permissions
        });
        const retryPromptFallbackBase = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), availableRoles, {
          includeRoleInstructions: true,
          permissions
        });
        const retryPrompt = this.confirmationBrevityRetryPrompt(retryPromptBase);
        const retryRole = retryUsesPromptRole
          ? undefined
          : this.cliRoleOptions(participant, session, this.confirmationBrevityRetryPrompt(retryPromptFallbackBase), permissions);
        result = await this.cliRunner.run(cliParticipant, retryPrompt, runPath, undefined, "chat", signal, {
          persistSession: true,
          extraReadableDirs: [workspacePath],
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
        this.applyCliRunMetadata(session, result, options.warnings);
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
      const now = new Date().toISOString();
      session.updatedAt = now;
      if (result.sessionId) {
        session.sessionId = result.sessionId;
      }
      this.updateParticipantContextUsage(conversation, participant.id, result.contextUsage);
      const participantMessage = this.message(
        "participant",
        result.content,
        cliParticipant,
        {
          threadId: triggerMessage.metadata?.threadId ?? triggerMessage.id,
          parentMessageId: triggerMessage.id,
          chatThreadRootId: triggerMessage.metadata?.chatThreadRootId,
          sourceMessageId: triggerMessage.id,
          requesterParticipantId: options.continuation ? triggerMessage.participantId : undefined,
          approvedContinuation: options.continuation || undefined
        },
        result.ok ? "done" : "error"
      );
      if (!result.ok && result.error) {
        options.warnings.push(`@${participant.handle}: ${result.error}`);
      }
      if (result.ok) {
        const pendingMentions = this.pendingMentionsFromAgentReply(conversation, participant, result.content);
        const pendingChoice = this.pendingChoiceFromAgentReply(result.content);
        const requesterContinuationRequested = pendingMentions.length > 0 ? this.requesterContinuationRequested(result.content) : false;
        if (pendingMentions.length > 0 || pendingChoice) {
          participantMessage.metadata = {
            ...participantMessage.metadata,
            mentions: pendingMentions.length > 0 ? pendingMentions.map((mention) => mention.targetHandle) : undefined,
            pendingMentions: pendingMentions.length > 0 ? pendingMentions : undefined,
            pendingChoice,
            requesterContinuationRequested: requesterContinuationRequested || undefined
          };
        }
        session.lastSyncedMessageId = participantMessage.id;
      }
      this.upsertSession(conversation, session);
      this.lockParticipantRoleVersion(conversation, participant, session.roleConfigVersion);
      return [participantMessage];
    } finally {
      progressSink.finish();
    }
  }

  private appendParticipantTurnMessages(
    conversation: Conversation,
    participant: ChatParticipant,
    messages: ChatMessage[]
  ): void {
    conversation.messages.push(...messages);
    this.createImplicitPermissionApproval(conversation, participant, messages);
  }

  private buildPrompt(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    triggerMessage: ChatMessage,
    workspacePath: string,
    continuation: boolean,
    availableRoles: ChatRoleConfig[],
    options: { includeRoleInstructions: boolean; permissions: ChatAgentPermissions }
  ): string {
    const participants = this.chatParticipants(conversation);
    const historyMarkdownPath = path.join(workspacePath, "history.md");
    const historyJsonPath = path.join(workspacePath, "history.json");
    const sections = [
      [
        `You are @${participant.handle}. Continue the same chat session.`,
        `Role: ${session.roleLabel}.`,
        options.includeRoleInstructions
          ? ["Role instructions:", session.roleInstructions].join("\n")
          : "Use your configured role instructions for this participant.",
        this.participantRepositoryLine(conversation, participant, options.permissions),
        this.participantPermissionPolicy(participant, options.permissions),
        `Readable chat history Markdown: ${historyMarkdownPath}.`,
        `Readable chat history JSON: ${historyJsonPath}.`,
        "Read the history files when you need prior conversation context. Do not ask User to grant access to these app-managed history files.",
        "Participants:",
        "- User: human conversation owner, requirements authority, and clarification source. User messages appear as `User` in the transcript.",
        ...participants.map((item) => {
          const role = this.roleLabelForParticipant(conversation, item);
          return `- @${item.handle}: ${role} agent`;
        }),
        this.appToolPromptPolicy(session, availableRoles),
        "Mention policy: you may cite participant handles in normal prose for attribution; those citations do not request dispatch. To ask another participant to respond, include a dedicated `Participant requests:` block with one bullet per requested participant. Use `Participant requests: none` when you cite or identify participants but do not need follow-up. If you need to synthesize after the requested participants reply, add the exact line `Return to requester after replies: yes`. Mentioned agents and requester continuations will not run until User approves them.",
        "User choice policy: when User must pick one option before you can continue, include one dedicated `User choice:` block after your explanation. Format it as lines `T: short title`, `Q: question`, `O1: option label | optional description`, `O2: option label | optional description`, and optionally `R: O1`. Use at least two options. Ask at most one user choice in a message. The UI also lets User write a custom answer instead of choosing your suggestions. After User confirms, the app will send the selected option or custom answer back to you in this chat.",
        this.confirmationBrevityPolicy(),
        "Clarification policy: if you need clarification about goals, requirements, preferences, acceptance criteria, or user intent, ask User directly in your reply. Do not mention another agent for user-owned clarification.",
        "Thread policy: answer in the active thread. Do not assume a mentioned participant has answered until their reply appears in the transcript.",
        "Chat response guard: answer only in this chat message. Do not mention ExitPlanMode, plan files, tool availability, or recording/writing outside the chat unless User directly asks about those mechanics. If you make a decision, arbitration, plan, or summary, include it in this reply. Do not say it is posted above or recorded elsewhere unless you cite the exact existing chat message."
      ].join("\n"),
      "Triggering message identifiers:",
      this.triggeringMessageIdentifiers(triggerMessage),
      "Triggering message:",
      this.formatMessage(triggerMessage),
      continuation
        ? "Current request: continue after the approved participant replies and produce your next answer."
        : "Current request: answer the triggering message above.",
      "Write your next message in this chat."
    ];
    return sections.join("\n\n");
  }

  private triggeringMessageIdentifiers(message: ChatMessage): string {
    return [
      `Message ID: ${message.id}`,
      message.metadata?.threadId ? `Thread ID: ${message.metadata.threadId}` : "",
      message.metadata?.parentMessageId ? `Parent message ID: ${message.metadata.parentMessageId}` : "",
      message.metadata?.chatThreadRootId ? `Chat thread root ID: ${message.metadata.chatThreadRootId}` : ""
    ].filter(Boolean).join("\n");
  }

  private cliRoleOptions(
    participant: ChatParticipant,
    session: ChatParticipantSession,
    promptFallbackPrompt: string,
    permissions: ChatAgentPermissions
  ): CliAgentRoleOptions {
    return {
      name: this.roleRuntimeName(participant, session),
      description: `${session.roleLabel} participant @${participant.handle} in AI Consensus Chat.`,
      instructions: this.nativeRoleInstructions(participant, session, permissions),
      promptFallbackPrompt
    };
  }

  private nativeRoleInstructions(
    participant: ChatParticipant,
    session: ChatParticipantSession,
    permissions: ChatAgentPermissions
  ): string {
    return [
      `You are @${participant.handle} in AI Consensus Chat.`,
      `Role: ${session.roleLabel}.`,
      "Use this role for the whole CLI session.",
      "",
      "Role instructions:",
      session.roleInstructions,
      "",
      "Chat participant boundaries:",
      "- You are one participant in a multi-participant chat.",
      "- User is the human conversation owner, requirements authority, and clarification source.",
      "- Ask User directly when goals, requirements, preferences, acceptance criteria, or user intent are unclear.",
      "- Do not ask another participant for user-owned clarification.",
      "- When User must choose between concrete options, include one `User choice:` block with `T:`, `Q:`, `O1:`, `O2:`, and optional `R:` lines so the app can render choice buttons plus a custom-answer path.",
      "- App MCP tools are the required path for app-managed mutations. If blocked file-editing or web-access permissions are needed to complete User's request, call `app_permissions_request_change` through MCP instead of asking in prose or saying the task is blocked.",
      "- For permission requests, use `workspaceWrite` for file edits and `webAccess` for web lookup. Do not claim the permission is granted until the tool result or a later app message confirms approval.",
      hasChatAppToolCapability(session.roleAppToolCapabilities, "participants.manage")
        ? "- You may use `app_roster_describe_options` to inspect available chat roles, CLI providers, configured models, and roster rules. Use `app_roster_request_change` only when User asks you to manage chat participants; the app validates and gates mutations through User approval."
        : "- You are not allowed to manage chat participants through app tools.",
      `- ${this.participantPermissionPolicy(participant, permissions)}`,
      `- ${this.confirmationBrevityPolicy()}`,
      "- Answer in the active chat message; do not claim to write, record, or post work elsewhere.",
      "- Follow each turn's chat prompt for history paths, the triggering message, participants, and dispatch rules."
    ].join("\n");
  }

  private appToolPromptPolicy(session: ChatParticipantSession, availableRoles: ChatRoleConfig[]): string {
    const lines = [
      "App MCP tools: use the connected `ai_consensus` MCP server for app-managed requests. Do not try to change app state by editing files, shelling out, or asking User in prose when an app MCP tool exists.",
      "Permission MCP tool: `app_permissions_request_change` is available when this participant needs User approval for file-editing or web-access permissions.",
      "Required permission workflow: if the current task needs a blocked capability, call `app_permissions_request_change` before answering that the work cannot be done. Send JSON like `{ \"permissions\": [\"webAccess\"], \"reason\": \"Need live web lookup to answer User's trademark question.\" }` or `{ \"permissions\": [\"workspaceWrite\"], \"reason\": \"Need to edit the requested file.\" }`.",
      "After a permission MCP call, the app will ask User to approve. If the result is pending approval, say only that the permission request is awaiting User approval; do not claim the permission was granted until the tool result or a later app message confirms approval."
    ];
    if (!hasChatAppToolCapability(session.roleAppToolCapabilities, "participants.manage")) {
      return [
        ...lines,
        "App tools: no chat-management app tools are available to this participant."
      ].join("\n");
    }
    const roleLines = availableRoles
      .filter((role) => role.id.trim() && role.label.trim())
      .map((role) => `- ${role.id}: ${role.label}`);
    return [
      ...lines,
      "App tools: `app_roster_describe_options` is available for read-only discovery of current roles, CLI providers, configured models, current roster, defaults, and validation rules.",
      "App tools: `app_roster_request_change` is available for User-requested participant roster changes.",
      "Call `app_roster_describe_options` first when you need exact role IDs, provider availability, configured models, or handle constraints.",
      "When using it, send JSON with `operations`, where each operation is `{ \"type\": \"add\", \"participant\": { \"handle\", \"roleConfigId\", \"kind\" } }`.",
      "The app will validate the request and either create a User approval item or auto-apply it if User already allowed roster management for this chat.",
      "Available role IDs:",
      ...roleLines
    ].join("\n");
  }

  private appMcpToolNames(capabilities: ChatAppToolCapability[]): string[] {
    return CHAT_APP_MCP_TOOL_NAMES.filter((toolName) => {
      if (toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL) {
        return hasChatAppToolCapability(capabilities, "permissions.request");
      }
      return hasChatAppToolCapability(capabilities, "participants.manage");
    });
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

  private applyCliRunMetadata(session: ChatParticipantSession, result: ParticipantRunResult, warnings: string[]): void {
    if (this.isKnownRoleRuntime(result.roleRuntime)) {
      session.roleRuntime = result.roleRuntime;
    }
    for (const warning of result.warnings ?? []) {
      warnings.push(warning);
    }
  }

  private async sessionForParticipant(conversation: Conversation, participant: ChatParticipant): Promise<ChatParticipantSession> {
    const existing = this.chatSessions(conversation).find((session) => session.participantId === participant.id);
    const role = await this.roleForParticipant(participant);
    const runtimeConfigVersion = this.runtimeConfigVersionFor(participant);
    if (
      existing &&
      existing.roleConfigId === role.id &&
      existing.roleConfigVersion >= role.version &&
      chatAppToolCapabilitiesEqual(existing.roleAppToolCapabilities, role.appToolCapabilities) &&
      existing.participantKind === participant.kind &&
      this.normalizedModel(existing.participantModel) === this.normalizedModel(participant.model) &&
      normalizeChatAgentMode(existing.participantAgentMode) === normalizeChatAgentMode(participant.agentMode) &&
      chatAgentPermissionsEqual(existing.participantPermissions, normalizeChatAgentPermissions(participant.permissions)) &&
      this.isKnownRoleRuntime(existing.roleRuntime) &&
      existing.runtimeConfigVersion === runtimeConfigVersion
    ) {
      return existing;
    }
    return this.newSessionForParticipant(participant, role, runtimeConfigVersion);
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

  private runtimeConfigVersionFor(_participant: ChatParticipant): number {
    return CHAT_ROLE_RUNTIME_CONFIG_VERSION;
  }

  private preferredRoleRuntimeFor(participant: ChatParticipant): ChatRoleRuntime {
    return participant.kind === "claude-code" ? "claude-agent" : "codex-developer-instructions";
  }

  private isKnownRoleRuntime(value: ChatRoleRuntime | undefined): value is ChatRoleRuntime {
    return value === "claude-agent" || value === "codex-developer-instructions" || value === "prompt-fallback";
  }

  private normalizedModel(value: string | undefined): string {
    return value?.trim() ?? "";
  }

  private runPathForParticipant(
    conversation: Conversation,
    participant: ChatParticipant,
    workspacePath: string,
    runPermissions: ChatAgentPermissions
  ): string {
    const permissions = effectiveChatAgentPermissions(
      normalizeChatAgentMode(participant.agentMode),
      runPermissions
    );
    return permissions.repoRead && conversation.repoPath ? conversation.repoPath : workspacePath;
  }

  private participantRepositoryLine(
    conversation: Conversation,
    participant: ChatParticipant,
    runPermissions: ChatAgentPermissions
  ): string {
    const permissions = effectiveChatAgentPermissions(
      normalizeChatAgentMode(participant.agentMode),
      runPermissions
    );
    if (!conversation.repoPath) {
      return "Repository: none selected.";
    }
    return permissions.repoRead
      ? `Repository: ${conversation.repoPath}.`
      : "Repository: selected for the chat but not granted to this participant.";
  }

  private participantPermissionPolicy(
    participant: ChatParticipant,
    runPermissions: ChatAgentPermissions
  ): string {
    const mode = normalizeChatAgentMode(participant.agentMode);
    const permissions = effectiveChatAgentPermissions(mode, runPermissions);
    const shellRules = permissions.shell.enabled && permissions.shell.rules.length > 0
      ? permissions.shell.rules.map((rule) => `${rule.action} ${rule.match} ${JSON.stringify(rule.pattern)}`).join("; ")
      : "none";
    return [
      `Agent mode: ${mode}.`,
      `Permissions: repo read ${permissions.repoRead ? "allowed" : "blocked"}, shell commands ${permissions.shell.enabled ? "allowed" : "blocked"}, workspace edits ${permissions.workspaceWrite ? "allowed" : "blocked"}, web access ${permissions.webAccess ? "allowed" : "blocked"}.`,
      permissions.repoRead
        ? "Repository files may be inspected read-only when repository context is selected; app-managed chat history files may be read for conversation context."
        : "Do not inspect selected repository files; app-managed chat history files may still be read for conversation context.",
      permissions.shell.enabled ? `Shell command rules: ${shellRules}. Follow deny rules strictly; ask rules require native CLI approval; allow rules may run without extra confirmation when the CLI supports them.` : "General shell commands are blocked; this does not block read-only file inspection allowed by repo or history context.",
      permissions.workspaceWrite ? "If you change files, summarize the changed files and verification in this chat reply." : "Do not edit files."
    ].join(" ");
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
      participantKind: participant.kind,
      participantModel: participant.model?.trim() || "",
      participantAgentMode: normalizeChatAgentMode(participant.agentMode),
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
    const roles = (await this.settings.getPublicSettings()).chatRoleConfigs;
    const role = roles.find((item) => item.id === participant.roleConfigId);
    if (!role) {
      throw new Error(`Unknown role for @${participant.handle}.`);
    }
    return role;
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
    return "Confirmation brevity policy: when the triggering request asks whether you agree, confirm, approve, acknowledge, sign off, or whether you have objections, reply with only a short confirmation such as `Yes, agree.`, `Confirmed.`, or `No objections.` unless you have a real objection, caveat, or correction. If you do have one, start with `Objection:` or `Concern:` and include only the material blocker; do not restate the prior proposal.";
  }

  private confirmationBrevityRetryPrompt(prompt: string): string {
    return [
      "Your previous draft was rejected because the triggering request only asked for agreement or confirmation, and you replied with a verbose affirmative restatement.",
      "Rewrite with only one short confirmation sentence, such as `Yes, agree.`, `Confirmed.`, or `No objections.` If you have a real objection, caveat, or correction, start with `Objection:` or `Concern:` and include only that material blocker.",
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
      /\b(?:any|no)\s+objections?\b/i,
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
    conversation.messages = stored.messages;
    conversation.metadata = stored.metadata;
    conversation.updatedAt = stored.updatedAt;
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

  private async requireParticipantCapability(participant: ChatParticipant, capability: ChatAppToolCapability): Promise<void> {
    const role = await this.roleForParticipant(participant);
    if (!hasChatAppToolCapability(role.appToolCapabilities, capability)) {
      throw new Error(`@${participant.handle} is not allowed to use ${capability}.`);
    }
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
    messages: ChatMessage[]
  ): void {
    const request = this.implicitPermissionChangeRequest(participant, messages);
    if (!request) {
      return;
    }
    const prepared = this.preparePermissionChange(participant, request);
    if (prepared.permissions.length === 0 || this.hasPendingPermissionApproval(conversation, participant, prepared.permissions)) {
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
    this.upsertAppToolApproval(conversation, approval);
    conversation.messages.push(this.message("system", `Permission approval needed for @${participant.handle}: ${prepared.summary}.`, undefined, {
      threadId: "system"
    }));
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
    if (requested.size === 0) {
      return undefined;
    }
    return {
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

  private hasPendingPermissionApproval(
    conversation: Conversation,
    participant: ChatParticipant,
    permissions: ChatPermissionGrant[]
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
      const request = approval.request as ChatPermissionChangeRequest;
      return permissions.every((permission) => request.permissions.includes(permission));
    });
  }

  private normalizePermissionChangeRequest(raw: unknown): ChatPermissionChangeRequest {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Permission change request must be an object.");
    }
    const record = raw as { reason?: unknown; permissions?: unknown };
    if (!Array.isArray(record.permissions) || record.permissions.length === 0) {
      throw new Error("Permission change request needs at least one permission.");
    }
    const permissions = new Set<ChatPermissionGrant>();
    for (const permission of record.permissions) {
      if (permission === "workspaceWrite" || permission === "webAccess") {
        permissions.add(permission);
      } else {
        throw new Error(`Unsupported permission request: ${String(permission)}.`);
      }
    }
    return {
      reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 500) || undefined : undefined,
      permissions: Array.from(permissions)
    };
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
    const mode = normalizeChatAgentMode(requester.agentMode);
    if (mode === "plan" && request.permissions.includes("workspaceWrite")) {
      throw new Error("Plan mode blocks file edits for this participant. Switch the participant to default or auto mode before granting edit access.");
    }
    const current = normalizeChatAgentPermissions(requester.permissions);
    const permissions = request.permissions.filter((permission) => !current[permission]);
    const summaryPermissions = permissions.length > 0 ? permissions : request.permissions;
    return {
      request: {
        reason: request.reason,
        permissions: request.permissions
      },
      permissions,
      summary: `Grant @${requester.handle} ${this.formatPermissionGrantList(summaryPermissions)}`
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
    const permissions = normalizeChatAgentPermissions(target.permissions);
    const nextPermissions = {
      ...permissions,
      workspaceWrite: permissions.workspaceWrite || prepared.permissions.includes("workspaceWrite"),
      webAccess: permissions.webAccess || prepared.permissions.includes("webAccess")
    };
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

  private participantPermissionsForRun(conversation: Conversation, participant: ChatParticipant): ChatAgentPermissions {
    const permissions = normalizeChatAgentPermissions(participant.permissions);
    for (const approval of this.oneTimePermissionApprovalsForParticipant(conversation, participant)) {
      if (!this.isPermissionChangeRequest(approval.request)) {
        continue;
      }
      for (const permission of approval.request.permissions) {
        permissions[permission] = true;
      }
    }
    return permissions;
  }

  private consumeOneTimePermissionApprovals(conversation: Conversation, participant: ChatParticipant): void {
    const approvals = this.chatAppToolApprovals(conversation);
    const now = new Date().toISOString();
    let changed = false;
    const nextApprovals = approvals.map((approval) => {
      if (!this.isUnconsumedOneTimePermissionApproval(approval, participant)) {
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

  private formatPermissionGrantList(permissions: ChatPermissionGrant[]): string {
    const labels = permissions.map((permission) => permission === "workspaceWrite" ? "file editing" : "web access");
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
    capability: ChatAppToolCapability
  ): ChatAppToolApprovalPolicy | undefined {
    return this.chatAppToolApprovalPolicies(conversation).find((policy) =>
      policy.participantId === participant.id &&
      policy.roleConfigId === participant.roleConfigId &&
      policy.toolName === toolName &&
      policy.capability === capability &&
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
        message.content.trim(),
        ""
      ].filter(Boolean).join("\n"))
    ].join("\n");
  }

  private roleLabelForParticipant(conversation: Conversation, participant: ChatParticipant): string {
    const session = this.chatSessions(conversation).find((item) => item.participantId === participant.id);
    return session?.roleLabel ?? participant.roleConfigId;
  }

  private formatMessage(message: ChatMessage): string {
    return [
      `[${message.createdAt}] ${this.messageAuthor(message)} (${message.id})`,
      message.metadata?.threadId ? `Thread: ${message.metadata.threadId}` : "",
      message.metadata?.parentMessageId ? `Parent: ${message.metadata.parentMessageId}` : "",
      message.metadata?.chatThreadRootId ? `Chat thread root: ${message.metadata.chatThreadRootId}` : "",
      message.content.trim()
    ].filter(Boolean).join("\n");
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
    return (
      typeof approval.id === "string" &&
      typeof approval.conversationId === "string" &&
      typeof approval.requesterParticipantId === "string" &&
      typeof approval.requesterHandle === "string" &&
      typeof approval.requesterRoleConfigId === "string" &&
      (isRosterApproval || isPermissionApproval) &&
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
    const permissions = (request as Partial<ChatPermissionChangeRequest>).permissions;
    return Array.isArray(permissions) && permissions.every((permission) => permission === "workspaceWrite" || permission === "webAccess");
  }

  private isChatAppToolApprovalPolicy(item: unknown): item is ChatAppToolApprovalPolicy {
    const policy = item as Partial<ChatAppToolApprovalPolicy>;
    return (
      typeof policy.id === "string" &&
      typeof policy.participantId === "string" &&
      typeof policy.roleConfigId === "string" &&
      policy.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL &&
      policy.capability === "participants.manage" &&
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
    return conversation;
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
    participant: ChatParticipant
  ): { emit: (event: CliAgentOutputEvent) => void; finish: () => void } {
    if (!progress) {
      return { emit: () => undefined, finish: () => undefined };
    }
    const participantLabel = `@${participant.handle}`;
    let finished = false;

    const emitNow = (event: CliAgentOutputEvent): void => {
      const activity = event.text.trim();
      if (!progress || finished || !activity) {
        return;
      }
      this.emitProgress(runId, progress, "debate", `${participantLabel} is responding.`, {
        participantLabel,
        agentProgress: {
          participantId: participant.id,
          participantLabel,
          state: "running",
          activity
        }
      });
    };

    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      this.emitProgress(runId, progress, "debate", `${participantLabel} finished.`, {
        participantLabel,
        agentProgress: {
          participantId: participant.id,
          participantLabel,
          state: "finished"
        }
      });
    };

    return {
      emit: emitNow,
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
