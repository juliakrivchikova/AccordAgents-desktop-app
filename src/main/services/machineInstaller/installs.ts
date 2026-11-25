import { isMachineInstallTerminalPhase } from "../../../shared/machineInstall";
import { isDeepStrictEqual } from "node:util";
import type {
  MachineInstallKind, MachineInstallRequest, MachineInstallResult, MachineInstallSnapshot, MachineUpgradeRequest
} from "../../../shared/machineInstall";
import type { MachineInstallerModules } from "./modules";
import type { MachineInstallerDependencies } from "./dependencies";

/** Installs and upgrades, one at a time for each machine. */
export class Installs {
  readonly active = new Map<string, Promise<MachineInstallResult>>();
  private readonly activeRequests = new Map<string, { kind: MachineInstallKind; request: MachineUpgradeRequest }>();

  constructor(
    private readonly installer: Pick<MachineInstallerModules, "installRun">,
    private readonly deps: Pick<MachineInstallerDependencies, "now" | "options">
  ) {}

  /** An install interrupted by the desktop closing left the machine in a known
   *  state (staged, drained, or started) but nobody watching it. The record is
   *  marked so the UI offers a retry instead of showing a step that will never
   *  finish, and `interrupted` so the automatic update or the program's
   *  recovery finishes it. Nothing is resumed from where it stopped: the next
   *  setup re-proves a half-finished drain instead of assuming it. */
  async recoverInterruptedOperation(): Promise<void> {
    for (const record of await this.deps.options.store.listMachineInstalls()) {
      const operation = record.lastOperation;
      if (!operation || isMachineInstallTerminalPhase(operation.phase)) continue;
      await this.deps.options.store.saveMachineInstall({
        ...record,
        lastOperation: {
          ...operation,
          phase: "needs-attention",
          message: "The desktop closed while the machine was being set up.",
          error: "Setup was interrupted.",
          retryable: true,
          interrupted: true,
          recovery: {
            kind: operation.completed.includes("activate")
              ? "new-runtime-installed-not-started"
              : "old-runtime-still-installed",
            detail: "Nothing was left running on this desktop's side. Check the machine and retry; the setup re-checks the machine before changing anything.",
            activeVersion: record.installedVersion
          },
          updatedAt: this.deps.now().toISOString()
        }
      });
    }
  }

  install(request: MachineInstallRequest, onProgress?: (snapshot: MachineInstallSnapshot) => void): Promise<MachineInstallResult> {
    return this.enqueue("install", request, onProgress);
  }

  upgrade(request: MachineUpgradeRequest, onProgress?: (snapshot: MachineInstallSnapshot) => void): Promise<MachineInstallResult> {
    return this.enqueue("upgrade", request, onProgress);
  }

  /** A setup or update running on any machine right now. The desktop must
   *  not restart for an update while one is: the SSH session would die
   *  mid-drain and leave the machine without a runtime. */
  hasActiveOperations(): boolean {
    return this.active.size > 0;
  }

  /** The setup or update running on this machine, to wait for rather than
   *  collide with. */
  activeOperation(machineId: string): Promise<MachineInstallResult> | undefined {
    return this.active.get(machineId);
  }

  private enqueue(
    kind: MachineInstallKind,
    request: MachineUpgradeRequest,
    onProgress?: (snapshot: MachineInstallSnapshot) => void
  ): Promise<MachineInstallResult> {
    const running = this.active.get(request.machineId);
    if (running) {
      if (isDeepStrictEqual(this.activeRequests.get(request.machineId), { kind, request })) return running;
      return Promise.reject(new Error("Another setup action for this machine is still running. Wait for it to finish, then try again."));
    }
    const snapshot = structuredClone(request);
    this.activeRequests.set(request.machineId, { kind, request: snapshot });
    const started = this.installer.installRun.run(kind, snapshot, onProgress).finally(() => {
      for (const [id, task] of this.active) if (task === started) this.active.delete(id);
      this.activeRequests.delete(request.machineId);
    });
    this.active.set(request.machineId, started);
    return started;
  }
}
