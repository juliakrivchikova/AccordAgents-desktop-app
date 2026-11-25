export type GitDiffMode = "working" | "staged" | "uncommitted" | "base" | "commit" | "pasted";

export interface GitRepoInfo {
  repoPath: string;
  isRepo: boolean;
  currentBranch?: string;
  branches: string[];
  /** The folder's own branches (no remotes): the ones it can switch to. */
  localBranches?: string[];
  statusLines: string[];
  error?: string;
}

export interface GitSwitchBranchRequest {
  repoPath: string;
  branch: string;
}

export interface GitDiffRequest {
  repoPath: string;
  mode: GitDiffMode;
  baseBranch?: string;
  compareBranch?: string;
  commit?: string;
  pastedDiff?: string;
}

export interface GitDiffResult {
  mode: GitDiffMode;
  repoPath?: string;
  title: string;
  diff: string;
  metadata: Record<string, string | number | boolean | undefined>;
}

export interface RepoFileMention {
  path: string;
}

export interface RepoFileSearchRequest {
  conversationId?: string;
  repoPath?: string;
  query: string;
  limit?: number;
}

export interface RepoFileSearchResult {
  path: string;
}
