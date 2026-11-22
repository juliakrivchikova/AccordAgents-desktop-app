// The sessions view's access in each CLI's own terms (the User, 2026-11-21):
// the same modes and words on the desktop and the phone, each the CLI's own
// mode, and the rights it carries through the main session's ceiling.
import assert from "node:assert/strict";
import test from "node:test";

import {
  chatAgentModeForKind,
  chatAgentModeFromAgent,
  chatAgentModeWithin,
  chatAgentPermissionsWithin,
  clampChatAgentAccess,
  clampChatAgentMode,
  clampChatAgentPermissions,
  cloneChatAgentPermissions,
  defaultChatAgentPermissions,
  effectiveChatAgentPermissionsForProvider,
  normalizeChatAgentMode,
  normalizeChatAgentPermissions
} from "./agentPermissions";
import {
  applyChatAccessOption,
  applyChatAccessOptionById,
  chatAccessMenuOptions,
  chatAccessModeSet,
  chatAccessOptions,
  codexModesUnavailableReason,
  cliModesSupportFromHello,
  cliModesTurnRefusal,
  modeNeedingCliModes,
  codexPlanModeOn,
  currentChatAccessId,
  defaultChatAccessOption,
  FULL_ACCESS_CONFIRMATION,
  inCliOwnMode,
  selectedChatAccessOption,
  startChatAccessOption,
  withClassicChatPermissions,
  withCodexPlanMode
} from "./chatAccessModes";
import { antigravityStartAccess, antigravityStartAccessFromText, claudeStartAccess, codexStartAccess, modelNameWithoutId, normalizeCliStartDefaultsByKind } from "./cliStartDefaults";
import { forkedMainSessionPermissions, memberAsItRunsNow } from "./forkToNewChat";
import { newChatMainSessionFor } from "./newChat";
import { chatPermissionPromptLines, chatPermissionSummaryLine } from "./permissionPrompt";
import type { ChatAgentMode, ChatAgentPermissions, ChatParticipant } from "./types";

test("each CLI's modes by its own names and in its own order, described in the vendor's words, and the one it starts in", () => {
  // Claude Code 2.1.330's Shift+Tab cycle and the Claude desktop app's Code sessions.
  assert.deepEqual(chatAccessOptions("claude-code").map((option) => option.label), ["Manual", "Accept edits", "Plan", "Auto"]);
  assert.deepEqual(chatAccessOptions("claude-code").map((option) => option.detail), [
    "Always ask before making changes",
    "Automatically accept all file edits",
    "Create a plan before making changes",
    "Claude handles permission decisions"
  ]);
  assert.equal(chatAccessModeSet("claude-code").title, "Permission mode");
  // Codex 0.155.1's /permissions picker; Read Only is a preset it no longer offers.
  assert.deepEqual(chatAccessOptions("codex-cli").map((option) => option.label), ["Ask for approval", "Approve for me", "Full Access"]);
  assert.equal(chatAccessOptions("codex-cli")[1]!.detail, "Only ask for actions detected as potentially unsafe");
  assert.match(chatAccessOptions("codex-cli")[2]!.detail ?? "", /^Codex can edit files outside this workspace and access the internet without asking for approval\. Exercise caution when using\.$/);
  assert.ok(!chatAccessOptions("codex-cli").some((option) => /plan/i.test(option.label)), "Plan mode is not one of Codex's permissions");
  assert.equal(chatAccessModeSet("codex-cli").plan?.label, "Plan mode");
  assert.equal(chatAccessModeSet("codex-cli").title, "Permissions");
  // agy 1.5.14's Shift+Tab cycle and its /config → Agent Mode words.
  assert.deepEqual(chatAccessOptions("gemini-cli").map((option) => option.label), ["Default", "Accept-edits mode", "Auto mode", "Plan mode"]);
  assert.equal(chatAccessOptions("gemini-cli")[0]!.detail, "Standard behavior.");
  assert.equal(chatAccessModeSet("gemini-cli").title, "Agent Mode");
  assert.match(chatAccessModeSet("gemini-cli").note ?? "", /cannot ask for approval here/, "the stated divergence is shown");
  assert.equal(chatAccessModeSet("claude-code").note, undefined);
  assert.equal(chatAccessModeSet("claude-code").plan, undefined, "Claude Code's Plan is one of its modes");
  assert.equal(defaultChatAccessOption("claude-code").id, "manual");
  assert.equal(defaultChatAccessOption("codex-cli").id, "workspace-write", "Codex's Ask for approval preset");
  assert.equal(defaultChatAccessOption("gemini-cli").id, "default");
});

test("stored and sent mode ids keep working: a renamed mode is its new one, Codex's old Plan is Read Only with Plan mode on", () => {
  assert.equal(currentChatAccessId("claude-code", "default"), "manual", "Claude Code's Default is called Manual now");
  assert.equal(currentChatAccessId("codex-cli", "workspace-write"), "workspace-write");
  const claude = applyChatAccessOptionById("claude-code", "default", defaultChatAgentPermissions());
  assert.equal(selectedChatAccessOption("claude-code", claude.agentMode, claude.permissions)?.id, "manual");
  // A member saved with the old Claude Default (default mode, no edits, its own mode) reads as Manual.
  assert.equal(selectedChatAccessOption("claude-code", "default", { ...defaultChatAgentPermissions(), cliApprovals: true })?.label, "Manual");
  // A Codex member saved in Plan before Plan was a toggle: Read Only, Plan mode on.
  const legacy = { ...defaultChatAgentPermissions(), workspaceWrite: true, cliApprovals: true as const };
  const shown = selectedChatAccessOption("codex-cli", "plan", legacy);
  assert.equal(shown?.id, "read-only");
  assert.equal(codexPlanModeOn("codex-cli", "plan", legacy), true);
  assert.deepEqual(chatAccessMenuOptions("codex-cli", shown).map((option) => option.label), ["Ask for approval", "Approve for me", "Full Access", "Read Only"], "Read Only shows while it is its mode");
  const viaPhone = applyChatAccessOptionById("codex-cli", "plan", defaultChatAgentPermissions());
  assert.deepEqual([viaPhone.agentMode, viaPhone.permissions.workspaceWrite, viaPhone.permissions.codexPlanMode], ["default", false, true]);
  const off = withCodexPlanMode("plan", legacy, false);
  assert.deepEqual([off.agentMode, off.permissions.workspaceWrite, off.permissions.codexPlanMode], ["default", false, undefined], "turning Plan off keeps Read Only, never grants edits");
});

test("Codex's Plan mode is a toggle on top of any preset; only Codex has it", () => {
  for (const id of ["workspace-write", "auto-review", "full-access"]) {
    const on = applyChatAccessOptionById("codex-cli", id, defaultChatAgentPermissions(), true);
    assert.equal(on.permissions.codexPlanMode, true, id);
    assert.equal(selectedChatAccessOption("codex-cli", on.agentMode, on.permissions)?.id, id, `${id}: the preset stays`);
    assert.equal(codexPlanModeOn("codex-cli", on.agentMode, on.permissions), true);
    const off = withCodexPlanMode(on.agentMode, on.permissions, false);
    assert.equal(selectedChatAccessOption("codex-cli", off.agentMode, off.permissions)?.id, id, `${id}: and stays when Plan goes off`);
    assert.equal(codexPlanModeOn("codex-cli", off.agentMode, off.permissions), false);
  }
  const applied = applyChatAccessOption(chatAccessOptions("codex-cli")[2]!, { ...defaultChatAgentPermissions(), cliApprovals: true, codexPlanMode: true });
  assert.equal(applied.permissions.codexPlanMode, true, "choosing a preset keeps Plan mode as it was");
  assert.equal(applyChatAccessOptionById("claude-code", "manual", defaultChatAgentPermissions(), true).permissions.codexPlanMode, undefined, "not on another CLI");
  assert.equal(codexPlanModeOn("codex-cli", "default", { ...defaultChatAgentPermissions(), codexPlanMode: true }), false, "only in the CLI's own mode");
  const classic = withClassicChatPermissions(applyChatAccessOptionById("codex-cli", "workspace-write", defaultChatAgentPermissions(), true).permissions, { webAccess: true }, "codex-cli");
  assert.equal(classic.codexPlanMode, undefined, "a classic toggle ends Plan mode with the CLI's own mode");
  assert.equal(normalizeChatAgentPermissions({ cliApprovals: true, codexPlanMode: true }).codexPlanMode, true);
  assert.equal(cloneChatAgentPermissions({ ...defaultChatAgentPermissions(), cliApprovals: true, codexPlanMode: true }).codexPlanMode, true);
});

test("Codex's Full Access is the broadest mode, Codex's alone: a ceiling below it holds it back, another CLI runs Auto", () => {
  const full = applyChatAccessOptionById("codex-cli", "full-access", defaultChatAgentPermissions());
  assert.equal(full.agentMode, "full-access");
  assert.equal(normalizeChatAgentMode("full-access"), "full-access");
  assert.equal(clampChatAgentMode("full-access", "auto"), "auto");
  assert.equal(clampChatAgentMode("full-access", "full-access"), "full-access");
  assert.equal(chatAgentModeWithin("auto", "full-access"), true);
  assert.equal(chatAgentModeWithin("full-access", "auto"), false);
  assert.equal(chatAgentModeForKind("claude-code", "full-access"), "auto");
  assert.equal(chatAgentModeForKind("gemini-cli", "full-access"), "auto");
  assert.equal(chatAgentModeForKind("codex-cli", "full-access"), "full-access");
  const effective = effectiveChatAgentPermissionsForProvider("codex-cli", "full-access", full.permissions);
  assert.deepEqual([effective.workspaceWrite, effective.shell.enabled, effective.webAccess], [true, true, true]);
  // A Claude member a Codex main session in Full Access makes: Auto, never more.
  const member = clampChatAgentAccess("claude-code", { agentMode: "full-access", permissions: full.permissions }, { agentMode: "full-access", permissions: effective });
  assert.equal(member.agentMode, "auto");
  const held = clampChatAgentAccess("codex-cli", full, applyChatAccessOptionById("codex-cli", "workspace-write", defaultChatAgentPermissions()));
  assert.equal(held.agentMode, "default", "under Ask for approval: not Full Access");
  assert.equal(selectedChatAccessOption("claude-code", "full-access", full.permissions)?.id, "auto", "a Claude member stored so reads as Auto");
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
  assert.equal(claude.permissions?.workspaceWrite, false, "Claude Code's Manual asks before edits");
  assert.equal(claude.permissions?.requestParticipants, "allow", "its role's rights stay");
  const plan = newChatMainSessionFor(offered, providers, { kind: "codex-cli", access: "full-access", plan: true });
  assert.deepEqual([plan.agentMode, plan.permissions?.codexPlanMode], ["full-access", true], "Full Access with Plan mode on");
  const oldPhone = newChatMainSessionFor(offered, providers, { kind: "codex-cli", access: "plan" });
  assert.deepEqual([oldPhone.agentMode, oldPhone.permissions?.workspaceWrite, oldPhone.permissions?.codexPlanMode], ["default", false, true], "a phone from before: Read Only with Plan mode");
  const oldClaude = newChatMainSessionFor(offered, providers, { kind: "claude-code", access: "default" });
  assert.equal(selectedChatAccessOption("claude-code", oldClaude.agentMode, oldClaude.permissions)?.id, "manual", "a phone from before sends Claude's old Default: Manual");
  const codexDefault = newChatMainSessionFor(offered, providers, { kind: "codex-cli" });
  assert.equal(codexDefault.permissions?.workspaceWrite, true, "Codex's Ask for approval preset");
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
  // Classic agy edits skip every confirmation (commands and web too): only
  // under a ceiling that has all of them.
  const classicAgy = { agentMode: "default" as const, permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true } };
  assert.equal(clampChatAgentAccess("gemini-cli", classicAgy, classicMain).permissions.workspaceWrite, false, "the ceiling runs no commands");
  const allMain = { agentMode: "default" as const, permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true, webAccess: true, shell: { enabled: true, rules: [] } } };
  assert.equal(clampChatAgentAccess("gemini-cli", classicAgy, allMain).permissions.workspaceWrite, true);
});

test("a classic toggle never turns Antigravity's own mode into skipped confirmations", () => {
  const accept = applyChatAccessOptionById("gemini-cli", "accept-edits", defaultChatAgentPermissions());
  const web = withClassicChatPermissions(accept.permissions, { webAccess: true }, "gemini-cli");
  assert.deepEqual([web.cliApprovals, web.workspaceWrite], [undefined, false], "an unrelated toggle: read-only, not --dangerously-skip-permissions");
  const edits = withClassicChatPermissions(accept.permissions, { workspaceWrite: true }, "gemini-cli");
  assert.equal(edits.workspaceWrite, true, "turning Edit Files on is the classic choice itself");
  assert.equal(withClassicChatPermissions(applyChatAccessOptionById("claude-code", "acceptEdits", defaultChatAgentPermissions()).permissions, { webAccess: true }, "claude-code").workspaceWrite, true);
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

test("Codex's Plan mode lives only in the CLI's own mode: normalising, clamping and forking keep it only there", () => {
  const own = { ...defaultChatAgentPermissions(), cliApprovals: true as const, codexPlanMode: true as const };
  assert.equal(normalizeChatAgentPermissions({ ...own, cliApprovals: undefined }).codexPlanMode, undefined, "no Plan flag left over without its own mode");
  assert.equal(clampChatAgentPermissions(own, { ...defaultChatAgentPermissions(), cliApprovals: true }).codexPlanMode, true);
  assert.equal(clampChatAgentPermissions(own, defaultChatAgentPermissions()).codexPlanMode, undefined);
  assert.equal(forkedMainSessionPermissions(defaultChatAgentPermissions(), own).codexPlanMode, true, "a fork keeps it");
  assert.equal(forkedMainSessionPermissions(defaultChatAgentPermissions(), { ...own, cliApprovals: undefined }).codexPlanMode, undefined);
});

test("a member or a machine never names Codex's Full Access: only the User's menu does", () => {
  assert.equal(chatAgentModeFromAgent("full-access"), "auto");
  assert.equal(chatAgentModeFromAgent("plan"), "plan");
  assert.equal(chatAgentModeFromAgent("nonsense"), "default");
});

test("a Codex member on a machine whose program is older is not given Full Access or Plan mode", () => {
  const member = { kind: "codex-cli" as const, homeMachineId: "m-box" };
  assert.match(codexModesUnavailableReason(member, { name: "Box", lastHello: {} }) ?? "", /^Box runs an older program: Settings → Machines → Upgrade runtime\.$/);
  assert.match(codexModesUnavailableReason(member, undefined) ?? "", /Upgrade runtime/, "a machine never heard from");
  assert.equal(codexModesUnavailableReason(member, { name: "Box", lastHello: { cliModesSupported: true } }), undefined);
  assert.equal(codexModesUnavailableReason({ kind: "codex-cli" }, undefined), undefined, "on this computer");
  assert.equal(codexModesUnavailableReason({ kind: "claude-code", homeMachineId: "m-box" }, undefined), undefined, "only Codex has them");
});

test("a stored mode a machine's older program would run otherwise refuses its turn there, with what to do", () => {
  const own = { ...defaultChatAgentPermissions(), workspaceWrite: true, cliApprovals: true as const };
  assert.equal(cliModesSupportFromHello(undefined), "unknown", "never greeted");
  assert.equal(cliModesSupportFromHello({}), "outdated", "a program from before the modes");
  assert.equal(cliModesSupportFromHello({ cliModesSupported: true }), "supported");
  // What such a program reads otherwise: Full Access (as Default) and Codex's
  // Plan mode (dropped), the old Plan entry included; nothing else.
  assert.equal(modeNeedingCliModes({ kind: "codex-cli", agentMode: "full-access", permissions: own }), "Full Access");
  assert.equal(modeNeedingCliModes({ kind: "codex-cli", agentMode: "default", permissions: { ...own, codexPlanMode: true } }), "Plan mode");
  assert.equal(modeNeedingCliModes({ kind: "codex-cli", agentMode: "plan", permissions: own }), "Plan mode", "Codex's old Plan entry is Read Only with Plan mode");
  assert.equal(modeNeedingCliModes({ kind: "claude-code", agentMode: "full-access", permissions: own }), undefined, "another CLI runs Auto for it; an older program, Default: nothing wider");
  assert.equal(modeNeedingCliModes({ kind: "codex-cli", agentMode: "full-access", permissions: defaultChatAgentPermissions() }), "Full Access", "the classic controls' Full Access too");
  for (const option of chatAccessOptions("codex-cli").filter((item) => item.agentMode !== "full-access")) {
    const applied = applyChatAccessOption(option, own);
    assert.equal(modeNeedingCliModes({ kind: "codex-cli", ...applied }), undefined, `${option.label} runs there as it says`);
  }
  for (const kind of ["claude-code", "gemini-cli"] as const) {
    for (const option of chatAccessOptions(kind)) {
      assert.equal(modeNeedingCliModes({ kind, ...applyChatAccessOption(option, own) }), undefined, `${kind} ${option.label} runs there as it says`);
    }
  }
  const member = { kind: "codex-cli" as const, agentMode: "full-access" as const, permissions: own };
  assert.equal(cliModesTurnRefusal(member, { name: "Box", support: "outdated" }),
    "Box runs an older program that cannot run Full Access: Settings → Machines → Upgrade runtime, or choose another mode.");
  assert.equal(cliModesTurnRefusal(member, { name: "Box", support: "supported" }), undefined);
  assert.equal(cliModesTurnRefusal(member, { name: "Box", support: "unknown" }), undefined, "never greeted: set up by this computer with its own program");
  assert.equal(cliModesTurnRefusal({ kind: "codex-cli", agentMode: "auto", permissions: own }, { name: "Box", support: "outdated" }), undefined, "Approve for me runs there");
  assert.match(cliModesTurnRefusal(member, { support: "outdated" }) ?? "", /^Its machine runs an older program/);
});

test("a new main session starts in the mode the User's own config starts its CLI in, read where it runs", () => {
  // Codex 0.155.1: the preset /permissions marks current for config/read.
  assert.equal(codexStartAccess({}), "workspace-write", "nothing set: Ask for approval, in a folder it trusts");
  assert.equal(codexStartAccess({ approvals_reviewer: "guardian_subagent" }), "auto-review", "her config: Approve for me");
  assert.equal(codexStartAccess({ approvals_reviewer: "auto_review", approval_policy: "on-request", sandbox_mode: "workspace-write" }), "auto-review");
  assert.equal(codexStartAccess({ sandbox_mode: "read-only" }), "read-only");
  assert.equal(codexStartAccess({ sandbox_mode: "danger-full-access", approval_policy: "never" }), "full-access");
  // A read-only sandbox stays read-only whoever reviews its asks: her own
  // config with sandbox_mode = "read-only" (config/read answers
  // approvals_reviewer auto_review, approval_policy null, Codex 0.155.1).
  assert.equal(codexStartAccess({ sandbox_mode: "read-only", approval_policy: null, approvals_reviewer: "auto_review" }), "read-only");
  assert.equal(codexStartAccess({ sandbox_mode: "read-only", approvals_reviewer: "guardian_subagent" }), "read-only");
  assert.equal(codexStartAccess({ sandbox_mode: "read-only", approval_policy: "never" }), "read-only");
  assert.equal(codexStartAccess({ sandbox_mode: "read-only", approval_policy: "untrusted" }), "read-only");
  // Codex's "Custom permissions": the closest preset that runs nothing
  // without her yes that her config would not (asking her is never wider).
  assert.equal(codexStartAccess({ approval_policy: "never" }), "workspace-write", "never: it asks her for what never refuses");
  assert.equal(codexStartAccess({ approval_policy: "never", approvals_reviewer: "auto_review" }), "workspace-write", "never Codex's reviewer, which would approve on its own");
  assert.equal(codexStartAccess({ approval_policy: "on-failure" }), "workspace-write");
  assert.equal(codexStartAccess({ approval_policy: "on-failure", approvals_reviewer: "auto_review" }), "auto-review");
  assert.equal(codexStartAccess({ sandbox_mode: "danger-full-access" }), "workspace-write", "Full Access's sandbox that asks: the workspace sandbox");
  assert.equal(codexStartAccess({ sandbox_mode: "danger-full-access", approvals_reviewer: "auto_review" }), "auto-review");
  assert.equal(codexStartAccess({ approvals_reviewer: "someone_new" }), "workspace-write", "a reviewer Codex added later: she reviews instead");
  // What Ask for approval would run without asking, or what the app cannot
  // read: Read Only, Codex's narrowest preset.
  assert.equal(codexStartAccess({ approval_policy: "untrusted" }), "read-only", "untrusted asks before commands Ask for approval runs");
  assert.equal(codexStartAccess({ sandbox_mode: "danger-full-access", approval_policy: "untrusted" }), "read-only");
  assert.equal(codexStartAccess({ approval_policy: { granular: { sandbox_approval: true } } }), "read-only", "a granular policy");
  assert.equal(codexStartAccess({ approvals_reviewer: { custom: true } }), "read-only", "a reviewer that is not text");
  assert.equal(codexStartAccess({ sandbox_mode: "external-sandbox" }), "read-only", "a sandbox Codex added later");
  assert.equal(codexStartAccess({ sandbox_mode: 3 }), "read-only", "not text");
  assert.equal(startChatAccessOption("codex-cli", codexStartAccess({ sandbox_mode: "read-only", approvals_reviewer: "auto_review" })).label, "Read Only");
  // Not read at all: the CLI's built-in default.
  assert.equal(codexStartAccess(undefined), undefined);
  // Claude Code 2.1.330: its initialize answer's current_permission_mode.
  assert.equal(claudeStartAccess("default"), "manual");
  assert.equal(claudeStartAccess("acceptEdits"), "acceptEdits");
  assert.equal(claudeStartAccess("plan"), "plan");
  assert.equal(claudeStartAccess("auto"), "auto");
  // Not offered by the composer: Manual, which asks before anything her
  // settings do not allow (Claude Code 2.1.330 says these modes as they are).
  assert.equal(claudeStartAccess("bypassPermissions"), "manual");
  assert.equal(claudeStartAccess("dontAsk"), "manual");
  assert.equal(claudeStartAccess("delegate"), "manual", "a mode Claude Code added later");
  assert.equal(claudeStartAccess(undefined), undefined, "said nothing");
  assert.equal(claudeStartAccess(""), undefined);
  for (const said of ["default", "manual", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"]) {
    const option = startChatAccessOption("claude-code", claudeStartAccess(said));
    assert.ok(["manual", "acceptEdits", "plan", "auto"].includes(option.id), `${said}: one of the composer's modes`);
  }
  // agy 1.5.14: settings.json agentMode. None saved: Auto only where the
  // account has it, which the app cannot read, so the built-in Default.
  assert.equal(antigravityStartAccess(undefined), undefined);
  assert.equal(antigravityStartAccess({}), undefined);
  assert.equal(antigravityStartAccess({ agentMode: "" }), "default");
  assert.equal(antigravityStartAccess({ agentMode: "auto" }), "auto", "saved by her: honoured");
  assert.equal(antigravityStartAccess({ agentMode: "accept-edits" }), "accept-edits");
  assert.equal(antigravityStartAccess({ agentMode: "plan" }), "plan");
  assert.equal(antigravityStartAccess({ agentMode: "turbo" }), undefined, "a mode agy does not have");
  assert.equal(antigravityStartAccessFromText(undefined), undefined, "no file");
  assert.equal(antigravityStartAccessFromText('\uFEFF{"agentMode":"plan"}'), "plan", "a BOM");
  assert.equal(antigravityStartAccessFromText("{ // comment\n}"), undefined, "not plain JSON");
  assert.equal(antigravityStartAccessFromText("[]"), undefined, "not an object");
  assert.equal(startChatAccessOption("gemini-cli", antigravityStartAccess({})).label, "Default");
  // The mode it starts in: that one when offered (Read Only too), else the built-in.
  assert.equal(startChatAccessOption("codex-cli", "auto-review").label, "Approve for me");
  assert.equal(startChatAccessOption("codex-cli", "read-only").label, "Read Only");
  assert.equal(startChatAccessOption("codex-cli", "full-access").label, "Full Access");
  assert.equal(startChatAccessOption("claude-code", "acceptEdits").label, "Accept edits");
  assert.equal(startChatAccessOption("claude-code", "default").label, "Manual", "the old id is the mode it is now");
  assert.equal(startChatAccessOption("gemini-cli", "auto").label, "Auto mode");
  assert.equal(startChatAccessOption("claude-code", undefined).label, defaultChatAccessOption("claude-code").label);
  assert.equal(startChatAccessOption("codex-cli", "nonsense").label, defaultChatAccessOption("codex-cli").label);
  // The phone names no mode: the one her config starts the CLI in.
  const applied = applyChatAccessOptionById("codex-cli", undefined, defaultChatAgentPermissions(), false, "auto-review");
  assert.equal(selectedChatAccessOption("codex-cli", applied.agentMode, applied.permissions)?.label, "Approve for me");
  // Travelling start defaults keep their known fields only.
  assert.deepEqual(normalizeCliStartDefaultsByKind({ "codex-cli": { access: "auto-review", model: "gpt-5.6-luna", modelLabel: "GPT-5.6-Luna", reasoningEffort: "low", extra: 1 }, bogus: {} }),
    { "codex-cli": { access: "auto-review", model: "gpt-5.6-luna", modelLabel: "GPT-5.6-Luna", reasoningEffort: "low" } });
  assert.equal(normalizeCliStartDefaultsByKind("nope"), undefined);
  assert.equal(modelNameWithoutId("GPT-5.6-Luna (gpt-5.6-luna)", "gpt-5.6-luna"), "GPT-5.6-Luna");
  assert.equal(modelNameWithoutId("Sonnet 5.5", "sonnet"), "Sonnet 5.5");
  assert.equal(modelNameWithoutId(" ", "gpt-x"), "gpt-x");
});

test("the phone's main session takes the start mode its provider offers when it names none", () => {
  const offered: ChatParticipant = {
    id: "main-session", handle: "main", roleConfigId: "main-session", kind: "codex-cli", agentMode: "default", permissions: defaultChatAgentPermissions()
  };
  const providers = [{ kind: "codex-cli" as const, label: "Codex", defaultModelLabel: "GPT-5.6-Luna", models: [], efforts: [], start: { access: "auto-review" } }];
  const made = newChatMainSessionFor(offered, providers, { kind: "codex-cli", access: "not-a-mode" });
  assert.equal(selectedChatAccessOption(made.kind, made.agentMode, made.permissions)?.label, "Approve for me");
  const chosen = newChatMainSessionFor(offered, providers, { kind: "codex-cli", access: "workspace-write" });
  assert.equal(selectedChatAccessOption(chosen.kind, chosen.agentMode, chosen.permissions)?.label, "Ask for approval");
});

test("Codex's question before Full Access is Codex's own, word for word (Codex 0.155.1's /permissions)", () => {
  assert.equal(FULL_ACCESS_CONFIRMATION.title, "Enable full access?");
  assert.equal(FULL_ACCESS_CONFIRMATION.body, "When Codex runs with full access, it can edit any file on your computer and run commands with network, without your approval. Exercise caution when enabling full access. This significantly increases the risk of data loss, leaks, or unexpected behavior.");
  assert.deepEqual(FULL_ACCESS_CONFIRMATION.confirm, { label: "Yes, continue anyway", detail: "Apply full access for this session" });
  assert.deepEqual(FULL_ACCESS_CONFIRMATION.cancel, { label: "Cancel", detail: "Go back without enabling full access" });
});

test("a member the main session made in Plan runs as each CLI runs a subagent then: Claude Code's stays in Plan, Codex's runs Default", () => {
  const permissions = { ...defaultChatAgentPermissions(), workspaceWrite: true, shell: { enabled: true, rules: [] }, cliApprovals: true as const };
  const member = (kind: ChatParticipant["kind"], agentMode: ChatParticipant["agentMode"], extra: Partial<ChatParticipant["permissions"]> = {}): ChatParticipant => ({
    id: `m-${kind}`, handle: "m", roleConfigId: "r", kind, agentMode, permissions: { ...permissions, ...extra }, delegatedByParticipantId: "main"
  });
  // Claude Code: "When the main conversation is in plan mode, the subagent
  // stays in plan mode whichever permissionMode you set" (its docs), seen too.
  const claudeMain: ChatParticipant = { id: "main", handle: "main", roleConfigId: "main-session", kind: "claude-code", agentMode: "plan", permissions };
  for (const mode of ["default", "auto", "plan"] as const) {
    const running = memberAsItRunsNow(member("claude-code", mode), claudeMain);
    assert.equal(running.agentMode, "plan", `a Claude Code member asked for ${mode} runs Plan`);
  }
  // Codex: a subagent spawned in Plan mode runs Codex's Default
  // collaboration mode with the parent's sandbox and approvals.
  const codexMain: ChatParticipant = { id: "main", handle: "main", roleConfigId: "main-session", kind: "codex-cli", agentMode: "default", permissions: { ...permissions, codexPlanMode: true } };
  const codexMember = memberAsItRunsNow(member("codex-cli", "default"), codexMain);
  assert.equal(codexPlanModeOn(codexMember.kind, codexMember.agentMode, codexMember.permissions), false, "not in Plan mode");
  assert.equal(selectedChatAccessOption(codexMember.kind, codexMember.agentMode, codexMember.permissions)?.label, "Ask for approval", "the main session's preset");
});

test("a member with rights set in the classic view runs in its CLI's own mode, the one it was running in, never wider (no Custom in the sessions view)", () => {
  const classic = (patch: Partial<ChatAgentPermissions> = {}) => ({ ...defaultChatAgentPermissions(), webAccess: true, ...patch }) as ChatAgentPermissions;
  const cases: Array<[string, ChatParticipant["kind"], ChatAgentMode, ChatAgentPermissions, string, boolean?]> = [
    ["Claude Code running auto", "claude-code", "auto", classic(), "auto"],
    ["Claude Code editing", "claude-code", "default", classic({ workspaceWrite: true }), "acceptEdits"],
    ["Claude Code read-only", "claude-code", "default", classic({ workspaceWrite: false }), "manual"],
    ["Claude Code planning", "claude-code", "plan", classic(), "plan"],
    ["Claude Code stored with Codex's Full Access", "claude-code", "full-access", classic(), "auto"],
    ["Codex editing", "codex-cli", "default", classic({ workspaceWrite: true }), "workspace-write"],
    ["Codex read-only", "codex-cli", "default", classic({ workspaceWrite: false }), "read-only"],
    ["Codex Full Access", "codex-cli", "full-access", classic(), "full-access"],
    ["Codex in Plan from before", "codex-cli", "plan", classic(), "read-only", true],
    ["Antigravity editing", "gemini-cli", "default", classic({ workspaceWrite: true }), "accept-edits"]
  ];
  for (const [label, kind, mode, permissions, expected, plan] of cases) {
    const access = inCliOwnMode(kind, mode, permissions);
    assert.equal(selectedChatAccessOption(kind, access.agentMode, access.permissions)?.id, expected, label);
    assert.equal(codexPlanModeOn(kind, access.agentMode, access.permissions), plan === true, `${label}: Plan mode`);
    assert.equal(access.permissions.webAccess, true, `${label}: its other rights stay`);
    assert.equal(access.permissions.repoRead, permissions.repoRead, `${label}: reading stays`);
  }
  // Already in its CLI's own mode: as it is.
  const own = { ...defaultChatAgentPermissions(), cliApprovals: true as const, workspaceWrite: true };
  assert.deepEqual(inCliOwnMode("claude-code", "default", own), { agentMode: "default", permissions: normalizeChatAgentPermissions(own) });
});
