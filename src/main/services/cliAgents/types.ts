import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ForkCutRequest } from "../forkCut";
import type {
  AgentContextUsage, ChatAgentActivityEvent, ChatAgentActivityKind, ChatAgentMode, ChatAgentPermissions, ParticipantConfig
} from "../../../shared/types";
import type { CapturedPosixProcess, PosixProcessRow } from "../processTermination";
import type { CodexInboundServerRequest } from "../codexApprovals";
import type { ParticipantRunResult } from "../providers";
import type { ClaudePermissionMode } from "./claude/permissionModes";

/** A picture sent with the message, given to the CLI as its own image input. */
export interface CliAgentImageInput {
  mimeType: string;
  /** The bytes, base64 (Claude Code's stream-json image block). */
  dataBase64: string;
  /** The file on this device (Codex app-server `localImage`). */
  path: string;
}

/** The pictures of the message a turn answers. A transport with image input
 *  (Claude Code's stream-json, Codex's app-server) gets them as images;
 *  any other gets `fallbackText` after the prompt, naming them for the
 *  app's attachment tools. */
export interface CliAgentTurnImages {
  items: CliAgentImageInput[];
  fallbackText: string;
}

export interface CliAgentRunOptions {
  persistSession?: boolean;
  sessionId?: string;
  /** A member made as a fork of another member's session (the main session
   *  delegating with start "fork"): with no sessionId of its own yet, its
   *  first turn starts from a copy of this session through the CLI's own
   *  fork (Claude `--resume <id> --fork-session`, Codex `thread/fork`) and
   *  reports the copy's new id. Both CLIs keep the source's system and
   *  developer instructions in the copy (verified on Claude Code 2.1.329 and
   *  Codex 0.155.1), so the caller tells the member who it is in the prompt. */
  forkFromSessionId?: string;
  /** Fork to new chat: the copy ends with the turn of the reply the User saw
   *  last (forkCut.ts). Claude Code reads the point from the source's
   *  transcript and forks with `--resume-session-at`; Codex forks with
   *  `lastTurnId`. When the point cannot be found the whole session is
   *  copied and the result says why (forkCutMissed). */
  forkCut?: ForkCutRequest;
  /** Claude Code: the assistant message the fork's copy ends at, read from
   *  forkCut (runClaude); not set by callers. */
  forkResumeAt?: string;
  /** Called as soon as a fork asked to end at a point (forkCut) is to copy
   *  the whole session instead, with why: before the turn runs, so the chat
   *  says it even if the app stops during the turn. */
  onForkCutMissed?: (reason: string) => void;
  compactInstructions?: string;
  clearCompactPrompt?: boolean;
  extraReadableDirs?: string[];
  resumeFallbackPrompt?: string;
  /** The session must be resumed: a session the CLI cannot find is an error
   *  (resumeOnlyMissError), never a clean start (an imported thread before
   *  its first turn, whose history is only in that session). */
  resumeOnly?: boolean;
  images?: CliAgentTurnImages;
  role?: CliAgentRoleOptions;
  appMcp?: CliAgentAppMcpOptions;
  /** Claude: start the CLI with `--chrome` (decided once per run from the
   *  CLI's own setting; part of the warm process key). */
  claudeChrome?: boolean;
  agentEnv?: NodeJS.ProcessEnv;
  /** Only the values from Settings → Environment (no added-provider keys):
   *  Codex gets them through its own shell policy, which is what wins over
   *  the shell profile it reads again before each command. */
  settingsEnv?: NodeJS.ProcessEnv;
  agentEnvKey?: string;
  /** The environment changes told before `agentEnv` was read
   *  (CliAgentRunner.environmentGeneration): a process started with it is
   *  judged by every change told after that read. */
  agentEnvGeneration?: number;
  warm?: CliAgentWarmOptions;
  onOutput?: CliAgentOutputCallback;
  onSessionId?: CliAgentSessionIdCallback;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
  timeoutMs?: number;
  allowEmptyContent?: boolean;
  nativeGoal?: NativeGoalRun;
  onProviderActivity?: () => void;
  onCodexServerRequest?: CliAgentCodexServerRequestCallback;
  /** Codex only: a request delivered now goes into the member's running turn
   *  (WarmAgentEntry.steer); told whether it did, before the reply ends. */
  steerIntoRunningTurn?: (outcome: "steered" | "not-steered") => void;
  /**
   * App-internal run that is not a participant turn: keep the user's MCP servers,
   * skills and subagents out of it. Used by the avatar studio.
   */
  isolated?: boolean;
}

export interface NativeGoalRun {
  name: "goal";
  objective: string;
}

export type CliAgentOutputKind = "tool" | "text";

export interface CliAgentOutputEvent {
  kind: CliAgentOutputKind;
  text: string;
  cumulative?: string;
  activityKind?: ChatAgentActivityKind;
  activityStatus?: ChatAgentActivityEvent["status"];
  activityDetail?: string;
  activityItemId?: string;
}

export type CliAgentOutputCallback = (event: CliAgentOutputEvent) => void;

export type CliAgentSessionIdCallback = (sessionId: string) => void;

export type CliAgentCodexServerRequest = CodexInboundServerRequest;

export type CliAgentCodexServerRequestCallback = (request: CliAgentCodexServerRequest) => Promise<unknown>;

export interface CliAgentWarmOptions {
  conversationId: string;
  participantId: string;
  contextKey: string;
  idleTimeoutMs: number;
  /** Claude: where background work started by this run belongs. Returned with
   *  the reply the CLI starts on its own when that work finishes. */
  origin?: CliAgentReplyOrigin;
  /** Claude: the CLI started a reply on its own while no message was pending
   *  (a background task finished, as in the dedicated CLI). The caller attaches
   *  to it to show and settle that reply; without a handler it is dropped. */
  onSelfResumedTurn?: (turn: CliAgentSelfResumedTurn) => void;
  /** Claude: the member's live background tasks changed (one started or
   *  finished, or the process ended with them). Always the full current list. */
  onBackgroundTasksChanged?: CliAgentBackgroundTasksCallback;
  /** Claude: the CLI handed this run's message to a step (it starts now, or
   *  joins the step that is running). Until then the process may still be
   *  working on an earlier message. */
  onReplyStarted?: (start?: CliAgentReplyStart) => void;
  /** Claude: this run's message was written to the CLI (it is in the CLI's
   *  queue from now on, in the order messages were written). */
  onMessageWritten?: () => void;
  /** Claude: after this run's reply ended, the CLI predicted the User's next
   *  prompt (`--prompt-suggestions`, as the dedicated CLI offers one in its
   *  input). Given only when the caller shows suggestions; the process is
   *  started with the flag only then and only when the CLI supports it. */
  onPromptSuggestion?: (suggestion: string) => void;
  /** Claude, a member in its CLI's own mode: the permission mode the member
   *  is in as its message goes into the live process (a mode the User picked
   *  after this run read its settings wins over the run's). Without it, the
   *  run's own mode. */
  permissionMode?: () => ClaudePermissionMode | undefined;
  /** Claude, a member in its CLI's own mode: a permission mode the CLI moved
   *  to itself (a plan the User approved moves it to the mode she picked),
   *  as its `system/status` says; never a mode the app asked for. Given to
   *  the process at its start. */
  onCliPermissionMode?: (mode: ClaudePermissionMode) => void;
}

/** A member's live background tasks, the full current list. With
 *  `environmentPending` its process still runs with the environment variables
 *  it started with, while members get other values now: it is replaced (and
 *  resumes the same session) once these tasks have finished. */
export type CliAgentBackgroundTasksCallback = (tasks: CliAgentBackgroundTask[], environmentPending?: boolean) => void;

/** A background task the CLI reports as live, with the reply that started it. */
export interface CliAgentBackgroundTask {
  id: string;
  label: string;
  /** When the CLI first reported it (ISO): its events carry no time. */
  startedAt: string;
  origin?: CliAgentReplyOrigin;
}

/** Opaque to the runner: identifies the chat reply whose run started work. */
export interface CliAgentReplyOrigin {
  runId: string;
  messageId: string;
  threadId?: string;
  chatThreadRootId?: string;
}

/** How the CLI started a reply's message. */
export interface CliAgentReplyStart {
  /** It was handed to the step that was running (sent mid-step): the reply
   *  that step was answering until now, when a message of the chat started
   *  that step (not for a step the CLI started on its own: its origin is the
   *  older reply whose background work finished). */
  joinedReply?: CliAgentReplyOrigin;
  /** When that running step began (epoch ms). Like the CLI's one spinner,
   *  the work counts from it. */
  joinedStepStartedAt?: number;
}

export interface CliAgentSelfResumedTurn {
  /** The reply that started the work that finished, when known. */
  origin?: CliAgentReplyOrigin;
  /** Bind output and Stop to this reply. Output produced before the call is
   *  replayed first; the promise settles at the step's result. */
  attach(handlers: {
    signal?: AbortSignal;
    onOutput?: CliAgentOutputCallback;
    onSessionId?: CliAgentSessionIdCallback;
  }): Promise<ParticipantRunResult>;
}

export interface CliAgentRoleOptions {
  name: string;
  description: string;
  instructions: string;
  promptFallbackPrompt: string;
}

export interface CliAgentAppMcpOptions {
  url: string;
  token: string;
  toolNames: string[];
  // Explicit app-owned subset that may bypass a provider classifier in Auto.
  // The caller derives this from the app tool registry; absent means deny by default.
  autoPreauthorizedToolNames?: string[];
  clientGenerationId?: string;
  clientStatus?: (clientGenerationId: string) => CliAgentAppMcpClientStatus | undefined;
}

export interface CliAgentAppMcpClientStatus {
  initialized: boolean;
  listedTools: boolean;
  requiredToolsPresent: boolean;
  missingToolNames: string[];
  errored: boolean;
  errorMessage?: string;
}

export interface CliAgentCompactResult {
  participant: ParticipantConfig;
  ok: boolean;
  sessionId?: string;
  contextUsage?: AgentContextUsage;
  providerNative?: boolean;
  content?: string;
  error?: string;
}

export interface CliAgentDebugLogger {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

export type ClaudePermissionDenialLayer =
  | "provider-native-permission-or-classifier"
  | "provider-sandbox-settings-or-os"
  | "unknown-provider-runtime";

/** What a Claude Code process did with Send now: the CLI's own answer;
 *  `not_at_cli` when it can but the message is still on its way to it (just
 *  sent: the caller asks again shortly); or `unsupported` (an older CLI, no
 *  reply running here), when the caller stops the reply for the message. */
export type ClaudeSendNowOutcome = "delivering" | "stopped" | "nothing_waiting" | "not_at_cli" | "unsupported";

export interface WarmAgentEntry {
  key: string;
  scopeKey: string;
  providerKind: ParticipantConfig["kind"];
  process: ChildProcessWithoutNullStreams;
  run: (
    prompt: string,
    signal?: AbortSignal,
    onOutput?: CliAgentOutputCallback,
    onSessionId?: CliAgentSessionIdCallback,
    timeoutMs?: number,
    nativeGoal?: NativeGoalRun,
    onCodexServerRequest?: CliAgentCodexServerRequestCallback,
    claude?: ClaudeWarmRunContext,
    /** Codex only: the message's pictures, as `localImage` input. */
    images?: CliAgentImageInput[]
  ) => Promise<ParticipantRunResult>;
  /** Claude only: no reply is waiting or running and no background task is
   *  live, so closing the process loses nothing. */
  isIdle?: () => boolean;
  /** Claude only: settles once isIdle() holds (or the process is gone). */
  whenIdle?: (signal?: AbortSignal) => Promise<void>;
  /** Claude only: no reply is waiting, running or about to start on its own;
   *  background tasks may still be running. */
  isReplyIdle?: () => boolean;
  /** Claude only: whether the CLI ever started a step in this process (it
   *  loaded its session, or made a fork's copy). */
  everStartedStep?: () => boolean;
  /** Claude only: settles once no reply is waiting, running or about to
   *  start on its own (or the process is gone); background tasks may still
   *  be running. */
  whenReplyIdle?: (signal?: AbortSignal) => Promise<void>;
  /** Claude only: the idle timeout of the last run, re-armed when the process
   *  becomes idle after work it did on its own. */
  idleTimeoutMs?: number;
  compact?: (instructions?: string, signal?: AbortSignal, onSessionId?: CliAgentSessionIdCallback) => Promise<CliAgentCompactResult>;
  /** Codex only: a message typed into the running turn, as Codex's own steer
   *  (`turn/steer`, Enter mid-turn in its CLI). The running reply ends there
   *  as a turn that goes on (`turnContinues`) and the rest of the turn is
   *  this message's reply, as Claude Code's transcript splits a step a
   *  message joined. Undefined when there is no turn to steer (none runs, it
   *  waits on an approval, or Codex refused it): the caller runs the message
   *  as a turn of its own. */
  steer?: (
    prompt: string,
    signal?: AbortSignal,
    onOutput?: CliAgentOutputCallback,
    onSessionId?: CliAgentSessionIdCallback,
    timeoutMs?: number,
    onCodexServerRequest?: CliAgentCodexServerRequestCallback,
    images?: CliAgentImageInput[]
  ) => Promise<Promise<ParticipantRunResult> | undefined>;
  /** Claude only: the context the live session holds now, as the CLI's own
   *  `/context` counts it (`get_context_usage`); after a `/compact`, the
   *  compacted figure. Undefined when the CLI does not answer it. */
  contextUsage?: (signal?: AbortSignal) => Promise<AgentContextUsage | undefined>;
  /** Claude only: one of the CLI's own control requests (`mcp_status`,
   *  `mcp_authenticate`, `mcp_reconnect`), answered while a reply runs too.
   *  Its response, or an error with the CLI's words. */
  control?: (request: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  /** Claude only: Send now on a message waiting behind the running reply, as
   *  the CLI's own send-now (`interrupt` with `send_now`, advertised as
   *  interrupt_send_now_v1): it stops no background task, and the CLI may
   *  take the message into the running step instead of ending it. With no
   *  waiting run named, every message waiting at the CLI counts. */
  sendNow?: (waitingRunId?: string, runningRunId?: string) => Promise<ClaudeSendNowOutcome>;
  /** Claude only: the capabilities the CLI announced on `system/init`. */
  cliCapabilities?: () => ReadonlySet<string>;
  /** Claude only: the member runs on the CLI's own sign-in (not an added
   *  provider), so the account's plan usage can be read through it. */
  ownSignIn?: boolean;
  /** Claude only: the permission mode the process is in, as far as the app
   *  knows: `--permission-mode` at its start, then each `set_permission_mode`
   *  it accepted and each mode the CLI reported itself (its `system` events). */
  permissionMode?: () => string | undefined;
  /** Claude only: the process ran in Claude Code's auto mode (the CLI said
   *  so itself), so the account has it. */
  autoModeSeen?: () => boolean;
  /** Claude only: the CLI's figures for the last compaction it ran. */
  lastCompactBoundary?: () => ClaudeCompactBoundary | undefined;
  queue: Promise<void>;
  /** Runs admitted on this process and not yet settled (queued ones too). */
  activeRuns?: number;
  /** Claude only: tells its background tasks again, whether its environment
   *  is now outdated (WarmAgents.environmentChanged) included. */
  refreshBackgroundReport?: () => void;
  /** Turns routed into this process with the environment it started with
   *  (WarmAgents.withBusyMemberEnvironment) and not yet over: it is not
   *  replaced for a changed environment under them. */
  environmentHolds?: number;
  /** The environment change (WarmEnvironment.currentGeneration) its process
   *  started after: only a later change can find it outdated. */
  environmentGeneration?: number;
  idleTimer?: NodeJS.Timeout;
  closed: boolean;
  /** Set when the process can no longer carry another turn cleanly (an error
   *  result with nothing else running, or a Stop the CLI never acknowledged).
   *  The next run replaces the process. */
  unusable?: boolean;
  /** Claude only: true while the CLI reports background tasks running, so
   *  shutdown ends stdin first and lets the CLI kill them itself (SIGTERM alone
   *  leaves their shells running in their own process group). */
  hasLiveBackgroundWork?: () => boolean;
  /** Claude only: stable identities captured while background tasks were live,
   *  retained across an unexpected provider exit so reparented work can still
   *  be terminated without risking a recycled PID. */
  capturedBackgroundProcesses?: () => CapturedPosixProcess[];
  refreshCapturedBackgroundProcesses?: (rows: Map<number, PosixProcessRow>) => void;
  /** Claude only: a step is running or a task event just arrived, so new
   *  descendants may be appearing and the tree is sampled at full rate. */
  captureUrgent?: () => boolean;
  processIdentity?: () => CapturedPosixProcess | undefined;
}

export interface ClaudeWarmRunContext {
  origin?: CliAgentReplyOrigin;
  onSelfResumedTurn?: (turn: CliAgentSelfResumedTurn) => void;
  onBackgroundTasksChanged?: CliAgentBackgroundTasksCallback;
  onReplyStarted?: (start?: CliAgentReplyStart) => void;
  onMessageWritten?: () => void;
  onPromptSuggestion?: (suggestion: string) => void;
  allowEmptyContent?: boolean;
  roleRuntime?: ParticipantRunResult["roleRuntime"];
  /** The message's pictures, as image blocks of the user message. */
  images?: CliAgentImageInput[];
  /** The reply answers a slash command (`/compact`): it reports no usage of
   *  its own and none is read from the session log (the caller asks the CLI),
   *  and what the CLI printed counts as its text although the result is empty. */
  localCommand?: boolean;
}

/** One reply of a warm Claude process: the model output of the step that
 *  consumed one message, or of a step the CLI started on its own, up to its
 *  `result`. Background work a reply starts belongs to the process, not to the
 *  reply, exactly as in the dedicated CLI: the reply ends at its result and the
 *  work keeps running. */
export interface ClaudeWarmReply {
  /** The uuid stamped on the user message this reply answers; the CLI reports
   *  its queue state under this id (`command_lifecycle`). Undefined for a step
   *  the CLI started itself (a background task finished while it was idle). */
  commandUuid?: string;
  prompt?: string;
  /** The message's pictures, sent as image blocks with its text. */
  images?: CliAgentImageInput[];
  /** Written to the CLI's stdin. Only an older CLI that reports no command
   *  lifecycle keeps later messages here until the current one has finished. */
  written: boolean;
  /** The model step carrying this reply is running. */
  started: boolean;
  settled: boolean;
  /** Stop was requested: an interrupt (running) or a queue removal (waiting). */
  stopRequested: boolean;
  /** Send now was pressed on a message waiting behind this running reply (the
   *  CLI's send-now): if the CLI cuts the step for that message, this reply
   *  ends with what it wrote and the member's turn goes on in that message's
   *  reply. It was not stopped. */
  sentNow?: boolean;
  startedAt: number;
  messages: string[];
  streamedText: string;
  nextTextBlockStartsBlock: boolean;
  resultEvents: unknown[];
  /** The uuid of the reply's last assistant message in the session (not a
   *  subagent's): where its session stood when it ended (sessionCut). */
  lastAssistantUuid?: string;
  sessionId?: string;
  model?: string;
  /** The context of the reply's latest main-thread model call, the model
   *  that made it, and the CLI's window for that model (cliContextUsage). */
  usedTokens?: number;
  contextModel?: string;
  contextWindowTokens?: number;
  /** Where background work started by this reply belongs (see CliAgentReplyOrigin). */
  origin?: CliAgentReplyOrigin;
  roleRuntime?: ParticipantRunResult["roleRuntime"];
  allowEmptyContent: boolean;
  localCommand?: boolean;
  timer?: NodeJS.Timeout;
  stopTimer?: NodeJS.Timeout;
  detachSignal?: () => void;
  /** Output of a self-started reply produced before the app attached to it. */
  buffered?: CliAgentOutputEvent[];
  /** A self-started reply the app has not been told of yet: tells it. */
  offer?: () => void;
  /** When the CLI step this reply is answering began (epoch ms): when the CLI
   *  started its message, or, for one handed to a running step, that step's. */
  stepStartedAt?: number;
  onStarted?: (start?: CliAgentReplyStart) => void;
  onWritten?: () => void;
  /** Receives the CLI's next-prompt suggestion if this reply ends well. */
  onPromptSuggestion?: (suggestion: string) => void;
  onOutput?: CliAgentOutputCallback;
  onSessionId?: CliAgentSessionIdCallback;
  resolve: (result: ParticipantRunResult) => void;
  reject: (error: Error) => void;
}

export interface ClaudeCompactBoundary {
  /** How many compactions this process has reported. */
  count: number;
  postTokens?: number;
}

export interface CodexAppServerPendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export interface CliAgentRunnerOptions {
  codexExecutable?: string;
  electronAppPath?: string;
  nativeProcessDbPath?: string;
  claudeModelProbeDir?: string;
}
