import { shell } from "electron";
import type { OpenRepoFileRequest, OpenRepoFileResult, RepoFileOpenAction } from "../../shared/types";
import { resolveRepoFile, type RepoFileResolutionFailureReason } from "./repoFile";
import { SettingsService } from "./settings";
import { StorageService } from "./storage";

// Opens a repository file reference clicked in chat output. V1 supports macOS system-default
// opening and Finder reveal only; direct editor openers and line navigation are deferred. All
// path resolution flows through resolveRepoFile so repo-escape/symlink/directory checks stay in
// one place.
export class RepoFileOpenerService {
  constructor(private readonly storage: StorageService, private readonly settings: SettingsService) {}

  async openRepoFile(request: OpenRepoFileRequest): Promise<OpenRepoFileResult> {
    const conversationId = typeof request?.conversationId === "string" ? request.conversationId.trim() : "";
    if (!conversationId) {
      throw new Error("A conversation is required to open a file.");
    }
    const action = this.normalizeAction(request.action) ?? (await this.settings.getRepoFileOpenAction()) ?? "open";

    const conversation = await this.storage.getConversation(conversationId);
    if (!conversation) {
      throw new Error("Conversation not found.");
    }
    if (!conversation.repoPath || !conversation.repoPath.trim()) {
      throw new Error("This chat has no selected repository, so file links cannot be opened.");
    }

    const resolution = await resolveRepoFile(conversation.repoPath, request.path);
    if (!resolution.ok) {
      throw new Error(this.failureMessage(resolution.reason));
    }

    if (action === "reveal") {
      shell.showItemInFolder(resolution.absolutePath);
    } else {
      const error = await shell.openPath(resolution.absolutePath);
      if (error) {
        throw new Error(`Could not open the file with the default app: ${error}`);
      }
    }

    return {
      action,
      path: request.path,
      line: typeof request.line === "number" ? request.line : undefined,
      column: typeof request.column === "number" ? request.column : undefined,
      // Neither system-default open nor Finder reveal can jump to a specific line.
      lineNavigationSupported: false
    };
  }

  async setOpenPreference(action: unknown) {
    return this.settings.setRepoFileOpenAction(this.normalizeAction(action) ?? null);
  }

  private normalizeAction(action: unknown): RepoFileOpenAction | undefined {
    return action === "open" || action === "reveal" ? action : undefined;
  }

  private failureMessage(reason: RepoFileResolutionFailureReason): string {
    switch (reason) {
      case "repo-missing":
        return "The selected repository no longer exists.";
      case "outside-repo":
        return "That file is outside the chat's repository.";
      case "directory":
        return "That path is a directory, not a file.";
      case "not-regular-file":
        return "That path is not a regular file.";
      case "not-found":
        return "That file no longer exists in the repository.";
      default:
        return "That file path is invalid.";
    }
  }
}
