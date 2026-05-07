import { CommandError, runCommand } from "./command";
import type { GitDiffRequest, GitDiffResult, GitRepoInfo } from "../../shared/types";

function cleanLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitError(error: unknown): string {
  if (error instanceof CommandError) {
    return (error.result.stderr || error.result.stdout || error.message).trim();
  }
  return error instanceof Error ? error.message : String(error);
}

export class GitService {
  async inspectRepo(repoPath: string): Promise<GitRepoInfo> {
    try {
      await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoPath, timeoutMs: 8000 });
      const [branch, branches, status] = await Promise.all([
        runCommand("git", ["branch", "--show-current"], { cwd: repoPath, timeoutMs: 8000 }).catch(() => ({ stdout: "" })),
        runCommand("git", ["branch", "--format=%(refname:short)"], { cwd: repoPath, timeoutMs: 8000 }).catch(() => ({ stdout: "" })),
        runCommand("git", ["status", "--short"], { cwd: repoPath, timeoutMs: 8000 }).catch(() => ({ stdout: "" }))
      ]);

      return {
        repoPath,
        isRepo: true,
        currentBranch: branch.stdout.trim() || undefined,
        branches: cleanLines(branches.stdout),
        statusLines: cleanLines(status.stdout)
      };
    } catch (error) {
      return {
        repoPath,
        isRepo: false,
        branches: [],
        statusLines: [],
        error: gitError(error)
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
      if (!baseBranch) {
        throw new Error("Base branch is required for branch comparison.");
      }
      title = `Changes against ${baseBranch}`;
      metadata.baseBranch = baseBranch;
      diff = await this.gitOutput(repoPath, ["diff", "--no-ext-diff", `${baseBranch}...HEAD`, "--"]);
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

  private async gitOutput(repoPath: string, args: string[]): Promise<string> {
    const result = await runCommand("git", args, { cwd: repoPath, timeoutMs: 20_000 });
    return result.stdout.trim();
  }

  private section(title: string, content: string): string {
    if (!content.trim()) {
      return "";
    }
    return `## ${title}\n${content.trim()}`;
  }
}
