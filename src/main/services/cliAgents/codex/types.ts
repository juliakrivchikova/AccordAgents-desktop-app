import type { AgentContextUsage, ChatAgentActivityKind } from "../../../../shared/types";
import type { ParticipantRunResult } from "../../providers";
import type {
  CliAgentCodexServerRequestCallback, CliAgentCompactResult, CliAgentOutputCallback, CliAgentSessionIdCallback
} from "../types";

export interface CodexAppServerPendingTurn {
  startedAt: number;
  threadId: string;
  /** The session's folder: an edit's row names its file relative to it. */
  cwd?: string;
  turnId?: string;
  /** The last of its turns that completed (a goal runs several): where the
   *  thread stands when the reply ends (sessionCut). */
  lastCompletedTurnId?: string;
  acceptedByProvider?: boolean;
  messages: string[];
  streamedText: string;
  visibleTranscript: string;
  activityItems: Map<string, {
    label: string;
    kind: ChatAgentActivityKind;
    detail?: string;
    /** The item as it started: its completion may carry only what changed. */
    item?: Record<string, unknown>;
  }>;
  agentTextPendingCarriageReturn?: boolean;
  completedAgentMessages: string[];
  finalMessage?: string;
  nextAgentMessageStartsBlock: boolean;
  model?: string;
  contextUsage?: AgentContextUsage;
  nativeGoal?: {
    status?: CodexNativeGoalStatus | "cleared";
    turnCompleted: boolean;
  };
  timer?: NodeJS.Timeout;
  timeoutRemainingMs?: number;
  timeoutDeadline?: number;
  outstandingServerRequestIds: Set<string>;
  abort?: () => void;
  onOutput?: CliAgentOutputCallback;
  onCodexServerRequest?: CliAgentCodexServerRequestCallback;
  resolve: (result: ParticipantRunResult) => void;
  reject: (error: Error) => void;
}

export type CodexNativeGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface CodexAppServerPendingCompact {
  threadId: string;
  startedAt: number;
  contextUsage?: AgentContextUsage;
  // codex app-server (>= 0.139) runs compaction as a normal turn that emits
  // turn/started + turn/completed instead of a dedicated thread/compacted event.
  // We capture that turn id so we resolve on the right turn/completed.
  compactTurnId?: string;
  sawCompactTurn?: boolean;
  timer: NodeJS.Timeout;
  abort?: () => void;
  onSessionId?: CliAgentSessionIdCallback;
  resolve: (result: CliAgentCompactResult) => void;
  reject: (error: Error) => void;
}
