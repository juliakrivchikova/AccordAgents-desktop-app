import type { CloudRunRemoteExecutionMode } from "./cloudRuns";
import type {
  ChatAgentMode, ChatAgentPermissions, ChatAppToolCapability, ChatParticipantRequestPermission, ChatReasoningEffort
} from "./members";
import type { ChatProviderKind } from "./providers";

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
  requestCompaction?: ChatParticipantRequestPermission;
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

export type ChatRoleRuntime = "claude-agent" | "codex-developer-instructions" | "prompt-fallback";

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
  hostId?: string;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
  remoteExecution?: CloudRunRemoteExecutionMode;
  /** Machine that hosts this participant's sessions (machines transport).
   *  Absent = this desktop unless a Cloud choice is awaiting preparation. */
  homeMachineId?: string;
  /** Cloud choice is saved before the machine is ready. */
  cloudRun?: import("../cloudRunPreparation").CloudRunSelection;
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
  hostId?: string;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
  remoteExecution?: CloudRunRemoteExecutionMode;
  homeMachineId?: string;
  /** Cloud choice is saved before the machine is ready. */
  cloudRun?: import("../cloudRunPreparation").CloudRunSelection;
  skipToolchainPreflight?: boolean;
  autoWatchEnabled?: boolean;
}
