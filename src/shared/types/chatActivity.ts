import type { ChatProviderKind } from "./providers";

export type ChatActivityStatus = "pending" | "running" | "recent";

export type ChatActivityKind =
  | "approval"
  | "choice"
  | "mention"
  | "participant-request"
  | "run"
  | "message";

export interface ChatActivityParticipantSummary {
  id: string;
  handle: string;
  /** How the chat's view names it, when that is not its handle: in the
   *  sessions view a member's task title, "" for the main session (named by
   *  nothing there). */
  displayName?: string;
  kind: ChatProviderKind;
  roleConfigId?: string;
  avatarId?: string;
}

export interface ChatActivityTarget {
  runId?: string;
  messageId?: string;
  /**
   * The message is only a navigation anchor picked as a fallback, not a message this row is
   * actually about. Such a row must not claim that message against another row that is.
   */
  messageIsApproximate?: boolean;
  sourceMessageId?: string;
  threadRootId?: string;
  approvalId?: string;
  approvalKind?: "codex";
  choiceId?: string;
  mentionTargetParticipantIds?: string[];
}

export interface ChatActivityItem {
  id: string;
  conversationId: string;
  conversationTitle: string;
  repoPath?: string;
  status: ChatActivityStatus;
  read?: boolean;
  kind: ChatActivityKind;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  /** Finished updates from one member in one chat share a row; how many that row stands for. */
  groupedCount?: number;
  participant?: ChatActivityParticipantSummary;
  target: ChatActivityTarget;
}

export interface ListChatActivityRequest {
  limit?: number;
  recentConversationLimit?: number;
  recentWindowDays?: number;
  lastViewedAtByConversationId?: Record<string, string>;
  excludedItemIds?: string[];
  /** Per chat and member "cleared through" timestamps, so cleared updates stay cleared and uncounted. */
  clearedRecentThroughByGroup?: Record<string, string>;
  /** Frozen cutoff inherited from the pre-per-group clear state. */
  clearedRecentThroughBefore?: string;
}

export interface ListChatActivityResult {
  items: ChatActivityItem[];
  generatedAt: string;
}
