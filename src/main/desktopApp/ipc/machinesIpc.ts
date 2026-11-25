import { ipcMain } from "electron";
import type {
  AnswerMachineInactivityRequest, CreateMachineRequest, CreateMachineResult, MachineEnrollmentRequest, MachineInactivityQuestion,
  MachineListResult, MachineTrustedDevicesResult, RemoveMachineRequest, SaveTrustedDeviceRequest
} from "../../../shared/machineLink";
import type {
  MachineInstallRecord, MachineInstallRequest, MachineInstallResult, MachineMirrorBootstrapRequest, MachineMirrorBootstrapResult,
  MachineRuntimePayloadInfo, MachineRuntimeProbe, MachineSshTarget, MachineUpgradeRequest
} from "../../../shared/machineInstall";
import { publishHubRoster } from "../hubRoster";
import { assertMachineId, assertMachineSshTarget, machineListResult, trustedDevicesResult } from "../machineRequests";
import { createMachine, removeMachine } from "../machines";
import { sendToMainWindow } from "../windowState";
import type { DesktopApp } from "../desktopApp";

export function registerMachinesIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("machines:list", async (): Promise<MachineListResult> => machineListResult(desktopApp));

  ipcMain.handle("machines:prepare-cloud-run", async (_event, request: import("../../../shared/cloudRunPreparation").PrepareCloudRunRequest) => {
    return desktopApp.cloudRunPreparation.prepare(request, () => {});
  });

  ipcMain.handle("machines:get-cloud-run-preparation", (_event, request: import("../../../shared/cloudRunPreparation").PrepareCloudRunRequest) => desktopApp.cloudRunPreparation.snapshot(request));

  ipcMain.handle("machines:create", async (_event, request: CreateMachineRequest): Promise<CreateMachineResult> => {
    return createMachine(desktopApp, request);
  });

  ipcMain.handle("machines:inactivity-questions", (): MachineInactivityQuestion[] => desktopApp.machineInactivityQuestions.list());

  ipcMain.handle("machines:inactivity-answer", async (_event, request: AnswerMachineInactivityRequest): Promise<MachineInactivityQuestion[]> => {
    const id = typeof request?.machineId === "string" ? request.machineId : "";
    if (request?.answer === "keep" || request?.answer === "remove") {
      await desktopApp.machineInactivityQuestions.answer(id, request.answer, (machineId) => removeMachine(desktopApp, machineId));
    }
    return desktopApp.machineInactivityQuestions.list();
  });

  ipcMain.handle("machines:remove", async (_event, request: RemoveMachineRequest): Promise<MachineListResult> => {
    const id = typeof request?.id === "string" ? request.id.trim() : "";
    if (!id) {
      throw new Error("Machine id is required.");
    }
    return removeMachine(desktopApp, id);
  });

  ipcMain.handle("machines:install-probe", async (_event, request: { machineId: string; target: MachineSshTarget }): Promise<MachineRuntimeProbe> => {
    return desktopApp.machineInstallerService.probe(assertMachineSshTarget(request?.target));
  });

  ipcMain.handle("machines:install", async (_event, request: MachineInstallRequest): Promise<MachineInstallResult> => {
    return desktopApp.machineInstallerService.install(
      { ...request, machineId: assertMachineId(request?.machineId), target: assertMachineSshTarget(request?.target) },
      (snapshot) => sendToMainWindow(desktopApp, "machines:install-progress", snapshot)
    ).then(async (result) => {
      sendToMainWindow(desktopApp, "machines:updated", await machineListResult(desktopApp));
      return result;
    });
  });

  ipcMain.handle("machines:upgrade", async (_event, request: MachineUpgradeRequest): Promise<MachineInstallResult> => {
    return desktopApp.machineInstallerService.upgrade(
      { ...request, machineId: assertMachineId(request?.machineId), target: assertMachineSshTarget(request?.target) },
      (snapshot) => sendToMainWindow(desktopApp, "machines:install-progress", snapshot)
    ).then(async (result) => {
      sendToMainWindow(desktopApp, "machines:updated", await machineListResult(desktopApp));
      return result;
    });
  });

  ipcMain.handle("machines:bootstrap-mirror", async (_event, request: MachineMirrorBootstrapRequest): Promise<MachineMirrorBootstrapResult> => {
    // Defaults to the project the app currently has open, so the Machines
    // screen does not need its own project picker.
    const localPath = (typeof request?.localPath === "string" ? request.localPath.trim() : "")
      || (await desktopApp.settingsService.getPublicSettings()).lastRepoPath?.trim()
      || "";
    if (!localPath) {
      throw new Error("Open a project first; there is nothing to put on the machine.");
    }
    return desktopApp.machineInstallerService.bootstrapProjectMirror({ machineId: assertMachineId(request?.machineId), localPath });
  });

  ipcMain.handle("machines:install-list", async (): Promise<MachineInstallRecord[]> => desktopApp.settingsService.listMachineInstalls());

  // A machine answers the devices on this list, so the User can see exactly
  // which ones they are and take one off.
  ipcMain.handle("machines:trusted-devices", async (): Promise<MachineTrustedDevicesResult> => trustedDevicesResult(desktopApp));

  ipcMain.handle("machines:trust-device", async (_event, request: SaveTrustedDeviceRequest): Promise<MachineTrustedDevicesResult> => {
    await desktopApp.settingsService.saveTrustedDevice({
      deviceId: String(request?.deviceId ?? "").trim(),
      publicKeyDerBase64: String(request?.publicKeyDerBase64 ?? "").trim(),
      role: request?.role === "phone" ? "phone" : "desktop",
      name: String(request?.name ?? "").trim() || "Another device",
      addedAt: new Date().toISOString()
    });
    publishHubRoster(desktopApp);
    return trustedDevicesResult(desktopApp);
  });

  ipcMain.handle("machines:untrust-device", async (_event, deviceId: string): Promise<MachineTrustedDevicesResult> => {
    await desktopApp.settingsService.removeTrustedDevice(String(deviceId ?? "").trim());
    publishHubRoster(desktopApp);
    return trustedDevicesResult(desktopApp);
  });

  ipcMain.handle("machines:install-payload", async (): Promise<MachineRuntimePayloadInfo> => desktopApp.machineInstallerService.readPayload());

  ipcMain.handle("machines:enrollment", async (_event, request: MachineEnrollmentRequest): Promise<CreateMachineResult> => {
    const id = typeof request?.id === "string" ? request.id.trim() : "";
    const machine = (await desktopApp.settingsService.listMachines()).find((item) => item.id === id);
    if (!machine) {
      throw new Error("Machine not found.");
    }
    const pairing = await desktopApp.settingsService.getMachinePairing(machine.pairingKey);
    if (!pairing) {
      throw new Error("The machine's enrollment is missing; remove and add the machine again.");
    }
    return { machine, enrollmentJson: JSON.stringify(pairing, null, 2) };
  });
}
