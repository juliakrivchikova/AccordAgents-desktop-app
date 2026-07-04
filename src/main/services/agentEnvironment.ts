import type {
  AgentEnvironmentKey,
  AgentEnvironmentSnapshot,
  AgentEnvironmentValueProtection
} from "../../shared/types";
import { safeStorage } from "electron";
import { filterAllowedAgentEnvironment } from "../../shared/agentEnvironment";
import { commandEnvironment, ensureLoginShellEnvPrimed } from "./command";
import { forwardedDesktopEnvironment } from "./remoteRuns";
import type { SettingsService } from "./settings";

export const AGENT_ENVIRONMENT_LOCAL_DISCLOSURE =
  "Local CLI agents also inherit the broader desktop and login-shell environment. This page lists the curated propagated set plus manual variables to avoid exposing hundreds of machine-local keys.";

export class AgentEnvironmentService {
  constructor(private readonly settings: SettingsService) {}

  async snapshot(): Promise<AgentEnvironmentSnapshot> {
    await ensureLoginShellEnvPrimed();
    const forwarded = forwardedDesktopEnvironment(commandEnvironment());
    const forwardedKeys = new Set(Object.keys(forwarded).sort((left, right) => left.localeCompare(right)));
    const manualVariables = await this.settings.listManualAgentEnvironmentVariables(forwardedKeys);
    const keys = new Map<string, AgentEnvironmentKey>();

    for (const key of forwardedKeys) {
      keys.set(key, {
        key,
        source: "forwarded",
        manual: false,
        overridesDetected: false
      });
    }

    for (const manual of manualVariables) {
      if (!manual.enabled) {
        continue;
      }
      keys.set(manual.key, {
        key: manual.key,
        source: "manual",
        manual: true,
        overridesDetected: forwardedKeys.has(manual.key)
      });
    }

    return {
      refreshedAt: new Date().toISOString(),
      keys: [...keys.values()].sort((left, right) => left.key.localeCompare(right.key)),
      manualVariables,
      forwardedCount: forwardedKeys.size,
      manualEnabledCount: manualVariables.filter((variable) => variable.enabled).length,
      localInheritanceDisclosure: AGENT_ENVIRONMENT_LOCAL_DISCLOSURE,
      valueProtection: this.currentValueProtection()
    };
  }

  async manualEnvForRun(): Promise<{ env: NodeJS.ProcessEnv; version: string }> {
    const manual = await this.settings.getManualAgentEnvironment();
    return {
      env: filterAllowedAgentEnvironment(manual.env),
      version: manual.version
    };
  }

  private currentValueProtection(): AgentEnvironmentValueProtection {
    return safeStorage?.isEncryptionAvailable?.() ? "os-encrypted" : "local-obfuscated";
  }
}
