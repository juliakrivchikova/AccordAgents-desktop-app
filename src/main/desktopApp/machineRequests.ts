import { createHash, randomUUID } from "node:crypto";
import type { CloudRunWorkerSettings } from "../../shared/types";
import type { MachineListResult, MachineTrustedDevicesResult } from "../../shared/machineLink";
import type { MachineInstallRecord, MachineSshTarget } from "../../shared/machineInstall";
import { runCommand } from "../services/command";
import {
  buildCloudRunSshTarget, cloudRunSshOptionArgs, cloudRunWorkerTargetFromSettings, normalizeCloudRunWorkerSettings,
  validateCloudRunSshWorkerFields
} from "../services/cloudRunWorkers";
import { acquireWorkerOperationLease, renewWorkerOperationLease, releaseWorkerOperationLease } from "../services/remoteWorkerLease";
import type { DesktopApp } from "./desktopApp";

// A machine enrollment is durable: it is installed once on the machine and
// revoked by removing the machine, not by a clock.
export const MACHINE_ENROLLMENT_TTL_MINUTES = 60 * 24 * 365 * 10;

export async function testCloudRunWorker(worker: CloudRunWorkerSettings): Promise<{ ok: boolean; message: string }> {
  const normalized = normalizeCloudRunWorkerSettings(worker);
  const host = normalized.host ?? "";
  if (!host) {
    return { ok: false, message: "Worker host is required." };
  }
  let target: string;
  try {
    validateCloudRunSshWorkerFields(normalized as CloudRunWorkerSettings & { host: string });
    target = buildCloudRunSshTarget(normalized as CloudRunWorkerSettings & { host: string });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const args = [
    ...cloudRunSshOptionArgs(normalized as CloudRunWorkerSettings & { host: string }),
    target,
    "command -v codex >/dev/null && printf ok"
  ];
  try {
    const result = await runCommand("ssh", args, { timeoutMs: 20_000 });
    return result.stdout.trim() === "ok"
      ? { ok: true, message: "Worker reachable; codex found." }
      : { ok: false, message: result.stdout.trim() || "Worker reachable, but codex check did not return ok." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function withCloudRunWorker<T>(desktopApp: DesktopApp, 
  request: CloudRunWorkerSettings | undefined,
  action: (worker: CloudRunWorkerSettings) => Promise<T>,
  intent: "inspect" | "setup"
): Promise<T> {
  if (request) {
    return action(request);
  }
  const settings = await desktopApp.settingsService.getPublicSettings();
  if (settings.cloudRuns.mode !== "aws") {
    return action(settings.cloudRuns.worker);
  }
  if (intent === "inspect") {
    return action(await desktopApp.cloudRunAwsService.workerForInspection());
  }
  const operationId = randomUUID();
  return desktopApp.cloudRunAwsService.withRunReference(operationId, async () => {
    const workerSettings = await desktopApp.cloudRunAwsService.ensureWorkerForRun();
    const worker = cloudRunWorkerTargetFromSettings(workerSettings);
    if (!worker) {
      throw new Error("The AWS worker did not provide a valid SSH target.");
    }
    const lease = await acquireWorkerOperationLease(worker, operationId, "settings-worker-operation");
    const renewalTimer = setInterval(() => {
      void renewWorkerOperationLease(worker, lease).then((renewed) => {
        lease.expiresAt = renewed.expiresAt;
      }).catch((error) => {
        void desktopApp.debugLogService.write("cloud-runs.operation-lease.renew-error", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, 10_000);
    renewalTimer.unref?.();
    try {
      return await action(workerSettings);
    } finally {
      clearInterval(renewalTimer);
      await releaseWorkerOperationLease(worker, lease).catch((error) => {
        void desktopApp.debugLogService.write("cloud-runs.operation-lease.release-error", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
  });
}

export function assertMachineId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) {
    throw new Error("Machine id is required.");
  }
  return id;
}

export function assertMachineSshTarget(value: unknown): MachineSshTarget {
  const target = value && typeof value === "object" ? value as Partial<MachineSshTarget> : {};
  const host = typeof target.host === "string" ? target.host.trim() : "";
  if (!host) {
    throw new Error("The machine needs an address to reach it for setup.");
  }
  return {
    host,
    user: typeof target.user === "string" && target.user.trim() ? target.user.trim() : undefined,
    port: typeof target.port === "number" && Number.isFinite(target.port) ? Math.floor(target.port) : undefined,
    identityFile: typeof target.identityFile === "string" && target.identityFile.trim() ? target.identityFile.trim() : undefined,
    hostKeyAlias: typeof target.hostKeyAlias === "string" && target.hostKeyAlias.trim() ? target.hostKeyAlias.trim() : undefined
  };
}

/** What Settings shows: this desktop's own identity, so it can be added on
 *  another device, and the devices this one already trusts. */
export async function trustedDevicesResult(desktopApp: DesktopApp): Promise<MachineTrustedDevicesResult> {
  const identity = await desktopApp.deviceIdentityService.getOrCreateDeviceIdentity();
  return {
    thisDevice: {
      deviceId: identity.originId,
      publicKeyDerBase64: identity.publicKeyDerBase64,
      role: "desktop",
      name: "This computer",
      addedAt: identity.createdAt ?? new Date().toISOString()
    },
    devices: await desktopApp.settingsService.listTrustedDevices()
  };
}

/** What the cloud machine itself says about this deployment, asked over
 *  SSH: what its program last reported may be stale. This device's SSH
 *  access is renewed first, as its address may have changed since; a stopped
 *  instance is never started for it. */
export async function inspectCloudMachine(desktopApp: DesktopApp, record: MachineInstallRecord): Promise<{ programRunning: boolean; agentsRunning: boolean }> {
  const instanceId = (await desktopApp.settingsService.getPublicSettings()).cloudRuns.awsHandle?.instanceId;
  if (!instanceId) throw new Error("No AWS instance is set up in Settings.");
  const worker = await desktopApp.cloudRunAwsService.ensureExistingWorkerForRun(instanceId, { start: false });
  if (!worker.host) throw new Error("AWS did not return an address for the instance.");
  const probe = await desktopApp.machineInstallerService.probe(
    { host: worker.host, user: worker.user, port: worker.port, identityFile: worker.identityFile, hostKeyAlias: worker.hostKeyAlias },
    { installRoot: record.installRoot, userDataDir: record.userDataDir, serviceName: record.serviceName });
  // A program its unit keeps restarting is not running: it never stays up
  // long enough to connect, and only a new setup can help it.
  const settled = (probe.serviceAgeSeconds ?? Number.POSITIVE_INFINITY) >= 60;
  return { programRunning: probe.serviceState === "active" && probe.runtimePids.length > 0 && settled, agentsRunning: probe.providerPids.length > 0 };
}

export async function machineListResult(desktopApp: DesktopApp): Promise<MachineListResult> {
  return {
    machines: await desktopApp.settingsService.listMachines(),
    status: desktopApp.machineLinkService?.status() ?? []
  };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
