/**
 * Installs, upgrades and supervises the headless machine runtime on a Linux
 * computer, and bootstraps a project mirror there once.
 *
 * This is the only place in the app that opens an SSH connection to a machine
 * for setup, and it is setup only: Rule 1 of the signed cutover accord keeps
 * every message, turn, approval and Stop on the relay. Nothing here is reached
 * from a chat turn; `scripts/machine-install-transport-guard.test.mjs` fails
 * the build if a messaging module ever imports it.
 *
 * The order of an upgrade is deliberate:
 *   stage the new release → drain and PROVE the old runtime and its provider
 *   processes are gone → flip → start → wait for the machine to connect →
 *   roll back if it does not.
 * Staging first keeps the machine down for seconds rather than minutes;
 * proving the drain before the flip is what stops two runtimes from owning one
 * participant session. A drain that cannot be proven refuses the upgrade
 * instead of forcing it, because the alternative is a duplicate executor.
 */

import { compareVersions } from "../../shared/machineInstall";
import type {
  MachineInstallRecord, MachineInstallRequest, MachineInstallResult, MachineInstallSnapshot, MachineMirrorBootstrapRequest,
  MachineMirrorBootstrapResult, MachineMirrorInspection, MachineRuntimePayloadInfo, MachineSshTarget, MachineUpgradeRequest
} from "../../shared/machineInstall";
import type { MachineInstallLayout, ParsedMachineProbe } from "./machineInstallScripts";
import { defaultRemoteMirrorSync } from "./remoteMirrorSync";
import { defaultBundleUpload, defaultMachineSshExec } from "./machineInstaller/sshTransport";
import type { MachineInstallerOptions } from "./machineInstaller/types";
import { createMachineInstallerModules, type MachineInstallerModules } from "./machineInstaller/modules";

export type { MachineSshExecRequest, MachineSshExec, MachineBundleUpload, MachineInstallStore, MachineDoctor, MachineRuntimePayloadLocation, MachineBundle, MachineInstallerOptions } from "./machineInstaller/types";
export { machinePowerNeedsDelivery, releaseName, versionFence } from "./machineInstaller/installChecks";
export { type MachineBundleSource, type ReadMachineBundleOptions, readMachineBundle } from "./machineInstaller/machineBundle";
export { redactKeyLikeText, MACHINE_DISK_FULL_MESSAGE } from "./machineInstaller/failureText";
export { compareVersions };

/** Installs the machine runtime. The work is done by the parts in ./machineInstaller. */
export class MachineInstallerService {
  private readonly modules: MachineInstallerModules;

  constructor(options: MachineInstallerOptions) {
    this.modules = createMachineInstallerModules({
      options,
      sshExec: options.sshExec ?? defaultMachineSshExec,
      uploadBundle: options.uploadBundle ?? defaultBundleUpload,
      mirrorSync: options.mirrorSync ?? defaultRemoteMirrorSync,
      now: options.now ?? (() => new Date())
    });
  }

  /** An install interrupted by the desktop closing left the machine in a known
   *  state (staged, drained, or started) but nobody watching it. The record is
   *  marked so the UI offers a retry instead of showing a step that will never
   *  finish, and `interrupted` so the automatic update or the program's
   *  recovery finishes it. Nothing is resumed from where it stopped: the next
   *  setup re-proves a half-finished drain instead of assuming it. */
  recoverInterruptedOperation(): Promise<void> {
    return this.modules.installs.recoverInterruptedOperation();
  }

  /** What this desktop would install, or why it cannot. Reading it costs one
   *  pass over the payload (~30 ms for 6 MB) and touches no machine. */
  readPayload(): MachineRuntimePayloadInfo {
    return this.modules.runtimePayload.readPayload();
  }

  probe(target: MachineSshTarget, layout?: Partial<MachineInstallLayout>): Promise<ParsedMachineProbe> {
    return this.modules.machineProbe.probe(target, layout);
  }

  ensureEnvironmentOwner(record: Pick<MachineInstallRecord, "machineId" | "target" | "installRoot">, readOnly = false, signal?: AbortSignal): Promise<void> {
    return this.modules.environmentOwner.ensureEnvironmentOwner(record, readOnly, signal);
  }

  /** Settings Start/Check/Set up also use this desktop's native profile.
   * A failed first probe may have persisted only a tilde path and the intent
   * to isolate; resolve that intent instead of falling back to the SSH home. */
  providerEnvironment(target: MachineSshTarget, defaultInstallRoot: string, readOnly = false): Promise<{ workerRoot: string; profileHome?: string }> {
    return this.modules.environmentOwner.providerEnvironment(target, defaultInstallRoot, readOnly);
  }

  install(request: MachineInstallRequest, onProgress?: (snapshot: MachineInstallSnapshot) => void): Promise<MachineInstallResult> {
    return this.modules.installs.install(request, onProgress);
  }

  upgrade(request: MachineUpgradeRequest, onProgress?: (snapshot: MachineInstallSnapshot) => void): Promise<MachineInstallResult> {
    return this.modules.installs.upgrade(request, onProgress);
  }

  /** A setup or update running on any machine right now. The desktop must
   *  not restart for an update while one is: the SSH session would die
   *  mid-drain and leave the machine without a runtime. */
  hasActiveOperations(): boolean {
    return this.modules.installs.hasActiveOperations();
  }

  /** The setup or update running on this machine, to wait for rather than
   *  collide with. */
  activeOperation(machineId: string): Promise<MachineInstallResult> | undefined {
    return this.modules.installs.activeOperation(machineId);
  }

  // ---- project mirror -----------------------------------------------------

  /** Reads the mirror without changing it. */
  inspectProjectMirror(machineId: string, localPath: string, signal?: AbortSignal): Promise<MachineMirrorInspection> {
    return this.modules.projectMirrors.inspectProjectMirror(machineId, localPath, signal);
  }

  /**
   * Puts a project on the machine once. After that the mirror is the machine's
   * own working copy: the participant pulls, commits and opens pull requests
   * from it, exactly as `docs/cloud-runs-workspace-parity.md` requires.
   *
   * An existing mirror is never replaced — not a clean one, and certainly not a
   * dirty one. There is no automatic resync and no write-back to this desktop.
   */
  bootstrapProjectMirror(request: MachineMirrorBootstrapRequest, signal?: AbortSignal, progress?: (message: string) => void): Promise<MachineMirrorBootstrapResult> {
    return this.modules.projectMirrors.bootstrapProjectMirror(request, signal, progress);
  }
}
