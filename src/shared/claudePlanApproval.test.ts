import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_PLAN_APPROVAL_INTRO,
  CLAUDE_PLAN_APPROVAL_QUESTION,
  CLAUDE_PLAN_APPROVAL_TITLE,
  CLAUDE_PLAN_EMPTY,
  CLAUDE_PLAN_FEEDBACK_PLACEHOLDER,
  CLAUDE_PLAN_MAX_CHARS,
  CLAUDE_PLAN_WITHHELD,
  claudePlanApprovalFromToolInput,
  claudePlanApprovalOption,
  claudePlanApprovalOptions,
  claudePlanModeSettings,
  claudePlanRejectionMessage,
  claudePlanSetMode,
  claudePlanShown,
  isClaudePlanApprovalRequest
} from "./claudePlanApproval";
import { applyChatAccessOptionById, selectedChatAccessOption } from "./chatAccessModes";
import { defaultChatAgentPermissions } from "./agentPermissions";

// Read from Claude Code 2.1.330's binary (its plan dialog): the words and
// rows the card shows, word for word.
test("the plan approval is Claude Code 2.1.330's own dialog, in its words", () => {
  assert.equal(CLAUDE_PLAN_APPROVAL_TITLE, "Ready to code?");
  assert.equal(CLAUDE_PLAN_APPROVAL_INTRO, "Here is Claude's plan:");
  assert.equal(CLAUDE_PLAN_APPROVAL_QUESTION, "Claude has written up a plan and is ready to execute. Would you like to proceed?");
  assert.equal(CLAUDE_PLAN_FEEDBACK_PLACEHOLDER, "Tell Claude what to change");
  assert.deepEqual(claudePlanApprovalOptions({}), [
    { id: "yes-accept-edits-keep-context", label: "Yes, auto-accept edits", mode: "acceptEdits" },
    { id: "yes-default-keep-context", label: "Yes, manually approve edits", mode: "default" },
    { id: "no", label: "No, keep planning", placeholder: "Tell Claude what to change" }
  ]);
  // With auto mode on the account the CLI offers it in place of Accept edits.
  assert.deepEqual(claudePlanApprovalOptions({ autoModeAvailable: true }).map((option) => [option.id, option.label, option.mode]), [
    ["yes-resume-auto-mode", "Yes, and use auto mode", "auto"],
    ["yes-default-keep-context", "Yes, manually approve edits", "default"],
    ["no", "No, keep planning", undefined]
  ]);
  // A plan too large to show can only be declined.
  assert.deepEqual(claudePlanApprovalOptions({ withheld: true }).map((option) => option.id), ["no"]);
});

test("a Yes is the CLI's setMode for the session; No is her words as the CLI's rejection", () => {
  assert.deepEqual(claudePlanSetMode("acceptEdits"), [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
  assert.deepEqual(claudePlanSetMode("default"), [{ type: "setMode", mode: "default", destination: "session" }]);
  assert.deepEqual(claudePlanSetMode("auto"), [{ type: "setMode", mode: "auto", destination: "session" }]);
  assert.equal(claudePlanApprovalOption({}, "yes-resume-auto-mode"), undefined, "not offered without auto mode");
  assert.equal(claudePlanApprovalOption({ autoModeAvailable: true }, "yes-accept-edits-keep-context"), undefined, "not offered with it");
  assert.equal(claudePlanApprovalOption({ withheld: true }, "yes-default-keep-context"), undefined);
  assert.equal(claudePlanApprovalOption({}, undefined), undefined);
  assert.equal(
    claudePlanRejectionMessage("  Split it in two.  "),
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nSplit it in two."
  );
  assert.equal(
    claudePlanRejectionMessage(" "),
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
  );
});

test("the card's plan comes from ExitPlanMode's input; an empty or too large one shows the CLI's words", () => {
  assert.deepEqual(claudePlanApprovalFromToolInput({ plan: "# Plan", planFilePath: " /p/plan.md " }, false), { plan: "# Plan", planFilePath: "/p/plan.md" });
  assert.deepEqual(claudePlanApprovalFromToolInput({ plan: "x" }, true), { plan: "x", autoModeAvailable: true });
  assert.deepEqual(claudePlanApprovalFromToolInput(undefined, false), { plan: "" });
  const huge = claudePlanApprovalFromToolInput({ plan: "a".repeat(CLAUDE_PLAN_MAX_CHARS + 1) }, false);
  assert.deepEqual(huge, { withheld: true }, "not kept: it is not shown");
  assert.equal(claudePlanShown(huge), CLAUDE_PLAN_WITHHELD);
  assert.equal(CLAUDE_PLAN_WITHHELD, "(the plan is too large to be shown in full, so it can only be declined)");
  assert.equal(claudePlanShown({ plan: "" }), CLAUDE_PLAN_EMPTY);
  assert.equal(CLAUDE_PLAN_EMPTY, "No plan found. Please write your plan to the plan file first.");
  assert.equal(claudePlanShown({ plan: "# Plan" }), "# Plan");
  assert.equal(isClaudePlanApprovalRequest({ kind: "toolPermission", toolName: "ExitPlanMode", planApproval: {} }), true);
  assert.equal(isClaudePlanApprovalRequest({ kind: "toolPermission", toolName: "ExitPlanMode" }), false, "a classic member's ExitPlanMode is a tool card");
  assert.equal(isClaudePlanApprovalRequest({ kind: "toolPermission", toolName: "Bash", planApproval: {} }), false);
});

test("the mode a Yes moves the CLI to is the member's chip: Accept edits, Manual, Auto", () => {
  for (const [mode, chip] of [["acceptEdits", "acceptEdits"], ["default", "manual"], ["auto", "auto"]] as const) {
    const settings = applyChatAccessOptionById("claude-code", mode, { ...defaultChatAgentPermissions(), repoRead: true, workspaceWrite: mode !== "acceptEdits", cliApprovals: true });
    assert.equal(selectedChatAccessOption("claude-code", settings.agentMode, settings.permissions)?.id, chip, mode);
    const expected = claudePlanModeSettings(mode);
    assert.equal(settings.agentMode, expected.agentMode);
    if (expected.workspaceWrite !== undefined) assert.equal(settings.permissions.workspaceWrite, expected.workspaceWrite);
  }
});
