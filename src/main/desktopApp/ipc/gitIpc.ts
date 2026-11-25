import { FOLDER_BUSY_REASON, folderBusy } from "../../../shared/newChat";
import { ipcMain } from "electron";
import type { GitDiffRequest, GitSwitchBranchRequest, RepoFileSearchRequest } from "../../../shared/types";
import type { DesktopApp } from "../desktopApp";

export function registerGitIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("git:inspect-repo", (_event, repoPath: string) => desktopApp.gitService.inspectRepo(repoPath));

  ipcMain.handle("git:switch-branch", async (_event, request: GitSwitchBranchRequest) => {
    // A switch changes the whole working tree: refused while a chat works
    // anywhere in it, in this folder or in another folder of the same tree.
    const running = (await desktopApp.storageService.listConversations()).filter((summary) => summary.repoPath && (summary.running || summary.replyPending));
    if (folderBusy(running, request.repoPath)) throw new Error(FOLDER_BUSY_REASON);
    const root = running.length ? await desktopApp.gitService.worktreeRoot(request.repoPath) : undefined;
    for (const summary of root ? running : []) {
      if (await desktopApp.gitService.worktreeRoot(summary.repoPath!) === root) throw new Error(FOLDER_BUSY_REASON);
    }
    return desktopApp.gitService.switchBranch(request.repoPath, request.branch);
  });

  ipcMain.handle("git:get-diff", (_event, request: GitDiffRequest) => desktopApp.gitService.getDiff(request));

  ipcMain.handle("git:search-repo-files", async (_event, request: RepoFileSearchRequest) => {
    const conversationId = typeof request?.conversationId === "string" ? request.conversationId : "";
    const query = typeof request?.query === "string" ? request.query : "";
    const limit = typeof request?.limit === "number" ? request.limit : undefined;
    let repoPath = "";
    if (conversationId) {
      const conversation = await desktopApp.storageService.getConversation(conversationId);
      repoPath = conversation?.repoPath ?? "";
    } else {
      repoPath = typeof request?.repoPath === "string" ? request.repoPath.trim() : "";
    }
    if (!repoPath) {
      return [];
    }
    return desktopApp.gitService.searchRepoFiles(repoPath, query, limit);
  });
}
