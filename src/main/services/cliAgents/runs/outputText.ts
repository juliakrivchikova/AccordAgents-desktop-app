import type { ChatAgentActivityEvent, ChatAgentActivityKind, ParticipantConfig } from "../../../../shared/types";
import { CommandError } from "../../command";
import { MAX_CLI_ERROR_CHARS } from "../constants";
import { asRecord, stringField } from "./records";
import type { CliAgentCompactResult, CliAgentOutputCallback, CliAgentOutputKind, CliAgentSessionIdCallback } from "../types";

const MAX_CLI_ERROR_LINES = 8;
const MAX_CLI_EVENT_SUMMARIES = 2;

export function reportSessionId(onSessionId: CliAgentSessionIdCallback | undefined, sessionId: string | undefined): void {
  const normalized = sessionId?.trim();
  if (!normalized) {
    return;
  }
  onSessionId?.(normalized);
}

export function emitLiveOutput(
  onOutput: CliAgentOutputCallback | undefined,
  kind: CliAgentOutputKind,
  text: string,
  cumulative?: string,
  activity?: {
    activityKind?: ChatAgentActivityKind;
    activityStatus?: ChatAgentActivityEvent["status"];
    activityDetail?: string;
    activityItemId?: string;
  }
): void {
  const clean = cleanLiveOutputText(text);
  if (!onOutput || !clean) {
    return;
  }
  const cleanCumulative = cumulative !== undefined ? cleanLiveOutputText(cumulative) : undefined;
  onOutput({ kind, text: clean, cumulative: cleanCumulative, ...activity });
}

function cleanLiveOutputText(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function isResumeMiss(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return /resume|session|conversation|thread/.test(message) && /not found|missing|unknown|cannot|can't|no .*session|no .*found|does not exist/.test(message);
}

export function failedCompact(participant: ParticipantConfig, error: unknown): CliAgentCompactResult {
  return {
    participant,
    ok: false,
    error: errorText(error)
  };
}

export function isTimeoutError(error: unknown, diagnostic: string): boolean {
  return (
    (error instanceof CommandError && error.result.timedOut) ||
    /\btimed out after \d+ms\b/i.test(diagnostic)
  );
}

export function errorText(error: unknown): string {
  if (error instanceof CommandError) {
    return commandErrorText(error);
  }
  return truncateText(error instanceof Error ? error.message : String(error), MAX_CLI_ERROR_CHARS);
}

export function commandErrorText(error: CommandError): string {
  const base = error.message.trim();
  const stderr = cleanCommandOutput(error.result.stderr);
  if (stderr) {
    return truncateText(`${base}: ${stderr}`, MAX_CLI_ERROR_CHARS);
  }

  const structuredSummary = summarizeStructuredOutput(error.result.stdout);
  if (structuredSummary) {
    return truncateText(`${base}. ${structuredSummary}`, MAX_CLI_ERROR_CHARS);
  }

  const stdout = cleanCommandOutput(error.result.stdout);
  if (stdout) {
    return truncateText(`${base}. Output: ${stdout}`, MAX_CLI_ERROR_CHARS);
  }

  return base;
}

function summarizeStructuredOutput(stdout: string): string | undefined {
  const summaries: string[] = [];
  let sawStructuredOutput = false;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const summary = summarizeStructuredEvent(JSON.parse(trimmed));
      sawStructuredOutput = true;
      if (summary) {
        summaries.push(summary);
        if (summaries.length > MAX_CLI_EVENT_SUMMARIES) {
          summaries.shift();
        }
      }
    } catch {
      // Non-JSON stdout is handled by cleanCommandOutput.
    }
  }

  if (summaries.length > 0) {
    return `No stderr was reported; CLI stdout contained structured events only. Last events: ${summaries.join(" | ")}.`;
  }
  if (sawStructuredOutput) {
    return "No stderr was reported. CLI stdout only contained structured events.";
  }
  return undefined;
}

function summarizeStructuredEvent(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }

  const type = stringField(record, "type") ?? "event";
  const message =
    stringField(record, "message") ??
    stringField(record, "error") ??
    (record.is_error === true
      ? stringField(record, "result") ?? stringField(record, "content")
      : undefined);
  if (message) {
    return `${type}: ${truncateText(message, 90)}`;
  }

  const item = asRecord(record.item);
  if (item) {
    const itemType = stringField(item, "type") ?? "item";
    const status = stringField(item, "status");
    const command = stringField(item, "command");
    const exitCode = typeof item.exit_code === "number" ? ` exit ${item.exit_code}` : "";
    const statusText = status ? ` ${status}` : "";
    if (command) {
      return `${type}/${itemType}${statusText}${exitCode}: ${truncateText(command, 90)}`;
    }
    return `${type}/${itemType}${statusText}${exitCode}`;
  }

  const threadId = stringField(record, "thread_id");
  if (threadId) {
    return `${type}: ${threadId}`;
  }
  return type;
}

function cleanCommandOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }
  const selected = lines.slice(0, MAX_CLI_ERROR_LINES);
  if (lines.length > selected.length) {
    selected.push(`[${lines.length - selected.length} more output lines omitted]`);
  }
  return selected.join("\n");
}

export function truncateText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}... [truncated ${trimmed.length - maxChars} chars]`;
}
