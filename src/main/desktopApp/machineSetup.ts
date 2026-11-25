import { CloudRunPreparationService } from "../services/cloudRunPreparation";
import { app } from "electron";
import { machineSigningKey } from "../../shared/machineLink";
import { MachineInstallerService } from "../services/machineInstaller";
import { MachinePowerHandoffService } from "../services/machinePowerHandoff";
import { isMachineAutoUpgradeOperation, isMachineRecoveryOperation } from "../../shared/machineInstall";
import { SET_UP_SERVER_FOR_MACHINES, createMachine, machineRuntimePayload, requireMachineLink } from "./machines";
import { sendToMainWindow } from "./windowState";
import type { DesktopApp } from "./desktopApp";

export function createMachineSetup(desktopApp: DesktopApp): void {
  desktopApp.machineInstallerService = new MachineInstallerService({
    store: desktopApp.settingsService,
    doctor: desktopApp.cloudRunDoctorService,
    getEnrollmentJson: (machineId) => requireMachineLink(desktopApp).enrollmentJson(machineId),
    restoreEnrollment: (machineId, requested, installed, installedMachineId) => requireMachineLink(desktopApp).restoreEnrollment(machineId, requested, installed, installedMachineId),
    waitForConnected: (machineId, timeoutMs, expectAppVersion) =>
      requireMachineLink(desktopApp).waitForConnected(machineId, timeoutMs, expectAppVersion),
    payload: machineRuntimePayload,
    machineName: async (machineId) => (await desktopApp.settingsService.listMachines()).find((machine) => machine.id === machineId)?.name,
    prepareProfile: desktopApp.prepareMachineProfile,
    // The runtime it installs says its key: the User's server admits it from
    // then on (the roster names it), before it first connects.
    adoptIdentity: (machineId, identity) => requireMachineLink(desktopApp).adoptMachineIdentity(machineId, identity),
    identityKnown: async (machineId) => {
      const machine = (await desktopApp.settingsService.listMachines()).find((item) => item.id === machineId);
      return Boolean(machine?.deviceId && machineSigningKey(machine));
    },
    // Minutes pass between the preflight and the drain; a member may have
    // started on the machine meanwhile. Asked afresh, and a stale answer is not
    // taken as idle.
    // Only for the automatic update: the button is the recovery path and must
    // still be able to replace a runtime that no longer answers.
    beforeDrain: async (record, operationId, purpose) => {
      // Set up again because the machine said its program was not running: if
      // it came back meanwhile, it may be running turns again.
      if (isMachineRecoveryOperation(operationId)) {
        return desktopApp.machineLinkService?.isMachineConnected(record.machineId)
          ? "The machine's program came back while it was being set up again, so it was not stopped."
          : undefined;
      }
      // The Update button may replace a runtime that does not answer; a healthy
      // one is never stopped mid-turn only to hand it a stop key.
      if (!isMachineAutoUpgradeOperation(operationId) && purpose !== "key") return undefined;
      const activity = await desktopApp.machineLinkService?.machineActivity(record.machineId);
      if (!activity?.connected) return "The machine is not connected right now, so its runtime was not stopped.";
      if (!activity.fresh) return "The machine did not say what it is doing in time, so its runtime was not stopped.";
      if (activity.activeRunIds.length > 0) {
        return "A member started work on the machine while the update was being staged, so its runtime was not stopped.";
      }
      return undefined;
    },
    // A machine on this app's AWS instance gets the stop key the setup command
    // minted, so it stops the instance itself after three idle hours.
    machinePower: (machineId) => desktopApp.cloudRunAwsService.machinePowerFor(machineId),
    logger: (event, payload) => {
      void desktopApp.debugLogService.write(event, payload);
    }
  });

  desktopApp.cloudRunPreparation = new CloudRunPreparationService({
    onProgress: snapshot => sendToMainWindow(desktopApp, "machines:cloud-run-progress", snapshot),
    configuredInstanceId: async () => (await desktopApp.settingsService.getPublicSettings()).cloudRuns.awsHandle?.instanceId,
    appVersion: app.getVersion(),
    environmentId: async () => (await desktopApp.deviceIdentityService.getOrCreateDeviceIdentity()).originId,
    aws: desktopApp.cloudRunAwsService,
    listMachines: () => desktopApp.settingsService.listMachines(),
    listInstalls: () => desktopApp.settingsService.listMachineInstalls(),
    createMachine: async (name, instanceId) => (await createMachine(desktopApp, { name }, instanceId)).machine,
    requireServer: async () => {
      if (!await desktopApp.settingsService.getHubConfig()) throw new Error(SET_UP_SERVER_FOR_MACHINES);
    },
    install: (request, progress) => desktopApp.machineInstallerService.install(request, progress),
    awaitActiveInstall: async (machineId) => { await desktopApp.machineInstallerService.activeOperation(machineId)?.catch(() => undefined); },
    isConnected: (machineId) => Boolean(desktopApp.machineLinkService?.isMachineConnected(machineId)),
    waitForConnected: async (machineId, timeoutMs) => Boolean(await desktopApp.machineLinkService?.waitForConnected(machineId, timeoutMs)),
    instanceRunningSince: () => desktopApp.cloudRunAwsService.instanceRunningSince(),
    bootstrapProject: (machineId, localPath, signal, progress) => desktopApp.machineInstallerService.bootstrapProjectMirror({ machineId, localPath }, signal, progress),
    saveInstall: (record) => desktopApp.settingsService.saveMachineInstall(record),
    prepareMachine: async (worker, record) => {
      if (!worker.host) throw new Error("AWS did not return an address for this instance.");
      const current = { ...record, target: { ...worker, host: worker.host } };
      await desktopApp.machineInstallerService.ensureEnvironmentOwner(current);
      await desktopApp.prepareMachineProfile(current);
    },
    prepareProvider: async (worker, provider, record, progress) => {
      if (!worker.host) throw new Error("AWS did not return an address for this instance.");
      const scopedWorker = { ...worker, workerRoot: record.installRoot };
      const options = { requiredProviderKind: provider, profileHome: record.profileHome, maintenance: {
        runtimePath: `${record.installRoot}/current/accordagents-machine.cjs`,
        userDataDir: record.userDataDir,
        capabilityPath: `${record.installRoot}/current/maintenance-v1`
      } };
      progress({ message: "Checking the provider on your cloud machine…" });
      let report = await desktopApp.cloudRunDoctorService.diagnose(scopedWorker, options);
      if (!report.ok) report = await desktopApp.cloudRunDoctorService.setup(scopedWorker, progress, options);
      if (!report.ok) throw new Error(report.message);
    }
  });

  void desktopApp.machineInstallerService.recoverInterruptedOperation();

  // Phones paired through the shared relay were handed the key that starts the
  // AWS machine. Nothing hands it out any more (a phone talks only to the
  // User's server); the records say who kept a copy, and a removed machine
  // settles them.
  desktopApp.machinePowerHandoffService = new MachinePowerHandoffService({
    getDeviceStartKey: async () => (await desktopApp.cloudRunAwsService.deviceWakePower())?.config,
    listMachinePowerHandoffs: () => desktopApp.settingsService.listMachinePowerHandoffs(),
    saveMachinePowerHandoffs: (records) => desktopApp.settingsService.saveMachinePowerHandoffs(records)
  });
}
