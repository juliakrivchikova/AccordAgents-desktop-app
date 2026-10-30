import { realpath } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "./command";
import { isPathInside, resolveLocalFile, type LocalFileResolution } from "./repoFile";

/** How long a repository's worktree list is trusted before it is read again. */
const WORKTREE_CACHE_MS = 30_000;

export type WorktreeLister = (repoPath: string) => Promise<string[]>;

/** `git worktree list --porcelain` roots, as real paths. Empty when the folder is not a git repository. */
export async function listGitWorktreeRoots(repoPath: string): Promise<string[]> {
  const result = await runCommand("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    timeoutMs: 5_000,
    primeLoginShellEnv: false
  }).catch(() => undefined);
  if (!result || result.exitCode !== 0) return [];
  const roots: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const root = line.slice("worktree ".length).trim();
    if (!root) continue;
    roots.push(await realpath(root).catch(() => path.resolve(root)));
  }
  return roots;
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
    const cached = this.cache.get(repoPath);
    const fresh = cached && this.now() - cached.readAt < WORKTREE_CACHE_MS;
    if (fresh && cached.roots.some((root) => isPathInside(root, realFilePath))) {
      return true;
    }
    // A miss on a fresh list may be a worktree created a moment ago: read again once.
    const roots = await this.listWorktrees(repoPath).catch(() => [] as string[]);
    this.cache.set(repoPath, { roots, readAt: this.now() });
    return roots.some((root) => isPathInside(root, realFilePath));
  }
}
