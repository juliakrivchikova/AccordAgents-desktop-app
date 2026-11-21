import { normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../shared/agentPermissions";
import type { ChatAgentMode, ChatAgentPermissions, ChatProviderKind } from "../../../shared/types";

/**
 * A member's access in its CLI's own terms, as the compact model picker of
 * the sessions view lists it (the User, 2026-11-21). Each is the app's mode
 * and file-edit right the CLI is run with, named the way that CLI names what
 * it then runs in (cliAgents.ts claudePermissionMode for Claude Code's
 * `--permission-mode`, codexExec.ts codexSandboxMode for Codex's `--sandbox`,
 * permissionPrompt.ts for Auto-review): the mapping is the app's, only the
 * words are the CLI's.
 */
export interface ChatAccessOption {
  id: string;
  label: string;
  detail: string;
  agentMode: ChatAgentMode;
  /** For the ordinary mode: whether it edits files. */
  workspaceWrite?: boolean;
}

const CLAUDE_ACCESS: ChatAccessOption[] = [
  { id: "default", label: "Default", detail: "Asks before editing files", agentMode: "default", workspaceWrite: false },
  { id: "accept-edits", label: "Accept edits", detail: "Edits files without asking", agentMode: "default", workspaceWrite: true },
  { id: "plan", label: "Plan mode", detail: "Reads and plans, changes nothing", agentMode: "plan" },
  { id: "auto", label: "Auto mode", detail: "Approves safe actions, blocks risky ones", agentMode: "auto" }
];

const CODEX_ACCESS: ChatAccessOption[] = [
  { id: "read-only", label: "Read only", detail: "Sandbox: read-only", agentMode: "default", workspaceWrite: false },
  { id: "workspace-write", label: "Workspace write", detail: "Sandbox: workspace-write", agentMode: "default", workspaceWrite: true },
  { id: "auto", label: "Auto-review", detail: "Workspace write, approvals reviewed by Codex", agentMode: "auto" },
  { id: "plan", label: "Plan mode", detail: "Reads and plans, changes nothing", agentMode: "plan" }
];

const ANTIGRAVITY_ACCESS: ChatAccessOption[] = [
  { id: "read-only", label: "Read only", detail: "Reads files, changes nothing", agentMode: "default", workspaceWrite: false },
  { id: "edit", label: "Edit files", detail: "Edits files in the project", agentMode: "default", workspaceWrite: true },
  { id: "auto", label: "Auto-review", detail: "Tool confirmations skipped", agentMode: "auto" },
  { id: "plan", label: "Plan mode", detail: "Reads and plans, changes nothing", agentMode: "plan" }
];

export function chatAccessOptions(kind: ChatProviderKind): ChatAccessOption[] {
  return kind === "claude-code" ? CLAUDE_ACCESS : kind === "codex-cli" ? CODEX_ACCESS : ANTIGRAVITY_ACCESS;
}

/** The option a member's mode and rights amount to. */
export function selectedChatAccessOption(
  kind: ChatProviderKind,
  agentMode: ChatAgentMode | undefined,
  permissions: ChatAgentPermissions | undefined
): ChatAccessOption {
  const mode = normalizeChatAgentMode(agentMode);
  const options = chatAccessOptions(kind);
  if (mode !== "default") {
    return options.find((option) => option.agentMode === mode) ?? options[0]!;
  }
  const writes = normalizeChatAgentPermissions(permissions).workspaceWrite;
  return options.find((option) => option.agentMode === "default" && option.workspaceWrite === writes) ?? options[0]!;
}

/** The mode and rights a member gets with this option: only the mode and the
 *  file-edit right change; every other right (reading, shell and its rules,
 *  web, asking and managing members) stays as it was. */
export function applyChatAccessOption(
  option: ChatAccessOption,
  permissions: ChatAgentPermissions | undefined
): { agentMode: ChatAgentMode; permissions: ChatAgentPermissions } {
  const current = normalizeChatAgentPermissions(permissions);
  if (option.agentMode !== "default" || option.workspaceWrite === undefined) {
    return { agentMode: option.agentMode, permissions: current };
  }
  return {
    agentMode: "default",
    permissions: { ...current, workspaceWrite: option.workspaceWrite }
  };
}
