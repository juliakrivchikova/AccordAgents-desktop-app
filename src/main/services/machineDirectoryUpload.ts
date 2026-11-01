import { randomUUID } from "node:crypto";
import { lstat, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { shellQuotePosix } from "./cloudRunWorkers";
import { runCommand, type CommandOptions } from "./command";
import { machineMaintenanceCommand, type MachineMaintenanceTarget } from "./machineMaintenanceCommand";
import { tarArchive, type TarEntry } from "./tarArchive";

/**
 * Windows has no rsync. A copy from there travels as one tar stream. Into an
 * empty folder it is unpacked directly, which is all rsync would do there;
 * otherwise it is unpacked into a private folder on the machine and the
 * machine's own rsync applies it with the options the copy runs with
 * everywhere else, so what is deleted and what is protected is decided by the
 * same rsync. Only the bytes on the wire differ (whole files, never deltas).
 */
export function copiesWithoutLocalRsync(): boolean {
  return process.platform === "win32";
}

export interface DirectoryUploadRequest {
  sshArgs: string[];
  target: string;
  localDir: string;
  remoteDir: string;
  /** The rsync options of the same copy elsewhere, without its transport
   *  (-e, --rsync-path) and paths. */
  rsyncOptions: string[];
  /** Entries never read or sent: exactly the ones `rsyncOptions` exclude,
   *  since an empty folder receives what is sent as it is. */
  skip?: (relativeDir: string, name: string, isDirectory: boolean) => boolean;
  /** A repository copy: the files git tracks get their line ends from git on
   *  the machine, so only other scripts are sent with LF. */
  lineEndsFromGit?: boolean;
  maintenance?: MachineMaintenanceTarget;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  /** Runs ssh with these arguments; the machine's side in tests. */
  ssh?: (args: string[], options: CommandOptions) => Promise<unknown>;
}

export async function uploadDirectoryThroughTar(request: DirectoryUploadRequest): Promise<void> {
  const index = await gitIndexModes(request.localDir, request.signal);
  const { entries, totalBytes } = await collectEntries(request.localDir, request.skip,
    request.lineEndsFromGit ? index : { ...index, tracked: new Set() }, request.signal);
  let sentBytes = 0;
  let lastPercent = -1;
  const archive = tarArchive(request.localDir, entries, (bytes) => {
    sentBytes += bytes;
    const percent = totalBytes > 0 ? Math.min(99, Math.floor((sentBytes / totalBytes) * 100)) : 0;
    if (percent !== lastPercent) {
      lastPercent = percent;
      request.onProgress?.(percent);
    }
  });
  const gzip = createGzip();
  let archiveFailure: unknown;
  const sending = pipeline(archive, gzip).catch((error: unknown) => { archiveFailure ??= error; });
  let commandFailure: unknown;
  const ssh = request.ssh ?? ((args, options) => runCommand("ssh", args, options));
  try {
    await ssh([
      ...request.sshArgs,
      request.target,
      machineMaintenanceCommand(request.maintenance, `bash -c ${shellQuotePosix(unpackScript(request.remoteDir, request.rsyncOptions, randomUUID()))}`)
    ], { inputStream: gzip, timeoutMs: request.timeoutMs, signal: request.signal });
  } catch (error) {
    commandFailure = error;
  }
  // A file that could not be read explains the failed copy; ssh's exit code does not.
  const failure = archiveFailure ?? commandFailure;
  archive.destroy();
  gzip.destroy();
  await sending;
  if (failure) throw failure;
  request.onProgress?.(100);
}

function unpackScript(remoteDir: string, rsyncOptions: string[], uploadId: string): string {
  const destination = remoteDir.replace(/\/+$/, "") || "/";
  return [
    "set -e",
    `destination=${shellQuotePosix(destination)}`,
    'if [ ! -e "$destination" ] || [ -z "$(ls -A "$destination")" ]; then',
    '  mkdir -p "$destination"',
    '  exec tar -xzpf - --no-same-owner -C "$destination"',
    "fi",
    'uploads="$HOME/.accordagents/uploads"',
    `staging="$uploads/${uploadId}"`,
    'mkdir -p "$uploads" && chmod 700 "$uploads"',
    // A copy cut off before it could clean up leaves its folder behind.
    'find "$uploads" -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null || true',
    "trap 'rm -rf \"$staging\"' EXIT",
    "trap 'exit 129' HUP INT TERM PIPE",
    'mkdir -m 700 "$staging"',
    'tar -xzpf - --no-same-owner -C "$staging"',
    // tar gave the folder the project's own, often old, time; the sweep above
    // must not take it for a folder left behind while rsync still reads it.
    'touch "$staging"',
    `rsync ${rsyncOptions.map(shellQuotePosix).join(" ")} "$staging/" "$destination/"`
  ].join("\n");
}

/** Windows keeps no POSIX modes. A file is executable when git records it so
 *  (or, elsewhere, when its own mode says so); everything else is 644/755, and
 *  the archive marks scripts by their "#!". A script git does not track goes
 *  with LF; the ones it tracks get their line ends from it on the machine.
 *  Entries deleted while the walk runs are left out, as rsync leaves them. */
async function collectEntries(
  root: string,
  skip: DirectoryUploadRequest["skip"],
  index: GitIndexModes,
  signal: AbortSignal | undefined
): Promise<{ entries: TarEntry[]; totalBytes: number }> {
  const entries: TarEntry[] = [{ path: "", kind: "directory", mode: 0o755, mtimeMs: (await stat(root)).mtimeMs }];
  let totalBytes = 0;
  const walk = async (relativeDir: string): Promise<void> => {
    signal?.throwIfAborted();
    const absoluteDir = relativeDir ? path.join(root, ...relativeDir.split("/")) : root;
    const names = (await walkStep(relativeDir, () => readdir(absoluteDir)) ?? []).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const stats = await Promise.all(names.map((name) => walkStep(`${relativeDir}/${name}`, () => lstat(path.join(absoluteDir, name)))));
    for (const [position, name] of names.entries()) {
      const entryStats = stats[position];
      if (!entryStats || skip?.(relativeDir, name, entryStats.isDirectory())) continue;
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      if (entryStats.isSymbolicLink()) {
        const linkTarget = await walkStep(relative, () => readlink(path.join(absoluteDir, name)));
        if (linkTarget === undefined) continue;
        entries.push({ path: relative, kind: "symlink", mode: 0o777, mtimeMs: entryStats.mtimeMs, linkTarget: linkTarget.replace(/\\/g, "/") });
      } else if (entryStats.isDirectory()) {
        entries.push({ path: relative, kind: "directory", mode: 0o755, mtimeMs: entryStats.mtimeMs });
        await walk(relative);
      } else if (entryStats.isFile()) {
        const executable = index.executables.has(relative) || (entryStats.mode & 0o111) !== 0;
        entries.push({
          path: relative, kind: "file", mode: executable ? 0o755 : 0o644, mtimeMs: entryStats.mtimeMs, size: entryStats.size,
          scriptToLf: !index.tracked.has(relative)
        });
        totalBytes += entryStats.size;
      }
    }
  };
  await walk("");
  return { entries, totalBytes };
}

/** One look at the disk during the walk: nothing for an entry deleted since
 *  it was listed, a plain sentence for one this computer will not show. */
async function walkStep<T>(relative: string, step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EPERM" || code === "EACCES") {
      throw new Error(`Could not copy ${relative.replace(/^\//, "") || "the project"}: this computer does not allow reading it.`, { cause: error });
    }
    throw error;
  }
}

interface GitIndexModes {
  tracked: ReadonlySet<string>;
  executables: ReadonlySet<string>;
}

/** The paths git tracks and those it records as executable ("<mode> <object>
 *  <stage>\t<path>"), relative to `localDir` (a repository or a folder in
 *  one, submodules included), read as the listing arrives. */
async function gitIndexModes(localDir: string, signal: AbortSignal | undefined): Promise<GitIndexModes> {
  const tracked = new Set<string>();
  const executables = new Set<string>();
  let partial = "";
  try {
    await runCommand("git", ["-C", localDir, "ls-files", "--recurse-submodules", "--stage", "-z"], {
      timeoutMs: 60_000,
      signal,
      maxOutputChars: 1,
      onStdout: (chunk) => {
        const records = `${partial}${chunk}`.split("\0");
        partial = records.pop() ?? "";
        for (const record of records) {
          const file = record.slice(record.indexOf("\t") + 1);
          tracked.add(file);
          if (record.startsWith("100755 ")) executables.add(file);
        }
      }
    });
  } catch {
    return { tracked: new Set(), executables: new Set() };
  }
  return { tracked, executables };
}
