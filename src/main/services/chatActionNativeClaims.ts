import type { HubCard } from "../../shared/hubOps";
import type { HubChoiceCardAnswer } from "../../shared/hubCards";
import { isHubMentionCardAnswer, pendingMentionsOf } from "../../shared/hubCards";
import type { NativeRuntimeIdentity } from "../../shared/nativeCommands";
import type { Conversation, RespondToChatChoiceRequest, ReviewProgress } from "../../shared/types";
import { ChatChoicePersistenceError, type ChatService } from "./chat";
import type { StorageService } from "./storage";
import { verifyNativeExecutorGone } from "./nativeExecutorRecovery";
import { CardRetryError, cardAnswerKey, type CardApplyResult } from "./machineApprovalExecutor";

/**
 * Applies the User's answer to a member's choice, raised by this device for
 * one of its members, exactly once (agreement Д9). The answer is the
 * command: the domain saves its validated selection before claiming the
 * native continuation; after a crash in between only this same answer
 * resumes that saved continuation. A claim without a confirmed outcome is
 * reported as uncertain and never continued again. Concurrent answers wait
 * for the target's outcome.
 */
export class MachineChoiceExecutor {
  private readonly active = new Map<string, Promise<CardApplyResult>>();
  private readonly targets = new Map<string, Promise<unknown>>();
  private readonly outcomes = new Map<string, CardApplyResult>();

  constructor(private readonly options: {
    storage: StorageService;
    chat: Pick<ChatService, "respondToChoice">;
    progress?: (progress: ReviewProgress, conversationId: string) => void;
    runtimeIdentity(): Promise<NativeRuntimeIdentity>;
    canApply?(): boolean;
    nativeProcessDbPath?: string;
  }) {}

  hasActiveWork(): boolean { return this.active.size > 0; }

  apply(card: HubCard, answerOpId?: string): Promise<CardApplyResult> {
    const key = cardAnswerKey(card);
    const current = this.active.get(key);
    if (current) return current;
    const target = JSON.stringify([card.conversationId, card.cardId]);
    const previous = this.targets.get(target) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.applyOnce(card, key, answerOpId));
    this.targets.set(target, work);
    this.active.set(key, work);
    void work.finally(() => {
      this.active.delete(key);
      if (this.targets.get(target) === work) this.targets.delete(target);
    }).catch(() => undefined);
    return work;
  }

  private async applyOnce(card: HubCard, key: string, answerOpId?: string): Promise<CardApplyResult> {
    const known = this.outcomes.get(key);
    if (known) return known;
    const sourceMessageId = card.messageId ?? (card.cardId.startsWith("choice:") ? card.cardId.slice("choice:".length) : "");
    const answer = (card.answer ?? {}) as HubChoiceCardAnswer;
    if (card.state === "pending" || !card.answeredAt || !sourceMessageId) return { kind: "refused", reason: "This answer is not one this card takes." };
    const conversation = await this.options.storage.getConversation(card.conversationId);
    const choice = conversation?.messages.find((message) => message.id === sourceMessageId)?.metadata?.pendingChoice;
    if (!choice) return { kind: "refused", reason: "The choice this answer is for is not here." };
    const targetKey = `choice:${choice.id}`;
    const owner = await this.options.runtimeIdentity();
    const commands = this.options.storage.nativeCommands();
    const previous = await commands.targetEffect(card.conversationId, targetKey);
    if (previous) {
      if (previous.eventId !== key) return { kind: "refused", reason: "This choice has already been answered; its earlier outcome stands." };
      if (previous.runtimeId !== owner.runtimeId && this.options.nativeProcessDbPath && !await verifyNativeExecutorGone({
        ...previous, generation: 0, released: false
      }, this.options.nativeProcessDbPath)) {
        return { kind: "retry", reason: "Waiting for the previous choice executor's verified shutdown." };
      }
      return this.remember(key, { kind: "uncertain", reason: "This answer crossed its execution boundary; continuation was not confirmed and was not repeated." });
    }
    const request: RespondToChatChoiceRequest = {
      conversationId: card.conversationId, sourceMessageId, choiceId: choice.id,
      runId: `choice-response:${key}`,
      ...(typeof answer.selectedOptionId === "string" ? { selectedOptionId: answer.selectedOptionId } : {}),
      ...(typeof answer.customAnswer === "string" ? { customAnswer: answer.customAnswer } : {}),
      ...(typeof answer.note === "string" ? { note: answer.note } : {}),
      ...(answer.cancel === true ? { cancel: true } : {})
    };
    let claimFailure: unknown;
    let claimed = false;
    try {
      if (this.options.canApply?.() === false) throw new ChatChoicePersistenceError("The machine is shutting down; this answer remains queued.");
      await this.options.chat.respondToChoice(request, undefined, (progress) => this.options.progress?.(progress, card.conversationId), {
        decisionEventId: key,
        ...(answerOpId ? { operationId: answerOpId } : {}),
        beforeApply: async (participantId) => {
          try {
            if (this.options.canApply?.() === false) throw new CardRetryError("The machine is shutting down; this answer remains queued.");
            claimed = await commands.claimTarget({ ...owner, eventId: key, conversationId: card.conversationId, targetKey, participantId });
            if (!claimed) throw new CardRetryError("Another executor claimed this choice; waiting for its outcome.");
            if (this.options.canApply?.() === false) throw new Error("The machine shut down after claiming this answer; continuation was not confirmed.");
          } catch (error) { claimFailure = error; throw error; }
        }
      });
      return this.remember(key, { kind: "applied" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof ChatChoicePersistenceError || (claimFailure && !claimed)) return { kind: "retry", reason };
      if (claimed) return this.remember(key, { kind: "uncertain", reason });
      return { kind: "refused", reason };
    }
  }

  private remember(key: string, result: CardApplyResult): CardApplyResult {
    this.outcomes.set(key, result);
    while (this.outcomes.size > 500) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
    return result;
  }
}

/**
 * Applies the User's answer to a member's mentions waiting for approval (a
 * message from before mentions stopped asking), raised by this device for
 * one of its members, at most once: the claim is taken before the members
 * asked start, so a crash in between reports the answer as uncertain rather
 * than asking them twice.
 */
export class MachineMentionExecutor {
  private readonly active = new Map<string, Promise<CardApplyResult>>();
  private readonly outcomes = new Map<string, CardApplyResult>();

  constructor(private readonly options: {
    storage: StorageService;
    chat: Pick<ChatService, "respondToMentions">;
    progress?: (progress: ReviewProgress, conversationId: string) => void;
    runtimeIdentity(): Promise<NativeRuntimeIdentity>;
    canApply?(): boolean;
  }) {}

  hasActiveWork(): boolean { return this.active.size > 0; }

  apply(card: HubCard): Promise<CardApplyResult> {
    const key = cardAnswerKey(card);
    const current = this.active.get(key);
    if (current) return current;
    const work = this.applyOnce(card, key);
    this.active.set(key, work);
    void work.finally(() => this.active.delete(key)).catch(() => undefined);
    return work;
  }

  private async applyOnce(card: HubCard, key: string): Promise<CardApplyResult> {
    const known = this.outcomes.get(key);
    if (known) return known;
    const sourceMessageId = card.messageId ?? (card.cardId.startsWith("mention:") ? card.cardId.slice("mention:".length) : "");
    const answer = card.answer;
    if (card.state === "pending" || !card.answeredAt || !sourceMessageId || !isHubMentionCardAnswer(answer)) {
      return { kind: "refused", reason: "This answer is not one this card takes." };
    }
    const conversation: Conversation | undefined = await this.options.storage.getConversation(card.conversationId);
    const message = conversation?.messages.find((item) => item.id === sourceMessageId);
    if (!message || !message.participantId) return { kind: "refused", reason: "The message these mentions are in is not here." };
    const pending = pendingMentionsOf(message);
    if (pending.length === 0) return { kind: "refused", reason: "These mentions were already answered." };
    if (answer.approve && !answer.continueRequester && !pending.some((mention) => answer.targetParticipantIds.includes(mention.targetParticipantId))) {
      return { kind: "refused", reason: "Select at least one pending mention." };
    }
    const commands = this.options.storage.nativeCommands();
    // Mentions are answered one member at a time ("Ask @x"), each answer
    // once: the claim is the card's for the members this answer names.
    const named = [...new Set(answer.approve ? answer.targetParticipantIds : pending.map((mention) => mention.targetParticipantId))].sort();
    const targetKey = `${card.cardId}:${named.join(",")}`;
    const previous = await commands.targetEffect(card.conversationId, targetKey);
    if (previous) {
      if (previous.eventId !== key) return { kind: "refused", reason: "These mentions were already answered; the earlier answer stands." };
      return this.remember(key, { kind: "uncertain", reason: "This answer reached the members it names before this device could confirm it; it was not repeated." });
    }
    const owner = await this.options.runtimeIdentity();
    try {
      if (this.options.canApply?.() === false) throw new CardRetryError("This machine is shutting down; the answer waits for its next start.");
      if (!await commands.claimTarget({ ...owner, eventId: key, conversationId: card.conversationId, targetKey, participantId: message.participantId })) {
        return { kind: "retry", reason: "Another executor claimed these mentions; waiting for its outcome." };
      }
    } catch (error) {
      return { kind: "retry", reason: error instanceof Error ? error.message : String(error) };
    }
    try {
      await this.options.chat.respondToMentions({
        conversationId: card.conversationId, sourceMessageId, approve: answer.approve,
        targetParticipantIds: answer.targetParticipantIds,
        ...(answer.continueRequester ? { continueRequester: true } : {}),
        runId: `mention-response:${key}`
      }, undefined, (progress) => this.options.progress?.(progress, card.conversationId));
      return this.remember(key, { kind: "applied" });
    } catch (error) {
      return this.remember(key, { kind: "uncertain", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  private remember(key: string, result: CardApplyResult): CardApplyResult {
    this.outcomes.set(key, result);
    while (this.outcomes.size > 500) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
    return result;
  }
}
