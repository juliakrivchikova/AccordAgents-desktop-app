import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { InspectLocalFileRequest, OpenLocalFileRequest } from "../../../shared/types";
import { openExternalUrl, openTerminal } from "../windows";
import type { DesktopApp } from "../desktopApp";

export function registerAppIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:is-full-screen", (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);
  ipcMain.handle("app:open-external", (_event, url: unknown) => openExternalUrl(url));
  ipcMain.handle("app:open-terminal", () => openTerminal());
  ipcMain.handle("app:inspect-local-file", (_event, request: InspectLocalFileRequest) => desktopApp.localFileOpenerService.inspectLocalFile(request));
  ipcMain.handle("app:open-local-file", (_event, request: OpenLocalFileRequest) => desktopApp.localFileOpenerService.openLocalFile(request));

  ipcMain.handle("dialog:select-repo", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Select repository",
      properties: ["openDirectory"]
    };
    const result = desktopApp.mainWindow ? await dialog.showOpenDialog(desktopApp.mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  });
}
