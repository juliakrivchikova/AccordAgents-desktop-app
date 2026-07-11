import type { ChatAgentMode, ChatAgentPermissions, ChatProviderKind, ChatShellPermissionRule } from "./types";

export interface ChatPermissionPromptLinesOptions {
  agentMode?: ChatAgentMode;
  providerKind?: ChatProviderKind;
  permissions: ChatAgentPermissions;
  canRequestPermissions: boolean;
}

export interface ChatPermissionPromptLines {
  shell: string;
  workspace: string;
  web: string;
}

export function chatPermissionPromptLines(
  options: ChatPermissionPromptLinesOptions
): ChatPermissionPromptLines {
  return {
    shell: chatShellPermissionLine(options),
    workspace: chatWorkspacePermissionLine(options),
    web: chatWebPermissionLine(options)
  };
}

export function chatShellRulesText(rules: ChatShellPermissionRule[]): string {
  if (rules.length === 0) {
    return "no explicit shell rules configured";
  }
  return rules.map((rule) => `${rule.action} ${rule.match} ${JSON.stringify(rule.pattern)}`).join("; ");
}

function chatShellPermissionLine({ agentMode, providerKind, permissions, canRequestPermissions }: ChatPermissionPromptLinesOptions): string {
  if (agentMode === "auto" && providerKind === "codex-cli") {
    return "Codex Auto-review mode enables native command execution inside the workspace-write sandbox; eligible provider approvals are handled by Codex Auto-review.";
  }
  if (agentMode === "auto" && providerKind === "gemini-cli") {
    const denyNote = permissions.shell.rules.some((rule) => rule.action === "deny")
      ? " Configured deny rules are hard stops: never run a matching command."
      : "";
    return `Auto-review runs Antigravity with tool confirmations skipped (print mode cannot prompt), so only run commands that are safe and reversible.${denyNote}`;
  }
  if (agentMode === "auto") {
    const denyNote = permissions.shell.rules.some((rule) => rule.action === "deny")
      ? " Configured deny rules remain hard stops for matching commands."
      : "";
    return `Auto-review runs Claude under the native auto classifier: it auto-approves safe shell commands and edits without prompting and blocks dangerous ones.${denyNote}`;
  }
  const requestGuidance = canRequestPermissions
    ? "call `app_permissions_request_change` with a narrow `shellRules` request before refusing."
    : "explain the specific command and shell rule needed before refusing.";
  if (!permissions.shell.enabled) {
    if (agentMode === "plan") {
      return "Shell commands are blocked by the current agent mode for this turn. If the current task requires shell execution, explain that a different agent mode with shell permission is needed before refusing.";
    }
    return `Shell commands are blocked for this turn. Read-only file inspection, search, and listing described above are still allowed. If the current task requires a shell command, ${requestGuidance}`;
  }
  const denyGuidance = permissions.shell.rules.some((rule) => rule.action === "deny")
    ? "Deny rules are strict hard stops for matching commands; do not request escalation for commands that match a deny rule."
    : "Deny rules are strict if configured.";
  const askGuidance = providerKind === "gemini-cli"
    ? "Antigravity print mode cannot prompt for approval, so treat ask rules as blocked for this turn."
    : "Ask rules require native CLI approval; allow rules may run without extra confirmation when supported.";
  return `Shell command rules: ${chatShellRulesText(permissions.shell.rules)}. ${denyGuidance} ${askGuidance} If the current task requires a shell command outside these rules, ${requestGuidance}`;
}

function chatWorkspacePermissionLine(options: ChatPermissionPromptLinesOptions): string {
  const { permissions } = options;
  if (permissions.workspaceWrite) {
    return "Workspace file edits are allowed when needed.";
  }
  return chatWorkspaceBlockedLine(options);
}

function chatWorkspaceBlockedLine({ agentMode, canRequestPermissions }: ChatPermissionPromptLinesOptions): string {
  if (agentMode === "plan") {
    return "Workspace file edits are blocked by the current agent mode for this turn. If the current task requires file edits, explain that a different agent mode with file-editing permission is needed before refusing.";
  }
  const guidance = canRequestPermissions
    ? "call `app_permissions_request_change` for `workspaceWrite` before refusing."
    : "explain that `workspaceWrite` is needed before refusing.";
  return `Workspace file edits are blocked for this turn. If the current task requires file edits, ${guidance}`;
}

function chatWebPermissionLine({ permissions, canRequestPermissions }: ChatPermissionPromptLinesOptions): string {
  if (permissions.webAccess) {
    return "Web access is allowed when needed.";
  }
  const guidance = canRequestPermissions
    ? "call `app_permissions_request_change` for `webAccess` before refusing."
    : "explain that `webAccess` is needed before refusing.";
  return `Web access is blocked for this turn. If the current task requires live lookup, ${guidance}`;
}
