import { machineMaintenanceCommand, type MachineMaintenanceTarget } from "../machineMaintenanceCommand";
import { copiesWithoutLocalRsync, uploadDirectoryThroughTar } from "../machineDirectoryUpload";
import { withMachineRsyncPath } from "../machineMaintenanceRsync";
import path from "node:path";
import type { CloudRunWorkerSettings } from "../../../shared/types";
import type { MachineSshTarget } from "../../../shared/machineInstall";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, shellQuotePosix } from "../cloudRunWorkers";
import { runCommand } from "../command";
import { escapeRemoteRsyncPath, rsyncRshCommand } from "../remoteMirrorSync";
import type { MachineSshExecRequest } from "./types";

export function workerSettingsFor(target: MachineSshTarget): CloudRunWorkerSettings {
  return {
    host: target.host,
    user: target.user,
    port: target.port,
    identityFile: target.identityFile,
    hostKeyAlias: target.hostKeyAlias
  };
}

export async function defaultMachineSshExec(request: MachineSshExecRequest): Promise<string> {
  const worker = workerSettingsFor(request.target) as CloudRunWorkerSettings & { host: string };
  // With no payload the script itself is stdin, so it never reaches `ps` on the
  // machine. With a payload the script (paths only, never a secret) goes as one
  // argument and stdin carries the payload — the enrollment's relay key.
  const remoteCommand = request.input === undefined
    ? "bash -s"
    : `bash -c ${shellQuotePosix(request.script)}`;
  const result = await runCommand("ssh", [
    ...cloudRunSshOptionArgs(worker),
    buildCloudRunSshTarget(worker),
    machineMaintenanceCommand(request.maintenance, remoteCommand)
  ], {
    input: request.input ?? request.script,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    onStdout: request.onStdout
  });
  return result.stdout;
}

const BUNDLE_RSYNC_OPTIONS = [
  "-az",
  "--delete",
  // Dependencies are installed inside the release directory on the machine;
  // deleting them on every re-upload would reinstall them for nothing.
  "--exclude=node_modules"
];

export async function defaultBundleUpload(request: {
  target: MachineSshTarget;
  localDir: string;
  remoteDir: string;
  timeoutMs: number;
  maintenance?: MachineMaintenanceTarget;
}): Promise<void> {
  const worker = workerSettingsFor(request.target) as CloudRunWorkerSettings & { host: string };
  const sshArgs = cloudRunSshOptionArgs(worker);
  const target = buildCloudRunSshTarget(worker);
  await runCommand("ssh", [...sshArgs, target, machineMaintenanceCommand(request.maintenance,
    `bash -c ${shellQuotePosix(`umask 077; mkdir -p ${shellQuotePosix(request.remoteDir)}`)}`)], {
    timeoutMs: 60_000
  });
  if (copiesWithoutLocalRsync()) {
    await uploadDirectoryThroughTar({
      sshArgs,
      target,
      localDir: path.resolve(request.localDir),
      remoteDir: request.remoteDir,
      rsyncOptions: BUNDLE_RSYNC_OPTIONS,
      skip: (_relativeDir, name) => name === "node_modules",
      maintenance: request.maintenance,
      timeoutMs: request.timeoutMs
    });
    return;
  }
  await withMachineRsyncPath(request.maintenance, (command, input) => runCommand("ssh", [
    ...sshArgs, target, command
  ], { input, timeoutMs: 60_000 }), (rsyncPath) => runCommand("rsync", [
    ...BUNDLE_RSYNC_OPTIONS,
    ...(rsyncPath ? ["--rsync-path", rsyncPath] : []),
    "-e",
    rsyncRshCommand(sshArgs),
    `${path.resolve(request.localDir)}/`,
    `${target}:${escapeRemoteRsyncPath(request.remoteDir)}/`
  ], { timeoutMs: request.timeoutMs }));
}
