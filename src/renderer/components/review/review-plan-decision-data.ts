import type {
  Conversation,
  PlanDecisionAnswer,
  PlanDecisionReply,
  PlanDecisionRequest,
  ReviewProgress
} from "../../../shared/types";

export function pendingPlanDecisions(conversation: Conversation | undefined): PlanDecisionRequest[] {
  const value = conversation?.metadata.pendingDecisions;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isPlanDecisionRequest);
}

export function planDecisionRequests(conversation: Conversation | undefined): PlanDecisionRequest[] {
  const value = conversation?.metadata.planDecisionRequests;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isPlanDecisionRequest);
}

export function visiblePlanDecisionRequests(conversation: Conversation | undefined): PlanDecisionRequest[] {
  if (!conversation) {
    return [];
  }
  const merged = mergePlanDecisionRequests(planDecisionRequests(conversation), pendingPlanDecisions(conversation));
  const byId = new Map(merged.map((decision) => [decision.id, decision]));
  implementationPlanAnswers(conversation).forEach((answer, index) => {
    if (!byId.has(answer.decisionId)) {
      const fallback = fallbackDecisionRequestFromAnswer(answer, conversation.updatedAt, index);
      if (fallback) {
        byId.set(fallback.id, fallback);
      }
    }
  });
  return Array.from(byId.values());
}

export function mergePlanDecisionRequests(existing: PlanDecisionRequest[], next: PlanDecisionRequest[]): PlanDecisionRequest[] {
  const merged = new Map<string, PlanDecisionRequest>();
  for (const decision of [...existing, ...next]) {
    if (decision.id.trim() && decision.question.trim()) {
      merged.set(decision.id, decision);
    }
  }
  return Array.from(merged.values());
}

export function decisionTypingLabels(decision: PlanDecisionRequest, progress: ReviewProgress[], isRunning: boolean): string[] {
  if (!isRunning) {
    return [];
  }
  const relevant = progress
    .filter((item) => item.phase === "decisions" && item.findingTitle === decision.title && item.participantLabel)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const latest = relevant[relevant.length - 1];
  return latest?.participantLabel ? [latest.participantLabel] : [];
}

export function typingText(labels: string[]): string {
  if (labels.length === 0 || labels[0] === "Models") {
    return "Models are typing";
  }
  if (labels.length === 1) {
    return `${labels[0]} is typing`;
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]} are typing`;
  }
  return `${labels[0]} and ${labels.length - 1} others are typing`;
}

export function planDecisionReplies(conversation: Conversation | undefined): PlanDecisionReply[] {
  const value = conversation?.metadata.planDecisionReplies;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanDecisionReply => {
    const reply = item as Partial<PlanDecisionReply>;
    return (
      typeof reply.id === "string" &&
      typeof reply.decisionId === "string" &&
      typeof reply.role === "string" &&
      typeof reply.content === "string" &&
      typeof reply.createdAt === "string"
    );
  });
}

export function implementationPlanAnswers(conversation: Conversation | undefined): PlanDecisionAnswer[] {
  const value = conversation?.metadata.implementationPlanAnswers;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanDecisionAnswer => {
    const answer = item as Partial<PlanDecisionAnswer>;
    return typeof answer.decisionId === "string" && typeof answer.answer === "string";
  });
}

export function pendingDecisionSelections(conversation: Conversation | undefined): Record<string, string> {
  const value = conversation?.metadata.pendingDecisionSelections;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
  );
}

export function pendingDecisionResolutions(conversation: Conversation | undefined): Record<string, boolean> {
  const value = conversation?.metadata.pendingDecisionResolutions;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[0] === "string" && entry[1] === true)
  );
}

export function decisionThreadIsReady(
  decision: PlanDecisionRequest,
  selectedAnswers: Record<string, string>,
  resolvedThreads: Record<string, boolean>,
  savedAnswers: PlanDecisionAnswer[] = []
): boolean {
  return (
    Boolean(selectedAnswers[decision.id]?.trim()) ||
    resolvedThreads[decision.id] === true ||
    Boolean(decisionAnswerForDecision(decision, savedAnswers))
  );
}

export function decisionThreadHasUserReply(decision: PlanDecisionRequest, replies: PlanDecisionReply[]): boolean {
  return replies.some((reply) => reply.decisionId === decision.id && reply.role === "user" && reply.content.trim());
}

export function decisionThreadAnswer(
  decision: PlanDecisionRequest,
  selectedAnswers: Record<string, string>,
  replies: PlanDecisionReply[]
): string {
  const selectedOptionId = selectedAnswers[decision.id]?.trim();
  const selectedOption = decision.options.find((option) => option.id === selectedOptionId);
  const threadReplies = replies
    .filter((reply) => reply.decisionId === decision.id && reply.content.trim())
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const lines = [
    `Decision: ${decision.title}`,
    `Question: ${decision.question}`,
    selectedOption ? `Selected option: ${selectedOption.label}` : "",
    "Thread transcript:",
    ...threadReplies.map((reply) => `${reply.role === "user" ? "User" : reply.participantLabel ?? "Participant"}: ${reply.content.trim()}`)
  ].filter(Boolean);
  return lines.join("\n");
}

export function decisionAnswerForDecision(decision: PlanDecisionRequest, answers: PlanDecisionAnswer[]): PlanDecisionAnswer | undefined {
  return answers.find((answer) => answer.decisionId === decision.id);
}

export function mergePlanDecisionAnswers(existing: PlanDecisionAnswer[], next: PlanDecisionAnswer[]): PlanDecisionAnswer[] {
  const merged = new Map<string, PlanDecisionAnswer>();
  for (const answer of [...existing, ...next]) {
    const key = answer.decisionId;
    if (key && answer.answer.trim()) {
      merged.set(key, answer);
    }
  }
  return Array.from(merged.values());
}

export function planDecisionKey(decision: PlanDecisionRequest): string {
  return normalizeDecisionText(`${decision.title} ${decision.question}`).split(/\s+/).slice(0, 12).join(" ");
}

function isPlanDecisionRequest(item: unknown): item is PlanDecisionRequest {
  const decision = item as Partial<PlanDecisionRequest>;
  return (
    typeof decision.id === "string" &&
    typeof decision.title === "string" &&
    typeof decision.question === "string" &&
    Array.isArray(decision.options)
  );
}

function fallbackDecisionRequestFromAnswer(answer: PlanDecisionAnswer, createdAt: string, index: number): PlanDecisionRequest | undefined {
  if (!answer.decisionId.trim() || !answer.answer.trim()) {
    return undefined;
  }
  const title = answer.answer.match(/^Decision:\s*(.+)$/m)?.[1]?.trim();
  const question = answer.answer.match(/^Question:\s*(.+)$/m)?.[1]?.trim();
  const selectedLabel = answer.answer.match(/^Selected option:\s*(.+)$/m)?.[1]?.trim();
  const optionId = answer.selectedOptionId?.trim();
  const optionLabel = selectedLabel || optionId;
  const firstContentLine = answer.answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^(Decision|Question|Selected option|Thread transcript|Automatic answer|Reason):/i.test(line));
  const option = optionLabel
    ? [{ id: optionId || "answered", label: optionLabel }]
    : [];
  return {
    id: answer.decisionId,
    title: title || `Decision answer ${index + 1}`,
    question: question || firstContentLine || "Saved decision answer",
    impact: "Saved answer from a previous decision thread.",
    options: option,
    recommendedOptionId: optionId && option.some((item) => item.id === optionId) ? optionId : undefined,
    sourceParticipantIds: [],
    sourceParticipantLabels: ["Agent"],
    createdAt
  };
}

function normalizeDecisionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/`[^`]+`/g, "")
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !["critical", "high", "medium", "low", "info", "severity"].includes(word))
    .join(" ");
}
