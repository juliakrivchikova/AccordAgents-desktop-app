import { recoverableMachineEnrollment } from "../../../shared/machineEnrollmentRecovery";
import type { MachineInstallRecord, MachineSshTarget } from "../../../shared/machineInstall";
import { CommandError } from "../command";
import { machineClaimEnvironmentScript } from "../machineInstallScripts";
import { SHORT_TIMEOUT_MS } from "./constants";
import type { MachineInstallerModules } from "./modules";
import type { MachineInstallerDependencies } from "./dependencies";

/** Which desktop a machine's environment belongs to. */
export class EnvironmentOwner {
  constructor(
    private readonly installer: Pick<MachineInstallerModules, "installs" | "machineProbe">,
    private readonly deps: Pick<MachineInstallerDependencies, "options" | "sshExec">
  ) {}

  async ensureEnvironmentOwner(record: Pick<MachineInstallRecord, "machineId" | "target" | "installRoot">, readOnly = false, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!record.installRoot.startsWith("/")) throw new Error("Finish machine setup before using its files.");
    const { enrollment } = await this.enrollmentForEnvironment(record, readOnly, signal);
    await this.claimEnvironmentOwner(record.target, record.installRoot, enrollment, readOnly, signal);
  }

  async enrollmentForEnvironment(record: Pick<MachineInstallRecord, "machineId" | "target" | "installRoot"> & { userDataDir?: string }, readOnly = false, signal?: AbortSignal, restoreIdentity = false): Promise<{ enrollment: string; machineId: string }> {
    const requested = await this.deps.options.getEnrollmentJson(record.machineId);
    if (readOnly || !this.deps.options.restoreEnrollment) return { enrollment: requested, machineId: record.machineId };
    signal?.throwIfAborted();
    let installed: string;
    try {
      installed = await this.deps.sshExec({ target: record.target, script: machineClaimEnvironmentScript(record.installRoot, "recover", record.userDataDir),
        input: requested, timeoutMs: SHORT_TIMEOUT_MS, signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CommandError && error.result.exitCode === 1 && error.result.stderr.split(/\r?\n/).includes(
        "RuntimeError: This installation belongs to another environment; nothing was replaced.")) {
        throw new Error("This installation belongs to another environment; nothing was replaced.");
      }
      throw new Error("Could not read the saved machine connection. Check the connection and try again.");
    }
    if (!installed.trim()) return { enrollment: requested, machineId: record.machineId };
    let recovered: { enrollment: unknown; machineId?: string | null };
    // Never include this response (a relay secret) in errors or progress.
    try {
      if (Buffer.byteLength(installed) > 65_536) throw new Error();
      recovered = JSON.parse(installed);
      // One set up for the shared relay comes back in the server's form,
      // and that is what is written to the machine below.
      recovered = { ...recovered, enrollment: recoverableMachineEnrollment(JSON.parse(requested), recovered.enrollment) };
      if (recovered.machineId != null && (typeof recovered.machineId !== "string" || !recovered.machineId.trim() || recovered.machineId.length > 256)) throw new Error();
    } catch { throw new Error("The saved machine connection is invalid; nothing was replaced."); }
    if (recovered.machineId && recovered.machineId !== record.machineId && !restoreIdentity) {
      throw new Error("Finish Cloud run setup before using this machine's files.");
    }
    signal?.throwIfAborted();
    if (recovered.machineId && recovered.machineId !== record.machineId) {
      const task = this.installer.installs.active.get(record.machineId);
      if (this.installer.installs.active.has(recovered.machineId)) throw new Error("Another setup is already running for the saved machine.");
      if (task) this.installer.installs.active.set(recovered.machineId, task);
    }
    const machineId = await this.deps.options.restoreEnrollment(record.machineId, requested, JSON.stringify(recovered.enrollment), recovered.machineId ?? undefined) || record.machineId;
    return { enrollment: await this.deps.options.getEnrollmentJson(machineId), machineId };
  }

  async claimEnvironmentOwner(target: MachineSshTarget, installRoot: string, enrollmentJson: string, readOnly = false, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      await this.deps.sshExec({ target, script: machineClaimEnvironmentScript(installRoot, readOnly),
        input: enrollmentJson, timeoutMs: SHORT_TIMEOUT_MS, signal });
    } catch (error) {
      // SSH's generic exit-code message hides Python's owner refusal. Expose
      // only our fixed diagnostic, never arbitrary stderr or enrollment data.
      if (error instanceof CommandError && error.result.exitCode === 1) {
        const reasons = [
          "This installation belongs to another environment; nothing was replaced.",
          "Machine enrollment has no owner identity; nothing was replaced.",
          "Finish machine setup before checking this environment."
        ];
        const lines = error.result.stderr.split(/\r?\n/);
        const reason = reasons.find(message => lines.includes(`RuntimeError: ${message}`));
        if (reason) throw new Error(reason);
      }
      throw error;
    }
  }

  /** Settings Start/Check/Set up also use this desktop's native profile.
   * A failed first probe may have persisted only a tilde path and the intent
   * to isolate; resolve that intent instead of falling back to the SSH home. */
  async providerEnvironment(target: MachineSshTarget, defaultInstallRoot: string, readOnly = false): Promise<{ workerRoot: string; profileHome?: string }> {
    const record = (await this.deps.options.store.listMachineInstalls()).find(
      install => target.hostKeyAlias && install.target.hostKeyAlias === target.hostKeyAlias
    );
    const probe = await this.installer.machineProbe.probe(target, { installRoot: record?.installRoot || defaultInstallRoot,
      userDataDir: record?.installRoot ? record.userDataDir || undefined : undefined,
      serviceName: record?.installRoot ? record.serviceName : undefined });
    if (record) await this.ensureEnvironmentOwner({ ...record, target, installRoot: probe.installRoot }, readOnly);
    return { workerRoot: probe.installRoot,
      profileHome: record?.installRoot ? record.profileHome ?? (record.isolatedProfile ? probe.installRoot + "/home" : undefined)
        : probe.installRoot + "/home" };
  }
}
