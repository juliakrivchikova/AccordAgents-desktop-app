import type { ChatProviderKind } from "./providers";

export interface ChatParticipantRequestInput {
  target: string;
  prompt: string;
  /** Its short title, set by the app only: an inferred request's is the
   *  reply's sentence that mentions the member (sessionsMentionSentenceTitle). */
  title?: string;
  reason?: string;
}

export interface ChatParticipantRequestApprovalRequest {
  reason?: string;
  requests: ChatParticipantRequestInput[];
  resumeRequester?: boolean;
  source?: ChatParticipantRequestSource;
  requestMessageId?: string;
  batchId?: string;
}

export type ChatParticipantRequestSource = "mcp" | "inferred";

export type ChatParticipantRequestStatus =
  | "pending_approval"
  | "running"
  | "answered"
  | "resuming_requester"
  | "completed"
  | "failed"
  | "denied"
  | "interrupted";

export interface ChatParticipantRequestItem {
  targetParticipantId: string;
  targetHandle: string;
  /** The target's provider when it was asked: a member removed later keeps
   *  its logo in the sessions view (sessionsFormerMembers). */
  targetKind?: ChatProviderKind;
  prompt: string;
  /** The main session's short title for its task (app_chat_delegate_task),
   *  as T3 Code titles a thread: the sessions view names the member by it.
   *  Without one the task's first sentence stands in (sessionsTaskTitle). */
  title?: string;
  reason?: string;
  status: ChatParticipantRequestStatus;
  replyMessageId?: string;
  /** What it wrote before, when it compacted its context in between and went
   *  on (replyMessageId is the last of them). */
  earlierReplyMessageIds?: string[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface ChatParticipantRequestBatch {
  id: string;
  requesterParticipantId: string;
  requesterHandle: string;
  source: ChatParticipantRequestSource;
  resumeRequester: boolean;
  status: ChatParticipantRequestStatus;
  depth: number;
  requesterDepth?: number;
  chainRootId?: string;
  createdAt: string;
  updatedAt: string;
  triggerMessageId?: string;
  /** The requester's turn that asked (its turnSegmentId): its own messages
   *  of that turn are not "going on" when a restart weighs resuming it. */
  requesterTurnSegmentId?: string;
  completedInToolCall?: boolean;
  autoResumeMessageId?: string;
  /** The main session's task to a member it made for it
   *  (app_chat_delegate_task): how the member started. Such a request is not
   *  held to the one-request-per-turn limit of app_chat_request_participants.
   *  `turnId`: the main-session turn that gave it; the tasks of one turn
   *  resume the main session once, when all of them have ended. */
  delegation?: { start: "clean" | "fork"; turnId?: string };
  items: ChatParticipantRequestItem[];
  error?: string;
}
