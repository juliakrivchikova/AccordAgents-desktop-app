import { randomUUID } from "node:crypto";
import type { AppSettings, CloudRunsSettingsUpdate, CloudRunWorkerMode } from "../../../../shared/types";
import { DEFAULT_CLOUD_RUNS_SETTINGS } from "./constants";
import { normalizeCloudRunsSettings } from "./storedAws";
import type { SettingsModules } from "../modules";

/** Whether and where members run in the cloud. */
export class CloudRuns {
  constructor(private readonly settings: Pick<SettingsModules, "publicSettings" | "settingsStore">) {}

  async saveCloudRunsSettings(update: CloudRunsSettingsUpdate): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    if (update.mode === "aws" || update.mode === "ssh") {
      stored.cloudRunsMode = update.mode;
    }
    stored.cloudRuns = normalizeCloudRunsSettings({
      ...stored,
      cloudRuns: {
        ...(stored.cloudRuns ?? DEFAULT_CLOUD_RUNS_SETTINGS),
        enabled: update.enabled ?? stored.cloudRuns?.enabled ?? false,
        awsInstanceType: update.awsInstanceType
          ?? stored.cloudRuns?.awsInstanceType
          ?? DEFAULT_CLOUD_RUNS_SETTINGS.awsInstanceType,
        awsRootVolumeSizeGb: update.awsRootVolumeSizeGb
          ?? stored.cloudRuns?.awsRootVolumeSizeGb
          ?? DEFAULT_CLOUD_RUNS_SETTINGS.awsRootVolumeSizeGb,
        maxRuntimeMs: update.maxRuntimeMs ?? stored.cloudRuns?.maxRuntimeMs ?? DEFAULT_CLOUD_RUNS_SETTINGS.maxRuntimeMs,
        pollIntervalMs: update.pollIntervalMs ?? stored.cloudRuns?.pollIntervalMs ?? DEFAULT_CLOUD_RUNS_SETTINGS.pollIntervalMs,
        worker: {
          ...(stored.cloudRuns?.worker ?? {}),
          ...(update.worker ?? {})
        }
      }
    });
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async getCloudRunsDeviceId(): Promise<string> {
    const stored = await this.settings.settingsStore.readStored();
    const existing = stored.cloudRunsDeviceId?.trim();
    if (existing) {
      return existing;
    }
    const created = randomUUID();
    stored.cloudRunsDeviceId = created;
    await this.settings.settingsStore.writeStored(stored);
    return created;
  }

  async setCloudRunsMode(mode: CloudRunWorkerMode): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    stored.cloudRunsMode = mode;
    await this.settings.settingsStore.writeStored(stored);
  }
}
