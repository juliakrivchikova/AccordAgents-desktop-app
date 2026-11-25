import path from "node:path";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, shellQuotePosix } from "../cloudRunWorkers";
import { CommandError } from "../command";
import type { CommandResult } from "../command";
import type { RemoteRunWorkerTarget } from "../remoteWorkerTarget";
import { remoteProfileCommand } from "../remoteWorkerTarget";
import { remotePortableSetupActivationScript } from "./activationScript";
import { PORTABLE_SETUP_DIRNAME } from "./constants";
import { isRecord } from "./portableConfig";
import type { PortableAgentSetupManifest, PortableCommandRunner, PortableSetupRemoteState } from "./types";

export async function resolvePortableSetupRoot(
  worker: RemoteRunWorkerTarget,
  signal: AbortSignal | undefined,
  commandRunner: PortableCommandRunner
): Promise<string> {
  const requested = worker.workerRoot?.trim() || "~/.accordagents/remote-runs";
  const root = requested.replace(/\/+$/g, "");
  const sharedRequested = (worker.profileHome ? root : root.replace(/\/devices\/[^/]+$/, "")) || "/";
  if (sharedRequested.startsWith("/")) {
    return path.posix.join(sharedRequested, PORTABLE_SETUP_DIRNAME);
  }
  const relative = sharedRequested === "~"
    ? ""
    : sharedRequested.startsWith("~/")
      ? sharedRequested.slice(2)
      : sharedRequested;
  const command = relative
    ? `printf '%s' "$HOME"/${shellQuotePosix(relative)}`
    : `printf '%s' "$HOME"`;
  const result = await commandRunner(
    worker.sshPath?.trim() || "ssh",
    [...cloudRunSshOptionArgs(worker), buildCloudRunSshTarget(worker), remoteProfileCommand(worker.profileHome, command)],
    { timeoutMs: 30_000, signal }
  );
  const resolved = result.stdout.trim();
  if (!resolved.startsWith("/")) {
    throw new Error(`Remote worker path did not resolve to an absolute path: ${requested}`);
  }
  return path.posix.join(resolved.replace(/\/+$/g, "") || "/", PORTABLE_SETUP_DIRNAME);
}

export async function readRemoteSetupState(
  worker: RemoteRunWorkerTarget,
  setupRoot: string,
  signal: AbortSignal | undefined,
  commandRunner: PortableCommandRunner
): Promise<{ manifest?: PortableAgentSetupManifest; state?: PortableSetupRemoteState }> {
  const statePath = `${setupRoot}/state.json`;
  const script = String.raw`const fs=require("fs"),path=require("path");const root=path.resolve(process.argv[1]);const statePath=path.join(root,"state.json");let state={};try{state=JSON.parse(fs.readFileSync(statePath,"utf8"))}catch{}let manifest={};if(typeof state.fingerprint==="string"&&/^[a-f0-9]{64}$/.test(state.fingerprint)){try{manifest=JSON.parse(fs.readFileSync(path.join(root,"bundles",state.fingerprint,"manifest.json"),"utf8"))}catch{}}process.stdout.write(JSON.stringify({marker:"portable-agent-setup-probe-v1",state,manifest}));`;
  const command = `node -e ${shellQuotePosix(script)} ${shellQuotePosix(setupRoot)}`;
  const result = await commandRunner(
    worker.sshPath?.trim() || "ssh",
    [...cloudRunSshOptionArgs(worker), buildCloudRunSshTarget(worker), remoteProfileCommand(worker.profileHome, command)],
    { timeoutMs: 30_000, signal }
  );
  const probe = parseJsonRecord(result.stdout.trim());
  if (probe?.marker !== "portable-agent-setup-probe-v1") {
    return {};
  }
  return {
    manifest: isRecord(probe.manifest)
      ? probe.manifest as unknown as PortableAgentSetupManifest
      : undefined,
    state: isRecord(probe.state) ? probe.state : undefined
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function activateRemotePortableSetup(
  worker: RemoteRunWorkerTarget,
  remoteBundlePath: string,
  remoteStatePath: string,
  signal: AbortSignal | undefined,
  commandRunner: PortableCommandRunner
): Promise<void> {
  const command = [
    "umask 077; node - --",
    shellQuotePosix(remoteBundlePath),
    shellQuotePosix(remoteStatePath)
  ].join(" ");
  let result: CommandResult;
  try {
    result = await commandRunner(
      worker.sshPath?.trim() || "ssh",
      [...cloudRunSshOptionArgs(worker), buildCloudRunSshTarget(worker), remoteProfileCommand(worker.profileHome, command)],
      { input: remotePortableSetupActivationScript(), timeoutMs: 60_000, signal }
    );
  } catch (error) {
    if (error instanceof CommandError) {
      throw new Error(`Remote portable agent setup activation failed: ${portableSetupCommandErrorDetail(error)}`);
    }
    throw error;
  }
  const parsed = parseJsonRecord(result.stdout.trim());
  if (parsed?.ok !== true || parsed.fingerprint === undefined) {
    throw new Error("Remote portable agent setup activation failed.");
  }
}

function portableSetupCommandErrorDetail(error: CommandError): string {
  if (error.result.timedOut) {
    return "timed out";
  }
  const detail = error.result.stderr.trim() || error.result.stdout.trim();
  return detail ? detail.slice(0, 2000) : `exit code ${error.result.exitCode ?? "unknown"}`;
}
