import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeContextWindowFromResult,
  claudeMainThreadContext,
  codexContextFromEvent,
  isClaudeCompactBoundary
} from "./cliContextUsage";
import { compactionCardEnding } from "../../shared/compactionCard";
import {
  buildAgentContextUsage,
  contextUsedPercentage,
  contextWindowForModel,
  formatContextUsageLabel,
  normalizeAgentContextUsage
} from "../../shared/agentContext";

// Shapes and figures from real runs on 2026-11-22: Claude Code 2.1.330 with
// --model sonnet (two turns: three Reads, then one Bash) answered
// get_context_usage and `/context` with 62,995 then 63,224 of 1,000,000.
const claudeCall = (usage: { input: number; creation: number; read: number }, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  parent_tool_use_id: null,
  session_id: "ee24b284",
  message: {
    id: "msg_1",
    model: "claude-sonnet-5-5",
    role: "assistant",
    content: [{ type: "text", text: "…" }],
    usage: { input_tokens: usage.input, cache_creation_input_tokens: usage.creation, cache_read_input_tokens: usage.read, output_tokens: 39 }
  },
  ...extra
});

test("Claude: the context is the main thread's last call, never the result's sum of the turn", () => {
  const turn = [
    claudeCall({ input: 2, creation: 18112, read: 11844 }),
    claudeCall({ input: 2, creation: 30805, read: 29956 }),
    claudeCall({ input: 2, creation: 1756, read: 60761 }),
    claudeCall({ input: 2, creation: 313, read: 62517 }),
    claudeCall({ input: 2, creation: 163, read: 62830 }),
    {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 10, cache_creation_input_tokens: 51149, cache_read_input_tokens: 227908, output_tokens: 624 },
      modelUsage: { "claude-sonnet-5-5": { contextWindow: 1_000_000 } }
    }
  ];
  let used: number | undefined;
  for (const event of turn) used = claudeMainThreadContext(event)?.usedTokens ?? used;
  assert.equal(used, 62_995, "what the CLI's /context showed for this turn (the result's sum is 279,067)");
  assert.equal(claudeMainThreadContext(turn[5]), undefined);
  assert.equal(claudeContextWindowFromResult(turn[5], "claude-sonnet-5-5"), 1_000_000);
});

test("Claude: a subagent's calls, sidechain log lines and synthetic messages are not the member's context", () => {
  assert.equal(claudeMainThreadContext(claudeCall({ input: 2, creation: 0, read: 150_000 }, { parent_tool_use_id: "toolu_sub" })), undefined);
  assert.equal(claudeMainThreadContext(claudeCall({ input: 2, creation: 0, read: 150_000 }, { isSidechain: true })), undefined);
  assert.equal(claudeMainThreadContext({ type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } }), undefined);
  assert.deepEqual(
    claudeMainThreadContext({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 4, cache_creation_input_tokens: 77, cache_read_input_tokens: 62993 } } } }),
    { usedTokens: 63074, model: "claude-sonnet-5-5" }
  );
  assert.equal(claudeMainThreadContext({ type: "stream_event", parent_tool_use_id: "toolu_sub", event: { type: "message_start", message: { usage: { input_tokens: 9 } } } }), undefined);
  assert.equal(claudeMainThreadContext({ type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 2, output_tokens: 300 } } }), undefined);
  assert.equal(claudeMainThreadContext({ type: "control_response", response: { response: { totalTokens: 63224 } } }), undefined);
  assert.equal(isClaudeCompactBoundary({ type: "system", subtype: "compact_boundary" }), true);
});

test("Claude: the window is the CLI's own for the main model", () => {
  const result = { type: "result", modelUsage: { "claude-sonnet-5-5": { contextWindow: 1_000_000 }, "claude-haiku-4-5": { contextWindow: 200_000 } } };
  assert.equal(claudeContextWindowFromResult(result, "claude-sonnet-5-5"), 1_000_000);
  assert.equal(claudeContextWindowFromResult(result, "claude-haiku-4-5"), 200_000);
  assert.equal(claudeContextWindowFromResult(result, "claude-sonnet-5-5[1m]"), 1_000_000);
  assert.equal(claudeContextWindowFromResult(result, "sonnet"), undefined, "two models and no match: the map decides");
  assert.equal(claudeContextWindowFromResult({ type: "result", modelUsage: { "claude-haiku-4-5": { contextWindow: 200_000 } } }, "haiku"), 200_000);
  assert.equal(claudeContextWindowFromResult({ type: "assistant" }, "claude-sonnet-5-5"), undefined);
});

test("Claude model windows match what Claude Code 2.1.330 reports", () => {
  assert.equal(contextWindowForModel("claude-code", "claude-sonnet-5-5"), 1_000_000);
  assert.equal(contextWindowForModel("claude-code", "claude-opus-5-5"), 1_000_000);
  assert.equal(contextWindowForModel("claude-code", "claude-haiku-5-5"), 1_000_000);
  assert.equal(contextWindowForModel("claude-code", "claude-haiku-4-5"), 200_000);
  assert.equal(contextWindowForModel("claude-code", "claude-haiku-4-5-20251001"), 200_000);
  assert.equal(contextWindowForModel("claude-code", "claude-sonnet-4-5[1m]"), 1_000_000);
  assert.equal(contextWindowForModel("claude-code", "haiku"), 1_000_000);
  assert.equal(contextWindowForModel("claude-code", "claude-opus-4-8"), 1_000_000);
});

test("Codex: the context is the last call's total against Codex's own window", () => {
  // codex 0.155.1 rollout (gpt-5.6-luna), and the app-server notification.
  assert.deepEqual(
    codexContextFromEvent({ type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { total_tokens: 45099 },
      last_token_usage: { input_tokens: 23405, cached_input_tokens: 21376, output_tokens: 5, total_tokens: 23410 },
      model_context_window: 258400
    } } }),
    { usedTokens: 23410, contextWindowTokens: 258400 }
  );
  assert.deepEqual(
    codexContextFromEvent({ method: "thread/tokenUsage/updated", params: { threadId: "t", turnId: "u", tokenUsage: {
      total: { totalTokens: 65_320_914 }, last: { totalTokens: 151_216 }, modelContextWindow: 258400
    } } }),
    { usedTokens: 151_216, contextWindowTokens: 258400 }
  );
  assert.equal(codexContextFromEvent({ type: "event_msg", payload: { type: "token_count", info: null, rate_limits: {} } }), undefined);
  // exec --json: the turn's summed usage is not the context.
  assert.equal(codexContextFromEvent({ type: "turn.completed", usage: { input_tokens: 44961, cached_input_tokens: 32000, output_tokens: 138 } }), undefined);
});

test("Codex's percentage is its own: 100 minus its '% context left', which leaves the 12k baseline out", () => {
  // The app's QA chat on 2026-11-22: 39,344 of 258,400; Codex's /status says "89% left".
  const usage = buildAgentContextUsage({ usedTokens: 39_344, contextWindowTokens: 258_400, source: "codex-cli" });
  assert.equal(usage?.percentage, 11);
  assert.equal(formatContextUsageLabel(usage!), "89% left (39k used / 258k tokens)");
  assert.equal(contextUsedPercentage("codex-cli", 5_519, 258_400), 0, "below the baseline Codex says 100% left");
  assert.equal(contextUsedPercentage("codex-cli", 258_400, 258_400), 100);
  assert.equal(contextUsedPercentage("codex-cli", 10_000, 12_000), 100);
});

test("Claude's percentage rounds used / window as /context does", () => {
  assert.equal(contextUsedPercentage("claude-code", 104_545, 1_000_000), 10);
  assert.equal(contextUsedPercentage("claude-code", 107_843, 1_000_000), 11);
  assert.equal(contextUsedPercentage("claude-code", 97_902, 200_000), 49);
  const usage = buildAgentContextUsage({ usedTokens: 71_400, contextWindowTokens: 1_000_000, source: "claude-code" });
  assert.equal(formatContextUsageLabel(usage!), "93% left (71k used / 1M tokens)");
});

test("A Codex figure stored by an older build reads with Codex's percentage", () => {
  const stored = { usedTokens: 39_344, contextWindowTokens: 258_400, percentage: 15, source: "codex-cli", updatedAt: "2026-11-22T06:43:12.109Z" };
  assert.equal(normalizeAgentContextUsage(stored)?.percentage, 11);
});

test("a compaction card ends as the folded line says it, for every outcome", () => {
  const cases: Array<[Parameters<typeof compactionCardEnding>[0], { ended: string; detail?: string }]> = [
    [{ status: "approved", approvalScope: "once" }, { ended: "Compact" }],
    [{ status: "approved" }, { ended: "Compact" }],
    [{ status: "approved", approvalScope: "chat" }, { ended: "Compact · Don't ask again in this chat" }],
    [{ status: "auto-applied" }, { ended: "Compact" }],
    [{ status: "denied" }, { ended: "Not now" }],
    [{ status: "denied", error: "Context compaction is already queued or running for @drew." }, { ended: "Not compacted", detail: "Context compaction is already queued or running for @drew." }],
    [{ status: "expired" }, { ended: "Expired" }],
    [{ status: "cancelled", error: "@drew left." }, { ended: "Cancelled", detail: "@drew left." }]
  ];
  for (const [approval, expected] of cases) assert.deepEqual(compactionCardEnding(approval), expected, JSON.stringify(approval));
});
