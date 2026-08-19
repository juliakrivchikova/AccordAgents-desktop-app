import { CommandError, firstCommandLookupPath, runCommand } from "./command";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { GitDiffRequest, GitDiffResult, GitRepoInfo, RepoFileSearchResult } from "../../shared/types";

function cleanLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function cleanBranchRefs(value: string): string[] {
  const seen = new Set<string>();
  const branches: string[] = [];

  for (const line of value.split(/\r?\n/)) {
    const [fullRef = "", shortRef = "", symRef = ""] = line.split("\t").map((part) => part.trim());
    if (!shortRef || symRef || fullRef.endsWith("/HEAD")) {
      continue;
    }
    if (!seen.has(shortRef)) {
      seen.add(shortRef);
      branches.push(shortRef);
    }
  }

  return branches;
}

function gitError(error: unknown): string {
  if (error instanceof CommandError) {
    return (error.result.stderr || error.result.stdout || error.message).trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function filesystemErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "ENOENT") {
    return "Folder does not exist.";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "Folder cannot be accessed.";
  }
  return error instanceof Error ? error.message : String(error);
}

interface RepoFileCacheEntry {
  indexMtimeMs?: number;
  paths: string[];
}

export interface GitServiceOptions {
  gitExecutable?: string;
  resolveGitExecutable?: () => Promise<string>;
}

async function resolveWindowsGitExecutable(): Promise<string> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) {
    throw new Error("Git executable lookup failed because the Windows system root is unavailable.");
  }

  const whereExecutable = path.join(systemRoot, "System32", "where.exe");
  const lookupCwd = path.dirname(process.execPath);
  const result = await runCommand(whereExecutable, ["git"], {
    cwd: lookupCwd,
    primeLoginShellEnv: false,
    timeoutMs: 5000
  });
  const executable = firstCommandLookupPath(result.stdout, "win32", process.env.PATHEXT);
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error("Git executable lookup did not return an absolute path.");
  }
  return path.resolve(executable);
}

export class GitService {
  private readonly repoFileCache = new Map<string, RepoFileCacheEntry>();
  private readonly gitExecutable?: string;
  private readonly resolveGitExecutable?: () => Promise<string>;
  private gitExecutablePromise?: Promise<string>;

  constructor(options: GitServiceOptions = {}) {
    if (options.gitExecutable !== undefined && !path.isAbsolute(options.gitExecutable)) {
      throw new Error("Git executable must be an absolute path.");
    }
    this.gitExecutable = options.gitExecutable;
    this.resolveGitExecutable = options.resolveGitExecutable;
  }

  async inspectRepo(repoPath: string): Promise<GitRepoInfo> {
    const normalizedRepoPath = repoPath.trim();
    try {
      const repoStat = await stat(normalizedRepoPath);
      if (!repoStat.isDirectory()) {
        return {
          repoPath: normalizedRepoPath,
          isRepo: false,
          branches: [],
          statusLines: [],
          error: "Selected path is not a folder."
        };
      }
    } catch (error) {
      return {
        repoPath: normalizedRepoPath,
        isRepo: false,
        branches: [],
        statusLines: [],
        error: filesystemErrorMessage(error)
      };
    }

    let gitMarkerFound = false;
    try {
      gitMarkerFound = await this.hasGitMarker(normalizedRepoPath);
    } catch (error) {
      return {
        repoPath: normalizedRepoPath,
        isRepo: false,
        branches: [],
        statusLines: [],
        error: filesystemErrorMessage(error)
      };
    }
    if (!gitMarkerFound) {
      return {
        repoPath: normalizedRepoPath,
        isRepo: false,
        branches: [],
        statusLines: []
      };
    }

    try {
      const gitExecutable = await this.gitCommand();
      await runCommand(gitExecutable, ["rev-parse", "--is-inside-work-tree"], { cwd: normalizedRepoPath, timeoutMs: 8000 });
      const [branch, branches, status] = await Promise.all([
        runCommand(gitExecutable, ["branch", "--show-current"], { cwd: normalizedRepoPath, timeoutMs: 8000 }).catch(() => ({ stdout: "" })),
        runCommand(gitExecutable, ["for-each-ref", "--format=%(refname)%09%(refname:short)%09%(symref)", "refs/heads", "refs/remotes"], {
          cwd: normalizedRepoPath,
          timeoutMs: 8000
        }).catch(() => ({ stdout: "" })),
        runCommand(gitExecutable, ["status", "--short"], { cwd: normalizedRepoPath, timeoutMs: 8000 }).catch(() => ({ stdout: "" }))
      ]);

      return {
        repoPath: normalizedRepoPath,
        isRepo: true,
        currentBranch: branch.stdout.trim() || undefined,
        branches: cleanBranchRefs(branches.stdout),
        statusLines: cleanLines(status.stdout)
      };
    } catch (error) {
      const message = gitError(error);
      return {
        repoPath: normalizedRepoPath,
        isRepo: false,
        branches: [],
        statusLines: [],
        error: message
      };
    }
  }

  async getDiff(request: GitDiffRequest): Promise<GitDiffResult> {
    if (request.mode === "pasted") {
      return {
        mode: "pasted",
        title: "Pasted diff",
        diff: request.pastedDiff?.trim() ?? "",
        metadata: { source: "pasted" }
      };
    }

    const repoPath = request.repoPath;
    let title = "Working tree diff";
    let diff = "";
    const metadata: GitDiffResult["metadata"] = { source: "git", mode: request.mode };

    if (request.mode === "working") {
      title = "Unstaged changes";
      diff = await this.gitOutput(repoPath, ["diff", "--no-ext-diff", "--"]);
    } else if (request.mode === "staged") {
      title = "Staged changes";
      diff = await this.gitOutput(repoPath, ["diff", "--cached", "--no-ext-diff", "--"]);
    } else if (request.mode === "uncommitted") {
      title = "Uncommitted changes";
      const staged = await this.gitOutput(repoPath, ["diff", "--cached", "--no-ext-diff", "--"]);
      const working = await this.gitOutput(repoPath, ["diff", "--no-ext-diff", "--"]);
      const untracked = await this.gitOutput(repoPath, ["ls-files", "--others", "--exclude-standard"]);
      diff = [this.section("Staged", staged), this.section("Unstaged", working), this.section("Untracked files", untracked)]
        .filter(Boolean)
        .join("\n\n");
    } else if (request.mode === "base") {
      const baseBranch = request.baseBranch?.trim();
      const compareBranch = request.compareBranch?.trim();
      if (!baseBranch || !compareBranch) {
        throw new Error("Base and compare branches are required for branch comparison.");
      }
      title = `Changes from ${baseBranch} to ${compareBranch}`;
      metadata.baseBranch = baseBranch;
      metadata.compareBranch = compareBranch;
      diff = await this.gitOutput(repoPath, ["diff", "--no-ext-diff", `${baseBranch}...${compareBranch}`, "--"]);
    } else if (request.mode === "commit") {
      const commit = request.commit?.trim();
      if (!commit) {
        throw new Error("Commit SHA is required for commit review.");
      }
      title = `Commit ${commit}`;
      metadata.commit = commit;
      diff = await this.gitOutput(repoPath, ["show", "--format=fuller", "--stat", "--patch", commit]);
    }

    return { mode: request.mode, repoPath, title, diff: diff.trim(), metadata };
  }

  async searchRepoFiles(repoPath: string, query: string, limit = 50): Promise<RepoFileSearchResult[]> {
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const normalizedQuery = query.trim().toLowerCase();
    const paths = await this.listRepoFiles(repoPath).catch((): string[] => []);
    const ranked = paths
      .map((filePath) => ({ path: filePath, score: this.repoFileSearchScore(filePath, normalizedQuery) }))
      .filter((item) => item.score < Number.POSITIVE_INFINITY)
      .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path));
    return ranked.slice(0, normalizedLimit).map((item) => ({ path: item.path }));
  }

  private async gitOutput(repoPath: string, args: string[]): Promise<string> {
    const result = await runCommand(await this.gitCommand(), args, { cwd: repoPath, timeoutMs: 20_000 });
    return result.stdout.trim();
  }

  private async gitCommand(): Promise<string> {
    if (this.gitExecutable) {
      return this.gitExecutable;
    }
    if (process.platform !== "win32") {
      return "git";
    }
    if (!this.gitExecutablePromise) {
      this.gitExecutablePromise = (this.resolveGitExecutable?.() ?? resolveWindowsGitExecutable()).then((executable) => {
        if (!path.isAbsolute(executable)) {
          throw new Error("Git executable must resolve to an absolute path.");
        }
        return path.resolve(executable);
      });
    }
    return this.gitExecutablePromise;
  }

  private async hasGitMarker(startPath: string): Promise<boolean> {
    let currentPath = path.resolve(startPath);
    while (true) {
      const found = await stat(path.join(currentPath, ".git")).then(
        () => true,
        (error) => {
          const code = typeof error === "object" && error && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
          if (code === "ENOENT" || code === "ENOTDIR") {
            return false;
          }
          throw error;
        }
      );
      if (found) {
        return true;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return false;
      }
      currentPath = parentPath;
    }
  }

  private async listRepoFiles(repoPath: string): Promise<string[]> {
    const indexMtimeMs = await this.gitIndexMtimeMs(repoPath);
    const cached = this.repoFileCache.get(repoPath);
    if (cached && cached.indexMtimeMs !== undefined && cached.indexMtimeMs === indexMtimeMs) {
      return cached.paths;
    }
    const output = await this.gitOutput(repoPath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    const seen = new Set<string>();
    const paths = output
      .split("\0")
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => {
        const normalized = item.replace(/\\/g, "/");
        if (seen.has(normalized)) {
          return false;
        }
        seen.add(normalized);
        return true;
      })
      .sort((left, right) => left.localeCompare(right));
    this.repoFileCache.set(repoPath, { indexMtimeMs, paths });
    return paths;
  }

  private async gitIndexMtimeMs(repoPath: string): Promise<number | undefined> {
    const gitDir = await this.gitOutput(repoPath, ["rev-parse", "--git-dir"]).catch(() => ".git");
    const indexPath = path.isAbsolute(gitDir) ? path.join(gitDir, "index") : path.join(repoPath, gitDir, "index");
    return stat(indexPath).then((info) => info.mtimeMs).catch(() => undefined);
  }

  private repoFileSearchScore(filePath: string, query: string): number {
    if (!query) {
      return 100 + filePath.length / 1000;
    }
    const normalizedPath = filePath.toLowerCase();
    const basename = normalizedPath.split("/").pop() ?? normalizedPath;
    if (basename === query) {
      return 0;
    }
    if (basename.startsWith(query)) {
      return 10 + basename.length / 1000;
    }
    const basenameIndex = basename.indexOf(query);
    if (basenameIndex >= 0) {
      return 20 + basenameIndex + basename.length / 1000;
    }
    const pathIndex = normalizedPath.indexOf(query);
    if (pathIndex >= 0) {
      return 40 + pathIndex + normalizedPath.length / 1000;
    }
    return Number.POSITIVE_INFINITY;
  }

  private section(title: string, content: string): string {
    if (!content.trim()) {
      return "";
    }
    return `## ${title}\n${content.trim()}`;
  }
}
