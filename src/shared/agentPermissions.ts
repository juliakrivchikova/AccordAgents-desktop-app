import type {
  ChatAgentMode,
  ChatAgentPermissions,
  ChatManageRolesParticipantsResolution,
  ChatParticipantRequestPermission,
  ChatProviderKind,
  ChatShellPermissionRule
} from "./types";

export const DEFAULT_CHAT_AGENT_MODE: ChatAgentMode = "default";
export const CHAT_SHELL_RULE_PATTERN_MAX_LENGTH = 160;
export const CHAT_PROVIDER_NATIVE_ALLOWED_TOOL_MAX_LENGTH = 240;

export const DEFAULT_CHAT_AGENT_PERMISSIONS: ChatAgentPermissions = {
  repoRead: true,
  workspaceWrite: false,
  webAccess: false,
  requestParticipants: "ask",
  requestCompaction: "ask",
  shell: {
    enabled: false,
    rules: []
  }
};

const UNSAFE_CHAT_SHELL_RULE_PATTERN = /[(),\r\n]/;

export function defaultChatAgentPermissions(): ChatAgentPermissions {
  return cloneChatAgentPermissions(DEFAULT_CHAT_AGENT_PERMISSIONS);
}

/** What an ordinary member starts with in a new chat: the generic member the
 *  app seeds for each CLI reads the chat's project when it has one (and is
 *  given nothing else); it asks for anything more. The main session starts
 *  the same way (docs/main-session.md). */
export function newChatMemberPermissions(hasProject: boolean): ChatAgentPermissions {
  return {
    ...defaultChatAgentPermissions(),
    repoRead: hasProject,
    workspaceWrite: false,
    webAccess: false,
    shell: { enabled: false, rules: [] }
  };
}

export function cloneChatAgentPermissions(permissions: ChatAgentPermissions): ChatAgentPermissions {
  const providerNative = cloneProviderNativePermissions(permissions.providerNative);
  const manageRolesParticipants = normalizeOptionalChatParticipantRequestPermission(permissions.manageRolesParticipants);
  return {
    repoRead: permissions.repoRead,
    workspaceWrite: permissions.workspaceWrite,
    webAccess: permissions.webAccess,
    requestParticipants: normalizeChatParticipantRequestPermission(permissions.requestParticipants),
    requestCompaction: normalizeChatParticipantRequestPermission(permissions.requestCompaction),
    ...(manageRolesParticipants ? { manageRolesParticipants } : {}),
    shell: {
      enabled: permissions.shell.enabled,
      rules: normalizeChatShellPermissionRules(permissions.shell.rules)
    },
    ...(providerNative ? { providerNative } : {})
  };
}

export function normalizeChatAgentMode(value: unknown): ChatAgentMode {
  return value === "plan" || value === "auto" || value === "default" ? value : DEFAULT_CHAT_AGENT_MODE;
}

export function normalizeChatAgentPermissions(value: unknown): ChatAgentPermissions {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ChatAgentPermissions>
    : {};
  const shell = record.shell && typeof record.shell === "object" && !Array.isArray(record.shell)
    ? record.shell as Partial<ChatAgentPermissions["shell"]>
    : {};
  const providerNative = normalizeProviderNativePermissions(record.providerNative);
  const manageRolesParticipants = normalizeOptionalChatParticipantRequestPermission(record.manageRolesParticipants);
  return {
    repoRead: typeof record.repoRead === "boolean" ? record.repoRead : DEFAULT_CHAT_AGENT_PERMISSIONS.repoRead,
    workspaceWrite: typeof record.workspaceWrite === "boolean" ? record.workspaceWrite : DEFAULT_CHAT_AGENT_PERMISSIONS.workspaceWrite,
    webAccess: typeof record.webAccess === "boolean" ? record.webAccess : DEFAULT_CHAT_AGENT_PERMISSIONS.webAccess,
    requestParticipants: normalizeChatParticipantRequestPermission(record.requestParticipants),
    requestCompaction: normalizeChatParticipantRequestPermission(record.requestCompaction),
    ...(manageRolesParticipants ? { manageRolesParticipants } : {}),
    shell: {
      enabled: typeof shell.enabled === "boolean" ? shell.enabled : DEFAULT_CHAT_AGENT_PERMISSIONS.shell.enabled,
      rules: normalizeChatShellPermissionRules(shell.rules)
    },
    ...(providerNative ? { providerNative } : {})
  };
}

export function effectiveChatAgentPermissions(mode: ChatAgentMode, permissions: ChatAgentPermissions): ChatAgentPermissions {
  const normalized = normalizeChatAgentPermissions(permissions);
  if (mode !== "plan") {
    return normalized;
  }
  const { providerNative: _providerNative, ...readOnlyPermissions } = normalized;
  return {
    ...readOnlyPermissions,
    workspaceWrite: false,
    shell: {
      ...readOnlyPermissions.shell,
      enabled: false
    }
  };
}

export function effectiveChatAgentPermissionsForProvider(
  _providerKind: ChatProviderKind | undefined,
  mode: ChatAgentMode,
  permissions: ChatAgentPermissions
): ChatAgentPermissions {
  const normalized = normalizeChatAgentPermissions(permissions);
  if (mode !== "auto") {
    return effectiveChatAgentPermissions(mode, normalized);
  }
  // Auto-review enables command execution for both providers. Codex runs commands in
  // its workspace-write sandbox; Claude runs under native `--permission-mode auto`,
  // whose classifier decides each command — so Bash must stay available to the
  // session tool surface.
  // Stored app rules remain part of the saved configuration but are not forwarded as
  // hard provider policy in Auto; the provider's native classifier owns each decision.
  const shell = {
    ...normalized.shell,
    enabled: true
  };
  return {
    ...normalized,
    repoRead: true,
    workspaceWrite: true,
    webAccess: true,
    shell
  };
}

export function chatAgentPermissionsEqual(left: ChatAgentPermissions | undefined, right: ChatAgentPermissions | undefined): boolean {
  return JSON.stringify(normalizeChatAgentPermissions(left)) === JSON.stringify(normalizeChatAgentPermissions(right));
}

export function normalizeChatParticipantRequestPermission(value: unknown): ChatParticipantRequestPermission {
  return normalizeOptionalChatParticipantRequestPermission(value) ?? DEFAULT_CHAT_AGENT_PERMISSIONS.requestParticipants;
}

export function normalizeOptionalChatParticipantRequestPermission(value: unknown): ChatParticipantRequestPermission | undefined {
  return value === "allow" || value === "deny" || value === "ask" ? value : undefined;
}

export function normalizeChatRoleManagementPermission(value: unknown): ChatParticipantRequestPermission {
  return normalizeOptionalChatParticipantRequestPermission(value) ?? "deny";
}

export function chatParticipantRequestPermissionRank(value: ChatParticipantRequestPermission): number {
  if (value === "allow") {
    return 2;
  }
  if (value === "ask") {
    return 1;
  }
  return 0;
}

export function chatParticipantRequestPermissionExceeds(
  left: ChatParticipantRequestPermission,
  right: ChatParticipantRequestPermission
): boolean {
  return chatParticipantRequestPermissionRank(left) > chatParticipantRequestPermissionRank(right);
}

export function resolveChatManageRolesParticipantsPermission(
  roleDefaultValue: unknown,
  participantExplicitValue: unknown
): ChatManageRolesParticipantsResolution {
  const roleDefault = normalizeChatRoleManagementPermission(roleDefaultValue);
  const participantExplicit = normalizeOptionalChatParticipantRequestPermission(participantExplicitValue);
  const effective = participantExplicit ?? roleDefault;
  return {
    roleDefault,
    ...(participantExplicit ? { participantExplicit } : {}),
    effective,
    exceedsRoleDefault: chatParticipantRequestPermissionExceeds(effective, roleDefault)
  };
}

const CHAT_AGENT_MODE_RANK: Record<ChatAgentMode, number> = { plan: 0, default: 1, auto: 2 };

/** A member's mode never above its ceiling's: plan < default < auto. */
export function clampChatAgentMode(requested: ChatAgentMode | undefined, ceiling: ChatAgentMode | undefined): ChatAgentMode {
  const wanted = normalizeChatAgentMode(requested);
  const limit = normalizeChatAgentMode(ceiling);
  return CHAT_AGENT_MODE_RANK[wanted] <= CHAT_AGENT_MODE_RANK[limit] ? wanted : limit;
}

function lowerChatParticipantRequestPermission(
  left: ChatParticipantRequestPermission,
  right: ChatParticipantRequestPermission
): ChatParticipantRequestPermission {
  return chatParticipantRequestPermissionRank(left) <= chatParticipantRequestPermissionRank(right) ? left : right;
}

function shellRuleKey(rule: ChatShellPermissionRule): string {
  return `${rule.action}\0${rule.match}\0${rule.pattern}`;
}

/**
 * The rights a member gets when another member makes it (the main session
 * delegating, docs/main-session.md): what was asked for, never more than the
 * ceiling has. Pass as the ceiling what the parent really has: its effective
 * permissions for its mode (effectiveChatAgentPermissionsForProvider), with
 * `manageRolesParticipants` set to its resolved right to manage members.
 *
 * - repo, edits and web: only when both have them;
 * - shell: on only when the ceiling's is; a rule that lets a command run
 *   (allow or ask) only when the ceiling has the same rule; every deny rule
 *   of either is kept;
 * - Claude Code native tools: only those the ceiling has;
 * - member requests and compaction requests: deny < ask < allow, never above
 *   the ceiling's;
 * - managing members: "deny" unless asked for explicitly, and never above
 *   the ceiling's (a member does not create members unless its task says so).
 *
 * The User's server holds a machine's additions to the same rule
 * (chatAgentPermissionsWithin, hub/hubMachineScope.ts).
 */
export function clampChatAgentPermissions(
  requested: ChatAgentPermissions,
  ceiling: ChatAgentPermissions
): ChatAgentPermissions {
  const wanted = normalizeChatAgentPermissions(requested);
  const limit = normalizeChatAgentPermissions(ceiling);
  const limitRules = new Set(limit.shell.rules.map(shellRuleKey));
  const rules = normalizeChatShellPermissionRules([
    ...wanted.shell.rules.filter((rule) => rule.action === "deny" || limitRules.has(shellRuleKey(rule))),
    ...limit.shell.rules.filter((rule) => rule.action === "deny")
  ]);
  const limitTools = new Set(limit.providerNative?.["claude-code"]?.allowedTools ?? []);
  const allowedTools = (wanted.providerNative?.["claude-code"]?.allowedTools ?? []).filter((tool) => limitTools.has(tool));
  const explicitManage = normalizeOptionalChatParticipantRequestPermission(requested?.manageRolesParticipants);
  const manageRolesParticipants = explicitManage
    ? lowerChatParticipantRequestPermission(explicitManage, normalizeChatRoleManagementPermission(limit.manageRolesParticipants))
    : "deny";
  return {
    repoRead: wanted.repoRead && limit.repoRead,
    workspaceWrite: wanted.workspaceWrite && limit.workspaceWrite,
    webAccess: wanted.webAccess && limit.webAccess,
    requestParticipants: lowerChatParticipantRequestPermission(wanted.requestParticipants, limit.requestParticipants),
    requestCompaction: lowerChatParticipantRequestPermission(
      normalizeChatParticipantRequestPermission(wanted.requestCompaction),
      normalizeChatParticipantRequestPermission(limit.requestCompaction)
    ),
    manageRolesParticipants,
    shell: {
      enabled: wanted.shell.enabled && limit.shell.enabled,
      rules
    },
    ...(allowedTools.length > 0 ? { providerNative: { "claude-code": { allowedTools } } } : {})
  };
}

/**
 * Whether a member's permissions give it nothing beyond `ceiling` (managing
 * members aside: it depends on the member's role, so callers check it with
 * resolveChatManageRolesParticipantsPermission). What clampChatAgentPermissions
 * returns is always within its ceiling.
 */
export function chatAgentPermissionsWithin(actual: ChatAgentPermissions, ceiling: ChatAgentPermissions): boolean {
  const member = normalizeChatAgentPermissions(actual);
  const limit = normalizeChatAgentPermissions(ceiling);
  if ((member.repoRead && !limit.repoRead) || (member.workspaceWrite && !limit.workspaceWrite) || (member.webAccess && !limit.webAccess)) {
    return false;
  }
  if (member.shell.enabled && !limit.shell.enabled) {
    return false;
  }
  const limitRules = new Set(limit.shell.rules.map(shellRuleKey));
  if (member.shell.rules.some((rule) => rule.action !== "deny" && !limitRules.has(shellRuleKey(rule)))) {
    return false;
  }
  // A command the ceiling may not run stays forbidden: a member with a shell
  // keeps every deny rule of the ceiling (clampChatAgentPermissions carries
  // them), dropping one is a broader right.
  const memberRules = new Set(member.shell.rules.map(shellRuleKey));
  if (member.shell.enabled && limit.shell.rules.some((rule) => rule.action === "deny" && !memberRules.has(shellRuleKey(rule)))) {
    return false;
  }
  const limitTools = new Set(limit.providerNative?.["claude-code"]?.allowedTools ?? []);
  if ((member.providerNative?.["claude-code"]?.allowedTools ?? []).some((tool) => !limitTools.has(tool))) {
    return false;
  }
  return chatParticipantRequestPermissionRank(member.requestParticipants) <= chatParticipantRequestPermissionRank(limit.requestParticipants) &&
    chatParticipantRequestPermissionRank(normalizeChatParticipantRequestPermission(member.requestCompaction)) <=
      chatParticipantRequestPermissionRank(normalizeChatParticipantRequestPermission(limit.requestCompaction));
}

/** Whether a member's mode is not above `ceiling`'s. */
export function chatAgentModeWithin(actual: ChatAgentMode | undefined, ceiling: ChatAgentMode | undefined): boolean {
  return CHAT_AGENT_MODE_RANK[normalizeChatAgentMode(actual)] <= CHAT_AGENT_MODE_RANK[normalizeChatAgentMode(ceiling)];
}

export function isChatShellPermissionPatternSafe(pattern: string): boolean {
  return pattern.trim().length > 0 && !UNSAFE_CHAT_SHELL_RULE_PATTERN.test(pattern);
}

export function normalizeChatShellPermissionRules(value: unknown): ChatShellPermissionRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rules: ChatShellPermissionRule[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const candidate = item as Partial<ChatShellPermissionRule>;
    const action = candidate.action === "ask" || candidate.action === "deny" || candidate.action === "allow"
      ? candidate.action
      : undefined;
    const match = candidate.match === "prefix" || candidate.match === "exact" ? candidate.match : undefined;
    const pattern = typeof candidate.pattern === "string"
      ? candidate.pattern.trim().slice(0, CHAT_SHELL_RULE_PATTERN_MAX_LENGTH)
      : "";
    if (!action || !match || !isChatShellPermissionPatternSafe(pattern)) {
      continue;
    }
    const key = `${action}\0${match}\0${pattern}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rules.push({
      action,
      match,
      pattern
    });
  }
  return rules;
}

function cloneProviderNativePermissions(
  providerNative: ChatAgentPermissions["providerNative"] | undefined
): ChatAgentPermissions["providerNative"] | undefined {
  const allowedTools = normalizeProviderNativeAllowedTools(providerNative?.["claude-code"]?.allowedTools);
  return allowedTools.length > 0
    ? { "claude-code": { allowedTools } }
    : undefined;
}

function normalizeProviderNativePermissions(value: unknown): ChatAgentPermissions["providerNative"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<NonNullable<ChatAgentPermissions["providerNative"]>>;
  const claudeCode = record["claude-code"];
  if (!claudeCode || typeof claudeCode !== "object" || Array.isArray(claudeCode)) {
    return undefined;
  }
  const allowedTools = normalizeProviderNativeAllowedTools((claudeCode as { allowedTools?: unknown }).allowedTools);
  return allowedTools.length > 0
    ? { "claude-code": { allowedTools } }
    : undefined;
}

export function normalizeProviderNativeAllowedTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowedTools: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const token = item.trim();
    if (!token || token.length > CHAT_PROVIDER_NATIVE_ALLOWED_TOOL_MAX_LENGTH || seen.has(token)) {
      continue;
    }
    seen.add(token);
    allowedTools.push(token);
  }
  return allowedTools;
}
