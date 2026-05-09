import { contextBridge, ipcRenderer } from "electron";
import type {
  AppBridge,
  AddChatParticipantRequest,
  ChatRoleConfigUpdate,
  ComposeImplementationPlanRequest,
  ContinueReviewRequest,
  Conversation,
  CreateChatConversationRequest,
  GitDiffRequest,
  PlanDecisionClarificationRequest,
  PlanItemReviewRequest,
  ProviderSettingsUpdate,
  RespondToChatMentionsRequest,
  RecoverImplementationPlanRequest,
  ReviseImplementationPlanRequest,
  RetryImplementationPlanSynthesisRequest,
  ReviewProgress,
  ReviewRequest,
  SendChatMessageRequest
} from "../shared/types";

const bridge: AppBridge = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateProviderSettings: (update: ProviderSettingsUpdate) => ipcRenderer.invoke("settings:update-provider", update),
  saveChatRoleConfig: (update: ChatRoleConfigUpdate) => ipcRenderer.invoke("settings:save-chat-role", update),
  updateLastRepoPath: (repoPath: string) => ipcRenderer.invoke("settings:update-last-repo-path", repoPath),
  listProviderModels: (kind) => ipcRenderer.invoke("settings:list-provider-models", kind),
  detectAgents: () => ipcRenderer.invoke("agents:detect"),
  selectRepoDirectory: () => ipcRenderer.invoke("dialog:select-repo"),
  inspectRepo: (repoPath: string) => ipcRenderer.invoke("git:inspect-repo", repoPath),
  getDiff: (request: GitDiffRequest) => ipcRenderer.invoke("git:get-diff", request),
  listConversations: () => ipcRenderer.invoke("conversations:list"),
  getConversation: (id: string) => ipcRenderer.invoke("conversations:get", id),
  saveDecisionSelections: (conversationId: string, selections: Record<string, string>) =>
    ipcRenderer.invoke("conversations:save-decision-selections", conversationId, selections),
  saveDecisionResolutions: (conversationId: string, resolutions: Record<string, boolean>) =>
    ipcRenderer.invoke("conversations:save-decision-resolutions", conversationId, resolutions),
  savePlanItemReview: (request: PlanItemReviewRequest) => ipcRenderer.invoke("conversations:save-plan-item-review", request),
  createChatConversation: (request: CreateChatConversationRequest) => ipcRenderer.invoke("chat:create", request),
  addChatParticipant: (request: AddChatParticipantRequest) => ipcRenderer.invoke("chat:add-participant", request),
  sendChatMessage: (request: SendChatMessageRequest) => ipcRenderer.invoke("chat:send", request),
  respondToChatMentions: (request: RespondToChatMentionsRequest) => ipcRenderer.invoke("chat:respond-to-mentions", request),
  startReview: (request: ReviewRequest) => ipcRenderer.invoke("conversations:start-review", request),
  continueReview: (request: ContinueReviewRequest) => ipcRenderer.invoke("conversations:continue-review", request),
  askPlanDecisionClarification: (request: PlanDecisionClarificationRequest) => ipcRenderer.invoke("conversations:ask-plan-decision-clarification", request),
  composeImplementationPlan: (request: ComposeImplementationPlanRequest) => ipcRenderer.invoke("conversations:compose-implementation-plan", request),
  retryImplementationPlanSynthesis: (request: RetryImplementationPlanSynthesisRequest) =>
    ipcRenderer.invoke("conversations:retry-implementation-plan-synthesis", request),
  recoverImplementationPlan: (request: RecoverImplementationPlanRequest) =>
    ipcRenderer.invoke("conversations:recover-implementation-plan", request),
  reviseImplementationPlan: (request: ReviseImplementationPlanRequest) =>
    ipcRenderer.invoke("conversations:revise-implementation-plan", request),
  cancelReview: (runId: string) => ipcRenderer.invoke("conversations:cancel-review", runId),
  onReviewProgress: (callback: (progress: ReviewProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ReviewProgress) => callback(progress);
    ipcRenderer.on("conversations:review-progress", listener);
    return () => ipcRenderer.removeListener("conversations:review-progress", listener);
  },
  onConversationUpdated: (callback: (conversation: Conversation) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, conversation: Conversation) => callback(conversation);
    ipcRenderer.on("conversations:updated", listener);
    return () => ipcRenderer.removeListener("conversations:updated", listener);
  }
};

contextBridge.exposeInMainWorld("consensus", bridge);
