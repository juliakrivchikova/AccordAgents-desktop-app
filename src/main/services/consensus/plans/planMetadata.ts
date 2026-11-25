import { randomUUID } from "node:crypto";
import type {
  Conversation, Finding, ParticipantConfig, PlanDecisionAnswer, PlanDecisionReply, PlanDecisionRequest, PlanItemReview,
  ReviewRequest
} from "../../../../shared/types";
import { DEFAULT_NOTICE_CHARS, sanitizeWarningList } from "../../../../shared/warnings";
import { MAX_VERIFIERS_PER_POINT } from "../constants";
import { decisionAnswerKey } from "../points/lineProtocol";
import { isCliParticipant } from "../runs/cliSessions";
import type { RawImplementationPlan } from "../types";

const MAX_STORED_WARNING_CHARS = DEFAULT_NOTICE_CHARS;

export function clarificationTargets(request: ReviewRequest, decision: PlanDecisionRequest): ParticipantConfig[] {
  const sourceIds = new Set(decision.sourceParticipantIds);
  const sources = request.participants.filter((participant) => sourceIds.has(participant.id) && isCliParticipant(participant));
  const fallback = request.participants.filter((participant) => isCliParticipant(participant));
  return (sources.length ? sources : fallback).slice(0, MAX_VERIFIERS_PER_POINT);
}

export function planDecisionReply(
  decisionId: string,
  role: PlanDecisionReply["role"],
  content: string,
  participant?: ParticipantConfig,
  status: PlanDecisionReply["status"] = "done",
  metadata: Pick<PlanDecisionReply, "answerSource" | "sourceDecisionId"> = {}
): PlanDecisionReply {
  return {
    id: randomUUID(),
    decisionId,
    role,
    participantId: participant?.id,
    participantLabel: participant?.label,
    content,
    createdAt: new Date().toISOString(),
    status,
    ...metadata
  };
}

export function serializeReviewRequest(request: ReviewRequest): ReviewRequest {
  return {
    ...request,
    participants: request.participants.map((participant) => ({ ...participant })),
    arbiter: request.arbiter ? { ...request.arbiter } : undefined
  };
}

export function implementationPlanRequestFromMetadata(conversation: Conversation): ReviewRequest | undefined {
  const value = conversation.metadata.implementationPlanRequest;
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const request = value as ReviewRequest;
  return request.kind === "implementation-plan" ? request : undefined;
}

export function implementationPlanAnswersFromMetadata(conversation: Conversation): PlanDecisionAnswer[] {
  const value = conversation.metadata.implementationPlanAnswers;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanDecisionAnswer => {
    const candidate = item as Partial<PlanDecisionAnswer>;
    return typeof candidate.decisionId === "string" && typeof candidate.answer === "string";
  });
}

export function rawImplementationPlansFromMetadata(conversation: Conversation): RawImplementationPlan[] {
  const value = conversation.metadata.implementationPlanRawPlans;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is RawImplementationPlan => {
    const candidate = item as Partial<RawImplementationPlan>;
    return (
      typeof candidate.participantId === "string" &&
      typeof candidate.participantLabel === "string" &&
      typeof candidate.content === "string" &&
      candidate.content.trim().length > 0 &&
      typeof candidate.createdAt === "string"
    );
  });
}

export function pendingDecisionsFromMetadata(conversation: Conversation): PlanDecisionRequest[] {
  const value = conversation.metadata.pendingDecisions;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanDecisionRequest => {
    const candidate = item as Partial<PlanDecisionRequest>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.title === "string" &&
      typeof candidate.question === "string" &&
      Array.isArray(candidate.options)
    );
  });
}

export function planDecisionRequestsFromMetadata(conversation: Conversation): PlanDecisionRequest[] {
  const value = conversation.metadata.planDecisionRequests;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanDecisionRequest => {
    const candidate = item as Partial<PlanDecisionRequest>;
    return typeof candidate.id === "string" && typeof candidate.question === "string" && Array.isArray(candidate.options);
  });
}

export function mergePlanDecisionRequests(existing: PlanDecisionRequest[], next: PlanDecisionRequest[]): PlanDecisionRequest[] {
  const merged = new Map<string, PlanDecisionRequest>();
  for (const decision of [...existing, ...next]) {
    if (decision.id && decision.question.trim()) {
      merged.set(decision.id, decision);
    }
  }
  return Array.from(merged.values());
}

export function planDecisionRepliesFromMetadata(conversation: Conversation): PlanDecisionReply[] {
  const value = conversation.metadata.planDecisionReplies;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanDecisionReply => {
    const candidate = item as Partial<PlanDecisionReply>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.decisionId === "string" &&
      typeof candidate.role === "string" &&
      typeof candidate.content === "string" &&
      typeof candidate.createdAt === "string"
    );
  });
}

export function planItemReviewsFromMetadata(conversation: Conversation): PlanItemReview[] {
  const value = conversation.metadata.planItemReviews;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanItemReview => {
    const candidate = item as Partial<PlanItemReview>;
    const status = candidate.status;
    return (
      typeof candidate.findingId === "string" &&
      (status === "confirmed" || status === "commented") &&
      typeof candidate.createdAt === "string" &&
      typeof candidate.updatedAt === "string" &&
      (candidate.comment === undefined || typeof candidate.comment === "string")
    );
  });
}

export function requiredPlanItemReviewFindings(conversation: Conversation): Finding[] {
  return conversation.findings.filter((finding) => finding.status === "Confirmed" && planItemRequiresReview(finding));
}

function planItemRequiresReview(finding: Finding): boolean {
  return finding.rounds.some((round) => round.stance !== "confirmed");
}

export function planItemReviewForFinding(finding: Finding, reviews: PlanItemReview[]): PlanItemReview | undefined {
  const review = reviews.find((item) => item.findingId === finding.id);
  if (!review) {
    return undefined;
  }
  if (review.status === "confirmed") {
    return review;
  }
  return review.comment?.trim() ? review : undefined;
}

export function mergeDecisionAnswers(existing: PlanDecisionAnswer[], next: PlanDecisionAnswer[]): PlanDecisionAnswer[] {
  const merged = new Map<string, PlanDecisionAnswer>();
  for (const answer of [...existing, ...next]) {
    if (answer.decisionId && answer.answer.trim()) {
      const normalized = { ...answer, answer: answer.answer.trim(), decisionKey: decisionAnswerKey(answer) || undefined };
      merged.set(normalized.decisionId, normalized);
    }
  }
  return Array.from(merged.values());
}

export function metadataText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function metadataWarnings(conversation: Conversation): string[] {
  return sanitizeWarningList(conversation.metadata.warnings, MAX_STORED_WARNING_CHARS);
}

export function metadataNumber(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;
}

export function hasStoredImplementationPlan(conversation: Conversation): boolean {
  return Boolean(
    metadataText(conversation.metadata.implementationPlanFinalMarkdown) ||
    conversation.finalSummary?.trim() ||
    conversation.messages.some((message) => message.role === "summary" && message.content.trim())
  );
}
