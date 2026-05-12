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
  hasApiKey?: boolean;
}

export interface AppSettings {
  roundLimitDefault: number;
  providers: ProviderSettings[];
  chatRoleConfigs: ChatRoleConfig[];
  chatParticipantConfigs: ChatParticipantConfig[];
  lastRepoPath?: string;
}

export interface ChatRoleConfig {
  id: string;
  label: string;
  instructions: string;
  version: number;
  builtIn?: boolean;
  updatedAt: string;
}

export type ChatProviderKind = Extract<ProviderKind, "codex-cli" | "claude-code">;

export type ChatRoleRuntime = "claude-agent" | "codex-developer-instructions" | "prompt-fallback";

export interface ChatParticipant {
  id: string;
  handle: string;
  roleConfigId: string;
  roleConfigVersion?: number;
  kind: ChatProviderKind;
  model?: string;
  avatarId?: string;
}

export interface ChatParticipantSession {
  participantId: string;
  sessionId: string;
  roleConfigId: string;
  roleConfigVersion: number;
  roleRuntime?: ChatRoleRuntime;
  participantKind?: ChatProviderKind;
  participantModel?: string;
  runtimeConfigVersion?: number;
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

export interface ChatMessageMetadata {
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
  mentions?: string[];
  pendingMentions?: ChatPendingMention[];
  sourceMessageId?: string;
  requesterParticipantId?: string;
  requesterContinuationRequested?: boolean;
  approvedContinuation?: boolean;
  syncedThroughMessageId?: string;
}

export interface ChatRoleConfigUpdate {
  id?: string;
  label: string;
  instructions: string;
}

export interface ChatParticipantConfig {
  id: string;
  handle: string;
  roleConfigId: string;
  kind: ChatProviderKind;
  model?: string;
  avatarId?: string;
  updatedAt: string;
}

export interface ChatParticipantConfigUpdate {
  id?: string;
  handle: string;
  roleConfigId: string;
  kind: ChatProviderKind;
  model?: string;
  avatarId?: string;
}

export interface CreateChatConversationRequest {
  title?: string;
  repoPath?: string;
  participants: Array<{
    handle: string;
    roleConfigId: string;
    kind: ChatProviderKind;
    model?: string;
    avatarId?: string;
  }>;
}

export interface AddChatParticipantRequest {
  conversationId: string;
  participant: {
    handle: string;
    roleConfigId: string;
    kind: ChatProviderKind;
    model?: string;
    avatarId?: string;
  };
}

export interface SendChatMessageRequest {
  conversationId: string;
  runId?: string;
  content: string;
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
}

export interface RespondToChatMentionsRequest {
  conversationId: string;
  sourceMessageId: string;
  targetParticipantIds: string[];
  approve: boolean;
  continueRequester?: boolean;
  runId?: string;
}

export interface ProviderSettingsUpdate {
  kind: ProviderKind;
  enabled?: boolean;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface ProviderModel {
  id: string;
  label: string;
  description?: string;
  createdAt?: string;
}

export interface ParticipantConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  model?: string;
}

export interface AgentHealth {
  kind: Extract<ProviderKind, "codex-cli" | "claude-code">;
  label: string;
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
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
}

export interface Conversation extends ConversationSummary {
  messages: ChatMessage[];
  findings: Finding[];
  finalSummary?: string;
  metadata: Record<string, unknown>;
}

export interface StartReviewResult {
  conversation: Conversation;
  warnings: string[];
  pendingDecisions?: PlanDecisionRequest[];
}

export interface AppBridge {
  getSettings(): Promise<AppSettings>;
  updateProviderSettings(update: ProviderSettingsUpdate): Promise<AppSettings>;
  saveChatRoleConfig(update: ChatRoleConfigUpdate): Promise<AppSettings>;
  saveChatParticipantConfig(update: ChatParticipantConfigUpdate): Promise<AppSettings>;
  deleteChatParticipantConfig(id: string): Promise<AppSettings>;
  updateLastRepoPath(repoPath: string): Promise<AppSettings>;
  listProviderModels(kind: ProviderKind): Promise<ProviderModel[]>;
  detectAgents(): Promise<AgentHealth[]>;
  selectRepoDirectory(): Promise<string | undefined>;
  inspectRepo(repoPath: string): Promise<GitRepoInfo>;
  getDiff(request: GitDiffRequest): Promise<GitDiffResult>;
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | undefined>;
  saveDecisionSelections(conversationId: string, selections: Record<string, string>): Promise<Conversation | undefined>;
  saveDecisionResolutions(conversationId: string, resolutions: Record<string, boolean>): Promise<Conversation | undefined>;
  savePlanItemReview(request: PlanItemReviewRequest): Promise<Conversation | undefined>;
  createChatConversation(request: CreateChatConversationRequest): Promise<StartReviewResult>;
  addChatParticipant(request: AddChatParticipantRequest): Promise<Conversation | undefined>;
  sendChatMessage(request: SendChatMessageRequest): Promise<StartReviewResult>;
  respondToChatMentions(request: RespondToChatMentionsRequest): Promise<StartReviewResult>;
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
