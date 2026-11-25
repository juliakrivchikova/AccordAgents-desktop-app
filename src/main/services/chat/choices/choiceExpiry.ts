import type { HubCardState } from "../../../../shared/hubOps";
import { choiceCardId } from "../../../../shared/hubCards";
import { choiceClosedForGoneMember, choiceExpiryPlan, choicesOfGoneMembers, type ChoiceExpiryPlan } from "../../chatChoiceExpiry";
import type { ChatMessage, Conversation } from "../../../../shared/types";
import { StorageService } from "../../storage";
import { chatMemberIds, chatParticipants } from "../members/identity";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** A choice's expiry timer fires this long after it is due, never before. */
const CHOICE_EXPIRY_TIMER_SLACK_MS = 1_000;

/** A due choice that could not be closed (the server could not be asked,
 *  its save failed, an answer to it was being applied) is looked at again
 *  after this. */
const CHOICE_EXPIRY_RETRY_MS = 5 * 60_000;

/** Choices that expire or lose the member that asked them. */
export class ChoiceExpiry {
  /** Each chat's timer for its next waiting choice to expire. */
  private readonly choiceExpiryTimers = new Map<string, { atMs: number; timer: NodeJS.Timeout }>();
  /** The clock choices expire by (tests move it). */
  choiceExpiryNow: () => number = () => Date.now();

  constructor(
    private readonly chat: Pick<ChatModules, "deletion" | "host" | "serverCardMirrors" | "serverCards" | "serverLink" | "store">,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "storage">
  ) {}

  // --- choices that close once the User went on with their member ---------

  /** Which cards this device closes: its own members' ones it wrote. */
  choiceClosedHere(conversation: Conversation): (message: ChatMessage) => boolean {
    const participants = chatParticipants(conversation);
    const me = this.chat.serverLink.current?.deviceId();
    return (message) => {
      const participant = participants.find((item) => item.id === message.participantId);
      if (!participant || !this.chat.host.runsHere(participant)) return false;
      const writer = message.metadata?.serverWriter;
      return !(typeof writer === "string" && me && writer !== me);
    };
  }

  /** The waiting choices of this device's members that the User went on
   *  past (choiceExpiryPlan): those due now. */
  private choiceExpiryPlanFor(conversation: Conversation): ChoiceExpiryPlan {
    const plan = choiceExpiryPlan(conversation.messages, this.choiceClosedHere(conversation));
    const memberIds = chatMemberIds(conversation);
    // A chat always keeps a member: a copy read without its members says
    // nothing about who left, and closes nothing.
    if (memberIds.size === 0) return plan;
    const mayClose = (message: ChatMessage) => this.mayCloseGoneMemberCard(message);
    const memberGone = choicesOfGoneMembers(conversation.messages, memberIds, mayClose);
    const goneMentions = conversation.messages
      .filter((message) => message.role === "participant" && (!message.participantId || !memberIds.has(message.participantId)) &&
        message.metadata?.pendingMentions?.some((mention) => mention.status === "pending") && mayClose(message))
      .map((message) => message.id);
    return memberGone.length || goneMentions.length
      ? { due: [...plan.due, ...memberGone], memberGone, ...(goneMentions.length ? { goneMentions } : {}) }
      : plan;
  }

  /** Which device closes a card whose member left the chat: the one that
   *  wrote its message, else (a message from before the server kept its
   *  writer) the computer, never a machine. */
  private mayCloseGoneMemberCard(message: ChatMessage): boolean {
    const writer = message.metadata?.serverWriter;
    if (typeof writer === "string") return writer === this.chat.serverLink.current?.deviceId();
    return !this.chat.host.machineRuntime;
  }

  /** A member's turn starts (inside its chat mutation): what the User's going
   *  on made due is closed at once. Closing happens in sweepChoiceExpiry,
   *  which asks the server first. */
  noteChoiceExpiry(conversation: Conversation): void {
    const nowMs = this.choiceExpiryNow();
    const plan = this.choiceExpiryPlanFor(conversation);
    if (plan.due.length === 0) return;
    // A due card whose answer is being applied here waits for it: looked at
    // again later, not at every turn meanwhile.
    const free = plan.due.some((messageId) => !this.choiceAnsweredHere(messageId));
    this.scheduleChoiceExpiry(conversation.id, free ? nowMs : nowMs + CHOICE_EXPIRY_RETRY_MS, { replace: free });
  }

  /** This device heard of an answer to this card (or applies one now). */
  choiceAnsweredHere(messageId: string): boolean {
    const cardId = choiceCardId(messageId);
    return this.chat.serverCards.book.applying.has(cardId) || this.chat.serverCards.book.known(cardId)?.state === "answered";
  }

  /** One timer per chat: close what is due now, or look again after a
   *  retry. `replace` sets it to `atMs` (none when undefined); otherwise an
   *  earlier one is kept. */
  scheduleChoiceExpiry(conversationId: string, atMs: number | undefined, options: { replace?: boolean } = {}): void {
    const current = this.choiceExpiryTimers.get(conversationId);
    if (current && !options.replace && atMs !== undefined && current.atMs <= atMs) return;
    if (current && current.atMs === atMs) return;
    if (current) {
      clearTimeout(current.timer);
      this.choiceExpiryTimers.delete(conversationId);
    }
    if (atMs === undefined) return;
    // Never longer than a retry: a time far ahead (a wrong clock) is looked
    // at again within it, never overflowing the timer.
    const delayMs = Math.min(Math.max(0, atMs - this.choiceExpiryNow()), CHOICE_EXPIRY_RETRY_MS) + CHOICE_EXPIRY_TIMER_SLACK_MS;
    const timer = setTimeout(() => {
      if (this.choiceExpiryTimers.get(conversationId)?.timer === timer) this.choiceExpiryTimers.delete(conversationId);
      void this.sweepChoiceExpiry(conversationId);
    }, delayMs);
    timer.unref?.();
    this.choiceExpiryTimers.set(conversationId, { atMs, timer });
  }

  /**
   * Closes a chat's choices that are due. An answer the User gave closes its
   * card, never the expiry: a card answered on the User's server (as the
   * server says now, or as this device heard) is left to its answer, and
   * while the server cannot be asked nothing is closed. An answer that still
   * crosses the expiry is applied all the same (respondToChoice).
   */
  private async sweepChoiceExpiry(conversationId: string): Promise<void> {
    try {
      if (this.chat.deletion.deletedConversationIds.has(conversationId) || await this.deps.storage.conversationTombstones?.().isDeleted(conversationId)) return;
      const conversation = await this.deps.storage.getConversation(conversationId);
      if (!conversation || conversation.kind !== "chat") return;
      const plan = this.choiceExpiryPlanFor(conversation);
      if (plan.due.length === 0 && !plan.goneMentions?.length) {
        this.scheduleChoiceExpiry(conversationId, undefined, { replace: true });
        return;
      }
      let serverStates: Map<string, HubCardState> | undefined;
      const link = this.chat.serverLink.current;
      if (link) {
        // Not known which cards were answered there until they are read
        // since this start: resumeChoiceExpiry runs then.
        if (!this.chat.serverCards.book.reconciled) return;
        const read = await link.openCards?.(conversationId);
        if (!read) throw new Error("The server's open cards could not be read.");
        serverStates = new Map(read.cards.map((card) => [card.cardId, card.state]));
      } else if (this.chat.serverLink.serverLinkInstalled) {
        // Between two links to the server (it is being restarted).
        throw new Error("Not linked to the server.");
      }
      await this.chat.store.withChatMutation(conversation, async () => {
        const closed = this.expireDueChoices(conversation, serverStates);
        const rejected = this.rejectGoneMemberMentions(conversation);
        if (!closed && !rejected) return;
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
      });
    } catch (error) {
      // Not closed: looked at again later, on the copy storage holds then.
      this.scheduleChoiceExpiry(conversationId, this.choiceExpiryNow() + CHOICE_EXPIRY_RETRY_MS);
      void this.deps.debugLogs.write("chat.choice.expiry-error", { conversationId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Rejects, in place, the mention approvals members no longer in the chat
   *  wait on (inside the chat's mutation; the caller saves): nobody is left
   *  to continue with them. */
  private rejectGoneMemberMentions(conversation: Conversation): boolean {
    const gone = new Set(this.choiceExpiryPlanFor(conversation).goneMentions ?? []);
    if (gone.size === 0) return false;
    for (const message of conversation.messages) {
      if (!gone.has(message.id) || !message.metadata?.pendingMentions) continue;
      message.metadata = { ...message.metadata, pendingMentions: message.metadata.pendingMentions.map((mention) =>
        mention.status === "pending" ? { ...mention, status: "rejected" as const } : mention) };
    }
    void this.deps.debugLogs.write("chat.mentions.member-gone", { conversationId: conversation.id, count: gone.size });
    return true;
  }

  /** Closes, in place, the due choices nobody answered (inside the chat's
   *  mutation; the caller saves), and sets the chat's timer to look again at
   *  those an answer is being applied to. */
  private expireDueChoices(conversation: Conversation, serverStates: Map<string, HubCardState> | undefined): boolean {
    const nowMs = this.choiceExpiryNow();
    const plan = this.choiceExpiryPlanFor(conversation);
    let nextAtMs: number | undefined;
    const due = new Set<string>();
    const memberGone = new Set(plan.memberGone ?? []);
    for (const messageId of plan.due) {
      const message = conversation.messages.find((item) => item.id === messageId);
      if (!message) continue;
      // Its member left the chat: an answer has nobody to go to either.
      if (memberGone.has(messageId)) {
        due.add(messageId);
        continue;
      }
      const answered = message.metadata?.serverCard?.state === "answered" || serverStates?.get(choiceCardId(message.id)) === "answered" ||
        this.choiceAnsweredHere(message.id);
      // Its answer is applied (or refused, and it is asked again): looked at
      // again later.
      if (answered) nextAtMs = Math.min(nextAtMs ?? Infinity, nowMs + CHOICE_EXPIRY_RETRY_MS);
      else due.add(messageId);
    }
    this.scheduleChoiceExpiry(conversation.id, nextAtMs, { replace: true });
    if (due.size === 0) return false;
    const now = new Date(nowMs).toISOString();
    for (const message of conversation.messages) {
      const choice = message.metadata?.pendingChoice;
      if (!due.has(message.id) || choice?.status !== "pending") continue;
      message.metadata = { ...message.metadata, pendingChoice: memberGone.has(message.id)
        ? choiceClosedForGoneMember(choice, now)
        : { ...choice, status: "cancelled", cancelledAt: now, expiredAt: now } };
    }
    void this.deps.debugLogs.write("chat.choice.expired", { conversationId: conversation.id, messageIds: [...due].slice(0, 20), count: due.size,
      memberGone: [...due].filter((messageId) => memberGone.has(messageId)).length });
    return true;
  }

  /** The server refused to close an expired choice: the User answered it
   *  first. It waits again (as raised), and the server's open cards are read,
   *  which applies her answer. */
  async reopenChoiceAnsweredFirst(conversationId: string, cardId: string): Promise<void> {
    const messageId = cardId.startsWith("choice:") ? cardId.slice("choice:".length) : "";
    const conversation = messageId ? await this.deps.storage.getConversation(conversationId) : undefined;
    if (!conversation || conversation.kind !== "chat") return;
    await this.chat.store.withChatMutation(conversation, async () => {
      const message = conversation.messages.find((item) => item.id === messageId);
      const choice = message?.metadata?.pendingChoice;
      if (!message || choice?.status !== "cancelled" || !choice.expiredAt) return;
      // Its member left the chat meanwhile: her answer has nobody to go to,
      // and the card closes for good instead (the server takes that close).
      const memberIds = chatMemberIds(conversation);
      if (memberIds.size > 0 && (!message.participantId || !memberIds.has(message.participantId))) {
        if (choice.memberGoneAt) return;
        message.metadata = { ...message.metadata, pendingChoice: choiceClosedForGoneMember(choice, new Date().toISOString()) };
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
        void this.deps.debugLogs.write("chat.choice.reopen-member-gone", { conversationId, messageId });
        return;
      }
      const { expiredAt: _expiredAt, cancelledAt: _cancelledAt, ...waiting } = choice;
      message.metadata = { ...message.metadata, pendingChoice: { ...waiting, status: "pending" } };
      // Raised as it was; the server holds her answer to it.
      this.chat.serverCards.book.noteState(cardId, conversationId, "pending", undefined, { reopen: true });
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
      void this.deps.debugLogs.write("chat.choice.reopened", { conversationId, messageId });
    });
    await this.chat.serverCardMirrors.resumeServerCards({ messages: false });
  }

  /**
   * After the server's open cards were first read (resumeServerCards): the
   * choices the User went on past while this device was off are closed.
   * `conversationIds` are the chats that
   * read named; only those holding a waiting choice are opened.
   */
  async resumeChoiceExpiry(conversationIds: string[]): Promise<void> {
    if (this.chat.serverLink.current && !this.chat.serverCards.book.reconciled) return;
    let ids = conversationIds;
    const storage = this.deps.storage as Partial<Pick<StorageService, "listPendingChoiceMessages">>;
    if (ids.length > 0 && typeof storage.listPendingChoiceMessages === "function") {
      const found = await storage.listPendingChoiceMessages.call(this.deps.storage, ids);
      if (!found.truncated) ids = [...new Set(found.rows.map((row) => row.conversationId))];
    }
    for (const conversationId of ids) await this.sweepChoiceExpiry(conversationId);
  }

  /** A pass over every message row: on the User's data, seconds of the one
   *  storage session, so only where nothing has just read them. */
  async chatIdsWithPendingChoices(): Promise<string[]> {
    const storage = this.deps.storage as Partial<Pick<StorageService, "conversationIdsWithPendingChoices">>;
    return typeof storage.conversationIdsWithPendingChoices === "function" ? storage.conversationIdsWithPendingChoices.call(this.deps.storage) : [];
  }
}
