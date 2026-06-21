import type { ChatAgentMode, ChatAgentPermissions, ChatProviderKind, ChatShellPermissionRule } from "./types";

export const DEFAULT_CHAT_AGENT_MODE: ChatAgentMode = "default";
export const CHAT_SHELL_RULE_PATTERN_MAX_LENGTH = 160;
export const CHAT_PROVIDER_NATIVE_ALLOWED_TOOL_MAX_LENGTH = 240;

export const DEFAULT_CHAT_AGENT_PERMISSIONS: ChatAgentPermissions = {
  repoRead: true,
  workspaceWrite: false,
  webAccess: false,
  shell: {
    enabled: false,
    rules: []
  }
};

const UNSAFE_CHAT_SHELL_RULE_PATTERN = /[(),\r\n]/;

export function defaultChatAgentPermissions(): ChatAgentPermissions {
  return cloneChatAgentPermissions(DEFAULT_CHAT_AGENT_PERMISSIONS);
}

export function cloneChatAgentPermissions(permissions: ChatAgentPermissions): ChatAgentPermissions {
  const providerNative = cloneProviderNativePermissions(permissions.providerNative);
  return {
    repoRead: permissions.repoRead,
    workspaceWrite: permissions.workspaceWrite,
    webAccess: permissions.webAccess,
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
  return {
    repoRead: typeof record.repoRead === "boolean" ? record.repoRead : DEFAULT_CHAT_AGENT_PERMISSIONS.repoRead,
    workspaceWrite: typeof record.workspaceWrite === "boolean" ? record.workspaceWrite : DEFAULT_CHAT_AGENT_PERMISSIONS.workspaceWrite,
    webAccess: typeof record.webAccess === "boolean" ? record.webAccess : DEFAULT_CHAT_AGENT_PERMISSIONS.webAccess,
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
  // Existing deny rules are preserved and still honored.
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
