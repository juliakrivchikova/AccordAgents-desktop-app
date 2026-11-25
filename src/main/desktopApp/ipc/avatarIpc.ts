import { ipcMain } from "electron";
import type { AvatarStudioTurnRequest, SaveCustomAvatarRequest } from "../../../shared/avatarStudio";
import type { DesktopApp } from "../desktopApp";

export function registerAvatarIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("avatar-studio:run-turn", (_event, request: AvatarStudioTurnRequest) => desktopApp.avatarStudioService.runTurn(request));
  ipcMain.handle("avatar-studio:cancel", (_event, studioId: string) => desktopApp.avatarStudioService.cancel(studioId));
  ipcMain.handle("avatar-studio:close", (_event, studioId: string) => desktopApp.avatarStudioService.closeStudio(studioId));
  ipcMain.handle("settings:save-custom-avatar", (_event, request: SaveCustomAvatarRequest) => desktopApp.settingsService.saveCustomAvatar(request));
  ipcMain.handle("settings:read-custom-avatar", (_event, id: string) => desktopApp.settingsService.readCustomAvatar(id));
}
