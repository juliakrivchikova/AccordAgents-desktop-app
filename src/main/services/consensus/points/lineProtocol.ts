import { randomUUID } from "node:crypto";
import type {
  FindingSeverity, ParticipantConfig, PlanDecisionAnswer, PlanDecisionOption, PlanDecisionRequest
} from "../../../../shared/types";
import { SEVERITY_ORDER } from "../constants";
import type { LinePoint } from "../types";

interface ParsedVerification {
  stance: "confirmed" | "rejected" | "unclear";
  severity?: FindingSeverity;
  reason: string;
}

interface ParsedSourceDecision {
  decision: "accept" | "reject" | "unclear";
  reason: string;
}

interface ParsedAutomaticDecisionAnswer {
  applies: boolean;
  selectedOptionId?: string;
  sourceDecisionId?: string;
  answer: string;
  reason: string;
}

export function parseLineProtocol(content: string, participant: ParticipantConfig | undefined, knownParticipants: ParticipantConfig[]): LinePoint[] {
  const points: LinePoint[] = [];
  let current: Partial<LinePoint> | undefined;
  let currentField: "claim" | "evidence" | "action" | undefined;

  const push = () => {
    if (!current) {
      return;
    }
    const normalized = normalizeLinePoint(current, participant, knownParticipants);
    if (normalized && !isMetaPoint(normalized)) {
      points.push(normalized);
    }
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const header = line.match(/^[PK]\d+\|/i) ? line : undefined;
    if (header) {
      push();
      current = parsePointHeader(header, participant, knownParticipants);
      currentField = undefined;
      continue;
    }
    if (!current) {
      continue;
    }
    const field = line.match(/^(C|E|A|T|S|SRC):\s*(.*)$/i);
    if (field) {
      const key = field[1].toUpperCase();
      const value = field[2].trim();
      if (key === "C") {
        current.claim = value;
        currentField = "claim";
      } else if (key === "E") {
        current.evidence = value;
        currentField = "evidence";
      } else if (key === "A") {
        current.action = value;
        currentField = "action";
      } else if (key === "T") {
        current.title = value;
        currentField = undefined;
      } else if (key === "S") {
        current.severity = asSeverity(value) ?? current.severity;
        currentField = undefined;
      } else if (key === "SRC") {
        current.sourceParticipantIds = resolveParticipantIds(value, knownParticipants);
        currentField = undefined;
      }
    } else if (currentField) {
      current[currentField] = [current[currentField], line].filter(Boolean).join(" ");
    }
  }
  push();
  return points;
}

export function parseDecisionProtocol(content: string, participant: ParticipantConfig | undefined, knownParticipants: ParticipantConfig[]): PlanDecisionRequest[] {
  if (/^\s*NO_DECISIONS\s*$/i.test(content.trim())) {
    return [];
  }

  const decisions: PlanDecisionRequest[] = [];
  let current: Partial<PlanDecisionRequest> & { options?: PlanDecisionOption[] } | undefined;
  let currentField: "question" | "impact" | "option" | undefined;
  let currentOptionId: string | undefined;

  const push = () => {
    if (!current) {
      return;
    }
    const normalized = normalizePlanDecision(current, participant, knownParticipants);
    if (normalized) {
      decisions.push(normalized);
    }
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const header = line.match(/^D\d+\|/i) ? line : undefined;
    if (header) {
      push();
      current = parseDecisionHeader(header, participant, knownParticipants);
      currentField = undefined;
      currentOptionId = undefined;
      continue;
    }
    if (!current) {
      continue;
    }
    const option = line.match(/^O(\d+):\s*(.*)$/i);
    if (option) {
      const id = `O${option[1]}`;
      current.options = [...(current.options ?? []), { id, label: option[2].trim() }];
      currentField = "option";
      currentOptionId = id;
      continue;
    }
    const field = line.match(/^(Q|I|R|T|SRC):\s*(.*)$/i);
    if (field) {
      const key = field[1].toUpperCase();
      const value = field[2].trim();
      if (key === "Q") {
        current.question = value;
        currentField = "question";
        currentOptionId = undefined;
      } else if (key === "I") {
        current.impact = value;
        currentField = "impact";
        currentOptionId = undefined;
      } else if (key === "R") {
        current.recommendedOptionId = value.toUpperCase();
        currentField = undefined;
        currentOptionId = undefined;
      } else if (key === "T") {
        current.title = value;
        currentField = undefined;
        currentOptionId = undefined;
      } else if (key === "SRC") {
        current.sourceParticipantIds = resolveParticipantIds(value, knownParticipants);
        currentField = undefined;
        currentOptionId = undefined;
      }
    } else if (currentField === "question") {
      current.question = [current.question, line].filter(Boolean).join(" ");
    } else if (currentField === "impact") {
      current.impact = [current.impact, line].filter(Boolean).join(" ");
    } else if (currentField === "option" && currentOptionId) {
      current.options = (current.options ?? []).map((item) =>
        item.id === currentOptionId ? { ...item, label: [item.label, line].filter(Boolean).join(" ") } : item
      );
    }
  }
  push();
  return decisions;
}

function parsePointHeader(header: string, participant: ParticipantConfig | undefined, knownParticipants: ParticipantConfig[]): Partial<LinePoint> {
  const [prefix, ...parts] = header.split("|");
  const point: Partial<LinePoint> = {
    id: prefix.trim(),
    sourceParticipantIds: participant ? [participant.id] : []
  };
  for (const part of parts) {
    const [rawKey, ...rawValue] = part.split(":");
    const key = rawKey.trim().toUpperCase();
    const value = rawValue.join(":").trim();
    if (key === "S") {
      point.severity = asSeverity(value);
    } else if (key === "T") {
      point.title = value;
    } else if (key === "SRC") {
      point.sourceParticipantIds = resolveParticipantIds(value, knownParticipants);
    }
  }
  return point;
}

function parseDecisionHeader(
  header: string,
  participant: ParticipantConfig | undefined,
  knownParticipants: ParticipantConfig[]
): Partial<PlanDecisionRequest> & { options?: PlanDecisionOption[] } {
  const [prefix, ...parts] = header.split("|");
  const decision: Partial<PlanDecisionRequest> & { options?: PlanDecisionOption[] } = {
    id: prefix.trim(),
    sourceParticipantIds: participant ? [participant.id] : [],
    options: []
  };
  for (const part of parts) {
    const [rawKey, ...rawValue] = part.split(":");
    const key = rawKey.trim().toUpperCase();
    const value = rawValue.join(":").trim();
    if (key === "T") {
      decision.title = value;
    } else if (key === "SRC") {
      decision.sourceParticipantIds = resolveParticipantIds(value, knownParticipants);
    }
  }
  return decision;
}

function normalizeLinePoint(point: Partial<LinePoint>, participant: ParticipantConfig | undefined, knownParticipants: ParticipantConfig[]): LinePoint | undefined {
  const sourceParticipantIds = point.sourceParticipantIds?.length
    ? Array.from(new Set(point.sourceParticipantIds))
    : participant
      ? [participant.id]
      : [];
  const claim = (point.claim ?? "").trim();
  const action = (point.action ?? "").trim();
  const title = (point.title || claim || action).trim().slice(0, 160);
  if (!title || (!claim && !action)) {
    return undefined;
  }
  return {
    id: point.id || `P${randomUUID().slice(0, 8)}`,
    title,
    claim,
    evidence: (point.evidence ?? "").trim(),
    action,
    severity: point.severity ?? (participant ? severityFromText(`${title} ${claim} ${action}`) : "Info"),
    sourceParticipantIds: sourceParticipantIds.filter((id) => knownParticipants.some((known) => known.id === id))
  };
}

function normalizePlanDecision(
  decision: Partial<PlanDecisionRequest> & { options?: PlanDecisionOption[] },
  participant: ParticipantConfig | undefined,
  knownParticipants: ParticipantConfig[]
): PlanDecisionRequest | undefined {
  const question = (decision.question ?? "").trim();
  const title = (decision.title || question).trim().slice(0, 120);
  const options = (decision.options ?? []).map((option) => ({ ...option, label: option.label.trim() })).filter((option) => option.label);
  if (!question || options.length < 2) {
    return undefined;
  }
  const sourceParticipantIds = (decision.sourceParticipantIds?.length ? decision.sourceParticipantIds : participant ? [participant.id] : [])
    .filter((id) => knownParticipants.some((known) => known.id === id));
  const sourceParticipantLabels = sourceParticipantIds.map((id) => knownParticipants.find((known) => known.id === id)?.label ?? id);
  const recommendedOptionId = options.some((option) => option.id === decision.recommendedOptionId) ? decision.recommendedOptionId : options[0]?.id;
  const decisionKey = decisionKeyFromText(title, question);
  const ownerKey = participant
    ? decisionIdFromKey(normalizeId(participant.id || participant.label))
    : sourceParticipantIds.length
      ? decisionIdFromKey(sourceParticipantIds.join(" "))
      : "shared";
  return {
    id: `decision-${ownerKey}-${decisionIdFromKey(decisionKey)}`,
    title,
    question,
    impact: (decision.impact ?? "").trim() || "This choice materially changes the implementation plan.",
    options,
    recommendedOptionId,
    sourceParticipantIds,
    sourceParticipantLabels,
    createdAt: new Date().toISOString()
  };
}

function resolveParticipantIds(value: string, participants: ParticipantConfig[]): string[] {
  const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
  const resolved: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeId(token);
    const match = participants.find((participant) => participant.id === token || normalizeId(participant.label) === normalized || normalizeId(participant.id) === normalized);
    if (match) {
      resolved.push(match.id);
    }
  }
  return Array.from(new Set(resolved));
}

export function parseVerification(content: string): ParsedVerification {
  const value = content.match(/\bV:\s*(AGREE|REJECT|UNCLEAR)\b/i)?.[1]?.toUpperCase();
  const severityText = content.match(/\bS:\s*(Critical|High|Medium|Low|Info)\b/i)?.[1];
  const reason = content.match(/\bE:\s*([\s\S]*)/i)?.[1]?.trim() || content.trim();
  return {
    stance: value === "AGREE" ? "confirmed" : value === "REJECT" ? "rejected" : "unclear",
    severity: asSeverity(severityText),
    reason
  };
}

export function parseSourceDecision(content: string): ParsedSourceDecision {
  const value = content.match(/\bV:\s*(ACCEPT|REJECT|UNCLEAR)\b/i)?.[1]?.toUpperCase();
  const reason = content.match(/\bE:\s*([\s\S]*)/i)?.[1]?.trim() || content.trim();
  return {
    decision: value === "ACCEPT" ? "accept" : value === "REJECT" ? "reject" : "unclear",
    reason
  };
}

export function parseAutomaticDecisionAnswer(content: string): ParsedAutomaticDecisionAnswer {
  const value = content.match(/\bV:\s*(YES|NO)\b/i)?.[1]?.toUpperCase();
  const selectedOptionId = content.match(/\bO:\s*(O\d+)\b/i)?.[1]?.toUpperCase();
  const sourceDecisionId = content.match(/\bSRC:\s*([^\s|]+)/i)?.[1]?.trim();
  const answer = content.match(/\bA:\s*([\s\S]*?)(?:\nE:|$)/i)?.[1]?.trim() ?? "";
  const reason = content.match(/\bE:\s*([\s\S]*)/i)?.[1]?.trim() || content.trim();
  return {
    applies: value === "YES",
    selectedOptionId,
    sourceDecisionId,
    answer,
    reason
  };
}

export function isMetaPoint(point: LinePoint): boolean {
  const text = `${point.title} ${point.claim} ${point.action}`.toLowerCase();
  if (/^(sources?|references?|источники|ссылки)\b/i.test(point.title.trim())) {
    return true;
  }
  return !point.claim && !point.action || /\b(niddk|mayo clinic|source|reference|источник)\b/i.test(text) && point.action.length < 20 && point.claim.length < 40;
}

export function isAnsweredDecision(decision: PlanDecisionRequest, answers: PlanDecisionAnswer[]): boolean {
  return answers.some((answer) => answer.decisionId === decision.id);
}

export function decisionKey(decision: PlanDecisionRequest): string {
  return decisionKeyFromText(decision.title, decision.question);
}

function decisionKeyFromText(title: string, question: string): string {
  return normalizeId(`${title} ${question}`).split(/\s+/).slice(0, 12).join(" ");
}

function decisionIdFromKey(key: string): string {
  const slug = key.replace(/\s+/g, "-").slice(0, 96);
  return slug || randomUUID();
}

export function decisionAnswerKey(answer: PlanDecisionAnswer): string {
  if (answer.decisionKey?.trim()) {
    return answer.decisionKey.trim();
  }
  const title = answer.answer.match(/^Decision:\s*(.+)$/m)?.[1] ?? "";
  const question = answer.answer.match(/^Question:\s*(.+)$/m)?.[1] ?? "";
  return title || question ? decisionKeyFromText(title, question) : "";
}

export function normalizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/`[^`]+`/g, "")
    .replace(/[^a-zа-яё0-9\s-]/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !["critical", "high", "medium", "low", "info", "severity"].includes(word))
    .join(" ");
}

function severityFromText(text: string): FindingSeverity {
  return asSeverity(text.match(/\b(Critical|High|Medium|Low|Info)\b/i)?.[1]) ?? "Medium";
}

function asSeverity(value: string | undefined): FindingSeverity | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return SEVERITY_ORDER.find((severity) => severity.toLowerCase() === normalized);
}
