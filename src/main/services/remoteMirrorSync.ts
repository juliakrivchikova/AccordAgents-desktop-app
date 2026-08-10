import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, shellQuotePosix } from "./cloudRunWorkers";
import { CommandError, runCommand } from "./command";
import type { RemoteRunWorkerTarget } from "./remoteRuns";

export const REMOTE_MIRROR_DIRNAME = "mirrors";
export const REMOTE_MIRROR_SYNC_TIMEOUT_MS = 15 * 60_000;
export const REMOTE_MIRROR_FINGERPRINT_VERSION = "mirror-sync-v2";
// Default heavy/build/dependency directories excluded from the mirror. Build
// outputs are top-level only so source packages named "build" still sync;
// dependency/cache noise is excluded at any depth. The fingerprint and rsync
// use the same rules, so "unchanged" reflects exactly what is copied.
const ANY_DEPTH_MIRROR_EXCLUDES = [
  "node_modules", ".DS_Store", ".venv", "venv", "__pycache__"
] as const;
const TOP_LEVEL_MIRROR_EXCLUDES = [
  "out", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".turbo",
  ".gradle", "target", ".pytest_cache", ".mypy_cache", "coverage", ".cache"
] as const;
export const DEFAULT_MIRROR_EXCLUDES = [
  ...ANY_DEPTH_MIRROR_EXCLUDES,
  ...TOP_LEVEL_MIRROR_EXCLUDES
];
const ANY_DEPTH_MIRROR_EXCLUDE_SET = new Set<string>(ANY_DEPTH_MIRROR_EXCLUDES);
const TOP_LEVEL_MIRROR_EXCLUDE_SET = new Set<string>(TOP_LEVEL_MIRROR_EXCLUDES);
const UP_SYNC_EXCLUDE_ARGS = [
  ...ANY_DEPTH_MIRROR_EXCLUDES.map((entry) => `--exclude=${entry}`),
  ...TOP_LEVEL_MIRROR_EXCLUDES.map((entry) => `--exclude=/${entry}/***`)
];
export const REMOTE_MIRROR_UP_SYNC_PROTECT_FILTERS = [
  "--filter=P .git/worktrees/***",
  "--filter=P .git/objects/***",
  "--filter=P .git/refs/***",
  "--filter=P .git/packed-refs"
];
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
  // The repo lives under a per-project container dir (".../<slug>/repo") so the
  // container can be a writable sandbox root: a remote agent can then create
  // sibling worktrees ("git worktree add ../feature" -> ".../<slug>/feature")
  // scoped to this project, without exposing other projects' mirrors. rsync only
  // targets the /repo subdir, so worktrees outside it survive re-syncs.
  return `${root}/${REMOTE_MIRROR_DIRNAME}/${remoteMirrorSlug(localPath)}/repo`;
}

export function localProjectHasGitDir(localPath: string): boolean {
  try {
    return fs.existsSync(path.join(path.resolve(localPath), ".git"));
  } catch {
    return false;
  }
}

// One project-container directory under `${workerRoot}/mirrors/` as observed on
// the worker. `hasRepoSubdir` means the current `<slug>/repo` layout is present;
// `hasDirectGitDir` means a `.git` sits directly in the container (the
// pre-`/repo` layout, before worktrees were nested). `worktrees` are the other
// child directories: `isWorktree` marks a real linked worktree (a `.git` FILE
// pointer, not a source dir), and `registered` means the mirror repo still
// tracks it under `.git/worktrees/<name>`.
export interface WorkerMirrorContainerSnapshot {
  path: string;
  hasRepoSubdir: boolean;
  hasDirectGitDir: boolean;
  worktrees: WorkerMirrorWorktreeSnapshot[];
}

export interface WorkerMirrorWorktreeSnapshot {
  path: string;
  isWorktree: boolean;
  registered: boolean;
}

export interface WorkerMirrorReclaimPlan {
  // Absolute worker paths safe to `rm -rf`.
  reclaim: string[];
  // Absolute worker paths deliberately kept (active mirrors, live worktrees).
  preserve: string[];
}

// Decide which worker-side mirror paths are safe to reclaim. Conservative by
// construction: it only ever proposes deleting (1) a pre-`/repo` old-layout
// container (a `.git` directly in the container with no `repo/` subdir — dead
// storage no current code targets) and (2) an ORPHANED linked worktree (a real
// worktree dir the mirror repo no longer registers, which `git worktree prune`
// would drop anyway). It never touches a `repo/`, a registered worktree, a
// non-worktree sibling dir, or any container whose repo has a live run.
export function planWorkerMirrorReclaim(
  containers: readonly WorkerMirrorContainerSnapshot[],
  activeRepoPaths: ReadonlySet<string>
): WorkerMirrorReclaimPlan {
  const reclaim: string[] = [];
  const preserve: string[] = [];
  for (const container of containers) {
    const repoPath = `${container.path.replace(/\/+$/g, "")}/repo`;
    const active = activeRepoPaths.has(repoPath);
    if (container.hasRepoSubdir) {
      preserve.push(repoPath);
      for (const worktree of container.worktrees) {
        if (!active && worktree.isWorktree && !worktree.registered) {
          reclaim.push(worktree.path);
        } else {
          preserve.push(worktree.path);
        }
      }
      continue;
    }
    if (container.hasDirectGitDir && !active) {
      reclaim.push(container.path);
      continue;
    }
    // Unknown shape (no repo, no direct .git): leave it untouched.
    preserve.push(container.path);
  }
  return {
    reclaim: dedupeSorted(reclaim),
    preserve: dedupeSorted(preserve)
  };
}

function dedupeSorted(paths: string[]): string[] {
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
      await runCommand("rsync", buildMirrorUpSyncRsyncArgs({
        progressArgs,
        rshCommand: rsyncRshCommand(sshArgs),
        source: `${localDir}/`,
        destination: `${target}:${escapeRemoteRsyncPath(request.remotePath)}/`
      }), {
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
// `.git/index` is special-cased to hash stable staged entries instead of the
// index stat cache, so stage/unstage changes sync without forcing a resync after
// every `git status`. The accepted residual risk is a same-size+same-mtime edit
// when rsync is skipped; the reset/force-resync path covers that rare case.
// Unreadable/vanished entries are skipped rather than aborting the fingerprint
// (which would silently fall back to a full sync forever, e.g. on a packaged
// out/app.asar).
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
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    throwIfAborted(signal);
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (isMirrorEntryExcluded(relativeDir, entry.name)) {
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
    if (relativePath === ".git/index") {
      if (await hashGitIndexEntries(absolutePath, hash)) {
        continue;
      }
    }
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

async function hashGitIndexEntries(indexPath: string, hash: ReturnType<typeof createHash>): Promise<boolean> {
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(indexPath);
  } catch {
    return false;
  }
  if (buffer.length < 12 || buffer.subarray(0, 4).toString("ascii") !== "DIRC") {
    return false;
  }
  const version = buffer.readUInt32BE(4);
  const entryCount = buffer.readUInt32BE(8);
  if (version < 2 || version > 4) {
    return false;
  }
  let offset = 12;
  let previousPath = "";
  hash.update(`git-index\0${version}\0${entryCount}\0`);
  for (let index = 0; index < entryCount; index += 1) {
    const entryStart = offset;
    if (offset + 62 > buffer.length) {
      return false;
    }
    const mode = buffer.readUInt32BE(offset + 24);
    const oid = buffer.subarray(offset + 40, offset + 60).toString("hex");
    const flags = buffer.readUInt16BE(offset + 60);
    const stage = (flags >> 12) & 0x3;
    offset += 62;
    if ((flags & 0x4000) !== 0) {
      if (offset + 2 > buffer.length) {
        return false;
      }
      offset += 2;
    }
    let entryPath: string;
    if (version === 4) {
      const decoded = decodeIndexV4Path(buffer, offset, previousPath);
      if (!decoded) {
        return false;
      }
      entryPath = decoded.path;
      offset = decoded.nextOffset;
    } else {
      const pathEnd = buffer.indexOf(0, offset);
      if (pathEnd < 0) {
        return false;
      }
      entryPath = buffer.toString("utf8", offset, pathEnd);
      offset = pathEnd + 1;
      offset = entryStart + Math.ceil((offset - entryStart) / 8) * 8;
    }
    previousPath = entryPath;
    hash.update(`git-index-entry\0${entryPath}\0${stage}\0${mode}\0${oid}\0`);
  }
  return true;
}

function decodeIndexV4Path(
  buffer: Buffer,
  offset: number,
  previousPath: string
): { path: string; nextOffset: number } | undefined {
  const decoded = decodeIndexV4RemoveCount(buffer, offset);
  if (!decoded) {
    return undefined;
  }
  const pathEnd = buffer.indexOf(0, decoded.nextOffset);
  if (pathEnd < 0) {
    return undefined;
  }
  const suffix = buffer.toString("utf8", decoded.nextOffset, pathEnd);
  const keepBytes = Buffer.byteLength(previousPath) - decoded.removeCount;
  if (keepBytes < 0) {
    return undefined;
  }
  const prefix = Buffer.from(previousPath, "utf8").subarray(0, keepBytes).toString("utf8");
  return { path: `${prefix}${suffix}`, nextOffset: pathEnd + 1 };
}

function decodeIndexV4RemoveCount(
  buffer: Buffer,
  offset: number
): { removeCount: number; nextOffset: number } | undefined {
  if (offset >= buffer.length) {
    return undefined;
  }
  let value = buffer[offset] & 0x7f;
  let nextOffset = offset + 1;
  while ((buffer[nextOffset - 1] & 0x80) !== 0) {
    if (nextOffset >= buffer.length) {
      return undefined;
    }
    value = ((value + 1) << 7) | (buffer[nextOffset] & 0x7f);
    nextOffset += 1;
  }
  return { removeCount: value, nextOffset };
}

function isMirrorEntryExcluded(relativeDir: string, name: string): boolean {
  return ANY_DEPTH_MIRROR_EXCLUDE_SET.has(name) ||
    (!relativeDir && TOP_LEVEL_MIRROR_EXCLUDE_SET.has(name));
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
        const relativeDir = path.relative(localDir, current).split(path.sep).join("/");
        if (isMirrorEntryExcluded(relativeDir, entry.name)) {
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

// Derive an aggregate (whole-transfer) percent from rsync progress output.
// The raw per-file byte percent (`204800 100%`) resets 0->100 on every file, so
// on a multi-file repo the bar appears to loop. macOS now ships openrsync, which
// has no `--info=progress2`, so we fall back to `--progress` and instead read the
// file-count token rsync appends to each transferred line:
//   - openrsync spells it `to-check=<done>/<total>` (done counts UP)
//   - GNU rsync spells it `to-chk=<remaining>/<total>` (remaining counts DOWN,
//     including inside `--info=progress2` output)
// Both give a monotonic aggregate; the per-file byte percent is only used as a
// last resort when no count token is present.
export function parseLastRsyncProgressPercent(buffer: string): number | undefined {
  const openrsync = [...buffer.matchAll(/to-check=(\d+)\/(\d+)/g)].at(-1);
  if (openrsync) {
    return ratioPercent(Number(openrsync[1]), Number(openrsync[2]));
  }
  const gnu = [...buffer.matchAll(/to-chk=(\d+)\/(\d+)/g)].at(-1);
  if (gnu) {
    const total = Number(gnu[2]);
    return ratioPercent(total - Number(gnu[1]), total);
  }
  const perFile = [...buffer.matchAll(/(?:^|[\r\n])\s*[\d,.]+\s+(\d{1,3})%/g)].at(-1);
  return perFile ? clampPercent(Number(perFile[1])) : undefined;
}

function ratioPercent(done: number, total: number): number | undefined {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  return clampPercent((done / total) * 100);
}

function clampPercent(percent: number): number | undefined {
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

// Build the up-sync rsync argv. Extracted so the ordering guarantee can be
// tested directly: `--delete` is always paired with the `--filter=P` protect
// rules, so a changed-fingerprint resync can never delete the remote-only
// `.git` worktree/objects/refs state the worker's own worktrees and unpushed
// commits depend on (P0-2).
export function buildMirrorUpSyncRsyncArgs(params: {
  progressArgs: string[];
  rshCommand: string;
  source: string;
  destination: string;
}): string[] {
  return [
    "-az",
    "--delete",
    ...params.progressArgs,
    ...REMOTE_MIRROR_UP_SYNC_PROTECT_FILTERS,
    ...UP_SYNC_EXCLUDE_ARGS,
    "-e",
    params.rshCommand,
    params.source,
    params.destination
  ];
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
