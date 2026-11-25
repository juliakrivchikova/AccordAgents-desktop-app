import { isMainSessionParticipant } from "../../../../shared/mainSession";
import type { AgentHealth, ChatParticipantActivitySnapshot, ChatProviderKind } from "../../../../shared/types";
import { reasoningEffortOptionsForProvider } from "../../../../shared/reasoningEffort";
import { normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { normalizeChatAppToolCapabilities } from "../../../../shared/appTools";
import { buildChatParticipantActivitySnapshot } from "../../../../shared/chatParticipantActivity";
import { preservedRemoteExecution } from "../../../../shared/chatParticipantHome";
import {
  APP_CHAT_GET_CONTEXT_TOOL, APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL, APP_CHAT_GET_PARTICIPANTS_TOOL,
  APP_CHAT_LIST_ATTACHMENTS_TOOL, APP_CHAT_READ_ATTACHMENT_TOOL, APP_CHAT_READ_MESSAGES_TOOL
} from "../../appMcp";
import { readinessForProvider } from "../../../../shared/cliReadiness";
import { normalizeChatAttachmentListRequest, normalizeChatAttachmentReadRequest } from "../attachments/exportTargets";
import { chatImageAttachmentForTool, visibleImageAttachmentRecords } from "../attachments/imageRecords";
import { CHAT_CONTEXT_READ_DEFAULT_LIMIT } from "../constants";
import { chatParticipants, isUserOnlyMessage, messageAuthor, normalizeBehaviorRuleIds, roleLabelForParticipant } from "../members/identity";
import { rosterParticipantSummary } from "../members/rosterRequests";
import { chatMessageForTool, historyFilePaths } from "../store/historyText";
import { CHAT_CONTEXT_READ_MAX_LIMIT } from "./constants";
import { normalizeChatMessageReadRequest } from "./toolInputs";
import { appMcpToolNamesFor, appToolCapabilitiesForRolePolicy } from "../turns/promptSections";
import type { ChatAppMcpActor } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Members' app tools that read the chat. */
export class ChatReadTools {
  constructor(
    private readonly chat: Pick<ChatModules, "attachments" | "backgroundTasks" | "store">,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs" | "settings">
  ) {}

  async describeChatContextForTool(actor: ChatAppMcpActor): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const participants = chatParticipants(conversation);
    const requester = participants.find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    const triggerSequence = actor.triggerMessageId
      ? conversation.messages.findIndex((message) => message.id === actor.triggerMessageId)
      : -1;
    const triggerMessage = triggerSequence >= 0 ? conversation.messages[triggerSequence] : undefined;
    const historyFiles = historyFilePaths(conversation.id, actor);

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
        ...rosterParticipantSummary(conversation, requester),
        appToolCapabilities: normalizeChatAppToolCapabilities(actor.capabilities)
      },
      activeTurn: {
        triggerMessageId: actor.triggerMessageId,
        triggerThreadId: actor.triggerThreadId,
        triggerParentMessageId: actor.triggerParentMessageId,
        triggerChatThreadRootId: actor.triggerChatThreadRootId,
        snapshotMaxSequence: actor.snapshotMaxSequence,
        continuation: Boolean(actor.continuation),
        triggerMessage: triggerMessage ? chatMessageForTool(triggerMessage, triggerSequence) : undefined
      },
      contextSources: {
        preferredMessageTool: APP_CHAT_READ_MESSAGES_TOOL,
        preferredAttachmentListTool: APP_CHAT_LIST_ATTACHMENTS_TOOL,
        preferredAttachmentReadTool: APP_CHAT_READ_ATTACHMENT_TOOL,
        preferredParticipantTool: APP_CHAT_GET_PARTICIPANTS_TOOL,
        preferredParticipantActivityTool: APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL,
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
      availableAppMcpTools: appMcpToolNamesFor(actor.capabilities)
    };
  }

  async describeChatParticipantsForTool(actor: ChatAppMcpActor): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const participants = chatParticipants(conversation);
    const requester = participants.find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }

    const settings = await this.deps.settings.getPublicSettings();
    const agents = await this.deps.cliRunner.detectAgents().catch((): AgentHealth[] => []);
    const providers = (["codex-cli", "claude-code", "gemini-cli"] as ChatProviderKind[]).map((kind) => {
      const provider = settings.providers.find((item) => item.kind === kind);
      const health = agents.find((item) => item.kind === kind);
      const readiness = readinessForProvider(kind, agents, settings.providers);
      return {
        kind,
        label: provider?.label ?? health?.label ?? (kind === "codex-cli" ? "Codex CLI" : kind === "gemini-cli" ? "Gemini CLI (Antigravity)" : "Claude Code"),
        enabled: Boolean(provider?.enabled),
        installed: Boolean(health?.installed),
        configuredModel: provider?.model?.trim() || undefined,
        reasoningEfforts: reasoningEffortOptionsForProvider(kind),
        version: health?.version,
        readiness,
        diagnosticCode: health?.diagnosticCode
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
          participantConfigId: participant.participantConfigId,
          handle: participant.handle,
          isRequester: participant.id === requester.id,
          roleConfigId: participant.roleConfigId,
          roleLabel: roleLabelForParticipant(conversation, participant),
          roleVersion: role?.version ?? participant.roleConfigVersion,
          behaviorRuleIds: normalizeBehaviorRuleIds(participant.behaviorRuleIds),
          appToolCapabilities: appToolCapabilitiesForRolePolicy(
            role?.appToolCapabilities,
            role?.participantDefaults,
            normalizeChatAgentPermissions(participant.permissions),
            isMainSessionParticipant(conversation.metadata, participant.id)
          ),
          kind: participant.kind,
          model: participant.model,
          reasoningEffort: participant.reasoningEffort,
          agentMode: normalizeChatAgentMode(participant.agentMode),
          permissions: normalizeChatAgentPermissions(participant.permissions),
          remoteExecution: preservedRemoteExecution(participant.remoteExecution),
          skipToolchainPreflight: participant.skipToolchainPreflight === true,
          provider
        };
      }),
      providers
    };
  }

  async describeChatParticipantActivityForTool(actor: ChatAppMcpActor): Promise<ChatParticipantActivitySnapshot> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const requester = chatParticipants(conversation)
      .find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    return buildChatParticipantActivitySnapshot(conversation, undefined, new Map(Object.entries(this.chat.backgroundTasks.backgroundTasksForConversation(conversation.id))));
  }

  async readChatMessagesForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }

    const request = normalizeChatMessageReadRequest(rawRequest);
    const sequencedMessages = conversation.messages.map((message, sequence) => ({ message, sequence }));
    const filteredMessages = sequencedMessages.filter(({ message, sequence }) => {
      if (typeof actor.snapshotMaxSequence === "number" && sequence > actor.snapshotMaxSequence) {
        return false;
      }
      // A turn-finished note is the User's pointer back to a reply members
      // can read in full, and a closed Accord's line is her own view of the
      // chat: neither is part of the chat they read.
      if (isUserOnlyMessage(message)) {
        return false;
      }
      // Read the exact canonical message by id. Snapshot visibility still applies, so a
      // message newer than this turn (or from another conversation) returns nothing. Other
      // filters are ignored when messageId is set.
      if (request.messageId) {
        return message.id === request.messageId;
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
        messageId: request.messageId,
        threadId: request.threadId,
        beforeSequence: request.beforeSequence,
        afterSequence: request.afterSequence,
        limit: request.limit
      },
      messages: selectedMessages.map(({ message, sequence }) => chatMessageForTool(message, sequence)),
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

  async listChatAttachmentsForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    const request = normalizeChatAttachmentListRequest(rawRequest);
    const records = visibleImageAttachmentRecords(conversation, actor)
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
        author: messageAuthor(record.message),
        threadId: record.message.metadata?.threadId,
        attachment: chatImageAttachmentForTool(record.attachment),
        readTool: APP_CHAT_READ_ATTACHMENT_TOOL,
        readArguments: { attachmentId: record.attachment.id }
      }))
    };
  }

  async readChatAttachmentForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    const request = normalizeChatAttachmentReadRequest(rawRequest);
    const record = visibleImageAttachmentRecords(conversation, actor).find((item) => item.attachment.id === request.attachmentId);
    if (!record) {
      void this.deps.debugLogs.write("chat.attachments.mcp-read-denied", {
        conversationId: actor.conversationId,
        participantId: actor.participantId,
        attachmentId: request.attachmentId,
        snapshotMaxSequence: actor.snapshotMaxSequence
      });
      throw new Error(
        "AttachmentReadDenied. Problem: this attachment is not visible to the current member turn. Cause: the attachment id is absent, belongs to another conversation, or is newer than this turn snapshot. Fix: call app_chat_list_attachments for visible attachment IDs, or ask User to resend the image."
      );
    }
    const dataBase64 = await this.chat.attachments.readAttachmentBase64(conversation.id, record.attachment);
    return {
      conversationId: conversation.id,
      requesterParticipantId: requester.id,
      messageId: record.message.id,
      sequence: record.sequence,
      author: messageAuthor(record.message),
      threadId: record.message.metadata?.threadId,
      attachment: chatImageAttachmentForTool(record.attachment),
      dataBase64
    };
  }
}
