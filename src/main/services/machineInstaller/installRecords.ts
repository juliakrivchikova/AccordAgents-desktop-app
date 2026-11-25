import type { MachineInstallRecord, MachineInstallRequest } from "../../../shared/machineInstall";
import { DEFAULT_MACHINE_SERVICE_NAME } from "../machineInstallScripts";
import type { MachineInstallerDependencies } from "./dependencies";

/** What this desktop keeps of a machine's program. */
export class InstallRecords {
  constructor(private readonly deps: Pick<MachineInstallerDependencies, "options">) {}

  async recordFor(request: MachineInstallRequest): Promise<MachineInstallRecord> {
    const existing = await this.deps.options.store.getMachineInstall(request.machineId);
    return {
      machineId: request.machineId,
      target: request.target,
      installRoot: request.installRoot ?? existing?.installRoot ?? "",
      userDataDir: request.userDataDir ?? (existing?.installRoot ? existing.userDataDir : undefined) ?? "",
      serviceName: request.serviceName ?? (existing?.installRoot ? existing.serviceName : undefined)
        ?? request.installRoot?.replace(/\/+$/, "").split("/").pop() ?? DEFAULT_MACHINE_SERVICE_NAME,
      serviceScope: existing?.serviceScope ?? "system",
      installedVersion: existing?.installedVersion,
      installedDigest: existing?.installedDigest,
      installedAt: existing?.installedAt,
      projects: existing?.projects,
      power: existing?.power,
      powerError: existing?.powerError,
      powerRetry: existing?.powerRetry,
      profileHome: existing?.profileHome,
      isolatedProfile: existing?.installRoot
        ? existing.isolatedProfile ?? Boolean(existing.profileHome) : request.isolatedProfile ?? false
    };
  }

  async requireRecord(machineId: string): Promise<MachineInstallRecord> {
    const record = await this.deps.options.store.getMachineInstall(machineId);
    if (!record || !record.installRoot) {
      throw new Error("This machine has not been set up from this desktop yet.");
    }
    return record;
  }
}
