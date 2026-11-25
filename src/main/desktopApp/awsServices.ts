import { app } from "electron";
import { CloudRunAwsService } from "../services/cloudRunAws";
import { AwsWorkerSetupService } from "../services/awsWorkerSetup";
import { machineListResult } from "./machineRequests";
import { SET_UP_SERVER_FOR_MACHINES, removeMachine } from "./machines";
import { DESKTOP_LINK_STARTUP_GRACE_MS } from "./usageSignals";
import { sendToMainWindow } from "./windowState";
import type { DesktopApp } from "./desktopApp";

export function createAwsServices(desktopApp: DesktopApp): void {
  /** Resolves once the machine link has started, or could not start. */
  desktopApp.markMachineLinkReady = () => undefined;

  desktopApp.machineLinkReady = new Promise<void>((resolve) => { desktopApp.markMachineLinkReady = resolve; });

  desktopApp.cloudRunAwsService = new CloudRunAwsService(desktopApp.settingsService, {
    appVersion: app.getVersion(),
    // Unknown while the link is still connecting after this desktop started.
    machineConnected: (machineId) => desktopApp.machineLinkService && desktopApp.machineLinkStartedAt !== undefined
      && Date.now() - desktopApp.machineLinkStartedAt >= DESKTOP_LINK_STARTUP_GRACE_MS
      ? desktopApp.machineLinkService.isMachineConnected(machineId) : undefined,
    machineRecoveryFailure: (machineId) => desktopApp.machineRecovery?.failure(machineId),
    // The box is no longer asked over SSH whether a turn is running on it: the
    // machine on it reports its own work over the link, and an idle stop waits
    // while any of it is in flight.
    automaticStopGate: {
      authorizeAutomaticWorkerStop: async (worker) => desktopApp.machineLinkService?.hasActiveMachineWork()
        ? { allowed: false, reason: "A machine is still working." }
        : desktopApp.machineLinkService?.machineKeepsAwake(awsInstanceOfWorker(worker))
          ? { allowed: false, reason: "A machine runs switched-on scheduled tasks." }
          : { allowed: true, lease: { leaseId: "machine-idle", expiresAt: new Date(Date.now() + 30_000).toISOString() } },
      renewAutomaticWorkerStopLease: async (worker, lease) => desktopApp.machineLinkService?.hasActiveMachineWork() || desktopApp.machineLinkService?.machineKeepsAwake(awsInstanceOfWorker(worker))
        ? Promise.reject(new Error("A machine started working; the automatic stop is abandoned."))
        : { ...lease, expiresAt: new Date(Date.now() + 30_000).toISOString() },
      releaseAutomaticWorkerStopLease: async () => undefined
    },
    // An instance deleted in Settings → AWS, or one AWS terminated or no longer
    // has, takes its machines along exactly as Settings → Remove removes one.
    removeMachine: async (machineId) => { await removeMachine(desktopApp, machineId); },
    machinesReady: () => desktopApp.machineLinkReady,
    logger: (event, payload) => {
      void desktopApp.debugLogService.write(event, payload);
    }
  });

  desktopApp.awsWorkerSetupService = new AwsWorkerSetupService(desktopApp.cloudRunAwsService, desktopApp.cloudRunDoctorService, desktopApp.settingsService, {
    // This desktop's program on that instance; another desktop's does not count.
    installed: (instanceId) => desktopApp.cloudRunAwsService.programInstalledOn(instanceId),
    // The same setup choosing Cloud run does, as one step of setting AWS up.
    install: async (progress) => {
      await desktopApp.cloudRunPreparation.prepareRuntime({ progress });
      desktopApp.evaluateMachineUpdates?.();
      // Installed is installed: a list that cannot be sent now is sent later.
      void machineListResult(desktopApp).then((result) => sendToMainWindow(desktopApp, "machines:updated", result)).catch(() => undefined);
    },
    ready: async () => { if (!await desktopApp.settingsService.getHubConfig()) throw new Error(SET_UP_SERVER_FOR_MACHINES); }
  });

  void desktopApp.awsWorkerSetupService.recoverInterruptedOperation();
}

/** The AWS instance a worker target names (its host key alias carries it). */
function awsInstanceOfWorker(worker: { hostKeyAlias?: string }): string | undefined {
  const prefix = "accordagents-";
  return worker.hostKeyAlias?.startsWith(prefix) ? worker.hostKeyAlias.slice(prefix.length) : undefined;
}
