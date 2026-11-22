/**
 * Claude Code's own plan approval: when a member in Plan mode finishes its
 * plan, the CLI calls ExitPlanMode, which reaches the app's permission prompt
 * tool. The card the User answers is the CLI's own "Ready to code?" dialog,
 * in its words and with its options (the User, 2026-11-22), on the desktop
 * and the phone alike.
 *
 * Read from Claude Code 2.1.330's binary (its plan dialog, the function that
 * builds its options and the one that turns the pick into a decision):
 *
 * - title "Ready to code?", then "Here is Claude's plan:", the plan, then
 *   "Claude has written up a plan and is ready to execute. Would you like to
 *   proceed?";
 * - with auto mode available on the account, "Yes, and use auto mode"
 *   (value `yes-resume-auto-mode`, mode `auto`); otherwise "Yes, auto-accept
 *   edits" (`yes-accept-edits-keep-context`, `acceptEdits`); then "Yes,
 *   manually approve edits" (`yes-default-keep-context`, `default`); then
 *   "No, keep planning" (`no`), an input row whose placeholder is "Tell
 *   Claude what to change";
 * - a plan over 200,000 characters is not shown ("(the plan is too large to
 *   be shown in full, so it can only be declined)") and only "No, keep
 *   planning" is offered;
 * - a Yes applies `[{ type: "setMode", mode, destination: "session" }]`; a
 *   No sends the User's words back as feedback.
 *
 * The clear-context rows (off unless the User turned
 * `showClearContextOnPlanAccept` on), the Ultraplan row and Shift+Tab's
 * "approve with this feedback" are not offered here.
 */

import type { ChatAgentMode, ChatClaudePlanApproval, ChatToolPermissionRequest } from "./types";

/** The tool Claude Code calls when its plan is ready. */
export const CLAUDE_EXIT_PLAN_MODE_TOOL = "ExitPlanMode";

export const CLAUDE_PLAN_APPROVAL_TITLE = "Ready to code?";
export const CLAUDE_PLAN_APPROVAL_INTRO = "Here is Claude's plan:";
export const CLAUDE_PLAN_APPROVAL_QUESTION = "Claude has written up a plan and is ready to execute. Would you like to proceed?";
/** What the CLI shows in place of an empty plan. */
export const CLAUDE_PLAN_EMPTY = "No plan found. Please write your plan to the plan file first.";
/** What the CLI shows in place of a plan too large to show. */
export const CLAUDE_PLAN_WITHHELD = "(the plan is too large to be shown in full, so it can only be declined)";
/** The longest plan the CLI shows (and lets the User approve). */
export const CLAUDE_PLAN_MAX_CHARS = 200_000;
export const CLAUDE_PLAN_FEEDBACK_PLACEHOLDER = "Tell Claude what to change";

/** What the CLI tells the model when the User declines a tool call, with
 *  and without her words (its rejection messages, verbatim). */
const CLAUDE_REJECT_WITH_FEEDBACK =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";
const CLAUDE_REJECT_STOP =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

export type ClaudePlanApprovalMode = "auto" | "acceptEdits" | "default";
export type ClaudePlanApprovalOptionId = "yes-resume-auto-mode" | "yes-accept-edits-keep-context" | "yes-default-keep-context" | "no";

export const CLAUDE_PLAN_KEEP_PLANNING_ID: ClaudePlanApprovalOptionId = "no";

export interface ClaudePlanApprovalOption {
  /** The CLI's own value for the row. */
  id: ClaudePlanApprovalOptionId;
  label: string;
  /** The mode the CLI moves to on this Yes; none for "No, keep planning". */
  mode?: ClaudePlanApprovalMode;
  /** The row takes the User's words ("No, keep planning"). */
  placeholder?: string;
}

const RESUME_AUTO: ClaudePlanApprovalOption = { id: "yes-resume-auto-mode", label: "Yes, and use auto mode", mode: "auto" };
const ACCEPT_EDITS: ClaudePlanApprovalOption = { id: "yes-accept-edits-keep-context", label: "Yes, auto-accept edits", mode: "acceptEdits" };
const MANUAL: ClaudePlanApprovalOption = { id: "yes-default-keep-context", label: "Yes, manually approve edits", mode: "default" };
const KEEP_PLANNING: ClaudePlanApprovalOption = { id: "no", label: "No, keep planning", placeholder: CLAUDE_PLAN_FEEDBACK_PLACEHOLDER };

/** The rows the CLI offers for this plan, in its order. */
export function claudePlanApprovalOptions(approval: Pick<ChatClaudePlanApproval, "autoModeAvailable" | "withheld"> | undefined): ClaudePlanApprovalOption[] {
  if (approval?.withheld === true) return [KEEP_PLANNING];
  return [approval?.autoModeAvailable === true ? RESUME_AUTO : ACCEPT_EDITS, MANUAL, KEEP_PLANNING];
}

/** The option the card offered under this id; undefined for one it did not. */
export function claudePlanApprovalOption(
  approval: Pick<ChatClaudePlanApproval, "autoModeAvailable" | "withheld"> | undefined,
  optionId: string | undefined
): ClaudePlanApprovalOption | undefined {
  return optionId ? claudePlanApprovalOptions(approval).find((option) => option.id === optionId) : undefined;
}

/** The permission update a Yes carries back to the CLI (its own pDt). */
export function claudePlanSetMode(mode: ClaudePlanApprovalMode): Array<{ type: "setMode"; mode: ClaudePlanApprovalMode; destination: "session" }> {
  return [{ type: "setMode", mode, destination: "session" }];
}

/** What the model is told when the User keeps planning: her words, as the
 *  CLI words a rejection with feedback; without words, the CLI's rejection
 *  that stops and waits for her. */
export function claudePlanRejectionMessage(feedback: string | undefined): string {
  const text = feedback?.trim();
  return text ? `${CLAUDE_REJECT_WITH_FEEDBACK}${text}` : CLAUDE_REJECT_STOP;
}

/** The plan-approval card's request part, from the ExitPlanMode call the
 *  CLI asks about. */
export function claudePlanApprovalFromToolInput(toolInput: unknown, autoModeAvailable: boolean): ChatClaudePlanApproval {
  const record = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput as Record<string, unknown> : {};
  const plan = typeof record.plan === "string" ? record.plan : "";
  const planFilePath = typeof record.planFilePath === "string" && record.planFilePath.trim() ? record.planFilePath.trim().slice(0, 1000) : undefined;
  if (plan.length > CLAUDE_PLAN_MAX_CHARS) {
    return { withheld: true, ...(planFilePath ? { planFilePath } : {}), ...(autoModeAvailable ? { autoModeAvailable: true } : {}) };
  }
  return {
    plan,
    ...(planFilePath ? { planFilePath } : {}),
    ...(autoModeAvailable ? { autoModeAvailable: true } : {})
  };
}

/** Whether a tool permission request is Claude Code's plan approval. */
export function isClaudePlanApprovalRequest(request: unknown): request is ChatToolPermissionRequest & { planApproval: ChatClaudePlanApproval } {
  const value = request as Partial<ChatToolPermissionRequest> | undefined;
  return Boolean(value) && typeof value === "object" && value!.kind === "toolPermission" &&
    value!.toolName === CLAUDE_EXIT_PLAN_MODE_TOOL && Boolean(value!.planApproval) && typeof value!.planApproval === "object";
}

/** The plan the card shows: the plan, the CLI's words for an empty one, or
 *  its words for one too large to show. */
export function claudePlanShown(approval: Pick<ChatClaudePlanApproval, "plan" | "withheld">): string {
  if (approval.withheld === true) return CLAUDE_PLAN_WITHHELD;
  return approval.plan && approval.plan.length > 0 ? approval.plan : CLAUDE_PLAN_EMPTY;
}

/** The member's settings for the mode the CLI moved to: Claude Code's own
 *  mode (its file-edit right telling Manual from Accept edits). */
export function claudePlanModeSettings(mode: ClaudePlanApprovalMode): { agentMode: ChatAgentMode; workspaceWrite?: boolean } {
  if (mode === "auto") return { agentMode: "auto" };
  return { agentMode: "default", workspaceWrite: mode === "acceptEdits" };
}
