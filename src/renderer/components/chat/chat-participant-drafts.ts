import type {
  AgentHealth,
  AppSettings,
  ChatBehaviorRuleConfig,
  ChatAgentMode,
  ChatAgentPermissions,
  ChatParticipant,
  ChatParticipantConfig,
  ChatProviderKind,
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
  isChatShellPermissionPatternSafe,
  normalizeChatAgentMode,
  normalizeChatAgentPermissions
} from "../../../shared/agentPermissions";
import {
  defaultChatAvatarId,
  isChatAvatarIdForKind,
  normalizedChatAvatarId
} from "./chat-avatars";

export interface ChatParticipantDraft {
  handle: string;
  roleConfigId: string;
  behaviorRuleIds: string[];
  kind: ChatProviderKind;
  model?: string;
  avatarId?: string;
  agentMode: ChatAgentMode;
  permissions: ChatAgentPermissions;
}

export const CHAT_AGENT_MODE_OPTIONS: Array<{ value: ChatAgentMode; label: string }> = [
  { value: "default", label: "Default" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" }
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

const CHAT_NAME_POOL = ["alex", "blake", "casey", "drew", "ellis", "harper", "jamie", "jordan", "morgan", "quinn", "riley", "sam", "taylor"];

export function defaultChatParticipantDraft(settings: AppSettings, existingHandles: Set<string> = new Set()): ChatParticipantDraft {
  const provider = settings.providers.find((item) => item.kind === "codex-cli") ?? settings.providers.find((item) => item.kind === "claude-code");
  const roleConfigId = settings.chatRoleConfigs[0]?.id ?? "";
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
    handle: participant.handle,
    roleConfigId: participant.roleConfigId,
    behaviorRuleIds: normalizeBehaviorRuleIds(participant.behaviorRuleIds),
    kind: participant.kind,
    model: participant.model,
    avatarId: normalizedChatAvatarId(participant.kind, participant.avatarId, participant.id || participant.handle),
    agentMode: normalizeChatAgentMode(participant.agentMode),
    permissions: normalizeChatAgentPermissions(participant.permissions)
  };
}

export function selectedChatParticipantDrafts(participants: ChatParticipantConfig[], selectedIds: Set<string>): ChatParticipantDraft[] {
  return participants.filter((participant) => selectedIds.has(participant.id)).map(chatParticipantConfigToDraft);
}

export function sameParticipantDraft(draft: ChatParticipantDraft, participant: ChatParticipantConfig): boolean {
  return (
    draft.handle === participant.handle &&
    draft.roleConfigId === participant.roleConfigId &&
    behaviorRuleIdsEqual(draft.behaviorRuleIds, participant.behaviorRuleIds) &&
    draft.kind === participant.kind &&
    (draft.model ?? "") === (participant.model ?? "") &&
    normalizedChatAvatarId(draft.kind, draft.avatarId, draft.handle) === normalizedChatAvatarId(participant.kind, participant.avatarId, participant.id || participant.handle) &&
    normalizeChatAgentMode(draft.agentMode) === normalizeChatAgentMode(participant.agentMode) &&
    chatAgentPermissionsEqual(draft.permissions, participant.permissions)
  );
}

export function labelForProviderKind(providers: ProviderSettings[], kind: ProviderKind): string {
  return providers.find((provider) => provider.kind === kind)?.label ?? kind;
}

export function chatParticipantPermissionSummary(participant: Pick<ChatParticipant, "agentMode" | "permissions">): string {
  const mode = normalizeChatAgentMode(participant.agentMode);
  const permissions = effectiveChatAgentPermissions(mode, normalizeChatAgentPermissions(participant.permissions));
  const enabled = [
    permissions.repoRead ? "repo" : "",
    permissions.shell.enabled ? "shell" : "",
    permissions.workspaceWrite ? "edit" : "",
    permissions.webAccess ? "web" : "",
    (permissions.providerNative?.["claude-code"]?.allowedTools.length ?? 0) > 0 ? "native" : ""
  ].filter(Boolean);
  return `${mode}${enabled.length > 0 ? ` · ${enabled.join(", ")}` : ""}`;
}

export function normalizeChatParticipantDraftForSettings(draft: ChatParticipantDraft, settings: AppSettings): ChatParticipantDraft {
  const fallback = defaultChatParticipantDraft(settings);
  const roleConfigId = settings.chatRoleConfigs.some((role) => role.id === draft.roleConfigId)
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
    avatarId: normalizedChatAvatarId(kind, draft.avatarId, handle || roleConfigId),
    agentMode: normalizeChatAgentMode(draft.agentMode),
    permissions: normalizeChatAgentPermissions(draft.permissions)
  };
}

export function updateChatParticipantDraft(
  draft: ChatParticipantDraft,
  settings: AppSettings,
  patch: Partial<Pick<ChatParticipantDraft, "roleConfigId" | "behaviorRuleIds" | "kind" | "avatarId" | "agentMode" | "permissions">>
): ChatParticipantDraft {
  let next = { ...draft, ...patch };
  if (!isChatAvatarIdForKind(next.avatarId, next.kind)) {
    next = { ...next, avatarId: defaultChatAvatarId(next.kind, next.handle || next.roleConfigId) };
  }
  if (!draft.handle.trim() || isGeneratedChatHandle(draft.handle)) {
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
    handle: draft.handle.trim().replace(/^@/, ""),
    roleConfigId: draft.roleConfigId,
    behaviorRuleIds: normalizeBehaviorRuleIds(draft.behaviorRuleIds),
    kind: draft.kind,
    model: draft.model?.trim() || undefined,
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
      return "Administrator role is required to start an empty chat.";
    }
    if (!agents.some((agent) => agent.installed)) {
      return "Codex CLI or Claude Code is required to start chat with @admin.";
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

function generatedChatHandle(settings: AppSettings, kind: ChatProviderKind, roleConfigId: string, existingHandles: Set<string> = new Set()): string {
  const roleLabel = settings.chatRoleConfigs.find((role) => role.id === roleConfigId)?.label ?? roleConfigId;
  const name = CHAT_NAME_POOL[Math.floor(Math.random() * CHAT_NAME_POOL.length)] ?? "alex";
  const cli = kind === "claude-code" ? "claude" : "codex";
  const role = compactRoleSlug(roleLabel);
  const base = truncateHandle(`${name}-${cli}-${role}`, 32);
  let candidate = base;
  let suffix = 2;
  while (existingHandles.has(candidate.toLowerCase())) {
    const suffixText = `-${suffix}`;
    candidate = `${truncateHandle(base, 32 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

function compactRoleSlug(label: string): string {
  const normalized = slugHandle(label);
  if (normalized.includes("synth")) {
    return "synthesizer";
  }
  if (normalized.includes("arbiter")) {
    return "arbiter";
  }
  if (normalized.includes("engineer")) {
    return "engineer";
  }
  return truncateHandle(normalized || "agent", 14);
}

function slugHandle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncateHandle(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/-+$/g, "") || "agent";
}

function isGeneratedChatHandle(handle: string): boolean {
  const [name, cli] = handle.toLowerCase().split("-");
  return CHAT_NAME_POOL.includes(name) && (cli === "codex" || cli === "claude");
}
