import assert from "node:assert/strict";
import test from "node:test";

import { memberPlanUsage, planUsageGroupForModel, planUsageResetText } from "./planUsage";
import type { PlanUsageSnapshot } from "./types";

const groups = [
  { name: "Gemini Models", models: ["Gemini 4 Neon", "Gemini 4 Carbon", "Orchestrator (Neon)", "Gemini 3.8 Flash"] },
  { name: "Claude and GPT models", models: ["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B"] }
];

test("Antigravity: a member's model id finds its group as `agy models` names it", () => {
  // `agy models` ids (agy 1.5.14), the effort suffix included.
  const cases: Array<[string | undefined, string]> = [
    ["gemini-4-neon-high", "Gemini Models"],
    ["gemini-3.8-flash-low", "Gemini Models"],
    ["gemini-pro-orchestrator-neon", "Gemini Models"],
    ["gemini-pro-orchestrator", "Gemini Models"],
    ["claude-opus-5-5-medium", "Claude and GPT models"],
    ["gpt-oss-120b-medium", "Claude and GPT models"],
    ["claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)", "Claude and GPT models"],
    [undefined, "Gemini Models"]
  ];
  for (const [model, expected] of cases) assert.equal(planUsageGroupForModel(groups, model)?.name, expected, String(model));
});

const snapshot = (fields: Partial<PlanUsageSnapshot>): PlanUsageSnapshot => ({
  provider: "codex-cli", hasPlanLimits: true, windows: [], facts: [], observedAt: "2026-11-27T10:00:00.000Z", ...fields
});

test("A member's ring: none without plan limits, unread before a read, the refusing window first", () => {
  assert.equal(memberPlanUsage({ kind: "codex-cli", hostId: "host-1" }, [snapshot({})]).state, "none", "an added provider has no plan");
  assert.equal(memberPlanUsage({ kind: "codex-cli" }, [snapshot({ hasPlanLimits: false })]).state, "none");
  assert.equal(memberPlanUsage({ kind: "codex-cli" }, []).state, "unread");
  const read = memberPlanUsage({ kind: "codex-cli" }, [snapshot({ windows: [
    { id: "primary", label: "5h limit", usedPercent: 100, tone: "reached" },
    { id: "secondary", label: "Weekly limit", usedPercent: 82, tone: "warning" }
  ] })]);
  assert.ok(read.state === "read");
  assert.equal(read.headline?.label, "5h limit");
  assert.equal(read.tone, "reached");
  const gemini = memberPlanUsage({ kind: "gemini-cli", model: "claude-opus-5-5-low" }, [snapshot({ provider: "gemini-cli", groups, windows: [
    { id: "gemini-weekly", label: "Weekly", group: "Gemini Models", usedPercent: 39, tone: "normal" },
    { id: "3p-weekly", label: "Weekly", group: "Claude and GPT models", usedPercent: 12, tone: "normal" },
    { id: "3p-5h", label: "5 hours", group: "Claude and GPT models", tone: "normal" }
  ] })]);
  assert.ok(gemini.state === "read");
  assert.deepEqual([gemini.group, gemini.headline?.id, gemini.others.map((w) => w.id)], ["Claude and GPT models", "3p-weekly", ["3p-5h"]]);

  // Codex: a named bucket counts for its own model; any other model, and a
  // model not known, count against the account's own.
  const codex = snapshot({ groups: [{ name: "Spark", models: ["gpt-5.3-codex-spark"] }], windows: [
    { id: "primary", label: "Weekly limit", usedPercent: 30, tone: "normal" },
    { id: "codex_spark:primary", label: "5h limit", group: "Spark", usedPercent: 100, tone: "reached" }
  ] });
  const headlineOf = (model?: string): string | undefined => {
    const usage = memberPlanUsage({ kind: "codex-cli", model }, [codex]);
    return usage.state === "read" ? usage.headline?.id : undefined;
  };
  assert.deepEqual([headlineOf("gpt-6.2-astra"), headlineOf("gpt-5.3-codex-spark"), headlineOf(undefined)], ["primary", "codex_spark:primary", "primary"]);

  // Claude: a model's own refused window is the refusal of members on that
  // model only.
  const claude = snapshot({ provider: "claude-code", headlineId: "seven_day", windows: [
    { id: "seven_day", label: "Current week (all models)", usedPercent: 40, tone: "normal" },
    { id: "model:Fable", label: "Current week (Fable)", model: "Fable", usedPercent: 100, tone: "reached" }
  ] });
  const toneOf = (model: string): string | undefined => {
    const usage = memberPlanUsage({ kind: "claude-code", model }, [claude]);
    return usage.state === "read" ? `${usage.headline?.id}:${usage.tone}:${usage.others.length}` : undefined;
  };
  assert.deepEqual([toneOf("opus"), toneOf("claude-opus-5-5"), toneOf("fable")], ["seven_day:normal:0", "seven_day:normal:0", "model:Fable:reached:1"]);
});

test("A window whose reset has passed has reset: nothing refused, no reset ahead", () => {
  const now = Date.parse("2026-11-27T12:00:00.000Z");
  const usage = memberPlanUsage({ kind: "codex-cli" }, [snapshot({ windows: [
    { id: "primary", label: "5h limit", usedPercent: 100, resetsAt: "2026-11-27T11:00:00.000Z", tone: "reached" },
    { id: "secondary", label: "Weekly limit", usedPercent: 60, resetsAt: "2026-11-30T11:00:00.000Z", tone: "normal" }
  ] })], now);
  assert.ok(usage.state === "read");
  assert.deepEqual([usage.headline?.id, usage.tone, usage.snapshot.windows[0].resetsAt], ["secondary", "normal", undefined]);
  // The CLI's own pick, once it has reset, gives way to a live window.
  const picked = memberPlanUsage({ kind: "codex-cli" }, [snapshot({ headlineId: "primary", windows: [
    { id: "primary", label: "5h limit", usedPercent: 40, resetsAt: "2026-11-27T11:00:00.000Z", tone: "normal" },
    { id: "secondary", label: "Weekly limit", usedPercent: 80, resetsAt: "2026-11-30T11:00:00.000Z", tone: "warning" }
  ] })], now);
  assert.ok(picked.state === "read");
  assert.deepEqual([picked.headline?.id, picked.tone], ["secondary", "warning"]);
  // A warning leads over the CLI's own pick when that one is fine.
  const warned = memberPlanUsage({ kind: "claude-code" }, [snapshot({ provider: "claude-code", headlineId: "five_hour", windows: [
    { id: "five_hour", label: "Current session", usedPercent: 12, tone: "normal" },
    { id: "seven_day", label: "Current week (all models)", usedPercent: 89, tone: "warning" }
  ] })], now);
  assert.ok(warned.state === "read");
  assert.deepEqual([warned.headline?.id, warned.tone], ["seven_day", "warning"]);
  assert.equal(planUsageResetText("2026-11-27T11:00:00.000Z", now), undefined);
});

test("Resets: the time today, the weekday within the week, the date later", () => {
  const now = new Date(2026, 10, 27, 9, 0).getTime();
  assert.equal(planUsageResetText(new Date(2026, 10, 27, 16, 10).toISOString(), now), "Resets 4:10 PM");
  assert.equal(planUsageResetText(new Date(2026, 10, 29, 18, 0).toISOString(), now), "Resets Sun 6:00 PM");
  assert.equal(planUsageResetText(new Date(2026, 11, 9, 9, 53).toISOString(), now), "Resets Dec 9, 9:53 AM");
});
