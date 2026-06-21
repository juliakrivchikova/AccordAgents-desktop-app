import { contextBridge, ipcRenderer } from "electron";
import type {
  AppBridge,
  AddChatParticipantRequest,
  ChatBehaviorRuleConfigUpdate,
  CompactChatParticipantRequest,
  ChatParticipantConfigUpdate,
  ChatRoleConfigUpdate,
  ComposeImplementationPlanRequest,
  ContinueReviewRequest,
  ConversationMessagePageRequest,
  Conversation,
  CreateChatConversationRequest,
  DismissConversationWarningsRequest,
  GitDiffRequest,
  OpenRepoFileRequest,
  PlanDecisionClarificationRequest,
  PlanItemReviewRequest,
  ProviderSettingsUpdate,
  ReadChatAttachmentRequest,
  RenameChatConversationRequest,
  SetChatArchivedRequest,
  RepoFileOpenAction,
  RepoFileSearchRequest,
  RespondToChatAppToolApprovalRequest,
  RespondToChatChoiceRequest,
  RespondToChatMentionsRequest,
  RecoverImplementationPlanRequest,
  ReviseImplementationPlanRequest,
  RetryImplementationPlanSynthesisRequest,
  ReviewProgress,
  ReviewRequest,
  SendChatMessageRequest,
  ToggleChatReactionRequest,
  UpdateChatParticipantRuntimeRequest,
  RemoveChatParticipantRequest,
  UserSkillDiagnosticsRequest,
  UserSkillSearchRequest
} from "../shared/types";

const bridge: AppBridge = {
  getAppVersion: () => ipcRenderer.invoke("app:get-version"),
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),
  openRepoFile: (request: OpenRepoFileRequest) => ipcRenderer.invoke("app:open-repo-file", request),
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => ipcRenderer.invoke("settings:set-repo-file-open-preference", action),
  setCliAgentRunTimeoutMs: (timeoutMs: number) => ipcRenderer.invoke("settings:set-cli-agent-run-timeout", timeoutMs),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateProviderSettings: (update: ProviderSettingsUpdate) => ipcRenderer.invoke("settings:update-provider", update),
  saveChatRoleConfig: (update: ChatRoleConfigUpdate) => ipcRenderer.invoke("settings:save-chat-role", update),
  archiveChatRoleConfig: (id: string) => ipcRenderer.invoke("settings:archive-chat-role", id),
  saveChatBehaviorRuleConfig: (update: ChatBehaviorRuleConfigUpdate) => ipcRenderer.invoke("settings:save-chat-behavior-rule", update),
  deleteChatBehaviorRuleConfig: (id: string) => ipcRenderer.invoke("settings:delete-chat-behavior-rule", id),
  saveChatParticipantConfig: (update: ChatParticipantConfigUpdate) => ipcRenderer.invoke("settings:save-chat-participant", update),
  deleteChatParticipantConfig: (id: string) => ipcRenderer.invoke("settings:delete-chat-participant", id),
  updateLastRepoPath: (repoPath: string) => ipcRenderer.invoke("settings:update-last-repo-path", repoPath),
  listProviderModels: (kind) => ipcRenderer.invoke("settings:list-provider-models", kind),
  detectAgents: () => ipcRenderer.invoke("agents:detect"),
  selectRepoDirectory: () => ipcRenderer.invoke("dialog:select-repo"),
  inspectRepo: (repoPath: string) => ipcRenderer.invoke("git:inspect-repo", repoPath),
  getDiff: (request: GitDiffRequest) => ipcRenderer.invoke("git:get-diff", request),
  searchRepoFiles: (request: RepoFileSearchRequest) => ipcRenderer.invoke("git:search-repo-files", request),
  searchUserSkills: (request: UserSkillSearchRequest) => ipcRenderer.invoke("skills:search", request),
  getUserSkillDiagnostics: (request?: UserSkillDiagnosticsRequest) => ipcRenderer.invoke("skills:diagnostics", request),
  listConversations: () => ipcRenderer.invoke("conversations:list"),
  getConversation: (id: string) => ipcRenderer.invoke("conversations:get", id),
  openConversation: (id: string, limit?: number) => ipcRenderer.invoke("conversations:open", id, limit),
  listConversationMessages: (request: ConversationMessagePageRequest) => ipcRenderer.invoke("conversations:list-messages", request),
  saveDecisionSelections: (conversationId: string, selections: Record<string, string>) =>
    ipcRenderer.invoke("conversations:save-decision-selections", conversationId, selections),
  saveDecisionResolutions: (conversationId: string, resolutions: Record<string, boolean>) =>
    ipcRenderer.invoke("conversations:save-decision-resolutions", conversationId, resolutions),
  savePlanItemReview: (request: PlanItemReviewRequest) => ipcRenderer.invoke("conversations:save-plan-item-review", request),
  createChatConversation: (request: CreateChatConversationRequest) => ipcRenderer.invoke("chat:create", request),
  renameChatConversation: (request: RenameChatConversationRequest) => ipcRenderer.invoke("chat:rename", request),
  setChatArchived: (request: SetChatArchivedRequest) => ipcRenderer.invoke("chat:set-archived", request),
  dismissConversationWarnings: (request: DismissConversationWarningsRequest) => ipcRenderer.invoke("chat:dismiss-warnings", request),
  addChatParticipant: (request: AddChatParticipantRequest) => ipcRenderer.invoke("chat:add-participant", request),
  updateChatParticipantRuntime: (request: UpdateChatParticipantRuntimeRequest) => ipcRenderer.invoke("chat:update-participant-runtime", request),
  removeChatParticipant: (request: RemoveChatParticipantRequest) => ipcRenderer.invoke("chat:remove-participant", request),
  compactChatParticipant: (request: CompactChatParticipantRequest) => ipcRenderer.invoke("chat:compact-participant", request),
  sendChatMessage: (request: SendChatMessageRequest) => ipcRenderer.invoke("chat:send", request),
  readChatAttachment: (request: ReadChatAttachmentRequest) => ipcRenderer.invoke("chat:read-attachment", request),
  toggleChatReaction: (request: ToggleChatReactionRequest) => ipcRenderer.invoke("chat:toggle-reaction", request),
  respondToChatMentions: (request: RespondToChatMentionsRequest) => ipcRenderer.invoke("chat:respond-to-mentions", request),
  respondToChatChoice: (request: RespondToChatChoiceRequest) => ipcRenderer.invoke("chat:respond-to-choice", request),
  respondToChatAppToolApproval: (request: RespondToChatAppToolApprovalRequest) => ipcRenderer.invoke("chat:respond-to-app-tool-approval", request),
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
