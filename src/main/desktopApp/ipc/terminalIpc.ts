import { ipcMain } from "electron";
import type { CreateTerminalRequest } from "../../../shared/terminal";
import { assertAppPage } from "../windows";
import type { DesktopApp } from "../desktopApp";

export function registerTerminalIpc(desktopApp: DesktopApp): void {
  // A shell is the most powerful thing the window can ask for: only the
  // app's own page may, never a document the window was navigated to.
  ipcMain.handle("terminal:list", (event) => {
    assertAppPage(desktopApp, event);
    desktopApp.terminalService.watchWindow(event.sender);
    return desktopApp.terminalService.list();
  });

  ipcMain.handle("terminal:create", async (event, request: CreateTerminalRequest | undefined) => {
    assertAppPage(desktopApp, event);
    desktopApp.terminalService.watchWindow(event.sender);
    const created = await desktopApp.terminalService.create(request ?? {});
    desktopApp.usageMilestones?.reach("terminal_opened");
    return created;
  });

  ipcMain.handle("terminal:kill", (event, terminalId: string) => {
    assertAppPage(desktopApp, event);
    desktopApp.terminalService.kill(String(terminalId));
  });

  ipcMain.handle("terminal:connect", (event) => {
    assertAppPage(desktopApp, event);
    return desktopApp.terminalService.connect(event.sender);
  });

  ipcMain.handle("terminal:restart", (event) => {
    assertAppPage(desktopApp, event);
    return desktopApp.terminalService.restartLost();
  });

  ipcMain.handle("terminal:workspace-root", (event, repoPath: string | undefined) => {
    assertAppPage(desktopApp, event);
    return desktopApp.terminalService.workspaceRoot(typeof repoPath === "string" ? repoPath : undefined);
  });
}
