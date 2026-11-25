import type { ParticipantConfig } from "../../../../shared/types";
import { buildAgentContextUsage, contextWindowForModel } from "../../../../shared/agentContext";
import { claudeContextWindowFromResult, claudeMainThreadContext } from "../../cliContextUsage";
import type { ParticipantRunResult } from "../../providers";
import { CLAUDE_WARM_CANCELLED_MESSAGE, COMPACTION_CANCELLED } from "./constants";
import {
  claudeAssistantMessageUuid, claudeWarmTextBlockStarted, emitClaudeToolRows, isClaudeWarmResult, noteClaudeToolContext
} from "./replies";
import type { ClaudeOneShotStreamState, ClaudePermissionDenialDiagnostic } from "./types";
import { textWithAgentMessageBoundary } from "../codex/appServerText";
import { findModelId } from "../models/modelLists";
import { emitLiveOutput, failedCompact, reportSessionId, truncateText } from "../runs/outputText";
import { asRecord, findSessionId, stringField, uuidText } from "../runs/records";
import type { ClaudePermissionDenialLayer, CliAgentCompactResult, CliAgentRunOptions, WarmAgentEntry } from "../types";
import { extractClaudeStreamEventTextDelta, extractClaudeWarmAssistantText } from "./streamText";

export async function compactClaudeThroughProcess(
  entry: WarmAgentEntry,
  participant: ParticipantConfig,
  compactPrompt: string,
  signal: AbortSignal | undefined,
  options: CliAgentRunOptions,
  timeoutMs: number
): Promise<CliAgentCompactResult> {
  const boundaryBefore = entry.lastCompactBoundary?.()?.count ?? 0;
  let result: ParticipantRunResult;
  try {
    // The member's observers, as on its turns: a process started for this
    // compaction reports the background work and the replies it starts on
    // its own later exactly as one a turn started.
    result = await entry.run(compactPrompt, signal, undefined, options.onSessionId, timeoutMs,
      undefined, undefined, {
        allowEmptyContent: true,
        localCommand: true,
        onSelfResumedTurn: options.warm?.onSelfResumedTurn,
        onBackgroundTasksChanged: options.warm?.onBackgroundTasksChanged
      });
  } catch (error) {
    return signal?.aborted || (error instanceof Error && error.message === CLAUDE_WARM_CANCELLED_MESSAGE)
      ? { participant, ok: false, error: COMPACTION_CANCELLED }
      : failedCompact(participant, error);
  }
  const boundary = entry.lastCompactBoundary?.();
  const compacted = (boundary?.count ?? 0) > boundaryBefore;
  if (!compacted && signal?.aborted) {
    // Stopped: the CLI ends the command with its own "Compaction canceled."
    // as a successful reply; the outcome is the one every Stop of a
    // compaction gives, whenever it lands.
    return { participant, ok: false, sessionId: result.sessionId, error: COMPACTION_CANCELLED, providerNative: true };
  }
  if (!result.ok) {
    return { participant, ok: false, sessionId: result.sessionId, error: result.error, providerNative: true };
  }
  if (!compacted) {
    // The CLI answered without compacting ("Error: No messages to
    // compact", say): what it said is the outcome, as in its own terminal.
    const said = (result.content ?? "").trim().replace(/^error:\s*/i, "");
    return { participant, ok: false, sessionId: result.sessionId, error: said || "The CLI did not compact the conversation", providerNative: true };
  }
  // The CLI's own count after compacting; failing that, its compaction
  // figure for the conversation (which leaves out the system prompt).
  const contextUsage = await entry.contextUsage?.(signal) ?? buildAgentContextUsage({
    usedTokens: boundary?.postTokens,
    contextWindowTokens: contextWindowForModel(participant.kind, participant.model),
    source: "claude-code",
    model: participant.model
  });
  return {
    participant,
    ok: true,
    sessionId: result.sessionId,
    ...(contextUsage ? { contextUsage } : {}),
    providerNative: true,
    content: result.content
  };
}

export function handleClaudeOneShotStreamChunk(
  chunk: string,
  state: ClaudeOneShotStreamState,
  participant: ParticipantConfig,
  options: CliAgentRunOptions
): void {
  state.buffer += chunk;
  let newline = state.buffer.indexOf("\n");
  while (newline >= 0) {
    const line = state.buffer.slice(0, newline).trimEnd();
    state.buffer = state.buffer.slice(newline + 1);
    if (line.trim()) {
      handleClaudeOneShotStreamLine(line, state, participant, options);
    }
    newline = state.buffer.indexOf("\n");
  }
}

export function handleClaudeOneShotStreamLine(
  line: string,
  state: ClaudeOneShotStreamState,
  participant: ParticipantConfig,
  options: CliAgentRunOptions
): void {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    state.error = `claude native goal emitted invalid JSON: ${line.slice(0, 120)}`;
    return;
  }
  state.sessionId = findSessionId(event) ?? state.sessionId;
  reportSessionId(options.onSessionId, state.sessionId);
  state.model = findModelId(event) ?? state.model ?? participant.model;
  const context = claudeMainThreadContext(event);
  if (context) {
    state.usedTokens = context.usedTokens;
    state.contextModel = context.model ?? state.contextModel;
  }
  state.contextWindowTokens = claudeContextWindowFromResult(event, state.contextModel ?? state.model) ?? state.contextWindowTokens;
  state.error = claudeWarmStreamError(event) ?? state.error;
  const record = asRecord(event);
  if (record && stringField(record, "type") === "system" && stringField(record, "subtype") === "init") {
    noteClaudeToolContext(record, state.toolContext);
  }
  emitClaudeToolRows(options.onOutput, event, state.toolContext);
  if (claudeWarmTextBlockStarted(event) && state.streamedText.trim()) {
    state.nextTextBlockStartsBlock = true;
  }
  const streamDelta = extractClaudeStreamEventTextDelta(event);
  if (streamDelta) {
    if (state.nextTextBlockStartsBlock) {
      state.streamedText = textWithAgentMessageBoundary(state.streamedText, streamDelta);
      state.nextTextBlockStartsBlock = false;
    }
    state.streamedText += streamDelta;
    emitLiveOutput(options.onOutput, "text", streamDelta, state.streamedText);
  }
  const assistantText = extractClaudeWarmAssistantText(event);
  if (assistantText) {
    state.messages.push(assistantText);
  }
  state.lastAssistantUuid = claudeAssistantMessageUuid(event) ?? state.lastAssistantUuid;
  if (isClaudeWarmResult(event)) {
    state.resultEvent = event;
  }
}

export function claudeWarmStreamError(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  const type = stringField(record, "type");
  if (type === "error") {
    const error = record.error;
    if (typeof error === "string") {
      return error;
    }
    const errorRecord = asRecord(error);
    return stringField(errorRecord ?? {}, "message") ?? stringField(record, "message") ?? "claude warm process reported an error";
  }
  if (type === "result" && record.is_error === true) {
    const errors = Array.isArray(record.errors) ? record.errors.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
    return stringField(record, "result") ?? stringField(record, "error") ??
      (errors.length > 0 ? errors.join(" ") : "claude warm process returned an error result");
  }
  return undefined;
}

export function claudePermissionDenials(raw: unknown): ClaudePermissionDenialDiagnostic[] {
  let value = raw;
  if (typeof raw === "string") {
    const candidates = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("{"));
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      try {
        value = JSON.parse(candidates[index] as string) as unknown;
        break;
      } catch {
        // Keep scanning earlier JSON lines.
      }
    }
  }
  const record = asRecord(value);
  const items = Array.isArray(record?.permission_denials) ? record.permission_denials : [];
  return items.flatMap((item): ClaudePermissionDenialDiagnostic[] => {
    const denial = asRecord(item);
    if (!denial) {
      return [];
    }
    const toolName = stringField(denial, "tool_name") ??
      stringField(denial, "toolName") ??
      stringField(denial, "name") ??
      "unknown-tool";
    const stage = claudeDenialStage(denial);
    return [{
      toolName: truncateText(toolName, 120),
      layer: stage.layer,
      decisionCode: claudeDenialDecisionCode(denial),
      ...(stage.missingEvidence ? { missingEvidence: stage.missingEvidence } : {})
    }];
  });
}

function claudeDenialStage(denial: Record<string, unknown>): {
  layer: ClaudePermissionDenialLayer;
  missingEvidence?: string[];
} {
  const stage = stringField(denial, "stage") ??
    stringField(denial, "source") ??
    stringField(denial, "category") ??
    stringField(denial, "layer");
  if (!stage) {
    // The provider's structured permission_denials envelope is itself evidence
    // for the native permission/classifier layer.
    return { layer: "provider-native-permission-or-classifier" };
  }
  const normalized = stage.trim().toLowerCase();
  if (/sandbox|filesystem|file-system|\bos\b/.test(normalized)) {
    return { layer: "provider-sandbox-settings-or-os" };
  }
  if (/permission|classifier|approval|policy/.test(normalized)) {
    return { layer: "provider-native-permission-or-classifier" };
  }
  return {
    layer: "unknown-provider-runtime",
    missingEvidence: ["recognized denial stage/category"]
  };
}

function claudeDenialDecisionCode(denial: Record<string, unknown>): string {
  for (const field of ["reason_code", "decision_code", "code", "decision", "status"]) {
    const value = stringField(denial, field)?.trim().toLowerCase();
    if (value && /^[a-z0-9_.:-]{1,80}$/.test(value)) {
      return value;
    }
  }
  return "permission_denied";
}

export function claudeDenialLayerLabel(layer: ClaudePermissionDenialLayer): string {
  if (layer === "provider-sandbox-settings-or-os") {
    return "the provider sandbox/settings or OS layer";
  }
  if (layer === "unknown-provider-runtime") {
    return "an unknown provider/runtime layer";
  }
  return "the native permission/classifier layer";
}

/** A Claude Code `--output-format json` result (it names each model's
 *  window in `modelUsage`); undefined for any other output. */
export function claudeJsonResult(stdout: string): { resultEvent: unknown } | undefined {
  try {
    const event = JSON.parse(stdout) as unknown;
    return asRecord(event)?.type === "result" ? { resultEvent: event } : undefined;
  } catch {
    return undefined;
  }
}

export function extractClaudeText(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { result?: string; content?: string; message?: string };
    return parsed.result ?? parsed.content ?? parsed.message ?? stdout.trim();
  } catch {
    return stdout.trim();
  }
}

export function extractClaudeSessionId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { session_id?: string; sessionId?: string };
    return uuidText(parsed.session_id) ?? uuidText(parsed.sessionId);
  } catch {
    return undefined;
  }
}
