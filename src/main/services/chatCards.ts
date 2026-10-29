import type { HubCard, HubCardState, HubOp } from "../../shared/hubOps";
import { hubCardDigest, hubCardOutcomeFrom, type HubApprovalCardAnswer, type WantedHubCard } from "../../shared/hubCards";
import type { Conversation } from "../../shared/types";
import type { CardApplyResult, MachineApprovalExecutor } from "./machineApprovalExecutor";
import type { MachineChoiceExecutor, MachineMentionExecutor } from "./chatActionNativeClaims";

/** What applies the User's answers to this device's members' cards. */
export interface ChatCardAppliers {
  approval: Pick<MachineApprovalExecutor, "apply">;
  choice: Pick<MachineChoiceExecutor, "apply">;
  mention: Pick<MachineMentionExecutor, "apply">;
}

export type { CardApplyResult };

interface KnownCard {
  conversationId: string;
  state: HubCardState;
  /** What it showed when this device last raised it (or read it). */
  digest?: string;
  /** Where in the server's order this was so: an older word never
   *  replaces a newer one. */
  seq?: number;
}

/**
 * The cards this device raised for its own members, as far as it knows how
 * the User's server holds them (agreement Д9). Kept in memory: the server is
 * the record, read again at every start and reconnect (ChatService
 * resumeServerCards). Decides, for each save of a chat, which cards that
 * save raises, raises again (what one shows changed while it waits, or it
 * waits again after an answer was refused) or settles (what it asked is
 * resolved here), so all of it goes in the save's own transaction.
 */
export class ServerCardBook {
  private readonly cards = new Map<string, KnownCard>();
  /** Answers being applied here now: a save meanwhile does not settle them
   *  (their applier does). */
  readonly applying = new Set<string>();
  /** Whether the server's open cards were read since this device started:
   *  until then an answered card is not settled by a save (its answer may
   *  not have been applied yet). */
  reconciled = false;
  /** Raises the server refused, by what they showed: not sent again until
   *  what the card shows changes or the open cards are read again. */
  private readonly refusedRaises = new Map<string, string>();

  /** Another server (or none): nothing is known of its cards yet. */
  reset(): void {
    this.cards.clear();
    this.refusedRaises.clear();
    this.reconciled = false;
  }

  known(cardId: string): KnownCard | undefined {
    return this.cards.get(cardId);
  }

  /** A card as the server holds it (from the feed, an operation's answer or
   *  a read of the open cards). False when this device knows a newer word
   *  on it (a feed entry read again after a restart): nothing to act on. */
  noteServer(card: HubCard, seq: number): boolean {
    const current = this.cards.get(card.cardId);
    if (current?.seq !== undefined && current.seq > seq) return false;
    this.set(card.cardId, { conversationId: card.conversationId, state: card.state, digest: hubCardDigest(card.cardKind, card.card), seq });
    return true;
  }

  /** What this device just wrote (committed with a save, or queued): so it
   *  will be once the server takes it. */
  noteState(cardId: string, conversationId: string, state: HubCardState, digest?: string, options: { reopen?: boolean } = {}): void {
    const current = this.cards.get(cardId);
    // An answer heard meanwhile (the feed is read while a save is written)
    // is not undone by the save's own raise: only a refusal asks again.
    if (current?.state === "answered" && state === "pending" && !options.reopen) return;
    const shown = digest ?? current?.digest;
    this.set(cardId, { conversationId, state, ...(shown ? { digest: shown } : {}), ...(current?.seq !== undefined ? { seq: current.seq } : {}) });
  }

  forget(cardId: string): void {
    this.cards.delete(cardId);
  }

  /** The server refused to raise this card as it showed then. */
  noteRaiseRefused(cardId: string, digest: string): void {
    this.cards.delete(cardId);
    this.refusedRaises.set(cardId, digest);
    while (this.refusedRaises.size > 1_000) {
      const oldest = this.refusedRaises.keys().next().value;
      if (oldest === undefined) break;
      this.refusedRaises.delete(oldest);
    }
  }

  /** The server's open cards, read at its place `head`: what this device
   *  raised is as the server says. One it believed open that the server does
   *  not list is not open there (settled, or never taken): forgotten, so a
   *  card still waiting here is raised again. Refused raises are tried again. */
  noteOpenCards(mine: HubCard[], head: number): void {
    this.refusedRaises.clear();
    const listed = new Set(mine.map((card) => card.cardId));
    for (const [cardId, known] of [...this.cards]) {
      if (known.state !== "settled" && !listed.has(cardId) && (known.seq === undefined || known.seq <= head)) this.cards.delete(cardId);
    }
    for (const card of mine) this.noteServer(card, head);
  }

  /** Cards known open in a chat (raised and not settled). */
  openIn(conversationId: string): string[] {
    return [...this.cards.entries()].filter(([, card]) => card.conversationId === conversationId && card.state !== "settled").map(([cardId]) => cardId);
  }

  private set(cardId: string, card: KnownCard): void {
    this.cards.delete(cardId);
    this.cards.set(cardId, card);
    // Settled cards are forgotten first; the rest are a few hundred at most.
    while (this.cards.size > 5_000) {
      const settled = [...this.cards.entries()].find(([, item]) => item.state === "settled")?.[0] ?? this.cards.keys().next().value;
      if (settled === undefined) break;
      this.cards.delete(settled);
    }
  }

  /**
   * The operations a save of `conversation` makes on its cards, and what to
   * note once that save is committed. `wanted` are the cards the saved chat
   * holds for this device's members.
   */
  opsFor(conversation: Conversation, wanted: WantedHubCard[], newOpId: () => string): { ops: HubOp[]; commit(): void } {
    const ops: HubOp[] = [];
    const notes: Array<() => void> = [];
    const wantedIds = new Set(wanted.map((card) => card.cardId));
    for (const want of wanted) {
      const known = this.cards.get(want.cardId);
      // Answered: the answer stands until it is applied and settled here.
      if (known?.state === "answered") continue;
      // The User approved it already (its roster change waits to be made):
      // kept open, never put up again as a question.
      if (want.keepOnly) continue;
      if (known && known.state === "pending" && known.digest === want.digest) continue;
      if (!known && this.refusedRaises.get(want.cardId) === want.digest) continue;
      ops.push({ opId: newOpId(), kind: "card.raise", conversationId: conversation.id, cardId: want.cardId, cardKind: want.cardKind,
        participantId: want.participantId, ...(want.messageId ? { messageId: want.messageId } : {}), card: want.card });
      // Decided here (its member's policy allowed it): answered at once, by
      // this device, so nobody is asked.
      const selfAnswer: HubApprovalCardAnswer | undefined = want.selfAnswer;
      if (selfAnswer) ops.push({ opId: newOpId(), kind: "card.answer", conversationId: conversation.id, cardId: want.cardId, answer: { ...selfAnswer } });
      notes.push(() => this.noteState(want.cardId, conversation.id, selfAnswer ? "answered" : "pending", want.digest));
    }
    for (const [cardId, known] of this.cards) {
      if (known.conversationId !== conversation.id || wantedIds.has(cardId)) continue;
      if (known.state === "settled") continue;
      // An answer being applied here (or one this device has not looked at
      // since it started) is settled by its applier.
      if (this.applying.has(cardId) || (known.state === "answered" && !this.reconciled)) continue;
      ops.push({ opId: newOpId(), kind: "card.settle", conversationId: conversation.id, cardId,
        outcome: hubCardOutcomeFrom(conversation, cardId, known.state === "answered" ? "applied" : "closed") as unknown as Record<string, unknown> });
      notes.push(() => this.noteState(cardId, conversation.id, "settled"));
    }
    return { ops, commit: () => { for (const note of notes) note(); } };
  }
}
