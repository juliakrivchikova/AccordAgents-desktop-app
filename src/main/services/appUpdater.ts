import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import { app, autoUpdater, BrowserWindow, dialog } from "electron";
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
 *  ends without one reaching this desktop. Asking a machine costs it a full
 *  greeting (provider detection, re-sent results), so this is minutes, not
 *  seconds; the events cover the common case. */
export const ACTIVITY_RECHECK_MS = 5 * 60_000;

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
  /** Called with a listener once the prompt had no window to show on; calls
   *  it when the User brings one up. Returns the unsubscribe. Only then:
   *  each busy check greets every machine, too dear for every focus. */
  onWindowAvailable?: (listener: () => void) => () => void;
  /** Whether a window to ask on is up now. Without one nothing is checked:
   *  the busy check greets every machine, and its answer could not be used. */
  canPrompt?: () => boolean;
  /** Shows the update prompt; resolves with what the User chose, or
   *  "unanswered" when it cannot be shown now (no window to show it in). */
  prompt: (info: UpdateRestartInfo) => Promise<"restart" | "later" | "unanswered">;
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
  let unansweredLogged = false;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeWindow: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopWatching = (): void => {
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeWindow?.();
    unsubscribeWindow = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const watch = (): void => {
    if (unsubscribe) return;
    unsubscribe = options.onActivitySettled(() => { void attempt(); });
    timer = setInterval(() => { void attempt(); }, options.recheckIntervalMs ?? ACTIVITY_RECHECK_MS);
    timer.unref?.();
  };

  const waitForWindow = (info: UpdateRestartInfo): void => {
    if (!unansweredLogged) {
      unansweredLogged = true;
      options.log("app-update-prompt-waiting", { releaseName: info.releaseName ?? "" });
    }
    if (!unsubscribeWindow && options.onWindowAvailable) {
      unsubscribeWindow = options.onWindowAvailable(() => {
        unsubscribeWindow?.();
        unsubscribeWindow = undefined;
        void attempt();
      });
    }
    watch();
  };

  const attempt = async (): Promise<void> => {
    if (!pending || prompting || checking) return;
    if (options.canPrompt && !options.canPrompt()) {
      waitForWindow(pending);
      return;
    }
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
      // pending, and the next quiet moment (or the window coming back) asks
      // again.
      waitForWindow(info);
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
      unansweredLogged = false;
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
    // The library reports these only to the console, which a packaged app
    // does not keep; an update that never offers itself or never installs is
    // otherwise invisible. Registered before the library's first check.
    autoUpdater.on("checking-for-update", () => { void debugLogs.write("app-update-checking", {}); });
    autoUpdater.on("update-available", () => { void debugLogs.write("app-update-available", {}); });
    autoUpdater.on("update-not-available", () => { void debugLogs.write("app-update-not-available", {}); });
    // A failed install ("No update available, can't quit and install", a
    // relaunch error) arrives here, not as a throw, and can be the last thing
    // the process does: written before returning.
    autoUpdater.on("error", (error: Error & { code?: unknown; domain?: unknown }) => {
      debugLogs.writeNow("app-update-error", {
        message: error instanceof Error ? error.message : String(error),
        ...(error && error.code !== undefined ? { code: error.code } : {}),
        ...(error && error.domain !== undefined ? { domain: error.domain } : {})
      });
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
 *  just not while a member is working — attached to the app's window.
 *
 *  Never without a window: on macOS a message box with no parent window runs
 *  modally inside the call, and the whole main process waits for the answer.
 *  On 2026-10-20 that stopped every member, the phone and the machines for 4
 *  and then 8 hours, until the User came back and pressed Restart. A sheet on
 *  the window waits without stopping anything; with no window open, the
 *  question waits for one. */
export function showUpdateRestartPrompt(info: UpdateRestartInfo, window: BrowserWindow | undefined): Promise<"restart" | "later" | "unanswered"> {
  // A hidden or minimized window waits too: newer Electron versions run the
  // box modally for a parent that is not shown, which is the freeze again.
  if (!updatePromptWindowShown(window)) return Promise.resolve("unanswered");
  // Quitting (Cmd+Q, the Dock, logging out) ends the sheet before the window
  // closes, and an ended sheet reports its cancel button, which is Restart
  // here: that is no answer, and the update still installs as the app quits.
  let quitting = false;
  const onQuit = (): void => { quitting = true; };
  app.on("before-quit", onQuit);
  window.once("close", onQuit);
  return dialog.showMessageBox(window, {
    type: "info",
    buttons: ["Restart", "Later"],
    title: "Application Update",
    message: process.platform === "win32" ? (info.releaseNotes ?? info.releaseName ?? "Update") : (info.releaseName ?? "Update"),
    detail: "A new version has been downloaded. Restart the application to apply the updates."
  }).then(({ response }) => (quitting ? "unanswered" : response === 0 ? "restart" : "later"))
    .finally(() => {
      app.removeListener("before-quit", onQuit);
      if (!window.isDestroyed()) window.removeListener("close", onQuit);
    });
}

/** A window the question can be asked on: there, shown, not minimized. */
export function updatePromptWindowShown(window: Pick<BrowserWindow, "isDestroyed" | "isVisible" | "isMinimized"> | undefined): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized());
}

export function quitAndInstallUpdate(): void {
  autoUpdater.quitAndInstall();
}

/** A window as it stands when the app restarts for an update: Electron
 *  installs only once every window has closed, so a window that stays open
 *  holds the restart. */
export interface UpdateWindowState {
  id?: number;
  destroyed?: boolean;
  visible?: boolean;
  enabled?: boolean;
  childWindows?: number;
  focused?: boolean;
  minimized?: boolean;
  fullScreen?: boolean;
  closable?: boolean;
  rendererCrashed?: boolean;
  /** The page is gone while the window is still open. */
  contentsDestroyed?: boolean;
  loading?: boolean;
  /** The window could not be read (it went away while being read). */
  error?: string;
}

/** The parts of a window read here; a BrowserWindow is one. */
export interface UpdateWindowLike {
  id: number;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  isClosable(): boolean;
  isEnabled(): boolean;
  getChildWindows(): unknown[];
  webContents: { isDestroyed(): boolean; isCrashed(): boolean; isLoading(): boolean } | null;
}

/** Never throws: it is read inside the quit path, where an exception would
 *  stop the quit itself. */
export function describeUpdateWindows(windows: UpdateWindowLike[]): UpdateWindowState[] {
  return windows.map((window) => {
    let id: number | undefined;
    try {
      id = window.id;
      if (window.isDestroyed()) return { id, destroyed: true };
      const contents = window.webContents && !window.webContents.isDestroyed() ? window.webContents : undefined;
      return {
        id,
        destroyed: false,
        visible: window.isVisible(),
        enabled: window.isEnabled(),
        focused: window.isFocused(),
        minimized: window.isMinimized(),
        fullScreen: window.isFullScreen(),
        closable: window.isClosable(),
        childWindows: window.getChildWindows().length,
        ...(contents ? { rendererCrashed: contents.isCrashed(), loading: contents.isLoading() } : { contentsDestroyed: true })
      };
    } catch (error) {
      return { ...(id !== undefined ? { id } : {}), error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function currentUpdateWindows(): UpdateWindowState[] {
  try {
    return describeUpdateWindows(BrowserWindow.getAllWindows());
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }];
  }
}

/** Whether the app itself is hidden (Cmd+H): a hidden app's windows are
 *  closed all the same, but it is worth seeing next to a stall. */
export function appHiddenForUpdate(): boolean | undefined {
  try {
    return process.platform === "darwin" ? app.isHidden() : undefined;
  } catch {
    return undefined;
  }
}

/** When to record that the app still runs after it was asked to restart. */
export const UPDATE_RESTART_STALL_MS = [30_000, 5 * 60_000];

export interface UpdateRestartOptions {
  quitAndInstall: () => void;
  windows: () => UpdateWindowState[];
  appHidden?: () => boolean | undefined;
  log: (event: string, payload: Record<string, unknown>) => void;
  stallAfterMs?: number[];
}

/**
 * The restart for an update, recorded: what every window looked like when it
 * was asked for and when the call returned, and, if the app is still running
 * a while later, that it is and what holds it. Electron closes the windows
 * inside the call, so a window close logged between the first two records
 * means the close was asked; a window still open with none means it was not
 * even tried. The app quitting ends the process and with it these timers; a
 * stall record means it did not.
 */
export function createUpdateRestart(options: UpdateRestartOptions): () => void {
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    options.log("app-update-quit-and-install", { windows: options.windows(), appHidden: options.appHidden?.() });
    try {
      options.quitAndInstall();
    } catch (error) {
      options.log("app-update-quit-and-install-error", { message: error instanceof Error ? error.message : String(error) });
    }
    options.log("app-update-quit-and-install-returned", { windows: options.windows() });
    for (const afterMs of options.stallAfterMs ?? UPDATE_RESTART_STALL_MS) {
      const timer = setTimeout(() => {
        options.log("app-update-restart-stalled", { afterMs, windows: options.windows(), appHidden: options.appHidden?.() });
      }, afterMs);
      timer.unref?.();
      timers.push(timer);
    }
  };
}
