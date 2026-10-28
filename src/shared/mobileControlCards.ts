/**
 * The cards a phone shows: a permission a member is waiting on, and a choice it
 * asked the User to make.
 *
 * Requirement 1 of docs/parity-requirements.md is that a participant behaves
 * the same wherever it runs, and the resolution extends that to the device the
 * User answers from. So the phone is given the same data the desktop card is
 * built from - the same summary, the same options, the same native identifiers
 * that have to travel back with the answer - rather than a simplified copy it
 * could answer differently.
 *
 * Nothing here decides anything. It is a projection of what the conversation
 * already holds, so a card cannot exist on the phone that does not exist on the
 * machine that raised it.
 */

import type { ChatAppToolApproval, ChatChoiceOption, ChatMessage, ChatParticipantRemovalRequest, ChatPendingChoice, Conversation } from "./types";
import { APP_PARTICIPANTS_REQUEST_CHANGE_TOOL } from "./appMcpToolContracts";
import type { HubCard } from "./hubOps";
import { approvalInstallsScriptCode } from "./scripts";

export type MobileControlCardKind = "permission" | "choice";

export interface MobileControlCard {
  id: string;
  kind: MobileControlCardKind;
  conversationId: string;
  title: string;
  /** What is being asked, in the words the desktop uses. */
  summary: string;
  requesterLabel?: string;
  /** The machine whose member raised it, when it is not this one. */
  machineName?: string;
  options: ChatChoiceOption[];
  /** The option the member recommends, marked and picked up front the way
   *  the desktop card does. */
  recommendedOptionId?: string;
  /** A choice may be answered in free text as well as by option. */
  allowsCustomAnswer: boolean;
  allowsCancel: boolean;
  status: "pending" | "answered";
  /** Answered, and what was approved has not happened yet (a member removal
   *  waits for running turns and for the desktop to apply it): shown where a
   *  pending card is, without buttons, until it has. */
  waiting?: boolean;
  /** What was decided, once it has been. */
  outcome?: string;
  createdAt: string;
  /** Carried back unchanged with the answer: the native provider needs them. */
  codexDecisionId?: string;
  draftOverride?: unknown;
  /** The message a choice belongs to; the answer names it. */
  sourceMessageId?: string;
  /** Answers to a still pending choice that were refused, named by the
   *  operation id each was sent under, so the phone that sent one stops waiting. */
  refusedAnswers?: Array<{ operationId: string; reason: string }>;
}

const ALLOW = { id: "allow", label: "Allow" };
const DENY = { id: "deny", label: "Deny" };

/** A member as the desktop card names it: the Chat Assistant by that name,
 *  any other member by its handle (chatParticipantReference). */
function memberReference(handle: string): string {
  const normalized = handle.trim().replace(/^@/, "");
  const lower = normalized.toLowerCase();
  return lower === "assistant" || lower === "admin" ? "Chat Assistant" : `@${normalized}`;
}

/** "@a", "@a and @b", "@a, @b, and @c" -- as the desktop card says it. */
function handleList(handles: string[]): string {
  const named = handles.map(memberReference);
  if (named.length <= 1) return named[0] ?? "";
  if (named.length === 2) return `${named[0]} and ${named[1]}`;
  return `${named.slice(0, -1).join(", ")}, and ${named[named.length - 1]}`;
}

function removalRequest(approval: ChatAppToolApproval): ChatParticipantRemovalRequest | undefined {
  const request = approval.request as Partial<ChatParticipantRemovalRequest> | undefined;
  return approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL && request?.kind === "participant_removal" &&
    Array.isArray(request.operations) && request.operations.length > 0 &&
    request.operations.every((operation) => typeof operation?.handle === "string" && typeof operation.participantId === "string")
    ? request as ChatParticipantRemovalRequest
    : undefined;
}

/** Whether a card should be shown for this approval: one that asks, and an
 *  approved roster change that has not happened yet. */
export function approvalHasCard(approval: ChatAppToolApproval): boolean {
  return approval.status === "pending" ||
    (approval.status === "approved" && typeof approval.memberRemovalQueuedAt === "string") ||
    ((approval.status === "approved" || approval.status === "auto-applied") && typeof approval.memberAdditionQueuedAt === "string");
}

/** The card for one app-tool approval, in exactly the shape the desktop card
 *  is built from. Pending ones are shown, and an approved roster change until
 *  it has happened (approvalHasCard); an answered approval has no record the
 *  phone keeps. */
export function controlCardFromApproval(conversationId: string, approval: ChatAppToolApproval): MobileControlCard {
  const removal = removalRequest(approval);
  if (removal) {
    // The desktop's removal card, word for word: who asks, who leaves, what
    // happens, and the two answers it offers.
    const handles = handleList(removal.operations.map((operation) => operation.handle));
    const one = removal.operations.length === 1;
    const requester = handleList([approval.requesterHandle]);
    const base = {
      id: approval.id,
      kind: "permission" as const,
      conversationId,
      requesterLabel: requester,
      machineName: (approval as { machineName?: string }).machineName,
      allowsCustomAnswer: false,
      allowsCancel: false,
      createdAt: approval.createdAt
    };
    if (approval.status === "approved" && typeof approval.memberRemovalQueuedAt === "string") {
      // The desktop's waiting result, with what the phone cannot see: it
      // cannot tell whether the Mac, which applies it, is on.
      return {
        ...base,
        title: "Removal approved",
        summary: "",
        options: [],
        status: "answered",
        waiting: true,
        outcome: `Waiting for running turns to finish and for your Mac to apply it, then ${handles} ${one ? "leaves" : "leave"} this chat.`
      };
    }
    return {
      ...base,
      title: `${requester} wants to remove ${handles} from this chat`,
      summary: `${one ? "Its" : "Their"} session in this chat ends and open requests to or from ${one ? "it" : "them"} are cancelled. ` +
        `This happens once ${requester}'s turn has ended and no member is running.`,
      options: [{ id: "allow", label: `Yes, remove ${handles}` }, { id: "deny", label: `No, keep ${handles} in this chat` }],
      status: approval.status === "pending" ? "pending" : "answered",
      ...(approval.status === "pending" ? { draftOverride: approval.request } : {})
    };
  }
  if (approval.status !== "pending" && typeof approval.memberAdditionQueuedAt === "string") {
    return {
      id: approval.id,
      kind: "permission",
      conversationId,
      title: "Addition approved",
      summary: approval.summary || "",
      requesterLabel: approval.requesterHandle ? memberReference(approval.requesterHandle) : undefined,
      machineName: (approval as { machineName?: string }).machineName,
      options: [],
      allowsCustomAnswer: false,
      allowsCancel: false,
      status: "answered",
      waiting: true,
      outcome: "Waiting for your Mac to apply it.",
      createdAt: approval.createdAt
    };
  }
  // A script that installs code is approved where its code can be read: the
  // phone shows it as a card it may only decline.
  const desktopOnly = approvalInstallsScriptCode(approval);
  return {
    id: approval.id,
    kind: "permission",
    conversationId,
    title: desktopOnly ? `Approve on the desktop: ${approval.summary}` : approval.summary || "Permission request",
    summary: desktopOnly
      ? `${approval.summary}. The phone cannot show the script's code yet, so it is approved on the desktop. You can decline it here.`
      : approval.summary || "",
    requesterLabel: approval.requesterHandle ? `@${approval.requesterHandle}` : undefined,
    machineName: (approval as { machineName?: string }).machineName,
    options: desktopOnly ? [DENY] : [ALLOW, DENY],
    allowsCustomAnswer: false,
    allowsCancel: false,
    status: "pending",
    createdAt: approval.createdAt,
    // The native decision id the desktop card carries back with its answer.
    ...(typeof (approval as unknown as { codexDecisionId?: unknown }).codexDecisionId === "string"
      ? { codexDecisionId: (approval as unknown as { codexDecisionId: string }).codexDecisionId }
      : {}),
    ...(approval.request ? { draftOverride: approval.request } : {})
  };
}

/** The card for the choice a member asked in this message, answered or not;
 *  undefined when the message asks nothing. */
export function controlCardFromChoiceMessage(conversationId: string, message: ChatMessage): MobileControlCard | undefined {
  const choice = message.metadata?.pendingChoice;
  if (!choice) return undefined;
  return {
    id: choice.id,
    kind: "choice",
    conversationId,
    title: choice.title || "Choice",
    summary: choice.question || "",
    requesterLabel: message.participantLabel,
    options: choice.options ?? [],
    ...(choice.recommendedOptionId && choice.options?.some((option) => option.id === choice.recommendedOptionId)
      ? { recommendedOptionId: choice.recommendedOptionId }
      : {}),
    allowsCustomAnswer: true,
    allowsCancel: true,
    status: choice.status === "pending" ? "pending" : "answered",
    outcome: choice.status === "pending"
      ? undefined
      : choice.status === "cancelled"
        ? "Cancelled"
        : choice.options?.find((option) => option.id === choice.selectedOptionId)?.label
          ?? choice.customAnswer
          ?? "Answered",
    createdAt: message.createdAt,
    sourceMessageId: message.id,
    ...(choice.status === "pending" && choice.refusals?.length
      ? { refusedAnswers: choice.refusals.map((refusal) => ({ operationId: refusal.operationId, reason: refusal.reason })) }
      : {})
  };
}

/** What an answered card waits for: the member's own device applies it. */
export const HUB_CARD_ANSWERED_WAITING = "Waiting for it to be applied.";

/**
 * The card the phone shows for a card on the User's server (Д9): raised by
 * the device the member runs on, answered once from any device, settled by
 * the device that raised it. The card a device raises carries what the
 * desktop card is built from — an app-tool approval (a permission or a
 * roster change) or a member's pending choice with the message that asked
 * it — so the phone shows the very same card. Pending, it is answered on the
 * phone; answered, it shows the answer and waits for the member's device;
 * settled, it is not shown (a choice keeps its record under its message,
 * read from the message itself). The card's id is the server's card id: the
 * answer names it. Undefined for a card the phone cannot show.
 */
export function controlCardFromHubCard(card: HubCard, participantLabel?: (participantId: string) => string | undefined): MobileControlCard | undefined {
  if (card.state === "settled") return undefined;
  const raised = card.card as { approval?: ChatAppToolApproval; choice?: ChatPendingChoice; sourceMessageId?: unknown; refusals?: unknown };
  if ((card.cardKind === "permission" || card.cardKind === "roster") && raised.approval && typeof raised.approval === "object") {
    const pending = controlCardFromApproval(card.conversationId, { ...raised.approval, status: "pending" });
    const base: MobileControlCard = { ...pending, id: card.cardId, createdAt: raised.approval.createdAt || card.raisedAt };
    if (card.state === "pending") {
      // Answers the member's device could not apply, asked again (a phone's
      // approval of a script's code, say): the phone that sent one says why.
      const refused = Array.isArray(raised.refusals)
        ? raised.refusals.filter((item): item is { operationId: string; reason: string } =>
          Boolean(item) && typeof (item as { operationId?: unknown }).operationId === "string" && Boolean((item as { operationId: string }).operationId) &&
          typeof (item as { reason?: unknown }).reason === "string")
        : [];
      return refused.length ? { ...base, refusedAnswers: refused.map((item) => ({ operationId: item.operationId, reason: item.reason })) } : base;
    }
    const approve = card.answer?.approve === true;
    // An approved roster change waits as the desktop's card waits ("Removal
    // approved … then @x leaves this chat", "Addition approved").
    if (approve && (card.cardKind === "roster" || raised.approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL)) {
      const queuedAt = card.answeredAt ?? card.raisedAt;
      const waiting = controlCardFromApproval(card.conversationId, {
        ...raised.approval, status: "approved",
        ...(removalRequest(raised.approval) ? { memberRemovalQueuedAt: queuedAt } : { memberAdditionQueuedAt: queuedAt })
      });
      return { ...waiting, id: card.cardId, createdAt: base.createdAt };
    }
    const chosen = base.options.find((option) => option.id === (approve ? "allow" : "deny"));
    // A card that words its answers (a removal: "Yes, remove @x") says the
    // one given; a plain permission says Allowed or Denied.
    const said = chosen && chosen.label !== ALLOW.label && chosen.label !== DENY.label ? chosen.label : approve ? "Allowed" : "Denied";
    const { codexDecisionId: _decision, draftOverride: _draft, ...shown } = base;
    return { ...shown, options: [], status: "answered", waiting: true, outcome: `${said}. ${HUB_CARD_ANSWERED_WAITING}` };
  }
  if (card.cardKind === "choice" && raised.choice && typeof raised.choice === "object") {
    const sourceMessageId = typeof raised.sourceMessageId === "string" && raised.sourceMessageId ? raised.sourceMessageId : card.messageId;
    const message = {
      id: sourceMessageId ?? card.cardId,
      role: "participant",
      content: "",
      createdAt: card.raisedAt,
      ...(card.participantId ? { participantId: card.participantId } : {}),
      ...(card.participantId && participantLabel?.(card.participantId) ? { participantLabel: participantLabel(card.participantId) } : {}),
      metadata: { pendingChoice: { ...raised.choice, status: "pending" } }
    } as ChatMessage;
    const pending = controlCardFromChoiceMessage(card.conversationId, message);
    if (!pending) return undefined;
    const base: MobileControlCard = { ...pending, id: card.cardId, ...(sourceMessageId ? { sourceMessageId } : { sourceMessageId: undefined }) };
    if (card.state === "pending") return base;
    const answer = card.answer ?? {};
    const outcome = answer.cancel === true ? "Cancelled"
      : base.options.find((option) => option.id === answer.selectedOptionId)?.label
        ?? (typeof answer.customAnswer === "string" && answer.customAnswer ? answer.customAnswer : "Answered");
    const { refusedAnswers: _refused, ...shown } = base;
    return { ...shown, status: "answered", outcome };
  }
  return undefined;
}

export function controlCardsFromConversation(conversation: Conversation): MobileControlCard[] {
  const cards: MobileControlCard[] = [];
  const approvals = (conversation.metadata as { pendingAppToolApprovals?: ChatAppToolApproval[] } | undefined)
    ?.pendingAppToolApprovals ?? [];
  for (const approval of approvals) {
    if (!approvalHasCard(approval)) continue;
    cards.push(controlCardFromApproval(conversation.id, approval));
  }
  for (const message of conversation.messages) {
    const card = controlCardFromChoiceMessage(conversation.id, message);
    if (card) cards.push(card);
  }
  return cards;
}

/** True when two card sets would look identical on the phone, so an unchanged
 *  set is not re-sent on every snapshot. */
export function sameControlCards(left: readonly MobileControlCard[], right: readonly MobileControlCard[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
