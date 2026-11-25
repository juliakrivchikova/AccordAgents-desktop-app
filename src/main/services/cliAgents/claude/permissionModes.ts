import type { ChatAgentMode, ChatAgentPermissions } from "../../../../shared/types";
import {
  chatAgentModeForKind, effectiveChatAgentPermissionsForProvider, normalizeChatAgentPermissions
} from "../../../../shared/agentPermissions";

export type ClaudePermissionMode = "default" | "plan" | "acceptEdits" | "auto";

/** A control request the member's live Claude Code process did not carry
 *  out: it refused it (`code`: Claude Code 2.1.330's reason, such as
 *  `auto_mode_unavailable`), or did not answer in time. */
export class ClaudeControlError extends Error {
  readonly code?: string;
  readonly timedOut: boolean;
  constructor(message: string, options: { code?: string; timedOut?: boolean } = {}) {
    super(message);
    this.name = "ClaudeControlError";
    this.code = options.code || undefined;
    this.timedOut = options.timedOut === true;
  }
}

/** Claude Code 2.1.330's reasons for refusing a switch to auto mode (its
 *  `set_permission_mode` error codes): the account, its settings or the
 *  model do not allow it now, which a new process does not change. */
export function isClaudeAutoModeRefusal(code: string | undefined): boolean {
  return typeof code === "string" && code.startsWith("auto_mode_");
}

export function isClaudePermissionMode(value: string): value is ClaudePermissionMode {
  return value === "default" || value === "plan" || value === "acceptEdits" || value === "auto";
}

/** Each mode as Claude Code names it (src/shared/chatAccessModes.ts). */
export const CLAUDE_PERMISSION_MODE_LABELS: Readonly<Record<ClaudePermissionMode, string>> = {
  default: "Manual",
  acceptEdits: "Accept edits",
  plan: "Plan",
  auto: "Auto"
};

/** How much a mode lets Claude Code do without asking: Plan edits nothing,
 *  Manual asks before edits and commands, Accept edits makes edits, Auto
 *  decides commands too. */
export function claudePermissionModeRank(mode: ClaudePermissionMode): number {
  return mode === "plan" ? 0 : mode === "default" ? 1 : mode === "acceptEdits" ? 2 : 3;
}

/** Claude Code's `--permission-mode` for a chat member's mode and rights:
 *  Manual (`default`) or Accept edits by the file-edit right, Plan, or Auto.
 *  Codex's Full Access is not a Claude Code mode: Auto, the broadest one
 *  Claude Code offers without extra flags. */
export function claudeCodePermissionMode(agentMode: ChatAgentMode | undefined, permissions: ChatAgentPermissions | undefined): ClaudePermissionMode {
  const mode = chatAgentModeForKind("claude-code", agentMode);
  if (mode === "plan") {
    return "plan";
  }
  if (mode === "auto") {
    // Native Claude auto mode: a classifier auto-approves safe tool calls (incl. Bash)
    // and blocks dangerous ones without prompting — the headless-friendly analog of
    // Codex Auto-review. If the installed CLI lacks it, runClaudeOneShot fails the run
    // loudly with an upgrade message rather than silently running a different mode.
    return "auto";
  }
  return effectiveChatAgentPermissionsForProvider("claude-code", mode, normalizeChatAgentPermissions(permissions)).workspaceWrite
    ? "acceptEdits"
    : "default";
}
