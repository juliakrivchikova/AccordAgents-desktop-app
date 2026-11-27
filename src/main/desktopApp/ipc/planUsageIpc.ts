import { ipcMain } from "electron";
import { isPlanUsageProvider } from "../../../shared/planUsage";
import type { PlanUsageRefreshRequest } from "../../../shared/types";
import type { DesktopApp } from "../desktopApp";

/** The plan usage rings: this computer's CLI accounts and each machine's. */
export function registerPlanUsageIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("plan-usage:get", () => desktopApp.planUsageLink.view());

  ipcMain.handle("plan-usage:refresh", (_event, request: Partial<PlanUsageRefreshRequest> | undefined) => {
    if (!isPlanUsageProvider(request?.provider)) throw new Error("Not a CLI with plan limits.");
    const machineId = typeof request.machineId === "string" && request.machineId.trim() ? request.machineId : undefined;
    return desktopApp.planUsageLink.refresh({ provider: request.provider, ...(machineId ? { machineId } : {}), force: request.force === true });
  });
}
