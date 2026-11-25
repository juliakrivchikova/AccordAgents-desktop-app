import type { ChatParticipantInput } from "./members";
import type { ChatProviderKind } from "./providers";

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
  assistantProviderKind?: ChatProviderKind;
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
  assistantProviderKind?: ChatProviderKind;
  query?: string;
  content?: string;
  limit?: number;
}

export interface PluginListResult {
  plugins: PluginCatalogItem[];
  diagnostics: PluginListDiagnostics;
}

export type AppSkillSyncStatus = "not-installed" | "synced" | "skipped" | "collision" | "error";

export interface AppSkillSyncHealth {
  status: AppSkillSyncStatus;
  skillCount: number;
  updatedAt?: string;
  message?: string;
}
