import assert from "node:assert/strict";
import test from "node:test";
import { SettingsService } from "./settings";
import { settingsDependencies, settingsParts, settingsWithoutFile } from "./settings/test/settingsParts";
import { commandEnvironment, parseWindowsVariables } from "./command";
import {
  agentEnvironmentValuePreview,
  isAutomaticAgentEnvironmentKey,
  isLocalPathValue
} from "../../shared/agentEnvironment";
import { automaticAgentEnvironmentSource } from "./agentEnvironment";
import { codexAppServerConfig } from "./cliAgents/codex/appServerParams";
import { agentRunEnv } from "./cliAgents/runs/runEnvironment";

function serviceWithStoredSettings(initial: Record<string, unknown> = {}) {
  const service = settingsWithoutFile();
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
  settingsParts(service).settingsStore.readStored = async () => stored;
  settingsParts(service).settingsStore.writeStored = async (next: Record<string, unknown>) => {
    stored = next;
  };
  return {
    service,
    stored: () => stored
  };
}

function exportedValues(snapshot: any): Record<string, string> {
  return Object.fromEntries(snapshot.agentEnvironment.map((entry: any) => [entry.key, entry.value]));
}

async function listed(service: any): Promise<Record<string, { source: string; preview: string; enabled: boolean; thisComputerOnly: boolean }>> {
  const variables = await service.listAgentEnvironmentVariables();
  return Object.fromEntries(variables.map((variable: any) => [variable.key, {
    source: variable.source,
    preview: variable.preview,
    enabled: variable.enabled,
    thisComputerOnly: variable.thisComputerOnly
  }]));
}

test("a saved value is stored encrypted and listed only by its first and last characters", async () => {
  const { service, stored } = serviceWithStoredSettings();
  await service.saveAgentEnvironmentVariable({ key: "AA_TOKEN", value: "ghp_secretmiddle3kQ2" });

  const variables = await service.listAgentEnvironmentVariables();
  assert.deepEqual(variables.map((variable: any) => [variable.key, variable.source, variable.preview]), [
    ["AA_TOKEN", "custom", "ghp_••••••••3kQ2"]
  ]);
  assert.equal(JSON.stringify(variables).includes("secretmiddle"), false);
  assert.equal(JSON.stringify(stored()).includes("secretmiddle"), false);
  const manual = await service.getManualAgentEnvironment();
  assert.equal(manual.env.AA_TOKEN, "ghp_secretmiddle3kQ2");
  assert.ok(manual.version);
});

test("an empty value is refused, and app-managed and invalid names are refused", async () => {
  const { service } = serviceWithStoredSettings();
  await assert.rejects(() => service.saveAgentEnvironmentVariable({ key: "AA_EMPTY", value: "" }), /Enter a value/);
  await assert.rejects(() => service.saveAgentEnvironmentVariable({ key: "ACCORD_AGENTS_MCP_TOKEN", value: "bad" }), /managed by AccordAgents/);
  await assert.rejects(() => service.saveAgentEnvironmentVariable({ key: "PATH", value: "/tmp/bin" }), /managed by AccordAgents/);
  await assert.rejects(() => service.saveAgentEnvironmentVariable({ key: "NOT VALID", value: "bad" }), /must start/);
});

test("the computer's variables join the list, follow it, and leave with it", async () => {
  const { service } = serviceWithStoredSettings();

  assert.equal(await service.reconcileAutomaticAgentEnvironment({ GH_TOKEN: "gho_first_value_0001", SENTRY_TOKEN: "sntr_value_abcd_Lw0e" }), true);
  assert.deepEqual(Object.keys(await listed(service)).sort(), ["GH_TOKEN", "SENTRY_TOKEN"]);
  assert.equal((await listed(service)).GH_TOKEN.source, "automatic");
  // Members here inherit the live value; the copy is what cloud machines get.
  assert.equal(Object.hasOwn((await service.getManualAgentEnvironment()).env, "GH_TOKEN"), false);
  assert.deepEqual(exportedValues(await service.exportMachineSettingsSnapshot()).GH_TOKEN, "gho_first_value_0001");

  // Nothing new: nothing written.
  assert.equal(await service.reconcileAutomaticAgentEnvironment({ GH_TOKEN: "gho_first_value_0001", SENTRY_TOKEN: "sntr_value_abcd_Lw0e" }), false);

  // A value changed on the computer is followed; a name it dropped goes away.
  assert.equal(await service.reconcileAutomaticAgentEnvironment({ GH_TOKEN: "gho_second_value_002" }), true);
  assert.deepEqual(Object.keys(await listed(service)), ["GH_TOKEN"]);
  assert.equal(exportedValues(await service.exportMachineSettingsSnapshot()).GH_TOKEN, "gho_second_value_002");
});

test("a value the User saved stays hers when the computer changes or drops the name", async () => {
  const { service } = serviceWithStoredSettings();
  await service.reconcileAutomaticAgentEnvironment({ GH_TOKEN: "gho_computer_value_1" });
  await service.saveAgentEnvironmentVariable({ key: "GH_TOKEN", value: "gho_users_own_value9" });
  assert.equal((await listed(service)).GH_TOKEN.source, "custom");

  await service.reconcileAutomaticAgentEnvironment({ GH_TOKEN: "gho_computer_value_2" });
  assert.equal((await service.getManualAgentEnvironment()).env.GH_TOKEN, "gho_users_own_value9");
  await service.reconcileAutomaticAgentEnvironment({});
  assert.equal((await service.getManualAgentEnvironment()).env.GH_TOKEN, "gho_users_own_value9");
});

test("a deleted automatic variable does not come back and is not inherited here either", async () => {
  const { service } = serviceWithStoredSettings();
  await service.reconcileAutomaticAgentEnvironment({ X_API_KEY: "Qm2t_secret_key_x9Pd" });
  const before = (await service.getManualAgentEnvironment()).version;

  await service.deleteAgentEnvironmentVariable("X_API_KEY");
  assert.equal(await service.reconcileAutomaticAgentEnvironment({ X_API_KEY: "Qm2t_secret_key_x9Pd" }), false);
  assert.deepEqual(await listed(service), {});
  const manual = await service.getManualAgentEnvironment();
  // An explicit removal: the member's process does not get this computer's value.
  assert.equal(Object.hasOwn(manual.env, "X_API_KEY"), true);
  assert.equal(manual.env.X_API_KEY, undefined);
  assert.notEqual(manual.version, before);

  // Saving the name again makes it the User's; deleting it again keeps it gone.
  await service.saveAgentEnvironmentVariable({ key: "X_API_KEY", value: "my_own_value_123456" });
  assert.equal((await service.getManualAgentEnvironment()).env.X_API_KEY, "my_own_value_123456");
  await service.deleteAgentEnvironmentVariable("X_API_KEY", true);
  assert.equal(await service.reconcileAutomaticAgentEnvironment({ X_API_KEY: "Qm2t_secret_key_x9Pd" }), false);
  assert.equal((await service.getManualAgentEnvironment()).env.X_API_KEY, undefined);
});

test("deleting a custom variable the computer does not set leaves nothing behind", async () => {
  const { service, stored } = serviceWithStoredSettings();
  await service.saveAgentEnvironmentVariable({ key: "AA_ONLY_MINE", value: "value_only_mine_1234" });
  await service.deleteAgentEnvironmentVariable("AA_ONLY_MINE", false);
  const manual = await service.getManualAgentEnvironment();
  assert.equal(Object.hasOwn(manual.env, "AA_ONLY_MINE"), false);
  assert.deepEqual((stored() as any).agentEnvironment.removedAutomaticKeys, []);
});

test("cloud machines get every variable except an automatic path on this computer", async () => {
  const { service } = serviceWithStoredSettings();
  await service.reconcileAutomaticAgentEnvironment({ BUN_INSTALL: "/Users/someone/.bun", GH_TOKEN: "gho_cloud_too_000001", DROPPED: "x_dropped_value_12" });
  await service.saveAgentEnvironmentVariable({ key: "MY_FOLDER", value: "/Users/someone/work" });
  await service.deleteAgentEnvironmentVariable("DROPPED");

  const exported = await service.exportMachineSettingsSnapshot();
  assert.deepEqual(exported.agentEnvironment.map((entry: any) => entry.key).sort(), ["GH_TOKEN", "MY_FOLDER"]);
  assert.equal((await listed(service)).BUN_INSTALL.thisComputerOnly, true);
  assert.equal((await listed(service)).MY_FOLDER.thisComputerOnly, false);
  // Members here inherit the path from this computer itself.
  assert.equal(Object.hasOwn((await service.getManualAgentEnvironment()).env, "BUN_INSTALL"), false);
});

test("a custom variable switched off before the switch was removed stays off until a value is saved", async () => {
  const { service } = serviceWithStoredSettings();
  await service.saveAgentEnvironmentVariable({ key: "AA_OLD_OFF", value: "old_value_0000000001" });
  const stored = await settingsParts(service).settingsStore.readStored();
  stored.agentEnvironment.variables[0].enabled = false;
  assert.equal((await service.getManualAgentEnvironment()).env.AA_OLD_OFF, undefined);
  assert.equal((await listed(service)).AA_OLD_OFF.enabled, false);
  await service.saveAgentEnvironmentVariable({ key: "AA_OLD_OFF", value: "new_value_0000000002" });
  assert.equal((await service.getManualAgentEnvironment()).env.AA_OLD_OFF, "new_value_0000000002");
});

test("only the User's own names are offered as automatic, whatever the case", () => {
  for (const key of ["GH_TOKEN", "BUN_INSTALL", "X_API_KEY", "ChocolateyInstall"]) {
    assert.equal(isAutomaticAgentEnvironmentKey(key), true, key);
  }
  for (const key of ["_", "Path", "PATH", "Home", "OS", "ComSpec", "windir", "PROCESSOR_ARCHITECTURE", "USERPROFILE", "TEMP", "ACCORDAGENTS_USER_DATA_DIR", "ACCORD_AGENTS_X", "MallocNanoZone", "LaunchInstanceID", "OneDrive"]) {
    assert.equal(isAutomaticAgentEnvironmentKey(key), false, key);
  }
  const source = automaticAgentEnvironmentSource({ GH_TOKEN: "t", TMPDIR: "/tmp", SSH_AUTH_SOCK: "/s", __CF_X: "1", XPC_X: "1", EMPTY: "", _: "/bin/zsh" });
  assert.deepEqual(source, { GH_TOKEN: "t" });
});

test("a path on this computer is recognised on macOS, Linux and Windows", () => {
  for (const value of ["/Users/a/.bun", "~/bin", "C:\\Tools", "D:/x", "\\\\server\\share", "/opt/a:/opt/b"]) {
    assert.equal(isLocalPathValue(value), true, value);
  }
  for (const value of ["ghp_123", "https://example.com", "1", "a/b", "", "/wJalrXUtnFEMI+K7MDENGbPxRfiCYEXAMPLEKEY", "/abc"]) {
    assert.equal(isLocalPathValue(value), false, value);
  }
});

test("the preview shows the first and last four characters, or only dots", () => {
  assert.equal(agentEnvironmentValuePreview("sk-proj-abcdefghij9fQa"), "sk-p••••••••9fQa");
  assert.equal(agentEnvironmentValuePreview("short"), "••••••••");
  assert.equal(agentEnvironmentValuePreview("abcd1234wxyz"), "••••••••");
  assert.equal(agentEnvironmentValuePreview("abcd123456789012wxy"), "••••••••");
  assert.equal(agentEnvironmentValuePreview("abcd1234567890123wxy"), "abcd••••••••3wxy");
});

test("Windows variables are read from PowerShell's JSON without PATH", () => {
  assert.deepEqual(parseWindowsVariables('{"GH_TOKEN":"abc","Path":"C:\\\\x","OS":"Windows_NT"}'), { GH_TOKEN: "abc", OS: "Windows_NT" });
  assert.deepEqual(parseWindowsVariables(""), {});
  assert.equal(parseWindowsVariables("not json"), undefined);
});

test("saved variables do not change the global command environment", async () => {
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

test("a member's process does not inherit a deleted name from this computer", async () => {
  const key = "AA_DELETED_FROM_COMPUTER";
  const original = process.env[key];
  process.env[key] = "computer-value";
  try {
    const runEnv = agentRunEnv(
      { agentEnv: { AA_KEPT: "kept", [key]: undefined, PATH: undefined } }
    );
    assert.equal(runEnv!.AA_KEPT, "kept");
    assert.equal(Object.hasOwn(runEnv as never, key), true);
    assert.equal(Object.hasOwn(runEnv as never, "PATH"), false);
    const childEnv = commandEnvironment(runEnv);
    assert.equal(childEnv[key], undefined);
    assert.ok(childEnv.PATH);
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

test("Codex gets the Settings values through its own shell policy, with the thread", async () => {
  const config = codexAppServerConfig(
    { kind: "codex-cli" } as never,
    { webAccess: false, workspaceWrite: false } as never,
    { settingsEnv: { QA_CHANGED: "users_value", QA_REMOVED: undefined, "NOT VALID": "x" } }
  );
  assert.equal(config["shell_environment_policy.set.QA_CHANGED"], "users_value");
  assert.equal(Object.keys(config).some((key) => key.includes("QA_REMOVED") || key.includes("NOT VALID")), false);
});

test("nothing is brought in step until this computer has been read once", async () => {
  const { AgentEnvironmentService } = await import("./agentEnvironment");
  let reconciled = 0;
  const settings = { reconcileAutomaticAgentEnvironment: async () => { reconciled += 1; return true; } } as any;
  let read = false;
  const service = new AgentEnvironmentService(settings, () => ({ GH_TOKEN: "x" }), () => read);
  assert.equal(await service.reconcile(), false);
  assert.equal(reconciled, 0);
  read = true;
  assert.equal(await service.reconcile(), true);
  assert.equal(reconciled, 1);
});

test("each pass uses the reading current when it starts, one after another", async () => {
  const { AgentEnvironmentService } = await import("./agentEnvironment");
  const seen: string[][] = [];
  let release: () => void = () => undefined;
  const first = new Promise<void>((resolve) => { release = resolve; });
  const settings = {
    reconcileAutomaticAgentEnvironment: async (source: Record<string, string>) => {
      seen.push(Object.keys(source));
      if (seen.length === 1) await first;
      return true;
    }
  } as any;
  let source: Record<string, string> = { A: "1" };
  const service = new AgentEnvironmentService(settings, () => source, () => true);
  const one = service.reconcile();
  await new Promise((resolve) => setImmediate(resolve));
  // A new reading arrives while the first pass is still writing.
  source = { B: "2" };
  const two = service.reconcile();
  release();
  await Promise.all([one, two]);
  assert.deepEqual(seen, [["A"], ["B"]]);
});

test("deleting asks the settings to remember the name only when this computer sets it", async () => {
  const { AgentEnvironmentService } = await import("./agentEnvironment");
  const calls: Array<[string, boolean]> = [];
  const settings = {
    deleteAgentEnvironmentVariable: async (key: string, setByThisComputer: boolean) => { calls.push([key, setByThisComputer]); },
    listAgentEnvironmentVariables: async () => []
  } as any;
  const service = new AgentEnvironmentService(settings, () => ({ GH_TOKEN: "x" }), () => true);
  await service.delete({ key: "GH_TOKEN" });
  await service.delete({ key: "ONLY_MINE" });
  assert.deepEqual(calls, [["GH_TOKEN", true], ["ONLY_MINE", false]]);
});

test("an unreadable automatic value is kept, not rewritten, while the secret store is away", async () => {
  const { service, stored } = serviceWithStoredSettings();
  await service.reconcileAutomaticAgentEnvironment({ GH_TOKEN: "gho_value_aaaaaaaaaaaa" });
  settingsParts(service).secrets.decodeAgentEnvironmentValue = () => undefined;
  settingsParts(service).secrets.safeStorageEncryptionAvailable = () => false;
  const before = JSON.stringify(stored());
  assert.equal(await service.reconcileAutomaticAgentEnvironment({ GH_TOKEN: "gho_value_aaaaaaaaaaaa" }), false);
  assert.equal(JSON.stringify(stored()), before);
});

test("automatic variables and deleted names survive a restart of the app", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(path.join(tmpdir(), "accord-env-restart-"));
  const make = () => { const settings = new SettingsService(); settingsDependencies(settings).settingsPath = path.join(dir, "settings.json"); return settings; };
  try {
    await make().reconcileAutomaticAgentEnvironment({ GH_TOKEN: "gho_value_aaaaaaaaaaaa", X_KEY: "x_value_bbbbbbbbbbbbbbb" });
    await make().deleteAgentEnvironmentVariable("X_KEY");
    const fresh = make();
    assert.deepEqual((await fresh.listAgentEnvironmentVariables()).map((variable) => [variable.key, variable.source]), [["GH_TOKEN", "automatic"]]);
    assert.deepEqual((await fresh.getManualAgentEnvironment()).removedKeys, ["X_KEY"]);
    assert.equal(await fresh.reconcileAutomaticAgentEnvironment({ X_KEY: "x_value_bbbbbbbbbbbbbbb" }), true);
    assert.deepEqual((await fresh.listAgentEnvironmentVariables()).map((variable) => variable.key), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
