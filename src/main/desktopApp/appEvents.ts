import { app, autoUpdater, dialog } from "electron";
import { currentUpdateWindows } from "../services/appUpdater";
import { createWindow, updatePromptWindow } from "./windows";
import type { DesktopApp } from "./desktopApp";

export function listenToAppEvents(desktopApp: DesktopApp): void {
  app.on("window-all-closed", () => {
    desktopApp.debugLogService.writeNow("app-window.all-closed", { forUpdate: desktopApp.quittingForUpdate, quitting: desktopApp.quitCleanupStarted });
    // The loader closed by hand while the server updates: the app's window
    // still comes. With its icon in the notification area the app goes on
    // running, as it does in the Dock on macOS.
    if (process.platform !== "darwin" && !desktopApp.serverUpdateLoaderOpen && !desktopApp.backgroundTray) {
      app.quit();
    }
  });

  app.on("second-instance", () => showMainWindow(desktopApp));

  autoUpdater.on("before-quit-for-update", () => {
    if (!desktopApp.updateRestartRequested) {
      // Electron asking again on its own after a restart that failed (every
      // time the windows all close): not a restart, and nothing is stopped.
      desktopApp.debugLogService.writeNow("app-update-before-quit-ignored", { windows: currentUpdateWindows() });
      return;
    }
    const again = desktopApp.quittingForUpdate;
    desktopApp.quittingForUpdate = true;
    desktopApp.debugLogService.writeNow("app-update-before-quit", { again, windows: currentUpdateWindows() });
    // The updater cannot await the normal graceful quit gate. Kill warm CLI
    // process trees synchronously so detached background work cannot outlive the
    // app and keep mutating the repository during installation.
    desktopApp.cliAgentRunner.terminateWarmAgentsImmediately("update installation");
  });

  /**
   * A restart for an update that did not happen. Electron closes every window
   * for it and then asks the native updater to install; when that finds nothing
   * to install ("No update available, can't quit and install") or cannot
   * relaunch, it reports an error and the app goes on running with no window
   * — on the User's desktop on 2026-10-29 it looked as if the app had updated,
   * and it was still beta.7. The window comes back and says what to do: the
   * downloaded update still installs when the app quits.
   */
  autoUpdater.on("error", (error: Error) => {
    if (!desktopApp.updateRestartRequested) return;
    desktopApp.updateRestartRequested = false;
    desktopApp.quittingForUpdate = false;
    // No quit happened: the next one asks about the terminal's commands again.
    desktopApp.quitConfirmation.revoke();
    desktopApp.debugLogService.writeNow("app-update-restart-failed", { message: error instanceof Error ? error.message : String(error) });
    setImmediate(() => {
      if (!desktopApp.mainWindow || desktopApp.mainWindow.isDestroyed()) createWindow(desktopApp);
      const window = desktopApp.mainWindow;
      if (!window) return;
      const say = (): void => {
        if (window.isDestroyed()) return;
        if (!window.isVisible()) window.show();
        void dialog.showMessageBox(window, {
          type: "warning",
          buttons: ["OK"],
          message: "The update was not installed",
          detail: "Quit AccordAgents and open it again to finish installing it."
        }).then(() => { void desktopApp.debugLogService.write("app-update-restart-failed-shown", {}); });
      };
      if (window.webContents.isLoading()) window.webContents.once("did-finish-load", say);
      else say();
    });
  });
}

/** A second launch on Windows (see launcher.ts) and the tray icon open the
 *  window; before the first one has opened, it is on its way anyway. */
export function showMainWindow(desktopApp: DesktopApp): void {
  if (!desktopApp.appWindowOpened) return;
  // The app's own window, also one whose page crashed: that one is reloaded,
  // not joined by a second window.
  const window = updatePromptWindow(desktopApp);
  if (!window) {
    createWindow(desktopApp);
    return;
  }
  if (window.webContents.isCrashed()) window.webContents.reload();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
