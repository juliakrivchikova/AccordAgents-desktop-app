import { newOpId } from "../../chatServerOps";
import type { HubCard, HubFeedEntry, HubOp } from "../../../../shared/hubOps";
import {
  choiceCardId, hubCardDigest, hubCardOutcomeFrom, pendingMentionsOf, wantedHubCards, type HubApprovalCardPayload,
  type HubChoiceCardPayload, type HubCardOutcome, type WantedHubCard
} from "../../../../shared/hubCards";
import { ServerCardBook, type CardApplyResult, type ChatCardAppliers } from "../../chatCards";
import type { HubOpOutcome } from "../../hubOpsClient";
import type { ChatMessage, Conversation } from "../../../../shared/types";
import { chatAppToolApprovals, isChatAppToolApproval, upsertAppToolApproval } from "../approvals/approvalRecords";
import { updatePendingChoiceCancellation, updatePendingMentionStatus } from "../choices/choiceRecords";
import { chatParticipants } from "../members/identity";
import { laterThan } from "../members/removalRules";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** An answer this device could not take right now is tried again after this. */
const CARD_APPLY_RETRY_MS = 15_000;

/** How long an answer given on this device's screen waits to be applied
 *  here (a card raised here) before the screen is told it was sent. */
const CARD_ANSWER_LOCAL_WAIT_MS = 30_000;

/** Refused answers a card keeps (the last few). */
const CARD_REFUSALS_KEPT = 5;

/** How long an answer the server took waits for this device's copy to show
 *  it before the screen is told it was sent. */
const CARD_ANSWER_FEED_WAIT_MS = 10_000;

/** A card the server refused to take is offered again after this. */
const CARD_RAISE_RETRY_MS = 60_000;

/** Cards raised on the server, and their answers applied here. */
export class ServerCards {
  /** The cards this device raised for its members, as the server holds them. */
  readonly book = new ServerCardBook();
  /** What applies answers to this device's members' cards (set at start). */
  private cardAppliers?: () => Promise<ChatCardAppliers>;
  /** Answers given on this device's screen to its own cards, by operation,
   *  waiting to hear how they were applied. */
  private readonly cardAnswerWaiters = new Map<string, (result: CardApplyResult) => void>();
  private readonly cardRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cardRaiseRetryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly chat: Pick<ChatModules, "choiceExpiry" | "host" | "serverCardMirrors" | "serverLink" | "store">,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "storage">
  ) {}

  // --- cards a member waits on, on the User's server (Д9) -------------------

  /** Sets what applies the User's answers to this device's members' cards
   *  (the native approval and choice executors). */
  setCardAppliers(appliers: (() => Promise<ChatCardAppliers>) | undefined): void {
    this.cardAppliers = appliers;
  }

  /** The card operations a save of this chat makes (Д9): cards raised for
   *  its members here, raised again when what they show changed, settled
   *  when what they asked is resolved here. Committed with the save. */
  serverCardOpsFor(snapshot: Conversation): { ops: HubOp[]; commit(): void } {
    if (!this.chat.serverLink.current || snapshot.kind !== "chat") return { ops: [], commit: () => undefined };
    return this.book.opsFor(snapshot, this.wantedServerCards(snapshot), newOpId);
  }

  /** The cards this chat holds for members that run on this device: a
   *  machine's members' cards are that machine's to raise, never a copy's. */
  wantedServerCards(conversation: Conversation): WantedHubCard[] {
    const participants = chatParticipants(conversation);
    const me = this.chat.serverLink.current?.deviceId();
    const memberHere = (participantId: string | undefined): boolean => {
      const participant = participants.find((item) => item.id === participantId);
      return Boolean(participant) && this.chat.host.runsHere(participant!);
    };
    const ownsMessage = (message: ChatMessage): boolean => {
      const writer = message.metadata?.serverWriter;
      if (typeof writer === "string" && (!me || writer !== me)) return false;
      return memberHere(message.participantId);
    };
    const wanted = wantedHubCards(conversation, {
      approval: (approval) => isChatAppToolApproval(approval) && (!approval.homeMachineId || approval.homeMachineId === this.chat.host.hostMachineId) &&
        memberHere(approval.requesterParticipantId),
      // Only for a member that runs here, as the server allows: a member of
      // a machine no longer on the server's devices (its messages moved as
      // this computer's) has nobody to answer it.
      message: ownsMessage
    });
    // A choice that expired here after the User had answered it on the
    // server: kept open for her answer, which is applied here (respondToChoice
    // takes it), never settled as if it had been.
    for (const message of conversation.messages) {
      const choice = message.metadata?.pendingChoice;
      if (choice?.status !== "cancelled" || !choice.expiredAt || !message.participantId || !ownsMessage(message) ||
        !this.chat.choiceExpiry.choiceAnsweredHere(message.id)) continue;
      const payload: HubChoiceCardPayload = { choice, sourceMessageId: message.id };
      wanted.push({ cardId: choiceCardId(message.id), conversationId: conversation.id, cardKind: "choice", participantId: message.participantId,
        messageId: message.id, card: payload as unknown as Record<string, unknown>, digest: hubCardDigest("choice", payload as unknown as Record<string, unknown>),
        keepOnly: true });
    }
    return wanted;
  }

  /** The server answered one of this device's operations: for a card, how
   *  it holds it now. A raise it refused is not sent again as it was. */
  noteServerOpAnswered(op: HubOp, outcome: HubOpOutcome): void {
    if (op.kind !== "card.raise" && op.kind !== "card.answer" && op.kind !== "card.settle") return;
    if (outcome.status === "accepted") {
      if (outcome.card && outcome.card.raisedBy === this.chat.serverLink.current?.deviceId()) this.book.noteServer(outcome.card, outcome.seq);
      return;
    }
    void this.deps.debugLogs.write("chat.card.op-refused", { kind: op.kind, cardId: op.cardId, conversationId: op.conversationId, reason: outcome.reason });
    // An expired choice the User had answered just before it closed: open
    // again, and her answer is applied.
    if (op.kind === "card.settle" && (op.outcome as { unanswered?: unknown }).unanswered === true) {
      void this.chat.choiceExpiry.reopenChoiceAnsweredFirst(op.conversationId, op.cardId).catch((error) => {
        void this.deps.debugLogs.write("chat.choice.reopen-error", { conversationId: op.conversationId, cardId: op.cardId,
          message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (op.kind === "card.raise") {
      this.book.noteRaiseRefused(op.cardId, hubCardDigest(op.cardKind, op.card));
      // Refused for now (the server does not know this device for the
      // member yet, say): tried again a while later, not only at a reconnect.
      if (!this.cardRaiseRetryTimer) {
        this.cardRaiseRetryTimer = setTimeout(() => {
          this.cardRaiseRetryTimer = undefined;
          void this.chat.serverCardMirrors.resumeServerCards({ messages: false }).catch((error) => {
            void this.deps.debugLogs.write("chat.card.raise-retry-error", { message: error instanceof Error ? error.message : String(error) });
          });
        }, CARD_RAISE_RETRY_MS);
        this.cardRaiseRetryTimer.unref?.();
      }
    }
  }

  /** Card changes in the feed for cards this device raised: their state, and
   *  an answer to apply here (from any device, this one included). */
  noteServerCardEntries(entries: HubFeedEntry[]): void {
    const me = this.chat.serverLink.current?.deviceId();
    if (!me) return;
    for (const entry of entries) {
      const effect = entry.effect;
      if (effect.kind !== "card.raise" && effect.kind !== "card.answer" && effect.kind !== "card.settle") continue;
      if (effect.card.raisedBy !== me) continue;
      // An answer is applied only while it is the card's newest word here.
      if (this.book.noteServer(effect.card, entry.seq) && effect.kind === "card.answer") this.scheduleCardApply(effect.card, entry.opId);
    }
  }

  /** Applies an answer to a card this device raised, once, then settles it
   *  (or asks it again when the answer could not be applied). */
  scheduleCardApply(card: HubCard, feedOpId?: string): void {
    // The operation the answer came in: a refusal is kept under it, so the
    // device that sent it says why (after a restart too).
    const answerOpId = feedOpId ?? card.answerOpId;
    const me = this.chat.serverLink.current?.deviceId();
    if (!me || card.raisedBy !== me || card.state !== "answered") return;
    // This device's own word on a card it decided itself: nothing to apply.
    if ((card.answer as { auto?: unknown } | undefined)?.auto === true && card.answeredBy === me) return;
    if (this.book.applying.has(card.cardId)) return;
    this.book.applying.add(card.cardId);
    const timer = this.cardRetryTimers.get(card.cardId);
    if (timer) {
      clearTimeout(timer);
      this.cardRetryTimers.delete(card.cardId);
    }
    void (async () => {
      let result: CardApplyResult;
      try {
        const applied = await this.applyCardAnswer(card, answerOpId);
        if (!applied) {
          this.book.applying.delete(card.cardId);
          if (answerOpId) {
            const waiter = this.cardAnswerWaiters.get(answerOpId);
            this.cardAnswerWaiters.delete(answerOpId);
            waiter?.({ kind: "applied" });
          }
          return;
        }
        result = applied;
      } catch (error) {
        result = { kind: "retry", reason: error instanceof Error ? error.message : String(error) };
      }
      try {
        await this.finishCardAnswer(card, result, answerOpId);
      } catch (error) {
        void this.deps.debugLogs.write("chat.card.finish-error", { conversationId: card.conversationId, cardId: card.cardId,
          message: error instanceof Error ? error.message : String(error) });
        if (result.kind !== "retry") result = { kind: "retry", reason: error instanceof Error ? error.message : String(error) };
      } finally {
        this.book.applying.delete(card.cardId);
      }
      if (answerOpId) {
        const waiter = this.cardAnswerWaiters.get(answerOpId);
        this.cardAnswerWaiters.delete(answerOpId);
        waiter?.(result);
      }
      if (result.kind === "retry") this.retryCardApplyLater(card, answerOpId);
    })();
  }

  private async applyCardAnswer(card: HubCard, answerOpId?: string): Promise<CardApplyResult | undefined> {
    // Applied before and settled here, the settle not sent yet (it stopped,
    // or the server is away): nothing to do again.
    if (await this.chat.serverLink.current?.cardSettleQueued?.(card.conversationId, card.cardId)) return undefined;
    const appliers = await this.cardAppliers?.();
    if (!appliers) return { kind: "retry", reason: "This device cannot apply answers yet." };
    if (card.cardKind === "choice") return appliers.choice.apply(card, answerOpId);
    if (card.cardKind === "mention") return appliers.mention.apply(card);
    return appliers.approval.apply(card);
  }

  private retryCardApplyLater(card: HubCard, answerOpId?: string): void {
    if (this.cardRetryTimers.has(card.cardId)) return;
    const timer = setTimeout(() => {
      this.cardRetryTimers.delete(card.cardId);
      if (this.book.known(card.cardId)?.state === "answered") this.scheduleCardApply(card, answerOpId);
    }, CARD_APPLY_RETRY_MS);
    timer.unref?.();
    this.cardRetryTimers.set(card.cardId, timer);
  }

  /**
   * What came of an answer, said on the server. Settled with the outcome, and
   * the settle names the answer it is about (the server never lets it close
   * a card asked again since). Refused while what it asked still waits here:
   * settled with why, and asked again. Applied (or past its point of no
   * return) while the member still waits on the same question (mentions
   * approved one at a time): settled, and asked again for the rest. Applied
   * while an approved roster change waits to be made: left answered until
   * it is made (never asked again: the User answered it).
   */
  private async finishCardAnswer(card: HubCard, result: CardApplyResult, answerOpId?: string): Promise<void> {
    const link = this.chat.serverLink.current;
    void this.deps.debugLogs.write("chat.card.answer-applied", { conversationId: card.conversationId, cardId: card.cardId, cardKind: card.cardKind,
      answeredBy: card.answeredBy ?? "", result: result.kind, ...(result.kind !== "applied" ? { reason: result.reason } : {}) });
    if (!link || result.kind === "retry") return;
    const settle = (outcome: HubCardOutcome): HubOp => ({ opId: newOpId(), kind: "card.settle", conversationId: card.conversationId, cardId: card.cardId,
      outcome: { ...outcome, ...(answerOpId ? { answerOpId } : {}) } as unknown as Record<string, unknown> });
    const raise = (again: WantedHubCard): HubOp => ({ opId: newOpId(), kind: "card.raise", conversationId: card.conversationId, cardId: again.cardId,
      cardKind: again.cardKind, participantId: again.participantId, ...(again.messageId ? { messageId: again.messageId } : {}), card: again.card });
    await this.chat.store.waitForQueuedSave(card.conversationId);
    let conversation = await this.deps.storage.getConversation(card.conversationId);
    if (!conversation || conversation.kind !== "chat") {
      await link.enqueue([settle({ result: "closed", reason: "The chat is gone." })]);
      this.book.noteState(card.cardId, card.conversationId, "settled");
      return;
    }
    if (result.kind === "uncertain") {
      // Never asked again: what it still asked is closed here with why.
      await this.closeCardHere(conversation, card, result.reason);
      conversation = await this.deps.storage.getConversation(card.conversationId);
      if (!conversation || conversation.kind !== "chat") {
        await link.enqueue([settle({ result: "closed", reason: "The chat is gone." })]);
        this.book.noteState(card.cardId, card.conversationId, "settled");
        return;
      }
    }
    const waiting = this.wantedServerCards(conversation).find((item) => item.cardId === card.cardId);
    // Whether the member still waits on the User for it (a question), or only
    // on a roster change the User approved being made.
    const stillAsks = Boolean(waiting) && (waiting!.cardKind === "choice" || waiting!.cardKind === "mention" ||
      (waiting!.card as unknown as HubApprovalCardPayload).approval?.status === "pending");
    if (result.kind === "refused" && waiting && !waiting.selfAnswer) {
      // Not applied, and the member still waits: the card is asked again,
      // and says why to the device that sent the answer.
      await this.recordCardRefusal(conversation, card, result.reason, answerOpId);
      const stored = await this.deps.storage.getConversation(card.conversationId);
      const again = stored ? this.wantedServerCards(stored).find((item) => item.cardId === card.cardId) : undefined;
      await link.enqueue([settle({ result: "refused", reason: result.reason }), ...(again ? [raise(again)] : [])]);
      this.book.noteState(card.cardId, card.conversationId, again ? "pending" : "settled", again?.digest, { reopen: true });
      return;
    }
    if (waiting && stillAsks && !waiting.selfAnswer) {
      // Done, and the member still waits on the rest of it: asked again.
      await link.enqueue([settle({ ...hubCardOutcomeFrom(conversation, card.cardId, result.kind === "applied" ? "applied" : "uncertain"),
        ...(result.kind !== "applied" ? { reason: result.reason } : {}) }), raise(waiting)]);
      this.book.noteState(card.cardId, card.conversationId, "pending", waiting.digest, { reopen: true });
      return;
    }
    // Applied, and an approved roster change waits to be made: settled when
    // it is made (serverCardOpsFor), on the device whose member asked (Д2).
    if (waiting && !stillAsks && result.kind !== "refused") return;
    const final = result.kind === "applied" ? "applied" : result.kind === "uncertain" ? "uncertain" : "closed";
    await link.enqueue([settle({ ...hubCardOutcomeFrom(conversation, card.cardId, final), ...(result.kind !== "applied" ? { reason: result.reason } : {}) })]);
    this.book.noteState(card.cardId, card.conversationId, "settled");
  }

  /** An answer that crossed its point of no return unconfirmed: what it
   *  answered is closed here (never asked again). */
  private async closeCardHere(conversation: Conversation, card: HubCard, reason: string): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      const now = new Date().toISOString();
      let changed = false;
      if (card.cardKind === "choice" || card.cardKind === "mention") {
        const message = conversation.messages.find((item) => item.id === card.messageId);
        const choice = message?.metadata?.pendingChoice;
        if (message && card.cardKind === "choice" && choice?.status === "pending") {
          updatePendingChoiceCancellation(message, choice.id);
          changed = true;
        }
        const mentions = message ? pendingMentionsOf(message) : [];
        if (message && card.cardKind === "mention" && mentions.length) {
          updatePendingMentionStatus(message, new Set(mentions.map((mention) => mention.targetParticipantId)), "rejected");
          changed = true;
        }
      } else {
        const approval = chatAppToolApprovals(conversation).find((item) => item.id === card.cardId);
        if (approval?.status === "pending") {
          upsertAppToolApproval(conversation, { ...approval, status: "cancelled", error: reason, updatedAt: laterThan(approval.updatedAt) });
          changed = true;
        }
      }
      if (!changed) return;
      conversation.updatedAt = now;
      await this.chat.store.saveConversation(conversation);
    });
  }

  /** Why an answer was not taken, kept with what it answered (the last few):
   *  the card asked again carries it. A choice keeps its own (respondToChoice). */
  private async recordCardRefusal(conversation: Conversation, card: HubCard, reason: string, answerOpId?: string): Promise<void> {
    if (card.cardKind === "choice") return;
    const refusal = { operationId: answerOpId ?? "", reason, at: new Date().toISOString() };
    const merged = (list: Array<{ operationId: string; reason: string; at: string }> | undefined) =>
      [...(list ?? []).filter((item) => !answerOpId || item.operationId !== answerOpId), refusal].slice(-CARD_REFUSALS_KEPT);
    await this.chat.store.withChatMutation(conversation, async () => {
      if (card.cardKind === "mention") {
        const index = conversation.messages.findIndex((item) => item.id === card.messageId);
        if (index < 0) return;
        const message = conversation.messages[index];
        conversation.messages[index] = { ...message, metadata: { ...(message.metadata ?? {}), mentionCardRefusals: merged(message.metadata?.mentionCardRefusals) } };
      } else {
        const approval = chatAppToolApprovals(conversation).find((item) => item.id === card.cardId);
        if (!approval) return;
        upsertAppToolApproval(conversation, { ...approval, cardRefusals: merged(approval.cardRefusals), updatedAt: laterThan(approval.updatedAt) });
      }
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
    });
  }

  /**
   * The User answered a card on this device's screen: the answer is written
   * to the User's server and this resolves once the server accepted it (its
   * refusal is the error). A card raised here is applied here from the feed
   * (exactly once, whoever answered); this waits for that too, a little, so
   * a refusal of this device's own (a script's missing keys) is shown.
   */
  async answerServerCard(request: { conversationId: string; cardId: string; answer: Record<string, unknown>; raisedHere: boolean }): Promise<void> {
    const link = this.chat.serverLink.current;
    if (!link) throw new Error("This computer is not linked to your server yet; try again in a moment.");
    const opId = newOpId();
    let applied: Promise<CardApplyResult | undefined> | undefined;
    if (request.raisedHere) {
      applied = new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.cardAnswerWaiters.delete(opId);
          resolve(undefined);
        }, CARD_ANSWER_LOCAL_WAIT_MS);
        timer.unref?.();
        this.cardAnswerWaiters.set(opId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    }
    try {
      await link.enqueue([{ opId, kind: "card.answer", conversationId: request.conversationId, cardId: request.cardId, answer: request.answer }]);
      const outcome = await link.opAnswered(opId);
      if (outcome.status === "rejected") {
        // Not put up yet: by this computer (it is still sending it), or by
        // the device the member runs on (it is off, or has not read this chat
        // since it asked).
        if (outcome.reason === "There is no such card.") {
          throw new Error(request.raisedHere
            ? "This question is not on your server yet. Try again in a moment."
            : "This question is not on your server yet: the device its member runs on has not put it there. Try again when that device is on.");
        }
        throw new Error(outcome.reason);
      }
      // What the server took is shown here before this returns: a card of a
      // member elsewhere reads answered, rather than asking again until the
      // feed brings the answer back.
      if (outcome.seq > 0) await link.readThrough?.(outcome.seq, CARD_ANSWER_FEED_WAIT_MS);
    } catch (error) {
      this.cardAnswerWaiters.delete(opId);
      throw error;
    }
    const result = await applied;
    if (result?.kind === "refused" || result?.kind === "uncertain") throw new Error(result.reason);
  }

  /** Whether a card's subject is this device's: what it raised (or would). */
  cardRaisedHere(conversation: Conversation, cardId: string): boolean {
    return this.wantedServerCards(conversation).some((card) => card.cardId === cardId) || this.book.known(cardId) !== undefined;
  }
}
