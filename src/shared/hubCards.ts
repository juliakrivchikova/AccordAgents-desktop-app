/**
 * Cards a member waits on, as the User's server holds them (agreement Д9):
 * what the device a member runs on raises for each thing the User must
 * answer for that member, what an answer from any device says, and what the
 * member's device says came of it when it settles the card. Shared by the
 * devices and the server; nothing here imports Node. (What the phone shows
 * of a card is mobileControlCards.)
 *
 * Card ids are stable, so raising the same thing again is the same card: an
 * app-tool approval's card is the approval's id; a member's choice is
 * `choice:<message id>`; a member's mentions waiting for approval are
 * `mention:<message id>`.
 */

import { APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_ROSTER_REQUEST_CHANGE_TOOL } from "./appMcpToolContracts";
import type { HubCardKind } from "./hubOps";
import { approvalHasCard } from "./mobileControlCards";
import { stableJson } from "./stableJson";
import type {
  ChatAppToolApproval,
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatCardRefusal,
  ChatMessage,
  ChatPendingChoice,
  ChatPendingMention,
  Conversation
} from "./types";

export function choiceCardId(messageId: string): string {
  return `choice:${messageId}`;
}

export function mentionCardId(messageId: string): string {
  return `mention:${messageId}`;
}

/** An answer the member's device could not apply, kept on the card it asked
 *  again so the device that sent it can say why (the phone matches its own
 *  operation id). */
export type HubCardRefusal = ChatCardRefusal;

/** A permission or roster card: the approval the desktop card is built from. */
export interface HubApprovalCardPayload {
  approval: ChatAppToolApproval;
  refusals?: HubCardRefusal[];
}

/** A member's choice: the choice as its message holds it (refusals included). */
export interface HubChoiceCardPayload {
  choice: ChatPendingChoice;
  sourceMessageId: string;
}

/** Mentions in a member's message waiting for the User's approval. */
export interface HubMentionCardPayload {
  mentions: ChatPendingMention[];
  sourceMessageId: string;
  continuationRequested?: boolean;
  refusals?: HubCardRefusal[];
}

/** The User's answer to a permission or roster card. `auto` is the member's
 *  own device saying its member's policy allowed it (no User answer). */
export interface HubApprovalCardAnswer {
  approve: boolean;
  scope?: ChatAppToolApprovalScope;
  codexDecisionId?: string;
  draftOverride?: ChatAppToolApprovalRequest;
  auto?: boolean;
}

export interface HubChoiceCardAnswer {
  selectedOptionId?: string;
  customAnswer?: string;
  note?: string;
  cancel?: boolean;
}

export interface HubMentionCardAnswer {
  approve: boolean;
  targetParticipantIds: string[];
  continueRequester?: boolean;
}

/**
 * What came of a card, as its device settles it:
 * - `applied`: the answer was applied;
 * - `closed`: the card went without the answer being applied (the turn it
 *   waited in ended, a newer turn superseded it, it was withdrawn);
 * - `refused`: the answer was not applied, the card is asked again;
 * - `uncertain`: the answer reached the point of no return before this
 *   device could confirm it (it stopped meanwhile); it is not repeated.
 * The final state of what it asked travels with it, for the devices that show it.
 */
export interface HubCardOutcome {
  result: "applied" | "closed" | "refused" | "uncertain";
  reason?: string;
  /** The answer it refused (its operation id on the server), when known. */
  answerOpId?: string;
  approval?: ChatAppToolApproval;
  choice?: ChatPendingChoice;
  mentions?: ChatPendingMention[];
}

/** A card a device holds for one of its own members, as it raises it. */
export interface WantedHubCard {
  cardId: string;
  conversationId: string;
  cardKind: HubCardKind;
  /** The member it waits on (a card always names one). */
  participantId: string;
  messageId?: string;
  card: Record<string, unknown>;
  /** What it shows, to tell a change while it waits. */
  digest: string;
  /** The member's device decided it itself (an approval its member's policy
   *  allowed): it answers it at once. */
  selfAnswer?: HubApprovalCardAnswer;
  /** Answered already (a roster change the User approved, waiting to be
   *  made): its card is kept open until it is made, never raised again as
   *  a question. */
  keepOnly?: boolean;
}

/** Fields only one device keeps on an approval (the desktop's view of a
 *  machine's card): never part of what a card shows. */
const LOCAL_APPROVAL_KEYS = ["machineDecisionPending", "machineDecisionReceiptId", "machineAppliedDecisionId", "rosterChangeSettledAt", "cardRefusals"] as const;

export function approvalForCard(approval: ChatAppToolApproval): ChatAppToolApproval {
  const copy = { ...approval } as Record<string, unknown>;
  for (const key of LOCAL_APPROVAL_KEYS) delete copy[key];
  return copy as unknown as ChatAppToolApproval;
}

/** What a card shows, to tell a change while it waits: the same for the
 *  card a device raises and the one the server holds. A decided approval's
 *  waiting state is not a change of what it asks. */
export function hubCardDigest(cardKind: HubCardKind, card: Record<string, unknown>): string {
  if (cardKind === "permission" || cardKind === "roster") {
    const payload = card as unknown as HubApprovalCardPayload;
    if (payload.approval && typeof payload.approval === "object") {
      return stableJson({ ...payload, approval: { ...approvalForCard(payload.approval), status: "pending", updatedAt: "" } });
    }
  }
  return stableJson(card);
}

/** A change to who is in the chat: its card is a roster card. */
export function isRosterApproval(approval: Pick<ChatAppToolApproval, "toolName">): boolean {
  return approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL || approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL;
}

export function approvalCardKind(approval: Pick<ChatAppToolApproval, "toolName">): HubCardKind {
  return isRosterApproval(approval) ? "roster" : "permission";
}

/** The pending mentions of a message, when it waits on the User for them. */
export function pendingMentionsOf(message: ChatMessage): ChatPendingMention[] {
  const mentions = Array.isArray(message.metadata?.pendingMentions) ? message.metadata!.pendingMentions! : [];
  return mentions.filter((mention) => mention && mention.status === "pending");
}

/**
 * Every card the chat holds for members whose device this is: its pending
 * approvals (and approved roster changes not made yet), the choices its
 * members asked, and their mentions waiting for approval. `owns` says which
 * are this device's; a card names its member only while it is one of the
 * chat's members.
 */
export function wantedHubCards(
  conversation: Conversation,
  owns: { approval(approval: ChatAppToolApproval): boolean; message(message: ChatMessage): boolean }
): WantedHubCard[] {
  const members = new Set((Array.isArray(conversation.metadata?.participants) ? conversation.metadata.participants : [])
    .map((participant) => (participant as { id?: unknown })?.id).filter((id): id is string => typeof id === "string"));
  const cards: WantedHubCard[] = [];
  const approvals = Array.isArray(conversation.metadata?.pendingAppToolApprovals) ? conversation.metadata.pendingAppToolApprovals as ChatAppToolApproval[] : [];
  for (const approval of approvals) {
    if (!approval || typeof approval.id !== "string" || !approvalHasCard(approval) || !owns.approval(approval)) continue;
    if (!members.has(approval.requesterParticipantId)) continue;
    const payload: HubApprovalCardPayload = {
      approval: approvalForCard(approval),
      ...(approval.cardRefusals?.length ? { refusals: approval.cardRefusals } : {})
    };
    // Decided here without a card (its member's policy allowed it): what the
    // User sees is that it waits to be applied, never a question.
    const selfAnswer = approval.status === "auto-applied" ? { approve: true, auto: true } : undefined;
    const cardKind = approvalCardKind(approval);
    cards.push({
      cardId: approval.id, conversationId: conversation.id, cardKind, participantId: approval.requesterParticipantId,
      card: payload as unknown as Record<string, unknown>,
      digest: hubCardDigest(cardKind, payload as unknown as Record<string, unknown>),
      ...(selfAnswer ? { selfAnswer } : {}),
      ...(approval.status === "approved" ? { keepOnly: true } : {})
    });
  }
  for (const message of conversation.messages) {
    if (message.role !== "participant" || !message.participantId || !members.has(message.participantId)) continue;
    const choice = message.metadata?.pendingChoice;
    if (choice && choice.status === "pending" && owns.message(message)) {
      const payload: HubChoiceCardPayload = { choice, sourceMessageId: message.id };
      cards.push({
        cardId: choiceCardId(message.id), conversationId: conversation.id, cardKind: "choice", participantId: message.participantId, messageId: message.id,
        card: payload as unknown as Record<string, unknown>, digest: hubCardDigest("choice", payload as unknown as Record<string, unknown>)
      });
    }
    const mentions = pendingMentionsOf(message);
    if (mentions.length > 0 && owns.message(message)) {
      const refusals = message.metadata?.mentionCardRefusals;
      const payload: HubMentionCardPayload = {
        mentions, sourceMessageId: message.id,
        ...(message.metadata?.requesterContinuationRequested ? { continuationRequested: true } : {}),
        ...(Array.isArray(refusals) && refusals.length ? { refusals } : {})
      };
      cards.push({
        cardId: mentionCardId(message.id), conversationId: conversation.id, cardKind: "mention", participantId: message.participantId, messageId: message.id,
        card: payload as unknown as Record<string, unknown>, digest: hubCardDigest("mention", payload as unknown as Record<string, unknown>)
      });
    }
  }
  return cards;
}

/** What a resolved card's device says came of it, from what the chat holds
 *  now; `closed` when it holds nothing of it any more. */
export function hubCardOutcomeFrom(conversation: Conversation | undefined, cardId: string, result: HubCardOutcome["result"] = "applied"): HubCardOutcome {
  if (!conversation) return { result: "closed", reason: "The chat is gone." };
  if (cardId.startsWith("choice:") || cardId.startsWith("mention:")) {
    const messageId = cardId.slice(cardId.indexOf(":") + 1);
    const message = conversation.messages.find((item) => item.id === messageId);
    if (!message) return { result: "closed", reason: "The message that asked it is gone." };
    if (cardId.startsWith("choice:")) {
      const choice = message.metadata?.pendingChoice;
      if (!choice) return { result: "closed" };
      const { refusals: _refusals, ...shown } = choice;
      return { result, choice: shown };
    }
    return { result, mentions: Array.isArray(message.metadata?.pendingMentions) ? message.metadata!.pendingMentions! : [] };
  }
  const approvals = Array.isArray(conversation.metadata?.pendingAppToolApprovals) ? conversation.metadata.pendingAppToolApprovals as ChatAppToolApproval[] : [];
  const approval = approvals.find((item) => item?.id === cardId);
  if (!approval) return { result: "closed", reason: "The request is gone." };
  return { result, approval: approvalForCard(approval) };
}

export function isHubApprovalCardAnswer(value: unknown): value is HubApprovalCardAnswer {
  const answer = value as Partial<HubApprovalCardAnswer> | undefined;
  return Boolean(answer) && typeof answer!.approve === "boolean" &&
    (answer!.scope === undefined || answer!.scope === "once" || answer!.scope === "chat") &&
    (answer!.codexDecisionId === undefined || typeof answer!.codexDecisionId === "string");
}

export function isHubMentionCardAnswer(value: unknown): value is HubMentionCardAnswer {
  const answer = value as Partial<HubMentionCardAnswer> | undefined;
  return Boolean(answer) && typeof answer!.approve === "boolean" && Array.isArray(answer!.targetParticipantIds) &&
    answer!.targetParticipantIds.every((id) => typeof id === "string");
}
