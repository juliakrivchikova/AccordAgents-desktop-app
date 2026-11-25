import type {
  Conversation, Finding, ParticipantConfig, PlanDecisionAnswer, PlanDecisionReply, PlanDecisionRequest, ReviewRequest
} from "../../../../shared/types";
import {
  implementationPlanAnswersFromMetadata, planItemReviewForFinding, planItemReviewsFromMetadata, requiredPlanItemReviewFindings
} from "../plans/planMetadata";
import { limitText } from "../runs/reviewRecords";
import type { RawImplementationPlan } from "../types";

export function buildDecisionDiscoveryPrompt(
  request: ReviewRequest,
  participant: ParticipantConfig,
  answers: PlanDecisionAnswer[]
): string {
  return [
    "You are one independent participant in an implementation-plan workflow.",
    "You are in plan mode. Inspect the repository read-only as needed, but do not edit files, run mutating commands, or ask interactive terminal questions.",
    "Before producing a plan, identify only blocking user decisions that materially change architecture, data model, scope, rollout, or compatibility.",
    "If no blocking decision is needed, return exactly: NO_DECISIONS",
    "If decisions are needed, return only compact decision blocks. Do not add prose, JSON, Markdown, bullets, or text outside the blocks.",
    "Use at most 3 decisions.",
    "Format:",
    "D1|T:short decision title",
    "Q:question the user must answer",
    "I:why this blocks the implementation plan",
    "O1:recommended option text",
    "O2:alternative option text",
    "R:O1",
    "Options must be mutually exclusive. Put the recommended option in R.",
    `Participant: ${participant.id} (${participant.label})`,
    answers.length ? `Existing decision-thread context:\n${formatDecisionAnswers(answers)}` : "Existing decision-thread context: none",
    `Repository: ${request.repoPath}`,
    request.question ? `User request:\n${request.question}` : "User request:\nCreate an implementation plan."
  ].join("\n\n");
}

export function buildAutomaticDecisionAnswerPrompt(decision: PlanDecisionRequest, answers: PlanDecisionAnswer[]): string {
  return [
    "You are the planner for implementation-plan decision threads.",
    "Decide whether the user's previous answers fully answer this separate agent decision request.",
    "Do not merge or rewrite the decision. Return YES only if the previous answer is enough for the agent to proceed without asking the user again.",
    "Return only this protocol:",
    "AUTO|V:YES|O:O1|SRC:decision-id",
    "A:short answer to apply to this target decision",
    "E:why the previous answer fully covers this target",
    "Or return:",
    "AUTO|V:NO",
    "E:why the target still needs direct user input",
    `Target decision:\nD|T:${decision.title}\nID:${decision.id}\nQ:${decision.question}\nI:${decision.impact}\n${decision.options.map((option) => `${option.id}:${option.label}`).join("\n")}`,
    `Previous answers:\n${formatDecisionAnswersForAutomaticReuse(answers)}`
  ].join("\n\n");
}

export function buildImplementationPlanPrompt(request: ReviewRequest, answers: PlanDecisionAnswer[], warnings: string[]): string {
  return [
    "You are one independent participant in an implementation-plan consensus workflow.",
    "You are in plan mode. Inspect the repository read-only as needed. Do not edit files, run mutating commands, or ask interactive questions.",
    "Produce an engineer-ready implementation plan for the user's requested feature, bug, or error log.",
    "Return the plan as natural Markdown in whatever structure best fits the task. Do not use a required template or machine protocol.",
    "Make it decision-complete for another engineer: include the intended approach, important interfaces/data flow, edge cases, and focused verification.",
    "Use repo-specific file names, modules, commands, and constraints where inspection supports them.",
    "Keep the plan concise enough to be scanned in the timeline, but do not omit important implementation decisions.",
    "If an unresolved blocker remains, state it clearly in the plan and explain what cannot be decided yet.",
    `Repository: ${request.repoPath}`,
    answers.length ? `User decision-thread context:\n${formatDecisionAnswers(answers)}` : "User decision-thread context: none",
    request.question ? `User request:\n${request.question}` : "User request:\nCreate an implementation plan.",
    limitText("Use repo inspection for file names and interfaces. Keep output concise.", warnings)
  ].join("\n\n");
}

export function buildDecisionClarificationPrompt(
  request: ReviewRequest,
  decision: PlanDecisionRequest,
  question: string,
  replies: PlanDecisionReply[]
): string {
  return [
    "You are replying inside an implementation-plan decision thread.",
    "You are in plan mode. Inspect the repository read-only if needed. Do not edit files, run mutating commands, or ask interactive terminal questions.",
    "Reply to the user's latest message directly and concisely. Do not choose for the user unless the answer is technically forced.",
    `Decision: ${decision.title}`,
    `Original question: ${decision.question}`,
    `Impact: ${decision.impact}`,
    `Options:\n${decision.options.map((option) => `${option.id}: ${option.label}`).join("\n")}`,
    `Thread so far:\n${formatDecisionRepliesForPrompt(replies.filter((reply) => reply.decisionId === decision.id))}`,
    `Latest user message:\n${question}`,
    `Repository: ${request.repoPath}`,
    request.question ? `Original user request:\n${request.question}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildImplementationPlanExtractionPrompt(
  request: ReviewRequest,
  participants: ParticipantConfig[],
  rawPlans: RawImplementationPlan[],
  warnings: string[]
): string {
  return [
    "You are the private planner for implementation-plan consensus extraction.",
    "Compare the independent participant plans below and extract only the canonical items needed for confirmation or debate.",
    "Classify work by source coverage before emitting items: common items appear in every healthy participant plan, needs-confirmation items appear in only a subset, and conflict items cover the same area with incompatible recommendations.",
    "Do not write the final plan. Do not add new facts beyond the participant plans and user request.",
    "Merge equivalent work into one item. Preserve practical needs-confirmation items and each incompatible conflict alternative so other participants can evaluate them.",
    "Use participant ids exactly in SRC. Put all participant ids in SRC only when equivalent work appears in every healthy participant plan. Put only actual source participant ids in SRC for subset or conflict items.",
    "Return only this internal protocol. No Markdown, prose, JSON, or text outside the blocks:",
    "K1|S:Info|T:short implementation item title|SRC:codex-cli,claude-code",
    "C:canonical goal or decision for this item",
    "E:repo evidence, source-plan evidence, likely files/modules, dependencies, or reasoning",
    "A:concrete implementation guidance plus tests/verification",
    "Severity S should usually be Info; use Medium or High only for risky migration, compatibility, or data-loss concerns.",
    `Participants: ${participants.map((participant) => `${participant.id}=${participant.label}`).join(", ")}`,
    `Repository: ${request.repoPath}`,
    request.question ? `User request:\n${request.question}` : "User request:\nCreate an implementation plan.",
    limitText(`Participant plans:\n${formatRawImplementationPlansForPrompt(rawPlans)}`, warnings)
  ].join("\n\n");
}

export function buildImplementationPlanSynthesisPrompt(request: ReviewRequest, conversation: Conversation, warnings: string[]): string {
  const answers = implementationPlanAnswersFromMetadata(conversation);
  return [
    "You are the planner for the final implementation-plan synthesis.",
    "Use the consensus item threads below to produce one engineer-ready implementation plan.",
    "Return only the final plan as natural Markdown. Do not use a required template and do not include a debate summary.",
    "The plan must include only confirmed/common items and confirmed-after-debate items. Do not include rejected or unresolved items as implementation steps.",
    "Apply user item-review comments as final guidance for wording, caveats, ordering, and refinements.",
    "Keep the plan decision-complete and concise enough to hand to another engineer.",
    `Repository: ${request.repoPath}`,
    request.question ? `User request:\n${request.question}` : "User request:\nCreate an implementation plan.",
    answers.length ? `User decision-thread context:\n${formatDecisionAnswers(answers)}` : "User decision-thread context: none",
    `User item review context:\n${formatPlanItemReviewsForPrompt(conversation)}`,
    limitText(`Consensus item threads:\n${formatImplementationPlanThreadsForPrompt(conversation.findings)}`, warnings)
  ].join("\n\n");
}

export function buildImplementationPlanRevisionPrompt(
  request: ReviewRequest,
  conversation: Conversation,
  previousPlan: string,
  debateSummary: string,
  instruction: string,
  warnings: string[]
): string {
  const answers = implementationPlanAnswersFromMetadata(conversation);
  return [
    "You are the planner revising an existing final implementation plan.",
    "Use the user's correction plus the saved consensus context to produce a complete replacement final plan.",
    "Return only the revised final plan as natural Markdown. Do not include a debate summary, acknowledgements, or commentary outside the plan.",
    "Keep the plan compatible with confirmed consensus items and explicit user decisions. If the correction conflicts with saved consensus, include the feasible correction and state the remaining blocker in the plan.",
    "Do not edit files or run mutating commands.",
    `Repository: ${request.repoPath}`,
    request.question ? `Original user request:\n${request.question}` : "Original user request:\nCreate an implementation plan.",
    `User correction:\n${instruction}`,
    answers.length ? `User decision-thread context:\n${formatDecisionAnswers(answers)}` : "User decision-thread context: none",
    `User item review context:\n${formatPlanItemReviewsForPrompt(conversation)}`,
    debateSummary ? `Existing debate summary for context:\n${debateSummary}` : "Existing debate summary for context: none",
    limitText(`Previous final plan:\n${previousPlan}`, warnings),
    limitText(`Consensus item threads:\n${formatImplementationPlanThreadsForPrompt(conversation.findings)}`, warnings)
  ].join("\n\n");
}

function formatImplementationPlanThreadsForPrompt(findings: Finding[]): string {
  if (findings.length === 0) {
    return "No implementation-plan items were extracted.";
  }

  const lines: string[] = [];
  for (const [index, finding] of findings.entries()) {
    lines.push(`ITEM ${index + 1}|STATUS:${finding.status}|S:${finding.severity}|T:${finding.title}`);
    lines.push(`C:${finding.claim || finding.description}`);
    if (finding.evidence) {
      lines.push(`E:${finding.evidence}`);
    }
    if (finding.action) {
      lines.push(`A:${finding.action}`);
    }
    lines.push(`Sources:${(finding.sourceParticipantLabels ?? [finding.sourceParticipantLabel]).join(", ") || "none"}`);
    if (finding.sourceItems?.length) {
      lines.push("Initial source items:");
      for (const sourceItem of finding.sourceItems) {
        lines.push(`- ${sourceItem.participantLabel}: ${sourceItem.title}`);
        if (sourceItem.claim) {
          lines.push(`  C:${sourceItem.claim}`);
        }
        if (sourceItem.evidence) {
          lines.push(`  E:${sourceItem.evidence}`);
        }
        if (sourceItem.action) {
          lines.push(`  A:${sourceItem.action}`);
        }
      }
    }
    if (finding.rounds.length) {
      lines.push("Debate rounds:");
      for (const round of finding.rounds) {
        lines.push(`- ${round.participantLabel} ${round.stance}: ${round.content}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatPlanItemReviewsForPrompt(conversation: Conversation): string {
  const reviews = planItemReviewsFromMetadata(conversation);
  const reviewable = requiredPlanItemReviewFindings(conversation);
  if (reviewable.length === 0) {
    return "No confirmed implementation-plan items required user review.";
  }

  const lines: string[] = [];
  for (const [index, finding] of reviewable.entries()) {
    const review = planItemReviewForFinding(finding, reviews);
    lines.push(`ITEM ${index + 1}|T:${finding.title}`);
    if (!review) {
      lines.push("User review: missing");
    } else if (review.status === "commented") {
      lines.push(`User review: commented`);
      lines.push(`Comment:${review.comment ?? ""}`);
    } else {
      lines.push("User review: confirmed as-is");
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatRawImplementationPlansForPrompt(rawPlans: RawImplementationPlan[]): string {
  if (rawPlans.length === 0) {
    return "No member plans were available.";
  }

  return rawPlans
    .map((plan) =>
      [
        `--- PARTICIPANT ${plan.participantId} (${plan.participantLabel}) ---`,
        plan.content || "(empty plan)"
      ].join("\n")
    )
    .join("\n\n");
}

function formatDecisionAnswers(answers: PlanDecisionAnswer[]): string {
  if (answers.length === 0) {
    return "none";
  }
  return answers.map((answer, index) => `${index + 1}. ${answer.answer}`).join("\n");
}

function formatDecisionAnswersForAutomaticReuse(answers: PlanDecisionAnswer[]): string {
  if (answers.length === 0) {
    return "none";
  }
  return answers
    .map((answer) => [
      `ID:${answer.decisionId}`,
      answer.answerSource ? `Source:${answer.answerSource}` : "Source:user",
      answer.selectedOptionId ? `Selected:${answer.selectedOptionId}` : "",
      answer.answer
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

export function formatDecisionAnswersForTimeline(answers: PlanDecisionAnswer[]): string {
  return `Implementation-plan decision threads continued:\n${formatDecisionAnswers(answers)}`;
}

function formatDecisionRepliesForPrompt(replies: PlanDecisionReply[]): string {
  if (replies.length === 0) {
    return "none";
  }
  return replies
    .map((reply) => {
      const author = reply.role === "user" ? "User" : reply.participantLabel ?? "Member";
      return `${author}: ${reply.content}`;
    })
    .join("\n");
}
