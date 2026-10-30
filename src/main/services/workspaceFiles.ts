import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./command";
import { isPathInside, resolveLocalFile, type LocalFileResolution } from "./repoFile";

/** How long a repository's worktree list is trusted before it is read again. */
const WORKTREE_CACHE_MS = 30_000;
/** A path that is not in a fresh list is checked against git again at most this often. */
const WORKTREE_MISS_RECHECK_MS = 5_000;

export type WorktreeLister = (repoPath: string) => Promise<string[]>;

/**
 * The roots of `git worktree list --porcelain`, as real paths. Entries git
 * marks prunable (their folder is gone, or their record is stale) are left out.
 * Empty when the folder is not a git repository.
 */
export async function listGitWorktreeRoots(repoPath: string): Promise<string[]> {
  const result = await runCommand("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    timeoutMs: 5_000,
    primeLoginShellEnv: false
  }).catch(() => undefined);
  if (!result || result.exitCode !== 0) return [];
  const roots: string[] = [];
  for (const block of result.stdout.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const head = lines.find((line) => line.startsWith("worktree "));
    if (!head || lines.some((line) => line.startsWith("prunable"))) continue;
    const root = head.slice("worktree ".length).trim();
    if (!root) continue;
    roots.push(await realpath(root).catch(() => path.resolve(root)));
  }
  return roots;
}

/**
 * Worktree roots that may widen the chat's project. Never a folder that holds
 * the chat's own folder (a chat on a subfolder of a repository, or a home
 * folder that is itself a repository, must not take in everything around it),
 * and never the file system root or the home folder.
 */
function usableRoots(roots: string[], repoRealPath: string): string[] {
  const home = os.homedir();
  return roots.filter((root) => root !== path.parse(root).root && root !== home && !isPathInside(root, repoRealPath));
}

/**
 * Resolves a file a chat links to and decides whether it belongs to the chat's
 * project. The project is the chat's folder plus every git worktree of the same
 * repository: agents work in worktrees next to the project or under
 * ~/.codex/worktrees, and a link into one must not be treated as a stranger's
 * file (approved 2026-10-30 with the file panel design).
 *
 * Every path that decides about a file a link names goes through here: the
 * consent check, the OS open, the panel's read and its write.
 */
export class WorkspaceFileResolver {
  private readonly cache = new Map<string, { roots: string[]; readAt: number }>();

  constructor(
    private readonly listWorktrees: WorktreeLister = listGitWorktreeRoots,
    private readonly now: () => number = Date.now
  ) {}

  async resolve(repoPath: string | undefined, rawPath: unknown): Promise<LocalFileResolution> {
    const resolution = await resolveLocalFile(repoPath, rawPath);
    if (!resolution.ok || resolution.insideWorkspace || !repoPath?.trim()) {
      return resolution;
    }
    if (await this.insideWorktree(repoPath, resolution.realPath)) {
      return { ...resolution, insideWorkspace: true };
    }
    return resolution;
  }

  private async insideWorktree(repoPath: string, realFilePath: string): Promise<boolean> {
    const repoRealPath = await realpath(repoPath).catch(() => path.resolve(repoPath));
    const inside = (roots: string[]) => usableRoots(roots, repoRealPath).some((root) => isPathInside(root, realFilePath));
    const cached = this.cache.get(repoPath);
    const age = cached ? this.now() - cached.readAt : Infinity;
    if (cached && age < WORKTREE_CACHE_MS) {
      if (inside(cached.roots)) return true;
      // A miss may be a worktree made a moment ago; ask git again, but not on every miss.
      if (age < WORKTREE_MISS_RECHECK_MS) return false;
    }
    const roots = await this.listWorktrees(repoPath).catch(() => [] as string[]);
    this.cache.set(repoPath, { roots, readAt: this.now() });
    return inside(roots);
  }
}
