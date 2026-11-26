import assert from "node:assert/strict";
import test from "node:test";

import { mainRunsOnMachine, subagentMachineOf, subagentReadyHere, subagentReadyOnMachine } from "./subagentReadiness";
import type { AgentHealth, ChatProviderKind, CliProviderHost } from "./types";

const health = (kind: ChatProviderKind, authentication: "ready" | "required"): AgentHealth =>
  ({ kind, label: kind, installed: true, detection: "detected", runnable: "ready", authentication }) as AgentHealth;
const HOST = { id: "zai", cli: "claude-code", hasApiKey: true, label: "Z.ai" } as CliProviderHost;

test("ready here: a main session on an added provider keeps its own CLI though the CLI itself is not signed in", () => {
  const agents = [health("claude-code", "required"), health("codex-cli", "ready"), health("gemini-cli", "required")];
  assert.deepEqual(subagentReadyHere(agents, [], [HOST], { kind: "claude-code", hostId: "zai" }), ["claude-code", "codex-cli"]);
  assert.deepEqual(subagentReadyHere(agents, [], [HOST], { kind: "claude-code" }), ["codex-cli"], "on the CLI's own sign-in it is not ready");
  assert.deepEqual(subagentReadyHere(agents, [], [{ ...HOST, hasApiKey: false }], { kind: "claude-code", hostId: "zai" }), ["codex-cli"], "a provider without a key is not");
  assert.deepEqual(subagentReadyHere(agents, [{ kind: "claude-code", enabled: false }], [HOST], { kind: "claude-code", hostId: "zai" }), ["codex-cli"],
    "a CLI turned off in Settings stays off");
});

test("a main session on a machine: the CLIs that machine said it has", () => {
  const machines = [
    { id: "m1", lastHello: { providers: [{ kind: "codex-cli", installed: true }, { kind: "gemini-cli", installed: false }, { kind: "nope", installed: true }] } },
    { id: "m2", awsInstanceId: "i-1" }
  ];
  assert.equal(mainRunsOnMachine({ kind: "claude-code" }), false);
  assert.equal(mainRunsOnMachine({ kind: "claude-code", homeMachineId: "m1" }), true);
  assert.deepEqual(subagentReadyOnMachine(subagentMachineOf({ kind: "claude-code", homeMachineId: "m1" }, machines)), ["codex-cli"]);
  assert.equal(subagentMachineOf({ kind: "claude-code", cloudRun: { instanceId: "i-1" } }, machines)?.id, "m2", "Cloud run: the machine on its instance");
  assert.deepEqual(subagentReadyOnMachine(machines[1]), [], "not greeted yet: none");
  assert.deepEqual(subagentReadyOnMachine(undefined), []);
});
