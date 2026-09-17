import type {
  AgentHealth,
  AppSettings,
  ChatBehaviorRuleConfig,
  ChatAgentMode,
  ChatAgentPermissions,
  CloudRunRemoteExecutionMode,
  ChatParticipant,
  ChatParticipantConfig,
  ChatProviderKind,
  CliProviderHost,
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
  normalizeChatAgentPermissions,
  normalizeChatRoleManagementPermission
} from "../../../shared/agentPermissions";
import { normalizeChatReasoningEffort } from "../../../shared/reasoningEffort";
import { chatProviderKind, preferredChatProviderSetting } from "../../../shared/chatProviders";
import {
  cliProviderHostDefaultModel,
  cliProviderHostDefaultModelLabel,
  cliProviderHostForParticipant
} from "../../../shared/cliProviderHosts";
import {
  readyProviderKinds
} from "../../../shared/cliReadiness";
import { validateChatCliAgents } from "./chat-cli-readiness";
export { validateChatCliAgents } from "./chat-cli-readiness";
import {
  defaultChatAvatarId,
  isChatAvatarIdForKind,
  normalizedChatAvatarId
} from "./chat-avatars";
import {
  generatedChatHandle,
  isGeneratedChatHandle
} from "./chat-participant-draft-handles";
import {
  CHAT_ASSISTANT_HANDLE,
  CHAT_ASSISTANT_ROLE_ID,
  isChatAssistantHandle,
  isChatAssistantParticipant
} from "../conversation/conversation-display";

export interface ChatParticipantDraft {
  participantConfigId?: string;
  handle: string;
  roleConfigId: string;
  behaviorRuleIds: string[];
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  avatarId?: string;
  /** Added provider the member runs through; must run through `kind`. */
  hostId?: string;
  agentMode: ChatAgentMode;
  permissions: ChatAgentPermissions;
  remoteExecution?: ChatParticipantConfig["remoteExecution"];
  skipToolchainPreflight: boolean;
  autoWatch: boolean;
}

export type ChatParticipantRuntimeOverride = Partial<Pick<
  ChatParticipantDraft,
  "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "skipToolchainPreflight" | "autoWatch"
>>;

export const NEW_CHAT_ASSISTANT_PARTICIPANT_ID = "__new-chat-assistant__";

export function newChatAssistantParticipantConfig(kind: ChatProviderKind): ChatParticipantConfig {
  return {
    id: NEW_CHAT_ASSISTANT_PARTICIPANT_ID,
    handle: CHAT_ASSISTANT_HANDLE,
    roleConfigId: CHAT_ASSISTANT_ROLE_ID,
    behaviorRuleIds: [],
    kind,
    agentMode: "default",
    permissions: {
      ...defaultChatAgentPermissions(),
      repoRead: false,
      workspaceWrite: false,
      webAccess: false,
      requestParticipants: "ask",
      requestCompaction: "ask",
      shell: {
        enabled: false,
        rules: []
      }
    },
    remoteExecution: "local",
    updatedAt: ""
  };
}

export function hasChatParticipantRuntimeOverride(override: ChatParticipantRuntimeOverride | undefined): boolean {
  return Boolean(override && Object.keys(override).length > 0);
}

export function newChatAssistantParticipantDraft(
  kind: ChatProviderKind,
  runtimeOverride: ChatParticipantRuntimeOverride | undefined
): ChatParticipantDraft {
  return chatParticipantConfigToDraftWithRuntimeOverrides(
    newChatAssistantParticipantConfig(kind),
    {},
    runtimeOverride ? { [NEW_CHAT_ASSISTANT_PARTICIPANT_ID]: runtimeOverride } : {}
  );
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

/** `hostLabel` is the added provider's name when the member runs through one. */
export function chatCliProviderLabel(kind: ChatProviderKind | undefined, hostLabel?: string): string {
  if (hostLabel?.trim()) {
    return hostLabel.trim();
  }
  if (kind === "claude-code") {
    return "Claude Code";
  }
  if (kind === "codex-cli") {
    return "Codex CLI";
  }
  if (kind === "gemini-cli") {
    return "Antigravity";
  }
  return "CLI";
}

/** Label of the "leave it to the CLI" choice for a setting the CLI owns
 *  (reasoning effort, or the model of a plain member). */
export function chatInheritedCliSettingLabel(kind: ChatProviderKind | undefined): string {
  return `${chatCliProviderLabel(kind)} setting`;
}

/** Label of the model picker's default entry: the CLI's own setting for a
 *  built-in member, the vendor's fixed default for a member on an added
 *  provider (first-party vendors have no fixed default and keep the CLI's). */
export function chatModelDefaultLabel(kind: ChatProviderKind | undefined, host?: Pick<CliProviderHost, "vendor" | "cli">): string {
  const hostDefault = kind && host && host.cli === kind ? cliProviderHostDefaultModelLabel(host) : undefined;
  return hostDefault ? `${hostDefault} (default)` : chatInheritedCliSettingLabel(kind);
}

/** The added provider a draft / member runs through, if it still exists and
 *  runs through the member's CLI. */
export function chatParticipantHost(
  participant: { kind: ChatProviderKind; hostId?: string },
  hosts: ReadonlyArray<CliProviderHost>
): CliProviderHost | undefined {
  return cliProviderHostForParticipant(participant.kind, participant.hostId, hosts);
}

/** Composite id for the Provider / CLI picker: an added provider is its own
 *  entry next to Claude Code / Codex / Antigravity. */
const HOST_OPTION_PREFIX = "host:";
export type ChatProviderOptionId = ChatProviderKind | `host:${string}`;

export function chatProviderOptionId(kind: ChatProviderKind, hostId: string | undefined): ChatProviderOptionId {
  return hostId ? `${HOST_OPTION_PREFIX}${hostId}` : kind;
}

export interface ChatProviderOption {
  id: ChatProviderOptionId;
  kind: ChatProviderKind;
  host?: CliProviderHost;
  label: string;
}

/** Picker entries: the built-in CLIs given, then every added provider whose CLI
 *  is among them. */
export function chatProviderOptions(kinds: ChatProviderKind[], hosts: ReadonlyArray<CliProviderHost> = []): ChatProviderOption[] {
  return [
    ...kinds.map((kind): ChatProviderOption => ({ id: kind, kind, label: chatCliProviderLabel(kind) })),
    ...hosts
      .filter((host) => kinds.includes(host.cli))
      .map((host): ChatProviderOption => ({ id: chatProviderOptionId(host.cli, host.id), kind: host.cli, host, label: host.label }))
  ];
}

/** Draft patch for a picker choice. An unknown host id falls back to the
 *  current kind without a binding. */
export function chatProviderOptionPatch(
  optionId: string,
  current: Pick<ChatParticipantDraft, "kind">,
  hosts: ReadonlyArray<CliProviderHost> = []
): Pick<ChatParticipantDraft, "kind" | "hostId"> {
  if (optionId.startsWith(HOST_OPTION_PREFIX)) {
    const host = hosts.find((item) => item.id === optionId.slice(HOST_OPTION_PREFIX.length));
    return host ? { kind: host.cli, hostId: host.id } : { kind: current.kind, hostId: undefined };
  }
  return { kind: chatProviderKind(optionId, current.kind), hostId: undefined };
}

export const CHAT_AGENT_MODE_OPTIONS: Array<{ value: ChatAgentMode; label: string }> = [
  { value: "default", label: chatAgentModeLabel("default") },
  { value: "plan", label: chatAgentModeLabel("plan") },
  { value: "auto", label: chatAgentModeLabel("auto") }
];

export const CHAT_RUN_LOCATION_OPTIONS: Array<{ value: Extract<CloudRunRemoteExecutionMode, "local" | "remote">; label: string }> = [
  { value: "local", label: "Local" },
  { value: "remote", label: "Remote" }
];

export const WORKFLOW_MANAGER_ROLE_ID = "workflow-manager";

export function normalizeChatRunLocation(value: unknown): Extract<CloudRunRemoteExecutionMode, "local" | "remote"> {
  return value === "remote" ? "remote" : "local";
}

export function chatRunLocationLabel(value: unknown): string {
  return normalizeChatRunLocation(value) === "remote" ? "Remote" : "Local";
}

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
  const provider = preferredChatProviderSetting(settings.providers);
  const roleConfigId = activeChatRoleConfigs(settings)[0]?.id ?? "";
  const kind = chatProviderKind(provider?.kind);
  const handle = roleConfigId ? generatedChatHandle(settings, kind, roleConfigId, existingHandles) : "";
  const roleDefaults = participantDefaultsForRole(settings, roleConfigId);
  return {
    handle,
    roleConfigId,
    behaviorRuleIds: [],
    kind,
    model: provider?.model,
    avatarId: defaultChatAvatarId(kind, handle || roleConfigId),
    agentMode: "default",
    permissions: defaultChatParticipantPermissionsForRole(settings, roleConfigId),
    remoteExecution: "local",
    skipToolchainPreflight: false,
    autoWatch: roleDefaults.autoWatch === true
  };
}

export function chatParticipantConfigToDraft(
  participant: ChatParticipantConfig
): ChatParticipantDraft {
  return {
    participantConfigId: participant.id,
    handle: participant.handle,
    roleConfigId: participant.roleConfigId,
    behaviorRuleIds: normalizeBehaviorRuleIds(participant.behaviorRuleIds),
    kind: participant.kind,
    model: participant.model,
    reasoningEffort: normalizeChatReasoningEffort(participant.reasoningEffort, participant.kind),
    avatarId: normalizedChatAvatarId(participant.kind, participant.avatarId, participant.id || participant.handle),
    hostId: participant.hostId?.trim() || undefined,
    agentMode: normalizeChatAgentMode(participant.agentMode),
    permissions: normalizeChatAgentPermissions(participant.permissions),
    remoteExecution: normalizeChatRunLocation(participant.remoteExecution),
    skipToolchainPreflight: participant.skipToolchainPreflight === true,
    autoWatch: participant.roleConfigId === WORKFLOW_MANAGER_ROLE_ID || participant.autoWatchEnabled === true
  };
}

export function selectedChatParticipantDrafts(
  participants: ChatParticipantConfig[],
  selectedIds: Set<string>,
  remoteExecutionByConfigId: Record<string, CloudRunRemoteExecutionMode> = {},
  runtimeOverridesByConfigId: Record<string, ChatParticipantRuntimeOverride> = {}
): ChatParticipantDraft[] {
  return participants
    .filter((participant) => selectedIds.has(participant.id))
    .map((participant) => chatParticipantConfigToDraftWithRuntimeOverrides(
      participant,
      remoteExecutionByConfigId,
      runtimeOverridesByConfigId
    ));
}

export function selectedOrMentionedChatParticipantDrafts(
  participants: ChatParticipantConfig[],
  selectedIds: Set<string>,
  content: string,
  remoteExecutionByConfigId: Record<string, CloudRunRemoteExecutionMode> = {},
  runtimeOverridesByConfigId: Record<string, ChatParticipantRuntimeOverride> = {}
): ChatParticipantDraft[] {
  const nextSelectedIds = new Set(selectedIds);
  for (const participant of participants) {
    if (isChatAssistantParticipant(participant) || isChatAssistantHandle(participant.handle)) {
      continue;
    }
    if (new RegExp(`@${escapeRegExp(participant.handle)}(?![A-Za-z0-9_-])`, "i").test(content)) {
      nextSelectedIds.add(participant.id);
    }
  }
  return selectedChatParticipantDrafts(
    participants.filter((participant) => !isChatAssistantParticipant(participant)),
    nextSelectedIds,
    remoteExecutionByConfigId,
    runtimeOverridesByConfigId
  );
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
        invalidReason: validateChatParticipantDrafts([draft], settings.chatRoleConfigs, new Set(), settings.chatBehaviorRules) ?? validateChatCliAgents([draft], agents, settings.providers, settings.cliProviderHosts)
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
    (draft.hostId?.trim() || "") === (participant.hostId?.trim() || "") &&
    normalizeChatAgentMode(draft.agentMode) === normalizeChatAgentMode(participant.agentMode) &&
    chatAgentPermissionsEqual(draft.permissions, participant.permissions) &&
    normalizeChatRunLocation(draft.remoteExecution) === normalizeChatRunLocation(participant.remoteExecution) &&
    draft.skipToolchainPreflight === (participant.skipToolchainPreflight === true) &&
    draft.autoWatch === (participant.autoWatchEnabled === true)
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
    permissions.requestParticipants === "allow" ? "request allow" : "",
    permissions.requestParticipants === "deny" ? "request deny" : "",
    permissions.requestCompaction === "allow" ? "compaction allow" : "",
    permissions.requestCompaction === "deny" ? "compaction deny" : "",
    permissions.manageRolesParticipants === "allow" ? "manage allow" : "",
    permissions.manageRolesParticipants === "ask" ? "manage ask" : "",
    permissions.manageRolesParticipants === "deny" ? "manage deny" : "",
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
  const kind = chatProviderKind(provider?.kind, fallback.kind);
  const host = chatParticipantHost({ kind, hostId: draft.hostId }, settings.cliProviderHosts ?? []);
  const handle = draft.handle.trim() || (roleConfigId ? generatedChatHandle(settings, kind, roleConfigId, new Set(), host) : "");
  const selectedRuleIds = new Set(normalizeBehaviorRuleIds(draft.behaviorRuleIds));
  return {
    ...draft,
    handle,
    roleConfigId,
    behaviorRuleIds: settings.chatBehaviorRules
      .map((rule) => rule.id)
      .filter((id) => selectedRuleIds.has(id)),
    kind,
    model: draft.model ?? cliProviderHostDefaultModel(host) ?? provider?.model,
    reasoningEffort: normalizeChatReasoningEffort(draft.reasoningEffort, kind),
    avatarId: normalizedChatAvatarId(kind, draft.avatarId, handle || roleConfigId),
    hostId: host?.id,
    agentMode: normalizeChatAgentMode(draft.agentMode),
    permissions: normalizeChatAgentPermissions(draft.permissions),
    remoteExecution: normalizeChatRunLocation(draft.remoteExecution),
    skipToolchainPreflight: draft.skipToolchainPreflight === true,
    autoWatch: isAutoWatchLockedRole(roleConfigId) || draft.autoWatch === true
  };
}

export function updateChatParticipantDraft(
  draft: ChatParticipantDraft,
  settings: AppSettings,
  patch: Partial<Pick<ChatParticipantDraft, "roleConfigId" | "behaviorRuleIds" | "kind" | "model" | "reasoningEffort" | "avatarId" | "hostId" | "agentMode" | "permissions" | "remoteExecution" | "skipToolchainPreflight" | "autoWatch">>
): ChatParticipantDraft {
  let next = { ...draft, ...patch };
  const kindChanged = patch.kind !== undefined && patch.kind !== draft.kind;
  const hosts = settings.cliProviderHosts ?? [];
  // A binding only holds for a provider that runs through the draft's CLI.
  const nextHost = chatParticipantHost(next, hosts);
  next = { ...next, hostId: nextHost?.id };
  const hostChanged = (next.hostId ?? undefined) !== (chatParticipantHost(draft, hosts)?.id ?? undefined);
  // A model id is only meaningful on the side it came from (glm-* vs first-party
  // aliases), so switching provider or binding resets it to that side's default.
  if ((kindChanged || hostChanged) && patch.model === undefined) {
    next = {
      ...next,
      model: cliProviderHostDefaultModel(nextHost) ?? settings.providers.find((provider) => provider.kind === next.kind)?.model
    };
  }
  if (kindChanged && patch.reasoningEffort === undefined) {
    next = {
      ...next,
      reasoningEffort: normalizeChatReasoningEffort(next.reasoningEffort, next.kind)
    };
  }
  if (kindChanged && next.kind !== "codex-cli") {
    next = {
      ...next,
      remoteExecution: "local"
    };
  }
  if (!isChatAvatarIdForKind(next.avatarId, next.kind)) {
    next = { ...next, avatarId: defaultChatAvatarId(next.kind, next.handle || next.roleConfigId) };
  }
  const roleChanged = patch.roleConfigId !== undefined && patch.roleConfigId !== draft.roleConfigId;
  const previousDefaults = participantDefaultsForRole(settings, draft.roleConfigId);
  const nextDefaults = participantDefaultsForRole(settings, next.roleConfigId);
  if (roleChanged && patch.permissions === undefined) {
    let permissions = normalizeChatAgentPermissions(next.permissions);
    if (previousDefaults.requestParticipants && permissions.requestParticipants === previousDefaults.requestParticipants) {
      permissions = { ...permissions, requestParticipants: defaultChatAgentPermissions().requestParticipants };
    }
    if (nextDefaults.requestParticipants) {
      permissions = { ...permissions, requestParticipants: nextDefaults.requestParticipants };
    }
    if (previousDefaults.requestCompaction && permissions.requestCompaction === previousDefaults.requestCompaction) {
      permissions = { ...permissions, requestCompaction: defaultChatAgentPermissions().requestCompaction };
    }
    if (nextDefaults.requestCompaction) {
      permissions = { ...permissions, requestCompaction: nextDefaults.requestCompaction };
    }
    const previousManage = normalizeChatRoleManagementPermission(previousDefaults.manageRolesParticipants);
    if (
      normalizeChatRoleManagementPermission(permissions.manageRolesParticipants) === previousManage ||
      permissions.manageRolesParticipants === undefined
    ) {
      permissions = {
        ...permissions,
        manageRolesParticipants: normalizeChatRoleManagementPermission(nextDefaults.manageRolesParticipants)
      };
    }
    next = { ...next, permissions };
  }
  if (roleChanged && patch.autoWatch === undefined) {
    if (previousDefaults.autoWatch === true && next.autoWatch === true) {
      next = { ...next, autoWatch: false };
    }
    if (typeof nextDefaults.autoWatch === "boolean") {
      next = { ...next, autoWatch: nextDefaults.autoWatch };
    }
  }
  if (isAutoWatchLockedRole(next.roleConfigId)) {
    next = {
      ...next,
      autoWatch: true
    };
  }
  if (!draft.handle.trim() || ((roleChanged || kindChanged || hostChanged) && isGeneratedChatHandle(draft.handle))) {
    const handle = generatedChatHandle(settings, next.kind, next.roleConfigId, new Set(), nextHost);
    return {
      ...next,
      handle,
      avatarId: normalizedChatAvatarId(next.kind, next.avatarId, handle)
    };
  }
  return next;
}

function participantDefaultsForRole(settings: Pick<AppSettings, "chatRoleConfigs">, roleConfigId: string): NonNullable<ChatRoleConfig["participantDefaults"]> {
  return settings.chatRoleConfigs.find((role) => role.id === roleConfigId)?.participantDefaults ?? {};
}

function isAutoWatchLockedRole(roleConfigId: string): boolean {
  return roleConfigId === WORKFLOW_MANAGER_ROLE_ID;
}

function defaultChatParticipantPermissionsForRole(
  settings: Pick<AppSettings, "chatRoleConfigs">,
  roleConfigId: string,
  permissions = defaultChatAgentPermissions()
): ChatAgentPermissions {
  const normalized = normalizeChatAgentPermissions(permissions);
  const defaults = participantDefaultsForRole(settings, roleConfigId);
  return {
    ...normalized,
    ...(defaults.requestParticipants ? { requestParticipants: defaults.requestParticipants } : {}),
    ...(defaults.requestCompaction ? { requestCompaction: defaults.requestCompaction } : {}),
    manageRolesParticipants: normalizeChatRoleManagementPermission(defaults.manageRolesParticipants)
  };
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
    hostId: draft.hostId?.trim() || undefined,
    agentMode: normalizeChatAgentMode(draft.agentMode),
    permissions: normalizeChatAgentPermissions(draft.permissions),
    remoteExecution: normalizeChatRunLocation(draft.remoteExecution),
    skipToolchainPreflight: draft.skipToolchainPreflight === true,
    autoWatch: draft.autoWatch === true
  }));
}

export function validateChatParticipantDrafts(
  drafts: ChatParticipantDraft[],
  roles: ChatRoleConfig[],
  existingHandles: Set<string> = new Set(),
  behaviorRules: ChatBehaviorRuleConfig[] = []
): string | undefined {
  if (drafts.length === 0) {
    return "Add at least one member.";
  }
  const handles = new Set(existingHandles);
  for (const draft of drafts) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(draft.handle)) {
      return "Member names may use letters, numbers, underscores, and hyphens only.";
    }
    const normalized = draft.handle.toLowerCase();
    if (handles.has(normalized)) {
      return `Duplicate member name: @${draft.handle}.`;
    }
    handles.add(normalized);
    if (!roles.some((role) => role.id === draft.roleConfigId)) {
      return "Select a role for every member.";
    }
    const availableRuleIds = new Set(behaviorRules.map((rule) => rule.id));
    if (draft.behaviorRuleIds.some((id) => !availableRuleIds.has(id))) {
      return "Select valid behavior rules for every member.";
    }
    if (draft.kind !== "codex-cli" && draft.kind !== "claude-code" && draft.kind !== "gemini-cli") {
      return "Chat supports local CLI members only.";
    }
    if (draft.avatarId && !isChatAvatarIdForKind(draft.avatarId, draft.kind)) {
      return "Select an avatar that matches the member CLI.";
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

function chatParticipantConfigToDraftWithRuntimeOverrides(
  participant: ChatParticipantConfig,
  remoteExecutionByConfigId: Record<string, CloudRunRemoteExecutionMode>,
  runtimeOverridesByConfigId: Record<string, ChatParticipantRuntimeOverride>
): ChatParticipantDraft {
  const draft = chatParticipantConfigToDraft(participant);
  const runtimeOverride = runtimeOverridesByConfigId[participant.id];
  const remoteExecutionOverride = remoteExecutionByConfigId[participant.id] ?? runtimeOverride?.remoteExecution;
  const next = runtimeOverride ? { ...draft, ...runtimeOverride } : draft;
  return remoteExecutionOverride ? { ...next, remoteExecution: normalizeChatRunLocation(remoteExecutionOverride) } : next;
}

export function validateChatStartupDrafts(
  drafts: ChatParticipantDraft[],
  roles: ChatRoleConfig[],
  agents: AgentHealth[],
  behaviorRules: ChatBehaviorRuleConfig[] = [],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">> = [],
  hosts: ReadonlyArray<CliProviderHost> = []
): string | undefined {
  if (drafts.length === 0) {
    if (!roles.some((role) => role.id === "administrator")) {
      return "Chat Assistant role is required to start an empty chat.";
    }
    if (readyProviderKinds(agents, providers).length === 0) {
      return "Set up and sign in to at least one CLI provider to start a chat.";
    }
    return undefined;
  }
  return validateChatParticipantDrafts(drafts, roles, new Set(), behaviorRules) ?? validateChatCliAgents(drafts, agents, providers, hosts);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
