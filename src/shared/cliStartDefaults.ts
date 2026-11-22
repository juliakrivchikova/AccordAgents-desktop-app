import { normalizeChatReasoningEffort } from "./reasoningEffort";
import type { ChatProviderKind, ChatReasoningEffort } from "./types";

/**
 * What a CLI starts a new session in with the User's own config, read on the
 * device that runs it (this computer, or a machine for the members that run
 * there): the mode, the model and the effort its terminal would start in
 * (the User, 2026-11-22: "a new session must start in the mode, model and
 * effort its CLI would start in with her config"). Read from the CLI itself
 * where it says (Codex's `config/read`, Claude Code's `initialize` and
 * `get_settings` answers), else from its settings file (agy's
 * `agentMode`); docs/main-session.md has the evidence.
 */
export interface CliStartDefaults {
  /** The mode by the CLI's own name (an id of chatAccessOptions); none when
   *  the config names one the CLI's own picker has no entry for, or it could
   *  not be read: the CLI's built-in default then. */
  access?: string;
  /** The model it runs when none is chosen, by the CLI's id. */
  model?: string;
  /** That model's name as the CLI lists it ("GPT-5.6-Luna"). */
  modelLabel?: string;
  /** The effort its config sets. */
  reasoningEffort?: ChatReasoningEffort;
}

export type CliStartDefaultsByKind = Partial<Record<ChatProviderKind, CliStartDefaults>>;

/** A model's name as a chip says it: its label without the id Codex repeats
 *  in brackets ("GPT-5.5 (gpt-5.5)" reads "GPT-5.5"); one rule for this
 *  computer's chips and what a machine says in its hello. */
export function modelNameWithoutId(label: string, id: string): string {
  const name = label.trim() || id;
  const repeated = ` (${id})`;
  return name.endsWith(repeated) && name.length > repeated.length ? name.slice(0, -repeated.length) : name;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The preset Codex 0.155.1's `/permissions` picker marks current for the
 * User's effective config (`config/read`), in a folder it trusts: its sandbox
 * (workspace-write when unset), approval policy (on-request when unset) and
 * reviewer (the User when unset; `guardian_subagent` is the old name of
 * `auto_review`). Any other combination is Codex's "Custom permissions",
 * which no preset is: none.
 */
export function codexStartAccess(config: { sandbox_mode?: unknown; approval_policy?: unknown; approvals_reviewer?: unknown } | undefined): string | undefined {
  if (!config) return undefined;
  const sandbox = text(config.sandbox_mode) ?? "workspace-write";
  const approval = text(config.approval_policy) ?? "on-request";
  const reviewer = text(config.approvals_reviewer) ?? "user";
  const autoReview = reviewer === "auto_review" || reviewer === "guardian_subagent";
  if (sandbox === "danger-full-access") return approval === "never" ? "full-access" : undefined;
  if (approval !== "on-request") return undefined;
  if (sandbox === "workspace-write") return autoReview ? "auto-review" : reviewer === "user" ? "workspace-write" : undefined;
  if (sandbox === "read-only") return reviewer === "user" ? "read-only" : undefined;
  return undefined;
}

/** The mode Claude Code 2.1.330 starts in, as its `initialize` answer says
 *  (`current_permission_mode`, from `permissions.defaultMode` in her
 *  settings): Manual for its internal `default`; none for Bypass
 *  Permissions and Don't Ask, which the composer does not offer. */
export function claudeStartAccess(permissionMode: unknown): string | undefined {
  const mode = text(permissionMode);
  if (mode === "default" || mode === "manual") return "manual";
  return mode === "acceptEdits" || mode === "plan" || mode === "auto" ? mode : undefined;
}

/** The mode agy 1.5.14 starts in (`-p` runs too) as its settings.json
 *  `agentMode` saves it ("" is Default). With none saved agy starts in Auto
 *  "wherever Auto mode is available and in Default elsewhere" (its
 *  changelog), and Auto depends on the account as well as the platform
 *  (`--mode auto` "is not available for this account" on hers, 2026-11-21),
 *  which the app cannot read: none then, so the CLI's built-in Default,
 *  which every account runs. */
export function antigravityStartAccess(settings: { agentMode?: unknown } | undefined): string | undefined {
  const saved = settings?.agentMode;
  if (saved === undefined || saved === null) return undefined;
  if (saved === "") return "default";
  const mode = text(saved);
  return mode === "accept-edits" || mode === "auto" || mode === "plan" || mode === "default" ? mode : undefined;
}

/** antigravityStartAccess from agy's settings.json text (none: no file); a
 *  file that is not a plain JSON object says nothing. */
export function antigravityStartAccessFromText(settingsText: string | undefined): string | undefined {
  if (settingsText === undefined) return undefined;
  try {
    const parsed = JSON.parse(settingsText.replace(/^\uFEFF/, "")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? antigravityStartAccess(parsed as { agentMode?: unknown }) : undefined;
  } catch {
    return undefined;
  }
}

/** Start defaults as they travel (a machine's hello, the phone's offer):
 *  known fields only, of the right shape. */
export function normalizeCliStartDefaults(value: unknown, kind: ChatProviderKind): CliStartDefaults | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const access = text(record.access);
  const model = text(record.model);
  const modelLabel = text(record.modelLabel);
  const reasoningEffort = normalizeChatReasoningEffort(text(record.reasoningEffort) as ChatReasoningEffort | undefined, kind);
  const result: CliStartDefaults = {
    ...(access ? { access } : {}),
    ...(model ? { model } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

const START_DEFAULT_KINDS: readonly ChatProviderKind[] = ["claude-code", "codex-cli", "gemini-cli"];

/** normalizeCliStartDefaults for every CLI of a hello or an offer. */
export function normalizeCliStartDefaultsByKind(value: unknown): CliStartDefaultsByKind | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result: CliStartDefaultsByKind = {};
  for (const kind of START_DEFAULT_KINDS) {
    const defaults = normalizeCliStartDefaults(record[kind], kind);
    if (defaults) result[kind] = defaults;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
