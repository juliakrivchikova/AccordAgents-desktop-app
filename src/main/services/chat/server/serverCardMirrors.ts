import { newOpId } from "../../chatServerOps";
import type { HubCard } from "../../../../shared/hubOps";
import type { HubApprovalCardAnswer, HubApprovalCardPayload, HubCardOutcome } from "../../../../shared/hubCards";
import type { ChatAppToolApproval, ChatMessageMetadata, ChatServerCardMark, Conversation } from "../../../../shared/types";
import { StorageService } from "../../storage";
import { chatAppToolApprovals, upsertAppToolApproval } from "../approvals/approvalRecords";
import { chatParticipants } from "../members/identity";
import { laterThan } from "../members/removalRules";
import { stableJson } from "../store/messages";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** How long a read of the open cards waits for the feed to reach it. */
const CARD_RECONCILE_READ_WAIT_MS = 30_000;

/** Cards of other devices, mirrored into this copy of the chat. */
export class ServerCardMirrors {
  private cardsReconciling?: Promise<void>;
  /** Where in the server's order this desktop last heard of another
   *  device's card (its feed): a list of open cards read before that is
   *  older than what the feed said. */
  readonly mirroredCardSeqs = new Map<string, number>();
  private cardsReconcileAgain = false;
  private cardsReconcileMessages = false;

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "choiceExpiry" | "connectorSignIns" | "host" | "serverCards" | "serverLink" | "store" | "toolPermissions"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "storage">
  ) {}

  /**
   * After a start or a reconnect: the server's open cards are read. Cards
   * this device holds for its members are raised where the server lacks
   * them (or lacks what they show now) and settled where they are resolved
   * here; answers this device has not applied yet are applied; and the
   * desktop's view of other devices' cards is brought up to date.
   */
  async resumeServerCards(options: { messages?: boolean } = {}): Promise<void> {
    // Every message row is read for cards at a start (or after the feed forgot
    // this device's place), not at each reconnect: what was raised meanwhile
    // went up with its save, and the server's open cards name the rest.
    if (options.messages !== false) this.cardsReconcileMessages = true;
    if (this.cardsReconciling) {
      this.cardsReconcileAgain = true;
      return this.cardsReconciling;
    }
    const run = (async () => {
      do {
        this.cardsReconcileAgain = false;
        const messages = this.cardsReconcileMessages;
        this.cardsReconcileMessages = false;
        try {
          await this.reconcileServerCards({ messages });
        } catch (error) {
          // Not done (the server could not be read): the next one reads
          // every message row, as this one was to.
          if (messages) this.cardsReconcileMessages = true;
          throw error;
        }
      } while (this.cardsReconcileAgain);
    })();
    this.cardsReconciling = run;
    try {
      await run;
    } finally {
      if (this.cardsReconciling === run) this.cardsReconciling = undefined;
    }
  }

  private async reconcileServerCards(options: { messages: boolean }): Promise<void> {
    const link = this.chat.serverLink.current;
    const me = link?.deviceId();
    if (!link?.openCards || !me) return;
    const read = await link.openCards();
    if (!read) return;
    // The feed read up to the list's place first: nothing older is applied
    // after it, and the view of other devices' cards is as current as it.
    await link.readThrough?.(read.head, CARD_RECONCILE_READ_WAIT_MS);
    const mine = read.cards.filter((card) => card.raisedBy === me);
    this.chat.serverCards.book.noteOpenCards(mine, read.head);
    const storage = this.deps.storage as Partial<Pick<StorageService, "conversationIdsWithOpenCards">>;
    const local = typeof storage.conversationIdsWithOpenCards === "function"
      ? await storage.conversationIdsWithOpenCards.call(this.deps.storage, { messages: options.messages }) : [];
    const chats = new Set<string>([...local, ...mine.map((card) => card.conversationId)]);
    for (const conversationId of chats) {
      if (await this.deps.storage.conversationTombstones?.().isDeleted(conversationId)) continue;
      const conversation = await this.deps.storage.getConversation(conversationId);
      if (!conversation || conversation.kind !== "chat") continue;
      // Decided on the chat's newest copy, between its saves: a card a save
      // raised meanwhile is never taken for one resolved here.
      await this.chat.store.withChatMutation(conversation, async () => {
        // Cards left by calls that ended (this device restarted) are closed
        // before the server is told which are open.
        const signInsExpired = this.chat.connectorSignIns.expireOrphanedConnectorSignIns(conversation);
        if (this.chat.toolPermissions.expireOrphanedToolPermissions(conversation) || signInsExpired) {
          conversation.updatedAt = new Date().toISOString();
          await this.chat.store.saveConversation(conversation);
        }
        const { ops, commit } = this.chat.serverCards.book.opsFor(conversation, this.chat.serverCards.wantedServerCards(conversation), newOpId);
        if (ops.length === 0) return;
        await link.enqueue(ops);
        commit();
        void this.deps.debugLogs.write("chat.card.reconciled", { conversationId, ops: ops.map((op) => `${op.kind}:${"cardId" in op ? op.cardId : ""}`).slice(0, 20) });
      });
    }
    for (const card of mine) if (card.state === "answered") this.chat.serverCards.scheduleCardApply(card);
    const firstRead = !this.chat.serverCards.book.reconciled;
    this.chat.serverCards.book.reconciled = true;
    // Choices that expired while it was not known which were answered on the
    // server are closed now that it is. When message rows were read, the
    // chats just read name every chat with a waiting choice: no second pass.
    if (firstRead) {
      void (async () => this.chat.choiceExpiry.resumeChoiceExpiry(options.messages ? local : await this.chat.choiceExpiry.chatIdsWithPendingChoices()))().catch((error) => {
        void this.deps.debugLogs.write("chat.choice.expiry-resume-error", { message: error instanceof Error ? error.message : String(error) });
      });
    }
    if (!this.chat.host.machineRuntime) await this.reconcileCardMirrors(read.cards.filter((card) => card.raisedBy !== me), local, read.head);
  }

  /** The desktop's view of other devices' cards, as the server holds them
   *  now: a card it showed that is not open there any more is closed. */
  private async reconcileCardMirrors(others: HubCard[], localChats: string[], head: number): Promise<void> {
    const open = new Map(others.map((card) => [card.cardId, card]));
    // What the feed said of a card after the list was read is newer than the
    // list: it is left as the feed said.
    const newer = (cardId: string): boolean => (this.mirroredCardSeqs.get(cardId) ?? 0) > head;
    const byChat = new Map<string, HubCard[]>();
    for (const card of others) byChat.set(card.conversationId, [...(byChat.get(card.conversationId) ?? []), card]);
    for (const conversationId of new Set([...byChat.keys(), ...localChats])) {
      if (await this.deps.storage.conversationTombstones?.().isDeleted(conversationId)) continue;
      const conversation = await this.deps.storage.getConversation(conversationId);
      if (!conversation || conversation.kind !== "chat") continue;
      await this.chat.store.withChatMutation(conversation, async () => {
        // What this chat shows of other devices' cards: read again as the
        // server holds them, it is saved only when that differs.
        const shown = (): string => stableJson({
          approvals: chatAppToolApprovals(conversation).map((approval) => ({ ...approval, updatedAt: "" })),
          marks: conversation.messages.flatMap((message) => message.metadata?.serverCard ? [[message.id, message.metadata.serverCard]] : [])
        });
        const before = shown();
        for (const card of byChat.get(conversationId) ?? []) {
          if (newer(card.cardId)) continue;
          this.mirrorServerCard(conversation, card.state === "answered" ? "card.answer" : "card.raise", card, undefined);
        }
        let changed = shown() !== before;
        const now = new Date().toISOString();
        for (const approval of chatAppToolApprovals(conversation)) {
          if (!approval.homeMachineId || approval.homeMachineId === this.chat.host.hostMachineId || open.has(approval.id) || newer(approval.id)) continue;
          if (approval.status !== "pending" && !approval.machineDecisionPending) continue;
          upsertAppToolApproval(conversation, { ...approval, machineDecisionPending: undefined,
            ...(approval.status === "pending" ? { status: "expired" as const, error: "This request is not waiting on its machine any more." } : {}),
            updatedAt: laterThan(approval.updatedAt) });
          changed = true;
        }
        conversation.messages = conversation.messages.map((message) => {
          const mark = message.metadata?.serverCard;
          if (!mark || open.has(mark.cardId) || newer(mark.cardId)) return message;
          const { serverCard: _gone, ...metadata } = message.metadata!;
          changed = true;
          return { ...message, metadata };
        });
        if (!changed) return;
        conversation.updatedAt = now;
        await this.chat.store.saveConversation(conversation, { emitChanges: false });
      });
    }
  }

  /**
   * The desktop's view of a card a member on another device raised: an
   * approval is shown as that member's card here (with the answer it got,
   * waiting for its machine); a choice or mentions answered elsewhere are
   * marked answered on the member's message until its machine applies them.
   * A machine member's roster change is made by its machine (Д2): here its
   * card waits for that machine's outcome. True when the chat changed.
   */
  mirrorServerCard(
    conversation: Conversation,
    kind: "card.raise" | "card.answer" | "card.settle",
    card: HubCard,
    opId: string | undefined
  ): boolean {
    const member = chatParticipants(conversation).find((item) => item.id === card.participantId);
    const homeMachineId = member?.homeMachineId;
    const machineName = (homeMachineId ? this.chat.serverLink.current?.machineName(homeMachineId) : undefined) ?? "the machine";
    if (card.cardKind === "choice" || card.cardKind === "mention") {
      const index = conversation.messages.findIndex((item) => item.id === card.messageId);
      if (index < 0) return false;
      const message = conversation.messages[index];
      const metadata: ChatMessageMetadata = { ...(message.metadata ?? {}) };
      if (kind === "card.answer" && card.state === "answered") {
        const mark: ChatServerCardMark = { cardId: card.cardId, state: "answered", answer: card.answer ?? {}, answeredAt: card.answeredAt ?? new Date().toISOString(), machineName };
        // Read again (a reconnect lists the open cards): nothing changed.
        if (stableJson(metadata.serverCard ?? null) === stableJson(mark)) return false;
        metadata.serverCard = mark;
      } else if (metadata.serverCard?.cardId === card.cardId) {
        delete metadata.serverCard;
      } else {
        return false;
      }
      conversation.messages[index] = { ...message, metadata };
      return true;
    }
    const payload = card.card as Partial<HubApprovalCardPayload>;
    const raised = payload.approval;
    if (!raised || raised.id !== card.cardId || raised.requesterParticipantId !== card.participantId || !homeMachineId) return false;
    const current = chatAppToolApprovals(conversation).find((item) => item.id === card.cardId);
    // Made here already (a machine member's roster change): no older word
    // from the machine brings the waiting state back.
    const settledHere = current?.rosterChangeSettledAt;
    // Never with a waiting marker: only the member's own device makes its
    // roster change (Д2), and a marker here would queue it on this desktop.
    const decided = (approval: ChatAppToolApproval): ChatAppToolApproval => {
      const { memberRemovalQueuedAt: _removal, memberAdditionQueuedAt: _addition, ...shown } = approval;
      return { ...shown, conversationId: conversation.id, homeMachineId, updatedAt: laterThan(current?.updatedAt) };
    };
    // The same word read again (a reconnect lists the open cards, the feed
    // may repeat a raise) changes nothing here.
    const put = (next: ChatAppToolApproval): boolean => {
      if (current && stableJson({ ...current, updatedAt: "" }) === stableJson({ ...next, updatedAt: "" })) return false;
      upsertAppToolApproval(conversation, next);
      return true;
    };
    if (kind === "card.raise") {
      if (settledHere) return false;
      const { machineDecisionPending: _pending, machineAppliedDecisionId: _decision, memberRemovalQueuedAt: _removal, memberAdditionQueuedAt: _addition,
        cardRefusals: _refusals, ...shown } = raised;
      return put(decided({ ...shown, ...(payload.refusals?.length ? { cardRefusals: payload.refusals } : {}) } as ChatAppToolApproval));
    }
    if (kind === "card.answer") {
      if (settledHere || card.state !== "answered") return false;
      const base = current ?? decided(raised);
      const answer = (card.answer ?? {}) as Partial<HubApprovalCardAnswer>;
      const answeredAt = card.answeredAt ?? new Date().toISOString();
      // A roster change too: the member's own machine makes it (Д2) and
      // settles the card; here it waits for that.
      const known = base.machineDecisionPending?.at === answeredAt ? base.machineDecisionPending.decisionId : undefined;
      return put(decided({ ...base,
        machineDecisionPending: { decisionId: known ?? opId ?? `server:${card.cardId}@${answeredAt}`, machineName, approve: answer.approve === true, at: answeredAt } }));
    }
    const outcome = (card.outcome ?? {}) as Partial<HubCardOutcome>;
    if (!current) return false;
    if (outcome.result === "refused") {
      // Asked again (a raise follows): its answer was not taken.
      if (settledHere) return false;
      const { machineDecisionPending: _pending, machineAppliedDecisionId: _decision, memberRemovalQueuedAt: _removal, memberAdditionQueuedAt: _addition, ...open } = current;
      return put(decided({ ...open, status: "pending" } as ChatAppToolApproval));
    }
    if (outcome.approval && outcome.approval.id === card.cardId) {
      const final: ChatAppToolApproval = { ...outcome.approval };
      if (settledHere) {
        delete final.memberRemovalQueuedAt;
        delete final.memberAdditionQueuedAt;
      }
      return put(decided({ ...final, machineDecisionPending: undefined,
        ...(settledHere ? { rosterChangeSettledAt: settledHere } : {}),
        ...(current.machineAppliedDecisionId ? { machineAppliedDecisionId: current.machineAppliedDecisionId } : {}) }));
    }
    if (current.status !== "pending" && !current.machineDecisionPending) return false;
    upsertAppToolApproval(conversation, decided({ ...current, machineDecisionPending: undefined,
      ...(current.status === "pending" ? { status: "cancelled" as const, error: outcome.reason || `Closed on ${machineName}.` } : {}) }));
    return true;
  }

  noteMirroredCardSeq(cardId: string, seq: number): void {
    this.mirroredCardSeqs.delete(cardId);
    this.mirroredCardSeqs.set(cardId, Math.max(seq, this.mirroredCardSeqs.get(cardId) ?? 0));
    while (this.mirroredCardSeqs.size > 5_000) {
      const oldest = this.mirroredCardSeqs.keys().next().value;
      if (oldest === undefined) break;
      this.mirroredCardSeqs.delete(oldest);
    }
  }
}
