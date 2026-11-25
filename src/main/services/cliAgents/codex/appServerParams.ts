import type {
  ChatAgentMode, ChatAgentPermissions, ChatReasoningEffort, ConversationKind, GitDiffMode, ParticipantConfig,
  ProviderReasoningEffortOption
} from "../../../../shared/types";
import { normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { codexPlanModeOn, withCodexPlanMode } from "../../../../shared/chatAccessModes";
import { agentEnvironmentKeyValidationError } from "../../../../shared/agentEnvironment";
import { chatReasoningEffortLabel, normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import { CODEX_APP_SERVER_MCP_TOKEN_ENV } from "../constants";
import { errorText } from "../runs/outputText";
import { asRecord, stringField } from "../runs/records";
import { agentModeForRun, permissionsForRun } from "../runs/runEnvironment";
import type { CliAgentImageInput, CliAgentRunOptions } from "../types";

const CODEX_AUTO_APPROVALS_REVIEWER = "auto_review";

export function codexModelReasoningEfforts(record: Record<string, unknown> | undefined): ProviderReasoningEffortOption[] {
  const values = Array.isArray(record?.supportedReasoningEfforts) ? record.supportedReasoningEfforts : [];
  const defaultReasoningEffort = normalizeChatReasoningEffort(stringField(record ?? {}, "defaultReasoningEffort"), "codex-cli");
  const options: ProviderReasoningEffortOption[] = [];
  for (const value of values) {
    const option = asRecord(value);
    const effort = normalizeChatReasoningEffort(stringField(option ?? {}, "reasoningEffort"), "codex-cli");
    if (!effort || options.some((item) => item.id === effort)) {
      continue;
    }
    options.push({
      id: effort,
      label: chatReasoningEffortLabel(effort),
      description: stringField(option ?? {}, "description"),
      recommended: effort === defaultReasoningEffort
    });
  }
  return options;
}

export function codexAppServerThreadStartParams(
  participant: ParticipantConfig,
  repoPath: string | undefined,
  kind: ConversationKind,
  options: CliAgentRunOptions
): Record<string, unknown> {
  const { mode, permissions } = codexRunAccess(kind, options);
  return {
    model: participant.model ?? null,
    cwd: repoPath ?? null,
    approvalPolicy: codexAppServerApprovalPolicy(mode, permissions),
    approvalsReviewer: codexAppServerApprovalsReviewer(mode, permissions),
    sandbox: codexAppServerSandbox(mode, permissions),
    config: codexAppServerConfig(participant, permissions, options),
    developerInstructions: options.role?.instructions ?? null,
    ephemeral: !options.persistSession,
    experimentalRawEvents: false,
    persistExtendedHistory: false
  };
}

export function codexAppServerThreadResumeParams(
  sessionId: string,
  participant: ParticipantConfig,
  repoPath: string | undefined,
  kind: ConversationKind,
  options: CliAgentRunOptions
): Record<string, unknown> {
  const { mode, permissions } = codexRunAccess(kind, options);
  return {
    threadId: sessionId,
    model: participant.model ?? null,
    cwd: repoPath ?? null,
    approvalPolicy: codexAppServerApprovalPolicy(mode, permissions),
    approvalsReviewer: codexAppServerApprovalsReviewer(mode, permissions),
    sandbox: codexAppServerSandbox(mode, permissions),
    config: codexAppServerConfig(participant, permissions, options),
    developerInstructions: options.role?.instructions ?? null,
    excludeTurns: true,
    persistExtendedHistory: false
  };
}

/** thread/fork: the copy gets this member's own settings, as a resume does. */
export function codexAppServerThreadForkParams(
  sourceThreadId: string,
  participant: ParticipantConfig,
  repoPath: string | undefined,
  kind: ConversationKind,
  options: CliAgentRunOptions
): Record<string, unknown> {
  return {
    ...codexAppServerThreadResumeParams(sourceThreadId, participant, repoPath, kind, options),
    ephemeral: !options.persistSession
  };
}

/**
 * A Codex member's mode and rights as Codex runs them, and whether its
 * Plan mode is on (src/shared/chatAccessModes.ts). A member stored in Plan
 * from before Plan was a toggle of its own (its mode "plan" in its own
 * mode) runs Codex's Read Only preset with Plan mode on, as its menu shows.
 */
export function codexRunAccess(kind: ConversationKind, options: CliAgentRunOptions): { mode: ChatAgentMode; permissions: ChatAgentPermissions; plan: boolean } {
  const raw = agentModeForRun(kind, options);
  const stored = normalizeChatAgentPermissions(options.permissions);
  if (kind !== "chat" || stored.cliApprovals !== true) {
    // Full Access is a mode of Codex's own, chosen in the User's menu (with
    // `cliApprovals`); anywhere else it is no wider than Auto.
    const mode: ChatAgentMode = raw === "full-access" ? "auto" : raw;
    return { mode, permissions: permissionsForRun("codex-cli", mode, options), plan: false };
  }
  const plan = codexPlanModeOn("codex-cli", raw, stored);
  const own = withCodexPlanMode(raw, stored, plan);
  return { mode: own.agentMode, permissions: permissionsForRun("codex-cli", own.agentMode, { ...options, permissions: own.permissions }), plan };
}

/** Codex asks (approval policy on-request, each ask an approval card) in
 *  Approve for me, where Codex reviews the asks itself first, and in its
 *  own Ask for approval and Read Only presets (the sessions view's access,
 *  `cliApprovals`); Full Access never asks (Codex 0.155.1's preset), nor do
 *  the classic controls and their Plan: what the sandbox does not allow
 *  fails. */
function codexAppServerApprovalPolicy(mode: ChatAgentMode, permissions?: ChatAgentPermissions): string {
  return mode === "auto" || (mode === "default" && permissions?.cliApprovals === true) ? "on-request" : "never";
}

/** Who reviews Codex's asks: Codex itself in Approve for me; the User in
 *  Ask for approval and Read Only, said explicitly so a reviewer set in the
 *  User's own Codex config (`approvals_reviewer`) does not turn the mode
 *  her menu shows into another one. */
function codexAppServerApprovalsReviewer(mode: ChatAgentMode, permissions: ChatAgentPermissions): string | null {
  if (mode === "auto") return CODEX_AUTO_APPROVALS_REVIEWER;
  return mode === "default" && permissions.cliApprovals === true ? "user" : null;
}

/** Codex's sandbox for the mode: Full Access's danger-full-access, else
 *  workspace-write with the file-edit right, read-only without it. */
function codexAppServerSandbox(mode: ChatAgentMode, permissions: ChatAgentPermissions): string {
  if (mode === "full-access") return "danger-full-access";
  return permissions.workspaceWrite ? "workspace-write" : "read-only";
}

export function codexReasoningEffort(value: ChatReasoningEffort | undefined): ChatReasoningEffort | undefined {
  return normalizeChatReasoningEffort(value, "codex-cli");
}

export function codexAppServerConfig(
  participant: ParticipantConfig,
  permissions: ChatAgentPermissions,
  options: CliAgentRunOptions
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    web_search: permissions.webAccess ? "live" : "disabled"
  };
  const reasoningEffort = codexReasoningEffort(participant.reasoningEffort);
  if (reasoningEffort) {
    config.model_reasoning_effort = reasoningEffort;
  }
  // Codex reads the User's shell profile again before each command
  // (shell_snapshot), and the profile's exports would win over the values
  // this process was started with. Its own policy wins over the profile, so
  // a value changed in Settings → Environment reaches the member's commands
  // too. Sent with the thread, not on the command line, so it is not in the
  // process list.
  for (const [key, value] of Object.entries(options.settingsEnv ?? {})) {
    if (typeof value === "string" && !agentEnvironmentKeyValidationError(key)) {
      config[`shell_environment_policy.set.${key}`] = value;
    }
  }
  if (options.appMcp) {
    config["mcp_servers.accord_agents.url"] = options.appMcp.url;
    config["mcp_servers.accord_agents.bearer_token_env_var"] = CODEX_APP_SERVER_MCP_TOKEN_ENV;
  }
  if (options.compactInstructions?.trim()) {
    config.compact_prompt = codexCompactPrompt(options.compactInstructions);
  } else if (options.clearCompactPrompt) {
    config.compact_prompt = null;
  }
  return config;
}

function codexCompactPrompt(instructions: string | undefined): string | null {
  const focus = instructions?.trim();
  if (!focus) {
    return null;
  }
  return [
    "Compact the conversation context for future turns. Preserve the information needed to continue accurately: user requirements, decisions, constraints, file paths, commands run, test results, open risks, and next steps.",
    "Pay special attention to this user focus instruction:",
    focus
  ].join("\n\n");
}

/** A Codex turn's input: the message's text and its pictures as Codex's
 *  own image input, as a picture pasted into its terminal goes (Codex
 *  0.171.0 records each as an input image). A message of pictures alone
 *  has no text item. */
export function codexAppServerTurnInput(prompt: string, images?: CliAgentImageInput[]): Array<Record<string, unknown>> {
  return [
    ...(prompt || !images?.length ? [{ type: "text", text: prompt, text_elements: [] }] : []),
    ...(images ?? []).map((image) => ({ type: "localImage", path: image.path }))
  ];
}

export function codexPrompt(
  prompt: string,
  repoPath: string | undefined,
  diffMode: GitDiffMode | undefined,
  kind: ConversationKind,
  options: CliAgentRunOptions = {}
): string {
  if (kind === "implementation-plan") {
    return [
      "You are running inside the selected repository in plan mode and read-only sandbox mode.",
      "Inspect files and git state as needed. Do not edit files, run mutating commands, install dependencies, or wait for terminal confirmation.",
      "If a blocking product or technical decision is needed, report it in the requested output format instead of asking interactively.",
      prompt
    ].join("\n\n");
  }

  if (kind === "chat") {
    // A chat turn is the member's message as it is: what the member may do
    // is in its developer instructions, said once (ChatService).
    return prompt;
  }

  const hasRepoContext = Boolean(repoPath) && (kind === "code-review" || Boolean(diffMode));

  return [
    hasRepoContext
      ? "You are running inside the selected repository in read-only mode. Inspect files and git state as needed. Do not edit files."
      : diffMode
        ? "Use the provided diff context. Do not inspect local files unless repository context is explicitly provided."
        : "Answer the user's question directly. Do not inspect local files unless context is explicitly provided.",
    diffMode ? `The user selected diff mode: ${diffMode}.` : "",
    prompt
  ]
    .filter(Boolean)
    .join("\n\n");
}

function insertCodexOptionBeforePrompt(args: string[], resuming: boolean, ...items: string[]): void {
  const promptIndex = resuming ? Math.max(args.length - 2, 2) : Math.max(args.length - 1, 1);
  args.splice(promptIndex, 0, ...items);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function isCodexDeveloperInstructionsUnsupported(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return (
    message.includes("developer_instructions") &&
    /unknown|invalid|unrecognized|unsupported|unexpected|failed to parse|configuration|config/.test(message)
  );
}
