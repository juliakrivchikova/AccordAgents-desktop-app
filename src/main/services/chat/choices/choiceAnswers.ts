import { randomUUID } from "node:crypto";
import { choiceCardId, mentionCardId, pendingMentionsOf } from "../../../../shared/hubCards";
import type {
  ChatMessage, ChatParticipant, Conversation, RespondToChatChoiceRequest, RespondToChatMentionsRequest, StartReviewResult
} from "../../../../shared/types";
import { chatMessageVisualThreadRootId } from "../../../../shared/chatParticipantRequestThreads";
import {
  formatChoiceSelectionForChat, updatePendingChoiceCancellation, updatePendingChoiceSelection, updatePendingMentionStatus
} from "./choiceRecords";
import { CHAT_CHOICE_REFUSALS_KEPT } from "../constants";
import { chatMemberIds, chatParticipants } from "../members/identity";
import { createChatMessage } from "../store/messages";
import { emitChatRunFailure, emitProgress } from "../turns/replyMessages";
import type { ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

const CHAT_CUSTOM_CHOICE_OPTION_ID = "__custom__";

export interface ChatChoiceExecutionGuard {
  /** The answer, as the native ledger names it (one card answer). */
  decisionEventId: string;
  /** The operation the answer was sent under on the User's server, when
   *  known: a refusal kept on the choice names it, so the device that sent
   *  it says why. */
  operationId?: string;
  /** Called after the validated answer is durably saved, before continuation. */
  beforeApply(participantId: string): Promise<void>;
}

export class ChatChoicePersistenceError extends Error {}

/** The User's answers to members' choices and mentions, and the turns they start. */
export class ChoiceAnswers {
  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "chatHistory" | "host" | "members" | "participantBatch" | "participantRequests" | "pendingReplies"
      | "promptSuggestions" | "serverCards" | "store" | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "storage">
  ) {}

  async respondToMentions(request: RespondToChatMentionsRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const runId = request.runId ?? randomUUID();
    const warnings: string[] = [];
    const ingest = await this.chat.activeRuns.withChatRunLock(request.conversationId, async () => {
      const conversation = await this.chat.store.requireChat(request.conversationId);
      const sourceMessage = conversation.messages.find((message) => message.id === request.sourceMessageId);
      if (!sourceMessage) {
        throw new Error("Source message was not found.");
      }
      const pendingMentions = (sourceMessage.metadata?.pendingMentions ?? [])
        .filter((mention) => mention.status === "pending");
      const requestedIds = new Set(request.targetParticipantIds);
      const selectedMentions = pendingMentions.filter((mention) => requestedIds.has(mention.targetParticipantId));
      const continuationOnly = request.approve && request.continueRequester && selectedMentions.length === 0 && Boolean(sourceMessage.participantId);
      if (selectedMentions.length === 0 && request.approve && !continuationOnly) {
        throw new Error("Select at least one pending mention.");
      }

      if (!request.approve) {
        await this.chat.store.saveChatChange(conversation, () => {
          const latest = conversation.messages.find((message) => message.id === sourceMessage.id) ?? sourceMessage;
          updatePendingMentionStatus(latest, new Set(pendingMentions.map((mention) => mention.targetParticipantId)), "rejected");
        });
        return { conversation, sourceMessage, targets: [], requester: undefined, runStarted: false };
      }

      if (selectedMentions.length > 0) {
        updatePendingMentionStatus(sourceMessage, requestedIds, "approved");
      }
      const participants = chatParticipants(conversation);
      const targets = selectedMentions
        .map((mention) => participants.find((participant) => participant.id === mention.targetParticipantId))
        .filter((participant): participant is ChatParticipant => Boolean(participant));
      const requester = request.continueRequester && sourceMessage.participantId
        ? participants.find((participant) => participant.id === sourceMessage.participantId)
        : undefined;
      // The requester waits for the targets' turns before its own resumes;
      // the targets are claimed by runParticipantBatch once they start.
      await this.chat.activeRuns.beginChatRun(conversation, runId, requester ? [requester.id] : undefined);
      await this.chat.store.waitForQueuedSave(conversation.id);
      return { conversation, sourceMessage, targets, requester, runStarted: true };
    });

    if (!ingest.runStarted) {
      return { conversation: ingest.conversation, warnings };
    }

    const dispatchWarnings: string[] = [];
    const backgroundController = this.chat.participantBatch.registerBackgroundRunController(runId, signal);
    void this.runMentionResponseFlow(
      ingest.conversation,
      ingest.sourceMessage,
      ingest.targets,
      ingest.requester,
      runId,
      backgroundController.signal,
      progress,
      dispatchWarnings
    )
      .catch((error) => {
        void this.deps.debugLogs.write("chat.mention-response.background.error", {
          conversationId: ingest.conversation.id,
          runId,
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(async () => {
        backgroundController.cleanup();
        if (dispatchWarnings.length > 0) {
          await this.chat.store.appendConversationWarnings(ingest.conversation, dispatchWarnings);
        }
      });
    return { conversation: ingest.conversation, warnings };
  }

  async respondToChoice(request: RespondToChatChoiceRequest, signal?: AbortSignal, progress?: ProgressCallback,
    execution?: ChatChoiceExecutionGuard): Promise<StartReviewResult> {
    let runId = request.runId ?? randomUUID();
    const warnings: string[] = [];
    const ingest = await this.chat.activeRuns.withChatRunLock(request.conversationId, async () => {
      const conversation = await this.chat.store.requireChat(request.conversationId);
      return this.chat.store.withChatMutation(conversation, async () => {
        const sourceMessage = conversation.messages.find(message => message.id === request.sourceMessageId);
        if (!sourceMessage) throw new Error("Source message was not found.");
        const choice = sourceMessage.metadata?.pendingChoice;
        if (!choice || choice.id !== request.choiceId) throw new Error("Choice request was not found.");
        // Saving the answer precedes native admission. After a crash in between,
        // only this exact signed decision may resume that saved continuation.
        const resume = Boolean(execution && choice.decisionEventId === execution.decisionEventId);
        // Expired by the app, never by the User: an answer she gave while it
        // still waited on her screen (one that crossed the expiry on its way)
        // is taken as if it had not expired.
        const expired = choice.status === "cancelled" && Boolean(choice.expiredAt);
        if (choice.status !== "pending" && !expired && !resume) throw new Error("Choice request has already been answered.");
        const selectedOptionId = request.selectedOptionId?.trim();
        const customAnswer = request.customAnswer?.trim();
        const note = request.note?.trim();
        const isCustomAnswer = selectedOptionId === CHAT_CUSTOM_CHOICE_OPTION_ID;
        const selectedOption = isCustomAnswer ? undefined : choice.options.find(option => option.id === selectedOptionId);
        // A durable answer refused while its choice still waits is kept on the
        // choice under the operation it was sent with: the phone that sent it
        // otherwise showed it on its way for an hour (the User, 2026-10-01).
        // Saved before the refusal is published, so a restart in between does
        // not lose it; the last few are kept, so one refusal does not hide another.
        const refuse = async (reason: string): Promise<never> => {
          const operationId = execution?.operationId;
          if (operationId && choice.status === "pending") {
            const refusals = [...(choice.refusals ?? []).filter(item => item.operationId !== operationId),
              { operationId, reason, at: new Date().toISOString() }].slice(-CHAT_CHOICE_REFUSALS_KEPT);
            sourceMessage.metadata = { ...sourceMessage.metadata, pendingChoice: { ...choice, refusals } };
            conversation.updatedAt = new Date().toISOString();
            try {
              await this.chat.store.saveConversation(conversation);
            } catch (error) {
              // Not published as refused unless it is kept: the answer stays
              // waiting and is tried again, as when a taken answer cannot be saved.
              this.chat.store.snapshotRowStates.delete(conversation.id);
              throw new ChatChoicePersistenceError(error instanceof Error ? error.message : String(error));
            }
          }
          throw new Error(reason);
        };
        if (!request.cancel) {
          if (isCustomAnswer && !customAnswer) await refuse("Custom choice answer is required.");
          if (!isCustomAnswer && !selectedOption) await refuse("Selected option was not found.");
        }
        if (!sourceMessage.participantId) await refuse("Choice request is not attached to a chat member.");
        const requester = chatParticipants(conversation).find(participant => participant.id === sourceMessage.participantId);
        if (!requester) return refuse("Choice requester is no longer in this chat.");
        if (execution && !this.chat.host.ownsParticipant(requester)) {
          throw new Error("This choice is owned by another machine.");
        }
        if (!request.cancel && conversation.metadata.archived === true) await refuse("Unarchive the chat before starting a member.");
        if (signal?.aborted) throw new Error("Choice response was cancelled before execution.");
        let userMessage: ChatMessage | undefined;
        if (resume) {
          runId = choice.responseRunId ?? runId;
          userMessage = conversation.messages.find(message => message.id === choice.responseMessageId);
          if (!request.cancel && !userMessage) throw new Error("The saved choice continuation is missing.");
        } else if (request.cancel) {
          updatePendingChoiceCancellation(sourceMessage, choice.id);
        } else {
          updatePendingChoiceSelection(sourceMessage, choice.id, selectedOption?.id ?? CHAT_CUSTOM_CHOICE_OPTION_ID, customAnswer, note);
          // The member answers where its card stands (the User, 2026-11-04): in
          // the card's thread when the card is in one, otherwise on the main
          // timeline, never in a new thread under the card. Placed by the helper
          // the desktop and the phone draw threads with.
          const cardThreadRootId = chatMessageVisualThreadRootId(conversation, sourceMessage);
          const rootId = cardThreadRootId && cardThreadRootId !== sourceMessage.id ? cardThreadRootId : undefined;
          userMessage = createChatMessage("user", formatChoiceSelectionForChat(sourceMessage, choice, selectedOption, customAnswer, note), undefined, {
            threadId: sourceMessage.metadata?.threadId ?? rootId ?? sourceMessage.id,
            parentMessageId: sourceMessage.id, ...(rootId ? { chatThreadRootId: rootId } : {}),
            sourceMessageId: sourceMessage.id, hiddenFromTimeline: true
          });
          conversation.messages.push(userMessage);
          this.chat.promptSuggestions.suggestions.userMessageSent(conversation.id);
        }
        if (execution) {
          Object.assign(sourceMessage.metadata!.pendingChoice!, {
            decisionEventId: execution.decisionEventId,
            ...(userMessage ? { responseMessageId: userMessage.id, responseRunId: runId } : {})
          });
        }
        if (!request.cancel) {
          this.chat.activeRuns.rememberActiveChatRun(conversation.id, runId);
          this.chat.members.claimMembersForRun(conversation.id, runId, [requester.id]);
          conversation.metadata = this.chat.activeRuns.metadataWithLiveRunState(conversation.id, { ...conversation.metadata, runId }, undefined, runId);
        }
        conversation.updatedAt = new Date().toISOString();
        try {
          // A queued-save wait suppresses disk errors. Native work needs the
          // actual write result, and mutation ownership must cover that write.
          await this.chat.store.saveConversation(conversation);
        } catch (error) {
          if (!request.cancel) this.chat.activeRuns.forgetActiveChatRun(conversation.id, runId);
          this.chat.store.snapshotRowStates.delete(conversation.id);
          throw new ChatChoicePersistenceError(error instanceof Error ? error.message : String(error));
        }
        try { await execution?.beforeApply(requester.id); }
        catch (error) {
          if (!request.cancel) this.chat.activeRuns.forgetActiveChatRun(conversation.id, runId);
          throw error;
        }
        return { conversation, requester: request.cancel ? undefined : requester, userMessage };
      });
    });
    if (!ingest.requester || !ingest.userMessage) return { conversation: ingest.conversation, warnings };
    const dispatchWarnings: string[] = [];
    void this.runChoiceResponseFlow(ingest.conversation, ingest.requester, ingest.userMessage, runId, signal, progress, dispatchWarnings)
      .catch(error => {
        void this.deps.debugLogs.write("chat.choice-response.background.error", {
          conversationId: ingest.conversation.id, runId, message: error instanceof Error ? error.message : String(error)
        });
      }).finally(async () => {
        if (dispatchWarnings.length) await this.chat.store.appendConversationWarnings(ingest.conversation, dispatchWarnings);
      });
    return { conversation: ingest.conversation, warnings };
  }

  private async runMentionResponseFlow(
    conversation: Conversation,
    sourceMessage: ChatMessage,
    targets: ChatParticipant[],
    requester: ChatParticipant | undefined,
    runId: string,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    warnings: string[]
  ): Promise<void> {
    try {
      if (targets.length > 0) {
        emitProgress(runId, progress, "initial", `Running ${targets.length} approved mention${targets.length === 1 ? "" : "s"}.`, {
          total: targets.length,
          completed: 0
        });
        await this.chat.participantBatch.runParticipantBatch(conversation, targets, sourceMessage, runId, signal, progress, warnings);
      }

      if (requester) {
        emitProgress(runId, progress, "debate", `Returning to @${requester.handle}.`, {
          participantLabel: `@${requester.handle}`
        });
        const messages = await this.chat.turnQueue.runParticipantTurnSerialized(conversation, requester, sourceMessage, runId, signal, progress, {
          continuation: true,
          warnings
        });
        const participantRequestsToRun = await this.chat.store.withChatMutation(conversation, async () => {
          const toRun = await this.chat.pendingReplies.appendParticipantTurnMessages(conversation, requester, messages);
          conversation.updatedAt = new Date().toISOString();
          this.chat.store.queueSnapshot(conversation);
          return toRun;
        });
        this.chat.participantRequests.startDeferredParticipantRequestRunners(conversation.id, participantRequestsToRun);
        await this.chat.chatHistory.ensureHistoryFiles(conversation);
      }

      emitProgress(runId, progress, "done", "Approved mention flow finished.");
    } catch (error) {
      emitChatRunFailure(runId, progress, error);
      throw error;
    } finally {
      await this.chat.activeRuns.endChatRun(conversation, runId);
    }
  }

  private async runChoiceResponseFlow(
    conversation: Conversation,
    requester: ChatParticipant,
    userMessage: ChatMessage,
    runId: string,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    warnings: string[]
  ): Promise<void> {
    try {
      emitProgress(runId, progress, "debate", `Returning choice to @${requester.handle}.`, {
        participantLabel: `@${requester.handle}`
      });
      const messages = await this.chat.turnQueue.runParticipantTurnSerialized(conversation, requester, userMessage, runId, signal, progress, {
        continuation: true,
        warnings
      });
      const participantRequestsToRun = await this.chat.store.withChatMutation(conversation, async () => {
        const toRun = await this.chat.pendingReplies.appendParticipantTurnMessages(conversation, requester, messages);
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
        return toRun;
      });
      this.chat.participantRequests.startDeferredParticipantRequestRunners(conversation.id, participantRequestsToRun);
      await this.chat.chatHistory.ensureHistoryFiles(conversation);
      emitProgress(runId, progress, "done", "Choice response finished.");
    } catch (error) {
      emitChatRunFailure(runId, progress, error);
      throw error;
    } finally {
      await this.chat.activeRuns.endChatRun(conversation, runId);
    }
  }

  /** The User's answer to a member's choice, from this device's card. */
  async answerChoiceCard(request: RespondToChatChoiceRequest): Promise<void> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "chat") throw new Error("The chat is not available.");
    const message = conversation.messages.find((item) => item.id === request.sourceMessageId);
    const choice = message?.metadata?.pendingChoice;
    if (!message || !choice || choice.id !== request.choiceId) throw new Error("Choice request was not found.");
    if (choice.status !== "pending" || message.metadata?.serverCard) throw new Error("Choice request has already been answered.");
    // Its member left the chat: nobody takes an answer. Her Cancel closes it
    // here (the close reaches the other devices when this device wrote the
    // message; the card on the server was settled when its member left).
    const memberIds = chatMemberIds(conversation);
    if (memberIds.size > 0 && (!message.participantId || !memberIds.has(message.participantId))) {
      if (!request.cancel) throw new Error(`${message.participantLabel ?? "This member"} is no longer in this chat: its question can only be cancelled.`);
      await this.cancelGoneMemberChoice(conversation.id, message.id, choice.id);
      return;
    }
    const cardId = choiceCardId(message.id);
    await this.chat.serverCards.answerServerCard({ conversationId: conversation.id, cardId, raisedHere: this.chat.serverCards.cardRaisedHere(conversation, cardId), answer: {
      ...(request.selectedOptionId !== undefined ? { selectedOptionId: request.selectedOptionId } : {}),
      ...(request.customAnswer !== undefined ? { customAnswer: request.customAnswer } : {}),
      ...(request.note !== undefined ? { note: request.note } : {}),
      ...(request.cancel ? { cancel: true } : {})
    } });
  }

  /** Cancels, here, a choice whose member is no longer in the chat. */
  private async cancelGoneMemberChoice(conversationId: string, messageId: string, choiceId: string): Promise<void> {
    const conversation = await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") throw new Error("The chat is not available.");
    await this.chat.store.withChatMutation(conversation, async () => {
      const message = conversation.messages.find((item) => item.id === messageId);
      const choice = message?.metadata?.pendingChoice;
      if (!message || !choice || choice.id !== choiceId || choice.status !== "pending") return;
      const now = new Date().toISOString();
      message.metadata = { ...message.metadata, pendingChoice: { ...choice, status: "cancelled", cancelledAt: now } };
      conversation.updatedAt = now;
      await this.chat.store.saveConversation(conversation);
      void this.deps.debugLogs.write("chat.choice.cancelled-member-gone", { conversationId, messageId });
    });
  }

  /** The User's answer to a member's mentions waiting for approval, from
   *  this device's card. Continuing the member after its mentions were all
   *  answered asks nothing of anyone's card: it is a turn of that member,
   *  started here and run where the member runs. */
  async answerMentionsCard(request: RespondToChatMentionsRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "chat") throw new Error("The chat is not available.");
    const message = conversation.messages.find((item) => item.id === request.sourceMessageId);
    if (!message) throw new Error("Source message was not found.");
    const pending = pendingMentionsOf(message);
    if (pending.length === 0) {
      if (request.approve && request.continueRequester && message.participantId) return this.respondToMentions(request, signal, progress);
      throw new Error("These mentions were already answered.");
    }
    if (message.metadata?.serverCard) throw new Error("These mentions were already answered.");
    const cardId = mentionCardId(message.id);
    await this.chat.serverCards.answerServerCard({ conversationId: conversation.id, cardId, raisedHere: this.chat.serverCards.cardRaisedHere(conversation, cardId), answer: {
      approve: request.approve,
      targetParticipantIds: request.approve ? request.targetParticipantIds : pending.map((mention) => mention.targetParticipantId),
      ...(request.continueRequester ? { continueRequester: true } : {})
    } });
    return { conversation: (await this.deps.storage.getConversation(conversation.id)) ?? conversation, warnings: [] };
  }
}
