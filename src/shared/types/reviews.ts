import type { Conversation, ConversationKind } from "./conversations";
import type { ParticipantConfig } from "./providers";
import type { GitDiffMode } from "./repositories";

export type FindingSeverity = "Critical" | "High" | "Medium" | "Low" | "Info";

export type FindingStatus = "Confirmed" | "Rejected" | "Unresolved";

export type DebateStance = "confirmed" | "rejected" | "unclear" | "originator-rebuttal" | "final-resolution";

export interface ReviewRequest {
  runId?: string;
  kind: ConversationKind;
  question: string;
  repoPath?: string;
  diffMode?: GitDiffMode;
  baseBranch?: string;
  compareBranch?: string;
  commit?: string;
  pastedDiff?: string;
  participants: ParticipantConfig[];
  arbiter?: ParticipantConfig;
  roundLimit: number;
}

export interface PlanDecisionOption {
  id: string;
  label: string;
  description?: string;
}

export interface PlanDecisionRequest {
  id: string;
  title: string;
  question: string;
  impact: string;
  options: PlanDecisionOption[];
  recommendedOptionId?: string;
  sourceParticipantIds: string[];
  sourceParticipantLabels: string[];
  createdAt: string;
}

export interface PlanDecisionAnswer {
  decisionId: string;
  decisionKey?: string;
  selectedOptionId?: string;
  answer: string;
  answerSource?: "user" | "automatic";
  sourceDecisionId?: string;
}

export interface PlanDecisionReply {
  id: string;
  decisionId: string;
  role: "user" | "participant" | "system";
  participantId?: string;
  participantLabel?: string;
  content: string;
  createdAt: string;
  status?: "done" | "error";
  answerSource?: "automatic";
  sourceDecisionId?: string;
}

export interface PlanItemReview {
  findingId: string;
  status: "confirmed" | "commented";
  comment?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanItemReviewRequest {
  conversationId: string;
  findingId: string;
  confirmed?: boolean;
  comment?: string;
}

export interface ComposeImplementationPlanRequest {
  conversationId: string;
  runId?: string;
}

export interface RetryImplementationPlanSynthesisRequest {
  conversationId: string;
  runId?: string;
}

export interface RecoverImplementationPlanRequest {
  conversationId: string;
  runId?: string;
}

export interface ReviseImplementationPlanRequest {
  conversationId: string;
  instruction: string;
  runId?: string;
}

export interface ContinueReviewRequest {
  conversationId: string;
  runId?: string;
  answers: PlanDecisionAnswer[];
}

export interface PlanDecisionClarificationRequest {
  conversationId: string;
  decisionId: string;
  question: string;
  runId?: string;
}

export interface DebateRound {
  id: string;
  roundIndex: number;
  participantId: string;
  participantLabel: string;
  stance: DebateStance;
  severity?: FindingSeverity;
  content: string;
  createdAt: string;
}

export interface FindingSourceItem {
  participantId: string;
  participantLabel: string;
  title: string;
  claim: string;
  evidence: string;
  action: string;
  rawContent?: string;
}

export interface Finding {
  id: string;
  title: string;
  description: string;
  sourceParticipantId: string;
  sourceParticipantLabel: string;
  sourceParticipantIds?: string[];
  sourceParticipantLabels?: string[];
  includedParticipantIds?: string[];
  missingParticipantIds?: string[];
  claim?: string;
  evidence?: string;
  action?: string;
  sourceItems?: FindingSourceItem[];
  severity: FindingSeverity;
  status: FindingStatus;
  rounds: DebateRound[];
  createdAt?: string;
}

export interface StartReviewResult {
  conversation: Conversation;
  warnings: string[];
  pendingDecisions?: PlanDecisionRequest[];
}
