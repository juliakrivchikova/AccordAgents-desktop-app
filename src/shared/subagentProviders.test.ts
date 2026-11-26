import assert from "node:assert/strict";
import test from "node:test";

import { applySubagentProviderChange, effectiveSubagentProviders, normalizeSubagentProvidersByProject } from "./subagentProviders";
import type { SubagentProviderEntry } from "./types";

const PROJECT: SubagentProviderEntry[] = [
  { kind: "codex-cli", model: "gpt-6.2-astra", reasoningEffort: "high" },
  { kind: "gemini-cli" }
];

test("a chat from before the list has no sub-agent list: any ready CLI, as before", () => {
  assert.equal(effectiveSubagentProviders(PROJECT, undefined), undefined);
});

test("a chat's providers are its project's, with its own layer on top, and each value says where it comes from", () => {
  const cases: Array<[string, SubagentProviderEntry[], Array<[string, string | undefined, string, string | undefined, string]>]> = [
    ["no layer of its own: the project's list", [],
      [["codex-cli", "gpt-6.2-astra", "project", "high", "project"], ["gemini-cli", undefined, "default", undefined, "default"]]],
    ["its own effort over the project's model", [{ kind: "codex-cli", reasoningEffort: "xhigh" }],
      [["codex-cli", "gpt-6.2-astra", "project", "xhigh", "thread"], ["gemini-cli", undefined, "default", undefined, "default"]]],
    // An effort is the project model's: a model of the chat's own starts from its own default.
    ["its own model does not take the project's effort", [{ kind: "codex-cli", model: "gpt-6-luna" }],
      [["codex-cli", "gpt-6-luna", "thread", undefined, "default"], ["gemini-cli", undefined, "default", undefined, "default"]]],
    ["a provider the project has, removed in this chat", [{ kind: "gemini-cli", removed: true }],
      [["codex-cli", "gpt-6.2-astra", "project", "high", "project"]]],
    ["a provider added for this chat only comes after the project's", [{ kind: "claude-code", model: "opus" }],
      [["codex-cli", "gpt-6.2-astra", "project", "high", "project"], ["gemini-cli", undefined, "default", undefined, "default"], ["claude-code", "opus", "thread", undefined, "default"]]]
  ];
  for (const [name, own, expected] of cases) {
    const providers = effectiveSubagentProviders(PROJECT, { entries: own })!;
    assert.deepEqual(providers.map((provider) => [provider.kind, provider.model, provider.modelFrom, provider.reasoningEffort, provider.effortFrom]), expected, name);
  }
  assert.deepEqual(effectiveSubagentProviders(undefined, { entries: [] }), [], "a new chat in a project with no list has no sub-agents until one is added");
});

test("changes at the chat's scope keep only what differs from the project", () => {
  const thread = (entries: SubagentProviderEntry[], change: Parameters<typeof applySubagentProviderChange>[2]) =>
    applySubagentProviderChange("thread", entries, change, PROJECT);
  assert.deepEqual(thread([], { type: "remove", kind: "gemini-cli" }), [{ kind: "gemini-cli", removed: true }], "a project provider is hidden, not deleted");
  assert.deepEqual(thread([{ kind: "gemini-cli", removed: true }], { type: "add", kind: "gemini-cli" }), [], "added back: nothing of its own left");
  assert.deepEqual(thread([], { type: "add", kind: "claude-code" }), [{ kind: "claude-code" }], "a provider the project lacks");
  assert.deepEqual(thread([{ kind: "claude-code" }], { type: "remove", kind: "claude-code" }), [], "removed again: gone");
  assert.deepEqual(thread([], { type: "set", kind: "codex-cli", reasoningEffort: "xhigh" }), [{ kind: "codex-cli", reasoningEffort: "xhigh" }]);
  assert.deepEqual(thread([{ kind: "codex-cli", reasoningEffort: "xhigh" }], { type: "set", kind: "codex-cli" }), [], "Reset: back to the project's values");
  assert.deepEqual(thread([{ kind: "claude-code", model: "opus" }], { type: "set", kind: "claude-code" }), [{ kind: "claude-code" }], "Reset keeps a provider only this chat has");
});

test("changes at the project's scope edit its list in place", () => {
  const project = (entries: SubagentProviderEntry[], change: Parameters<typeof applySubagentProviderChange>[2]) => applySubagentProviderChange("project", entries, change);
  assert.deepEqual(project([], { type: "add", kind: "codex-cli" }), [{ kind: "codex-cli" }]);
  assert.deepEqual(project(PROJECT, { type: "add", kind: "codex-cli" }), PROJECT, "added twice: once");
  assert.deepEqual(project(PROJECT, { type: "set", kind: "gemini-cli", model: " gemini-4-neon " }), [PROJECT[0], { kind: "gemini-cli", model: "gemini-4-neon" }], "kept in its place");
  assert.deepEqual(project(PROJECT, { type: "set", kind: "codex-cli" }), [{ kind: "codex-cli" }, PROJECT[1]], "Reset: the CLI's own defaults");
  assert.deepEqual(project(PROJECT, { type: "remove", kind: "codex-cli" }), [PROJECT[1]]);
});

test("stored lists are read back safely", () => {
  assert.deepEqual(normalizeSubagentProvidersByProject({
    "/repo/": [{ kind: "codex-cli", reasoningEffort: "high" }, { kind: "codex-cli" }, { kind: "nope" }, { kind: "gemini-cli", removed: true }],
    "": [{ kind: "claude-code" }],
    "/empty": []
  }), { "/repo": [{ kind: "codex-cli", reasoningEffort: "high" }, { kind: "gemini-cli" }] }, "one entry per provider, no removed flag in a project, no empty or keyless lists");
  assert.equal(normalizeSubagentProvidersByProject("junk"), undefined);
});
