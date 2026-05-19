import type { Conversation } from "./types";

export const DEFAULT_NOTICE_CHARS = 220;
export const INTERRUPTED_RUN_WARNING = "Previous run was interrupted before completion. Continue from the saved context.";

const RAW_CLI_PATTERNS = [
  /"type"\s*:\s*"thread\.started"/,
  /"type"\s*:\s*"turn\.started"/,
  /"type"\s*:\s*"item\.(started|completed)"/,
  /"type"\s*:\s*"command_execution"/,
  /"aggregated_output"\s*:/,
  /"thread_id"\s*:/
];

const OBSOLETE_WARNING_PATTERNS = [
  /^.+?: CLI session id was not reported, so later rounds may need to rebuild context from the saved thread transcript\.$/
];

export function sanitizeWarningText(warning: string, maxChars = DEFAULT_NOTICE_CHARS): string {
  const trimmed = warning.trim();
  if (!trimmed) {
    return "";
  }
  if (OBSOLETE_WARNING_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return "";
  }

  const cliSummary = summarizeRawCliDiagnostic(trimmed);
  if (cliSummary) {
    return truncateOneLine(cliSummary, maxChars);
  }

  return truncateOneLine(trimmed, maxChars);
}

export function sanitizeWarningList(value: unknown, maxChars = DEFAULT_NOTICE_CHARS): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const warning of value
    .filter((item): item is string => typeof item === "string")
    .map((item) => sanitizeWarningText(item, maxChars))
    .filter(Boolean)) {
    if (!seen.has(warning)) {
      seen.add(warning);
      warnings.push(warning);
    }
  }
  return warnings;
}

export function sanitizeConversationWarnings(conversation: Conversation, maxChars = DEFAULT_NOTICE_CHARS): boolean {
  const before = conversation.metadata.warnings;
  const warnings = sanitizeWarningList(before, maxChars);
  const changed = JSON.stringify(before ?? []) !== JSON.stringify(warnings);
  if (changed) {
    conversation.metadata = { ...conversation.metadata, warnings };
  }
  return changed;
}

function summarizeRawCliDiagnostic(warning: string): string | undefined {
  const normalized = warning.replace(/\\"/g, '"');
  if (!looksLikeRawCliDiagnostic(normalized)) {
    return undefined;
  }

  const label = normalized.match(/^([A-Za-z][A-Za-z0-9 ._-]{1,79}):/)?.[1].trim() ?? "CLI agent";
  const phase = normalized.slice(-260).match(/\b(during [a-z][a-z\s-]{1,80})\.?$/i)?.[1];
  const suffix = phase ? ` ${phase}` : "";
  return `${label} failed${suffix}. Raw diagnostic output hidden; see debug logs.`;
}

function looksLikeRawCliDiagnostic(warning: string): boolean {
  const sample = warning.slice(0, 40_000);
  const matches = RAW_CLI_PATTERNS.filter((pattern) => pattern.test(sample)).length;
  return matches >= 2 && /command_execution|aggregated_output|thread_id/.test(sample);
}

function truncateOneLine(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
