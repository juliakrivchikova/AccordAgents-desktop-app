import { ipcMain } from "electron";
import type { ReadFilePreviewRequest, UnsavedFileEdit, WriteFilePreviewRequest } from "../../../shared/types";
import type { DesktopApp } from "../desktopApp";

export function registerFilesIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("files:read", async (_event, request: ReadFilePreviewRequest) => {
    const preview = await desktopApp.filePreviewService.read(request);
    desktopApp.usageMilestones?.reach("file_preview_opened");
    return preview;
  });

  ipcMain.handle("files:write", (_event, request: WriteFilePreviewRequest) => desktopApp.filePreviewService.write(request));
  ipcMain.handle("files:watch", (_event, request: ReadFilePreviewRequest) => desktopApp.filePreviewService.watch(request));
  ipcMain.handle("files:unwatch", (_event, realPath: unknown) => desktopApp.filePreviewService.unwatch(realPath));
  ipcMain.handle("files:release", (_event, realPath: unknown) => desktopApp.filePreviewService.release(realPath));
  ipcMain.handle("files:unsaved-save", (_event, edit: UnsavedFileEdit) => desktopApp.filePreviewService.saveUnsaved(edit));
  ipcMain.handle("files:unsaved-clear", (_event, realPath: unknown) => desktopApp.filePreviewService.clearUnsaved(realPath));
  ipcMain.handle("files:unsaved-list", () => desktopApp.filePreviewService.listUnsaved());
  ipcMain.on("files:flush-done", (_event, requestId: unknown) => desktopApp.fileEditFlusher.acknowledge(requestId));
}
