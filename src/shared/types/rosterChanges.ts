import type { AgentReadinessDiagnosticCode, AgentReadinessState } from "./agents";
import type { CloudRunRemoteExecutionMode } from "./cloudRuns";
import type { ChatAgentMode, ChatAgentPermissions, ChatAppToolCapability, ChatReasoningEffort } from "./members";
import type { ChatProviderKind, ProviderModelCatalog, ProviderReasoningEffortOption } from "./providers";
import type { ChatManageRolesParticipantsResolution, ChatRoleParticipantDefaults } from "./roles";

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
  hostId?: string;
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

// A member asks to take another member out of the chat. The app resolves the
// target when the request is made; the stored handle is for display only.
export interface ChatParticipantRemoveOperation {
  type: "remove_participant_from_chat";
  participantId: string;
  handle: string;
}

// Decided by the asking member's Manage members setting, like an addition:
// allow records it as auto-applied, ask puts it on a card for the User. Once
// decided it is applied when the chat has no live work (see
// ChatAppToolApproval.memberRemovalQueuedAt).
export interface ChatParticipantRemovalRequest {
  kind: "participant_removal";
  reason?: string;
  operations: ChatParticipantRemoveOperation[];
}

export interface ChatRoleParticipantChangeRequest {
  kind: "role_participant_change";
  reason?: string;
  roleRequest: ChatRoleChangeRequest;
  participantRequest: ChatParticipantChangeRequest;
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
  readiness: AgentReadinessState;
  diagnosticCode?: AgentReadinessDiagnosticCode;
}

export interface ChatRosterCurrentParticipant {
  id: string;
  participantConfigId?: string;
  handle: string;
  roleConfigId: string;
  roleLabel: string;
  behaviorRuleIds?: string[];
  kind: ChatProviderKind;
  hostId?: string;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
  manageRolesParticipants?: ChatManageRolesParticipantsResolution;
  remoteExecution?: CloudRunRemoteExecutionMode;
  homeMachineId?: string;
  /** Cloud choice is saved before the machine is ready. */
  cloudRun?: import("../cloudRunPreparation").CloudRunSelection;
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
  /** The providers this chat gives tasks to with app_chat_delegate_task (its side
   *  panel's Agents): every CLI ready where its members run, less those User
   *  took out of this chat, with the model and effort its new members run on.
   *  Absent in a chat without a main session. */
  chatSubagents?: Array<{ kind: ChatProviderKind; label: string; model?: string; reasoningEffort?: ChatReasoningEffort }>;
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

/** The desktop's outcome of a roster change a member asked for, on the chat
 *  message that says it: a machine settles its own copy of the card from it
 *  (it never applies a roster change itself). */
export interface ChatRosterChangeOutcome {
  approvalId: string;
  outcome: "applied" | "refused";
  appliedParticipantIds?: string[];
  error?: string;
}
