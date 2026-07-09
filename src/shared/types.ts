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

export type CloudRunRemoteExecutionMode = "inherit" | "local" | "remote";

export type CloudRunStatus = "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface CloudRunWorkerSettings {
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  workerRoot?: string;
  remoteCwd?: string;
  codexPath?: string;
}

export type CloudRunWorkerMode = "ssh" | "aws";

export interface AwsWorkerHandleInfo {
  instanceId: string;
  securityGroupId: string;
  keyName: string;
  region: string;
  instanceType: string;
  rootVolumeSizeGb?: number;
  createdAt: string;
}

export interface CloudRunsSettings {
  enabled: boolean;
  mode: CloudRunWorkerMode;
  worker: CloudRunWorkerSettings;
  // AWS-managed worker: credentials are stored encrypted and never returned to
  // the renderer; only hasAwsCredentials + the non-sensitive handle are exposed.
  hasAwsCredentials: boolean;
  awsHandle?: AwsWorkerHandleInfo;
  awsRegion?: string;
  awsRootVolumeSizeGb: number;
  maxRuntimeMs: number;
  pollIntervalMs: number;
}

export interface CloudRunsSettingsUpdate {
  enabled?: boolean;
  mode?: CloudRunWorkerMode;
  worker?: CloudRunWorkerSettings;
  awsRootVolumeSizeGb?: number;
  maxRuntimeMs?: number;
  pollIntervalMs?: number;
}

export type AgentEnvironmentKeySource = "forwarded" | "manual";

export type AgentEnvironmentValueProtection = "os-encrypted" | "local-obfuscated";

export interface ManualAgentEnvironmentVariable {
  key: string;
  enabled: boolean;
  updatedAt: string;
  protection: AgentEnvironmentValueProtection;
  overridesDetected: boolean;
  hasValue: boolean;
}

export interface AgentEnvironmentKey {
  key: string;
  source: AgentEnvironmentKeySource;
  manual: boolean;
  overridesDetected: boolean;
}

export interface AgentEnvironmentSnapshot {
  refreshedAt: string;
  keys: AgentEnvironmentKey[];
  manualVariables: ManualAgentEnvironmentVariable[];
  forwardedCount: number;
  manualEnabledCount: number;
  localInheritanceDisclosure: string;
  valueProtection: AgentEnvironmentValueProtection;
}

export interface SaveAgentEnvironmentVariableRequest {
  key: string;
  value?: string;
  enabled?: boolean;
}

export interface DeleteAgentEnvironmentVariableRequest {
  key: string;
}

export type AwsWorkerLifecycleState =
  | "absent"
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "terminated";

export interface AwsWorkerStatus {
  configured: boolean;
  handle?: AwsWorkerHandleInfo;
  state?: AwsWorkerLifecycleState;
  publicIp?: string;
  message?: string;
}

export interface ConnectAwsWorkerRequest {
  blob: string;
  instanceType?: string;
  rootVolumeSizeGb?: number;
}

export interface CloudRunWorkerTestResult {
  ok: boolean;
  message: string;
}

export type CloudRunWorkerCheckId =
  | "connect"
  | "sudo"
  | "rsync"
  | "git"
  | "gh"
  | "java"
  | "node"
  | "build-essential"
  | "codex"
  | "codex-auth"
  | "git-identity"
  | "userns";

export type CloudRunWorkerCheckStatus = "pass" | "warn" | "fail";

export interface CloudRunWorkerCheck {
  id: CloudRunWorkerCheckId;
  label: string;
  status: CloudRunWorkerCheckStatus;
  detail?: string;
  // True when "Set up worker" knows how to repair this check automatically.
  fixable?: boolean;
}

export interface CloudRunWorkerDoctorReport {
  ok: boolean;
  message: string;
  checks: CloudRunWorkerCheck[];
}

export interface CloudRunWorkerSetupProgress {
  stage: string;
  message: string;
  // Present while the codex device-auth fix waits for the user to approve the
  // sign-in in their browser.
  authUrl?: string;
  authCode?: string;
}

export interface RemoteRunSyncInfo {
  localPath: string;
  remotePath?: string;
}

export interface RemoteRunHandle {
  runId: string;
  conversationId: string;
  participantId: string;
  participantHandle?: string;
  worker: CloudRunWorkerSettings;
  status: CloudRunStatus;
  workerCursorSeq?: number;
  providerOutputMessageId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  lastPolledAt?: string;
  error?: string;
  sync?: RemoteRunSyncInfo;
  promptContextPointerAdvance?: ChatPromptContextPointerAdvance;
}

export type ChatPromptContextMode = "off" | "all_unseen" | "latest_unseen";

export interface ChatPromptContextScopeSettings {
  mode: ChatPromptContextMode;
  limit?: number;
}

export interface ChatPromptContextSettings {
  thread: ChatPromptContextScopeSettings;
  timeline: ChatPromptContextScopeSettings;
}

export interface AppSettings {
  roundLimitDefault: number;
  cliAgentRunTimeoutMs: number;
  chatParticipantRequestMaxDepth: number;
  chatParticipantRequestPromptMaxChars: number;
  chatAutoWatchWakeLimit: number;
  chatPromptContext: ChatPromptContextSettings;
  cloudRuns: CloudRunsSettings;
  providers: ProviderSettings[];
  chatRoleConfigs: ChatRoleConfig[];
  chatBehaviorRules: ChatBehaviorRuleConfig[];
  chatSavedPrompts: ChatSavedPromptConfig[];
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
  participantDefaults?: ChatRoleParticipantDefaults;
  updatedAt: string;
  // Soft-delete marker. Archived custom roles stay in settings so existing
  // participants keep resolving, but are hidden from the Roles list and pickers.
  archivedAt?: string;
}

export interface ChatRoleParticipantDefaults {
  autoWatch?: boolean;
  requestParticipants?: ChatParticipantRequestPermission;
  manageRolesParticipants?: ChatParticipantRequestPermission;
}

export interface ChatManageRolesParticipantsResolution {
  roleDefault: ChatParticipantRequestPermission;
  participantExplicit?: ChatParticipantRequestPermission;
  effective: ChatParticipantRequestPermission;
  exceedsRoleDefault: boolean;
}

export interface ChatBehaviorRuleConfig {
  id: string;
  label: string;
  instructions: string;
  version: number;
  updatedAt: string;
}

export interface ChatSavedPromptConfig {
  id: string;
  label: string;
  trigger: string;
  body: string;
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

export interface UserSkillListRequest {
  repoPath?: string;
  query?: string;
  limit?: number;
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

export interface UserSkillListResult {
  skills: UserSkillSummary[];
  diagnostics: UserSkillDiagnostics;
}

export type PluginSourceScope = "personal" | "workspace" | "bundled";

export type PluginInvocationKind = "skill-mention" | "prompt-insert" | "mcp-passive";

export type PluginProviderStatus = "invocable" | "available" | "needs-setup" | "unsupported" | "malformed";

export interface PluginInstallRecord {
  providerKind: ChatProviderKind;
  key: string;
  enabled: boolean;
  sourceLabel: string;
  scope?: string;
  version?: string;
  installedAt?: string;
  installPath?: string;
}

export interface PluginProviderAvailability {
  providerKind: ChatProviderKind;
  status: PluginProviderStatus;
  capabilityState: UserSkillCapabilityState;
  message?: string;
}

export type PluginInvocationDescriptor =
  | {
      kind: "skill-mention";
      skill: UserSkillSummary;
    }
  | {
      kind: "prompt-insert";
      prompt: string;
    }
  | {
      kind: "mcp-passive";
    };

export interface PluginCatalogItem {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  category?: string;
  iconUrl?: string;
  brandColor?: string;
  providerKind: ChatProviderKind;
  sourceScope: PluginSourceScope;
  sourceLabel: string;
  manifestPath?: string;
  pluginPath?: string;
  installRecords: PluginInstallRecord[];
  installedProviderKinds: ChatProviderKind[];
  invocation: PluginInvocationDescriptor;
  providerAvailability: PluginProviderAvailability[];
  statusMessage?: string;
}

export interface PluginListDiagnostics {
  checkedSources: string[];
  errors: string[];
  updatedAt: string;
}

export interface PluginListRequest {
  conversationId?: string;
  repoPath?: string;
  participants?: ChatParticipantInput[];
  query?: string;
  content?: string;
  limit?: number;
}

export interface PluginListResult {
  plugins: PluginCatalogItem[];
  diagnostics: PluginListDiagnostics;
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

export type ChatParticipantRequestPermission = "ask" | "allow" | "deny";

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
  requestParticipants: ChatParticipantRequestPermission;
  manageRolesParticipants?: ChatParticipantRequestPermission;
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
  remoteExecution?: CloudRunRemoteExecutionMode;
  skipToolchainPreflight?: boolean;
  autoWatch?: boolean;
}

export interface ChatParticipantSession {
  participantId: string;
  sessionId: string;
  roleConfigId: string;
  roleConfigVersion: number;
  roleAppToolCapabilities?: ChatAppToolCapability[];
  roleParticipantDefaults?: ChatRoleParticipantDefaults;
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
  remoteExecution?: CloudRunRemoteExecutionMode;
  skipToolchainPreflight?: boolean;
  autoWatch?: boolean;
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
    participantDefaults?: ChatRoleParticipantDefaults;
  };
}

export interface ChatRoleEditOperation {
  type: "edit_role";
  role: {
    roleConfigId: string;
    label: string;
    instructions: string;
    appToolCapabilities?: ChatAppToolCapability[];
    participantDefaults?: ChatRoleParticipantDefaults;
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
  remoteExecution?: CloudRunRemoteExecutionMode;
  skipToolchainPreflight?: boolean;
  autoWatch?: boolean;
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

export interface ChatGitHubAppPermissionChangeRequest {
  kind: "githubApp";
  reason?: string;
  repository_full_name: string;
  permissions: string[];
}

export type ChatPermissionChangeRequest =
  | ChatPortablePermissionChangeRequest
  | ChatShellRulesPermissionChangeRequest
  | ChatProviderNativePermissionChangeRequest
  | ChatGitHubAppPermissionChangeRequest;

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
  requesterDepth?: number;
  chainRootId?: string;
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
  permissions?: ChatAgentPermissions;
  manageRolesParticipants?: ChatManageRolesParticipantsResolution;
  remoteExecution?: CloudRunRemoteExecutionMode;
  skipToolchainPreflight?: boolean;
  autoWatch?: boolean;
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

export type ChatPermissionRequestToolStatus =
  | "pending_user_approval"
  | "approved"
  | "denied"
  | "already_granted"
  | "not_found";

export interface ChatPermissionRequestToolResult {
  ok: boolean;
  status: ChatPermissionRequestToolStatus;
  requestId?: string;
  approvalId?: string;
  summary?: string;
  request?: ChatPermissionChangeRequest;
  approvalScope?: ChatAppToolApprovalScope;
  updatedAt?: string;
  error?: string;
}

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
    remoteRun?: boolean;
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
  activityEvents?: ChatAgentActivityEvent[];
  processingTranscript?: ChatProcessingTranscript;
  remoteRunStatus?: ChatRemoteRunStatus;
  accordResolution?: ChatAccordResolutionMetadata;
  autoWatchTrigger?: {
    participantId: string;
    reason: string;
    messageIds: string[];
  };
}

export type ChatRemoteRunPhase =
  | "preparing-worker"
  | "syncing-files"
  | "launching-session"
  | "waiting-for-response"
  | "processing-request"
  | "waiting-for-approval"
  | "terminal";

export interface ChatRemoteRunStatus {
  phase: ChatRemoteRunPhase;
  label: string;
  detail?: string;
  startedAt: string;
  updatedAt: string;
  processingStartedAt?: string;
}

export type ChatAgentActivityKind = "tool" | "command" | "file-edit" | "web" | "approval" | "status";

export interface ChatAgentActivityEvent {
  id: string;
  sequence: number;
  kind: ChatAgentActivityKind;
  label: string;
  detail?: string;
  createdAt: string;
  status?: "started" | "completed" | "failed";
  afterContentLength?: number;
}

export interface ChatProcessingTranscript {
  content: string;
  capturedAt: string;
  originalLength: number;
  retainedStart?: number;
  truncated?: boolean;
  omittedActivityEventCount?: number;
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

export interface ChatPromptContextPointerEntry {
  messageId: string;
  sequence: number;
  createdAt?: string;
}

export type ChatPromptContextPointerScope =
  | { type: "timeline" }
  | { type: "thread"; threadRootId: string };

export interface ChatPromptContextPointerAdvance {
  scope: ChatPromptContextPointerScope;
  entry: ChatPromptContextPointerEntry;
}

export interface ChatPromptContextParticipantPointers {
  timeline?: ChatPromptContextPointerEntry;
  threads?: Record<string, ChatPromptContextPointerEntry>;
}

export type ChatPromptContextPointers = Record<string, ChatPromptContextParticipantPointers>;

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
  participantDefaults?: ChatRoleParticipantDefaults;
}

export interface ChatBehaviorRuleConfigUpdate {
  id?: string;
  label: string;
  instructions: string;
}

export interface ChatSavedPromptConfigUpdate {
  id?: string;
  label: string;
  trigger: string;
  body: string;
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
  remoteExecution?: CloudRunRemoteExecutionMode;
  skipToolchainPreflight?: boolean;
  autoWatchEnabled?: boolean;
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
  remoteExecution?: CloudRunRemoteExecutionMode;
  skipToolchainPreflight?: boolean;
  autoWatchEnabled?: boolean;
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
  remoteExecution?: CloudRunRemoteExecutionMode;
  skipToolchainPreflight?: boolean;
  autoWatch?: boolean;
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
  remoteExecution?: CloudRunRemoteExecutionMode;
  skipToolchainPreflight?: boolean;
  autoWatch?: boolean;
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

export interface StartChatAccordRequest {
  conversationId: string;
  facilitatorParticipantId: string;
  targetParticipantIds: string[];
  subject: string;
}

export interface StartChatAccordResult {
  runId: string;
  sourceMessageId: string;
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
  activityEvents?: ChatAgentActivityEvent[];
  messageId?: string;
  partialContent?: string;
  remoteRunStatus?: ChatRemoteRunStatus;
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
  chatParticipants?: ConversationSummaryChatParticipant[];
}

export interface ConversationSummaryChatParticipant {
  participantConfigId?: string;
  handle: string;
  kind: ChatProviderKind;
}

export interface ChatParticipantCompactionState {
  runId: string;
  startedAt: string;
}

export type ChatParticipantWatcherPausedReason = "wake-limit" | "error";

export interface ChatParticipantWatcherState {
  lastSeenMessageId?: string;
  lastRunId?: string;
  lastTriggeredAt?: string;
  wakeChainDepth: number;
  pausedReason?: ChatParticipantWatcherPausedReason;
  updatedAt: string;
}

export type ConversationMetadata = Record<string, unknown> & {
  activeRunParticipantIdsByRunId?: Record<string, string>;
  lastMessageByParticipant?: ChatLastMessageByParticipant;
  participantCompactionsByParticipantId?: Record<string, ChatParticipantCompactionState>;
  promptContextPointers?: ChatPromptContextPointers;
  participantWatchers?: Record<string, ChatParticipantWatcherState>;
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

export type ChatActivityStatus = "pending" | "running" | "recent";

export type ChatActivityKind =
  | "approval"
  | "choice"
  | "mention"
  | "participant-request"
  | "run"
  | "message";

export interface ChatActivityParticipantSummary {
  id: string;
  handle: string;
  kind: ChatProviderKind;
  roleConfigId?: string;
  avatarId?: string;
}

export interface ChatActivityTarget {
  runId?: string;
  messageId?: string;
  threadRootId?: string;
  approvalId?: string;
}

export interface ChatActivityItem {
  id: string;
  conversationId: string;
  conversationTitle: string;
  repoPath?: string;
  status: ChatActivityStatus;
  read?: boolean;
  kind: ChatActivityKind;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  participant?: ChatActivityParticipantSummary;
  target: ChatActivityTarget;
}

export interface ListChatActivityRequest {
  limit?: number;
  recentConversationLimit?: number;
  recentWindowDays?: number;
  lastViewedAtByConversationId?: Record<string, string>;
}

export interface ListChatActivityResult {
  items: ChatActivityItem[];
  generatedAt: string;
}

export type RepoFileOpenAction = "open" | "reveal" | "intellij-idea";
export type LocalFileOpenAction = RepoFileOpenAction;

export interface InspectLocalFileRequest {
  conversationId: string;
  path: string;
  line?: number;
  column?: number;
}

export interface InspectLocalFileResult {
  path: string;
  absolutePath: string;
  insideWorkspace: boolean;
  line?: number;
  column?: number;
}

export interface OpenLocalFileRequest {
  conversationId: string;
  path: string;
  line?: number;
  column?: number;
  action?: LocalFileOpenAction;
}

export interface OpenLocalFileResult {
  action: LocalFileOpenAction;
  path: string;
  absolutePath: string;
  insideWorkspace: boolean;
  line?: number;
  column?: number;
  fallbackMessage?: string;
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
  inspectLocalFile(request: InspectLocalFileRequest): Promise<InspectLocalFileResult>;
  openLocalFile(request: OpenLocalFileRequest): Promise<OpenLocalFileResult>;
  setRepoFileOpenPreference(action: RepoFileOpenAction | null): Promise<AppSettings>;
  setCliAgentRunTimeoutMs(timeoutMs: number): Promise<AppSettings>;
  setChatParticipantRequestMaxDepth(maxDepth: number): Promise<AppSettings>;
  setChatParticipantRequestPromptMaxChars(maxChars: number): Promise<AppSettings>;
  setChatAutoWatchWakeLimit(limit: number): Promise<AppSettings>;
  setChatPromptContext(settings: ChatPromptContextSettings): Promise<AppSettings>;
  saveCloudRunsSettings(update: CloudRunsSettingsUpdate): Promise<AppSettings>;
  testCloudRunWorker(request?: CloudRunWorkerSettings): Promise<CloudRunWorkerTestResult>;
  diagnoseCloudRunWorker(request?: CloudRunWorkerSettings): Promise<CloudRunWorkerDoctorReport>;
  setupCloudRunWorker(request?: CloudRunWorkerSettings): Promise<CloudRunWorkerDoctorReport>;
  onCloudRunSetupProgress(callback: (progress: CloudRunWorkerSetupProgress) => void): () => void;
  getAwsWorkerBootstrapCommand(region: string): Promise<string>;
  connectAwsWorker(request: ConnectAwsWorkerRequest): Promise<AwsWorkerStatus>;
  getAwsWorkerStatus(): Promise<AwsWorkerStatus>;
  stopAwsWorker(): Promise<AwsWorkerStatus>;
  deleteAwsWorker(): Promise<AwsWorkerStatus>;
  getAgentEnvironment(): Promise<AgentEnvironmentSnapshot>;
  saveAgentEnvironmentVariable(request: SaveAgentEnvironmentVariableRequest): Promise<AgentEnvironmentSnapshot>;
  deleteAgentEnvironmentVariable(request: DeleteAgentEnvironmentVariableRequest): Promise<AgentEnvironmentSnapshot>;
  getSettings(): Promise<AppSettings>;
  updateProviderSettings(update: ProviderSettingsUpdate): Promise<AppSettings>;
  saveChatRoleConfig(update: ChatRoleConfigUpdate): Promise<AppSettings>;
  archiveChatRoleConfig(id: string): Promise<AppSettings>;
  saveChatBehaviorRuleConfig(update: ChatBehaviorRuleConfigUpdate): Promise<AppSettings>;
  deleteChatBehaviorRuleConfig(id: string): Promise<AppSettings>;
  saveChatSavedPromptConfig(update: ChatSavedPromptConfigUpdate): Promise<AppSettings>;
  deleteChatSavedPromptConfig(id: string): Promise<AppSettings>;
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
  listUserSkills(request?: UserSkillListRequest): Promise<UserSkillListResult>;
  listPlugins(request?: PluginListRequest): Promise<PluginListResult>;
  refreshPlugins(request?: PluginListRequest): Promise<PluginListResult>;
  listConversations(): Promise<ConversationSummary[]>;
  listChatActivity(request?: ListChatActivityRequest): Promise<ListChatActivityResult>;
  getConversation(id: string): Promise<Conversation | undefined>;
  openConversation(id: string, limit?: number): Promise<ConversationOpenResult | undefined>;
  listConversationMessages(request: ConversationMessagePageRequest): Promise<ConversationMessagePage>;
  saveDecisionSelections(conversationId: string, selections: Record<string, string>): Promise<Conversation | undefined>;
  saveDecisionResolutions(conversationId: string, resolutions: Record<string, boolean>): Promise<Conversation | undefined>;
  savePlanItemReview(request: PlanItemReviewRequest): Promise<Conversation | undefined>;
  createChatConversation(request: CreateChatConversationRequest): Promise<StartReviewResult>;
  renameChatConversation(request: RenameChatConversationRequest): Promise<Conversation | undefined>;
  setChatArchived(request: SetChatArchivedRequest): Promise<Conversation | undefined>;
  startChatAccord(request: StartChatAccordRequest): Promise<StartChatAccordResult>;
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
