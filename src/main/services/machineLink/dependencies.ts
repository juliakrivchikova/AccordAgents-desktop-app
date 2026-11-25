import type { DebugLogService } from "../debugLogs";
import type { SettingsService } from "../settings";
import type { MachineLinkOptions } from "./types";

/** What the machine link is given by the app. */
export interface MachineLinkDependencies {
  readonly settings: Pick<SettingsService, "listMachines" | "saveMachine" | "removeMachine" | "getMachinePairing" | "exportMachineSettingsSnapshot"> & Partial<Pick<SettingsService, "restoreMachineEnrollment">>;
  readonly debugLogs: Pick<DebugLogService, "write">;
  readonly options: MachineLinkOptions;
  readonly now: () => Date;
}
