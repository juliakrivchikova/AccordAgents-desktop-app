import type { ChatProviderKind, ProviderKind } from "./providers";
import type { AppSkillSyncHealth } from "./skills";

export interface AgentHealth {
  kind: Extract<ProviderKind, "codex-cli" | "claude-code" | "gemini-cli">;
  label: string;
  installed: boolean;
  version?: string;
  detection?: AgentDetectionState;
  runnable?: AgentRunnableState;
  authentication?: AgentAuthenticationState;
  diagnosticCode?: AgentReadinessDiagnosticCode;
  checking?: boolean;
  lastCheckedAt?: string;
  generation?: number;
  platform?: AgentPlatform;
  appSkillSync?: AppSkillSyncHealth;
}

/** A CLI whose own sign-in the app can start on this computer. Antigravity
 *  has no sign-in command; it is signed in from its own app. */
export type CliSignInKind = Extract<ChatProviderKind, "claude-code" | "codex-cli">;

export type CliSignInStatus = "starting" | "waiting" | "checking-code" | "succeeded" | "failed" | "cancelled";

/** One sign-in the CLI runs on this computer. The CLI opens the browser and
 *  keeps the credentials; the app only starts it and shows where it is. */
export interface CliSignInState {
  kind: CliSignInKind;
  requestId: string;
  status: CliSignInStatus;
  /** Higher is newer; an update with a lower revision is stale. */
  revision: number;
  /** The page the CLI printed for when the browser did not open. */
  pageUrl?: string;
  /** That page ends with a code the CLI reads back (Claude's). */
  pageGivesCode?: boolean;
  /** Why it failed, in the CLI's words when it said. */
  message?: string;
}

export type AgentDetectionState = "detected" | "not-detected" | "unknown";

export type AgentPlatform = "darwin" | "linux" | "win32" | "other";

export type AgentRunnableState = "ready" | "failed" | "unknown";

export type AgentAuthenticationState = "ready" | "required" | "unknown";

export type AgentReadinessState =
  | "not-detected"
  | "failed-to-run"
  | "sign-in-required"
  | "could-not-verify"
  | "ready"
  | "disabled"
  | "checking";

export type AgentReadinessDiagnosticCode =
  | "environment-check-failed"
  | "not-detected"
  | "failed-to-run"
  | "auth-required"
  | "auth-check-failed"
  | "probe-timeout";

export interface AgentDetectionRequest {
  force?: boolean;
  trigger?: "initial" | "focus" | "manual" | "submit" | "provider-enabled" | "service";
}
