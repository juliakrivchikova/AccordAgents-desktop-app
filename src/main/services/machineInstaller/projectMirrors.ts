import { randomUUID } from "node:crypto";
import type { MachineMirrorBootstrapRequest, MachineMirrorBootstrapResult, MachineMirrorInspection } from "../../../shared/machineInstall";
import { shellQuotePosix } from "../cloudRunWorkers";
import { machineMirrorProbeScript, machinePublishMirrorScript, parseMachineMirrorProbe } from "../machineInstallScripts";
import { remoteMirrorPath } from "../remoteMirrorSync";
import { PROBE_TIMEOUT_MS, SHORT_TIMEOUT_MS } from "./constants";
import { maintenanceFor } from "./installChecks";
import type { MachineInstallerModules } from "./modules";
import type { MachineInstallerDependencies } from "./dependencies";

/** The one-time copy of a project to a machine. */
export class ProjectMirrors {
  constructor(
    private readonly installer: Pick<MachineInstallerModules, "environmentOwner" | "installRecords">,
    private readonly deps: Pick<MachineInstallerDependencies, "mirrorSync" | "sshExec">
  ) {}

  // ---- project mirror -----------------------------------------------------

  /** Reads the mirror without changing it. */
  async inspectProjectMirror(machineId: string, localPath: string, signal?: AbortSignal): Promise<MachineMirrorInspection> {
    signal?.throwIfAborted();
    const record = await this.installer.installRecords.requireRecord(machineId);
    const repoPath = remoteMirrorPath(`${record.installRoot}/workspace`, localPath);
    const stdout = await this.deps.sshExec({
      target: record.target,
      script: machineMirrorProbeScript(repoPath),
      timeoutMs: PROBE_TIMEOUT_MS,
      signal
    });
    return parseMachineMirrorProbe(stdout);
  }

  /**
   * Puts a project on the machine once. After that the mirror is the machine's
   * own working copy: the participant pulls, commits and opens pull requests
   * from it, exactly as `docs/cloud-runs-workspace-parity.md` requires.
   *
   * An existing mirror is never replaced — not a clean one, and certainly not a
   * dirty one. There is no automatic resync and no write-back to this desktop.
   */
  async bootstrapProjectMirror(request: MachineMirrorBootstrapRequest, signal?: AbortSignal, progress?: (message: string) => void): Promise<MachineMirrorBootstrapResult> {
    signal?.throwIfAborted();
    const record = await this.installer.installRecords.requireRecord(request.machineId);
    progress?.("Checking the cloud copy of your project…");
    await this.installer.environmentOwner.ensureEnvironmentOwner(record, false, signal);
    const inspection = await this.inspectProjectMirror(request.machineId, request.localPath, signal);
    signal?.throwIfAborted();
    if (inspection.state === "dirty") {
      return {
        inspection,
        action: "refused",
        message: `The machine's copy of this project has ${inspection.dirtyPaths.length} uncommitted change${inspection.dirtyPaths.length === 1 ? "" : "s"}. It was left untouched; commit or push them on the machine first.`
      };
    }
    if (inspection.state === "clean" || inspection.state === "directory") {
      return {
        inspection,
        action: "reused",
        message: inspection.worktrees.length
          ? `The machine already has this project (${inspection.worktrees.length} worktree${inspection.worktrees.length === 1 ? "" : "s"} beside it). Nothing was copied.`
          : "The machine already has this project. Nothing was copied."
      };
    }
    if (inspection.state === "unknown") {
      return {
        inspection,
        action: "refused",
        message: "The machine's copy of this project could not be read; it was left untouched."
      };
    }
    const repoPath = remoteMirrorPath(`${record.installRoot}/workspace`, request.localPath);
    const stagedPath = `${repoPath}.bootstrap-${randomUUID()}`;
    const maintenance = maintenanceFor(record);
    try {
      progress?.("Copying your project to the cloud for the first time…");
      await this.deps.mirrorSync.syncUp({
        worker: { ...record.target, host: record.target.host },
        localPath: request.localPath,
        remotePath: stagedPath,
        maintenance,
        signal,
        onProgress: ({ percent }) => {
          if (!signal?.aborted) progress?.(`Copying your project to the cloud · ${percent}%`);
        }
      });
      signal?.throwIfAborted();
      progress?.("Finishing the cloud project setup…");
      await this.deps.sshExec({ target: record.target, script: machinePublishMirrorScript(stagedPath, repoPath),
        timeoutMs: SHORT_TIMEOUT_MS, maintenance, signal });
    } finally {
      // This random staging directory belongs only to this copy. A failed
      // transfer/restart must not expose a half-copied project as runnable.
      // The project's folder goes too when a first copy left nothing in it.
      await this.deps.sshExec({ target: record.target, script: `rm -rf -- ${shellQuotePosix(stagedPath)}; rmdir -- ${shellQuotePosix(repoPath.replace(/\/repo$/, ""))} 2>/dev/null || true`,
        timeoutMs: SHORT_TIMEOUT_MS, maintenance }).catch(() => undefined);
    }
    return {
      inspection: await this.inspectProjectMirror(request.machineId, request.localPath, signal),
      action: "created",
      message: "The project was copied to the machine. From now on it is the machine's own working copy; it will not be overwritten by another copy."
    };
  }
}
