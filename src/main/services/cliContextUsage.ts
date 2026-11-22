/**
 * How full a member's context is, read from its CLI's own events the way the
 * CLI itself reads them — one explicit shape per CLI, never "any usage field
 * found anywhere in an event".
 *
 * Claude Code (verified on 2.1.330): `/context` and the `get_context_usage`
 * control request report the input of the main thread's latest model call —
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of
 * that call's `usage` — against the window the CLI uses for the model, which
 * its `result` event reports per model (`modelUsage[model].contextWindow`).
 * The `result` event's own `usage` is the sum of every call of the turn (4×
 * the context after a turn of four tool calls), and a subagent's calls
 * (`parent_tool_use_id`, or `isSidechain` in the session log) fill the
 * subagent's context, not the member's: neither is the context.
 *
 * Codex (0.155.1): the context is `last_token_usage.total_tokens` (app-server:
 * `tokenUsage.last.totalTokens`) against `model_context_window`, from its
 * token-count events; after a compaction Codex sends one with its estimate of
 * the new history. `codex exec --json`'s `turn.completed.usage` sums the
 * turn's calls and is not the context.
 */

export interface CliContextReading {
  usedTokens?: number;
  contextWindowTokens?: number;
  model?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A Claude model id as `modelUsage` keys it: lower case, without the CLI's
 *  `[1m]` window suffix. */
export function claudeCanonicalModelId(model: string | undefined): string | undefined {
  const id = model?.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
  return id || undefined;
}

/** The context one Claude Code event (stream-json line, or a line of its
 *  session log) shows the member's conversation fills: only an assistant
 *  message of the main thread, or the `message_start` of its streamed call,
 *  carries it. Undefined for every other event, a subagent's call, and a
 *  call that reports no input (a synthetic message). */
export function claudeMainThreadContext(event: unknown): CliContextReading | undefined {
  const record = asRecord(event);
  if (!record || record.isSidechain === true || text(record.parent_tool_use_id)) {
    return undefined;
  }
  let message: Record<string, unknown> | undefined;
  if (record.type === "assistant") {
    message = asRecord(record.message);
  } else if (record.type === "stream_event") {
    const streamEvent = asRecord(record.event);
    message = streamEvent?.type === "message_start" ? asRecord(streamEvent.message) : undefined;
  }
  const usage = asRecord(message?.usage);
  if (!usage) {
    return undefined;
  }
  const usedTokens =
    nonNegativeNumber(usage.input_tokens) +
    nonNegativeNumber(usage.cache_creation_input_tokens) +
    nonNegativeNumber(usage.cache_read_input_tokens);
  if (usedTokens <= 0) {
    return undefined;
  }
  const model = text(message?.model);
  return { usedTokens, ...(model && model !== "<synthetic>" ? { model } : {}) };
}

/** The window the CLI uses for the member's model, from a `result` event's
 *  `modelUsage` — the main model's entry when the turn also ran another
 *  model (a subagent on Haiku, say); the only entry when there is one. */
export function claudeContextWindowFromResult(event: unknown, model: string | undefined): number | undefined {
  const record = asRecord(event);
  if (!record || record.type !== "result") {
    return undefined;
  }
  const modelUsage = asRecord(record.modelUsage);
  if (!modelUsage) {
    return undefined;
  }
  const entries = Object.entries(modelUsage);
  const exact = model?.trim().toLowerCase();
  const wanted = claudeCanonicalModelId(model);
  // The model's own entry first (`opus[1m]` and `opus` can both be there
  // after a switch), then its id without the window suffix.
  const match = (exact ? entries.find(([id]) => id.trim().toLowerCase() === exact) : undefined)
    ?? (wanted ? entries.find(([id]) => claudeCanonicalModelId(id) === wanted) : undefined)
    ?? (entries.length === 1 ? entries[0] : undefined);
  return positiveNumber(asRecord(match?.[1])?.contextWindow);
}

/** Whether a Claude Code session-log line is a compaction boundary: usage
 *  recorded before it describes the conversation before it was summarized. */
export function isClaudeCompactBoundary(event: unknown): boolean {
  const record = asRecord(event);
  return Boolean(record && (record.subtype === "compact_boundary" || record.isCompactSummary === true));
}

/** The context one Codex event reports: an app-server
 *  `thread/tokenUsage/updated` notification or a rollout `token_count`
 *  event. Undefined for every other event, and for a token-count event that
 *  carries only rate limits. */
export function codexContextFromEvent(event: unknown): CliContextReading | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  if (record.method === "thread/tokenUsage/updated") {
    const tokenUsage = asRecord(asRecord(record.params)?.tokenUsage);
    const last = asRecord(tokenUsage?.last);
    const usedTokens = positiveNumber(last?.totalTokens);
    const contextWindowTokens = positiveNumber(tokenUsage?.modelContextWindow);
    return usedTokens || contextWindowTokens ? { usedTokens, contextWindowTokens } : undefined;
  }
  const payload = asRecord(record.payload) ?? asRecord(record.msg) ?? asRecord(asRecord(record.params)?.msg);
  const info = payload?.type === "token_count" ? asRecord(payload.info) : undefined;
  if (!info) {
    return undefined;
  }
  const usedTokens = positiveNumber(asRecord(info.last_token_usage)?.total_tokens);
  const contextWindowTokens = positiveNumber(info.model_context_window);
  return usedTokens || contextWindowTokens ? { usedTokens, contextWindowTokens } : undefined;
}
