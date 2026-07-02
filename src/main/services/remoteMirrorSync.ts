import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, shellQuotePosix } from "./cloudRunWorkers";
import { runCommand } from "./command";
import type { RemoteRunWorkerTarget } from "./remoteRuns";

export const REMOTE_MIRROR_DIRNAME = "mirrors";
export const REMOTE_MIRROR_SYNC_TIMEOUT_MS = 15 * 60_000;
// node_modules is excluded both ways: local installs are platform-specific and
// useless on the Linux worker, and a worker-side npm install must never land back
// in the local project. rsync --delete does not remove excluded paths, so a
// worker-side node_modules survives future up-syncs.
const UP_SYNC_EXCLUDES = ["node_modules", ".DS_Store"];
// Mirror sync is ONE-WAY (local → worker). syncDown exists only for the
// explicit user-initiated "pull changes" action; it is never run
// automatically. .git is synced UP (the agent needs history and commits from
// the mirror) but never DOWN: the box's git state lives on the box and on the
// remote (PRs); pulling it back could clobber concurrent local git activity.
const DOWN_SYNC_EXCLUDES = [".git", "node_modules", ".DS_Store"];

export interface RemoteMirrorSyncRequest {
  worker: RemoteRunWorkerTarget;
  localPath: string;
  remotePath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RemoteMirrorSyncRunner {
  syncUp(request: RemoteMirrorSyncRequest): Promise<void>;
  syncDown(request: RemoteMirrorSyncRequest): Promise<void>;
}

export function remoteMirrorSlug(localPath: string): string {
  const resolved = path.resolve(localPath);
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "project";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 10);
  return `${base}-${hash}`;
}

export function remoteMirrorPath(resolvedWorkerRoot: string, localPath: string): string {
  const root = resolvedWorkerRoot.replace(/\/+$/g, "");
  return `${root}/${REMOTE_MIRROR_DIRNAME}/${remoteMirrorSlug(localPath)}`;
}

export function localProjectHasGitDir(localPath: string): boolean {
  try {
    return fs.existsSync(path.join(path.resolve(localPath), ".git"));
  } catch {
    return false;
  }
}

export const defaultRemoteMirrorSync: RemoteMirrorSyncRunner = {
  async syncUp(request: RemoteMirrorSyncRequest): Promise<void> {
    const localDir = assertLocalDir(request.localPath);
    const target = buildCloudRunSshTarget(request.worker);
    const sshArgs = cloudRunSshOptionArgs(request.worker);
    await runCommand("ssh", [
      ...sshArgs,
      target,
      `umask 077; mkdir -p ${shellQuotePosix(request.remotePath)}`
    ], {
      timeoutMs: 30_000,
      signal: request.signal
    });
    await runCommand("rsync", [
      "-az",
      "--delete",
      ...UP_SYNC_EXCLUDES.map((entry) => `--exclude=${entry}`),
      "-e",
      rsyncRshCommand(sshArgs),
      `${localDir}/`,
      `${target}:${escapeRemoteRsyncPath(request.remotePath)}/`
    ], {
      timeoutMs: request.timeoutMs ?? REMOTE_MIRROR_SYNC_TIMEOUT_MS,
      signal: request.signal
    });
  },

  async syncDown(request: RemoteMirrorSyncRequest): Promise<void> {
    const localDir = assertLocalDir(request.localPath);
    const target = buildCloudRunSshTarget(request.worker);
    const sshArgs = cloudRunSshOptionArgs(request.worker);
    await runCommand("rsync", [
      "-az",
      ...DOWN_SYNC_EXCLUDES.map((entry) => `--exclude=${entry}`),
      "-e",
      rsyncRshCommand(sshArgs),
      `${target}:${escapeRemoteRsyncPath(request.remotePath)}/`,
      `${localDir}/`
    ], {
      timeoutMs: request.timeoutMs ?? REMOTE_MIRROR_SYNC_TIMEOUT_MS,
      signal: request.signal
    });
  }
};

function assertLocalDir(localPath: string): string {
  const resolved = path.resolve(localPath);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`Local project directory does not exist: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Local project path is not a directory: ${resolved}`);
  }
  return resolved.replace(/\/+$/g, "") || resolved;
}

// rsync tokenizes the -e value with shell-like quoting; single-quote any token
// that is not plainly safe (identity files with spaces, etc.).
function rsyncRshCommand(sshArgs: string[]): string {
  return ["ssh", ...sshArgs]
    .map((part) => (/^[A-Za-z0-9._/=@:-]+$/.test(part) ? part : shellQuotePosix(part)))
    .join(" ");
}

// The remote side of an rsync path is word-split by the remote shell.
function escapeRemoteRsyncPath(remotePath: string): string {
  return remotePath.replace(/([ \t'"\\])/g, "\\$1");
}
