import { machineProfileVariables } from "../../../../shared/machineInstall";
import type { AgentEnvironmentVariable, SaveAgentEnvironmentVariableRequest } from "../../../../shared/types";
import {
  agentEnvironmentValuePreview, assertAgentEnvironmentKeyAllowed, filterAllowedAgentEnvironment, isAutomaticAgentEnvironmentKey,
  isLocalPathValue, normalizeAgentEnvironmentKey
} from "../../../../shared/agentEnvironment";
import { environmentKeyId } from "./environmentKeys";
import { agentEnvironmentVersion, normalizeAgentEnvironmentVariables } from "./storedEnvironment";
import type { StoredAgentEnvironmentVariable, StoredSettings } from "../types";
import type { SettingsModules } from "../modules";
import type { SettingsDependencies } from "../dependencies";

/** Environment variables members get, found on this computer or added by the User. */
export class AgentEnvironment {
  constructor(
    private readonly settings: Pick<SettingsModules, "secrets" | "settingsStore">,
    private readonly deps: Pick<SettingsDependencies, "options">
  ) {}

  /** Every variable members get, with the first and last characters of its
   *  value: the page never receives a whole value. */
  async listAgentEnvironmentVariables(): Promise<AgentEnvironmentVariable[]> {
    const stored = await this.settings.settingsStore.readStored();
    return (stored.agentEnvironment?.variables ?? []).map((variable) => {
      const value = this.settings.secrets.decodeAgentEnvironmentValue(variable);
      const automatic = variable.source === "automatic";
      return {
        key: variable.key,
        source: automatic ? "automatic" : "custom",
        preview: value === undefined ? "••••••••" : agentEnvironmentValuePreview(value),
        updatedAt: variable.updatedAt,
        enabled: variable.enabled !== false,
        thisComputerOnly: automatic && value !== undefined && isLocalPathValue(value)
      };
    });
  }

  /** The variables members get, and the names they must not get from this
   *  computer either because the User deleted them. */
  async getManualAgentEnvironment(): Promise<{ env: NodeJS.ProcessEnv; version: string; removedKeys: string[] }> {
    const stored = await this.settings.settingsStore.readStored();
    return this.readManualAgentEnvironment(stored);
  }

  readManualAgentEnvironment(
    stored: StoredSettings,
    requireComplete = false,
    forCloudMachines = false
  ): { env: NodeJS.ProcessEnv; version: string; removedKeys: string[] } {
    const env: NodeJS.ProcessEnv = {};
    for (const variable of stored.agentEnvironment?.variables ?? []) {
      if (variable.enabled === false) {
        continue;
      }
      // Members on this computer already inherit its live value; the copy is
      // what the cloud machines get, so a value the computer just changed is
      // never replaced here by an older copy.
      if (!forCloudMachines && variable.source === "automatic") {
        continue;
      }
      if (normalizeAgentEnvironmentKey(variable.key) !== variable.key) {
        if (requireComplete) throw new Error("Machine environment contains an invalid key; no settings were sent.");
        continue;
      }
      try {
        assertAgentEnvironmentKeyAllowed(variable.key);
      } catch {
        if (requireComplete) throw new Error("Machine environment contains a forbidden key; no settings were sent.");
        continue;
      }
      const value = this.settings.secrets.decodeAgentEnvironmentValue(variable);
      if (value === undefined) {
        if (requireComplete) throw new Error(`The configured environment value ${variable.key} could not be read; no machine settings were sent.`);
        continue;
      }
      // A folder on this computer does not exist on a cloud machine.
      if (forCloudMachines && variable.source === "automatic" && isLocalPathValue(value)) {
        continue;
      }
      env[variable.key] = value;
    }
    // Native directories belong to the machine, even if the source laptop
    // explicitly configured CODEX_HOME / CLAUDE_CONFIG_DIR in Settings.
    const filtered = filterAllowedAgentEnvironment({ ...env,
      ...(this.deps.options?.profileHome ? machineProfileVariables(this.deps.options.profileHome) : {}) });
    const present = new Set(Object.keys(filtered).map(environmentKeyId));
    const removedKeys = [...(stored.agentEnvironment?.removedAutomaticKeys ?? [])]
      .filter((key) => !present.has(environmentKeyId(key)));
    const version = agentEnvironmentVersion(filtered, removedKeys);
    // An undefined entry takes the name out of what a member inherits from
    // this computer: child processes skip undefined values.
    const runEnv: NodeJS.ProcessEnv = { ...filtered };
    if (!forCloudMachines) {
      for (const key of removedKeys) runEnv[key] = undefined;
    }
    return { env: runEnv, version, removedKeys };
  }

  /** A value the User saves is hers: it stays until she changes or deletes it,
   *  whatever the computer says later. */
  async saveAgentEnvironmentVariable(update: SaveAgentEnvironmentVariableRequest): Promise<void> {
    const key = assertAgentEnvironmentKeyAllowed(update.key);
    if (typeof update.value !== "string" || !update.value) {
      throw new Error("Enter a value to save.");
    }
    const stored = await this.settings.settingsStore.readStored();
    const variables = stored.agentEnvironment?.variables ?? [];
    const encoded = this.settings.secrets.encodeAgentEnvironmentValue(update.value);
    const nextVariable: StoredAgentEnvironmentVariable = {
      key,
      encryptedValue: encoded.encryptedValue,
      enabled: true,
      updatedAt: new Date().toISOString(),
      protection: encoded.protection
    };
    const kept = variables.filter((variable) => environmentKeyId(variable.key) !== environmentKeyId(key));
    stored.agentEnvironment = {
      variables: normalizeAgentEnvironmentVariables([...kept, nextVariable]),
      removedAutomaticKeys: (stored.agentEnvironment?.removedAutomaticKeys ?? [])
        .filter((removed) => environmentKeyId(removed) !== environmentKeyId(key))
    };
    await this.settings.settingsStore.writeStored(stored);
  }

  /** Deleting is the same for every variable. When this computer sets the
   *  name too (or the variable came from it), the name is remembered so the
   *  next reading does not bring it back. */
  async deleteAgentEnvironmentVariable(key: string, setByThisComputer = false): Promise<void> {
    const normalized = assertAgentEnvironmentKeyAllowed(key);
    const stored = await this.settings.settingsStore.readStored();
    const variables = stored.agentEnvironment?.variables ?? [];
    const deleted = variables.find((variable) => environmentKeyId(variable.key) === environmentKeyId(normalized));
    const removed = new Set(stored.agentEnvironment?.removedAutomaticKeys ?? []);
    if (setByThisComputer || deleted?.source === "automatic") {
      removed.add(deleted?.key ?? normalized);
    }
    stored.agentEnvironment = {
      variables: variables.filter((variable) => environmentKeyId(variable.key) !== environmentKeyId(normalized)),
      removedAutomaticKeys: [...removed].sort()
    };
    await this.settings.settingsStore.writeStored(stored);
  }

  /** Brings the automatic variables in step with what this computer sets now:
   *  a new name is added, a changed value is updated, a name the computer no
   *  longer sets goes away. A value the User saved and a name she deleted are
   *  left as she made them. Returns whether anything changed. */
  async reconcileAutomaticAgentEnvironment(computerEnvironment: Record<string, string>): Promise<boolean> {
    const stored = await this.settings.settingsStore.readStored();
    const removedNames = stored.agentEnvironment?.removedAutomaticKeys ?? [];
    const removed = new Set(removedNames.map(environmentKeyId));
    const current = stored.agentEnvironment?.variables ?? [];
    const byKey = new Map(current.map((variable) => [environmentKeyId(variable.key), variable]));
    const computer = new Map(Object.entries(computerEnvironment).map(([key, value]) => [environmentKeyId(key), value]));
    const now = new Date().toISOString();
    let changed = false;
    const next: StoredAgentEnvironmentVariable[] = [];
    for (const variable of current) {
      if (variable.source !== "automatic") {
        next.push(variable);
        continue;
      }
      const value = computer.get(environmentKeyId(variable.key));
      if (value === undefined || removed.has(environmentKeyId(variable.key))) {
        changed = true;
        continue;
      }
      const storedValue = this.settings.secrets.decodeAgentEnvironmentValue(variable);
      // Unreadable only because the secret store is away: keep it rather than
      // rewrite it (and restart members) on every reading.
      if (storedValue === value || (storedValue === undefined && !this.settings.secrets.safeStorageEncryptionAvailable())) {
        next.push(variable);
        continue;
      }
      next.push({ ...variable, ...this.settings.secrets.encodeAgentEnvironmentValue(value), enabled: true, updatedAt: now });
      changed = true;
    }
    for (const [key, value] of Object.entries(computerEnvironment).sort(([left], [right]) => left.localeCompare(right))) {
      if (byKey.has(environmentKeyId(key)) || removed.has(environmentKeyId(key)) || !isAutomaticAgentEnvironmentKey(key)) {
        continue;
      }
      next.push({ key, ...this.settings.secrets.encodeAgentEnvironmentValue(value), enabled: true, updatedAt: now, source: "automatic" });
      changed = true;
    }
    if (!changed) {
      return false;
    }
    stored.agentEnvironment = {
      variables: normalizeAgentEnvironmentVariables(next),
      removedAutomaticKeys: [...removedNames].sort()
    };
    await this.settings.settingsStore.writeStored(stored);
    return true;
  }
}
