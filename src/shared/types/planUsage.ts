import type { ChatProviderKind } from "./providers";

/**
 * How much of the plan limits of a member's CLI account is used, as that CLI
 * reports it (Claude Code's `get_usage` and `rate_limit_event`, Codex's
 * `account/rateLimits/read` and `account/rateLimits/updated`, Antigravity's
 * `/usage`). One snapshot per CLI account on one device: every member of
 * that CLI there runs on it.
 */

/** A plan-limited CLI: an account with windows that reset. */
export type PlanUsageProvider = Extract<ChatProviderKind, "claude-code" | "codex-cli" | "gemini-cli">;

/** How a window stands: as its CLI says it (Claude Code's own warning), or,
 *  for a CLI that states none, from 75% used; `reached` once it refuses. */
export type PlanUsageTone = "normal" | "warning" | "reached";

export interface PlanUsageWindow {
  /** The CLI's own key for the window (`seven_day`, Codex's `primary`, an
   *  Antigravity bucket id). */
  id: string;
  /** Its title as the CLI shows it: "Current week (all models)", "5h limit",
   *  "Weekly". */
  label: string;
  /** Antigravity: the group of models that share it ("Gemini Models"); Codex:
   *  a named bucket's name. */
  group?: string;
  /** Claude Code: the model a model's own window counts ("Fable", "Sonnet");
   *  it applies only to members on that model. */
  model?: string;
  /** Share used, 0 to 100; none for a window not used yet. */
  usedPercent?: number;
  /** When it resets (ISO); none while it has not started. */
  resetsAt?: string;
  tone: PlanUsageTone;
}

/** An account fact the CLI reports beside its windows: extra usage, credits. */
export interface PlanUsageFact {
  label: string;
  value: string;
}

/** Antigravity: a group of models with their own windows. */
export interface PlanUsageGroup {
  name: string;
  /** The models in it, as `/usage` names them ("Gemini 4 Neon"). */
  models: string[];
}

export interface PlanUsageSnapshot {
  provider: PlanUsageProvider;
  /** A short hash of the account id the CLI reports (Codex), so two accounts
   *  are told apart without the id leaving the device. */
  accountKey?: string;
  /** "Max plan". */
  plan?: string;
  /** False: the CLI runs here without plan limits (an API key, Bedrock,
   *  Vertex, a Gemini API key), and there is no ring. */
  hasPlanLimits: boolean;
  windows: PlanUsageWindow[];
  /** The window the CLI itself puts first, when it says. */
  headlineId?: string;
  /** The account refuses requests now (the CLI says so). */
  refused?: boolean;
  groups?: PlanUsageGroup[];
  facts: PlanUsageFact[];
  observedAt: string;
}

/** What the desktop knows: this computer's accounts, and each machine's as
 *  that machine put them on the User's server. */
export interface PlanUsageView {
  local: PlanUsageSnapshot[];
  machines: Record<string, { snapshots: PlanUsageSnapshot[]; updatedAt: string }>;
}

/** What a refresh did: the view after it, and why nothing could be read
 *  for a machine (it was offline, or the User's server could not be
 *  reached), so its figures are its last ones. */
export interface PlanUsageRefreshResult {
  view: PlanUsageView;
  failed?: "machine-offline" | "server-unreachable";
}

/** Read again now: this computer's account of a CLI, or a machine's. */
export interface PlanUsageRefreshRequest {
  provider: PlanUsageProvider;
  machineId?: string;
  /** The User pressed Refresh (read sooner than an opened card would). */
  force?: boolean;
}
