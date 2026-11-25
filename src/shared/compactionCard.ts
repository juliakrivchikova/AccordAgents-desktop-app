import { APP_CHAT_REQUEST_COMPACTION_TOOL } from "./appMcpToolContracts";
import type { ChatAppToolApproval, ChatAppToolApprovalScope, ChatSelfCompactionRequest } from "./types";

/**
 * The card a member raises when it asks to compact its own conversation
 * (`app_chat_request_compaction`), in the words of the mockup the User
 * approved on 2026-11-22. The desktop card and the phone's card say exactly
 * these words.
 *
 * Compact is "allow once"; Compact with the box ticked is "always allow" this
 * member to compact in this chat (scope "chat"); Not now declines. There is
 * no "tell it what to do differently": she writes an ordinary message.
 */
export const COMPACTION_CARD_TITLE = "Compact the conversation?";
export const COMPACTION_CARD_SENTENCE =
  "After this reply the older part of the conversation is replaced by a short summary, and work continues from it.";
export const COMPACTION_CARD_KEEPS = "Summary keeps:";
export const COMPACTION_CARD_CHAT_SCOPE = "Don't ask again in this chat";
export const COMPACTION_CARD_COMPACT = "Compact";
export const COMPACTION_CARD_NOT_NOW = "Not now";
/** What the folded card is about, beside how it ended. */
export const COMPACTION_CARD_USED_PREVIEW = "Compact the conversation";

/** The meter's name for a screen reader; its value is the meter's words. */
export const COMPACTION_CARD_METER_NAME = "Context used";

/** The meter's words for a known figure. */
export function compactionMeterLabel(percentage: number): string {
  return `${percentage}% of context used`;
}

/** The figure the card's meter shows: the member's context indicator as it
 *  stood when it asked, a whole percentage; undefined (no meter) when the
 *  indicator had no figure. */
export function compactionCardPercentage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : undefined;
}

/** The compaction a card asks for, as both the desktop and the phone read
 *  it: undefined for any other approval. */
export function selfCompactionRequestOf(approval: Pick<ChatAppToolApproval, "toolName" | "request">): ChatSelfCompactionRequest | undefined {
  const request = approval.request as Partial<ChatSelfCompactionRequest> | undefined;
  if (approval.toolName !== APP_CHAT_REQUEST_COMPACTION_TOOL || request?.type !== "self_compaction" ||
      (request.instructions !== undefined && typeof request.instructions !== "string")) {
    return undefined;
  }
  const instructions = request.instructions?.trim() || undefined;
  const contextPercentage = compactionCardPercentage(request.contextPercentage);
  return {
    type: "self_compaction",
    ...(instructions ? { instructions } : {}),
    ...(contextPercentage !== undefined ? { contextPercentage } : {})
  };
}

/** How an answered compaction card ends, in the folded line's words. */
export function compactionCardEnding(
  approval: Pick<ChatAppToolApproval, "status" | "error"> & { approvalScope?: ChatAppToolApprovalScope }
): { ended: string; detail?: string } {
  const detail = approval.error?.trim() || undefined;
  if (approval.status === "approved" || approval.status === "auto-applied") {
    return {
      ended: approval.approvalScope === "chat" ? `${COMPACTION_CARD_COMPACT} · ${COMPACTION_CARD_CHAT_SCOPE}` : COMPACTION_CARD_COMPACT,
      ...(detail ? { detail } : {})
    };
  }
  if (approval.status === "denied") {
    // Refused by the app (the member left, a compaction already queued):
    // said with why, never as her Not now.
    return detail ? { ended: "Not compacted", detail } : { ended: COMPACTION_CARD_NOT_NOW };
  }
  if (approval.status === "expired") return { ended: "Expired", ...(detail ? { detail } : {}) };
  return { ended: "Cancelled", ...(detail ? { detail } : {}) };
}
