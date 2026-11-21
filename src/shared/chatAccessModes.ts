import { normalizeChatAgentMode, normalizeChatAgentPermissions } from "./agentPermissions";
import type { ChatAgentMode, ChatAgentPermissions, ChatProviderKind } from "./types";

/**
 * A member's access in its CLI's own terms, as the sessions view's compact
 * picker lists it on the desktop and the phone (the User, 2026-11-21). Each
 * mode runs the CLI in that mode (`cliApprovals`, the app's mode and the
 * file-edit right), so it behaves as it does in its own terminal:
 *
 * - Claude Code (`--permission-mode`): Default reads freely and asks before
 *   each edit, command and web use (`default`, every ask an approval card);
 *   Accept edits edits without asking and asks before commands and web
 *   (`acceptEdits`); Plan mode reads and plans (`plan`); Auto mode is
 *   Claude's own classifier (`auto`).
 * - Codex (its `/permissions` presets, 0.155): Read Only is the read-only
 *   sandbox and Default the workspace-write one, both asking (approval
 *   policy `on-request`, every ask an approval card) to go further; Auto-review
 *   lets Codex review those asks itself (`--approve-for-me`); Plan mode is the
 *   read-only sandbox that never asks.
 * - Antigravity (`agy --mode`, its Default being `agentMode: ""`): agy's
 *   print mode cannot ask, so what a mode would ask about is refused (agy
 *   1.5.14, checked 2026-11-21): Default reads and refuses edits and
 *   commands, Accept edits edits in the workspace and refuses commands, Auto
 *   mode edits and runs safe commands where the account has it (elsewhere agy
 *   says so and stays in Default), Plan mode reads and plans.
 *
 * cliAgents.ts (claudePermissionMode, claudeToolConfig,
 * codexAppServerApprovalPolicy) and geminiExec.ts (geminiModeArgs) carry
 * the mapping out.
 */
export interface ChatAccessOption {
  /** The CLI's own name for the mode. */
  id: string;
  label: string;
  detail: string;
  agentMode: ChatAgentMode;
  /** For the ordinary mode: whether it edits files without asking. */
  workspaceWrite?: boolean;
}

const CLAUDE_ACCESS: ChatAccessOption[] = [
  { id: "default", label: "Default", detail: "Reads freely, asks before edits, commands and web", agentMode: "default", workspaceWrite: false },
  { id: "acceptEdits", label: "Accept edits", detail: "Edits without asking, asks before commands and web", agentMode: "default", workspaceWrite: true },
  { id: "plan", label: "Plan mode", detail: "Reads and plans, changes nothing", agentMode: "plan" },
  { id: "auto", label: "Auto mode", detail: "Approves safe actions, blocks risky ones", agentMode: "auto" }
];

const CODEX_ACCESS: ChatAccessOption[] = [
  { id: "read-only", label: "Read only", detail: "Reads the workspace, asks to edit or go online", agentMode: "default", workspaceWrite: false },
  { id: "workspace-write", label: "Default", detail: "Edits and runs commands in the workspace, asks to go outside it or online", agentMode: "default", workspaceWrite: true },
  { id: "auto-review", label: "Auto-review", detail: "Workspace write, Codex reviews its own asks", agentMode: "auto" },
  { id: "plan", label: "Plan mode", detail: "Read-only sandbox, plans, never asks", agentMode: "plan" }
];

const ANTIGRAVITY_ACCESS: ChatAccessOption[] = [
  { id: "default", label: "Default", detail: "Reads, refuses edits and commands (agy cannot ask here)", agentMode: "default", workspaceWrite: false },
  { id: "accept-edits", label: "Accept edits", detail: "Edits in the workspace, refuses commands (agy cannot ask here)", agentMode: "default", workspaceWrite: true },
  { id: "auto", label: "Auto mode", detail: "Edits and runs safe commands, where the account has it", agentMode: "auto" },
  { id: "plan", label: "Plan mode", detail: "Reads and plans, changes nothing", agentMode: "plan" }
];

export function chatAccessOptions(kind: ChatProviderKind): ChatAccessOption[] {
  return kind === "claude-code" ? CLAUDE_ACCESS : kind === "codex-cli" ? CODEX_ACCESS : ANTIGRAVITY_ACCESS;
}

/** The mode a main session starts in, the one its CLI starts in: Claude
 *  Code's Default, Codex's Default (the workspace-write preset it gives a
 *  folder it trusts) and agy's Default (its Auto mode is not on every
 *  account; where it is not, agy runs in Default). */
export function defaultChatAccessOption(kind: ChatProviderKind): ChatAccessOption {
  const options = chatAccessOptions(kind);
  const id = kind === "codex-cli" ? "workspace-write" : "default";
  return options.find((option) => option.id === id) ?? options[0]!;
}

/** The mode a member's settings amount to; none when they are not one of
 *  its CLI's modes (rights set in the classic view's controls). */
export function selectedChatAccessOption(
  kind: ChatProviderKind,
  agentMode: ChatAgentMode | undefined,
  permissions: ChatAgentPermissions | undefined
): ChatAccessOption | undefined {
  const normalized = normalizeChatAgentPermissions(permissions);
  if (!normalized.cliApprovals) {
    return undefined;
  }
  const mode = normalizeChatAgentMode(agentMode);
  const options = chatAccessOptions(kind);
  if (mode !== "default") {
    return options.find((option) => option.agentMode === mode);
  }
  return options.find((option) => option.agentMode === "default" && option.workspaceWrite === normalized.workspaceWrite);
}

/** Rights set from the classic controls (Read Files, Edit Files, Run Shell,
 *  Access Web): the classic meaning wins, so the member leaves its CLI's own
 *  mode (`cliApprovals`) and what is off is refused, never asked about; the
 *  picker then shows "Custom access". Antigravity's own mode is what holds
 *  it back (geminiExec.ts: without it, granted edits skip every agy
 *  confirmation), so leaving it never keeps its edits unless this very toggle
 *  turns them on: it runs read-only (`--sandbox`) instead. */
export function withClassicChatPermissions(
  permissions: ChatAgentPermissions | undefined,
  patch: Partial<ChatAgentPermissions>,
  kind?: ChatProviderKind
): ChatAgentPermissions {
  const current = normalizeChatAgentPermissions(permissions);
  const { cliApprovals: _ownMode, ...classic } = { ...current, ...patch };
  if (kind === "gemini-cli" && current.cliApprovals && patch.workspaceWrite !== true) {
    return { ...classic, workspaceWrite: false };
  }
  return classic;
}

/** The mode and rights a member gets with this option: its CLI's own mode
 *  (`cliApprovals`) and, for the ordinary mode, the file-edit right; every
 *  other right (reading, shell and its rules, web, asking and managing
 *  members) stays as it was. */
export function applyChatAccessOption(
  option: ChatAccessOption,
  permissions: ChatAgentPermissions | undefined
): { agentMode: ChatAgentMode; permissions: ChatAgentPermissions } {
  const current: ChatAgentPermissions = { ...normalizeChatAgentPermissions(permissions), cliApprovals: true };
  if (option.agentMode !== "default" || option.workspaceWrite === undefined) {
    return { agentMode: option.agentMode, permissions: current };
  }
  return {
    agentMode: "default",
    permissions: { ...current, workspaceWrite: option.workspaceWrite }
  };
}

/** A member's settings with its CLI's mode set to `option` by its id; the
 *  CLI's default mode for an id it does not have. */
export function applyChatAccessOptionById(
  kind: ChatProviderKind,
  id: string | undefined,
  permissions: ChatAgentPermissions | undefined
): { agentMode: ChatAgentMode; permissions: ChatAgentPermissions } {
  const option = chatAccessOptions(kind).find((candidate) => candidate.id === id) ?? defaultChatAccessOption(kind);
  return applyChatAccessOption(option, permissions);
}
