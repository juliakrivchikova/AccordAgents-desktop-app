import { ipcMain } from "electron";
import type { AgentDetectionRequest } from "../../../shared/types";
import { detectAgentsWithAppSkills } from "../agentDetection";
import { normalizeAgentDetectionRequest } from "./pluginRequests";
import { assertAppPage } from "../windows";
import type { DesktopApp } from "../desktopApp";

export function registerAgentsIpc(desktopApp: DesktopApp): void {
  // Starting a program is for the app's own page only, as the terminal is.
  ipcMain.handle("cli-sign-in:start", (event, kind: unknown) => {
    assertAppPage(desktopApp, event, "CLI sign-in", "cli-sign-in.refused-sender");
    return desktopApp.localCliSignInService.start(kind);
  });

  ipcMain.handle("cli-sign-in:list", (event) => {
    assertAppPage(desktopApp, event, "CLI sign-in", "cli-sign-in.refused-sender");
    return desktopApp.localCliSignInService.list();
  });

  ipcMain.handle("cli-sign-in:submit-code", (event, request: { requestId?: unknown; code?: unknown } | undefined) => {
    assertAppPage(desktopApp, event, "CLI sign-in", "cli-sign-in.refused-sender");
    desktopApp.localCliSignInService.submitCode(request?.requestId, request?.code);
  });

  ipcMain.handle("cli-sign-in:cancel", (event, requestId: unknown) => {
    assertAppPage(desktopApp, event, "CLI sign-in", "cli-sign-in.refused-sender");
    desktopApp.localCliSignInService.cancel(requestId);
  });

  ipcMain.handle("agents:detect", async (_event, request?: AgentDetectionRequest) => {
    const agents = await detectAgentsWithAppSkills(desktopApp, normalizeAgentDetectionRequest(request));
    await desktopApp.settingsService.ensureGenericChatParticipantSeeds(agents);
    return agents;
  });
}
