import { randomUUID } from "node:crypto";
import { wireChatAppToolHandlers } from "../appToolWiring";
import { sendToMainWindow } from "./windowState";
import type { DesktopApp } from "./desktopApp";

export function wireChatToMachines(desktopApp: DesktopApp): void {
  desktopApp.chatService.setCloudRunPreparation(async (selection, provider, progress) => {
    if (provider !== "codex-cli" && provider !== "claude-code") throw new Error("This provider does not support Cloud run.");
    // A member's turn: a stopped instance is started for it.
    const result = await desktopApp.cloudRunPreparation.prepare({ operationId: randomUUID(), provider, instanceId: selection.instanceId }, progress, { startStopped: true });
    return result.machine.id;
  });

  desktopApp.chatService.setCloudRunAwsService(desktopApp.cloudRunAwsService);
  desktopApp.chatService.setPromptSuggestionsListener((update) => sendToMainWindow(desktopApp, "chat:prompt-suggestions", update));
  desktopApp.chatService.onBackgroundTasksChanged((event) => sendToMainWindow(desktopApp, "chat:background-tasks", event));
  desktopApp.chatService.setMachineProjectPreparation((machineId, localPath, signal, progress) => desktopApp.cloudRunPreparation.prepareProject(machineId, localPath, signal, progress));

  // A machine found its copy of a project missing: the next turn copies it again.
  desktopApp.chatService.setMachineProjectMissingHandler(async (machineId, localPath) => {
    if (await desktopApp.cloudRunPreparation.forgetProject(machineId, localPath)) void desktopApp.debugLogService.write("machines.project.missing-forgotten", { machineId });
  });

  desktopApp.chatService.setCloudRunDoctorService(desktopApp.cloudRunDoctorService);
  wireChatAppToolHandlers(desktopApp.appMcpService, desktopApp.chatService);
}
