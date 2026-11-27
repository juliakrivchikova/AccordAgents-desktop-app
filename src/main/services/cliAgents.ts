import path from "node:path";
import type {
  AgentContextUsage, AgentDetectionRequest, AgentHealth, ChatProviderKind, CliProviderHost, ClaudeChromeSetting, ConversationKind,
  GitDiffMode, ParticipantConfig, PlanUsageProvider, PlanUsageSnapshot, ProviderModelCatalog
} from "../../shared/types";
import type { CliStartDefaultsByKind } from "../../shared/cliStartDefaults";
import { spawnCommand } from "./command";
import { CliReadinessService } from "./cliReadiness";
import { hasConfiguredHostPlatform, userDataPath } from "../platform";
import { NATIVE_PROCESS_REGISTRY_FILE } from "./nativeProcessRegistry";
import type { ParticipantRunResult } from "./providers";
import type { ClaudePermissionMode } from "./cliAgents/claude/permissionModes";
import {
  CLAUDE_MODEL_PROBE_DIR, type ClaudeModelProbeExpectSpawn, type ClaudeModelProbePtySpawn
} from "./cliAgents/models/claudeModelProbe";
import type { ClaudeSendNowOutcome, CliAgentCompactResult, CliAgentDebugLogger, CliAgentRunnerOptions, CliAgentRunOptions } from "./cliAgents/types";
import { createCliModules, type CliModules } from "./cliAgents/modules";

export { CLAUDE_PERMISSION_MODE_TIMEOUT_MS } from "./cliAgents/claude/claudeRuns";
export { CLAUDE_CODE_COMMAND_ENV_OPTIONS } from "./cliAgents/claude/commandEnvironment";
export { isCodexCollaborationModeRefusal, codexAppServerMessageKind, CodexAppServerRunError } from "./cliAgents/codex/appServerErrors";
export { CLAUDE_APP_MCP_TOOL_TIMEOUT_MS } from "./cliAgents/claude/launch";
export { COMPACTION_CANCELLED_BEFORE_START } from "./cliAgents/runs/cliRuns";
export { COMPACTION_CANCELLED } from "./cliAgents/claude/constants";
export { withCliStartModel, parseAgyModelList, agyModelsInvocation } from "./cliAgents/models/startDefaults";
export { antigravityExpectProgram, antigravityInteractiveGoalAtPrompt, antigravityInteractivePermissionPrompt } from "./cliAgents/gemini/goalTerminal";
export { resolveCodexCompactTimeoutMs } from "./cliAgents/codex/appServer/appServerTurns";
export { isForkSourceMissingError, forkCopyNotMade } from "./cliAgents/runs/forkSource";
export type { CliAgentImageInput, CliAgentTurnImages, CliAgentRunOptions, NativeGoalRun, CliAgentOutputKind, CliAgentOutputEvent, CliAgentOutputCallback, CliAgentSessionIdCallback, CliAgentCodexServerRequest, CliAgentCodexServerRequestCallback, CliAgentWarmOptions, CliAgentBackgroundTask, CliAgentReplyOrigin, CliAgentReplyStart, CliAgentSelfResumedTurn, CliAgentRoleOptions, CliAgentAppMcpOptions, CliAgentAppMcpClientStatus, CliAgentCompactResult, ClaudeSendNowOutcome } from "./cliAgents/types";
export { type ClaudePermissionMode, ClaudeControlError, isClaudeAutoModeRefusal, isClaudePermissionMode, CLAUDE_PERMISSION_MODE_LABELS, claudePermissionModeRank, claudeCodePermissionMode } from "./cliAgents/claude/permissionModes";
export { ClaudeFolderNotTrustedError, parseClaudeModelPickerOutput, claudeModelProbeEnv, resolveClaudeModelProbeCwd, probeClaudeModelsInFolder, runClaudeModelProbeWithExpect, runClaudeModelProbeInPty } from "./cliAgents/models/claudeModelProbe";
export { parseClaudeInitializeModels, claudeAppliedSettings, ClaudeModelListTimeoutError, runClaudeModelListProbe } from "./cliAgents/models/claudeModelList";
export { type GeminiMcpConfigEntry, syncGeminiMcpConfig, geminiMcpProxyLaunchArgs } from "./cliAgents/gemini/mcpProxyConfig";

/** Runs the members' CLIs (Claude Code, Codex, Antigravity). The work is done by the parts in ./cliAgents. */
export class CliAgentRunner {
  private readonly modules: CliModules;

  constructor(
    debugLogs?: CliAgentDebugLogger,
    manualReadinessEnvironment?: () => Promise<{ env: NodeJS.ProcessEnv; version?: string }>,
    codexExecutableOrOptions: string | CliAgentRunnerOptions = "codex",
    claudeModelProbePtySpawn?: ClaudeModelProbePtySpawn,
    claudeModelProbeExpectSpawn: ClaudeModelProbeExpectSpawn = spawnCommand
  ) {
    const options = typeof codexExecutableOrOptions === "string"
      ? { codexExecutable: codexExecutableOrOptions }
      : codexExecutableOrOptions;
    this.modules = createCliModules({
      debugLogs,
      manualReadinessEnvironment,
      claudeModelProbePtySpawn,
      claudeModelProbeExpectSpawn,
      nativeProcessDbPath: options.nativeProcessDbPath ?? (hasConfiguredHostPlatform() ? path.join(userDataPath(), NATIVE_PROCESS_REGISTRY_FILE) : undefined),
      claudeModelProbeDir: options.claudeModelProbeDir ?? (hasConfiguredHostPlatform() ? path.join(userDataPath(), CLAUDE_MODEL_PROBE_DIR) : undefined),
      codexExecutable: options.codexExecutable ?? "codex",
      electronAppPath: options.electronAppPath ?? process.argv[1],
      readiness: new CliReadinessService(debugLogs, {
        manualEnvironment: async () => (await manualReadinessEnvironment?.())?.env ?? {}
      })
    });
  }

  setRunTimeoutMs(timeoutMs: number): void {
    this.modules.cliRuns.setRunTimeoutMs(timeoutMs);
  }

  detectAgents(request?: AgentDetectionRequest): Promise<AgentHealth[]> {
    return this.modules.agentReadiness.detectAgents(request);
  }

  /** Readiness with only these CLIs checked (each one's fresh result reused,
   *  CliReadinessService.refreshKinds); every CLI is in the result. */
  detectAgentKinds(kinds: readonly ChatProviderKind[], request?: AgentDetectionRequest): Promise<AgentHealth[]> {
    return this.modules.agentReadiness.detectAgentKinds(kinds, request);
  }

  /** Told every readiness result, of every CLI or of some (the computer's
   *  usage signals). */
  setAgentsDetectedObserver(observer: ((agents: AgentHealth[]) => void) | undefined): void {
    this.modules.agentReadiness.setAgentsDetectedObserver(observer);
  }

  invalidateAgentReadiness(): number {
    return this.modules.agentReadiness.invalidateAgentReadiness();
  }

  /** What each CLI installed here starts a new session in with the User's
   *  own config (a machine says it in its hello): read with its model list. */
  cliStartDefaults(): Promise<CliStartDefaultsByKind | undefined> {
    return this.modules.modelCatalogs.cliStartDefaults();
  }

  listModelCatalog(kind: ChatProviderKind, configuredModel?: string, probeCwd?: string): Promise<ProviderModelCatalog> {
    return this.modules.modelCatalogs.listModelCatalog(kind, configuredModel, probeCwd);
  }

  run(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    return this.modules.cliRuns.run(participant, prompt, repoPath, diffMode, kind, signal, options);
  }

  compactSession(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<CliAgentCompactResult> {
    return this.modules.cliRuns.compactSession(participant, repoPath, diffMode, kind, signal, options);
  }

  hasActiveNativeWork(): boolean {
    return this.modules.cliRuns.hasActiveNativeWork();
  }

  /** Every deployment on this host shares one instance. Consulted before any
   * native work starts; admission also tells the other deployments that this
   * one is busy, in the same step, so a stop cannot commit around it. */
  setHostAdmission(gate: ((what: string) => Promise<{ admitted: true } | { admitted: false; reason: string }> | { admitted: true } | { admitted: false; reason: string }) | undefined): void {
    this.modules.cliRuns.setHostAdmission(gate);
  }

  /** Idle power-off must not race a queued turn/compaction. The caller can
   * release this gate only before committing its durable power-stop fence. */
  fenceIdleNativeAdmissions(): (() => void) | undefined {
    return this.modules.cliRuns.fenceIdleNativeAdmissions();
  }

  shutdownWarmAgents(): Promise<void> {
    return this.modules.warmAgents.shutdownWarmAgents();
  }

  /** The environment members get changed (Settings → Environment saved, or
   * a machine's settings imported). A member process started with other
   * values closes once it holds no work, so the member's next message resumes
   * its session in a new process with the new values (WarmEnvironment). A
   * turn in progress finishes on the process it started on. Nothing is
   * fenced: turns keep starting meanwhile. */
  environmentChanged(): Promise<void> {
    return this.modules.warmAgents.environmentChanged();
  }

  /** Archive/delete closes resident processes, while leaving provider session
   * files intact for a later unarchive. Other chats continue running. */
  closeConversationSessions(conversationId: string): Promise<void> {
    return this.modules.warmAgents.closeConversationSessions(conversationId);
  }

  terminateWarmAgentsImmediately(reason = "immediate shutdown"): void {
    this.modules.warmAgents.terminateWarmAgentsImmediately(reason);
  }

  /**
   * Reads the latest context usage from the CLI's own session log.
   *
   * By default a missing log is retried for a moment, because right after a turn
   * or a compaction the CLI may not have written it yet. `waitForLog: false`
   * reads once: opening a chat refreshes usage for every session it holds, and
   * the logs of old sessions are gone for good (Claude Code deletes them after
   * its cleanup period), so waiting there only delayed every open.
   */
  contextUsageForSession(
    participant: ParticipantConfig,
    sessionId: string | undefined,
    options: { waitForLog?: boolean; known?: AgentContextUsage } = {}
  ): Promise<AgentContextUsage | undefined> {
    return this.modules.sessionLogs.contextUsageForSession(participant, sessionId, options);
  }

  /** The models an Antigravity member on a Gemini API key provider can pick:
   *  agy lists other models on a key than on its sign-in. `undefined` = the
   *  provider is gone. */
  listHostModelCatalog(
    provider: { host: Pick<CliProviderHost, "id" | "label" | "baseUrl" | "updatedAt">; apiKey: string | undefined } | undefined
  ): Promise<ProviderModelCatalog> {
    return this.modules.modelCatalogs.listHostModelCatalog(provider);
  }

  /** Whether a live process of this member is answering, or about to start a
   *  reply on its own (Claude: a background task finished and the CLI answers
   *  it), before the chat has registered that reply as a run. */
  memberProcessAnswering(conversationId: string, participantId: string): boolean {
    return this.modules.warmAgents.memberProcessAnswering(conversationId, participantId);
  }

  /** How many compactions the member's Claude Code process ran since this was
   *  last asked, each told once: after one, Claude Code rebuilds its system
   *  prompt from the text that process was launched with, which may be older
   *  than the member's access now (ChatService says it again). */
  takeMemberClaudeCompactions(conversationId: string, participantId: string): number {
    return this.modules.warmAgents.takeMemberClaudeCompactions(conversationId, participantId);
  }

  /** Whether the member's live Claude Code process ran in auto mode (the CLI
   *  said so itself): the account has Claude Code's auto mode. */
  memberClaudeAutoModeAvailable(conversationId: string, participantId: string): boolean {
    return this.modules.warmAgents.memberClaudeAutoModeAvailable(conversationId, participantId);
  }

  /** The permission mode the member's live Claude Code process is in (the one
   *  memberClaudeControl talks to), as far as the app knows; undefined with
   *  none live here. */
  memberClaudePermissionMode(conversationId: string, participantId: string): ClaudePermissionMode | undefined {
    return this.modules.warmAgents.memberClaudePermissionMode(conversationId, participantId);
  }

  /** One of the CLI's own control requests, sent to the member's live Claude
   *  Code process: the one answering now, else any still open. Undefined when
   *  the member has no live Claude Code process on this device. */
  memberClaudeControl(
    conversationId: string,
    participantId: string,
    request: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown> | undefined> {
    return this.modules.warmAgents.memberClaudeControl(conversationId, participantId, request, timeoutMs, signal);
  }

  /** Send now on the member's live Claude Code process, as the CLI's own
   *  send-now; `unsupported` when it cannot (the caller stops the reply). */
  memberClaudeSendNow(conversationId: string, participantId: string, waitingRunId?: string, runningRunId?: string): Promise<ClaudeSendNowOutcome> {
    return this.modules.warmAgents.memberClaudeSendNow(conversationId, participantId, waitingRunId, runningRunId);
  }

  /** Where this device's Claude Code keeps its members' sessions (the
   *  environment members get decides it: CLAUDE_CONFIG_DIR on a machine). */
  claudeProjectsDirectory(): Promise<string> {
    return this.modules.claudeSettings.claudeProjectsDirectory();
  }

  /** Claude in Chrome as this computer's Claude Code has it (`/chrome`). */
  claudeChromeSetting(): Promise<ClaudeChromeSetting> {
    return this.modules.claudeSettings.claudeChromeSetting();
  }

  /** Changes "Enabled by default" through the CLI's own command. Members
   *  pick it up with their next turn once their process is idle. */
  setClaudeChromeEnabledByDefault(enabled: boolean): Promise<ClaudeChromeSetting> {
    return this.modules.claudeSettings.setClaudeChromeEnabledByDefault(enabled);
  }

  /** The plan usage of this device's CLI accounts, as their CLIs last
   *  reported it (cliAgents/usage/planUsage.ts). */
  planUsage(): PlanUsageSnapshot[] {
    return this.modules.planUsage.list();
  }

  /** Told every change of planUsage(). Reads happen only while someone listens. */
  onPlanUsageChanged(listener: (snapshots: PlanUsageSnapshot[]) => void): () => void {
    return this.modules.planUsage.onChanged(listener);
  }

  /** Reads one CLI's account again (a card opened, Refresh): not twice at
   *  once, and not again within a minute (ten seconds for Refresh). */
  async refreshPlanUsage(provider: PlanUsageProvider, force = false): Promise<PlanUsageSnapshot[]> {
    await this.modules.planUsage.refresh(provider, force);
    return this.modules.planUsage.list();
  }

  /** Retire every warm process of one member, e.g. when the credential it was
   *  started with is removed; otherwise it would linger until the idle timeout. */
  closeWarmAgents(conversationId: string, participantId: string, reason = "context-changed"): Promise<void> {
    return this.modules.warmAgents.closeWarmAgents(conversationId, participantId, reason);
  }
}
