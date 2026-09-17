import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import { app, autoUpdater, dialog } from "electron";
import { DebugLogService } from "./debugLogs";

export const STABLE_UPDATE_REPO = "juliakrivchikova/AccordAgents-Releases";
export const BETA_UPDATE_REPO = "juliakrivchikova/AccordAgents-Beta-Releases";

export function resolveUpdateRepo(betaUpdates: boolean): string {
  return betaUpdates === true ? BETA_UPDATE_REPO : STABLE_UPDATE_REPO;
}

export function supportsAutoUpdates(isPackaged: boolean, platform: NodeJS.Platform): boolean {
  return isPackaged && (platform === "darwin" || platform === "win32");
}

/** How often a pending update, or a machine waiting for idle, is re-checked
 *  when no event announces the change: a turn a phone started on a machine
 *  ends without one reaching this desktop. */
export const ACTIVITY_RECHECK_MS = 60_000;

export interface UpdateRestartInfo {
  releaseName?: string;
  releaseNotes?: string;
}

export interface UpdateRestartGateOptions {
  /** True while any participant is running anywhere: a local member's turn,
   *  a turn this desktop dispatched to a machine, or a turn a machine reports
   *  running. Asked afresh every time; a stale answer would restart the app
   *  underneath a member. */
  isBusy: () => Promise<boolean>;
  /** Called with a listener to re-check when work settles (a run ends, a
   *  machine reports in). Returns the unsubscribe. */
  onActivitySettled: (listener: () => void) => () => void;
  /** Shows the update prompt; resolves with what the User chose. */
  prompt: (info: UpdateRestartInfo) => Promise<"restart" | "later">;
  quitAndInstall: () => void;
  log: (event: string, payload: Record<string, unknown>) => void;
  /** Safety net while an update waits: a machine turn started from the phone
   *  ends without an event this desktop subscribes to. */
  recheckIntervalMs?: number;
}

export interface UpdateRestartGate {
  /** The updater's update-downloaded hook. */
  onDownloaded: (info: UpdateRestartInfo) => void;
  /** The update waiting for a quiet moment, if any. */
  pending: () => UpdateRestartInfo | undefined;
  dispose: () => void;
}

/**
 * A downloaded update is applied only when nothing is running anywhere.
 *
 * Restarting the desktop kills the local members' CLI processes, and the new
 * desktop then upgrades every machine's runtime, which kills the members
 * there. So the prompt to restart is not shown while any member is working,
 * on this desktop or on a machine; it is shown as soon as they all settle.
 * "Later" keeps the library's meaning: no further prompt for this download,
 * the update installs on the next quit.
 */
export function createUpdateRestartGate(options: UpdateRestartGateOptions): UpdateRestartGate {
  let pending: UpdateRestartInfo | undefined;
  let prompting = false;
  let checking = false;
  let deferredLogged = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopWatching = (): void => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const watch = (): void => {
    if (unsubscribe) return;
    unsubscribe = options.onActivitySettled(() => { void attempt(); });
    timer = setInterval(() => { void attempt(); }, options.recheckIntervalMs ?? ACTIVITY_RECHECK_MS);
    timer.unref?.();
  };

  const attempt = async (): Promise<void> => {
    if (!pending || prompting || checking) return;
    checking = true;
    let busy = true;
    try {
      busy = await options.isBusy();
    } catch (error) {
      options.log("app-update-busy-check-error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      checking = false;
    }
    if (!pending) return;
    if (busy) {
      if (!deferredLogged) {
        deferredLogged = true;
        options.log("app-update-deferred", { releaseName: pending.releaseName ?? "" });
      }
      watch();
      return;
    }
    stopWatching();
    prompting = true;
    const info = pending;
    let choice: "restart" | "later" | "unanswered" = "unanswered";
    try {
      choice = await options.prompt(info);
    } catch (error) {
      options.log("app-update-prompt-error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      prompting = false;
    }
    if (choice === "unanswered") {
      // The dialog could not be shown (no window yet): the update is still
      // pending, and the next quiet moment asks again.
      watch();
      return;
    }
    if (choice === "later") {
      options.log("app-update-postponed", { releaseName: info.releaseName ?? "" });
      pending = undefined;
      return;
    }
    // A member may have started while the prompt was open; an answer that
    // cannot be had counts as busy, never as idle.
    let busyAgain = true;
    try { busyAgain = await options.isBusy(); } catch (error) {
      options.log("app-update-busy-check-error", { error: error instanceof Error ? error.message : String(error) });
    }
    if (busyAgain) {
      options.log("app-update-restart-deferred", { releaseName: info.releaseName ?? "" });
      deferredLogged = false;
      watch();
      return;
    }
    options.log("app-update-restarting", { releaseName: info.releaseName ?? "" });
    pending = undefined;
    options.quitAndInstall();
  };

  return {
    onDownloaded: (info) => {
      pending = info;
      deferredLogged = false;
      options.log("app-update-downloaded", { releaseName: info.releaseName ?? "" });
      void attempt();
    },
    pending: () => pending,
    dispose: stopWatching
  };
}

export function bootstrapAppUpdater(debugLogs: DebugLogService, betaUpdates: boolean, gate: UpdateRestartGate): void {
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
      notifyUser: true,
      onNotifyUser: (info) => gate.onDownloaded({ releaseName: info.releaseName, releaseNotes: info.releaseNotes })
    });
  } catch (error) {
    void debugLogs.write("app-updater-bootstrap-error", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/** The library's own prompt, so the User sees the same dialog as before —
 *  just not while a member is working. */
export function showUpdateRestartPrompt(info: UpdateRestartInfo): Promise<"restart" | "later"> {
  return dialog.showMessageBox({
    type: "info",
    buttons: ["Restart", "Later"],
    title: "Application Update",
    message: process.platform === "win32" ? (info.releaseNotes ?? info.releaseName ?? "Update") : (info.releaseName ?? "Update"),
    detail: "A new version has been downloaded. Restart the application to apply the updates."
  }).then(({ response }) => (response === 0 ? "restart" : "later"));
}

export function quitAndInstallUpdate(): void {
  autoUpdater.quitAndInstall();
}
