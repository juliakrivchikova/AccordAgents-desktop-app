import type { RemoteMirrorSyncRunner } from "../remoteMirrorSync";
import type { MachineBundleUpload, MachineInstallerOptions, MachineSshExec } from "./types";

/** What the installer is given by the app. */
export interface MachineInstallerDependencies {
  readonly options: MachineInstallerOptions;
  readonly sshExec: MachineSshExec;
  readonly uploadBundle: MachineBundleUpload;
  readonly mirrorSync: RemoteMirrorSyncRunner;
  readonly now: () => Date;
}
