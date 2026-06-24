import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

// Shared file reference resolution helpers. Repository file references stay repo-contained
// because they can become agent prompt context. Local file references are opener-only, but still
// report whether the target resolves outside the selected workspace so the UI can require consent.

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

export type LocalFileResolutionFailureReason =
  | "invalid-path"
  | "base-missing"
  | "not-found"
  | "directory"
  | "not-regular-file";

export type LocalFileResolution =
  | { ok: true; absolutePath: string; realPath: string; insideWorkspace: boolean }
  | { ok: false; reason: LocalFileResolutionFailureReason };

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

export async function resolveLocalFile(basePath: string | undefined, rawPath: unknown): Promise<LocalFileResolution> {
  if (typeof rawPath !== "string") {
    return { ok: false, reason: "invalid-path" };
  }
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return { ok: false, reason: "invalid-path" };
  }

  let absolutePath: string;
  let baseRealPath: string | undefined;
  if (path.isAbsolute(trimmed)) {
    absolutePath = path.resolve(trimmed);
  } else {
    if (typeof basePath !== "string" || !basePath.trim()) {
      return { ok: false, reason: "base-missing" };
    }
    try {
      const baseInfo = await stat(basePath);
      if (!baseInfo.isDirectory()) {
        return { ok: false, reason: "base-missing" };
      }
      baseRealPath = await realpath(basePath);
    } catch {
      return { ok: false, reason: "base-missing" };
    }
    absolutePath = path.resolve(basePath, trimmed);
  }

  if (!baseRealPath && typeof basePath === "string" && basePath.trim()) {
    try {
      const baseInfo = await stat(basePath);
      if (baseInfo.isDirectory()) {
        baseRealPath = await realpath(basePath);
      }
    } catch {
      baseRealPath = undefined;
    }
  }

  try {
    const linkInfo = await lstat(absolutePath);
    if (linkInfo.isDirectory()) {
      return { ok: false, reason: "directory" };
    }
    const realFilePath = await realpath(absolutePath);
    const fileInfo = await stat(absolutePath);
    if (!fileInfo.isFile()) {
      return { ok: false, reason: "not-regular-file" };
    }
    return {
      ok: true,
      absolutePath,
      realPath: realFilePath,
      insideWorkspace: baseRealPath ? isPathInside(baseRealPath, realFilePath) : false
    };
  } catch {
    return { ok: false, reason: "not-found" };
  }
}
