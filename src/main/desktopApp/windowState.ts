import type { DesktopApp } from "./desktopApp";

/** What the window and the quit are doing. */
export function startWindowState(desktopApp: DesktopApp): void {
  desktopApp.quitCleanupStarted = false;
  desktopApp.quitCleanupFinished = false;
  desktopApp.quittingForUpdate = false;

  // The restart for an update this app asked for (the update prompt's
  // Restart). Electron keeps watching the windows after a restart that failed
  // and asks again every time they all close; those later asks are not one.
  desktopApp.updateRestartRequested = false;

  // Only the loader is up while the User's server updates before the window
  // opens (serverUpdateLoader.ts): no window of the app's own yet.
  desktopApp.serverUpdateLoaderOpen = false;

  desktopApp.appWindowOpened = false;
}

export function sendToMainWindow(desktopApp: DesktopApp, channel: string, ...args: unknown[]): boolean {
  const window = desktopApp.mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return false;
  }
  try {
    window.webContents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}
