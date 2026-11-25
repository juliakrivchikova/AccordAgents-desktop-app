import path from "node:path";
import { HubInstaller, removeStaleHubTemp } from "../services/hubInstaller";
import { app } from "electron";
import { startHubLink } from "./hubLink";
import { hubLinkNotices } from "./hubRoster";
import { restartServerChatLink } from "./serverChat";
import { sendToMainWindow } from "./windowState";
import type { DesktopApp } from "./desktopApp";

export function createHubInstaller(desktopApp: DesktopApp): void {
  desktopApp.hubInstaller = new HubInstaller({
    keyDir: path.join(app.getPath("userData"), "hub"),
    payloadDir: hubPayloadDir,
    bundledVersion: app.getVersion(),
    identity: async () => {
      const identity = await desktopApp.deviceIdentityService.getOrCreateDeviceIdentity();
      return { originId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64 };
    },
    link: async ({ url, hubId, hubKey, server }) => {
      // A server program from before servers had a key says none: the key
      // learned before (if any) stays.
      const before = await desktopApp.settingsService.getHubConfig().catch(() => undefined);
      const keptKey = hubKey ?? (before?.hubId === hubId ? before?.hubKey : undefined);
      await desktopApp.settingsService.saveHubConfig({ url, hubId, ...(keptKey ? { hubKey: keptKey } : {}), server });
      await startHubLink(desktopApp);
      // The chats move to the new server (once per server) and go through it
      // from now on.
      await restartServerChatLink(desktopApp);
    },
    currentLink: () => desktopApp.settingsService.getHubConfig().catch(() => undefined),
    reachable: () => desktopApp.serverChatLink.reachable(),
    notices: () => hubLinkNotices(desktopApp),
    defaultRegion: async () => (await desktopApp.settingsService.getPublicSettings()).cloudRuns.awsRegion,
    log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
  });

  desktopApp.hubInstaller.onProgress((state) => {
    sendToMainWindow(desktopApp, "hub:setup-progress", state);
  });

  void removeStaleHubTemp().then((removed) => {
    if (removed) void desktopApp.debugLogService.write("hub.setup.temp-removed", { removed });
  });
}

/** The hub program this app installs: beside the asar when packaged (scp
 *  reads real files), what `npm run build` produced in a checkout. */
function hubPayloadDir(): string {
  const override = process.env.ACCORDAGENTS_HUB_BUNDLE_DIR?.trim();
  if (override) return override;
  if (app.isPackaged) return path.join(process.resourcesPath, "hub");
  return path.join(app.getAppPath(), "dist", "hub");
}
