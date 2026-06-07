import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

// Shared, safe resolution of a repository-relative or absolute file reference against a
// selected repo. Used both by chat repo-file mention validation and by the open-file IPC path
// so the security checks (repo containment, symlink escape, directory/regular-file) live in one
// place.

export type RepoFileResolutionFailureReason =
  | "invalid-path"
  | "repo-missing"
  | "outside-repo"
  | "not-found"
  | "directory"
  | "not-regular-file";

export type RepoFileResolution =
  | { ok: true; absolutePath: string }
  | { ok: false; reason: RepoFileResolutionFailureReason };

function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveRepoFile(repoPath: string, rawPath: unknown): Promise<RepoFileResolution> {
  if (typeof repoPath !== "string" || !repoPath.trim()) {
    return { ok: false, reason: "repo-missing" };
  }
  if (typeof rawPath !== "string") {
    return { ok: false, reason: "invalid-path" };
  }
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return { ok: false, reason: "invalid-path" };
  }

  const repoRoot = path.resolve(repoPath);
  const absolutePath = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(repoRoot, trimmed);

  let repoRealPath: string;
  try {
    repoRealPath = await realpath(repoRoot);
  } catch {
    return { ok: false, reason: "repo-missing" };
  }

  // Lexical containment first, before touching the target. Check both the selected repo path
  // and its real path so absolute links still work when the repo path contains a symlink.
  if (!isPathInside(repoRoot, absolutePath) && !isPathInside(repoRealPath, absolutePath)) {
    return { ok: false, reason: "outside-repo" };
  }

  try {
    const linkInfo = await lstat(absolutePath);
    if (linkInfo.isDirectory()) {
      return { ok: false, reason: "directory" };
    }
    // Resolve symlinks and re-check containment to block symlink escapes.
    const realFilePath = await realpath(absolutePath);
    if (!isPathInside(repoRealPath, realFilePath)) {
      return { ok: false, reason: "outside-repo" };
    }
    const fileInfo = await stat(absolutePath);
    if (!fileInfo.isFile()) {
      return { ok: false, reason: "not-regular-file" };
    }
    return { ok: true, absolutePath };
  } catch {
    return { ok: false, reason: "not-found" };
  }
}
