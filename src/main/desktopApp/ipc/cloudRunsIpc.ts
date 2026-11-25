import { cloudEnvironmentDirectory } from "../../services/cloudRunPreparation";
import { AwsInstanceProjectsService, AwsProjectAddCancelled } from "../../services/awsInstanceProjects";
import { newChatProjects } from "../../../shared/newChat";
import { AwsInstanceDiskService } from "../../services/awsInstanceDisk";
import { ipcMain } from "electron";
import type {
  AwsDiskChosenWork, CloudRunsSettingsUpdate, CloudRunWorkerDoctorReport, CloudRunWorkerSettings, ConnectAwsWorkerRequest,
  AwsWorkerStartRequest, AwsDiskCleanCategory, SetAwsAutoStopRequest
} from "../../../shared/types";
import { isMachineInstallTerminalPhase } from "../../../shared/machineInstall";
import { enabledCloudProviders } from "../../services/cloudRunDoctor";
import { inspectCloudMachine, machineListResult, testCloudRunWorker, withCloudRunWorker } from "../machineRequests";
import { DESKTOP_LINK_STARTUP_GRACE_MS } from "../usageSignals";
import { sendToMainWindow } from "../windowState";
import type { DesktopApp } from "../desktopApp";

export function registerCloudRunsIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("settings:save-cloud-runs", (_event, update: CloudRunsSettingsUpdate) => desktopApp.settingsService.saveCloudRunsSettings(update));

  ipcMain.handle("cloud-runs:test-worker", async (_event, request?: CloudRunWorkerSettings) => {
    try { return await withCloudRunWorker(desktopApp, request, testCloudRunWorker, "inspect"); }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle("cloud-runs:diagnose-worker", async (_event, request?: CloudRunWorkerSettings): Promise<CloudRunWorkerDoctorReport> => {
    try {
      const settings = await desktopApp.settingsService.getPublicSettings();
      const managedAws = !request && settings.cloudRuns.mode === "aws";
      // A provider the User has not signed in yet is offered, not an error:
      // only its members cannot run in the cloud until then.
      return await withCloudRunWorker(desktopApp, request, (worker) => desktopApp.cloudRunDoctorService.diagnose(worker, {
        requirePersistentStorage: managedAws,
        requiredProviderKinds: enabledCloudProviders(settings.providers),
        signIn: "optional"
      }), "inspect");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message, checks: [] };
    }
  });

  ipcMain.handle("cloud-runs:setup-worker", (_event, request?: CloudRunWorkerSettings, options?: { signIn?: "codex-cli" | "claude-code" | "none" }) =>
    desktopApp.cloudRunSetupSession.run(request, async publish => {
      const settings = await desktopApp.settingsService.getPublicSettings();
      const managedAws = !request && settings.cloudRuns.mode === "aws";
      // Sign in… on one provider signs in that one; Install or Fix signs in
      // nobody; the others stay as they are.
      const signIn = options?.signIn === "codex-cli" || options?.signIn === "claude-code" ? options.signIn : undefined;
      return withCloudRunWorker(desktopApp, request, worker => desktopApp.cloudRunDoctorService.setup(worker, publish, {
        requirePersistentStorage: managedAws,
        requiredProviderKinds: enabledCloudProviders(settings.providers),
        ...(signIn ? { signIn: "optional" as const, offerSignIn: [signIn] }
          : options?.signIn === "none" ? { signIn: "optional" as const, offerSignIn: [] } : {})
      }), "setup");
    }, progress => sendToMainWindow(desktopApp, "cloud-runs:setup-progress", progress)));

  ipcMain.handle("cloud-runs:get-setup-progress", () => desktopApp.cloudRunSetupSession.getProgress());

  ipcMain.handle("cloud-runs:submit-auth-code", (_event, request: { requestId: string; code: string }) =>
    desktopApp.cloudRunDoctorService.submitAuthCode(request?.requestId, request?.code));

  ipcMain.handle("cloud-runs:cancel-auth", (_event, requestId: string) => desktopApp.cloudRunDoctorService.cancelAuth(requestId));
  ipcMain.handle("cloud-runs:is-auth-active", (_event, requestId: string) => desktopApp.cloudRunDoctorService.isAuthActive(requestId));

  ipcMain.handle("cloud-runs:aws-bootstrap-command", (_event, region: string, recoveryOperationId?: string) =>
    desktopApp.cloudRunAwsService.bootstrapCommand(String(region ?? "").trim() || "us-east-1", recoveryOperationId));

  ipcMain.handle("cloud-runs:aws-connect", (_event, request: ConnectAwsWorkerRequest) =>
    desktopApp.cloudRunAwsService.connectWorker(request.blob, request.instanceType, request.rootVolumeSizeGb));

  ipcMain.handle("cloud-runs:aws-start", async (event, request: AwsWorkerStartRequest) => {
    const result = await desktopApp.awsWorkerSetupService.start(request, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("cloud-runs:aws-progress", progress);
    });
    // A pasted setup result may carry a new stop key for the machine.
    if (request.blob?.trim()) desktopApp.evaluateMachineUpdates?.();
    return result;
  });

  ipcMain.handle("cloud-runs:aws-status", () => desktopApp.cloudRunAwsService.status());

  ipcMain.handle("cloud-runs:aws-auto-stop", async (_event, request: SetAwsAutoStopRequest) => {
    const { keyAdded } = await desktopApp.cloudRunAwsService.setAutoStop(request);
    const enabled = request?.enabled === true;
    void desktopApp.debugLogService.write("machines.auto-stop.switched", { enabled, newKey: keyAdded });
    // The machine decides when to stop; tell a connected one now, without
    // making the switch wait behind replication. One that is offline gets the
    // switch with the settings it receives on connecting.
    // Then ask the machine to report in: its answer confirms what it has, or
    // shows in the Automatic stop row that the change did not arrive.
    void (async () => {
      await desktopApp.machineLinkService?.syncSettings();
      // A moment later, so the answer follows the settings it was sent.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const holder = await desktopApp.cloudRunAwsService.autoStopMachineRecord();
      if (holder) await desktopApp.machineLinkService?.machineActivity(holder.machineId, { fresh: true });
    })().catch((error) => {
      void desktopApp.debugLogService.write("machines.auto-stop.sync-failed", { message: error instanceof Error ? error.message : String(error) });
    });
    // A new key goes over to the machine the next time it is idle.
    if (keyAdded) desktopApp.evaluateMachineUpdates?.();
    return desktopApp.cloudRunAwsService.status();
  });

  ipcMain.handle("cloud-runs:aws-reconnect-machine", async (_event, machineId?: string) => {
    const record = typeof machineId === "string" && machineId
      ? await desktopApp.cloudRunAwsService.machineRecordOnInstance(machineId)
      : await desktopApp.cloudRunAwsService.autoStopMachineRecord();
    if (desktopApp.machineLinkStartedAt === undefined || Date.now() - desktopApp.machineLinkStartedAt < DESKTOP_LINK_STARTUP_GRACE_MS) {
      throw new Error("Still connecting to the cloud machine. Try again in a minute.");
    }
    if (record?.lastOperation && !isMachineInstallTerminalPhase(record.lastOperation.phase)) {
      throw new Error("The cloud machine is being set up right now. Try again when that finishes.");
    }
    if (record && desktopApp.machineLinkService?.isMachineConnected(record.machineId)) {
      // A connected program is never drained by this button: the key goes
      // over the way automatic updates hand it over, once the machine is idle
      // and with new turns held.
      if (record.powerRetry) await desktopApp.settingsService.saveMachineInstall({ ...record, powerRetry: undefined });
      await desktopApp.retryMachineUpdate?.(record.machineId);
      void desktopApp.debugLogService.write("machines.auto-stop.retry", { machineId: record.machineId });
    } else {
      // Not connected: set its program up again, as choosing Cloud run does.
      // What it reported last may be stale, so the machine itself is asked
      // whether agents are running before anything is stopped.
      if (record?.installRoot && (await inspectCloudMachine(desktopApp, record)).agentsRunning) {
        throw new Error("Agents are still running on the cloud machine. Try again when they finish.");
      }
      const release = record ? desktopApp.machineLinkService?.holdTurns(record.machineId, "The cloud machine's program is being set up again.") : undefined;
      try {
        await desktopApp.cloudRunPreparation.prepareRuntime({ agentsChecked: Boolean(record?.installRoot), machineId: record?.machineId });
      } finally {
        release?.();
      }
      desktopApp.evaluateMachineUpdates?.();
      void desktopApp.debugLogService.write("machines.auto-stop.reconnected", { machineId: record?.machineId ?? "" });
    }
    sendToMainWindow(desktopApp, "machines:updated", await machineListResult(desktopApp));
    return desktopApp.cloudRunAwsService.status();
  });

  const awsInstanceDisk = new AwsInstanceDiskService({
    worker: () => desktopApp.cloudRunAwsService.workerForInspection(),
    // A desktop set up before per-desktop folders keeps its recorded ones.
    program: async () => {
      const folder = cloudEnvironmentDirectory((await desktopApp.deviceIdentityService.getOrCreateDeviceIdentity()).originId);
      const recorded = await desktopApp.cloudRunAwsService.programFoldersOnInstance();
      const root = recorded?.installRoot ?? `~/${folder}`;
      const name = root.replace(/\/+$/, "").split("/").pop() ?? folder;
      return { root, data: recorded?.userDataDir ?? `~/.accordagents/${name === "accordagents-machine" ? "machine" : name}` };
    },
    log: (event, data) => { void desktopApp.debugLogService.write(event, data); },
    // A deleted project copy is copied again by the next turn in its project.
    removed: async (paths) => {
      const forgotten = await desktopApp.cloudRunPreparation.forgetRemovedCopies(paths);
      if (forgotten.length) void desktopApp.debugLogService.write("aws.disk.copies-forgotten", { machines: new Set(forgotten.map((item) => item.machineId)).size, projects: forgotten.length });
    }
  });

  ipcMain.handle("cloud-runs:aws-disk", (_event, options?: { refresh?: boolean }) => awsInstanceDisk.report(options));
  ipcMain.handle("cloud-runs:aws-disk-clean", (_event, category: AwsDiskCleanCategory) => awsInstanceDisk.clean(category));
  ipcMain.handle("cloud-runs:aws-disk-list", (_event, path?: string) => awsInstanceDisk.list(path));
  ipcMain.handle("cloud-runs:aws-disk-delete", (_event, paths: string[], options?: { withWork?: AwsDiskChosenWork }) => awsInstanceDisk.remove(paths, options?.withWork));

  const awsInstanceProjects = new AwsInstanceProjectsService({
    record: () => desktopApp.cloudRunAwsService.programRecordOnInstance(),
    listCopies: () => awsInstanceDisk.list("@mirrors"),
    knownProjects: async () => newChatProjects(await desktopApp.storageService.listConversations(), undefined).projects,
    copy: (machineId, localPath, signal, progress) => desktopApp.cloudRunPreparation.prepareProject(machineId, localPath, signal, progress, { checkCopy: true }),
    forget: async (machineId, localPaths) => {
      for (const localPath of localPaths) await desktopApp.cloudRunPreparation.forgetProject(machineId, localPath);
      void desktopApp.debugLogService.write("aws.projects.missing-forgotten", { projects: localPaths.length });
    },
    progress: (progress) => sendToMainWindow(desktopApp, "cloud-runs:aws-project-progress", progress)
  });

  ipcMain.handle("cloud-runs:aws-projects", () => awsInstanceProjects.list());

  ipcMain.handle("cloud-runs:aws-project-add", async (_event, localPath: string) => {
    try {
      await awsInstanceProjects.add(localPath);
      void desktopApp.debugLogService.write("aws.projects.add", { outcome: "added" });
    } catch (error) {
      void desktopApp.debugLogService.write("aws.projects.add", { outcome: error instanceof AwsProjectAddCancelled ? "cancelled" : "failed",
        message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  ipcMain.handle("cloud-runs:aws-project-add-cancel", (_event, localPath: string) => { awsInstanceProjects.cancel(localPath); });
  ipcMain.handle("cloud-runs:aws-stop", () => desktopApp.cloudRunAwsService.stopWorker());
  ipcMain.handle("cloud-runs:aws-delete", () => desktopApp.cloudRunAwsService.deleteWorker());
}
