import type { MachineSshTarget } from "../../../shared/machineInstall";
import {
  machineProbeScript, machineServiceLogScript, parseMachineProbe, type MachineInstallLayout, type ParsedMachineProbe
} from "../machineInstallScripts";
import { PROBE_TIMEOUT_MS, SHORT_TIMEOUT_MS } from "./constants";
import { redactKeyLikeText } from "./failureText";
import type { MachineInstallerDependencies } from "./dependencies";

/** What is on the machine now. */
export class MachineProbe {
  constructor(private readonly deps: Pick<MachineInstallerDependencies, "sshExec">) {}

  async probe(target: MachineSshTarget, layout?: Partial<MachineInstallLayout>): Promise<ParsedMachineProbe> {
    const stdout = await this.deps.sshExec({
      target,
      script: machineProbeScript({
        installRoot: layout?.installRoot,
        userDataDir: layout?.userDataDir,
        serviceName: layout?.serviceName
      }),
      timeoutMs: PROBE_TIMEOUT_MS
    });
    return parseMachineProbe(stdout);
  }

  async readServiceLog(target: MachineSshTarget, layout: MachineInstallLayout): Promise<string | undefined> {
    try {
      const output = await this.deps.sshExec({ target, script: machineServiceLogScript(layout), timeoutMs: SHORT_TIMEOUT_MS });
      // This tail is stored in settings and shown to the User. A machine's log
      // should never print a key, but it is not this service's log to trust:
      // long key-shaped runs are replaced before anything is written down.
      return redactKeyLikeText(output).trim().split("\n").slice(-60).join("\n") || undefined;
    } catch {
      return undefined;
    }
  }
}
