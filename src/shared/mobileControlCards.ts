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

import type { ChatAppToolApproval, ChatChoiceOption, Conversation } from "./types";

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
  /** A choice may be answered in free text as well as by option. */
  allowsCustomAnswer: boolean;
  allowsCancel: boolean;
  status: "pending" | "answered";
  /** What was decided, once it has been. */
  outcome?: string;
  createdAt: string;
  /** Carried back unchanged with the answer: the native provider needs them. */
  codexDecisionId?: string;
  draftOverride?: unknown;
  /** The message a choice belongs to; the answer names it. */
  sourceMessageId?: string;
}

const ALLOW = { id: "allow", label: "Allow" };
const DENY = { id: "deny", label: "Deny" };

export function controlCardsFromConversation(conversation: Conversation): MobileControlCard[] {
  const cards: MobileControlCard[] = [];
  const approvals = (conversation.metadata as { pendingAppToolApprovals?: ChatAppToolApproval[] } | undefined)
    ?.pendingAppToolApprovals ?? [];
  for (const approval of approvals) {
    if (approval.status !== "pending") continue;
    cards.push({
      id: approval.id,
      kind: "permission",
      conversationId: conversation.id,
      title: approval.summary || "Permission request",
      summary: approval.summary || "",
      requesterLabel: approval.requesterHandle ? `@${approval.requesterHandle}` : undefined,
      machineName: (approval as { machineName?: string }).machineName,
      options: [ALLOW, DENY],
      allowsCustomAnswer: false,
      allowsCancel: false,
      status: "pending",
      createdAt: approval.createdAt,
      // The native decision id the desktop card carries back with its answer.
      ...(typeof (approval as unknown as { codexDecisionId?: unknown }).codexDecisionId === "string"
        ? { codexDecisionId: (approval as unknown as { codexDecisionId: string }).codexDecisionId }
        : {}),
      ...(approval.request ? { draftOverride: approval.request } : {})
    });
  }
  for (const message of conversation.messages) {
    const choice = message.metadata?.pendingChoice;
    if (!choice) continue;
    cards.push({
      id: choice.id,
      kind: "choice",
      conversationId: conversation.id,
      title: choice.title || "Choice",
      summary: choice.question || "",
      requesterLabel: message.participantLabel,
      options: choice.options ?? [],
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
      sourceMessageId: message.id
    });
  }
  return cards;
}

/** True when two card sets would look identical on the phone, so an unchanged
 *  set is not re-sent on every snapshot. */
export function sameControlCards(left: readonly MobileControlCard[], right: readonly MobileControlCard[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
