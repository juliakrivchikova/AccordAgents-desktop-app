import type { ChatActivityItem, ChatAppToolApproval, ChatCodexApprovalRequest, Conversation } from "../../../shared/types";
import { isCodexActivityApprovalItem } from "../../../shared/chatActivity";

export const CODEX_APPROVAL_TOOL_NAME = "codex_auto_review_approval";

export interface ChatApprovalPlacement {
  byMessageId: Map<string, ChatAppToolApproval[]>;
  unanchored: ChatAppToolApproval[];
}

export function chatApprovalShowsGenericSkip(codexRequest: ChatCodexApprovalRequest | undefined): boolean {
  return codexRequest === undefined;
}

export function chatActivityShowsGenericCancel(item: ChatActivityItem): boolean {
  if (item.status !== "pending") return false;
  if (item.kind === "approval") {
    return !isCodexActivityApprovalItem(item) && Boolean(item.target.approvalId?.trim());
  }
  const sourceMessageId = item.target.sourceMessageId ?? item.target.messageId;
  if (item.kind === "choice") {
    return Boolean(sourceMessageId?.trim() && item.target.choiceId?.trim());
  }
  if (item.kind === "mention") {
    return Boolean(sourceMessageId?.trim() && item.target.mentionTargetParticipantIds?.length);
  }
  return false;
}

export type ChatApprovalKeyboardAction = { type: "select"; index: number } | { type: "submit" };

export function chatApprovalKeyboardAction(
  key: string,
  selectedIndex: number,
  optionCount: number
): ChatApprovalKeyboardAction | undefined {
  if (key === "Enter") return optionCount > 0 ? { type: "submit" } : undefined;
  if (key === "ArrowDown") return optionCount > 0
    ? { type: "select", index: Math.min(optionCount - 1, selectedIndex + 1) }
    : undefined;
  if (key === "ArrowUp") return optionCount > 0
    ? { type: "select", index: Math.max(0, selectedIndex - 1) }
    : undefined;
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    return index < optionCount ? { type: "select", index } : undefined;
  }
  return undefined;
}

/** Keep non-Codex approvals in the shared sticky slot and bind Codex cards to
 * the visible provider-output bubble with the same participant and run. */
export function chatApprovalPlacement(
  approvals: ChatAppToolApproval[],
  visibleMessages: Conversation["messages"]
): ChatApprovalPlacement {
  const messageByRunAndParticipant = new Map<string, Conversation["messages"][number]>();
  for (const message of visibleMessages) {
    const runId = message.metadata?.runId;
    if (message.role !== "participant" || !runId || !message.participantId) continue;
    messageByRunAndParticipant.set(`${message.participantId}:${runId}`, message);
  }
  const byMessageId = new Map<string, ChatAppToolApproval[]>();
  const unanchored: ChatAppToolApproval[] = [];
  for (const approval of approvals) {
    if (approval.toolName !== CODEX_APPROVAL_TOOL_NAME) {
      unanchored.push(approval);
      continue;
    }
    const runId = approval.resumeContext?.runId;
    const message = runId
      ? messageByRunAndParticipant.get(`${approval.requesterParticipantId}:${runId}`)
      : undefined;
    if (!message) {
      unanchored.push(approval);
      continue;
    }
    byMessageId.set(message.id, [...(byMessageId.get(message.id) ?? []), approval]);
  }
  return { byMessageId, unanchored };
}

export function chatCodexApprovalRequest(approval: ChatAppToolApproval): ChatCodexApprovalRequest | undefined {
  if (approval.toolName !== CODEX_APPROVAL_TOOL_NAME) return undefined;
  const request = approval.request as Partial<ChatCodexApprovalRequest>;
  return request.kind === "codexApproval" &&
    (typeof request.requestId === "string" || typeof request.requestId === "number") &&
    (
      request.action === "command" ||
      request.action === "fileChange" ||
      request.action === "permissions" ||
      request.action === "network" ||
      request.action === "mcpToolCall"
    ) &&
    Array.isArray(request.options) &&
    (request.method === "item/autoApprovalReview/timedOut" ? request.options.length === 0 : request.options.length > 0) &&
    request.options.every((option) =>
      typeof option?.id === "string" &&
      typeof option.label === "string" &&
      (option.detail === undefined || typeof option.detail === "string") &&
      (option.outcome === "approve" || option.outcome === "deny" || option.outcome === "cancel")
    )
    ? request as ChatCodexApprovalRequest
    : undefined;
}
