import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatParticipant, Conversation } from "../../../../shared/types";
import {
  autoWatchMessagesAfterCursor, autoWatchToggleOnCursor, autoWatchTriggerContent, laterAutoWatchCursor,
  metadataWithParticipantWatchers, normalizeParticipantWatchers
} from "./watchers";
import { chatParticipants } from "../members/identity";
import { createChatMessage } from "../store/messages";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

const CHAT_AUTO_WATCH_EVALUATION_DEBOUNCE_MS = 75;

/** Members that watch the chat and answer without being asked. */
export class AutoWatch {
  private readonly autoWatchEvaluationTimers = new Map<string, NodeJS.Timeout>();
  private readonly autoWatchEvaluations = new Set<string>();

  constructor(
    private readonly chat: Pick<ChatModules, "activeRuns" | "host" | "participantBatch" | "queuedRosterChanges" | "runOwners" | "store">,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "settings" | "storage">
  ) {}

  activeAutoWatchParticipant(conversation: Conversation): ChatParticipant | undefined {
    return chatParticipants(conversation).find((participant) => participant.autoWatch === true && this.chat.host.ownsParticipant(participant));
  }

  scheduleAutoWatchEvaluation(conversationId: string, reason: string): void {
    // Every point where a chat may have gone idle lands here; an approved
    // member removal waits for exactly that (runAutoWatchEvaluation also lets
    // it finish before waking a watcher).
    this.chat.queuedRosterChanges.scheduleQueuedMemberRemovals(conversationId);
    const existing = this.autoWatchEvaluationTimers.get(conversationId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.autoWatchEvaluationTimers.delete(conversationId);
      void this.runAutoWatchEvaluation(conversationId, reason).catch((error) => {
        void this.deps.debugLogs.write("chat.auto-watch.evaluate.error", {
          conversationId,
          reason,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, CHAT_AUTO_WATCH_EVALUATION_DEBOUNCE_MS);
    this.autoWatchEvaluationTimers.set(conversationId, timer);
  }

  private async runAutoWatchEvaluation(conversationId: string, reason: string): Promise<void> {
    if (this.autoWatchEvaluations.has(conversationId)) {
      return;
    }
    if (this.chat.queuedRosterChanges.memberRemovalApplyDue(conversationId)) {
      // An approved member removal waits for exactly this idle moment; a
      // woken watcher (possibly the member being removed) must not start a
      // turn ahead of it.
      await this.chat.queuedRosterChanges.applyQueuedMemberRemovalsOnce(conversationId);
    }
    this.autoWatchEvaluations.add(conversationId);
    let prepared: {
      conversation: Conversation;
      participant: ChatParticipant;
      triggerMessage: ChatMessage;
      runId: string;
      latestMessageId: string;
    } | undefined;
    try {
      await this.chat.activeRuns.withChatRunLock(conversationId, async () => {
        if (this.chat.activeRuns.chatHasLiveWork(conversationId)) {
          return;
        }
        const conversation = await this.deps.storage.getConversation(conversationId);
        if (!conversation || conversation.kind !== "chat" || conversation.metadata.archived === true) {
          return;
        }
        await this.chat.store.withChatMutation(conversation, async () => {
          if (this.chat.activeRuns.chatHasLiveWork(conversationId)) {
            return;
          }
          const participant = this.activeAutoWatchParticipant(conversation);
          if (!participant) {
            return;
          }
          if (this.chat.runOwners.storedMetadataHasProtectedLiveRuns(conversation.metadata)) {
            return;
          }
          // A remote run is not in this process's active-run map. Its pending
          // row still means the chat is busy; wait for that owner's terminal
          // result instead of waking once for the request and again for its reply.
          if (conversation.messages.some(message => message.role === "participant" && message.status === "pending"
            && this.chat.runOwners.isMessageRunProtectedByExternalOwner(conversation, message))) {
            return;
          }
          let watchers = normalizeParticipantWatchers(conversation.metadata.participantWatchers);
          const existingState = watchers[participant.id] ?? {
            lastSeenMessageId: autoWatchToggleOnCursor(conversation, participant.id),
            wakeChainDepth: 0,
            updatedAt: new Date().toISOString()
          };
          if (existingState.pausedReason) {
            return;
          }
          const messages = autoWatchMessagesAfterCursor(conversation, participant.id, existingState.lastSeenMessageId);
          if (messages.length === 0) {
            return;
          }
          const settings = await this.deps.settings.getPublicSettings();
          if (existingState.wakeChainDepth >= settings.chatAutoWatchWakeLimit) {
            const now = new Date().toISOString();
            watchers = {
              ...watchers,
              [participant.id]: {
                ...existingState,
                pausedReason: "wake-limit",
                updatedAt: now
              }
            };
            conversation.metadata = metadataWithParticipantWatchers(conversation.metadata, watchers);
            conversation.updatedAt = now;
            await this.chat.store.saveConversation(conversation);
            return;
          }
          const latest = messages[messages.length - 1];
          const runId = randomUUID();
          const now = new Date().toISOString();
          const triggerMessage = createChatMessage("system", autoWatchTriggerContent(participant, messages), undefined, {
            threadId: latest.metadata?.threadId ?? latest.id,
            parentMessageId: latest.id,
            chatThreadRootId: latest.metadata?.chatThreadRootId,
            sourceMessageId: latest.id,
            hiddenFromTimeline: true,
            autoWatchTrigger: {
              participantId: participant.id,
              reason,
              messageIds: messages.map((message) => message.id)
            }
          });
          conversation.messages.push(triggerMessage);
          conversation.updatedAt = now;
          await this.chat.store.saveConversation(conversation);
          prepared = { conversation, participant, triggerMessage, runId, latestMessageId: latest.id };
        });
      });
    } finally {
      this.autoWatchEvaluations.delete(conversationId);
    }
    if (!prepared) {
      return;
    }
    const run = prepared;
    const dispatchWarnings: string[] = [];
    const dispatchPromise = this.chat.participantBatch.runParticipantBatch(
      run.conversation,
      [run.participant],
      run.triggerMessage,
      run.runId,
      undefined,
      undefined,
      dispatchWarnings,
      {
        targetRunIds: new Map([[run.participant.id, run.runId]]),
        onTargetRunBegun: async (participantId, targetRunId) => {
          await this.advanceAutoWatchCursorAfterRunStarted(run.conversation, participantId, targetRunId, run.latestMessageId);
        }
      }
    );
    void dispatchPromise
      .catch(async (error) => {
        await this.markAutoWatchError(conversationId, run.participant.id, error);
      })
      .finally(async () => {
        if (dispatchWarnings.length > 0) {
          await this.chat.store.appendConversationWarnings(run.conversation, dispatchWarnings);
        }
      });
  }

  private async advanceAutoWatchCursorAfterRunStarted(
    conversation: Conversation,
    participantId: string,
    runId: string,
    latestMessageId: string
  ): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      const watchers = normalizeParticipantWatchers(conversation.metadata.participantWatchers);
      const now = new Date().toISOString();
      const existingState = watchers[participantId] ?? {
        wakeChainDepth: 0,
        updatedAt: now
      };
      watchers[participantId] = {
        ...existingState,
        lastSeenMessageId: laterAutoWatchCursor(conversation, participantId, existingState.lastSeenMessageId, latestMessageId),
        lastRunId: runId,
        lastTriggeredAt: now,
        wakeChainDepth: existingState.wakeChainDepth + 1,
        updatedAt: now
      };
      delete watchers[participantId].pausedReason;
      conversation.metadata = metadataWithParticipantWatchers(conversation.metadata, watchers);
      conversation.updatedAt = now;
      await this.chat.store.saveConversation(conversation);
    });
  }

  private async markAutoWatchError(conversationId: string, participantId: string | undefined, error: unknown): Promise<void> {
    void this.deps.debugLogs.write("chat.auto-watch.run.error", {
      conversationId,
      participantId,
      message: error instanceof Error ? error.message : String(error)
    });
    if (!participantId) {
      return;
    }
    const conversation = await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return;
    }
    await this.chat.store.withChatMutation(conversation, async () => {
      const watchers = normalizeParticipantWatchers(conversation.metadata.participantWatchers);
      const state = watchers[participantId];
      if (!state) {
        return;
      }
      watchers[participantId] = {
        ...state,
        pausedReason: "error",
        updatedAt: new Date().toISOString()
      };
      conversation.metadata = metadataWithParticipantWatchers(conversation.metadata, watchers);
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
    });
  }
}
