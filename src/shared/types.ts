export type ProviderKind = "openai" | "anthropic" | "gemini" | "codex-cli" | "claude-code";

export type ConversationKind = "general" | "code-review";

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

export interface ReviewProgress {
  runId: string;
  phase: "initial" | "extract" | "arbiter" | "debate" | "summary" | "done" | "cancelled" | "error";
  message: string;
  participantLabel?: string;
  findingTitle?: string;
  completed?: number;
  total?: number;
  createdAt: string;
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
}

export interface AppBridge {
  getSettings(): Promise<AppSettings>;
  updateProviderSettings(update: ProviderSettingsUpdate): Promise<AppSettings>;
  listProviderModels(kind: ProviderKind): Promise<ProviderModel[]>;
  detectAgents(): Promise<AgentHealth[]>;
  selectRepoDirectory(): Promise<string | undefined>;
  inspectRepo(repoPath: string): Promise<GitRepoInfo>;
  getDiff(request: GitDiffRequest): Promise<GitDiffResult>;
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | undefined>;
  startReview(request: ReviewRequest): Promise<StartReviewResult>;
  cancelReview(runId: string): Promise<void>;
  onReviewProgress(callback: (progress: ReviewProgress) => void): () => void;
}
