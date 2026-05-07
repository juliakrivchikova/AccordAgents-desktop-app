import { contextBridge, ipcRenderer } from "electron";
import type { AppBridge, GitDiffRequest, ProviderSettingsUpdate, ReviewProgress, ReviewRequest } from "../shared/types";

const bridge: AppBridge = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateProviderSettings: (update: ProviderSettingsUpdate) => ipcRenderer.invoke("settings:update-provider", update),
  listProviderModels: (kind) => ipcRenderer.invoke("settings:list-provider-models", kind),
  detectAgents: () => ipcRenderer.invoke("agents:detect"),
  selectRepoDirectory: () => ipcRenderer.invoke("dialog:select-repo"),
  inspectRepo: (repoPath: string) => ipcRenderer.invoke("git:inspect-repo", repoPath),
  getDiff: (request: GitDiffRequest) => ipcRenderer.invoke("git:get-diff", request),
  listConversations: () => ipcRenderer.invoke("conversations:list"),
  getConversation: (id: string) => ipcRenderer.invoke("conversations:get", id),
  startReview: (request: ReviewRequest) => ipcRenderer.invoke("conversations:start-review", request),
  cancelReview: (runId: string) => ipcRenderer.invoke("conversations:cancel-review", runId),
  onReviewProgress: (callback: (progress: ReviewProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ReviewProgress) => callback(progress);
    ipcRenderer.on("conversations:review-progress", listener);
    return () => ipcRenderer.removeListener("conversations:review-progress", listener);
  }
};

contextBridge.exposeInMainWorld("consensus", bridge);
