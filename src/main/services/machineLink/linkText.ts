import type { MachineSettingsSnapshot } from "../../../shared/machineLink";

export function cleanBackgroundLabels(labels: unknown[]): string[] {
  return labels.filter((label): label is string => typeof label === "string").slice(0, 50);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The part of a settings snapshot a machine uses; the export time is not. */
export function machineSettingsKey(snapshot: MachineSettingsSnapshot): string {
  return JSON.stringify([snapshot.settingsJson, snapshot.agentEnvironment]);
}
