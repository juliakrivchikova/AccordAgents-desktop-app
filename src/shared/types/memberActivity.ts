import type { ChatParticipantRosterStatus } from "../chatParticipantStatus";
import type { CloudRunStatus } from "./cloudRuns";
import type { ChatParticipantRequestStatus } from "./memberRequests";
import type { ChatRemoteRunPhase } from "./messages";
import type { ChatProviderKind } from "./providers";

export interface ChatParticipantActivityApprovalDependency {
  type: "user" | "participant";
  participantId?: string;
  handle?: string;
  summary?: string;
}

interface ChatParticipantActivityWorkBase {
  messageId?: string;
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
  startedAt: string;
  lastActivityAt: string;
  error?: string;
  approvalDependency?: ChatParticipantActivityApprovalDependency;
}

export interface ChatParticipantActivityRunWork extends ChatParticipantActivityWorkBase {
  kind: "run";
  status: CloudRunStatus;
  phase?: ChatRemoteRunPhase;
  runId: string;
}

export interface ChatParticipantActivityCompactionWork extends ChatParticipantActivityWorkBase {
  kind: "compaction";
  status: "running";
  phase: "compacting";
  runId: string;
}

export interface ChatParticipantActivityRequestWork extends ChatParticipantActivityWorkBase {
  kind: "participant_request";
  status: ChatParticipantRequestStatus;
  requestId: string;
}

export interface ChatParticipantActivityApprovalWork extends ChatParticipantActivityWorkBase {
  kind: "approval";
  status: "pending";
  approvalType: "app_tool" | "pending_choice" | "pending_mention";
  requestId?: string;
}

export type ChatParticipantActiveWork =
  | ChatParticipantActivityRunWork
  | ChatParticipantActivityCompactionWork
  | ChatParticipantActivityRequestWork
  | ChatParticipantActivityApprovalWork;

export interface ChatParticipantLastFinishedMessage {
  messageId: string;
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
  sequence: number;
  createdAt: string;
  status: "done" | "error";
  terminalReason?: string;
  content: string;
}

/** How full a member's context is, as its context indicator shows it. */
export interface ChatParticipantActivityContext {
  usedTokens: number;
  contextWindowTokens: number;
  percentage: number;
  /** When the figure was read. */
  measuredAt: string;
}

export interface ChatParticipantActivityEntry {
  participantId: string;
  handle: string;
  provider: ChatProviderKind;
  model: string | null;
  status: ChatParticipantRosterStatus;
  activeWork: ChatParticipantActiveWork[];
  lastFinishedMessage: ChatParticipantLastFinishedMessage | null;
  /** When the member's session last worked (its last reply's last activity,
   *  or a compaction of it), as near as the chat knows it: a CLI's prompt
   *  cache lives about an hour after that. Null when it never worked here. */
  lastTurnEndedAt: string | null;
  context: ChatParticipantActivityContext | null;
}

export interface ChatParticipantActivitySnapshot {
  snapshotAt: string;
  hasActiveParticipants: boolean;
  statusCounts: Record<ChatParticipantRosterStatus, number>;
  participants: ChatParticipantActivityEntry[];
}
