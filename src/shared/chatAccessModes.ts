import { chatAgentModeForKind, normalizeChatAgentMode, normalizeChatAgentPermissions } from "./agentPermissions";
import type { ChatAgentMode, ChatAgentPermissions, ChatProviderKind } from "./types";

/**
 * A member's permission mode in its CLI's own terms, as the sessions view's
 * composer lists it on the desktop and the phone (the User, 2026-11-21: "the
 * modes themselves, they don't match"). Each table is the set the CLI offers
 * by default, in its own order, named and described in the vendor's own
 * words (verified in the CLIs on 2026-11-22, docs/main-session.md):
 *
 * - Claude Code 2.1.330 (`--permission-mode`; Shift+Tab cycles Manual,
 *   Accept edits, Plan and, where the account has it, Auto; Bypass needs
 *   `--allow-dangerously-skip-permissions` and Don't Ask is not in the
 *   cycle): names and descriptions as the Claude desktop app's Code sessions
 *   list them.
 * - Codex 0.155.1 (its `/permissions` picker): Ask for approval, Approve for
 *   me (auto-review), Full Access, with the picker's descriptions. Read Only
 *   is still one of its presets but not in the picker: it shows only while a
 *   member is in it. Plan mode is Codex's collaboration mode (`/plan`,
 *   Shift+Tab), on top of any of these, not one of them.
 * - Antigravity 1.5.14 (`agy --mode`, its Default being `agentMode: ""`;
 *   Shift+Tab cycles Default, Accept-edits mode, Auto mode, Plan mode): the
 *   descriptions of its `/config` → Agent Mode. The app runs `agy --print`,
 *   which cannot ask, so what a mode would ask about is refused
 *   (docs/parity-requirements.md, known divergences); the menu says so.
 *
 * Each mode runs the CLI in that mode (`cliApprovals`, the app's mode and the
 * file-edit right): cliAgents.ts (claudePermissionMode, claudeToolConfig,
 * codexAppServerApprovalPolicy, codexAppServerSandbox, codexCollaborationMode)
 * and geminiExec.ts (geminiModeArgs) carry the mapping out.
 */
export interface ChatAccessOption {
  /** The CLI's own name for the mode (what the phone's New chat sends;
   *  members store the mode and rights it amounts to). */
  id: string;
  label: string;
  /** The vendor's own description; none where it gives none. */
  detail?: string;
  agentMode: ChatAgentMode;
  /** For the ordinary mode: whether it edits files without asking. */
  workspaceWrite?: boolean;
  /** Not offered: shown only while it is the member's mode (Codex's Read
   *  Only). */
  hidden?: boolean;
}

/** A CLI's modes as its own menu shows them. */
export interface ChatAccessModeSet {
  /** The menu's title in the vendor's words. */
  title: string;
  options: ChatAccessOption[];
  /** A stated divergence, said under the list (Antigravity cannot ask). */
  note?: string;
  /** Codex's Plan mode: a toggle of its own, beside the permissions, named
   *  as Codex names it ("Plan mode (shift+tab to cycle)"). */
  plan?: { label: string };
}

const CLAUDE_ACCESS: ChatAccessModeSet = {
  title: "Permission mode",
  options: [
    { id: "manual", label: "Manual", detail: "Always ask before making changes", agentMode: "default", workspaceWrite: false },
    { id: "acceptEdits", label: "Accept edits", detail: "Automatically accept all file edits", agentMode: "default", workspaceWrite: true },
    { id: "plan", label: "Plan", detail: "Create a plan before making changes", agentMode: "plan" },
    { id: "auto", label: "Auto", detail: "Claude handles permission decisions", agentMode: "auto" }
  ]
};

const CODEX_ACCESS: ChatAccessModeSet = {
  title: "Permissions",
  options: [
    {
      id: "workspace-write",
      label: "Ask for approval",
      detail: "Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files.",
      agentMode: "default",
      workspaceWrite: true
    },
    { id: "auto-review", label: "Approve for me", detail: "Only ask for actions detected as potentially unsafe.", agentMode: "auto" },
    {
      id: "full-access",
      label: "Full Access",
      detail: "Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.",
      agentMode: "full-access"
    },
    {
      id: "read-only",
      label: "Read Only",
      detail: "Codex can read files in the current workspace. Approval is required to edit files or access the internet.",
      agentMode: "default",
      workspaceWrite: false,
      hidden: true
    }
  ],
  plan: { label: "Plan mode" }
};

const ANTIGRAVITY_ACCESS: ChatAccessModeSet = {
  title: "Agent Mode",
  options: [
    { id: "default", label: "Default", detail: "Standard behavior.", agentMode: "default", workspaceWrite: false },
    { id: "accept-edits", label: "Accept-edits mode", detail: "Auto-approve file edits, prompt for commands.", agentMode: "default", workspaceWrite: true },
    { id: "auto", label: "Auto mode", detail: "Auto-approve edits and safe commands, prompt on irreversible actions.", agentMode: "auto" },
    { id: "plan", label: "Plan mode", detail: "Research and plan without making changes.", agentMode: "plan" }
  ],
  note: "Antigravity cannot ask for approval here, so what a mode would prompt for is refused."
};

/**
 * What Codex asks before it switches to Full Access, in its own words: its
 * `/permissions` picker, Codex 0.155.1 in a terminal (2026-11-22), shows
 * this in place of the list, and only "Yes, continue anyway" switches;
 * "Cancel" (or Esc) goes back without it. Starting in Full Access from her
 * own config asks nothing, as Codex does not.
 */
export const FULL_ACCESS_CONFIRMATION = {
  title: "Enable full access?",
  body: "When Codex runs with full access, it can edit any file on your computer and run commands with network, without your approval. Exercise caution when enabling full access. This significantly increases the risk of data loss, leaks, or unexpected behavior.",
  confirm: { label: "Yes, continue anyway", detail: "Apply full access for this session" },
  cancel: { label: "Cancel", detail: "Go back without enabling full access" }
} as const;

/** Why a member cannot be given Codex's Full Access or Plan mode where it
 *  runs: a machine whose program is from before they existed (its last
 *  hello says nothing of them) would run Full Access as Ask for approval and
 *  drop Plan mode. None on this computer or where they run. */
export function codexModesUnavailableReason(
  member: { kind: ChatProviderKind; homeMachineId?: string },
  machine: { name?: string; lastHello?: { cliModesSupported?: boolean } } | undefined
): string | undefined {
  if (member.kind !== "codex-cli" || !member.homeMachineId) return undefined;
  if (machine?.lastHello?.cliModesSupported === true) return undefined;
  return `${machine?.name ?? "Its machine"} runs an older program: Settings → Machines → Upgrade runtime.`;
}

/** Ids the app stored before a mode was renamed, and the mode they are now
 *  (Claude Code 2.1.330 calls its Default mode Manual). Codex's Plan mode,
 *  once listed among its permissions, is its own toggle now: its old id is
 *  Read Only with Plan mode on (applyChatAccessOptionById). */
const RENAMED_ACCESS_IDS: Partial<Record<ChatProviderKind, Record<string, string>>> = {
  "claude-code": { default: "manual" }
};

export function chatAccessModeSet(kind: ChatProviderKind): ChatAccessModeSet {
  return kind === "claude-code" ? CLAUDE_ACCESS : kind === "codex-cli" ? CODEX_ACCESS : ANTIGRAVITY_ACCESS;
}

/** The modes a CLI offers (its hidden ones left out). */
export function chatAccessOptions(kind: ChatProviderKind): ChatAccessOption[] {
  return chatAccessModeSet(kind).options.filter((option) => !option.hidden);
}

/** The modes its menu lists for a member: the offered ones, and a hidden one
 *  while it is the member's own. */
export function chatAccessMenuOptions(kind: ChatProviderKind, selected: ChatAccessOption | undefined): ChatAccessOption[] {
  return chatAccessModeSet(kind).options.filter((option) => !option.hidden || option.id === selected?.id);
}

/** A stored or sent mode id as the CLI names it now. */
export function currentChatAccessId(kind: ChatProviderKind, id: string | undefined): string | undefined {
  return id ? RENAMED_ACCESS_IDS[kind]?.[id] ?? id : undefined;
}

/** The mode a CLI starts in without settings of the User's: Claude Code's
 *  Manual, Codex's Ask for approval (the preset its picker marks current for
 *  a folder it trusts) and agy's Default. A new main session starts in the
 *  one her own config starts the CLI in (startChatAccessOption); this one
 *  only when that cannot be read. */
export function defaultChatAccessOption(kind: ChatProviderKind): ChatAccessOption {
  const options = chatAccessOptions(kind);
  const id = kind === "codex-cli" ? "workspace-write" : kind === "claude-code" ? "manual" : "default";
  return options.find((option) => option.id === id) ?? options[0]!;
}

/** The mode a new main session starts in: the one the User's own config
 *  starts its CLI in on the device that runs it (`access`, CliStartDefaults,
 *  src/shared/cliStartDefaults.ts) when the composer offers it, else the
 *  CLI's built-in default. */
export function startChatAccessOption(kind: ChatProviderKind, access: string | undefined): ChatAccessOption {
  const id = currentChatAccessId(kind, access);
  return chatAccessModeSet(kind).options.find((option) => option.id === id && (!option.hidden || option.id === "read-only")) ??
    defaultChatAccessOption(kind);
}

/** Whether Codex's Plan mode is on for a member in its own mode (a member
 *  stored with Codex's Plan as its mode, from before Plan was a toggle,
 *  counts). */
export function codexPlanModeOn(kind: ChatProviderKind, agentMode: ChatAgentMode | undefined, permissions: ChatAgentPermissions | undefined): boolean {
  if (kind !== "codex-cli") return false;
  const normalized = normalizeChatAgentPermissions(permissions);
  return normalized.cliApprovals === true && (normalized.codexPlanMode === true || normalizeChatAgentMode(agentMode) === "plan");
}

/** The mode a member's settings amount to; none when they are not one of
 *  its CLI's modes (rights set in the classic view's controls). A Codex
 *  member stored in Plan from before is Read Only (its Plan mode on). */
export function selectedChatAccessOption(
  kind: ChatProviderKind,
  agentMode: ChatAgentMode | undefined,
  permissions: ChatAgentPermissions | undefined
): ChatAccessOption | undefined {
  const normalized = normalizeChatAgentPermissions(permissions);
  if (!normalized.cliApprovals) {
    return undefined;
  }
  const options = chatAccessModeSet(kind).options;
  const mode = chatAgentModeForKind(kind, agentMode);
  if (kind === "codex-cli" && mode === "plan") {
    return options.find((option) => option.id === "read-only");
  }
  if (mode !== "default") {
    return options.find((option) => option.agentMode === mode);
  }
  return options.find((option) => option.agentMode === "default" && option.workspaceWrite === normalized.workspaceWrite);
}

/** Rights set from the classic controls (Read Files, Edit Files, Run Shell,
 *  Access Web): the classic meaning wins, so the member leaves its CLI's own
 *  mode (`cliApprovals`, and Codex's Plan mode with it) and what is off is
 *  refused, never asked about; the picker then shows "Custom". Antigravity's
 *  own mode is what holds it back (geminiExec.ts: without it, granted edits
 *  skip every agy confirmation), so leaving it never keeps its edits unless
 *  this very toggle turns them on: it runs read-only (`--sandbox`) instead. */
export function withClassicChatPermissions(
  permissions: ChatAgentPermissions | undefined,
  patch: Partial<ChatAgentPermissions>,
  kind?: ChatProviderKind
): ChatAgentPermissions {
  const current = normalizeChatAgentPermissions(permissions);
  const { cliApprovals: _ownMode, codexPlanMode: _plan, ...classic } = { ...current, ...patch };
  if (kind === "gemini-cli" && current.cliApprovals && patch.workspaceWrite !== true) {
    return { ...classic, workspaceWrite: false };
  }
  return classic;
}

/** The mode and rights a member gets with this option: its CLI's own mode
 *  (`cliApprovals`) and, for the ordinary mode, the file-edit right; every
 *  other right (reading, shell and its rules, web, asking and managing
 *  members) stays as it was, Codex's Plan mode too (it is its own toggle). */
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

/** A Codex member's settings with its Plan mode on or off, in its own mode:
 *  a member stored in Plan from before keeps Read Only, now with the toggle. */
export function withCodexPlanMode(
  agentMode: ChatAgentMode | undefined,
  permissions: ChatAgentPermissions | undefined,
  on: boolean
): { agentMode: ChatAgentMode; permissions: ChatAgentPermissions } {
  const mode = normalizeChatAgentMode(agentMode);
  const { codexPlanMode: _plan, ...rest } = { ...normalizeChatAgentPermissions(permissions), cliApprovals: true as const };
  const base = mode === "plan" ? { ...rest, workspaceWrite: false } : rest;
  return {
    agentMode: mode === "plan" ? "default" : mode,
    permissions: on ? { ...base, codexPlanMode: true } : base
  };
}

/** A member's settings with its CLI's mode set by its id (an id from before
 *  a rename taken as the mode it is now); the mode the CLI starts in for an
 *  id it does not have. `plan`: Codex's Plan mode on (the phone's toggle); Codex's
 *  old "plan" id is Read Only with it on. */
export function applyChatAccessOptionById(
  kind: ChatProviderKind,
  id: string | undefined,
  permissions: ChatAgentPermissions | undefined,
  plan?: boolean,
  /** The mode the User's own config starts the CLI in where it runs (the
   *  fallback for an id it does not have): startChatAccessOption. */
  startAccess?: string
): { agentMode: ChatAgentMode; permissions: ChatAgentPermissions } {
  const legacyCodexPlan = kind === "codex-cli" && id === "plan";
  const wanted = legacyCodexPlan ? "read-only" : currentChatAccessId(kind, id);
  const option = chatAccessModeSet(kind).options.find((candidate) => candidate.id === wanted) ?? startChatAccessOption(kind, startAccess);
  const applied = applyChatAccessOption(option, permissions);
  if (kind !== "codex-cli") {
    const { codexPlanMode: _plan, ...rest } = applied.permissions;
    return { agentMode: applied.agentMode, permissions: rest };
  }
  return withCodexPlanMode(applied.agentMode, applied.permissions, plan === true || legacyCodexPlan);
}
