import type { ChatAgentMode, ChatAgentPermissions, ChatShellPermissionRule } from "./types";

export const DEFAULT_CHAT_AGENT_MODE: ChatAgentMode = "default";
export const CHAT_SHELL_RULE_PATTERN_MAX_LENGTH = 160;

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
  return {
    repoRead: permissions.repoRead,
    workspaceWrite: permissions.workspaceWrite,
    webAccess: permissions.webAccess,
    shell: {
      enabled: permissions.shell.enabled,
      rules: permissions.shell.rules.map((rule) => ({ ...rule }))
    }
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
  return {
    repoRead: typeof record.repoRead === "boolean" ? record.repoRead : DEFAULT_CHAT_AGENT_PERMISSIONS.repoRead,
    workspaceWrite: typeof record.workspaceWrite === "boolean" ? record.workspaceWrite : DEFAULT_CHAT_AGENT_PERMISSIONS.workspaceWrite,
    webAccess: typeof record.webAccess === "boolean" ? record.webAccess : DEFAULT_CHAT_AGENT_PERMISSIONS.webAccess,
    shell: {
      enabled: typeof shell.enabled === "boolean" ? shell.enabled : DEFAULT_CHAT_AGENT_PERMISSIONS.shell.enabled,
      rules: normalizeChatShellPermissionRules(shell.rules)
    }
  };
}

export function effectiveChatAgentPermissions(mode: ChatAgentMode, permissions: ChatAgentPermissions): ChatAgentPermissions {
  const normalized = normalizeChatAgentPermissions(permissions);
  if (mode !== "plan") {
    return normalized;
  }
  return {
    ...normalized,
    workspaceWrite: false,
    shell: {
      ...normalized.shell,
      enabled: false
    }
  };
}

export function chatAgentPermissionsEqual(left: ChatAgentPermissions | undefined, right: ChatAgentPermissions | undefined): boolean {
  return JSON.stringify(normalizeChatAgentPermissions(left)) === JSON.stringify(normalizeChatAgentPermissions(right));
}

export function isChatShellPermissionPatternSafe(pattern: string): boolean {
  return pattern.trim().length > 0 && !UNSAFE_CHAT_SHELL_RULE_PATTERN.test(pattern);
}

function normalizeChatShellPermissionRules(value: unknown): ChatShellPermissionRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rules: ChatShellPermissionRule[] = [];
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
    rules.push({
      action,
      match,
      pattern
    });
  }
  return rules;
}
