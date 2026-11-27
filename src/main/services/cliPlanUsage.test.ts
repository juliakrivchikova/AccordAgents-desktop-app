import assert from "node:assert/strict";
import test from "node:test";

import {
  antigravityPlanUsage, claudePlanUsage, codexPlanUsage, codexWindowLabel, mergeClaudeRateLimitEvent, mergeCodexRateLimitsUpdate
} from "./cliPlanUsage";

// The shapes below are the CLIs' real answers on 2026-11-27 (ids removed):
// Claude Code 2.1.329 `get_usage` on a Max plan, Codex 0.155
// `account/rateLimits/read` on Pro Lite, agy 1.5 `/usage --output-format json`.
const claudeGetUsage = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: { utilization: 89, resets_at: "2026-11-29T16:00:00.251735+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, currency: null },
    limits: [
      { kind: "weekly_all", group: "weekly", percent: 89, severity: "warning", resets_at: "2026-11-29T16:00:00.251735+00:00", scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 23, severity: "normal", resets_at: "2026-11-29T16:00:00.251974+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false }
    ],
    model_scoped: [{ display_name: "Fable", utilization: 23, resets_at: "2026-11-29T16:00:00.251974+00:00" }]
  }
};

const rateLimitEvent = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" });

test("Claude: /usage's rows, the server's severity and headline, and an event newer than the read", () => {
  const read = claudePlanUsage({ usage: { value: claudeGetUsage, at: "2026-11-27T10:00:00.000Z" } });
  assert.deepEqual(read?.windows.map((w) => [w.label, w.usedPercent, w.tone]), [
    ["Current week (all models)", 89, "warning"],
    ["Current week (Fable)", 23, "normal"]
  ]);
  assert.equal(read?.plan, "Max plan");
  assert.equal(read?.headlineId, "seven_day");
  assert.deepEqual(read?.facts, [{ label: "Extra usage", value: "Off" }]);
  assert.equal(read?.refused, undefined);

  // A response later the CLI says the week is used up and requests are refused.
  const readAt = { value: claudeGetUsage, at: "2026-11-27T10:00:00.000Z" };
  const refused = claudePlanUsage(mergeClaudeRateLimitEvent({ usage: readAt }, rateLimitEvent({
    status: "rejected", rateLimitType: "seven_day", utilization: 1, resetsAt: 1796306400,
    unifiedWindows: {
      five_hour: { utilization: 0.12, resetsAt: 1796220000, status: "allowed" },
      seven_day: { utilization: 1, resetsAt: 1796306400, status: "rejected" }
    }
  }), "2026-11-27T10:05:00.000Z"));
  assert.deepEqual(refused?.windows.map((w) => [w.id, w.usedPercent, w.tone]), [
    ["five_hour", 12, "normal"], ["seven_day", 100, "reached"], ["model:Fable", 23, "normal"]
  ]);
  assert.equal(refused?.refused, true);
  assert.equal(refused?.headlineId, "seven_day");

  // Extra usage covers it: past the limit, but not refused.
  const covered = claudePlanUsage(mergeClaudeRateLimitEvent({}, rateLimitEvent({
    status: "rejected", overageStatus: "allowed", rateLimitType: "seven_day",
    unifiedWindows: { seven_day: { utilization: 1.02, resetsAt: 1796306400, status: "rejected" } }
  }), "2026-11-27T10:05:00.000Z"));
  assert.deepEqual(covered?.windows.map((w) => [w.usedPercent, w.tone]), [[100, "warning"]]);
  assert.equal(covered?.refused, undefined);
});

test("Claude: a model's own limit refuses, leads, and stays through later events about other windows", () => {
  const usage = { value: claudeGetUsage, at: "2026-11-27T10:00:00.000Z" };
  // The "Fable limit" in Claude Code, while the general windows are fine.
  const byModel = mergeClaudeRateLimitEvent({ usage }, rateLimitEvent({
    status: "rejected", rateLimitType: "seven_day_overage_included", utilization: 1, resetsAt: 1796306400,
    unifiedWindows: {
      five_hour: { utilization: 0.12, resetsAt: 1796220000, status: "allowed" },
      seven_day: { utilization: 0.4, resetsAt: 1796306400, status: "allowed" }
    }
  }), "2026-11-27T10:05:00.000Z");
  const first = claudePlanUsage(byModel);
  assert.deepEqual(first?.windows.find((w) => w.id === "model:Fable"), {
    id: "model:Fable", label: "Current week (Fable)", model: "Fable", usedPercent: 100, resetsAt: "2026-12-03T14:00:00.000Z", tone: "reached"
  });
  assert.equal(first?.headlineId, "model:Fable");
  assert.equal(first?.refused, true);
  // An Opus reply later reports only the general windows: Fable is still used up.
  const later = claudePlanUsage(mergeClaudeRateLimitEvent(byModel, rateLimitEvent({
    status: "allowed", rateLimitType: "seven_day",
    unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1796220000, status: "allowed" }, seven_day: { utilization: 0.41, resetsAt: 1796306400, status: "allowed" } }
  }), "2026-11-27T10:10:00.000Z"));
  assert.deepEqual(later?.windows.map((w) => [w.id, w.usedPercent, w.tone]), [
    ["five_hour", 15, "normal"], ["seven_day", 41, "normal"], ["model:Fable", 100, "reached"]
  ]);
});

test("Claude: an account without plan limits, and an event that reports none", () => {
  assert.equal(claudePlanUsage({ usage: { value: { rate_limits_available: false, rate_limits: null }, at: "2026-11-27T10:00:00.000Z" } })?.hasPlanLimits, false);
  // API-key sessions' events carry no windows: nothing to show.
  assert.equal(claudePlanUsage(mergeClaudeRateLimitEvent({}, rateLimitEvent({ status: "allowed" }), "2026-11-27T10:00:00.000Z")), undefined);
});

const codexRead = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: "codex", limitName: null, normalModelSlug: null,
    primary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1796306815 },
    secondary: null,
    credits: { hasCredits: true, unlimited: false, balance: "61409.5644690000" },
    individualLimit: null, spendControlReached: false, planType: "prolite", rateLimitReachedType: null
  },
  rateLimitResetCredits: { availableCount: 2, credits: null },
  accountId: "account-id",
  rateLimitUpsell: null
};

test("Codex: its windows by length, plan and credits; the warning from 75%; a refusal", () => {
  const read = codexPlanUsage(codexRead, { account: { type: "chatgpt", planType: "prolite" } }, "2026-11-27T10:00:00.000Z");
  assert.deepEqual(read?.windows.map((w) => [w.label, w.usedPercent, w.tone, w.resetsAt]), [["Weekly limit", 18, "normal", "2026-12-03T14:06:55.000Z"]]);
  assert.equal(read?.plan, "Pro Lite plan");
  assert.deepEqual(read?.facts, [{ label: "Credits", value: "61,409" }, { label: "Limit resets available", value: "2" }]);
  assert.match(read?.accountKey ?? "", /^[0-9a-f]{12}$/);

  const later = mergeCodexRateLimitsUpdate(codexRead, { rateLimits: {
    limitId: "codex", primary: { usedPercent: 76, windowDurationMins: 10080, resetsAt: 1796306815 },
    secondary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1796230000 },
    credits: null, planType: null, rateLimitReachedType: "rate_limit_reached"
  } });
  const refused = codexPlanUsage(later, undefined, "2026-11-27T10:05:00.000Z");
  assert.deepEqual(refused?.windows.map((w) => [w.label, w.tone]), [["5h limit", "reached"], ["Weekly limit", "warning"]]);
  assert.equal(refused?.refused, true);
  assert.equal(refused?.plan, "Pro Lite plan", "a sparse update keeps what it does not carry");
  assert.deepEqual(refused?.facts[0], { label: "Credits", value: "61,409" });

  assert.equal(codexPlanUsage(codexRead, { account: { type: "apiKey" } }, "2026-11-27T10:00:00.000Z")?.hasPlanLimits, false);

  // A read that refused ordinary usage ends with the next response's update.
  const blocked = { ...codexRead, ordinaryUsageAllowed: false };
  assert.equal(codexPlanUsage(blocked, undefined, "2026-11-27T10:00:00.000Z")?.refused, true);
  const answered = mergeCodexRateLimitsUpdate(blocked, { rateLimits: { limitId: "codex", primary: { usedPercent: 19, windowDurationMins: 10080 }, rateLimitReachedType: null } });
  assert.equal(codexPlanUsage(answered, undefined, "2026-11-27T10:05:00.000Z")?.refused, undefined);

  // A named bucket (a model's own limit) is kept and updated by its limitId.
  const spark = { limitId: "codex_spark", limitName: "GPT-5.3-Codex-Spark", normalModelSlug: "gpt-5.3-codex-spark",
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1796230000 }, secondary: null, rateLimitReachedType: null };
  const withSpark = mergeCodexRateLimitsUpdate({ ...codexRead, rateLimitsByLimitId: { codex: codexRead.rateLimits, codex_spark: spark } },
    { rateLimits: { ...spark, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1796230000 }, rateLimitReachedType: "rate_limit_reached" } });
  const buckets = codexPlanUsage(withSpark, undefined, "2026-11-27T10:05:00.000Z");
  assert.deepEqual(buckets?.windows.map((w) => [w.id, w.group, w.usedPercent, w.tone]), [
    ["primary", undefined, 18, "normal"], ["codex_spark:primary", "GPT-5.3-Codex-Spark", 100, "reached"]
  ]);
  assert.deepEqual(buckets?.groups, [{ name: "GPT-5.3-Codex-Spark", models: ["gpt-5.3-codex-spark"] }]);
  assert.deepEqual([300, 1440, 10080, 43200].map(codexWindowLabel), ["5h limit", "Daily limit", "Weekly limit", "Monthly limit"]);
});

const agyUsage = {
  status: "SUCCESS",
  command: { name: "usage", data: { groups: [
    { name: "Gemini Models", description: "Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Orchestrator (Neon), Gemini 3.8 Flash",
      buckets: [
        { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.6108688712120056, reset_time: "2026-12-03T09:53:08Z" },
        { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-27T03:57:14Z" }
      ] },
    { name: "Claude and GPT models", description: "Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
      buckets: [
        { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.2, reset_time: "2026-12-01T00:00:00Z" },
        { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.004, reset_time: "2026-11-27T12:00:00Z" }
      ] }
  ] } }
};

test("Antigravity: remaining turned into used, an unused bucket, groups and their models", () => {
  const read = antigravityPlanUsage(agyUsage, "2026-11-27T10:00:00.000Z");
  assert.deepEqual(read?.windows.map((w) => [w.group, w.label, w.usedPercent, w.tone, Boolean(w.resetsAt)]), [
    ["Gemini Models", "Weekly", 39, "normal", true],
    ["Gemini Models", "5 hours", 0, "normal", true],
    ["Claude and GPT models", "Weekly", 80, "warning", true],
    ["Claude and GPT models", "5 hours", 99, "warning", true]
  ]);
  // Never used: no share, no reset (agy says 1970).
  const unused = antigravityPlanUsage({ command: { data: { groups: [{ name: "G", description: "Models within this group: A",
    buckets: [{ id: "g-5h", window: "5h", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" }] }] } } }, "2026-11-27T10:00:00.000Z");
  assert.deepEqual(unused?.windows[0], { id: "g-5h", label: "5 hours", group: "G", tone: "normal" });
  assert.deepEqual(read?.groups?.[1].models, ["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B"]);
  assert.equal(antigravityPlanUsage({ status: "SUCCESS", response: "ok" }, "2026-11-27T10:00:00.000Z"), undefined);
});
