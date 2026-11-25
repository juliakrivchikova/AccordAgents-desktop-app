import { membersInCliOwnMode } from "../../../../shared/chatAccessModes";
import { canSwitchChatView, chatViewFor, isChatViewMode } from "../../../../shared/mainSession";
import type {
  Conversation, DismissConversationWarningsRequest, RenameChatConversationRequest, SetChatArchivedRequest, SetChatPinnedRequest,
  SetChatViewRequest
} from "../../../../shared/types";
import { sanitizeWarningList } from "../../../../shared/warnings";
import { chatParticipants, cliModesConverted } from "../members/identity";
import { chatAutoTitleEligibility, chatAutoTitleMetadata, metadataWithManualChatTitle, normalizeChatTitle } from "../store/titles";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** A chat's own settings: name, pin, archive, view, dismissed warnings. */
export class ChatList {
  /** Chats this computer has checked, as it opened them, for members to move
   *  into their CLI's own mode (convertMembersForSessionsView). */
  private readonly sessionsViewConversions = new Set<string>();

  constructor(
    private readonly chat: Pick<ChatModules, "activeRuns" | "chatHistory" | "host" | "store">,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs" | "storage">
  ) {}

  async renameConversation(request: RenameChatConversationRequest): Promise<Conversation | undefined> {
    return this.chat.activeRuns.withChatRunLock(request.conversationId, async () => {
      await this.chat.store.waitForQueuedSave(request.conversationId);
      const conversation = await this.deps.storage.getConversation(request.conversationId);
      if (!conversation) {
        return undefined;
      }
      if (conversation.kind !== "chat") {
        throw new Error("Only chat conversations can be renamed.");
      }
      if (conversation.metadata.running === true || this.chat.activeRuns.chatHasLiveWork(conversation.id)) {
        throw new Error("Chat name cannot be edited while members are running.");
      }
      const title = normalizeChatTitle(request.title);
      const existingAutoTitle = chatAutoTitleMetadata(conversation);
      const hadAutoTitleEligibility = Boolean(chatAutoTitleEligibility(conversation));
      if (title === conversation.title && existingAutoTitle?.source === "manual" && !hadAutoTitleEligibility) {
        return conversation;
      }
      const now = new Date().toISOString();
      conversation.title = title;
      conversation.metadata = metadataWithManualChatTitle(conversation.metadata, title, now);
      conversation.updatedAt = now;
      await this.chat.store.saveConversation(conversation);
      await this.chat.chatHistory.ensureHistoryFiles(conversation);
      return conversation;
    }, {
      rejectIfQueued: true,
      queuedMessage: "Chat name cannot be edited while members are running."
    });
  }

  async setArchived(request: SetChatArchivedRequest): Promise<Conversation | undefined> {
    return this.chat.activeRuns.withChatRunLock(request.conversationId, async () => {
      await this.chat.store.waitForQueuedSave(request.conversationId);
      const conversation = await this.deps.storage.getConversation(request.conversationId);
      if (!conversation) {
        return undefined;
      }
      if (conversation.kind !== "chat") {
        throw new Error("Only chat conversations can be archived.");
      }
      return this.chat.store.withChatMutation(conversation, async () => {
        if (request.archived && request.onlyIfEmpty && (
          conversation.messages.some(item => item.role !== "system")
          || conversation.metadata.running === true || this.chat.activeRuns.chatHasLiveWork(conversation.id)
        )) return conversation;
        if (conversation.metadata.running === true || this.chat.activeRuns.chatHasLiveWork(conversation.id)) {
          throw new Error("Chat cannot be archived while members are running.");
        }
        const alreadyArchived = conversation.metadata.archived === true;
        if (request.archived) await this.deps.cliRunner.closeConversationSessions(conversation.id);
        if (request.archived === alreadyArchived) {
          return conversation;
        }
        const nextMetadata = { ...conversation.metadata };
        if (request.archived) {
          nextMetadata.archived = true;
          nextMetadata.archivedAt = new Date().toISOString();
        } else {
          delete nextMetadata.archived;
          delete nextMetadata.archivedAt;
        }
        conversation.metadata = nextMetadata;
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
        return conversation;
      });
    }, {
      rejectIfQueued: true,
      queuedMessage: "Chat cannot be archived while members are running."
    });
  }

  /** Pins a chat to the top of the chat list, or unpins it. The User's own
   *  ordering, shared through her server like the archive state; allowed
   *  while members run. It is not activity in the chat, so `updatedAt` stays
   *  and the chat keeps its place among the recent ones. */
  async setPinned(request: SetChatPinnedRequest): Promise<Conversation | undefined> {
    await this.chat.store.waitForQueuedSave(request.conversationId);
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation) {
      return undefined;
    }
    if (conversation.kind !== "chat") {
      throw new Error("Only chat conversations can be pinned.");
    }
    return this.chat.store.withChatMutation(conversation, async () => {
      if ((conversation.metadata.pinned === true) === (request.pinned === true)) {
        return conversation;
      }
      const nextMetadata = { ...conversation.metadata };
      if (request.pinned === true) {
        nextMetadata.pinned = true;
        nextMetadata.pinnedAt = new Date().toISOString();
      } else {
        delete nextMetadata.pinned;
        delete nextMetadata.pinnedAt;
      }
      conversation.metadata = nextMetadata;
      await this.chat.store.saveConversation(conversation);
      return conversation;
    });
  }

  async setChatView(request: SetChatViewRequest): Promise<Conversation | undefined> {
    if (!isChatViewMode(request.view)) {
      throw new Error("Unknown chat view.");
    }
    await this.chat.store.waitForQueuedSave(request.conversationId);
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation) {
      return undefined;
    }
    if (conversation.kind !== "chat" || !canSwitchChatView(conversation.metadata)) {
      throw new Error("This chat has one view only.");
    }
    return this.chat.store.withChatMutation(conversation, async () => {
      if (conversation.metadata.chatView === request.view) {
        return conversation;
      }
      // Shown in the sessions view, members with rights from the classic
      // view run in their CLI's own mode from now on (the User, 2026-11-22).
      const converted = request.view === "sessions" ? membersInCliOwnMode(chatParticipants(conversation)) : undefined;
      conversation.metadata = { ...conversation.metadata, chatView: request.view, ...(converted ? { participants: converted } : {}) };
      await this.chat.store.saveConversation(conversation);
      return conversation;
    });
  }

  /** A chat switched to the sessions view on another device (the phone), or
   *  (`once`) a chat in the sessions view this computer opens: this computer
   *  moves its members with rights from the classic view into their CLI's
   *  own mode, as a switch made here does (setChatView). Only the computer
   *  writes it, so devices never race on the same change; it goes to her
   *  server, the cloud machines and the phone as any change of the members.
   *  On opening it is done once: the chat is marked (cliModesConvertedAt),
   *  so a later change of a member is not undone. */
  convertMembersForSessionsView(conversationId: string, once = false): void {
    if (this.chat.host.machineRuntime) return;
    if (once) {
      if (this.sessionsViewConversions.has(conversationId)) return;
      this.sessionsViewConversions.add(conversationId);
    }
    void (async () => {
      await this.chat.store.waitForQueuedSave(conversationId);
      const conversation = await this.deps.storage.getConversation(conversationId);
      if (!conversation || conversation.kind !== "chat" || chatViewFor(conversation.metadata) !== "sessions") return;
      if (once && cliModesConverted(conversation.metadata)) return;
      await this.chat.store.withChatMutation(conversation, async () => {
        if (chatViewFor(conversation.metadata) !== "sessions" || (once && cliModesConverted(conversation.metadata))) return;
        const converted = membersInCliOwnMode(chatParticipants(conversation));
        if (!converted && !once) return;
        const at = conversation.metadata.cliModesConvertedAt ?? conversation.metadata.cliModesConvertedHereAt ?? new Date().toISOString();
        conversation.metadata = {
          ...conversation.metadata,
          ...(converted ? { participants: converted } : {}),
          cliModesConvertedAt: at,
          cliModesConvertedHereAt: at
        };
        await this.chat.store.saveConversation(conversation);
      });
    })().catch((error) => {
      if (once) this.sessionsViewConversions.delete(conversationId);
      void this.deps.debugLogs.write("chat.sessions-view.cli-mode-failed", { conversationId, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    });
  }

  async dismissConversationWarnings(request: DismissConversationWarningsRequest): Promise<Conversation | undefined> {
    const dismissedWarnings = new Set(sanitizeWarningList(request.warnings));
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation || dismissedWarnings.size === 0) {
      return conversation;
    }
    const dismissWarnings = async (): Promise<Conversation> => {
      const currentWarnings = sanitizeWarningList(conversation.metadata.warnings);
      const nextWarnings = currentWarnings.filter((warning) => !dismissedWarnings.has(warning));
      if (JSON.stringify(conversation.metadata.warnings ?? []) === JSON.stringify(nextWarnings)) {
        return conversation;
      }
      conversation.metadata = { ...conversation.metadata, warnings: nextWarnings };
      await this.chat.store.saveConversation(conversation);
      return conversation;
    };
    if (conversation.kind === "chat") {
      return this.chat.store.withChatMutation(conversation, dismissWarnings);
    }
    return dismissWarnings();
  }
}
