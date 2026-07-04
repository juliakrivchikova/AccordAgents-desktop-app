import assert from "node:assert/strict";
import test from "node:test";
import { SettingsService } from "./settings";
import { commandEnvironment } from "./command";
import type { ManualAgentEnvironmentVariable } from "../../shared/types";

function serviceWithStoredSettings(initial: Record<string, unknown> = {}) {
  const service = Object.create(SettingsService.prototype) as any;
  let stored: Record<string, unknown> = {
    settingsVersion: 1,
    roundLimitDefault: 1,
    providers: [],
    chatRoleConfigs: [],
    chatBehaviorRules: [],
    chatSavedPrompts: [],
    chatParticipantConfigs: [],
    agentEnvironment: { variables: [] },
    ...initial
  };
  service.readStored = async () => stored;
  service.writeStored = async (next: Record<string, unknown>) => {
    stored = next;
  };
  return {
    service,
    stored: () => stored
  };
}

test("manual agent env saves secret values without returning plaintext metadata", async () => {
  const { service, stored } = serviceWithStoredSettings();

  const publicVariables = await service.saveAgentEnvironmentVariable({
    key: "AA_MANUAL_AGENT_ENV_TEST",
    value: "secret-value"
  }) as ManualAgentEnvironmentVariable[];

  assert.deepEqual(publicVariables.map((variable) => ({
    key: variable.key,
    enabled: variable.enabled,
    hasValue: variable.hasValue
  })), [{
    key: "AA_MANUAL_AGENT_ENV_TEST",
    enabled: true,
    hasValue: true
  }]);
  assert.equal(JSON.stringify(publicVariables).includes("secret-value"), false);
  assert.equal(JSON.stringify(stored()).includes("secret-value"), false);

  const manual = await service.getManualAgentEnvironment();
  assert.equal(manual.env.AA_MANUAL_AGENT_ENV_TEST, "secret-value");
  assert.ok(manual.version);
});

test("manual agent env supports empty values and enable toggles without re-sending the value", async () => {
  const { service } = serviceWithStoredSettings();

  await service.saveAgentEnvironmentVariable({ key: "AA_EMPTY_AGENT_ENV_TEST", value: "" });
  assert.equal((await service.getManualAgentEnvironment()).env.AA_EMPTY_AGENT_ENV_TEST, "");

  await service.saveAgentEnvironmentVariable({ key: "AA_EMPTY_AGENT_ENV_TEST", enabled: false });
  assert.equal((await service.getManualAgentEnvironment()).env.AA_EMPTY_AGENT_ENV_TEST, undefined);

  await service.saveAgentEnvironmentVariable({ key: "AA_EMPTY_AGENT_ENV_TEST", enabled: true });
  assert.equal((await service.getManualAgentEnvironment()).env.AA_EMPTY_AGENT_ENV_TEST, "");
});

test("manual agent env rejects app-managed and structural keys", async () => {
  const { service } = serviceWithStoredSettings();

  await assert.rejects(
    () => service.saveAgentEnvironmentVariable({ key: "ACCORD_AGENTS_MCP_TOKEN", value: "bad" }),
    /managed by AccordAgents/
  );
  await assert.rejects(
    () => service.saveAgentEnvironmentVariable({ key: "PATH", value: "/tmp/bin" }),
    /managed by AccordAgents/
  );
  await assert.rejects(
    () => service.saveAgentEnvironmentVariable({ key: "NOT VALID", value: "bad" }),
    /must start/
  );
});

test("manual agent env does not alter the global command environment", async () => {
  const { service } = serviceWithStoredSettings();
  const key = "AA_COMMAND_ENV_NEGATIVE_TEST";
  const original = process.env[key];
  delete process.env[key];
  try {
    await service.saveAgentEnvironmentVariable({ key, value: "manual-only" });

    assert.equal(commandEnvironment()[key], undefined);
    assert.equal((await service.getManualAgentEnvironment()).env[key], "manual-only");
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});
