import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import { app } from "electron";
import { DebugLogService } from "./debugLogs";

const UPDATE_REPO = "juliakrivchikova/accordagents-releases";

export function bootstrapAppUpdater(debugLogs: DebugLogService): void {
  if (!app.isPackaged || process.platform !== "darwin") {
    return;
  }

  try {
    updateElectronApp({
      updateSource: {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo: UPDATE_REPO
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
