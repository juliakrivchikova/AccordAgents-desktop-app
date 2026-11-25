import type {
  ChatMessage, ChatParticipant, ChatParticipantRequestApprovalRequest, ChatParticipantRequestBatch
} from "../../../../shared/types";

export type InferredParticipantRequestSuppressionScope =
  | "tool-source-segment"
  | "final-source-tool-origin-run"
  | "final-source-tool-origin-segment";

export interface PreparedParticipantRequest {
  request: ChatParticipantRequestApprovalRequest;
  requester: ChatParticipant;
  targets: ChatParticipant[];
  batch: ChatParticipantRequestBatch;
  requestMessage: ChatMessage;
  summary: string;
  timeoutMs: number;
}

export interface ParticipantRequestRunResult {
  batch: ChatParticipantRequestBatch;
  replies: Array<{
    targetHandle: string;
    messageId?: string;
    content?: string;
    error?: string;
  }>;
}
