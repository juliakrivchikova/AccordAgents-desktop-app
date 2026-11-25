import { mainSessionParticipantId } from "../../../../shared/mainSession";
import { sessionsTaskTitle } from "../../../../shared/mainSessionView";
import { hubTurnRunId } from "../../../../shared/hubOps";
import type { ChatMessage, ChatParticipant, ChatParticipantRequestItem, Conversation } from "../../../../shared/types";
import { sanitizeAutoChatTitleSuggestion } from "../../../../shared/chatTitles";
import { chatParticipants } from "../members/identity";
import {
  actorMatchesAutoTitleEligibility, chatAutoTitleEligibility, chatAutoTitleMetadata, initialAutoTitleEligibility,
  metadataWithFirstAgentChatTitle, metadataWithoutAutoTitleEligibility, normalizeChatTitleToolRequest
} from "../store/titles";
import { deliveryTargetsOf } from "../turns/deliveryTargets";
import type { ChatAppMcpActor } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Titles the chat gets from its members. */
export class ChatTitles {
  constructor(
    private readonly chat: Pick<ChatModules, "activeRuns" | "chatHistory" | "host" | "store">,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "storage">
  ) {}

  /**
   * Members of a sessions-view chat made before the title of their task was
   * kept with them (ChatParticipant.taskTitle) get it once, from the chat's
   * whole stored history, so the view names them however much of the chat a
   * device has loaded: the newest title the main session gave a task of
   * theirs (their delegation), else their first task's first line
   * (sessionsTaskTitle). Never a handle: a member that never had a task keeps
   * none, and the view names it "Agent". Done once per chat
   * (metadata.sessionsTaskTitlesBackfilled); members added later get theirs
   * when they are made. `opened`: the chat as just opened, read only to
   * decide whether there is anything to do.
   */
  async backfillSessionsTaskTitles(opened: Pick<Conversation, "id" | "kind" | "metadata">): Promise<void> {
    if (opened.kind !== "chat" || opened.metadata.sessionsTaskTitlesBackfilled === true) return;
    const mainId = mainSessionParticipantId(opened.metadata);
    if (!mainId) return;
    const lacking = (participants: readonly ChatParticipant[]): ChatParticipant[] =>
      participants.filter((participant) => participant.id !== mainId && !(typeof participant.taskTitle === "string" && participant.taskTitle.trim()));
    if (lacking(chatParticipants(opened as Conversation)).length === 0) return;
    const batches = await this.deps.storage.chatRequestBatches(opened.id);
    const given = new Map<string, string>();
    const first = new Map<string, ChatParticipantRequestItem>();
    for (const batch of batches) {
      for (const item of batch.items) {
        if (!item || typeof item.targetParticipantId !== "string") continue;
        if (!first.has(item.targetParticipantId)) first.set(item.targetParticipantId, item);
        // An inferred request's title is the app's (titleTaskByMember).
        const title = batch.source !== "inferred" && typeof item.title === "string" ? item.title.replace(/\s+/g, " ").trim() : "";
        if (title) given.set(item.targetParticipantId, title);
      }
    }
    const titleOf = (participantId: string): string => {
      const kept = given.get(participantId);
      if (kept) return kept;
      const task = first.get(participantId);
      return task ? sessionsTaskTitle(task) : "";
    };
    await this.chat.store.waitForQueuedSave(opened.id);
    const conversation = await this.deps.storage.getConversation(opened.id);
    if (!conversation || conversation.kind !== "chat" || conversation.metadata.sessionsTaskTitlesBackfilled === true) return;
    await this.chat.store.withChatMutation(conversation, async () => {
      const missing = new Set(lacking(chatParticipants(conversation)).map((participant) => participant.id));
      const participants = chatParticipants(conversation).map((participant) => {
        const title = missing.has(participant.id) ? titleOf(participant.id) : "";
        return title ? { ...participant, taskTitle: title } : participant;
      });
      conversation.metadata = { ...conversation.metadata, participants, sessionsTaskTitlesBackfilled: true };
      await this.chat.store.saveConversation(conversation);
    });
    await this.deps.debugLogs.write("chat.sessions-titles.backfill", {
      conversationId: opened.id,
      titled: [...first.keys()].filter((id) => titleOf(id)).length
    });
  }

  async setChatTitleFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    const request = normalizeChatTitleToolRequest(rawRequest);
    const title = sanitizeAutoChatTitleSuggestion(request.title);
    if (!title) {
      return {
        ok: false,
        status: "ignored",
        reason: "invalid_title"
      };
    }
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    let applied = false;
    let result: Record<string, unknown> = {
      ok: false,
      status: "ignored",
      reason: "not_eligible"
    };
    await this.chat.store.withChatMutation(conversation, async () => {
      if (chatAutoTitleMetadata(conversation)) {
        result = {
          ok: false,
          status: "ignored",
          reason: "already_titled",
          title: conversation.title
        };
        return;
      }
      const eligibility = chatAutoTitleEligibility(conversation);
      if (!actorMatchesAutoTitleEligibility(actor, eligibility)) {
        result = {
          ok: false,
          status: "ignored",
          reason: "not_eligible",
          title: conversation.title
        };
        return;
      }
      const now = new Date().toISOString();
      conversation.title = title;
      conversation.metadata = metadataWithFirstAgentChatTitle(conversation.metadata, {
        source: "first-agent",
        title,
        participantId: actor.participantId,
        runId: actor.runId,
        triggerMessageId: actor.triggerMessageId,
        appliedAt: now
      });
      conversation.updatedAt = now;
      await this.chat.store.saveConversation(conversation);
      applied = true;
      result = {
        ok: true,
        status: "applied",
        title,
        conversationId: conversation.id
      };
    });
    if (applied) {
      await this.chat.chatHistory.ensureHistoryFiles(conversation);
    }
    return result;
  }

  metadataAfterAutoTitleRunTerminal(
    conversationId: string,
    metadata: Record<string, unknown>,
    terminalRunId: string
  ): Record<string, unknown> {
    const eligibility = chatAutoTitleEligibility({ metadata } as Conversation);
    if (!eligibility || !Object.values(eligibility.targetRunIds).includes(terminalRunId)) {
      return metadata;
    }
    const hasOtherLiveEligibleRun = Object.values(eligibility.targetRunIds)
      .some((runId) => runId !== terminalRunId && this.isAutoTitleEligibleRunLive(conversationId, runId));
    return hasOtherLiveEligibleRun ? metadata : metadataWithoutAutoTitleEligibility(metadata);
  }

  private isAutoTitleEligibleRunLive(conversationId: string, runId: string): boolean {
    if (this.chat.activeRuns.activeConversationRunIds.get(conversationId)?.has(runId)) {
      return true;
    }
    return this.chat.activeRuns.chatRunMeta.get(runId)?.conversationId === conversationId;
  }

  async clearAutoTitleEligibilityForTerminalRun(conversation: Conversation, terminalRunId: string): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      const nextMetadata = this.metadataAfterAutoTitleRunTerminal(conversation.id, conversation.metadata, terminalRunId);
      if (nextMetadata === conversation.metadata) {
        return;
      }
      conversation.metadata = nextMetadata;
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
    });
  }

  /**
   * A chat's first message written on another device (the phone's New chat):
   * the members it asked name the chat, as when this computer sends a chat's
   * first message (shouldCreateInitialAutoTitleEligibility). On the computer
   * only: a machine's members name a chat no more than before. Whether it
   * armed the title now.
   */
  armServerChatTitle(conversation: Conversation, message: ChatMessage): boolean {
    if (this.chat.host.machineRuntime) return false;
    if (message.role !== "user" || conversation.metadata.autoTitle || conversation.metadata.autoTitleEligibility) return false;
    if (message.metadata?.parentMessageId || message.metadata?.chatThreadRootId) return false;
    if ((message.metadata?.threadId ?? message.id) !== message.id) return false;
    const index = conversation.messages.findIndex((item) => item.id === message.id);
    if (index < 0 || conversation.messages.slice(0, index).some((item) => item.role === "user" || item.role === "participant")) return false;
    const asked = new Set(deliveryTargetsOf(message));
    const targets = chatParticipants(conversation).filter((item) => asked.has(item.id));
    if (targets.length === 0) return false;
    conversation.metadata = {
      ...conversation.metadata,
      autoTitleEligibility: initialAutoTitleEligibility(message, targets, new Map(targets.map((target) => [target.id, hubTurnRunId(message.id, target.id)])))
    };
    return true;
  }
}
