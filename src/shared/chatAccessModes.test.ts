// The sessions view's access in each CLI's own terms (the User, 2026-11-21):
// the same modes and words on the desktop and the phone, each the CLI's own
// mode, and the rights it carries through the main session's ceiling.
import assert from "node:assert/strict";
import test from "node:test";

import {
  chatAgentPermissionsWithin,
  clampChatAgentAccess,
  clampChatAgentPermissions,
  cloneChatAgentPermissions,
  defaultChatAgentPermissions,
  normalizeChatAgentPermissions
} from "./agentPermissions";
import {
  applyChatAccessOption,
  applyChatAccessOptionById,
  chatAccessOptions,
  defaultChatAccessOption,
  selectedChatAccessOption,
  withClassicChatPermissions
} from "./chatAccessModes";
import { newChatMainSessionFor } from "./newChat";
import { chatPermissionPromptLines, chatPermissionSummaryLine } from "./permissionPrompt";
import type { ChatParticipant } from "./types";

test("each CLI's modes by its own names, and the one it starts in", () => {
  assert.deepEqual(chatAccessOptions("claude-code").map((option) => option.label), ["Default", "Accept edits", "Plan mode", "Auto mode"]);
  assert.deepEqual(chatAccessOptions("codex-cli").map((option) => option.label), ["Read only", "Default", "Auto-review", "Plan mode"]);
  assert.deepEqual(chatAccessOptions("gemini-cli").map((option) => option.label), ["Default", "Accept edits", "Auto mode", "Plan mode"]);
  assert.equal(defaultChatAccessOption("claude-code").id, "default");
  assert.equal(defaultChatAccessOption("codex-cli").id, "workspace-write", "Codex's Default preset");
  assert.equal(defaultChatAccessOption("gemini-cli").id, "default");
  for (const kind of ["claude-code", "codex-cli", "gemini-cli"] as const) {
    for (const option of chatAccessOptions(kind)) {
      assert.doesNotMatch(option.detail, /Asks before editing files/, `${kind} ${option.id}: the old claim the app did not keep`);
    }
  }
  assert.ok(!chatAccessOptions("gemini-cli").some((option) => option.label === "Read only"), "agy has no read-only mode, only a prompt");
  // agy's print mode cannot ask: no agy mode says it asks.
  assert.ok(chatAccessOptions("gemini-cli").every((option) => !/\basks\b/i.test(option.detail)), "no agy mode claims it asks");
  assert.match(chatAccessOptions("gemini-cli")[0]!.detail, /refuses edits and commands/);
});

test("a mode is the CLI's own (cliApprovals) with its file-edit right; the other rights stay; settings from the classic controls are no mode", () => {
  const base = { ...defaultChatAgentPermissions(), webAccess: true, shell: { enabled: true, rules: [{ action: "deny" as const, match: "prefix" as const, pattern: "rm" }] } };
  const accept = applyChatAccessOption(chatAccessOptions("claude-code")[1]!, base);
  assert.equal(accept.agentMode, "default");
  assert.equal(accept.permissions.workspaceWrite, true);
  assert.equal(accept.permissions.cliApprovals, true);
  assert.equal(accept.permissions.webAccess, true, "other rights stay");
  assert.deepEqual(accept.permissions.shell, base.shell);
  assert.equal(selectedChatAccessOption("claude-code", accept.agentMode, accept.permissions)?.id, "acceptEdits");
  assert.equal(selectedChatAccessOption("claude-code", "default", { ...base, workspaceWrite: true }), undefined, "classic rights are not passed off as a mode");
  assert.equal(selectedChatAccessOption("codex-cli", "auto", applyChatAccessOptionById("codex-cli", "auto-review", base).permissions)?.id, "auto-review");
  assert.equal(applyChatAccessOptionById("gemini-cli", "nope", base).agentMode, "default", "an unknown id: the CLI's default");
});

test("cliApprovals survives normalising and copying, and passes the main session's ceiling only when the ceiling has it", () => {
  const own = { ...defaultChatAgentPermissions(), cliApprovals: true as const };
  assert.equal(normalizeChatAgentPermissions(own).cliApprovals, true);
  assert.equal(cloneChatAgentPermissions(own).cliApprovals, true);
  assert.equal(normalizeChatAgentPermissions({ ...own, cliApprovals: "yes" }).cliApprovals, undefined);
  assert.equal(clampChatAgentPermissions(own, own).cliApprovals, true);
  assert.equal(clampChatAgentPermissions(own, defaultChatAgentPermissions()).cliApprovals, undefined, "never asks the User where its ceiling may not");
  assert.equal(chatAgentPermissionsWithin(own, defaultChatAgentPermissions()), false);
  assert.equal(chatAgentPermissionsWithin(defaultChatAgentPermissions(), own), true);
});

test("a member in its CLI's Default is told what is asked, not that it is blocked", () => {
  const permissions = { ...defaultChatAgentPermissions(), cliApprovals: true as const };
  const claude = { agentMode: "default" as const, providerKind: "claude-code" as const, permissions, canRequestPermissions: true };
  assert.equal(chatPermissionSummaryLine(claude), "Permissions: shell commands asked first, workspace edits asked first, web access asked first.");
  const lines = chatPermissionPromptLines(claude);
  assert.match(lines.workspace, /asks User to approve each edit/);
  assert.match(lines.shell, /asks User to approve each one/);
  assert.match(lines.web, /asks User to approve each use/);
  assert.doesNotMatch(Object.values(lines).join(" "), /blocked/);
  const codex = chatPermissionPromptLines({ ...claude, providerKind: "codex-cli" });
  assert.match(codex.workspace, /asks User for approval \(escalation\)/);
  const agy = chatPermissionPromptLines({ ...claude, providerKind: "gemini-cli" });
  assert.match(agy.workspace, /refuses file edits here/);
  // The classic controls: as before.
  assert.match(chatPermissionSummaryLine({ ...claude, permissions: defaultChatAgentPermissions() }), /workspace edits blocked/);
});

test("the phone's main session is made in the mode its chip chose, else its CLI's default", () => {
  const offered = { id: "main-session", handle: "main", roleConfigId: "main-session", kind: "codex-cli", agentMode: "default",
    permissions: { ...defaultChatAgentPermissions(), requestParticipants: "allow" } } as ChatParticipant;
  const providers = [
    { kind: "claude-code" as const, label: "Claude Code", defaultModelLabel: "Opus", models: [], efforts: [] },
    { kind: "codex-cli" as const, label: "Codex", defaultModelLabel: "GPT", models: [], efforts: [] }
  ];
  const claude = newChatMainSessionFor(offered, providers, { kind: "claude-code" });
  assert.equal(claude.kind, "claude-code");
  assert.equal(claude.permissions?.cliApprovals, true);
  assert.equal(claude.permissions?.workspaceWrite, false, "Claude Code's Default asks before edits");
  assert.equal(claude.permissions?.requestParticipants, "allow", "its role's rights stay");
  const plan = newChatMainSessionFor(offered, providers, { kind: "codex-cli", access: "plan" });
  assert.equal(plan.agentMode, "plan");
  const codexDefault = newChatMainSessionFor(offered, providers, { kind: "codex-cli" });
  assert.equal(codexDefault.permissions?.workspaceWrite, true, "Codex's Default preset");
  const elsewhere = newChatMainSessionFor(offered, providers, { kind: "codex-cli", homeMachineId: "m-box" });
  assert.equal(elsewhere.homeMachineId, "m-box");
  assert.equal(newChatMainSessionFor(offered, providers, undefined), offered, "no choice: the offer as it is");
});

test("a ceiling without the CLI's own mode never turns Antigravity's restricting mode into skipped confirmations", () => {
  // The main session set from the classic controls: edits on, no CLI mode.
  const classicMain = { agentMode: "default" as const, permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true } };
  for (const id of ["accept-edits", "auto"]) {
    const agy = applyChatAccessOptionById("gemini-cli", id, defaultChatAgentPermissions());
    const held = clampChatAgentAccess("gemini-cli", agy, id === "auto" ? { ...classicMain, agentMode: "auto" } : classicMain);
    assert.equal(held.permissions.cliApprovals, undefined, `${id}: the ceiling has no CLI mode to give`);
    assert.equal(held.permissions.workspaceWrite, false, `${id}: no edits, so agy runs --sandbox, not --dangerously-skip-permissions`);
    assert.equal(held.agentMode, "default", `${id}: not Auto, which skips every confirmation without its own mode`);
  }
  // Plan stays plan; a ceiling with the mode keeps it; Claude Code and Codex
  // simply refuse what is not granted.
  const plan = clampChatAgentAccess("gemini-cli", applyChatAccessOptionById("gemini-cli", "plan", defaultChatAgentPermissions()), classicMain);
  assert.equal(plan.agentMode, "plan");
  const ownMain = applyChatAccessOptionById("claude-code", "acceptEdits", defaultChatAgentPermissions());
  const kept = clampChatAgentAccess("gemini-cli", applyChatAccessOptionById("gemini-cli", "accept-edits", defaultChatAgentPermissions()), ownMain);
  assert.deepEqual([kept.agentMode, kept.permissions.workspaceWrite, kept.permissions.cliApprovals], ["default", true, true], "agy's Accept edits under Claude's");
  const claude = clampChatAgentAccess("claude-code", applyChatAccessOptionById("claude-code", "acceptEdits", defaultChatAgentPermissions()), classicMain);
  assert.deepEqual([claude.permissions.workspaceWrite, claude.permissions.cliApprovals], [true, undefined]);
});

test("the classic toggles end a CLI mode chosen in the picker: what is off is refused, and the picker says Custom access", () => {
  const accept = applyChatAccessOptionById("claude-code", "acceptEdits", { ...defaultChatAgentPermissions(), webAccess: false });
  assert.equal(selectedChatAccessOption("claude-code", accept.agentMode, accept.permissions)?.id, "acceptEdits");
  for (const patch of [{ shell: { enabled: false, rules: [] } }, { workspaceWrite: false }, { webAccess: false }]) {
    const classic = withClassicChatPermissions(accept.permissions, patch);
    assert.equal(classic.cliApprovals, undefined, `${JSON.stringify(patch)}: no CLI mode left to ask the User for what is off`);
    assert.equal(selectedChatAccessOption("claude-code", accept.agentMode, classic), undefined, "the picker marks no mode (Custom access)");
  }
  assert.equal(withClassicChatPermissions(accept.permissions, { webAccess: true }).webAccess, true, "the toggle itself applies");
});
