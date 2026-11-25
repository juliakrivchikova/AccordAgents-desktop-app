import { ipcMain } from "electron";
import type {
  DeleteScriptSecretRequest, GetScriptRevisionRequest, ScriptIdRequest, SetScriptEnabledRequest, SetScriptSecretRequest
} from "../../../shared/scripts";
import type { DesktopApp } from "../desktopApp";

export function registerScriptsIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("scripts:list", () => desktopApp.scriptHub.list());

  ipcMain.handle("scripts:get-revision", (_event, request: GetScriptRevisionRequest) =>
    desktopApp.scriptHub.revision(request.hostId, request.scriptId, request.revisionId));

  ipcMain.handle("scripts:runs", (_event, request: ScriptIdRequest) => desktopApp.scriptHub.runs(request.hostId, request.scriptId));

  ipcMain.handle("scripts:set-secret", (_event, request: SetScriptSecretRequest) =>
    desktopApp.scriptHub.setSecret(request.hostId, request.scriptId, request.name, request.value));

  ipcMain.handle("scripts:delete-secret", (_event, request: DeleteScriptSecretRequest) =>
    desktopApp.scriptHub.deleteSecret(request.hostId, request.scriptId, request.name));

  ipcMain.handle("scripts:set-enabled", (_event, request: SetScriptEnabledRequest) =>
    desktopApp.scriptHub.setEnabled(request.hostId, request.scriptId, request.enabled));

  ipcMain.handle("scripts:run-now", (_event, request: ScriptIdRequest) => desktopApp.scriptHub.control(request.hostId, "runNow", request.scriptId));
  ipcMain.handle("scripts:delete", (_event, request: ScriptIdRequest) => desktopApp.scriptHub.control(request.hostId, "delete", request.scriptId));
  ipcMain.handle("scripts:release-held", (_event, request: ScriptIdRequest) => desktopApp.scriptHub.control(request.hostId, "releaseHeld", request.scriptId));
  ipcMain.handle("scripts:discard-held", (_event, request: ScriptIdRequest) => desktopApp.scriptHub.control(request.hostId, "discardHeld", request.scriptId));
}
