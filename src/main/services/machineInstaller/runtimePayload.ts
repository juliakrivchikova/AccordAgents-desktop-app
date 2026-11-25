import type { MachineRuntimePayloadInfo } from "../../../shared/machineInstall";
import { errorMessage } from "./failureText";
import { readMachineBundle } from "./machineBundle";
import type { MachineRuntimePayloadLocation } from "./types";
import type { MachineInstallerDependencies } from "./dependencies";

/** What this desktop would install. */
export class RuntimePayload {
  constructor(private readonly deps: Pick<MachineInstallerDependencies, "options">) {}

  payloadLocation(): MachineRuntimePayloadLocation {
    return typeof this.deps.options.payload === "function" ? this.deps.options.payload() : this.deps.options.payload;
  }

  /** What this desktop would install, or why it cannot. Reading it costs one
   *  pass over the payload (~30 ms for 6 MB) and touches no machine. */
  readPayload(): MachineRuntimePayloadInfo {
    const location = this.payloadLocation();
    try {
      const bundle = readMachineBundle(location.dir, { source: location.source, expectVersion: location.expectVersion });
      return {
        ok: true,
        source: location.source,
        dir: bundle.dir,
        version: bundle.version,
        digest: bundle.digest,
        files: bundle.files,
        bytes: bundle.bytes
      };
    } catch (error) {
      return { ok: false, source: location.source, dir: location.dir, message: errorMessage(error) };
    }
  }
}
