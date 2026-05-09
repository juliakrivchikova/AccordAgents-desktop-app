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
import { DebugLogService } from "./debugLogs";
import { SettingsService } from "./settings";
import { StorageService } from "./storage";

type ProgressCallback = (progress: ReviewProgress) => void;

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_PROMPT_DELTA_MESSAGES = 80;

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
    const threadId = request.threadId?.trim() || randomUUID();
    const userMessage = this.message("user", content, undefined, {
      threadId,
      parentMessageId: request.parentMessageId
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
      conversation.messages.push(this.message("system", warning, undefined, { threadId: userMessage.metadata?.threadId ?? threadId, parentMessageId: userMessage.id }));
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
    if (selectedMentions.length === 0 && request.approve) {
      throw new Error("Select at least one pending mention.");
    }

    if (!request.approve) {
      this.updatePendingMentionStatus(sourceMessage, new Set(pendingMentions.map((mention) => mention.targetParticipantId)), "rejected");
      conversation.updatedAt = new Date().toISOString();
      await this.saveConversation(conversation);
      return { conversation, warnings };
    }

    this.updatePendingMentionStatus(sourceMessage, requestedIds, "approved");
    conversation.metadata = { ...conversation.metadata, running: true, runId };
    conversation.updatedAt = new Date().toISOString();
    this.queueSnapshot(conversation);

    const participants = this.chatParticipants(conversation);
    const targets = selectedMentions
      .map((mention) => participants.find((participant) => participant.id === mention.targetParticipantId))
      .filter((participant): participant is ChatParticipant => Boolean(participant));
    this.emitProgress(runId, progress, "initial", `Running ${targets.length} approved mention${targets.length === 1 ? "" : "s"}.`, {
      total: targets.length,
      completed: 0
    });
    await this.runParticipantBatch(conversation, targets, sourceMessage, runId, signal, progress, warnings);

    if (request.continueRequester && sourceMessage.participantId) {
      const requester = participants.find((participant) => participant.id === sourceMessage.participantId);
      if (requester) {
        this.emitProgress(runId, progress, "debate", `Returning to @${requester.handle}.`, {
          participantLabel: `@${requester.handle}`
        });
        await this.runParticipantTurn(conversation, requester, sourceMessage, runId, signal, progress, {
          continuation: true,
          warnings
        });
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
        const messages = await this.runParticipantTurn(conversation, participant, triggerMessage, runId, signal, undefined, {
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
    const session = await this.sessionForParticipant(conversation, participant);
    const promptConversation = options.promptConversation ?? conversation;
    const workspacePath = options.workspacePath ?? await this.ensureHistoryFiles(promptConversation);
    const prompt = this.buildPrompt(promptConversation, participant, session, triggerMessage, workspacePath, Boolean(options.continuation));
    const runPath = conversation.repoPath || workspacePath;
    const cliParticipant: ParticipantConfig = {
      id: participant.id,
      kind: participant.kind,
      label: `@${participant.handle}`,
      model: participant.model
    };
    this.emitProgress(runId, progress, "debate", `@${participant.handle} is responding.`, {
      participantLabel: `@${participant.handle}`
    });
    const result = await this.cliRunner.run(cliParticipant, prompt, runPath, undefined, "chat", signal, {
      persistSession: true,
      sessionId: session.sessionId
    });
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
        participantMessage.metadata = {
          ...participantMessage.metadata,
          mentions: pendingMentions.map((mention) => mention.targetHandle),
          pendingMentions
        };
      }
    }
    session.lastSyncedMessageId = participantMessage.id;
    this.upsertSession(conversation, session);
    this.lockParticipantRoleVersion(conversation, participant, session.roleConfigVersion);
    return [participantMessage];
  }

  private buildPrompt(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    triggerMessage: ChatMessage,
    workspacePath: string,
    continuation: boolean
  ): string {
    const participants = this.chatParticipants(conversation);
    const deltaMessages = this.messagesSince(conversation, session.lastSyncedMessageId);
    const threadMessages = conversation.messages.filter((message) => message.metadata?.threadId === (triggerMessage.metadata?.threadId ?? triggerMessage.id));
    const sections = [
      [
        `You are @${participant.handle}. Continue the same chat session.`,
        `Role: ${session.roleLabel}.`,
        "Role instructions:",
        session.roleInstructions,
        conversation.repoPath ? `Repository: ${conversation.repoPath} (read-only).` : "Repository: none selected.",
        `Internal chat history file: ${path.join(workspacePath, "history.md")}.`,
        "Participants:",
        "- User: human conversation owner, requirements authority, and clarification source. User messages appear as `User` in the transcript.",
        ...participants.map((item) => {
          const role = this.roleLabelForParticipant(conversation, item);
          return `- @${item.handle}: ${role} agent`;
        }),
        "Mention policy: you may mention another agent when you need independent technical analysis, review, or source comparison, but mentioned agents will not run until the user approves the mention.",
        "Clarification policy: if you need clarification about goals, requirements, preferences, acceptance criteria, or user intent, ask User directly in your reply. Do not mention another agent for user-owned clarification.",
        "Thread policy: answer in the active thread. Do not assume a mentioned participant has answered until their reply appears in the transcript."
      ].join("\n"),
      "Messages since your last turn:",
      this.formatMessages(deltaMessages.length > 0 ? deltaMessages : conversation.messages.slice(-MAX_PROMPT_DELTA_MESSAGES)),
      "Active thread:",
      this.formatMessages(threadMessages),
      continuation ? "Current request: continue after the approved participant replies and produce your next answer." : `Current request:\n${this.formatMessage(triggerMessage)}`,
      "Write your next message in this chat."
    ];
    return sections.join("\n\n");
  }

  private async sessionForParticipant(conversation: Conversation, participant: ChatParticipant): Promise<ChatParticipantSession> {
    const existing = this.chatSessions(conversation).find((session) => session.participantId === participant.id);
    if (existing) {
      return existing;
    }
    const role = await this.roleForParticipant(participant);
    return {
      participantId: participant.id,
      sessionId: "",
      roleConfigId: role.id,
      roleConfigVersion: role.version,
      roleLabel: role.label,
      roleInstructions: role.instructions,
      updatedAt: new Date().toISOString()
    };
  }

  private async roleForParticipant(participant: ChatParticipant): Promise<ChatRoleConfig> {
    const roles = (await this.settings.getPublicSettings()).chatRoleConfigs;
    const role = roles.find((item) => item.id === participant.roleConfigId);
    if (!role) {
      throw new Error(`Unknown role for @${participant.handle}.`);
    }
    return role;
  }

  private lockParticipantRoleVersion(conversation: Conversation, participant: ChatParticipant, version: number): void {
    const participants = this.chatParticipants(conversation).map((item) =>
      item.id === participant.id ? { ...item, roleConfigVersion: item.roleConfigVersion ?? version } : item
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
        model: item.model?.trim() || undefined
      };
    });
  }

  private pendingMentionsFromAgentReply(conversation: Conversation, sourceParticipant: ChatParticipant, content: string): ChatPendingMention[] {
    const participants = this.chatParticipants(conversation);
    const handles = this.extractMentions(content);
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
    const withoutCode = content.replace(/```[\s\S]*?```/g, "");
    const matches = withoutCode.matchAll(/@([A-Za-z0-9_-]{1,32})/g);
    return Array.from(matches, (match) => match[1]);
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

  private messagesSince(conversation: Conversation, messageId: string | undefined): ChatMessage[] {
    if (!messageId) {
      return conversation.messages.slice(-MAX_PROMPT_DELTA_MESSAGES);
    }
    const index = conversation.messages.findIndex((message) => message.id === messageId);
    if (index < 0) {
      return conversation.messages.slice(-MAX_PROMPT_DELTA_MESSAGES);
    }
    return conversation.messages.slice(index + 1).slice(-MAX_PROMPT_DELTA_MESSAGES);
  }

  private formatMessages(messages: ChatMessage[]): string {
    if (messages.length === 0) {
      return "(none)";
    }
    return messages.map((message) => this.formatMessage(message)).join("\n\n");
  }

  private formatMessage(message: ChatMessage): string {
    return [
      `[${message.createdAt}] ${this.messageAuthor(message)} (${message.id})`,
      message.metadata?.threadId ? `Thread: ${message.metadata.threadId}` : "",
      message.metadata?.parentMessageId ? `Parent: ${message.metadata.parentMessageId}` : "",
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
