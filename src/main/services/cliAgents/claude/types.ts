import type { ClaudeToolActivityContext } from "../../cliToolActivity";
import type { ClaudePermissionMode } from "./permissionModes";
import type {
  ClaudeCompactBoundary, ClaudePermissionDenialLayer, ClaudeWarmReply, CliAgentBackgroundTask, CliAgentOutputEvent,
  CliAgentReplyOrigin, CliAgentSelfResumedTurn
} from "../types";

export interface ClaudePermissionDenialDiagnostic {
  toolName: string;
  layer: ClaudePermissionDenialLayer;
  decisionCode: string;
  missingEvidence?: string[];
}

/** Process-level state of one warm Claude process. */
export interface ClaudeWarmProcessState {
  /** Unsettled replies in the order they were submitted or started. */
  replies: ClaudeWarmReply[];
  /** Set at the first step this process starts. */
  everStartedStep?: boolean;
  /** The reply receiving the running model step's output. */
  active?: ClaudeWarmReply;
  /** True from a step's start (`system/init`, a command `started`, or any of
   *  its own output) until its `result`. */
  stepActive: boolean;
  /** The CLI stamps queue state on uuid-stamped messages (`command_lifecycle`,
   *  verified on Claude Code 2.1.280). Until it is seen, messages are written
   *  one at a time, as before. */
  lifecycleSupported: boolean;
  /** Background tasks (`Agent`/`Bash` with `run_in_background`) the CLI
   *  reports as live, keyed by task id. */
  backgroundTasks: Map<string, string>;
  /** Descriptions of every background task seen, kept after the task leaves the
   *  live list so its notification can still be named. */
  backgroundTaskLabels: Map<string, string>;
  backgroundTaskOrigins: Map<string, CliAgentReplyOrigin | undefined>;
  /** When each task was first reported (ISO), foreground ones too, until
   *  its notification says it ended: "running 3m" in the app. */
  backgroundTaskStartedAt: Map<string, string>;
  /** Tasks whose notification already arrived; a stale `background_tasks_changed`
   *  ordered after it must not resurrect them. */
  finishedTaskIds: Set<string>;
  /** "Background task finished" rows for tasks that ended while no step was
   *  running; shown in the reply the CLI starts for them. */
  pendingNotices: CliAgentOutputEvent[];
  /** Origin for the next self-started step: the work that finished last. */
  idleOrigin?: CliAgentReplyOrigin;
  lastOrigin?: CliAgentReplyOrigin;
  sessionId?: string;
  model?: string;
  onSelfResumedTurn?: (turn: CliAgentSelfResumedTurn) => void;
  onBackgroundTasksChanged?: (tasks: CliAgentBackgroundTask[]) => void;
  /** What was last reported through onBackgroundTasksChanged. */
  reportedBackgroundTasks: string;
  /** Where the CLI's next `prompt_suggestion` goes: the reply that ended last,
   *  until a step starts (the CLI drops a pending suggestion then, too). */
  promptSuggestionTarget?: (suggestion: string) => void;
  /** control_request ids sent for a queued reply's removal. */
  cancelRequests: Map<string, ClaudeWarmReply>;
  /** When the CLI last reported a background task event. */
  lastTaskEventAt: number;
  /** A task finished while the model was idle: the CLI is about to start a
   *  step for it, so the process counts as busy until then (bounded). */
  selfResumeExpectedUntil: number;
  /** The reply an interrupt was sent for, until a step ends after it. A step
   *  the interrupt reached instead (the next message, started as the Stop was
   *  on its way) is reported as stopped with it, not as a failure. */
  interruptTarget?: ClaudeWarmReply;
  interruptRequestId?: string;
  /** The error the CLI reported outside any reply, kept for what its end is
   *  said to be (a session it could not load, then exit code 1). */
  errorOutsideReply?: string;
  /** What it last wrote to stderr since a step began. */
  stderr?: string;
  /** control_request ids of our own questions to the CLI, and who waits. */
  controlWaiters: Map<string, (response: Record<string, unknown> | undefined) => void>;
  /** What the CLI said about the last compaction of this session, numbered,
   *  so a /compact that compacted nothing is told from one that did. */
  lastCompactBoundary?: ClaudeCompactBoundary;
  /** The session's folder and MCP servers, as its `system/init` said: a tool
   *  row names paths and servers the way the CLI's transcript does. */
  toolContext: ClaudeToolActivityContext;
  /** The member this process runs (WarmAgents.claudeCompactionsUnreported). */
  scopeKey: string;
  /** The session's permission mode (WarmAgentEntry.permissionMode). */
  permissionMode?: string;
  /** Modes the app asked for with `set_permission_mode` and has no answer
   *  to yet: the CLI reporting one of them is the app's switch, not its own. */
  requestedPermissionModes: Map<string, number>;
  /** The CLI reported auto mode (WarmAgentEntry.autoModeSeen). */
  autoModeSeen: boolean;
  /** CliAgentWarmOptions.onCliPermissionMode, from the process's start. */
  onCliPermissionMode?: (mode: ClaudePermissionMode) => void;
}

export interface ClaudeWarmProcessHooks {
  write: (message: Record<string, unknown>) => void;
  /** A reply settled: write held-back messages, re-check idleness. */
  settled: () => void;
  /** Write held-back messages (the CLI turned out to queue them itself). */
  flush: () => void;
  markUnusable: () => void;
  /** Retire the process before the next turn only when nothing else is live. */
  markUnusableIfIdle: () => void;
}

export interface ClaudeOneShotStreamState {
  buffer: string;
  streamedText: string;
  toolContext: ClaudeToolActivityContext;
  messages: string[];
  lastAssistantUuid?: string;
  nextTextBlockStartsBlock: boolean;
  resultEvent?: unknown;
  error?: string;
  sessionId?: string;
  model?: string;
  usedTokens?: number;
  contextModel?: string;
  contextWindowTokens?: number;
}

export interface ClaudeToolConfig {
  permissionMode: ClaudePermissionMode;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  askTools: string[];
}
