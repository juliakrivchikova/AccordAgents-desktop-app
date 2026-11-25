import type { Conversation } from "./types";
import { CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS } from "./cliAgentRunSettings";

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
  /^.+?: CLI session id was not reported, so later rounds may need to rebuild context from the saved thread transcript\.$/,
  /^@[A-Za-z0-9._-]+: rejected verbose affirmative confirmation; retried in the same chat session\.$/,
  /^@[A-Za-z0-9._-]+: still returned a verbose affirmative confirmation after retry\.$/
];

export function sanitizeWarningText(warning: string, maxChars = DEFAULT_NOTICE_CHARS): string {
  const trimmed = warning.trim();
  if (!trimmed) {
    return "";
  }
  if (OBSOLETE_WARNING_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return "";
  }

  const plainCliSummary = summarizePlainCliFailureDiagnostic(trimmed);
  if (plainCliSummary) {
    return truncateOneLine(plainCliSummary, maxChars);
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

export interface CliFailureNoticeOptions {
  label: string;
  defaultTimeoutMs?: number;
  forceTimeout?: boolean;
}

/**
 * What a failed reply says happened (the User, 2026-11-25: "a meaningful
 * message of what happened, not just a fail"). What the CLI itself said — a
 * usage limit and when it resets, an API error, a refused model — is shown in
 * its own words, as its terminal shows it; what the app knows better (a
 * missing program, a timeout, a Stop) in the app's.
 */
export function cliFailureNoticeText(diagnostic: string, options: CliFailureNoticeOptions): string {
  const label = options.label;
  const authProvider = authRequiredProviderLabel(diagnostic);
  if (authProvider) {
    return `${label} could not finish because ${authProvider} needs authorization.`;
  }

  if (options.forceTimeout || /\btimed out after \d+ms\b/i.test(diagnostic)) {
    return `${label} timed out after ${formattedTimeoutDuration(diagnostic, options.defaultTimeoutMs)}.`;
  }

  if (/cancelled|canceled|interrupted|stopped by user/i.test(diagnostic)) {
    return `${label} was cancelled before it returned a response.`;
  }

  if (/\bENOENT\b|command not found|\b(?:sh|bash|zsh|env): [^\n]*not found|no such file or directory/i.test(diagnostic)) {
    return `${label} could not start because the CLI executable is unavailable.`;
  }

  const ended = cliProcessEnd(diagnostic);
  if (ended) {
    return ended.reason
      ? `${label} stopped before it returned a response: ${ended.reason}`
      : `${label} stopped before it returned a response.`;
  }

  const reason = cliFailureReason(diagnostic);
  return reason ? `${label}: ${reason}` : `${label} failed before it returned a response.`;
}

/** The longest reason a failed reply quotes. */
const MAX_FAILURE_REASON_CHARS = 360;
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** Our own words for a turn that failed without the CLI saying why. */
const UNEXPLAINED_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude (?:warm process|code) completed without response content/i, "Claude Code ended the turn without a reply."],
  [/^antigravity (?:cli|native goal) completed without response content/i, "Antigravity ended the turn without a reply."],
  [/^claude warm process (?:returned an error result|reported an error)/i, "Claude Code reported an error without saying what it was."],
  [/^codex app-server (?:reported an error|turn failed)/i, "Codex reported an error without saying what it was."],
  [/^claude warm process emitted invalid JSON/i, "Claude Code wrote output that could not be read."]
];

/** A CLI process that ended under its turn, and what it said (its last words,
 *  else how it ended); undefined when the diagnostic is not that. */
function cliProcessEnd(diagnostic: string): { reason?: string } | undefined {
  if (/\bwrite EPIPE\b|transport channel closed|stdin is closed|process is not running|worker quit with fatal/i.test(diagnostic)) {
    return {};
  }
  const exit = /process exited(?: with code (\d+)| after signal (SIG[A-Z0-9]+))?(?::\s*([\s\S]*))?/i.exec(diagnostic);
  if (!exit) {
    return undefined;
  }
  const said = exit[3] ? cliFailureReason(exit[3]) : undefined;
  if (said) {
    return { reason: said };
  }
  const cli = /codex/i.test(diagnostic) ? "Codex" : /claude/i.test(diagnostic) ? "Claude Code" : "The CLI";
  if (exit[2]) {
    return { reason: `${cli} was ended by ${exit[2]}.` };
  }
  return exit[1] ? { reason: `${cli} exited with code ${exit[1]}.` } : {};
}

/** The sentence of a diagnostic that says what went wrong, on one line; ""
 *  when it holds none (raw CLI events are never shown). */
function cliFailureReason(diagnostic: string): string {
  const text = providerErrorMessage(diagnostic.replace(ANSI_SEQUENCE, "").trim());
  const unexplained = UNEXPLAINED_FAILURES.find(([pattern]) => pattern.test(text));
  if (unexplained) {
    return unexplained[1];
  }
  if (looksLikeRawCliDiagnostic(text.replace(/\\"/g, '"')) || /^[{[]/.test(text)) {
    return "";
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^at\s/.test(line));
  if (lines.length > 3) {
    // A log, not a message: the line that says what went wrong.
    const telling = lines.find((line) => /\b(?:error|failed|cannot|could not|limit|denied|refused|invalid|not supported)\b/i.test(line));
    return truncateOneLine(telling ?? lines[lines.length - 1]!, MAX_FAILURE_REASON_CHARS);
  }
  const telling = lines.length > 1 ? lines.find((line) => /^(?:[a-z]*error|fatal)\b/i.test(line)) : undefined;
  return truncateOneLine(telling ?? lines.join(" "), MAX_FAILURE_REASON_CHARS);
}

/** A provider's error given as its JSON body: the message inside it. */
function providerErrorMessage(text: string): string {
  const start = text.indexOf("{");
  if (start < 0 || !text.endsWith("}")) {
    return text;
  }
  let body: unknown;
  try {
    body = JSON.parse(text.slice(start));
  } catch {
    return text;
  }
  const record = body as { message?: unknown; error?: unknown } | null;
  const error = record?.error as { message?: unknown } | string | undefined;
  const message = typeof error === "string" ? error : error?.message ?? record?.message;
  if (typeof message !== "string" || !message.trim()) {
    return text;
  }
  // "API Error: 400 {…}" keeps its own words before the body.
  return `${text.slice(0, start).trim()} ${message.trim()}`.trim();
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

function summarizePlainCliFailureDiagnostic(warning: string): string | undefined {
  const parsed = warning.match(/^(@?[A-Za-z][A-Za-z0-9 ._-]{1,79}|@[A-Za-z0-9._-]{1,79}):\s+([\s\S]+)$/);
  const label = parsed?.[1]?.trim() ?? "CLI agent";
  const diagnostic = parsed?.[2]?.trim() ?? warning;
  if (!looksLikePlainCliFailure(diagnostic)) {
    return undefined;
  }
  return cliFailureNoticeText(diagnostic, { label });
}

function looksLikePlainCliFailure(diagnostic: string): boolean {
  return (
    /AuthRequired|www_authenticate|oauth-protected-resource/i.test(diagnostic) ||
    /\b(?:codex|claude|gemini|agy|antigravity)(?:\s+\S+){0,4}\s+timed out after \d+ms\b/i.test(diagnostic) ||
    /write EPIPE|transport channel closed|stdin is closed|process exited|process is not running|worker quit with fatal/i.test(diagnostic) ||
    /session limit|rate limit|quota/i.test(diagnostic) ||
    /ENOENT|command not found|no such file or directory/i.test(diagnostic)
  );
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

function authRequiredProviderLabel(diagnostic: string): string | undefined {
  if (!/AuthRequired|www_authenticate|oauth-protected-resource/i.test(diagnostic)) {
    return undefined;
  }

  const urlMatch = diagnostic.match(/https?:\/\/([^/\s"\\]+)/i);
  const host = urlMatch?.[1]?.toLowerCase();
  if (!host) {
    return "a connected MCP server";
  }
  if (host.includes("slack.com")) {
    return "the Slack MCP server";
  }
  return `${host} MCP server`;
}

function formattedTimeoutDuration(diagnostic: string, defaultTimeoutMs = CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS): string {
  const match = diagnostic.match(/\btimed out after (\d+)ms\b/i);
  const timeoutMs = match ? Number(match[1]) : defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return formattedDuration(defaultTimeoutMs);
  }
  return formattedDuration(timeoutMs);
}

function formattedDuration(timeoutMs: number): string {
  const hours = timeoutMs / (60 * 60_000);
  if (Number.isInteger(hours) && hours >= 1) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = timeoutMs / 60_000;
  if (Number.isInteger(minutes) && minutes >= 1) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.round(timeoutMs / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function truncateOneLine(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
