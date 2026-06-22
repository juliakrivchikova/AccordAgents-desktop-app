import type {
  AgentHealth,
  AppSettings,
  ChatBehaviorRuleConfig,
  ChatAgentMode,
  ChatAgentPermissions,
  ChatParticipant,
  ChatParticipantConfig,
  ChatProviderKind,
  ChatReasoningEffort,
  ChatRoleConfig,
  ChatShellPermissionAction,
  ChatShellPermissionMatch,
  ProviderKind,
  ProviderSettings
} from "../../../shared/types";
import {
  chatAgentPermissionsEqual,
  defaultChatAgentPermissions,
  effectiveChatAgentPermissions,
  effectiveChatAgentPermissionsForProvider,
  isChatShellPermissionPatternSafe,
  normalizeChatAgentMode,
  normalizeChatAgentPermissions
} from "../../../shared/agentPermissions";
import { normalizeChatReasoningEffort } from "../../../shared/reasoningEffort";
import {
  defaultChatAvatarId,
  isChatAvatarIdForKind,
  normalizedChatAvatarId
} from "./chat-avatars";
import {
  generatedChatHandle,
  isGeneratedChatHandle
} from "./chat-participant-draft-handles";

export interface ChatParticipantDraft {
  participantConfigId?: string;
  handle: string;
  roleConfigId: string;
  behaviorRuleIds: string[];
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  avatarId?: string;
  agentMode: ChatAgentMode;
  permissions: ChatAgentPermissions;
}

export interface AddableSavedParticipantConfig {
  config: ChatParticipantConfig;
  invalidReason?: string;
}

export function chatAgentModeLabel(mode: ChatAgentMode | undefined): string {
  switch (normalizeChatAgentMode(mode)) {
    case "plan":
      return "Plan only";
    case "auto":
      return "Auto-run";
    case "default":
    default:
      return "Custom access";
  }
}

export function chatCliProviderLabel(kind: ChatProviderKind | undefined): string {
  if (kind === "claude-code") {
    return "Claude Code";
  }
  if (kind === "codex-cli") {
    return "Codex CLI";
  }
  return "CLI";
}

export function chatInheritedCliSettingLabel(kind: ChatProviderKind | undefined): string {
  return `${chatCliProviderLabel(kind)} setting`;
}

export const CHAT_AGENT_MODE_OPTIONS: Array<{ value: ChatAgentMode; label: string }> = [
  { value: "default", label: chatAgentModeLabel("default") },
  { value: "plan", label: chatAgentModeLabel("plan") },
  { value: "auto", label: chatAgentModeLabel("auto") }
];

export const CHAT_SHELL_ACTION_OPTIONS: Array<{ value: ChatShellPermissionAction; label: string }> = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "deny", label: "Deny" }
];

export const CHAT_SHELL_MATCH_OPTIONS: Array<{ value: ChatShellPermissionMatch; label: string }> = [
  { value: "exact", label: "Exact" },
  { value: "prefix", label: "Prefix" }
];

export function activeChatRoleConfigs(settings: Pick<AppSettings, "chatRoleConfigs">): ChatRoleConfig[] {
  return settings.chatRoleConfigs.filter((role) => !role.archivedAt);
}

export function defaultChatParticipantDraft(settings: AppSettings, existingHandles: Set<string> = new Set()): ChatParticipantDraft {
  const provider = settings.providers.find((item) => item.kind === "codex-cli") ?? settings.providers.find((item) => item.kind === "claude-code");
  const roleConfigId = activeChatRoleConfigs(settings)[0]?.id ?? "";
  const kind = provider?.kind === "claude-code" ? "claude-code" : "codex-cli";
  const handle = roleConfigId ? generatedChatHandle(settings, kind, roleConfigId, existingHandles) : "";
  return {
    handle,
    roleConfigId,
    behaviorRuleIds: [],
    kind,
    model: provider?.model,
    avatarId: defaultChatAvatarId(kind, handle || roleConfigId),
    agentMode: "default",
    permissions: defaultChatAgentPermissions()
  };
}

export function chatParticipantConfigToDraft(participant: ChatParticipantConfig): ChatParticipantDraft {
  return {
    participantConfigId: participant.id,
    handle: participant.handle,
    roleConfigId: participant.roleConfigId,
    behaviorRuleIds: normalizeBehaviorRuleIds(participant.behaviorRuleIds),
    kind: participant.kind,
    model: participant.model,
    reasoningEffort: normalizeChatReasoningEffort(participant.reasoningEffort, participant.kind),
    avatarId: normalizedChatAvatarId(participant.kind, participant.avatarId, participant.id || participant.handle),
    agentMode: normalizeChatAgentMode(participant.agentMode),
    permissions: normalizeChatAgentPermissions(participant.permissions)
  };
}

export function selectedChatParticipantDrafts(participants: ChatParticipantConfig[], selectedIds: Set<string>): ChatParticipantDraft[] {
  return participants.filter((participant) => selectedIds.has(participant.id)).map(chatParticipantConfigToDraft);
}

export function addableSavedParticipantConfigs(
  settings: AppSettings,
  agents: AgentHealth[],
  existingHandles: Set<string>
): AddableSavedParticipantConfig[] {
  const normalizedExistingHandles = new Set(Array.from(existingHandles, (handle) => handle.toLowerCase()));
  return settings.chatParticipantConfigs
    .filter((participant) => !normalizedExistingHandles.has(participant.handle.toLowerCase()))
    .map((config) => {
      const draft = chatParticipantConfigToDraft(config);
      return {
        config,
        invalidReason: validateChatParticipantDrafts([draft], settings.chatRoleConfigs, new Set(), settings.chatBehaviorRules) ?? validateChatCliAgents([draft], agents)
      };
    });
}

export function sameParticipantDraft(draft: ChatParticipantDraft, participant: ChatParticipantConfig): boolean {
  return (
    draft.handle === participant.handle &&
    draft.roleConfigId === participant.roleConfigId &&
    behaviorRuleIdsEqual(draft.behaviorRuleIds, participant.behaviorRuleIds) &&
    draft.kind === participant.kind &&
    (draft.model ?? "") === (participant.model ?? "") &&
    (draft.reasoningEffort ?? "") === (participant.reasoningEffort ?? "") &&
    normalizedChatAvatarId(draft.kind, draft.avatarId, draft.handle) === normalizedChatAvatarId(participant.kind, participant.avatarId, participant.id || participant.handle) &&
    normalizeChatAgentMode(draft.agentMode) === normalizeChatAgentMode(participant.agentMode) &&
    chatAgentPermissionsEqual(draft.permissions, participant.permissions)
  );
}

export function labelForProviderKind(providers: ProviderSettings[], kind: ProviderKind): string {
  return providers.find((provider) => provider.kind === kind)?.label ?? kind;
}

export function chatParticipantPermissionSummary(participant: Pick<ChatParticipant, "agentMode" | "permissions"> & { kind?: ChatProviderKind }): string {
  const mode = normalizeChatAgentMode(participant.agentMode);
  const permissions = participant.kind
    ? effectiveChatAgentPermissionsForProvider(participant.kind, mode, normalizeChatAgentPermissions(participant.permissions))
    : effectiveChatAgentPermissions(mode, normalizeChatAgentPermissions(participant.permissions));
  const enabled = [
    permissions.repoRead ? "repo read" : "",
    permissions.shell.enabled ? "shell" : "",
    permissions.workspaceWrite ? "edit" : "",
    permissions.webAccess ? "web" : "",
    (permissions.providerNative?.["claude-code"]?.allowedTools.length ?? 0) > 0 ? "native tools" : ""
  ].filter(Boolean);
  return `${chatAgentModeLabel(mode)}${enabled.length > 0 ? ` · ${enabled.join(", ")}` : ""}`;
}

export function normalizeChatParticipantDraftForSettings(draft: ChatParticipantDraft, settings: AppSettings): ChatParticipantDraft {
  const fallback = defaultChatParticipantDraft(settings);
  const activeRoles = activeChatRoleConfigs(settings);
  const roleConfigId = activeRoles.some((role) => role.id === draft.roleConfigId)
    ? draft.roleConfigId
    : fallback.roleConfigId;
  const provider = settings.providers.find((item) => item.kind === draft.kind) ?? settings.providers.find((item) => item.kind === fallback.kind);
  const kind = provider?.kind === "claude-code" ? "claude-code" : "codex-cli";
  const handle = draft.handle.trim() || (roleConfigId ? generatedChatHandle(settings, kind, roleConfigId) : "");
  const selectedRuleIds = new Set(normalizeBehaviorRuleIds(draft.behaviorRuleIds));
  return {
    ...draft,
    handle,
    roleConfigId,
    behaviorRuleIds: settings.chatBehaviorRules
      .map((rule) => rule.id)
      .filter((id) => selectedRuleIds.has(id)),
    kind,
    model: draft.model ?? provider?.model,
    reasoningEffort: normalizeChatReasoningEffort(draft.reasoningEffort, kind),
    avatarId: normalizedChatAvatarId(kind, draft.avatarId, handle || roleConfigId),
    agentMode: normalizeChatAgentMode(draft.agentMode),
    permissions: normalizeChatAgentPermissions(draft.permissions)
  };
}

export function updateChatParticipantDraft(
  draft: ChatParticipantDraft,
  settings: AppSettings,
  patch: Partial<Pick<ChatParticipantDraft, "roleConfigId" | "behaviorRuleIds" | "kind" | "model" | "reasoningEffort" | "avatarId" | "agentMode" | "permissions">>
): ChatParticipantDraft {
  let next = { ...draft, ...patch };
  const kindChanged = patch.kind !== undefined && patch.kind !== draft.kind;
  if (kindChanged && patch.model === undefined) {
    next = {
      ...next,
      model: settings.providers.find((provider) => provider.kind === next.kind)?.model
    };
  }
  if (kindChanged && patch.reasoningEffort === undefined) {
    next = {
      ...next,
      reasoningEffort: normalizeChatReasoningEffort(next.reasoningEffort, next.kind)
    };
  }
  if (!isChatAvatarIdForKind(next.avatarId, next.kind)) {
    next = { ...next, avatarId: defaultChatAvatarId(next.kind, next.handle || next.roleConfigId) };
  }
  const roleChanged = patch.roleConfigId !== undefined && patch.roleConfigId !== draft.roleConfigId;
  if (!draft.handle.trim() || ((roleChanged || kindChanged) && isGeneratedChatHandle(draft.handle))) {
    const handle = generatedChatHandle(settings, next.kind, next.roleConfigId);
    return {
      ...next,
      handle,
      avatarId: normalizedChatAvatarId(next.kind, next.avatarId, handle)
    };
  }
  return next;
}

export function normalizedChatDrafts(drafts: ChatParticipantDraft[]): ChatParticipantDraft[] {
  return drafts.map((draft) => ({
    participantConfigId: draft.participantConfigId?.trim() || undefined,
    handle: draft.handle.trim().replace(/^@/, ""),
    roleConfigId: draft.roleConfigId,
    behaviorRuleIds: normalizeBehaviorRuleIds(draft.behaviorRuleIds),
    kind: draft.kind,
    model: draft.model?.trim() || undefined,
    reasoningEffort: normalizeChatReasoningEffort(draft.reasoningEffort, draft.kind),
    avatarId: normalizedChatAvatarId(draft.kind, draft.avatarId, draft.handle),
    agentMode: normalizeChatAgentMode(draft.agentMode),
    permissions: normalizeChatAgentPermissions(draft.permissions)
  }));
}

export function validateChatParticipantDrafts(
  drafts: ChatParticipantDraft[],
  roles: ChatRoleConfig[],
  existingHandles: Set<string> = new Set(),
  behaviorRules: ChatBehaviorRuleConfig[] = []
): string | undefined {
  if (drafts.length === 0) {
    return "Add at least one participant.";
  }
  const handles = new Set(existingHandles);
  for (const draft of drafts) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(draft.handle)) {
      return "Participant names may use letters, numbers, underscores, and hyphens only.";
    }
    const normalized = draft.handle.toLowerCase();
    if (handles.has(normalized)) {
      return `Duplicate participant name: @${draft.handle}.`;
    }
    handles.add(normalized);
    if (!roles.some((role) => role.id === draft.roleConfigId)) {
      return "Select a role for every participant.";
    }
    const availableRuleIds = new Set(behaviorRules.map((rule) => rule.id));
    if (draft.behaviorRuleIds.some((id) => !availableRuleIds.has(id))) {
      return "Select valid behavior rules for every participant.";
    }
    if (draft.kind !== "codex-cli" && draft.kind !== "claude-code") {
      return "Chat supports local CLI participants only.";
    }
    if (draft.avatarId && !isChatAvatarIdForKind(draft.avatarId, draft.kind)) {
      return "Select an avatar that matches the participant CLI.";
    }
    const shellRules = draft.permissions.shell.enabled ? draft.permissions.shell.rules : [];
    for (const rule of shellRules) {
      if (!rule.pattern.trim()) {
        return "Shell permission rules need a command pattern.";
      }
      if (!isChatShellPermissionPatternSafe(rule.pattern)) {
        return "Shell permission rules cannot include commas, parentheses, or newlines.";
      }
    }
  }
  return undefined;
}

export function validateChatStartupDrafts(
  drafts: ChatParticipantDraft[],
  roles: ChatRoleConfig[],
  agents: AgentHealth[],
  behaviorRules: ChatBehaviorRuleConfig[] = []
): string | undefined {
  if (drafts.length === 0) {
    if (!roles.some((role) => role.id === "administrator")) {
      return "Chat Assistant role is required to start an empty chat.";
    }
    if (!agents.some((agent) => agent.installed)) {
      return "Codex CLI or Claude Code is required to start a chat.";
    }
    return undefined;
  }
  return validateChatParticipantDrafts(drafts, roles, new Set(), behaviorRules) ?? validateChatCliAgents(drafts, agents);
}

export function validateChatCliAgents(drafts: ChatParticipantDraft[], agents: AgentHealth[]): string | undefined {
  for (const draft of drafts) {
    const health = agents.find((agent) => agent.kind === draft.kind);
    if (!health?.installed) {
      return `${draft.kind === "codex-cli" ? "Codex CLI" : "Claude Code"} is not installed.`;
    }
  }
  return undefined;
}

function normalizeBehaviorRuleIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const id = item.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function behaviorRuleIdsEqual(left: unknown, right: unknown): boolean {
  const leftIds = normalizeBehaviorRuleIds(left);
  const rightIds = normalizeBehaviorRuleIds(right);
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}
