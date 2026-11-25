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

/** Whether the member's CLI runs in its own default mode (the sessions
 *  view's access): what is not granted, it asks about instead of the app
 *  refusing it. */
function asksInOwnMode({ agentMode, permissions }: ChatPermissionPromptLinesOptions): boolean {
  return permissions.cliApprovals === true && (agentMode ?? "default") === "default";
}

/** One line naming what the member may do this turn, and what it is asked
 *  about first. */
export function chatPermissionSummaryLine(options: ChatPermissionPromptLinesOptions): string {
  const { permissions, providerKind } = options;
  const own = asksInOwnMode(options);
  const state = (granted: boolean, asked: boolean): string => granted ? "allowed" : asked ? "asked first" : "blocked";
  const claude = providerKind === "claude-code";
  const codex = providerKind === "codex-cli";
  if (own && providerKind === "gemini-cli") {
    return `Permissions: Antigravity's own ${permissions.workspaceWrite ? "accept-edits" : "default"} mode decides; what it would ask about is refused.`;
  }
  return `Permissions: shell commands ${state(permissions.shell.enabled, own && (claude || codex))}, workspace edits ${state(permissions.workspaceWrite, own && (claude || codex))}, web access ${state(permissions.webAccess, own && claude)}.`;
}

export function chatShellRulesText(rules: ChatShellPermissionRule[]): string {
  if (rules.length === 0) {
    return "no explicit shell rules configured";
  }
  return rules.map((rule) => `${rule.action} ${rule.match} ${JSON.stringify(rule.pattern)}`).join("; ");
}

function chatShellPermissionLine({ agentMode, providerKind, permissions, canRequestPermissions }: ChatPermissionPromptLinesOptions): string {
  if (agentMode === "full-access" && providerKind === "codex-cli") {
    return "Codex Full Access: commands and edits run without asking, outside the workspace and with network access too, as in Codex's own Full Access preset.";
  }
  if (agentMode === "auto" && providerKind === "codex-cli") {
    return "Codex Auto-review mode enables native command execution inside the workspace-write sandbox; eligible provider approvals are handled by Codex Auto-review.";
  }
  if (agentMode === "auto" && providerKind === "gemini-cli") {
    return "Auto-review runs Antigravity with tool confirmations skipped (print mode cannot prompt), so only run commands that are safe and reversible.";
  }
  if (agentMode === "auto") {
    return "Auto-review runs Claude under the native auto classifier: it auto-approves safe shell commands and edits without prompting and blocks dangerous ones.";
  }
  const requestGuidance = canRequestPermissions
    ? "call `app_permissions_request_change` with a narrow `shellRules` request before refusing."
    : "explain the specific command and shell rule needed before refusing.";
  if (asksInOwnMode({ agentMode, providerKind, permissions, canRequestPermissions })) {
    const denies = permissions.shell.rules.filter((rule) => rule.action === "deny");
    const denyText = denies.length > 0 ? ` Deny rules are strict hard stops: ${chatShellRulesText(denies)}.` : "";
    if (providerKind === "codex-cli") {
      return `Shell commands run in Codex's ${permissions.workspaceWrite ? "workspace-write" : "read-only"} sandbox; a command that needs more asks User for approval (escalation), as Codex does in its terminal.${denyText}`;
    }
    if (providerKind === "gemini-cli") {
      return "Antigravity's own mode decides commands; one it would ask about is refused, because print mode cannot ask User.";
    }
    if (!permissions.shell.enabled) {
      return `Shell commands are available: Claude Code asks User to approve each one, as in its terminal, so run what the task needs instead of requesting a permission change first.${denyText}`;
    }
  }
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
  const { permissions, providerKind } = options;
  if (permissions.workspaceWrite) {
    return "Workspace file edits are allowed when needed.";
  }
  if (asksInOwnMode(options)) {
    if (providerKind === "claude-code") {
      return "Workspace file edits are available: Claude Code asks User to approve each edit, as in its terminal, so make the edits the task needs instead of requesting a permission change first.";
    }
    if (providerKind === "codex-cli") {
      return "The sandbox is read-only: an edit asks User for approval (escalation), as Codex does in its terminal.";
    }
    return "Antigravity's default mode refuses file edits here (print mode cannot ask User); if the task needs edits, say so: User can switch you to Accept-edits mode.";
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

function chatWebPermissionLine(options: ChatPermissionPromptLinesOptions): string {
  const { permissions, canRequestPermissions, providerKind } = options;
  if (permissions.webAccess) {
    return "Web access is allowed when needed.";
  }
  if (asksInOwnMode(options) && providerKind === "claude-code") {
    return "Web search and fetch are available: Claude Code asks User to approve each use, as in its terminal.";
  }
  if (asksInOwnMode(options) && providerKind === "gemini-cli") {
    return "Antigravity's own mode decides web use.";
  }
  const guidance = canRequestPermissions
    ? "call `app_permissions_request_change` for `webAccess` before refusing."
    : "explain that `webAccess` is needed before refusing.";
  return `Web access is blocked for this turn. If the current task requires live lookup, ${guidance}`;
}
