import { randomUUID } from "node:crypto";
import type { Finding, FindingSourceItem, FindingStatus, ParticipantConfig } from "../../../../shared/types";
import { ParticipantRunResult } from "../../providers";
import { isMetaPoint, normalizeId, parseVerification } from "./lineProtocol";
import type { LinePoint, RawImplementationPlan } from "../types";

const MIN_POINT_MATCH_TOKENS = 3;
const MIN_POINT_MATCH_RATIO = 0.5;

export function rawImplementationPlansFromResults(initialResults: ParticipantRunResult[], healthyParticipants: ParticipantConfig[]): RawImplementationPlan[] {
  const healthyIds = new Set(healthyParticipants.map((participant) => participant.id));
  const createdAt = new Date().toISOString();
  return initialResults
    .filter((result) => result.ok && healthyIds.has(result.participant.id) && result.content.trim())
    .map((result) => ({
      participantId: result.participant.id,
      participantLabel: result.participant.label,
      content: result.content.trim(),
      createdAt
    }));
}

export function localMergePoints(pointsByParticipant: Map<string, LinePoint[]>): LinePoint[] {
  const merged = new Map<string, LinePoint>();
  for (const points of pointsByParticipant.values()) {
    for (const point of points) {
      const key = keyOfPoint(point);
      const existing = merged.get(key);
      if (existing) {
        existing.sourceParticipantIds = Array.from(new Set([...existing.sourceParticipantIds, ...point.sourceParticipantIds]));
        existing.evidence = existing.evidence || point.evidence;
        existing.action = existing.action || point.action;
      } else {
        merged.set(key, { ...point, sourceParticipantIds: [...point.sourceParticipantIds] });
      }
    }
  }
  return Array.from(merged.values());
}

function selectImplementationPlanPoints(
  points: LinePoint[],
  pointsByParticipant: Map<string, LinePoint[]>,
  participants: ParticipantConfig[],
  warnings: string[]
): LinePoint[] {
  const normalizedPoints = points
    .filter((point) => !isMetaPoint(point))
    .map((point) => withVerifiedSources(point, pointsByParticipant, participants));
  const untraceablePointCount = normalizedPoints.filter((point) => point.sourceParticipantIds.length === 0).length;
  if (untraceablePointCount > 0) {
    warnings.push(`${untraceablePointCount} implementation-plan item${untraceablePointCount === 1 ? "" : "s"} had no matching member source and were filtered out.`);
  }

  return normalizedPoints.filter((point) => point.sourceParticipantIds.length > 0);
}

export function selectImplementationPlanExtractionPoints(points: LinePoint[], participants: ParticipantConfig[], warnings: string[]): LinePoint[] {
  const participantIds = new Set(participants.map((participant) => participant.id));
  const normalizedPoints = points
    .filter((point) => !isMetaPoint(point))
    .map((point) => ({
      ...point,
      sourceParticipantIds: Array.from(new Set(point.sourceParticipantIds.filter((id) => participantIds.has(id))))
    }));
  const untraceablePointCount = normalizedPoints.filter((point) => point.sourceParticipantIds.length === 0).length;
  if (untraceablePointCount > 0) {
    warnings.push(`${untraceablePointCount} implementation-plan item${untraceablePointCount === 1 ? "" : "s"} had no valid member source and were filtered out.`);
  }

  return normalizedPoints.filter((point) => point.sourceParticipantIds.length > 0);
}

export function withInferredSources(
  point: LinePoint,
  pointsByParticipant: Map<string, LinePoint[]>,
  participants: ParticipantConfig[]
): LinePoint {
  const participantIds = new Set(participants.map((participant) => participant.id));
  const sourceParticipantIds = new Set(point.sourceParticipantIds.filter((id) => participantIds.has(id)));

  for (const [participantId, points] of pointsByParticipant.entries()) {
    if (!participantIds.has(participantId) || sourceParticipantIds.has(participantId)) {
      continue;
    }
    if (points.some((candidate) => pointsLikelyMatch(point, candidate))) {
      sourceParticipantIds.add(participantId);
    }
  }

  return { ...point, sourceParticipantIds: Array.from(sourceParticipantIds) };
}

function withVerifiedSources(
  point: LinePoint,
  pointsByParticipant: Map<string, LinePoint[]>,
  participants: ParticipantConfig[]
): LinePoint {
  const participantIds = new Set(participants.map((participant) => participant.id));
  const declaredSourceIds = new Set(point.sourceParticipantIds.filter((id) => participantIds.has(id)));
  const sourceParticipantIds = new Set<string>();

  for (const [participantId, points] of pointsByParticipant.entries()) {
    if (!participantIds.has(participantId)) {
      continue;
    }
    const hasSourceMatch = declaredSourceIds.has(participantId)
      ? Boolean(bestSourcePointForParticipant(point, points))
      : declaredSourceIds.size === 0 && points.some((candidate) => pointsLikelyMatch(point, candidate));
    if (hasSourceMatch) {
      sourceParticipantIds.add(participantId);
    }
  }

  return { ...point, sourceParticipantIds: Array.from(sourceParticipantIds) };
}

function sourceItemsForPoint(
  point: LinePoint,
  pointsByParticipant: Map<string, LinePoint[]>,
  participants: ParticipantConfig[]
): FindingSourceItem[] {
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));
  const sourceItems: FindingSourceItem[] = [];
  for (const participantId of point.sourceParticipantIds) {
    const participant = participantById.get(participantId);
    if (!participant) {
      continue;
    }
    const sourcePoint = bestSourcePointForParticipant(point, pointsByParticipant.get(participantId) ?? []) ?? point;
    sourceItems.push({
      participantId,
      participantLabel: participant.label,
      title: sourcePoint.title,
      claim: sourcePoint.claim,
      evidence: sourcePoint.evidence,
      action: sourcePoint.action
    });
  }
  return sourceItems;
}

export function sourceItemsForRawPlans(
  point: LinePoint,
  rawPlans: RawImplementationPlan[],
  participants: ParticipantConfig[]
): FindingSourceItem[] {
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));
  const rawPlanByParticipantId = new Map(rawPlans.map((plan) => [plan.participantId, plan]));
  const sourceItems: FindingSourceItem[] = [];
  for (const participantId of point.sourceParticipantIds) {
    const participant = participantById.get(participantId);
    const rawPlan = rawPlanByParticipantId.get(participantId);
    if (!participant || !rawPlan) {
      continue;
    }
    sourceItems.push({
      participantId,
      participantLabel: participant.label,
      title: "Initial implementation plan",
      claim: "",
      evidence: "",
      action: "",
      rawContent: rawPlan.content
    });
  }
  return sourceItems;
}

function bestSourcePointForParticipant(point: LinePoint, candidates: LinePoint[]): LinePoint | undefined {
  const pointKey = keyOfPoint(point);
  const pointTokens = tokensOfPoint(point);
  let best: { point: LinePoint; score: number } | undefined;
  for (const candidate of candidates) {
    if (pointKey && pointKey === keyOfPoint(candidate)) {
      return candidate;
    }
    const candidateTokens = tokensOfPoint(candidate);
    if (pointTokens.size === 0 || candidateTokens.size === 0) {
      continue;
    }
    const common = Array.from(pointTokens).filter((token) => candidateTokens.has(token)).length;
    const smaller = Math.min(pointTokens.size, candidateTokens.size);
    const score = common / smaller;
    if (common < MIN_POINT_MATCH_TOKENS || score < MIN_POINT_MATCH_RATIO) {
      continue;
    }
    if (!best || score > best.score) {
      best = { point: candidate, score };
    }
  }
  return best?.point;
}

export function createFinding(point: LinePoint, healthyParticipants: ParticipantConfig[], sourceItems: FindingSourceItem[] = []): Finding {
  const includedParticipantIds = point.sourceParticipantIds.filter((id) => healthyParticipants.some((participant) => participant.id === id));
  const missingParticipantIds = healthyParticipants.map((participant) => participant.id).filter((id) => !includedParticipantIds.includes(id));
  const sourceParticipantId = includedParticipantIds[0] ?? healthyParticipants[0]?.id ?? "unknown";
  const sourceParticipantLabel = healthyParticipants.find((participant) => participant.id === sourceParticipantId)?.label ?? sourceParticipantId;
  const sourceParticipantLabels = includedParticipantIds.map((id) => healthyParticipants.find((participant) => participant.id === id)?.label ?? id);

  return {
    id: randomUUID(),
    title: point.title,
    description: point.claim || point.action || point.title,
    sourceParticipantId,
    sourceParticipantLabel,
    sourceParticipantIds: includedParticipantIds,
    sourceParticipantLabels,
    includedParticipantIds,
    missingParticipantIds,
    claim: point.claim,
    evidence: point.evidence,
    action: point.action,
    sourceItems,
    severity: point.severity,
    status: missingParticipantIds.length === 0 && includedParticipantIds.length > 0 ? "Confirmed" : "Unresolved",
    rounds: [],
    createdAt: new Date().toISOString()
  };
}

export function statusFor(finding: Finding, healthyParticipants: ParticipantConfig[]): FindingStatus {
  const finalRound = finding.rounds.find((round) => round.stance === "final-resolution");
  if (finalRound) {
    const parsed = parseVerification(finalRound.content);
    return parsed.stance === "confirmed" ? "Confirmed" : parsed.stance === "rejected" ? "Rejected" : "Unresolved";
  }

  const supportIds = new Set(finding.includedParticipantIds ?? [finding.sourceParticipantId]);
  const rejectIds = new Set<string>();
  let hasUnclear = false;
  for (const round of finding.rounds) {
    if (round.stance === "confirmed") {
      supportIds.add(round.participantId);
    } else if (round.stance === "rejected") {
      rejectIds.add(round.participantId);
    } else if (round.stance === "unclear") {
      hasUnclear = true;
    }
  }

  if (healthyParticipants.length > 0 && healthyParticipants.every((participant) => supportIds.has(participant.id))) {
    return "Confirmed";
  }
  if (rejectIds.size > 0 && rejectIds.size >= supportIds.size) {
    return "Rejected";
  }
  return hasUnclear || rejectIds.size > 0 ? "Unresolved" : "Unresolved";
}

function keyOfPoint(point: LinePoint): string {
  return normalizeId(`${point.title} ${point.claim || point.action}`).split(/\s+/).slice(0, 14).join(" ");
}

function pointsLikelyMatch(left: LinePoint, right: LinePoint): boolean {
  const leftKey = keyOfPoint(left);
  const rightKey = keyOfPoint(right);
  if (leftKey && rightKey && leftKey === rightKey) {
    return true;
  }

  const leftTokens = tokensOfPoint(left);
  const rightTokens = tokensOfPoint(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return false;
  }

  const common = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  return common >= MIN_POINT_MATCH_TOKENS && common / smaller >= MIN_POINT_MATCH_RATIO;
}

function tokensOfPoint(point: LinePoint): Set<string> {
  return new Set(
    normalizeId(`${point.title} ${point.claim} ${point.evidence} ${point.action}`)
      .split(/\s+/)
      .filter((token) => token.length > 2)
  );
}
