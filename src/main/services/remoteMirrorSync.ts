import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, shellQuotePosix } from "./cloudRunWorkers";
import { CommandError, runCommand } from "./command";
import type { RemoteRunWorkerTarget } from "./remoteRuns";

export const REMOTE_MIRROR_DIRNAME = "mirrors";
export const REMOTE_MIRROR_SYNC_TIMEOUT_MS = 15 * 60_000;
// node_modules is excluded both ways: local installs are platform-specific and
// useless on the Linux worker, and a worker-side npm install must never land back
// in the local project. rsync --delete does not remove excluded paths, so a
// worker-side node_modules survives future up-syncs.
const UP_SYNC_EXCLUDES = ["node_modules", ".DS_Store"];
const MIRROR_SYNC_SPACE_BUFFER_BYTES = 512 * 1024 * 1024;
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
    try {
      await runCommand("ssh", [
        ...sshArgs,
        target,
        `umask 077; mkdir -p ${shellQuotePosix(request.remotePath)}`
      ], {
        timeoutMs: 30_000,
        signal: request.signal
      });
      await assertRemoteMirrorHasSpace(request, localDir, target, sshArgs);
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
    } catch (error) {
      throw normalizeMirrorSyncError(error, request.remotePath);
    }
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

async function assertRemoteMirrorHasSpace(
  request: RemoteMirrorSyncRequest,
  localDir: string,
  target: string,
  sshArgs: string[]
): Promise<void> {
  const localBytes = await estimateLocalMirrorPayloadBytes(localDir);
  if (localBytes === undefined) {
    return;
  }
  const remote = await queryRemoteMirrorUsage(request, target, sshArgs);
  if (!remote) {
    return;
  }
  const requiredFreeBytes = Math.max(0, localBytes - remote.usedBytes) + MIRROR_SYNC_SPACE_BUFFER_BYTES;
  if (remote.availableBytes >= requiredFreeBytes) {
    return;
  }
  throw new Error(remoteMirrorSpaceMessage({
    remotePath: request.remotePath,
    localBytes,
    availableBytes: remote.availableBytes,
    requiredFreeBytes
  }));
}

async function estimateLocalMirrorPayloadBytes(localDir: string): Promise<number | undefined> {
  let total = 0;
  const stack = [localDir];
  try {
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
        if (UP_SYNC_EXCLUDES.includes(entry.name)) {
          continue;
        }
        const fullPath = path.join(current, entry.name);
        const stats = await fs.promises.lstat(fullPath);
        if (stats.isDirectory()) {
          stack.push(fullPath);
        } else {
          total += stats.size;
        }
      }
    }
    return total;
  } catch {
    return undefined;
  }
}

async function queryRemoteMirrorUsage(
  request: RemoteMirrorSyncRequest,
  target: string,
  sshArgs: string[]
): Promise<{ availableBytes: number; usedBytes: number } | undefined> {
  const quotedPath = shellQuotePosix(request.remotePath);
  const command = [
    `df -Pk ${quotedPath} | awk 'NR==2 {print "available_kb="$4}'`,
    `du -sk ${quotedPath} 2>/dev/null | awk '{print "used_kb="$1}' || printf 'used_kb=0\\n'`
  ].join("; ");
  try {
    const result = await runCommand("ssh", [...sshArgs, target, command], {
      timeoutMs: 30_000,
      signal: request.signal
    });
    const availableKb = numberFromOutput(result.stdout, "available_kb");
    const usedKb = numberFromOutput(result.stdout, "used_kb") ?? 0;
    if (availableKb === undefined) {
      return undefined;
    }
    return {
      availableBytes: availableKb * 1024,
      usedBytes: usedKb * 1024
    };
  } catch {
    return undefined;
  }
}

function numberFromOutput(output: string, key: string): number | undefined {
  const match = output.match(new RegExp(`(?:^|\\n)${key}=(\\d+)`));
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

export function normalizeMirrorSyncError(error: unknown, remotePath: string): Error {
  if (isDiskSpaceError(error)) {
    return new Error(remoteMirrorSpaceMessage({ remotePath }));
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isDiskSpaceError(error: unknown): boolean {
  const chunks = [error instanceof Error ? error.message : String(error)];
  if (error instanceof CommandError) {
    chunks.push(error.result.stdout, error.result.stderr);
  }
  const diagnostic = chunks.join("\n");
  return /no space left on device|enospc|disk quota exceeded/i.test(diagnostic);
}

export function remoteMirrorSpaceMessage(details: {
  remotePath: string;
  localBytes?: number;
  availableBytes?: number;
  requiredFreeBytes?: number;
}): string {
  const sizeDetail = details.availableBytes !== undefined && details.requiredFreeBytes !== undefined
    ? ` needs about ${formatBytes(details.requiredFreeBytes)} free under ${details.remotePath}, but only ${formatBytes(details.availableBytes)} is available.`
    : ` ran out of disk space while syncing this project to ${details.remotePath}.`;
  const projectDetail = details.localBytes !== undefined
    ? ` Local project mirror size is about ${formatBytes(details.localBytes)}.`
    : "";
  return [
    `Remote worker disk is too small to sync this project:${sizeDetail}${projectDetail}`,
    "Free space on the worker, delete stale mirrors, or recreate the AWS worker with a larger disk in Settings > Cloud Runs."
  ].join(" ");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
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
