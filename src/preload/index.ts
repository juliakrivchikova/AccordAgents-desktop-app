import { contextBridge, ipcRenderer } from "electron";
import type {
  AppBridge,
  AddChatParticipantRequest,
  ChatBehaviorRuleConfigUpdate,
  ChatPromptContextSettings,
  ChatSavedPromptConfigUpdate,
  CloudRunsSettingsUpdate,
  CloudRunWorkerSettings,
  CloudRunWorkerSetupProgress,
  ConnectAwsWorkerRequest,
  DeleteAgentEnvironmentVariableRequest,
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
  InspectLocalFileRequest,
  OpenLocalFileRequest,
  PlanDecisionClarificationRequest,
  PlanItemReviewRequest,
  PluginListRequest,
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
  SaveAgentEnvironmentVariableRequest,
  SendChatMessageRequest,
  StartChatAccordRequest,
  ToggleChatReactionRequest,
  UpdateChatParticipantRuntimeRequest,
  RemoveChatParticipantRequest,
  UserSkillDiagnosticsRequest,
  UserSkillListRequest,
  UserSkillSearchRequest
} from "../shared/types";

const bridge: AppBridge = {
  getAppVersion: () => ipcRenderer.invoke("app:get-version"),
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),
  inspectLocalFile: (request: InspectLocalFileRequest) => ipcRenderer.invoke("app:inspect-local-file", request),
  openLocalFile: (request: OpenLocalFileRequest) => ipcRenderer.invoke("app:open-local-file", request),
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => ipcRenderer.invoke("settings:set-repo-file-open-preference", action),
  setCliAgentRunTimeoutMs: (timeoutMs: number) => ipcRenderer.invoke("settings:set-cli-agent-run-timeout", timeoutMs),
  setChatParticipantRequestMaxDepth: (maxDepth: number) =>
    ipcRenderer.invoke("settings:set-chat-participant-request-max-depth", maxDepth),
  setChatParticipantRequestPromptMaxChars: (maxChars: number) =>
    ipcRenderer.invoke("settings:set-chat-participant-request-prompt-max-chars", maxChars),
  setChatAutoWatchWakeLimit: (limit: number) =>
    ipcRenderer.invoke("settings:set-chat-auto-watch-wake-limit", limit),
  setChatPromptContext: (settings: ChatPromptContextSettings) =>
    ipcRenderer.invoke("settings:set-chat-prompt-context", settings),
  saveCloudRunsSettings: (update: CloudRunsSettingsUpdate) => ipcRenderer.invoke("settings:save-cloud-runs", update),
  testCloudRunWorker: (request?: CloudRunWorkerSettings) => ipcRenderer.invoke("cloud-runs:test-worker", request),
  diagnoseCloudRunWorker: (request?: CloudRunWorkerSettings) => ipcRenderer.invoke("cloud-runs:diagnose-worker", request),
  setupCloudRunWorker: (request?: CloudRunWorkerSettings) => ipcRenderer.invoke("cloud-runs:setup-worker", request),
  onCloudRunSetupProgress: (callback: (progress: CloudRunWorkerSetupProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: CloudRunWorkerSetupProgress) => callback(progress);
    ipcRenderer.on("cloud-runs:setup-progress", listener);
    return () => ipcRenderer.removeListener("cloud-runs:setup-progress", listener);
  },
  getAwsWorkerBootstrapCommand: (region: string) => ipcRenderer.invoke("cloud-runs:aws-bootstrap-command", region),
  connectAwsWorker: (request: ConnectAwsWorkerRequest) => ipcRenderer.invoke("cloud-runs:aws-connect", request),
  getAwsWorkerStatus: () => ipcRenderer.invoke("cloud-runs:aws-status"),
  stopAwsWorker: () => ipcRenderer.invoke("cloud-runs:aws-stop"),
  deleteAwsWorker: () => ipcRenderer.invoke("cloud-runs:aws-delete"),
  getAgentEnvironment: () => ipcRenderer.invoke("settings:get-agent-environment"),
  saveAgentEnvironmentVariable: (request: SaveAgentEnvironmentVariableRequest) =>
    ipcRenderer.invoke("settings:save-agent-environment-variable", request),
  deleteAgentEnvironmentVariable: (request: DeleteAgentEnvironmentVariableRequest) =>
    ipcRenderer.invoke("settings:delete-agent-environment-variable", request),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateProviderSettings: (update: ProviderSettingsUpdate) => ipcRenderer.invoke("settings:update-provider", update),
  saveChatRoleConfig: (update: ChatRoleConfigUpdate) => ipcRenderer.invoke("settings:save-chat-role", update),
  archiveChatRoleConfig: (id: string) => ipcRenderer.invoke("settings:archive-chat-role", id),
  saveChatBehaviorRuleConfig: (update: ChatBehaviorRuleConfigUpdate) => ipcRenderer.invoke("settings:save-chat-behavior-rule", update),
  deleteChatBehaviorRuleConfig: (id: string) => ipcRenderer.invoke("settings:delete-chat-behavior-rule", id),
  saveChatSavedPromptConfig: (update: ChatSavedPromptConfigUpdate) => ipcRenderer.invoke("settings:save-chat-saved-prompt", update),
  deleteChatSavedPromptConfig: (id: string) => ipcRenderer.invoke("settings:delete-chat-saved-prompt", id),
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
  listUserSkills: (request?: UserSkillListRequest) => ipcRenderer.invoke("skills:list-all", request),
  listPlugins: (request?: PluginListRequest) => ipcRenderer.invoke("plugins:list", request),
  refreshPlugins: (request?: PluginListRequest) => ipcRenderer.invoke("plugins:refresh", request),
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
  startChatAccord: (request: StartChatAccordRequest) => ipcRenderer.invoke("chat:start-accord", request),
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
