import path from "node:path";
import { SpeechToTextService, resolveSpeechEngine } from "../services/speechToText";
import { app, net, session } from "electron";
import { sendToMainWindow } from "./windowState";
import type { DesktopApp } from "./desktopApp";

export function createSpeechToText(desktopApp: DesktopApp): void {
  desktopApp.speechToTextService = new SpeechToTextService({
    dir: path.join(app.getPath("userData"), "speech-to-text"),
    engine: () => resolveSpeechEngine({
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      override: process.env.ACCORDAGENTS_WHISPER_SERVER
    }),
    // Chromium's network stack: the system proxy and certificates apply.
    fetch: (url, init) => net.fetch(url, init),
    log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
  });

  desktopApp.speechToTextService.onState((state) => {
    sendToMainWindow(desktopApp, "speech:state", state);
  });
}

/**
 * Web content may open the microphone only to dictate: audio alone, from the
 * app's own pages, while speech to text is on and ready. The camera is never
 * opened. Every other permission keeps Electron's default.
 */
export function installMediaPermissionGate(desktopApp: DesktopApp): void {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const isAppPage = (url: string): boolean => url.startsWith("file://") || Boolean(devServerUrl && url.startsWith(devServerUrl));
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== "media") {
      callback(true);
      return;
    }
    const types = "mediaTypes" in details ? details.mediaTypes ?? [] : [];
    callback(
      types.length > 0
      && types.every((type) => type === "audio")
      && isAppPage(details.requestingUrl)
      && desktopApp.speechToTextService.isReadyNow()
    );
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    if (permission !== "media") return true;
    return details.mediaType === "audio" && desktopApp.speechToTextService.isReadyNow();
  });
}
