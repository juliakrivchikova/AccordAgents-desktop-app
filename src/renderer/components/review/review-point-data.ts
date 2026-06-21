import type {
  Finding,
  PlanDecisionRequest
} from "../../../shared/types";

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

function stanceLabel(stance: string): string {
  return stance
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
