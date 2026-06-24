export type ProviderKind = "openai" | "anthropic" | "gemini" | "codex-cli" | "claude-code";

export type ConversationKind = "general" | "code-review" | "implementation-plan" | "chat";

export type GitDiffMode = "working" | "staged" | "uncommitted" | "base" | "commit" | "pasted";

export type FindingSeverity = "Critical" | "High" | "Medium" | "Low" | "Info";

export type FindingStatus = "Confirmed" | "Rejected" | "Unresolved";

export type DebateStance = "confirmed" | "rejected" | "unclear" | "originator-rebuttal" | "final-resolution";

export interface ProviderSettings {
  kind: ProviderKind;
  label: string;
  enabled: boolean;
  model?: string;
}

export interface AppSettings {
  roundLimitDefault: number;
  cliAgentRunTimeoutMs: number;
  providers: ProviderSettings[];
  chatRoleConfigs: ChatRoleConfig[];
  chatBehaviorRules: ChatBehaviorRuleConfig[];
  chatParticipantConfigs: ChatParticipantConfig[];
  chatParticipantSeedState?: ChatParticipantSeedState;
  lastRepoPath?: string;
  repoFileOpenAction?: RepoFileOpenAction;
}

export interface ChatRoleConfig {
  id: string;
  label: string;
  instructions: string;
  version: number;
  builtIn?: boolean;
  appToolCapabilities?: ChatAppToolCapability[];
  updatedAt: string;
  // Soft-delete marker. Archived custom roles stay in settings so existing
  // participants keep resolving, but are hidden from the Roles list and pickers.
  archivedAt?: string;
}

export interface ChatBehaviorRuleConfig {
  id: string;
  label: string;
  instructions: string;
  version: number;
  updatedAt: string;
}

export interface ChatBehaviorRuleSnapshot {
  id: string;
  label: string;
  instructions: string;
  version: number;
}

export type ChatProviderKind = Extract<ProviderKind, "codex-cli" | "claude-code">;

export interface ChatParticipantSeedRecord {
  participantConfigId: string;
  updatedAt: string;
}

export interface ChatParticipantSeedState {
  seededProviders?: Partial<Record<ChatProviderKind, ChatParticipantSeedRecord>>;
  deletedSeedProviders?: Partial<Record<ChatProviderKind, ChatParticipantSeedRecord>>;
}

export type UserSkillScope = "personal" | "repo";

export type UserSkillCapabilityState = "invocable" | "discovery-only" | "unsupported";

export interface ChatSkillMentionVariant {
  providerKind: ChatProviderKind;
  scope: UserSkillScope;
  rootKind: UserSkillScope;
  sourceKey: string;
  frontmatterName: string;
  contentHash: string;
  capabilityState: UserSkillCapabilityState;
}

export interface ChatSkillMention {
  skillId: string;
  displayName: string;
  frontmatterName: string;
  description?: string;
  contentHash: string;
  capabilityState: UserSkillCapabilityState;
  variants: ChatSkillMentionVariant[];
}

export interface UserSkillSummary extends ChatSkillMention {
  providerKinds: ChatProviderKind[];
  scopeKinds: UserSkillScope[];
  statusMessage?: string;
  ambiguous?: boolean;
}

export interface UserSkillSearchRequest {
  conversationId?: string;
  repoPath?: string;
  participants?: ChatParticipantInput[];
  query: string;
  content?: string;
  limit?: number;
}

export interface UserSkillTargetSummary {
  participantIds: string[];
  providerKinds: ChatProviderKind[];
  hasClearTargets: boolean;
}

export interface UserSkillSearchResult {
  target: UserSkillTargetSummary;
  skills: UserSkillSummary[];
}

export interface UserSkillDiagnosticsRequest {
  conversationId?: string;
}

export interface UserSkillDiagnosticRoot {
  label: string;
  providerKind: ChatProviderKind;
  scope: UserSkillScope;
  exists: boolean;
  visibleCount: number;
  hiddenInternalCount: number;
  malformedCount: number;
  unsafeSymlinkCount: number;
  lastError?: string;
}

export interface UserSkillDiagnostics {
  roots: UserSkillDiagnosticRoot[];
  visibleCount: number;
  hiddenInternalCount: number;
  malformedCount: number;
  unsafeSymlinkCount: number;
  providerCapabilities: Array<{
    providerKind: ChatProviderKind;
    capabilityState: UserSkillCapabilityState;
    runCondition: string;
    message?: string;
  }>;
  lastScanError?: string;
}

export type ChatRoleRuntime = "claude-agent" | "codex-developer-instructions" | "prompt-fallback";

export type ChatAppToolCapability = "participants.manage" | "participants.request" | "permissions.request";

export type ChatReactionActorKind = "user" | "participant";

export interface ChatReactor {
  actorId: string;
  actorLabel: string;
  actorKind: ChatReactionActorKind;
  at: string;
}

export type ChatMessageReactions = Record<string, ChatReactor[]>;

export interface ChatStaleRunRecovery {
  runId?: string;
  at: string;
}

export type AgentContextUsageSource = Extract<ProviderKind, "codex-cli" | "claude-code">;

export interface AgentContextUsage {
  usedTokens: number;
  contextWindowTokens: number;
  percentage: number;
  source: AgentContextUsageSource;
  updatedAt: string;
  model?: string;
}

export type ChatAgentMode = "default" | "plan" | "auto";

export type ChatReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ChatShellPermissionAction = "allow" | "ask" | "deny";

export type ChatShellPermissionMatch = "exact" | "prefix";

export interface ChatShellPermissionRule {
  action: ChatShellPermissionAction;
  pattern: string;
  match: ChatShellPermissionMatch;
}

export interface ChatAgentPermissions {
  repoRead: boolean;
  workspaceWrite: boolean;
  webAccess: boolean;
  shell: {
    enabled: boolean;
    rules: ChatShellPermissionRule[];
  };
  providerNative?: {
    "claude-code"?: {
      allowedTools: string[];
    };
  };
}

export interface ChatParticipant {
  id: string;
  participantConfigId?: string;
  handle: string;
  roleConfigId: string;
  roleConfigVersion?: number;
  behaviorRuleIds?: string[];
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  avatarId?: string;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
}

export interface ChatParticipantSession {
  participantId: string;
  sessionId: string;
  roleConfigId: string;
  roleConfigVersion: number;
  roleAppToolCapabilities?: ChatAppToolCapability[];
  roleRuntime?: ChatRoleRuntime;
  participantKind?: ChatProviderKind;
  participantModel?: string;
  participantReasoningEffort?: ChatReasoningEffort;
  participantBehaviorRules?: ChatBehaviorRuleSnapshot[];
  participantAgentMode?: ChatAgentMode;
  participantPermissions?: ChatAgentPermissions;
  runtimeConfigVersion?: number;
  appMcpClientGeneration?: number;
  roleLabel: string;
  roleInstructions: string;
  lastSyncedMessageId?: string;
  updatedAt: string;
}

export type ChatMentionApprovalStatus = "pending" | "approved" | "rejected";

export interface ChatPendingMention {
  targetParticipantId: string;
  targetHandle: string;
  status: ChatMentionApprovalStatus;
  approvedAt?: string;
}

export type ChatChoiceStatus = "pending" | "selected" | "cancelled";

export interface ChatChoiceOption {
  id: string;
  label: string;
  description?: string;
}

export interface ChatPendingChoice {
  id: string;
  title: string;
  question: string;
  options: ChatChoiceOption[];
  recommendedOptionId?: string;
  status: ChatChoiceStatus;
  selectedOptionId?: string;
  customAnswer?: string;
  note?: string;
  selectedAt?: string;
  cancelledAt?: string;
}

export type ChatRosterChangeOperationType = "add";

export interface ChatRosterChangeParticipantInput {
  participantConfigId?: string;
  handle: string;
  roleConfigId: string;
  behaviorRuleIds?: string[];
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  avatarId?: string;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
}

export interface ChatRosterChangeAddOperation {
  type: "add";
  participant: ChatRosterChangeParticipantInput;
}

export type ChatRosterChangeOperation = ChatRosterChangeAddOperation;

export interface ChatRosterChangeRequest {
  reason?: string;
  operations: ChatRosterChangeOperation[];
}

export interface ChatRoleCreateOperation {
  type: "create_role";
  role: {
    draftRoleRef?: string;
    label: string;
    instructions: string;
    appToolCapabilities?: ChatAppToolCapability[];
  };
}

export interface ChatRoleEditOperation {
  type: "edit_role";
  role: {
    roleConfigId: string;
    label: string;
    instructions: string;
    appToolCapabilities?: ChatAppToolCapability[];
  };
}

// UI label is "Delete role"; the operation soft-deletes (archives) the role so
// existing references stay resolvable. Custom roles only; built-ins are rejected.
export interface ChatRoleArchiveOperation {
  type: "archive_role";
  role: {
    roleConfigId: string;
  };
}

export type ChatRoleChangeOperation =
  | ChatRoleCreateOperation
  | ChatRoleEditOperation
  | ChatRoleArchiveOperation;

export interface ChatRoleChangeRequest {
  reason?: string;
  operations: ChatRoleChangeOperation[];
}

export interface ChatParticipantAddNewOperation {
  type: "add_new_participant_to_chat";
  participant: ChatRosterChangeParticipantInput;
  saveAsPreset?: boolean;
}

// Chat-level overrides applied to a saved participant when it is added to this chat.
// Their presence is authoritative (each field, including undefined, is the chat value);
// when absent the preset's own values are used. They never modify the saved preset.
export interface ChatExistingParticipantOverrides {
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
}

export interface ChatParticipantAddExistingOperation {
  type: "add_existing_participant_to_chat";
  participantConfigId: string;
  overrides?: ChatExistingParticipantOverrides;
}

export type ChatParticipantChangeOperation = ChatParticipantAddNewOperation | ChatParticipantAddExistingOperation;

export interface ChatParticipantChangeRequest {
  reason?: string;
  operations: ChatParticipantChangeOperation[];
}

export interface ChatRoleParticipantChangeRequest {
  kind: "role_participant_change";
  reason?: string;
  roleRequest: ChatRoleChangeRequest;
  participantRequest: ChatParticipantChangeRequest;
}

export type ChatPermissionGrant = "workspaceWrite" | "webAccess" | "repoRead";

export interface ChatPortablePermissionChangeRequest {
  kind: "portable";
  reason?: string;
  permissions: ChatPermissionGrant[];
}

export interface ChatShellRulesPermissionChangeRequest {
  kind: "shellRules";
  reason?: string;
  rules: ChatShellPermissionRule[];
}

export interface ChatProviderNativePermissionChangeRequest {
  kind: "providerNative";
  reason?: string;
  provider: "claude-code";
  allowedTools: string[];
}

export type ChatPermissionChangeRequest =
  | ChatPortablePermissionChangeRequest
  | ChatShellRulesPermissionChangeRequest
  | ChatProviderNativePermissionChangeRequest;

export interface ChatToolPermissionRequest {
  kind: "toolPermission";
  reason?: string;
  toolName: string;
  toolInput?: unknown;
}

export interface ChatParticipantRequestInput {
  target: string;
  prompt: string;
  reason?: string;
}

export interface ChatParticipantRequestApprovalRequest {
  reason?: string;
  requests: ChatParticipantRequestInput[];
  resumeRequester?: boolean;
  source?: ChatParticipantRequestSource;
  requestMessageId?: string;
  batchId?: string;
}

export type ChatParticipantRequestSource = "mcp" | "inferred";

export type ChatParticipantRequestStatus =
  | "pending_approval"
  | "running"
  | "answered"
  | "resuming_requester"
  | "completed"
  | "failed"
  | "denied"
  | "interrupted";

export interface ChatParticipantRequestItem {
  targetParticipantId: string;
  targetHandle: string;
  prompt: string;
  reason?: string;
  status: ChatParticipantRequestStatus;
  replyMessageId?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface ChatParticipantRequestBatch {
  id: string;
  requesterParticipantId: string;
  requesterHandle: string;
  source: ChatParticipantRequestSource;
  resumeRequester: boolean;
  status: ChatParticipantRequestStatus;
  depth: number;
  createdAt: string;
  updatedAt: string;
  triggerMessageId?: string;
  completedInToolCall?: boolean;
  autoResumeMessageId?: string;
  items: ChatParticipantRequestItem[];
  error?: string;
}

export interface ChatRosterAvailableRole {
  id: string;
  label: string;
  version: number;
  builtIn: boolean;
  appToolCapabilities: ChatAppToolCapability[];
}

export interface ChatRosterAvailableProvider {
  kind: ChatProviderKind;
  label: string;
  enabled: boolean;
  installed: boolean;
  selectedByDefault: boolean;
  configuredModel?: string;
  modelCatalog?: ProviderModelCatalog;
  reasoningEfforts?: ProviderReasoningEffortOption[];
  version?: string;
  error?: string;
}

export interface ChatRosterCurrentParticipant {
  id: string;
  participantConfigId?: string;
  handle: string;
  roleConfigId: string;
  roleLabel: string;
  behaviorRuleIds?: string[];
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  agentMode?: ChatAgentMode;
}

export interface ChatRosterAvailableOptions {
  conversationId: string;
  requester: ChatRosterCurrentParticipant & {
    appToolCapabilities: ChatAppToolCapability[];
  };
  currentParticipants: ChatRosterCurrentParticipant[];
  roles: ChatRosterAvailableRole[];
  providers: ChatRosterAvailableProvider[];
  agentModes: ChatAgentMode[];
  reasoningEfforts: ProviderReasoningEffortOption[];
  defaults: {
    kind: ChatProviderKind;
    agentMode: ChatAgentMode;
    reasoningEffort?: ChatReasoningEffort;
    permissions: ChatAgentPermissions;
  };
  handleRules: {
    pattern: string;
    maxLength: number;
    duplicatePolicy: string;
  };
  rosterChange: {
    supportedOperations: ChatRosterChangeOperationType[];
    maxOperations: number;
    modelPolicy: string;
    reasoningEffortPolicy: string;
  };
}

export type ChatAppToolApprovalStatus = "pending" | "approved" | "denied" | "auto-applied";

export type ChatAppToolApprovalScope = "once" | "chat";

export type ChatAppToolApprovalRequest =
  | ChatRosterChangeRequest
  | ChatRoleChangeRequest
  | ChatParticipantChangeRequest
  | ChatRoleParticipantChangeRequest
  | ChatPermissionChangeRequest
  | ChatToolPermissionRequest
  | ChatParticipantRequestApprovalRequest;

export interface ChatAppToolApproval {
  id: string;
  conversationId: string;
  requesterParticipantId: string;
  requesterHandle: string;
  requesterRoleConfigId: string;
  toolName: string;
  capability: ChatAppToolCapability;
  status: ChatAppToolApprovalStatus;
  request: ChatAppToolApprovalRequest;
  summary: string;
  createdAt: string;
  updatedAt: string;
  approvalScope?: ChatAppToolApprovalScope;
  appliedParticipantIds?: string[];
  resumeContext?: {
    runId: string;
    triggerMessageId: string;
    participantRequestBatchId?: string;
  };
  consumedAt?: string;
  error?: string;
}

export interface ChatAppToolApprovalPolicy {
  id: string;
  participantId: string;
  roleConfigId: string;
  toolName: string;
  capability: ChatAppToolCapability;
  targetParticipantId?: string;
  targetToolName?: string;
  scope: "chat";
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageMetadata {
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
  reactions?: ChatMessageReactions;
  staleRunRecovery?: ChatStaleRunRecovery;
  terminalReason?: "user-stopped";
  mentions?: string[];
  skillMentions?: ChatSkillMention[];
  repoFileMentions?: RepoFileMention[];
  imageAttachments?: ChatImageAttachment[];
  pendingMentions?: ChatPendingMention[];
  pendingChoice?: ChatPendingChoice;
  participantRequest?: ChatParticipantRequestBatch;
  hiddenFromTimeline?: boolean;
  sourceMessageId?: string;
  requesterParticipantId?: string;
  requesterContinuationRequested?: boolean;
  approvedContinuation?: boolean;
  syncedThroughMessageId?: string;
  runId?: string;
  workedMs?: number;
  queuedBehind?: { handle: string };
  appMessageSource?: string;
  accordResolution?: ChatAccordResolutionMetadata;
}

export interface ChatLastMessageByParticipantEntry {
  messageId: string;
  sequence: number;
  // ISO timestamp of the pointed message. This — not `sequence` — is the authoritative
  // recency key: the array index is window-relative under pagination and not comparable
  // across opens, so ordering by it froze pointers on stale messages.
  createdAt?: string;
  threadRootId?: string;
}

export type ChatLastMessageByParticipant = Record<string, ChatLastMessageByParticipantEntry>;

// Lightweight, optional metadata a facilitator can attach to a canonical /accord
// resolution message for verification/debugging. This is NOT an app-state decision
// engine — approval authority remains the `✅` reactor set on the canonical message.
export interface ChatAccordResolutionMetadata {
  version?: number;
  sourceMessageId?: string;
  selectedParticipantIds?: string[];
  requiredApproverIds?: string[];
  supersedesMessageId?: string;
  status?: string;
}

export interface ChatRoleConfigUpdate {
  id?: string;
  label: string;
  instructions: string;
  appToolCapabilities?: ChatAppToolCapability[];
}

export interface ChatBehaviorRuleConfigUpdate {
  id?: string;
  label: string;
  instructions: string;
}

export interface ChatParticipantConfig {
  id: string;
  handle: string;
  roleConfigId: string;
  behaviorRuleIds?: string[];
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  avatarId?: string;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
  updatedAt: string;
}

export interface ChatParticipantConfigUpdate {
  id?: string;
  handle: string;
  roleConfigId: string;
  behaviorRuleIds?: string[];
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  avatarId?: string;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
}

export interface ChatParticipantInput {
  participantConfigId?: string;
  handle: string;
  roleConfigId: string;
  behaviorRuleIds?: string[];
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  avatarId?: string;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
}

export interface CreateChatConversationRequest {
  title?: string;
  repoPath?: string;
  skipDefaultParticipants?: boolean;
  participants: ChatParticipantInput[];
}

export interface AddChatParticipantRequest {
  conversationId: string;
  participant: ChatParticipantInput;
}

export interface UpdateChatParticipantRuntimeRequest {
  conversationId: string;
  participantId: string;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
}

export interface RemoveChatParticipantRequest {
  conversationId: string;
  participantId: string;
}

export interface CompactChatParticipantRequest {
  conversationId: string;
  participantId?: string;
  handle?: string;
  instructions?: string;
  runId?: string;
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
}

export interface RenameChatConversationRequest {
  conversationId: string;
  title: string;
}

export interface SetChatArchivedRequest {
  conversationId: string;
  archived: boolean;
}

export interface DismissConversationWarningsRequest {
  conversationId: string;
  warnings: string[];
}

export interface SendChatMessageRequest {
  conversationId: string;
  runId?: string;
  content: string;
  skillMentions?: ChatSkillMention[];
  repoFileMentions?: RepoFileMention[];
  imageAttachments?: ChatImageInput[];
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
}

export interface ToggleChatReactionRequest {
  conversationId: string;
  messageId: string;
  emoji: string;
}

export type ChatImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface ChatImageInput {
  filename?: string;
  mimeType: string;
  dataBase64: string;
}

export interface ChatImageAttachment {
  id: string;
  filename: string;
  mimeType: ChatImageMimeType;
  sizeBytes: number;
  width: number;
  height: number;
  storageKey: string;
  createdAt: string;
}

export interface ReadChatAttachmentRequest {
  conversationId: string;
  attachmentId: string;
}

export interface ReadChatAttachmentResult {
  attachment: ChatImageAttachment;
  dataBase64: string;
}

export interface ExportChatAttachmentRequest {
  attachmentId: string;
  targetPath: string;
  overwrite?: boolean;
}

export interface ExportChatAttachmentResult {
  attachment: Omit<ChatImageAttachment, "storageKey">;
  targetPath: string;
  sizeBytes: number;
  overwrite: boolean;
}

export interface RespondToChatMentionsRequest {
  conversationId: string;
  sourceMessageId: string;
  targetParticipantIds: string[];
  approve: boolean;
  continueRequester?: boolean;
  runId?: string;
}

export interface RespondToChatChoiceRequest {
  conversationId: string;
  sourceMessageId: string;
  choiceId: string;
  cancel?: boolean;
  selectedOptionId?: string;
  customAnswer?: string;
  note?: string;
  runId?: string;
}

export interface RespondToChatAppToolApprovalRequest {
  conversationId: string;
  approvalId: string;
  approve: boolean;
  scope?: ChatAppToolApprovalScope;
  draftOverride?: ChatAppToolApprovalRequest;
}

export interface ProviderSettingsUpdate {
  kind: ProviderKind;
  enabled?: boolean;
  model?: string;
}

export type ProviderModelSource = "cli" | "provider-api" | "configured" | "builtin";

export interface ProviderReasoningEffortOption {
  id: ChatReasoningEffort;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ProviderModel {
  id: string;
  label: string;
  description?: string;
  createdAt?: string;
  source?: ProviderModelSource;
  recommended?: boolean;
  hidden?: boolean;
  supportedReasoningEfforts?: ProviderReasoningEffortOption[];
  defaultReasoningEffort?: ChatReasoningEffort;
}

export interface ProviderModelCatalog {
  kind: ProviderKind;
  models: ProviderModel[];
  authoritative: boolean;
  fetchedAt: string;
  error?: string;
}

export interface ParticipantConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
}

export type AppSkillSyncStatus = "not-installed" | "synced" | "skipped" | "collision" | "error";

export interface AppSkillSyncHealth {
  status: AppSkillSyncStatus;
  skillCount: number;
  updatedAt?: string;
  message?: string;
}

export interface AgentHealth {
  kind: Extract<ProviderKind, "codex-cli" | "claude-code">;
  label: string;
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
  appSkillSync?: AppSkillSyncHealth;
}

export interface GitRepoInfo {
  repoPath: string;
  isRepo: boolean;
  currentBranch?: string;
  branches: string[];
  statusLines: string[];
  error?: string;
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

export interface ReviewRequest {
  runId?: string;
  kind: ConversationKind;
  question: string;
  repoPath?: string;
  diffMode?: GitDiffMode;
  baseBranch?: string;
  compareBranch?: string;
  commit?: string;
  pastedDiff?: string;
  participants: ParticipantConfig[];
  arbiter?: ParticipantConfig;
  roundLimit: number;
}

export interface PlanDecisionOption {
  id: string;
  label: string;
  description?: string;
}

export interface PlanDecisionRequest {
  id: string;
  title: string;
  question: string;
  impact: string;
  options: PlanDecisionOption[];
  recommendedOptionId?: string;
  sourceParticipantIds: string[];
  sourceParticipantLabels: string[];
  createdAt: string;
}

export interface PlanDecisionAnswer {
  decisionId: string;
  decisionKey?: string;
  selectedOptionId?: string;
  answer: string;
  answerSource?: "user" | "automatic";
  sourceDecisionId?: string;
}

export interface PlanDecisionReply {
  id: string;
  decisionId: string;
  role: "user" | "participant" | "system";
  participantId?: string;
  participantLabel?: string;
  content: string;
  createdAt: string;
  status?: "done" | "error";
  answerSource?: "automatic";
  sourceDecisionId?: string;
}

export interface PlanItemReview {
  findingId: string;
  status: "confirmed" | "commented";
  comment?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanItemReviewRequest {
  conversationId: string;
  findingId: string;
  confirmed?: boolean;
  comment?: string;
}

export interface ComposeImplementationPlanRequest {
  conversationId: string;
  runId?: string;
}

export interface RetryImplementationPlanSynthesisRequest {
  conversationId: string;
  runId?: string;
}

export interface RecoverImplementationPlanRequest {
  conversationId: string;
  runId?: string;
}

export interface ReviseImplementationPlanRequest {
  conversationId: string;
  instruction: string;
  runId?: string;
}

export interface ContinueReviewRequest {
  conversationId: string;
  runId?: string;
  answers: PlanDecisionAnswer[];
}

export interface PlanDecisionClarificationRequest {
  conversationId: string;
  decisionId: string;
  question: string;
  runId?: string;
}

export interface ReviewProgress {
  runId: string;
  phase: "initial" | "extract" | "arbiter" | "decisions" | "debate" | "summary" | "done" | "cancelled" | "error";
  message: string;
  participantLabel?: string;
  agentProgress?: AgentRunProgress;
  findingTitle?: string;
  completed?: number;
  total?: number;
  createdAt: string;
}

export interface AgentRunProgress {
  participantId?: string;
  participantLabel: string;
  state: "running" | "finished";
  activity?: string;
  messageId?: string;
  partialContent?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "participant" | "system" | "summary";
  participantId?: string;
  participantLabel?: string;
  content: string;
  createdAt: string;
  status?: "pending" | "done" | "error";
  progressPhase?: ReviewProgress["phase"];
  metadata?: ChatMessageMetadata;
}

export interface DebateRound {
  id: string;
  roundIndex: number;
  participantId: string;
  participantLabel: string;
  stance: DebateStance;
  severity?: FindingSeverity;
  content: string;
  createdAt: string;
}

export interface FindingSourceItem {
  participantId: string;
  participantLabel: string;
  title: string;
  claim: string;
  evidence: string;
  action: string;
  rawContent?: string;
}

export interface Finding {
  id: string;
  title: string;
  description: string;
  sourceParticipantId: string;
  sourceParticipantLabel: string;
  sourceParticipantIds?: string[];
  sourceParticipantLabels?: string[];
  includedParticipantIds?: string[];
  missingParticipantIds?: string[];
  claim?: string;
  evidence?: string;
  action?: string;
  sourceItems?: FindingSourceItem[];
  severity: FindingSeverity;
  status: FindingStatus;
  rounds: DebateRound[];
  createdAt?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  kind: ConversationKind;
  createdAt: string;
  updatedAt: string;
  repoPath?: string;
  running?: boolean;
  archived?: boolean;
}

export type ConversationMetadata = Record<string, unknown> & {
  lastMessageByParticipant?: ChatLastMessageByParticipant;
};

export interface Conversation extends ConversationSummary {
  messages: ChatMessage[];
  findings: Finding[];
  finalSummary?: string;
  metadata: ConversationMetadata;
}

export interface ConversationMessagePageRequest {
  conversationId: string;
  beforeSequence?: number;
  aroundMessageId?: string;
  limit?: number;
}

export interface ConversationMessagePageInfo {
  oldestSequence?: number;
  newestSequence?: number;
  hasMoreBefore: boolean;
  totalMessages: number;
}

export interface ConversationMessagePage extends ConversationMessagePageInfo {
  messages: ChatMessage[];
}

export interface ConversationOpenResult {
  conversation: Conversation;
  messagePage: ConversationMessagePageInfo;
}

export type RepoFileOpenAction = "open" | "reveal";

export interface OpenRepoFileRequest {
  conversationId: string;
  path: string;
  line?: number;
  column?: number;
  action?: RepoFileOpenAction;
}

export interface OpenRepoFileResult {
  action: RepoFileOpenAction;
  path: string;
  line?: number;
  column?: number;
  lineNavigationSupported: boolean;
}

export interface StartReviewResult {
  conversation: Conversation;
  warnings: string[];
  pendingDecisions?: PlanDecisionRequest[];
}

export interface AppBridge {
  getAppVersion(): Promise<string>;
  openExternal(url: string): Promise<void>;
  openRepoFile(request: OpenRepoFileRequest): Promise<OpenRepoFileResult>;
  setRepoFileOpenPreference(action: RepoFileOpenAction | null): Promise<AppSettings>;
  setCliAgentRunTimeoutMs(timeoutMs: number): Promise<AppSettings>;
  getSettings(): Promise<AppSettings>;
  updateProviderSettings(update: ProviderSettingsUpdate): Promise<AppSettings>;
  saveChatRoleConfig(update: ChatRoleConfigUpdate): Promise<AppSettings>;
  archiveChatRoleConfig(id: string): Promise<AppSettings>;
  saveChatBehaviorRuleConfig(update: ChatBehaviorRuleConfigUpdate): Promise<AppSettings>;
  deleteChatBehaviorRuleConfig(id: string): Promise<AppSettings>;
  saveChatParticipantConfig(update: ChatParticipantConfigUpdate): Promise<AppSettings>;
  deleteChatParticipantConfig(id: string): Promise<AppSettings>;
  updateLastRepoPath(repoPath: string): Promise<AppSettings>;
  listProviderModels(kind: ProviderKind): Promise<ProviderModelCatalog>;
  detectAgents(): Promise<AgentHealth[]>;
  selectRepoDirectory(): Promise<string | undefined>;
  inspectRepo(repoPath: string): Promise<GitRepoInfo>;
  getDiff(request: GitDiffRequest): Promise<GitDiffResult>;
  searchRepoFiles(request: RepoFileSearchRequest): Promise<RepoFileSearchResult[]>;
  searchUserSkills(request: UserSkillSearchRequest): Promise<UserSkillSearchResult>;
  getUserSkillDiagnostics(request?: UserSkillDiagnosticsRequest): Promise<UserSkillDiagnostics>;
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | undefined>;
  openConversation(id: string, limit?: number): Promise<ConversationOpenResult | undefined>;
  listConversationMessages(request: ConversationMessagePageRequest): Promise<ConversationMessagePage>;
  saveDecisionSelections(conversationId: string, selections: Record<string, string>): Promise<Conversation | undefined>;
  saveDecisionResolutions(conversationId: string, resolutions: Record<string, boolean>): Promise<Conversation | undefined>;
  savePlanItemReview(request: PlanItemReviewRequest): Promise<Conversation | undefined>;
  createChatConversation(request: CreateChatConversationRequest): Promise<StartReviewResult>;
  renameChatConversation(request: RenameChatConversationRequest): Promise<Conversation | undefined>;
  setChatArchived(request: SetChatArchivedRequest): Promise<Conversation | undefined>;
  dismissConversationWarnings(request: DismissConversationWarningsRequest): Promise<Conversation | undefined>;
  addChatParticipant(request: AddChatParticipantRequest): Promise<Conversation | undefined>;
  updateChatParticipantRuntime(request: UpdateChatParticipantRuntimeRequest): Promise<Conversation | undefined>;
  removeChatParticipant(request: RemoveChatParticipantRequest): Promise<Conversation | undefined>;
  compactChatParticipant(request: CompactChatParticipantRequest): Promise<StartReviewResult>;
  sendChatMessage(request: SendChatMessageRequest): Promise<StartReviewResult>;
  readChatAttachment(request: ReadChatAttachmentRequest): Promise<ReadChatAttachmentResult>;
  toggleChatReaction(request: ToggleChatReactionRequest): Promise<Conversation | undefined>;
  respondToChatMentions(request: RespondToChatMentionsRequest): Promise<StartReviewResult>;
  respondToChatChoice(request: RespondToChatChoiceRequest): Promise<StartReviewResult>;
  respondToChatAppToolApproval(request: RespondToChatAppToolApprovalRequest): Promise<Conversation | undefined>;
  startReview(request: ReviewRequest): Promise<StartReviewResult>;
  continueReview(request: ContinueReviewRequest): Promise<StartReviewResult>;
  askPlanDecisionClarification(request: PlanDecisionClarificationRequest): Promise<StartReviewResult>;
  composeImplementationPlan(request: ComposeImplementationPlanRequest): Promise<StartReviewResult>;
  retryImplementationPlanSynthesis(request: RetryImplementationPlanSynthesisRequest): Promise<StartReviewResult>;
  recoverImplementationPlan(request: RecoverImplementationPlanRequest): Promise<StartReviewResult>;
  reviseImplementationPlan(request: ReviseImplementationPlanRequest): Promise<StartReviewResult>;
  cancelReview(runId: string): Promise<void>;
  onReviewProgress(callback: (progress: ReviewProgress) => void): () => void;
  onConversationUpdated(callback: (conversation: Conversation) => void): () => void;
}
