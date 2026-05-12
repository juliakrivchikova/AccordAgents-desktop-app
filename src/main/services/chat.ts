import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type {
  AddChatParticipantRequest,
  ChatMessage,
  ChatParticipant,
  ChatParticipantSession,
  ChatPendingMention,
  ChatProviderKind,
  ChatRoleRuntime,
  ChatRoleConfig,
  Conversation,
  CreateChatConversationRequest,
  ParticipantConfig,
  RespondToChatMentionsRequest,
  ReviewProgress,
  SendChatMessageRequest,
  StartReviewResult
} from "../../shared/types";
import { CliAgentRunner } from "./cliAgents";
import type { CliAgentOutputEvent, CliAgentRoleOptions } from "./cliAgents";
import { DebugLogService } from "./debugLogs";
import type { ParticipantRunResult } from "./providers";
import { SettingsService } from "./settings";
import { StorageService } from "./storage";

type ProgressCallback = (progress: ReviewProgress) => void;

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const CHAT_ROLE_RUNTIME_CONFIG_VERSION = 3;
const CHAT_WARM_AGENT_IDLE_TIMEOUT_MS = 10 * 60_000;

export class ChatService {
  private readonly saveQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly cliRunner: CliAgentRunner,
    private readonly debugLogs: DebugLogService,
    private readonly onConversationSnapshot?: (conversation: Conversation) => void
  ) {}

  async createConversation(request: CreateChatConversationRequest): Promise<StartReviewResult> {
    const now = new Date().toISOString();
    const participants = await this.validateParticipants(request.participants);
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

    const dispatch = this.resolveMentionTargets(conversation, content);
    for (const unknown of dispatch.unknownHandles) {
      const warning = `No participant named @${unknown}.`;
      warnings.push(warning);
      conversation.messages.push(this.message("system", warning, undefined, {
        threadId: userMessage.metadata?.threadId ?? threadId,
        parentMessageId: userMessage.id,
        chatThreadRootId
      }));
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
        conversation.messages.push(...messages);
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
        return messages;
      })
    );
    for (const messages of results) {
      conversation.messages.push(...messages);
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
    const usePromptRole = session.roleRuntime === "prompt-fallback";
    const prompt = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
      includeRoleInstructions: usePromptRole && !isResumingSession
    });
    const promptFallbackPrompt = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
      includeRoleInstructions: true
    });
    const resumeFallbackPrompt = isResumingSession
      ? this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
          includeRoleInstructions: usePromptRole
        })
      : undefined;
    const role = usePromptRole ? undefined : this.cliRoleOptions(participant, session, promptFallbackPrompt);
    const runPath = conversation.repoPath || workspacePath;
    const cliParticipant: ParticipantConfig = {
      id: participant.id,
      kind: participant.kind,
      label: `@${participant.handle}`,
      model: participant.model
    };
    const progressSink = this.createAgentProgressSink(runId, progress, participant);
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
        onOutput: progressSink.emit,
        warm: {
          conversationId: conversation.id,
          participantId: participant.id,
          contextKey: this.warmAgentContextKey(conversation, participant, session, runPath, workspacePath),
          idleTimeoutMs: CHAT_WARM_AGENT_IDLE_TIMEOUT_MS
        }
      });
      this.applyCliRunMetadata(session, result, options.warnings);
      const guardViolation = result.ok ? this.chatResponseGuardViolation(result.content, triggerMessage) : undefined;
      if (guardViolation) {
        options.warnings.push(`@${participant.handle}: rejected response that mentioned ${guardViolation}; restarted the chat session and retried.`);
        session = await this.newSessionForParticipant(participant);
        const retryUsesPromptRole = session.roleRuntime === "prompt-fallback";
        const retryPromptBase = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
          includeRoleInstructions: retryUsesPromptRole
        });
        const retryPromptFallbackBase = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation), {
          includeRoleInstructions: true
        });
        const retryPrompt = this.chatGuardRetryPrompt(retryPromptBase, guardViolation);
        const retryRole = retryUsesPromptRole
          ? undefined
          : this.cliRoleOptions(participant, session, this.chatGuardRetryPrompt(retryPromptFallbackBase, guardViolation));
        result = await this.cliRunner.run(cliParticipant, retryPrompt, runPath, undefined, "chat", signal, {
          persistSession: true,
          extraReadableDirs: [workspacePath],
          role: retryRole,
          onOutput: progressSink.emit,
          warm: {
            conversationId: conversation.id,
            participantId: participant.id,
            contextKey: this.warmAgentContextKey(conversation, participant, session, runPath, workspacePath),
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
      const now = new Date().toISOString();
      session.updatedAt = now;
      if (result.sessionId) {
        session.sessionId = result.sessionId;
      }
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
        if (pendingMentions.length > 0) {
          const requesterContinuationRequested = this.requesterContinuationRequested(result.content);
          participantMessage.metadata = {
            ...participantMessage.metadata,
            mentions: pendingMentions.map((mention) => mention.targetHandle),
            pendingMentions,
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

  private buildPrompt(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    triggerMessage: ChatMessage,
    workspacePath: string,
    continuation: boolean,
    options: { includeRoleInstructions: boolean }
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
        conversation.repoPath ? `Repository: ${conversation.repoPath} (read-only).` : "Repository: none selected.",
        `Readable chat history Markdown: ${historyMarkdownPath}.`,
        `Readable chat history JSON: ${historyJsonPath}.`,
        "Read the history files when you need prior conversation context. Do not ask User to grant access to these app-managed history files.",
        "Participants:",
        "- User: human conversation owner, requirements authority, and clarification source. User messages appear as `User` in the transcript.",
        ...participants.map((item) => {
          const role = this.roleLabelForParticipant(conversation, item);
          return `- @${item.handle}: ${role} agent`;
        }),
        "Mention policy: you may cite participant handles in normal prose for attribution; those citations do not request dispatch. To ask another participant to respond, include a dedicated `Participant requests:` block with one bullet per requested participant. Use `Participant requests: none` when you cite or identify participants but do not need follow-up. If you need to synthesize after the requested participants reply, add the exact line `Return to requester after replies: yes`. Mentioned agents and requester continuations will not run until User approves them.",
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

  private cliRoleOptions(participant: ChatParticipant, session: ChatParticipantSession, promptFallbackPrompt: string): CliAgentRoleOptions {
    return {
      name: this.roleRuntimeName(participant, session),
      description: `${session.roleLabel} participant @${participant.handle} in AI Consensus Chat.`,
      instructions: this.nativeRoleInstructions(participant, session),
      promptFallbackPrompt
    };
  }

  private nativeRoleInstructions(participant: ChatParticipant, session: ChatParticipantSession): string {
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
      "- Answer in the active chat message; do not claim to write, record, or post work elsewhere.",
      "- Follow each turn's chat prompt for history paths, the triggering message, participants, and dispatch rules."
    ].join("\n");
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
      existing.participantKind === participant.kind &&
      this.normalizedModel(existing.participantModel) === this.normalizedModel(participant.model) &&
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
      roleRuntime: this.preferredRoleRuntimeFor(participant),
      participantKind: participant.kind,
      participantModel: participant.model?.trim() || undefined,
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

  private warmAgentContextKey(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    runPath: string,
    workspacePath: string
  ): string {
    return JSON.stringify({
      conversationId: conversation.id,
      participantId: participant.id,
      participantKind: participant.kind,
      participantModel: participant.model?.trim() || "",
      roleConfigId: session.roleConfigId,
      roleConfigVersion: session.roleConfigVersion,
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

  private async validateParticipants(
    items: CreateChatConversationRequest["participants"],
    existing: ChatParticipant[] = []
  ): Promise<ChatParticipant[]> {
    if (items.length === 0 && existing.length === 0) {
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
        avatarId: item.avatarId?.trim() || undefined
      };
    });
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

  private chatSessions(conversation: Conversation): ChatParticipantSession[] {
    const value = conversation.metadata.participantSessions;
    return Array.isArray(value)
      ? value.filter((item): item is ChatParticipantSession => {
          const session = item as Partial<ChatParticipantSession>;
          return typeof session.participantId === "string" && typeof session.sessionId === "string";
        })
      : [];
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
