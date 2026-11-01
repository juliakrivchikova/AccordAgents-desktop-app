import { app, Menu, Tray } from "electron";

/**
 * Windows has no Dock. Closing the window there leaves the app running with
 * its icon in the notification area, as macOS leaves it running in the Dock:
 * phones and machines keep getting answers, and the icon opens the window
 * again or quits. The icon is the app's own, read from its executable.
 */
export async function createBackgroundTray(openWindow: () => void): Promise<Tray> {
  const tray = new Tray(await app.getFileIcon(process.execPath, { size: "normal" }));
  tray.setToolTip("AccordAgents");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open AccordAgents", click: openWindow },
    { type: "separator" },
    { label: "Quit AccordAgents", click: () => app.quit() }
  ]));
  tray.on("click", openWindow);
  return tray;
}
