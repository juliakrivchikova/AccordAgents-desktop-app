import type {
  Conversation,
  ConversationKind,
  Finding,
  PlanDecisionAnswer,
  PlanDecisionReply,
  PlanDecisionRequest,
  PlanItemReview,
  ReviewProgress
} from "../../../shared/types";
import { DEFAULT_NOTICE_CHARS, sanitizeWarningText } from "../../../shared/warnings";

const MAX_NOTICE_CHARS = DEFAULT_NOTICE_CHARS;

export function pointStatus(finding: Finding): { kind: "confirmed" | "disputed" | "unresolved" | "filtered-out"; label: string } {
  if (finding.status === "Confirmed") {
    return { kind: "confirmed", label: "confirmed" };
  }
  if (finding.status === "Rejected") {
    return { kind: "filtered-out", label: "filtered out" };
  }
  const hasDispute = finding.rounds.some((round) => round.stance === "rejected" || round.stance === "originator-rebuttal" || round.stance === "final-resolution");
  return hasDispute ? { kind: "disputed", label: "disputed" } : { kind: "unresolved", label: "unresolved" };
}

export function liveProgressLabel(progress: ReviewProgress[]): string {
  const latest = progress[progress.length - 1];
  if (!latest) {
    return "Running";
  }
  const phase = phaseLabel(latest.phase);
  if (typeof latest.completed === "number" && typeof latest.total === "number" && latest.total > 0) {
    return `${phase}: ${latest.completed}/${latest.total} done`;
  }
  return phase;
}

function phaseLabel(phase: ReviewProgress["phase"]): string {
  return phase
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export interface TimelineMessageDisplay {
  content: string;
  markdown: boolean;
}

interface LineProtocolItem {
  title: string;
  severity?: string;
  claim?: string;
  evidence?: string;
  action?: string;
}

export function displayMessageContent(message: Conversation["messages"][number], kind: ConversationKind): TimelineMessageDisplay {
  const content = summarizeRawProviderJson(message.content) ?? message.content;
  if (kind === "implementation-plan" && (message.role === "participant" || message.role === "summary")) {
    return { content, markdown: true };
  }
  const protocolSummary = formatLineProtocolForTimeline(message, kind, content);
  const displayContent = protocolSummary ?? content;
  return { content: displayContent, markdown: Boolean(protocolSummary) };
}

export function isHiddenImplementationPlanInternalMessage(message: Conversation["messages"][number], kind: ConversationKind): boolean {
  if (kind !== "implementation-plan") {
    return false;
  }
  if (message.role === "participant" && message.participantId?.startsWith("arbiter:")) {
    return true;
  }
  return message.role === "user" && message.content.trimStart().startsWith("Implementation-plan decision threads continued:");
}

function formatLineProtocolForTimeline(
  message: Conversation["messages"][number],
  kind: ConversationKind,
  content: string
): string | undefined {
  if (message.role !== "participant" || message.status === "error") {
    return undefined;
  }
  const items = parseLineProtocolItems(content);
  if (!items.length) {
    return undefined;
  }

  const labels = { claim: "Claim", evidence: "Evidence", action: "Action" };

  return items
    .map((item, index) =>
      [
        `### ${index + 1}. ${item.title || "Untitled item"}`,
        item.claim ? `**${labels.claim}:** ${item.claim}` : "",
        item.evidence ? `**${labels.evidence}:** ${item.evidence}` : "",
        item.action ? `**${labels.action}:** ${item.action}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    )
    .join("\n\n");
}

function parseLineProtocolItems(content: string): LineProtocolItem[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const items: LineProtocolItem[] = [];
  let current: LineProtocolItem | undefined;
  let currentField: "claim" | "evidence" | "action" | undefined;

  const appendField = (field: "claim" | "evidence" | "action", value: string): void => {
    if (!current) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    current[field] = current[field] ? `${current[field]}\n${trimmed}` : trimmed;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      currentField = undefined;
      continue;
    }

    const header = trimmed.match(/^[PK]\d+\|(.+)$/i);
    if (header) {
      current = parseLineProtocolHeader(header[1]);
      items.push(current);
      currentField = undefined;
      continue;
    }

    const field = trimmed.match(/^([CEA]):\s*(.*)$/i);
    if (field && current) {
      const key = field[1].toUpperCase();
      currentField = key === "C" ? "claim" : key === "E" ? "evidence" : "action";
      appendField(currentField, field[2]);
      continue;
    }

    if (current && currentField && !/^[A-Z][A-Z0-9_ -]{0,24}:/i.test(trimmed)) {
      appendField(currentField, trimmed);
    }
  }

  return items.filter((item) => item.title || item.claim || item.evidence || item.action);
}

function parseLineProtocolHeader(header: string): LineProtocolItem {
  const fields = header.split("|");
  const item: LineProtocolItem = { title: "" };
  for (const field of fields) {
    const match = field.match(/^([A-Z]+):\s*(.*)$/i);
    if (!match) {
      continue;
    }
    const key = match[1].toUpperCase();
    const value = match[2].trim();
    if (key === "T") {
      item.title = value;
    } else if (key === "S") {
      item.severity = value;
    }
  }
  return item;
}

export function displayNoticeText(content: string): string {
  return sanitizeWarningText(content, MAX_NOTICE_CHARS);
}

function summarizeRawProviderJson(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const data = JSON.parse(trimmed) as {
      object?: string;
      status?: string;
      model?: string;
      incomplete_details?: { reason?: string };
      output?: unknown[];
    };
    if (data.object !== "response") {
      return undefined;
    }
    if (data.status === "incomplete") {
      const reason = data.incomplete_details?.reason ?? "unknown reason";
      const model = data.model ? ` from ${data.model}` : "";
      return `OpenAI returned an incomplete response${model}: ${reason}. No usable text was produced.`;
    }
    return `OpenAI returned a response object without usable text output${data.status ? ` (status: ${data.status})` : ""}.`;
  } catch {
    return undefined;
  }
}

export function mergeProgressIntoConversation(conversation: Conversation, _progress: ReviewProgress[]): Conversation {
  const messages = conversation.messages.filter((message) => !message.progressPhase);
  if (messages.length === conversation.messages.length) {
    return conversation;
  }

  return { ...conversation, messages };
}

export function conversationRelevantRunIds(conversation: Conversation): Set<string> {
  const ids = new Set<string>();
  const compatibilityRunId = metadataString(conversation.metadata.runId);
  if (compatibilityRunId) ids.add(compatibilityRunId);
  const active = conversation.metadata.activeRunIds;
  if (Array.isArray(active)) {
    for (const id of active) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  for (const message of conversation.messages) {
    const messageRunId = message.metadata?.runId;
    if (typeof messageRunId === "string" && messageRunId) {
      ids.add(messageRunId);
    }
  }
  return ids;
}

export function conversationMatchesSnapshot(current: Conversation | undefined, updated: Conversation, currentRunId: string | undefined): boolean {
  if (!current) {
    return false;
  }
  const currentRun = metadataString(current.metadata.runId);
  const updatedRun = metadataString(updated.metadata.runId);
  return (
    current.id === updated.id ||
    Boolean(currentRun && updatedRun && currentRun === updatedRun) ||
    Boolean(currentRunId && updatedRun && currentRunId === updatedRun) ||
    Boolean(updatedRun && current.id === updatedRun)
  );
}

export function threadExistsInConversation(conversation: Conversation, threadId: string): boolean {
  return (
    timelineFindings(conversation).some((finding) => finding.id === threadId) ||
    visiblePlanDecisionRequests(conversation).some((decision) => decision.id === threadId) ||
    conversation.messages.some((message) => message.metadata?.threadId === threadId || message.id === threadId)
  );
}

function stanceLabel(stance: string): string {
  return stance
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function pointThreadReplies(finding: Finding): Array<{ id: string; author: string; meta: string; createdAt?: string; content: string; order: number }> {
  const sourceReplies = finding.sourceItems?.length
    ? []
    : (() => {
        const sourceLabels = finding.sourceParticipantLabels?.length ? finding.sourceParticipantLabels : [finding.sourceParticipantLabel];
        const sourceIds = finding.sourceParticipantIds?.length ? finding.sourceParticipantIds : [finding.sourceParticipantId];
        return sourceLabels.map((label, index) => ({
          id: `source-${sourceIds[index] ?? label}-${index}`,
          author: label,
          meta: "Initial point",
          createdAt: finding.createdAt,
          content: pointSourceContent(finding),
          order: index
        }));
      })();
  const roundReplies = finding.rounds.map((round, index) => ({
    id: round.id,
    author: round.participantLabel,
    meta: stanceLabel(round.stance),
    createdAt: round.createdAt,
    content: round.content,
    order: sourceReplies.length + index
  }));

  return [...sourceReplies, ...roundReplies].sort((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
    return leftTime - rightTime || left.order - right.order;
  });
}

export function canonicalPlanItemContent(finding: Finding): string {
  return [
    `**Decision:** ${finding.claim || finding.description}`,
    finding.evidence ? `**Context:** ${finding.evidence}` : "",
    finding.action ? `**Next steps:** ${finding.action}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function sourceItemContent(item: NonNullable<Finding["sourceItems"]>[number]): string {
  if (item.rawContent?.trim()) {
    return item.rawContent.trim();
  }
  return [
    item.title ? `Title: ${item.title}` : "",
    item.claim ? `Claim: ${item.claim}` : "",
    item.evidence ? `Evidence: ${item.evidence}` : "",
    item.action ? `Recommended action: ${item.action}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function pointSourceContent(finding: Finding): string {
  return [
    finding.claim ? `Claim: ${finding.claim}` : finding.description,
    finding.evidence ? `Evidence: ${finding.evidence}` : "",
    finding.action ? `Recommended action: ${finding.action}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function sourceLabelForDecision(decision: PlanDecisionRequest): string {
  return decision.sourceParticipantLabels?.length ? decision.sourceParticipantLabels.join(", ") : "Agent";
}

function metadataString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

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

export function labelForKind(kind: ConversationKind): string {
  if (kind === "code-review") {
    return "Code review";
  }
  if (kind === "implementation-plan") {
    return "Implementation plan";
  }
  if (kind === "chat") {
    return "Chat";
  }
  return "Question";
}

export function pendingPlanDecisions(conversation: Conversation | undefined): PlanDecisionRequest[] {
  const value = conversation?.metadata.pendingDecisions;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanDecisionRequest => {
    const decision = item as Partial<PlanDecisionRequest>;
    return (
      typeof decision.id === "string" &&
      typeof decision.title === "string" &&
      typeof decision.question === "string" &&
      Array.isArray(decision.options)
    );
  });
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

function isPlanDecisionRequest(item: unknown): item is PlanDecisionRequest {
  const decision = item as Partial<PlanDecisionRequest>;
  return (
    typeof decision.id === "string" &&
    typeof decision.title === "string" &&
    typeof decision.question === "string" &&
    Array.isArray(decision.options)
  );
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

export function firstPendingPlanItemReview(conversation: Conversation | undefined): Finding | undefined {
  const reviews = planItemReviews(conversation);
  return requiredPlanItemReviewFindings(conversation).find((finding) => !planItemReviewForFinding(finding, reviews));
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

function normalizeDecisionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/`[^`]+`/g, "")
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !["critical", "high", "medium", "low", "info", "severity"].includes(word))
    .join(" ");
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
