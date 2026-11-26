import assert from "node:assert/strict";
import test from "node:test";

import {
  addableSubagentProviders, applySubagentDefaultUpdate, applySubagentProviderChange, chatSubagentProvidersOf, effectiveSubagentProviders,
  normalizeSubagentProviderEntries
} from "./subagentProviders";
import type { ChatProviderKind, SubagentProviderEntry } from "./types";

// The chat's Agents list (the User, 2026-11-26): every ready CLI, on Settings →
// General → Agents' model and effort; a chat's own changes are its only.

const ALL: ChatProviderKind[] = ["codex-cli", "claude-code", "gemini-cli"];
const DEFAULTS: SubagentProviderEntry[] = [{ kind: "codex-cli", model: "gpt-6.2-astra", reasoningEffort: "high" }];

const rows = (providers: ReturnType<typeof effectiveSubagentProviders>) =>
  providers.map((provider) => [provider.kind, provider.model, provider.modelFrom, provider.reasoningEffort, provider.effortFrom]);

test("every ready CLI is in a chat's list from the start, in the display order, on Settings' values", () => {
  assert.deepEqual(rows(effectiveSubagentProviders({ ready: ALL, defaults: DEFAULTS })), [
    ["gemini-cli", undefined, "default", undefined, "default"],
    ["claude-code", undefined, "default", undefined, "default"],
    ["codex-cli", "gpt-6.2-astra", "settings", "high", "settings"]
  ]);
  assert.deepEqual(effectiveSubagentProviders({ ready: ["codex-cli"], thread: { entries: [] } }).map((provider) => provider.kind), ["codex-cli"], "a CLI that is not ready is not listed");
  assert.deepEqual(effectiveSubagentProviders({ ready: [] }), [], "none ready: none listed");
  assert.deepEqual(effectiveSubagentProviders({ ready: ALL, cloudRun: true }).map((provider) => provider.kind), ["claude-code", "codex-cli"],
    "a Cloud run main session's members run there, where Antigravity does not");
});

test("a chat's own changes: taken out, its own values over Settings', and an effort that goes with its own model", () => {
  const cases: Array<[string, SubagentProviderEntry[], Array<[string, string | undefined, string, string | undefined, string]>]> = [
    ["taken out", [{ kind: "gemini-cli", removed: true }, { kind: "claude-code", removed: true }],
      [["codex-cli", "gpt-6.2-astra", "settings", "high", "settings"]]],
    ["its own effort over Settings' model", [{ kind: "codex-cli", reasoningEffort: "xhigh" }, { kind: "gemini-cli", removed: true }, { kind: "claude-code", removed: true }],
      [["codex-cli", "gpt-6.2-astra", "settings", "xhigh", "thread"]]],
    // An effort is the Settings model's: a model of the chat's own starts from its own default.
    ["its own model does not take Settings' effort", [{ kind: "codex-cli", model: "gpt-6-luna" }, { kind: "gemini-cli", removed: true }, { kind: "claude-code", removed: true }],
      [["codex-cli", "gpt-6-luna", "thread", undefined, "default"]]],
    // Added before 2026-11-26, in a chat's own list: changes nothing now.
    ["a CLI added for the chat in the old list", [{ kind: "claude-code" }, { kind: "gemini-cli", removed: true }],
      [["claude-code", undefined, "default", undefined, "default"], ["codex-cli", "gpt-6.2-astra", "settings", "high", "settings"]]]
  ];
  for (const [name, own, expected] of cases) {
    assert.deepEqual(rows(effectiveSubagentProviders({ ready: ALL, defaults: DEFAULTS, thread: { entries: own } })), expected, name);
  }
});

test("what the chat can have back: what it took out, when that CLI is ready where its members run", () => {
  const thread = { entries: [{ kind: "gemini-cli" as const, removed: true as const }, { kind: "codex-cli" as const, removed: true as const }, { kind: "claude-code" as const, model: "opus" }] };
  assert.deepEqual(addableSubagentProviders({ ready: ALL, thread }), ["gemini-cli", "codex-cli"]);
  assert.deepEqual(addableSubagentProviders({ ready: ["claude-code", "gemini-cli"], thread }), ["gemini-cli"], "Codex is not ready here");
  assert.deepEqual(addableSubagentProviders({ ready: ALL, thread, cloudRun: true }), ["codex-cli"], "Antigravity does not run on Cloud run");
  assert.deepEqual(addableSubagentProviders({ ready: ALL }), [], "nothing taken out: nothing to add");
});

test("a chat's changes keep only what differs from the list Settings makes", () => {
  const change = applySubagentProviderChange;
  assert.deepEqual(change([], { type: "remove", kind: "gemini-cli" }), [{ kind: "gemini-cli", removed: true }]);
  assert.deepEqual(change([{ kind: "gemini-cli", model: "gemini-4" }], { type: "remove", kind: "gemini-cli" }), [{ kind: "gemini-cli", removed: true }], "its values go with it");
  assert.deepEqual(change([{ kind: "gemini-cli", removed: true }], { type: "add", kind: "gemini-cli" }), [], "back on Settings' values");
  assert.deepEqual(change([], { type: "set", kind: "codex-cli", reasoningEffort: "xhigh" }), [{ kind: "codex-cli", reasoningEffort: "xhigh" }]);
  assert.deepEqual(change([{ kind: "codex-cli", reasoningEffort: "xhigh" }], { type: "set", kind: "codex-cli", model: " gpt-6-luna " }),
    [{ kind: "codex-cli", model: "gpt-6-luna" }], "Apply sets both: an effort it does not name goes back to Settings'");
  assert.deepEqual(change([{ kind: "codex-cli", reasoningEffort: "xhigh" }], { type: "set", kind: "codex-cli" }), [], "Reset: back to Settings' values");
  assert.deepEqual(change([{ kind: "claude-code" }], { type: "set", kind: "claude-code" }), [], "an old entry with nothing of its own is dropped");
});

test("Settings' defaults: a CLI with nothing set has no entry, a value is changed in place", () => {
  assert.deepEqual(applySubagentDefaultUpdate([], { kind: "codex-cli", model: "gpt-6.2-astra" }), [{ kind: "codex-cli", model: "gpt-6.2-astra" }]);
  assert.deepEqual(applySubagentDefaultUpdate(DEFAULTS, { kind: "codex-cli", reasoningEffort: "low" }), [{ kind: "codex-cli", model: "gpt-6.2-astra", reasoningEffort: "low" }],
    "undefined leaves the model");
  assert.deepEqual(applySubagentDefaultUpdate(DEFAULTS, { kind: "codex-cli", model: null }), [{ kind: "codex-cli", reasoningEffort: "high" }], "null clears it");
  assert.deepEqual(applySubagentDefaultUpdate(DEFAULTS, { kind: "codex-cli", model: null, reasoningEffort: null }), [], "nothing left: no entry");
  assert.deepEqual(applySubagentDefaultUpdate([{ kind: "claude-code", model: "opus" }, ...DEFAULTS], { kind: "claude-code", model: "sonnet" }),
    [{ kind: "claude-code", model: "sonnet" }, ...DEFAULTS], "kept in its place");
  assert.deepEqual(applySubagentDefaultUpdate([], { kind: "codex-cli", reasoningEffort: "bogus" as never }), [], "an effort the CLI does not have is not kept");
});

test("stored values are read back safely", () => {
  assert.deepEqual(normalizeSubagentProviderEntries([{ kind: "codex-cli", reasoningEffort: "high" }, { kind: "codex-cli" }, { kind: "nope" }, { kind: "gemini-cli", removed: true }], false),
    [{ kind: "codex-cli", reasoningEffort: "high" }, { kind: "gemini-cli" }], "one entry per CLI, no removed flag in Settings");
  assert.deepEqual(normalizeSubagentProviderEntries("junk", false), []);
  assert.equal(chatSubagentProvidersOf({}), undefined);
  assert.deepEqual(chatSubagentProvidersOf({ subagentProviders: { entries: [{ kind: "gemini-cli", removed: true }, null] } }), { entries: [{ kind: "gemini-cli", removed: true }] });
});
