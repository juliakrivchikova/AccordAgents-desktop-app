import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, shellQuotePosix } from "./cloudRunWorkers";
import { CommandError, runCommand } from "./command";
import type { RemoteRunWorkerTarget } from "./remoteRuns";

export const REMOTE_MIRROR_DIRNAME = "mirrors";
export const REMOTE_MIRROR_SYNC_TIMEOUT_MS = 15 * 60_000;
export const REMOTE_MIRROR_FINGERPRINT_VERSION = "mirror-sync-v2";
// Default heavy/build/dependency directories excluded from the mirror. They are
// regenerated on the worker (node_modules via install, build outputs via build),
// platform-specific, or huge (Electron's packaged out/ can be ~500MB) — shipping
// them dominates sync time for no benefit. rsync --delete does not remove
// excluded paths, so a worker-side node_modules survives future up-syncs. The
// fingerprint uses this SAME set, so "unchanged" reflects exactly what is copied.
// (Change detection is git-free — a plain working-dir copy; a future settings UI
// will let users add/remove entries and preview what gets copied.)
export const DEFAULT_MIRROR_EXCLUDES = [
  "node_modules", ".DS_Store", "out", "dist", "build",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".gradle",
  "target", ".venv", "venv", "__pycache__", ".pytest_cache",
  ".mypy_cache", "coverage", ".cache"
];
const UP_SYNC_EXCLUDES = DEFAULT_MIRROR_EXCLUDES;
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
  onProgress?: (progress: RemoteMirrorSyncProgress) => void | Promise<void>;
}

export interface RemoteMirrorSyncRunner {
  syncUp(request: RemoteMirrorSyncRequest): Promise<void>;
  syncDown(request: RemoteMirrorSyncRequest): Promise<void>;
}

export interface RemoteMirrorSyncProgress {
  percent: number;
}

export interface LocalMirrorFingerprint {
  version: typeof REMOTE_MIRROR_FINGERPRINT_VERSION;
  digest: string;
  fileCount: number;
  totalBytes: number;
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

export async function computeLocalMirrorFingerprint(
  localPath: string,
  options: { signal?: AbortSignal } = {}
): Promise<LocalMirrorFingerprint> {
  const localDir = assertLocalDir(localPath);
  const hash = createHash("sha256");
  const stats = { fileCount: 0, totalBytes: 0 };

  hash.update(`${REMOTE_MIRROR_FINGERPRINT_VERSION}\0`);
  await hashMirrorTree(localDir, "", hash, stats, options.signal);

  return {
    version: REMOTE_MIRROR_FINGERPRINT_VERSION,
    digest: hash.digest("hex"),
    fileCount: stats.fileCount,
    totalBytes: stats.totalBytes
  };
}

export const defaultRemoteMirrorSync: RemoteMirrorSyncRunner = {
  async syncUp(request: RemoteMirrorSyncRequest): Promise<void> {
    const localDir = assertLocalDir(request.localPath);
    const target = buildCloudRunSshTarget(request.worker);
    const sshArgs = cloudRunSshOptionArgs(request.worker);
    const progressArgs = await rsyncProgressArgs();
    const pendingProgress: Promise<unknown>[] = [];
    let progressBuffer = "";
    let lastPercent = -1;
    const emitProgress = (chunk: string): void => {
      if (!request.onProgress) {
        return;
      }
      progressBuffer = `${progressBuffer}${chunk}`.slice(-4096);
      const percent = parseLastRsyncProgressPercent(progressBuffer);
      if (percent === undefined || percent === lastPercent) {
        return;
      }
      lastPercent = percent;
      const progress = request.onProgress({ percent });
      if (progress) {
        pendingProgress.push(Promise.resolve(progress).catch(() => undefined));
      }
    };
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
        ...progressArgs,
        ...UP_SYNC_EXCLUDES.map((entry) => `--exclude=${entry}`),
        "-e",
        rsyncRshCommand(sshArgs),
        `${localDir}/`,
        `${target}:${escapeRemoteRsyncPath(request.remotePath)}/`
      ], {
        timeoutMs: request.timeoutMs ?? REMOTE_MIRROR_SYNC_TIMEOUT_MS,
        signal: request.signal,
        onStdout: emitProgress,
        onStderr: emitProgress
      });
      await Promise.allSettled(pendingProgress);
    } catch (error) {
      await Promise.allSettled(pendingProgress);
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

// Git-free change detection: a plain walk of the working dir hashing each
// entry's relative path + size + mtime + mode (no file-content reads, no git).
// This is the same quick-check signal rsync uses to decide what to transfer, so
// an unchanged tree yields a stable digest (=> skip) and any edit changes it
// (=> resync). rsync still catches the rare same-size+same-mtime edit on the
// next real sync. Unreadable/vanished entries are skipped rather than aborting
// the whole fingerprint (which would silently fall back to a full sync forever,
// e.g. on a packaged out/app.asar).
async function hashMirrorTree(
  root: string,
  relativeDir: string,
  hash: ReturnType<typeof createHash>,
  totals: { fileCount: number; totalBytes: number },
  signal: AbortSignal | undefined
): Promise<void> {
  throwIfAborted(signal);
  const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    throwIfAborted(signal);
    if (UP_SYNC_EXCLUDES.includes(entry.name)) {
      continue;
    }
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (relativePath === ".git/index") {
      // Churns on routine git commands (git status, etc.) without meaning a
      // real content change; skip so it does not force needless resyncs.
      continue;
    }
    const absolutePath = path.join(root, relativePath);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(absolutePath);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      hash.update(`dir\0${relativePath}\0`);
      await hashMirrorTree(root, relativePath, hash, totals, signal);
      continue;
    }
    totals.fileCount += 1;
    totals.totalBytes += stats.size;
    if (stats.isSymbolicLink()) {
      let target = "";
      try {
        target = await fs.promises.readlink(absolutePath);
      } catch {
        target = "";
      }
      hash.update(`symlink\0${relativePath}\0${target}\0`);
      continue;
    }
    hash.update(`file\0${relativePath}\0${stats.size}\0${Math.trunc(stats.mtimeMs)}\0${stats.mode & 0o7777}\0`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Mirror fingerprinting was cancelled.");
  }
}

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

async function rsyncProgressArgs(): Promise<string[]> {
  try {
    const result = await runCommand("rsync", ["--version"], {
      timeoutMs: 5000
    });
    return rsyncSupportsInfoProgress2(result.stdout) ? ["--info=progress2"] : ["--progress"];
  } catch {
    return ["--progress"];
  }
}

function rsyncSupportsInfoProgress2(versionOutput: string): boolean {
  const match = versionOutput.match(/version\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 1);
}

function parseLastRsyncProgressPercent(buffer: string): number | undefined {
  const matches = [...buffer.matchAll(/(?:^|[\r\n])\s*[\d,.]+\s+(\d{1,3})%/g)];
  const match = matches.at(-1);
  if (!match) {
    return undefined;
  }
  const percent = Number(match[1]);
  if (!Number.isFinite(percent)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.floor(percent)));
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
