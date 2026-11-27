import { URGENT_ALERT_USER_ACTIONS, type UrgentAlertSettingsView, type UrgentAlertUserRequest } from "../../../shared/urgentAlerts";
import { ipcMain } from "electron";
import { hostPlatform } from "../../platform";
import { openAlertCallContact } from "../alertCallContact";
import { publishHubRoster } from "../hubRoster";
import { createPhoneInvite } from "../phoneInvites";
import type { DesktopApp } from "../desktopApp";

export function registerHubIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("hub:setup-state", () => desktopApp.hubInstaller.state());
  let alertsPublicUrlSaid: { key: string; at: number } | undefined;

  ipcMain.handle("alerts:request", async (_event, request: unknown) => {
    const action = (request as { action?: unknown } | undefined)?.action;
    if (!request || typeof request !== "object" || typeof action !== "string" || !URGENT_ALERT_USER_ACTIONS.has(action)) {
      return { ok: false, error: { code: "invalid_request", message: "Unknown alert request." } };
    }
    if (action !== "close") {
      // Where Twilio reaches the server: the address this computer links to,
      // when it is the User's own server (https); none for the one in the app.
      // Said again when it changes, and every few minutes (a new server).
      const config = await desktopApp.settingsService.getHubConfig();
      const url = config?.url && /^https:\/\//.test(config.url) ? config.url : undefined;
      const key = `${config?.url ?? "in-app"}|${url ?? ""}`;
      if (alertsPublicUrlSaid?.key !== key || Date.now() - alertsPublicUrlSaid.at > 5 * 60_000) {
        const said = await desktopApp.serverChatLink.alerts({ action: "public-url", ...(url ? { url } : {}) });
        alertsPublicUrlSaid = said.ok ? { key, at: Date.now() } : undefined;
      }
    }
    const result = await desktopApp.serverChatLink.alerts<unknown>(request as UrgentAlertUserRequest);
    desktopApp.usageMilestones?.observeUrgentAlertRequest(action, result);
    return result;
  });

  ipcMain.handle("alerts:open-call-contact", () => openAlertCallContact({
    settings: () => desktopApp.serverChatLink.alerts<UrgentAlertSettingsView>({ action: "settings" }),
    openPath: (target) => hostPlatform().openPath(target)
  }));

  ipcMain.handle("hub:setup-command", async (_event, request: import("../../../shared/hubSetup").HubSetupCommandRequest) => {
    const region = typeof request?.region === "string" ? request.region.trim() : "";
    return { command: await desktopApp.hubInstaller.command(region), region };
  });

  ipcMain.handle("hub:install", (_event, request: import("../../../shared/hubSetup").HubInstallRequest) => desktopApp.hubInstaller.install({
    ...(typeof request?.blob === "string" ? { blob: request.blob } : {}),
    ...(request?.startOver === true ? { startOver: true } : {})
  }));

  ipcMain.handle("mobile:create-phone-invite", async (_event, request: import("../../../shared/types").CreatePhoneInviteRequest | undefined) => createPhoneInvite(desktopApp, request ?? {}));

  ipcMain.handle("mobile:revoke-phone-invite", async (_event, request: { inviteId?: string } | undefined) => {
    const inviteId = typeof request?.inviteId === "string" ? request.inviteId.trim() : "";
    if (!inviteId) throw new Error("Revoking a phone needs its invite.");
    const removed = await desktopApp.settingsService.revokePhoneInvite(inviteId);
    desktopApp.hubPhonePublisher.phonesChanged();
    // The last phone gone: the server keeps no start key for it.
    desktopApp.hubPhonePublisher.publishWakeKeys();
    publishHubRoster(desktopApp);
    return { revoked: true, inviteId, ...(removed ? { deviceId: removed } : {}) };
  });
}
