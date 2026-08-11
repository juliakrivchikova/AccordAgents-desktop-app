import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import { app } from "electron";
import { DebugLogService } from "./debugLogs";

export const STABLE_UPDATE_REPO = "juliakrivchikova/AccordAgents-Releases";
export const BETA_UPDATE_REPO = "juliakrivchikova/AccordAgents-Beta-Releases";

export function resolveUpdateRepo(betaUpdates: boolean): string {
  return betaUpdates === true ? BETA_UPDATE_REPO : STABLE_UPDATE_REPO;
}

export function supportsAutoUpdates(isPackaged: boolean, platform: NodeJS.Platform): boolean {
  return isPackaged && (platform === "darwin" || platform === "win32");
}

export function bootstrapAppUpdater(debugLogs: DebugLogService, betaUpdates: boolean): void {
  if (!supportsAutoUpdates(app.isPackaged, process.platform)) {
    return;
  }

  const repo = resolveUpdateRepo(betaUpdates);

  try {
    void debugLogs.write("app-updater-bootstrap", {
      channel: betaUpdates ? "beta" : "stable",
      repo
    });
    updateElectronApp({
      updateSource: {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo
      },
      updateInterval: "1 hour",
      notifyUser: true
    });
  } catch (error) {
    void debugLogs.write("app-updater-bootstrap-error", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
