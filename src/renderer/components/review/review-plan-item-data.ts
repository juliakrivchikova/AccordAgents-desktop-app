import type {
  Conversation,
  Finding,
  PlanItemReview
} from "../../../shared/types";
import { metadataString } from "./review-common-data";
import { pendingPlanDecisions } from "./review-plan-decision-data";

export function hasFallbackFinalPlan(conversation: Conversation): boolean {
  const source = metadataString(conversation.metadata.implementationPlanSynthesisSource);
  if (source === "fallback") {
    return true;
  }
  if (source === "arbiter") {
    return false;
  }
  const warnings = Array.isArray(conversation.metadata.warnings)
    ? conversation.metadata.warnings.filter((item): item is string => typeof item === "string")
    : [];
  return warnings.some((warning) => {
    const normalized = warning.toLowerCase();
    return normalized.includes("used local summary fallback") || normalized.includes("could not synthesize the final implementation plan");
  });
}

export function pendingPlanItemReview(conversation: Conversation | undefined): boolean {
  return conversation?.kind === "implementation-plan" && conversation.metadata.pendingPlanItemReview === true;
}

export function timelineFindings(conversation: Conversation): Finding[] {
  if (conversation.kind === "implementation-plan") {
    const actionIds = new Set(requiredPlanItemReviewFindings(conversation).map((finding) => finding.id));
    return conversation.findings.filter((finding) => actionIds.has(finding.id));
  }
  return conversation.findings;
}

export function hasFinalImplementationPlan(conversation: Conversation | undefined): boolean {
  if (!conversation || conversation.kind !== "implementation-plan") {
    return false;
  }
  if (!conversation.findings.some((finding) => finding.status === "Confirmed")) {
    return false;
  }
  return Boolean(
    metadataString(conversation.metadata.implementationPlanFinalMarkdown) ||
    conversation.finalSummary?.trim() ||
    conversation.messages.some((message) => message.role === "summary" && message.content.trim())
  );
}

export function canRecoverImplementationPlan(conversation: Conversation | undefined, busy: boolean): boolean {
  if (busy || !conversation || conversation.kind !== "implementation-plan") {
    return false;
  }
  if (pendingPlanDecisions(conversation).length > 0 || pendingPlanItemReview(conversation)) {
    return false;
  }
  const hasStoredPlan = Boolean(
    metadataString(conversation.metadata.implementationPlanFinalMarkdown) ||
    conversation.finalSummary?.trim() ||
    conversation.messages.some((message) => message.role === "summary" && message.content.trim())
  );
  if (hasStoredPlan) {
    return false;
  }
  const request = conversation.metadata.implementationPlanRequest;
  return Boolean(request && typeof request === "object");
}

export function planItemReviews(conversation: Conversation | undefined): PlanItemReview[] {
  const value = conversation?.metadata.planItemReviews;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanItemReview => {
    const review = item as Partial<PlanItemReview>;
    return (
      typeof review.findingId === "string" &&
      (review.status === "confirmed" || review.status === "commented") &&
      typeof review.createdAt === "string" &&
      typeof review.updatedAt === "string" &&
      (review.comment === undefined || typeof review.comment === "string")
    );
  });
}

export function requiredPlanItemReviewFindings(conversation: Conversation | undefined): Finding[] {
  if (!conversation || !pendingPlanItemReview(conversation)) {
    return [];
  }
  return conversation.findings.filter((finding) => finding.status === "Confirmed" && planItemRequiresReview(finding));
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

export function firstPendingPlanItemReview(conversation: Conversation | undefined): Finding | undefined {
  const reviews = planItemReviews(conversation);
  return requiredPlanItemReviewFindings(conversation).find((finding) => !planItemReviewForFinding(finding, reviews));
}

function planItemRequiresReview(finding: Finding): boolean {
  return finding.rounds.some((round) => round.stance !== "confirmed");
}
