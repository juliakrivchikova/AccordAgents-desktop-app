import {
  codexForkCut, FORK_CUT_NOT_IN_SESSION, FORK_CUT_SESSION_GONE, FORK_CUT_TURNS_UNLISTED, isForkCutMissingError
} from "../../forkCut";
import type { CodexTurnSummary, ForkCutDecision } from "../../forkCut";
import type { ChatReasoningEffort, ConversationKind, GitDiffMode, ParticipantConfig } from "../../../../shared/types";
import { commandEnvironment } from "../../command";
import { capturePosixDescendantsFromTable, capturePosixProcessIdentity, type CapturedPosixProcess } from "../../processTermination";
import {
  CODEX_GUARDIAN_DENIED_APPROVAL_METHOD, CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD, codexGuardianAssessmentEvent,
  codexApprovalCancellationResult, isCodexApprovalMethod, validateCodexApprovalCorrelation, type CodexApprovalCorrelation,
  type CodexServerRequestDelivery
} from "../../codexApprovals";
import type { ParticipantRunResult } from "../../providers";
import { codexAppServerMessageKind, CodexAppServerRunError, isCodexCollaborationModeRefusal } from "./appServerErrors";
import { handleCodexAppServerCompactNotification } from "./appServerEvents";
import {
  codexAppServerThreadForkParams, codexAppServerThreadResumeParams, codexAppServerThreadStartParams, codexAppServerTurnInput,
  codexPrompt, codexReasoningEffort
} from "./appServerParams";
import type { CodexAppServerPendingCompact, CodexAppServerPendingTurn } from "./types";
import { CLI_AGENT_COMPACT_TIMEOUT_MS, MAX_CLI_ERROR_CHARS } from "../constants";
import { isForkSourceMissingError } from "../runs/forkSource";
import { emitLiveOutput, errorText, reportSessionId, truncateText } from "../runs/outputText";
import { asRecord, stringField } from "../runs/records";
import { agentRunEnv } from "../runs/runEnvironment";
import type {
  ClaudeWarmRunContext, CliAgentCodexServerRequestCallback, CliAgentCompactResult, CliAgentImageInput, CliAgentOutputCallback,
  CliAgentRunOptions, CliAgentSessionIdCallback, CodexAppServerPendingRequest, NativeGoalRun, WarmAgentEntry
} from "../types";
import type { CliModules } from "../modules";
import type { CliDependencies } from "../dependencies";

// Fork to new chat from a reply from before its turn id was recorded: the
// source thread's turns are read newest first, a page at a time (the reply
// is usually among the newest), at most this many.
const CODEX_FORK_CUT_PAGE_SIZE = 50;

const CODEX_FORK_CUT_MAX_PAGES = 40;

export function resolveCodexCompactTimeoutMs(requestedTimeoutMs: number | undefined): number {
  return typeof requestedTimeoutMs === "number" && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : CLI_AGENT_COMPACT_TIMEOUT_MS;
}

interface CodexAppServerPendingInboundRequest {
  id: string | number;
  key: string;
  method: string;
  controller: AbortController;
  turn: CodexAppServerPendingTurn;
  answered: boolean;
  correlation: CodexApprovalCorrelation;
}

interface CodexAppServerPendingGuardianApproval {
  key: string;
  controller: AbortController;
  threadId: string;
  turnId: string;
  reviewId: string;
  targetItemId: string | null;
}

interface CodexAppServerThreadStartResult {
  thread?: {
    id?: string;
    sessionId?: string;
  };
  model?: string;
  /** The effort the thread runs at (the User's config.toml when the member
   *  sets none). */
  reasoningEffort?: string | null;
}

interface CodexAppServerTurnStartResult {
  turn?: {
    id?: string;
  };
}

/** A member's live codex app-server process. */
export class CodexAppServer {
  constructor(
    private readonly cli: Pick<
      CliModules,
      | "cliRuns" | "codexAppServerNotifications" | "codexRuns" | "sessionLogs" | "warmAgentClose" | "warmAgents"
    >,
    private readonly deps: Pick<CliDependencies, "debugLogs">
  ) {}

  async createCodexAppServerWarmAgent(
    key: string,
    scopeKey: string,
    participant: ParticipantConfig,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions,
    codexExecutable: string
  ): Promise<WarmAgentEntry> {
    return this.cli.warmAgents.createTrackedWarmAgent(key, () => this.constructCodexAppServerWarmAgent(key, scopeKey, participant, repoPath, diffMode, kind, options, codexExecutable));
  }

  private async constructCodexAppServerWarmAgent(
    key: string,
    scopeKey: string,
    participant: ParticipantConfig,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions,
    codexExecutable: string
  ): Promise<WarmAgentEntry> {
    // `-c` overrides are global codex options; the app-server honors them for
    // every thread it hosts, which is how a member on an added provider reaches
    // that provider's Responses endpoint.
    const configArgs = (participant.codexConfigOverrides ?? []).flatMap((override) => ["-c", override]);
    const child = await this.cli.warmAgents.spawnResidentProcess(scopeKey, codexExecutable, ["app-server", ...configArgs, "--listen", "stdio://"], {
      cwd: repoPath,
      env: commandEnvironment(agentRunEnv(options)),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let processIdentity = capturePosixProcessIdentity(child.pid, this.cli.warmAgentClose.readPosixProcessTableForTermination);
    let capturedProcesses: CapturedPosixProcess[] = [];
    const captureBeforeInterrupt = (): boolean => {
      if (process.platform === "win32") return true;
      const rows = this.cli.warmAgentClose.readPosixProcessTableForTermination();
      if (!rows) return false;
      processIdentity ??= capturePosixProcessIdentity(child.pid, () => rows);
      capturedProcesses = capturePosixDescendantsFromTable(child.pid, rows, capturedProcesses, processIdentity);
      return true;
    };

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let stderr = "";
    let closed = false;
    let nextRequestId = 1;
    let threadId = options.sessionId;
    let threadLoaded = false;
    let initialized = false;
    let activeModel = participant.model;
    // The effort the thread runs at as Codex says (her config's when the
    // member sets none): a collaboration mode said on a turn keeps it.
    let activeEffort: ChatReasoningEffort | undefined;
    // The model and effort the thread runs at, as Codex said on start,
    // resume or fork.
    const takeThread = (result: CodexAppServerThreadStartResult): void => {
      activeModel = result.model ?? activeModel;
      activeEffort = codexReasoningEffort((result.reasoningEffort ?? undefined) as ChatReasoningEffort | undefined) ?? activeEffort;
    };
    // Fork to new chat: why the fork just made copied the whole thread
    // instead of ending where it was asked to (the next run reports it).
    let forkCutMissed: string | undefined;
    const pendingRequests = new Map<number, CodexAppServerPendingRequest>();
    const pendingInboundRequests = new Map<string, CodexAppServerPendingInboundRequest>();
    const pendingGuardianApprovals = new Map<string, CodexAppServerPendingGuardianApproval>();
    const pendingFileChangeSummaries = new Map<string, Array<Record<string, unknown>>>();
    const seenGuardianReviewKeys = new Set<string>();
    let pendingTurn: CodexAppServerPendingTurn | undefined;
    let pendingCompact: CodexAppServerPendingCompact | undefined;

    const cleanupPendingTurn = (): CodexAppServerPendingTurn | undefined => {
      const current = pendingTurn;
      if (!current) {
        return undefined;
      }
      if (current.timer) {
        clearTimeout(current.timer);
      }
      if (current.abort) {
        current.abort();
      }
      for (const [requestKey, request] of pendingInboundRequests) {
        if (request.turn !== current) {
          continue;
        }
        pendingInboundRequests.delete(requestKey);
        request.controller.abort(new Error("Codex turn ended before the approval was answered."));
      }
      const turnPrefix = current.turnId ? `${current.threadId}:${current.turnId}:` : `${current.threadId}:`;
      for (const key of pendingFileChangeSummaries.keys()) {
        if (key.startsWith(turnPrefix)) pendingFileChangeSummaries.delete(key);
      }
      current.outstandingServerRequestIds.clear();
      pendingTurn = undefined;
      return current;
    };

    const rejectPendingTurn = (error: Error): void => {
      const current = cleanupPendingTurn();
      if (!current) {
        return;
      }
      current.reject(error instanceof CodexAppServerRunError
        ? error
        : new CodexAppServerRunError(error, current.acceptedByProvider === true));
    };

    const cleanupPendingCompact = (): CodexAppServerPendingCompact | undefined => {
      const current = pendingCompact;
      if (!current) {
        return undefined;
      }
      clearTimeout(current.timer);
      if (current.abort) {
        current.abort();
      }
      pendingCompact = undefined;
      return current;
    };

    const rejectPendingCompact = (error: Error): void => {
      const current = cleanupPendingCompact();
      current?.reject(error);
    };

    const sendRequest = (method: string, params: unknown, timeoutMs?: number): Promise<unknown> => {
      if (closed || child.exitCode !== null || child.killed) {
        return Promise.reject(new Error("codex app-server process is not running"));
      }
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise<unknown>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const settle = (callback: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          pendingRequests.delete(id);
          callback();
        };
        const resolveRequest = (result: unknown): void => settle(() => resolve(result));
        const rejectRequest = (error: Error): void => settle(() => reject(error));
        pendingRequests.set(id, { method, resolve: resolveRequest, reject: rejectRequest });
        if (timeoutMs && timeoutMs > 0) {
          timer = setTimeout(() => {
            rejectRequest(new Error(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timer.unref();
        }
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
          if (error) {
            rejectRequest(error);
          }
        });
      });
    };

    const initialize = async (timeoutMs?: number): Promise<void> => {
      if (initialized) {
        return;
      }
      await sendRequest("initialize", {
        clientInfo: {
          name: "accordagents",
          title: "AccordAgents",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: []
        }
      }, timeoutMs);
      initialized = true;
    };

    // Said once the copy is made (thread/fork answered, still before the
    // turn runs): a source that is gone gets no copy, and its fork says only
    // that it starts clean.
    let forkCutMissedPending: string | undefined;
    const missedCut = (reason: string): void => {
      forkCutMissedPending = reason;
    };
    /** Where a Fork to new chat's copy ends (options.forkCut): the turn its
     *  reply recorded, or, for a reply from before that, the last turn that
     *  ended by the reply's finish, read from the thread's turns newest
     *  first; undefined for all of it (nothing came after, or no point can
     *  be named: forkCutMissed says why). */
    const codexForkLastTurnId = async (sourceThreadId: string, timeoutMs?: number): Promise<string | undefined> => {
      const cut = options.forkCut;
      if (!cut) return undefined;
      if (cut.unknown) {
        missedCut(cut.unknown);
        return undefined;
      }
      if (cut.at) return cut.at;
      if (!cut.finishedBy) return undefined;
      let decision: ForkCutDecision | undefined;
      try {
        const turns: CodexTurnSummary[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < CODEX_FORK_CUT_MAX_PAGES && !decision; page += 1) {
          const listed = asRecord(await sendRequest("thread/turns/list", {
            threadId: sourceThreadId,
            sortDirection: "desc",
            limit: CODEX_FORK_CUT_PAGE_SIZE,
            itemsView: "notLoaded",
            ...(cursor ? { cursor } : {})
          }, timeoutMs)) ?? {};
          for (const item of Array.isArray(listed.data) ? listed.data : []) {
            const turn = asRecord(item);
            const id = turn ? stringField(turn, "id") : undefined;
            if (!turn || !id) continue;
            turns.push({
              id,
              status: stringField(turn, "status"),
              startedAt: typeof turn.startedAt === "number" ? turn.startedAt : null,
              completedAt: typeof turn.completedAt === "number" ? turn.completedAt : null
            });
          }
          cursor = typeof listed.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
          decision = codexForkCut(turns, cut.finishedBy, !cursor);
          if (!cursor) break;
        }
      } catch (error) {
        void this.cli.cliRuns.writeDebugLog("cli-agent-codex-fork-cut-unlisted", { participantId: participant.id, error: errorText(error) });
      }
      const resolved: ForkCutDecision = decision ?? { kind: "missed", reason: FORK_CUT_TURNS_UNLISTED };
      void this.cli.cliRuns.writeDebugLog("cli-agent-codex-fork-cut", {
        participantId: participant.id,
        decision: resolved.kind,
        ...(resolved.kind === "missed" ? { reason: resolved.reason } : {})
      });
      if (resolved.kind === "missed") missedCut(resolved.reason);
      return resolved.kind === "cut" ? resolved.at : undefined;
    };

    const ensureThread = async (timeoutMs?: number): Promise<string> => {
      await initialize(timeoutMs);
      if (threadId && threadLoaded) {
        return threadId;
      }
      if (!threadId && options.forkFromSessionId) {
        // A member made as a fork of another member's thread: its own thread
        // starts as a copy (Codex 0.155.1 forks a thread another process is
        // still running a turn on). Never the source's id: the member must
        // not write to the session it was copied from.
        const sourceThreadId = options.forkFromSessionId;
        forkCutMissed = undefined;
        forkCutMissedPending = undefined;
        const forkParams = codexAppServerThreadForkParams(sourceThreadId, participant, repoPath, kind, options);
        let forkedThreadId: string | undefined;
        let result: CodexAppServerThreadStartResult;
        try {
          // Fork to new chat: only through the turn of the reply the User saw
          // last (Codex 0.155.1 `lastTurnId`, inclusive), in the thread that
          // reply was in (the member's own now, unless it changed after it).
          const lastTurnId = await codexForkLastTurnId(sourceThreadId, timeoutMs);
          const replyThreadId = lastTurnId && options.forkCut?.sessionId?.trim() ? options.forkCut.sessionId.trim() : sourceThreadId;
          try {
            result = await sendRequest("thread/fork", lastTurnId ? { ...forkParams, threadId: replyThreadId, lastTurnId } : forkParams, timeoutMs) as CodexAppServerThreadStartResult;
          } catch (error) {
            const text = errorText(error);
            const earlierGone = replyThreadId !== sourceThreadId && (isForkSourceMissingError(text) || /thread not (?:found|loaded)/i.test(text));
            if (!lastTurnId || (!earlierGone && !isForkCutMissingError(text))) throw error;
            // Codex does not know that turn, or the thread it was in is gone:
            // the whole of the member's thread, and the chat says so.
            void this.cli.cliRuns.writeDebugLog("cli-agent-codex-fork-cut-refused", { participantId: participant.id, earlierGone });
            missedCut(earlierGone ? FORK_CUT_SESSION_GONE : FORK_CUT_NOT_IN_SESSION);
            result = await sendRequest("thread/fork", forkParams, timeoutMs) as CodexAppServerThreadStartResult;
          }
          forkedThreadId = result.thread?.id ?? result.thread?.sessionId;
          if (!forkedThreadId || forkedThreadId === options.forkFromSessionId) {
            throw new Error("codex app-server did not return a thread id for the fork");
          }
        } catch (error) {
          // No copy was made: the caller may try again or start clean
          // (ParticipantRunResult.forkCopyFailed).
          forkCutMissedPending = undefined;
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { forkCopyFailed: true });
        }
        if (forkCutMissedPending) {
          forkCutMissed = forkCutMissedPending;
          forkCutMissedPending = undefined;
          options.onForkCutMissed?.(forkCutMissed);
        }
        threadId = forkedThreadId;
        threadLoaded = true;
        takeThread(result);
        return forkedThreadId;
      }
      if (threadId) {
        if (options.sessionId && threadId === options.sessionId) {
          const result = await sendRequest("thread/resume", codexAppServerThreadResumeParams(options.sessionId, participant, repoPath, kind, options), timeoutMs) as CodexAppServerThreadStartResult;
          threadId = result.thread?.id ?? options.sessionId;
          takeThread(result);
        }
        threadLoaded = true;
        return threadId;
      }
      const result = await sendRequest("thread/start", codexAppServerThreadStartParams(participant, repoPath, kind, options), timeoutMs) as CodexAppServerThreadStartResult;
      const nextThreadId = result.thread?.id ?? result.thread?.sessionId;
      if (!nextThreadId) {
        throw new Error("codex app-server did not return a thread id");
      }
      threadId = nextThreadId;
      threadLoaded = true;
      takeThread(result);
      return nextThreadId;
    };

    const handleResponse = (record: Record<string, unknown>): void => {
      const id = typeof record.id === "number" ? record.id : undefined;
      if (id === undefined) {
        return;
      }
      const pending = pendingRequests.get(id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(id);
      const error = asRecord(record.error);
      if (error) {
        pending.reject(new Error(stringField(error, "message") ?? `${pending.method} failed`));
        return;
      }
      pending.resolve(record.result);
    };

    const inboundRequestKey = (id: string | number): string => `${typeof id}:${String(id)}`;
    const itemCorrelationKey = (thread: string, turn: string, item: string): string => `${thread}:${turn}:${item}`;

    const writeServerMessage = (message: Record<string, unknown>): Promise<void> => {
      if (closed || child.exitCode !== null || child.killed) {
        return Promise.reject(new Error("codex app-server process is not running"));
      }
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
      });
    };

    const rejectPendingGuardianApprovals = (error: Error): void => {
      for (const approval of pendingGuardianApprovals.values()) {
        approval.controller.abort(error);
      }
      pendingGuardianApprovals.clear();
    };

    let cancelPendingInboundApprovals: (turn: CodexAppServerPendingTurn, reason: string) => Promise<void>;

    const armPendingTurnTimer = (turn: CodexAppServerPendingTurn, delayMs: number): void => {
      if (delayMs <= 0 || pendingTurn !== turn) {
        return;
      }
      if (turn.timer) {
        clearTimeout(turn.timer);
      }
      turn.timeoutRemainingMs = delayMs;
      turn.timeoutDeadline = Date.now() + delayMs;
      turn.timer = setTimeout(() => {
        void cancelPendingInboundApprovals(turn, "Codex approval expired because the turn timed out.")
          .catch((error) => {
            void this.deps.debugLogs?.write("cli.codex-app-server.timeout-refusal-write-failed", {
              threadId: turn.threadId,
              turnId: turn.turnId,
              message: errorText(error)
            });
          });
        rejectPendingGuardianApprovals(new Error("Codex Guardian approval expired because the provider turn timed out."));
        rejectPendingTurn(new Error(`codex app-server timed out after ${delayMs}ms`));
      }, delayMs);
      turn.timer.unref();
    };

    const pausePendingTurnTimer = (turn: CodexAppServerPendingTurn): void => {
      if (!turn.timer) {
        return;
      }
      clearTimeout(turn.timer);
      turn.timer = undefined;
      turn.timeoutRemainingMs = Math.max(1, (turn.timeoutDeadline ?? Date.now()) - Date.now());
      turn.timeoutDeadline = undefined;
    };

    const resumePendingTurnTimer = (turn: CodexAppServerPendingTurn): void => {
      if (turn.outstandingServerRequestIds.size > 0 || turn.timer || !turn.timeoutRemainingMs) {
        return;
      }
      armPendingTurnTimer(turn, turn.timeoutRemainingMs);
    };

    const finishPendingInboundRequest = async (
      request: CodexAppServerPendingInboundRequest,
      message: Record<string, unknown>
    ): Promise<boolean> => {
      const current = pendingInboundRequests.get(request.key);
      if (!current || current !== request || request.answered) {
        return false;
      }
      request.answered = true;
      pendingInboundRequests.delete(request.key);
      request.turn.outstandingServerRequestIds.delete(request.key);
      try {
        await writeServerMessage(message);
      } finally {
        resumePendingTurnTimer(request.turn);
      }
      return true;
    };

    const answerPendingInboundRequest = (
      request: CodexAppServerPendingInboundRequest,
      result: unknown
    ): Promise<boolean> => finishPendingInboundRequest(request, { id: request.id, result });

    const rejectPendingInboundRequest = (
      request: CodexAppServerPendingInboundRequest,
      code: number,
      message: string
    ): Promise<boolean> => finishPendingInboundRequest(request, {
      id: request.id,
      error: { code, message: truncateText(message, MAX_CLI_ERROR_CHARS) }
    });

    cancelPendingInboundApprovals = async (turn: CodexAppServerPendingTurn, reason: string): Promise<void> => {
      const requests = [...pendingInboundRequests.values()].filter((request) => request.turn === turn);
      const refusals: Array<Promise<boolean>> = [];
      for (const request of requests) {
        if (!isCodexApprovalMethod(request.method)) {
          continue;
        }
        request.controller.abort(new Error(reason));
        refusals.push(answerPendingInboundRequest(request, codexApprovalCancellationResult(request.method)));
      }
      const results = await Promise.allSettled(refusals);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
      if (failures.length > 0) {
        throw new AggregateError(failures, "One or more Codex approval refusal frames could not be written.");
      }
    };

    const handleServerRequestResolved = (record: Record<string, unknown>): boolean => {
      if (stringField(record, "method") !== "serverRequest/resolved") {
        return false;
      }
      const params = asRecord(record.params);
      const notificationThreadId = stringField(params ?? {}, "threadId");
      const id = params && (typeof params.requestId === "string" || typeof params.requestId === "number")
        ? params.requestId
        : undefined;
      if (id === undefined || !notificationThreadId) {
        return true;
      }
      const request = pendingInboundRequests.get(inboundRequestKey(id));
      if (!request) {
        return true;
      }
      if (notificationThreadId !== request.correlation.threadId) {
        const message = `Ignored serverRequest/resolved for thread ${notificationThreadId}; request ${String(id)} belongs to ${request.correlation.threadId}.`;
        emitLiveOutput(request.turn.onOutput, "tool", `${message}\n`, undefined, {
          activityKind: "approval",
          activityStatus: "failed",
          activityDetail: message
        });
        return true;
      }
      pendingInboundRequests.delete(request.key);
      request.answered = true;
      request.turn.outstandingServerRequestIds.delete(request.key);
      request.controller.abort(new Error("Codex resolved this approval request before the user answered."));
      resumePendingTurnTimer(request.turn);
      return true;
    };

    const handleServerRequest = (record: Record<string, unknown>): void => {
      const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : undefined;
      const method = stringField(record, "method");
      if (id === undefined || !method) {
        return;
      }
      if (method === "currentTime/read") {
        void writeServerMessage({ id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } })
          .catch((error) => rejectPendingTurn(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      if (!isCodexApprovalMethod(method)) {
        // Codex 0.146's account/read contract says managed authentication uses
        // the CLI's normal refresh-token flow; this callback belongs to clients
        // that supplied external chatgptAuthTokens through account/login/start.
        // AccordAgents never performs that login variant, so receiving it is
        // authentication-contract drift rather than a recoverable refresh ask.
        const message = method === "account/chatgptAuthTokens/refresh"
          ? "This app-server was launched with Codex CLI-managed authentication, but Codex requested a client-managed token refresh. AccordAgents did not supply external ChatGPT tokens; re-authenticate the Codex CLI and retry."
          : `AccordAgents does not support the Codex client request ${method}.`;
        emitLiveOutput(pendingTurn?.onOutput, "tool", `${message}\n`, undefined, {
          activityKind: "status",
          activityStatus: "failed",
          activityDetail: message
        });
        void writeServerMessage({ id, error: { code: method === "account/chatgptAuthTokens/refresh" ? -32001 : -32601, message } })
          .catch((error) => rejectPendingTurn(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      const turn = pendingTurn;
      if (!turn?.onCodexServerRequest) {
        const message = "This Codex transport cannot present interactive approvals.";
        void writeServerMessage({ id, error: { code: -32601, message } })
          .catch((error) => rejectPendingTurn(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      let correlation: CodexApprovalCorrelation;
      try {
        correlation = validateCodexApprovalCorrelation(method, record.params, turn.threadId, turn.turnId);
      } catch (error) {
        const message = errorText(error);
        void writeServerMessage({ id, error: { code: -32602, message: truncateText(message, MAX_CLI_ERROR_CHARS) } })
          .catch((writeError) => rejectPendingTurn(writeError instanceof Error ? writeError : new Error(String(writeError))));
        emitLiveOutput(turn.onOutput, "tool", `Rejected malformed Codex approval request: ${message}\n`, undefined, {
          activityKind: "approval",
          activityStatus: "failed",
          activityDetail: message
        });
        return;
      }
      if (!turn.turnId && correlation.turnId) turn.turnId = correlation.turnId;
      turn.acceptedByProvider = true;
      const key = inboundRequestKey(id);
      if (pendingInboundRequests.has(key)) {
        const message = `Codex reused an active JSON-RPC request id (${String(id)}).`;
        void writeServerMessage({ id, error: { code: -32600, message } })
          .catch((error) => rejectPendingTurn(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      const controller = new AbortController();
      const request: CodexAppServerPendingInboundRequest = {
        id,
        key,
        method,
        controller,
        turn,
        answered: false,
        correlation
      };
      pendingInboundRequests.set(key, request);
      turn.outstandingServerRequestIds.add(key);
      pausePendingTurnTimer(turn);
      let resolveDelivery!: (delivery: CodexServerRequestDelivery) => void;
      let rejectDelivery!: (error: Error) => void;
      const responseDelivered = new Promise<CodexServerRequestDelivery>((resolve, reject) => {
        resolveDelivery = resolve;
        rejectDelivery = reject;
      });
      void responseDelivered.catch(() => undefined);
      const correlatedParams = method === "item/fileChange/requestApproval" && correlation.turnId
        ? {
            ...(asRecord(record.params) ?? {}),
            fileChanges: pendingFileChangeSummaries.get(itemCorrelationKey(correlation.threadId, correlation.turnId, correlation.itemId))
          }
        : record.params;
      void turn.onCodexServerRequest({ id, method, params: correlatedParams, signal: controller.signal, responseDelivered })
        .then(async (result) => {
          try {
            const delivered = await answerPendingInboundRequest(request, result);
            if (!delivered) {
              throw new Error("The Codex approval request was resolved before this decision could be delivered.");
            }
            // The turn blocks on this request, so an answered request always
            // lands inside the running turn.
            resolveDelivery({ turnActive: true });
          } catch (error) {
            const deliveryError = error instanceof Error ? error : new Error(String(error));
            rejectDelivery(deliveryError);
            throw deliveryError;
          }
        })
        .catch((error) => {
          rejectDelivery(error instanceof Error ? error : new Error(String(error)));
          if (!pendingInboundRequests.has(key)) {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          return rejectPendingInboundRequest(request, -32000, message);
        })
        .catch((error) => rejectPendingTurn(error instanceof Error ? error : new Error(String(error))));
    };

    const handleFileChangePatchUpdated = (record: Record<string, unknown>): boolean => {
      if (stringField(record, "method") !== "item/fileChange/patchUpdated") return false;
      const params = asRecord(record.params);
      const notificationThreadId = stringField(params ?? {}, "threadId");
      const notificationTurnId = stringField(params ?? {}, "turnId");
      const itemId = stringField(params ?? {}, "itemId");
      const turn = pendingTurn;
      if (
        !params || !notificationThreadId || !notificationTurnId || !itemId || !Array.isArray(params.changes) ||
        !turn || notificationThreadId !== turn.threadId || (turn.turnId && notificationTurnId !== turn.turnId)
      ) {
        return true;
      }
      if (!turn.turnId) turn.turnId = notificationTurnId;
      const summaries = params.changes.flatMap((value): Array<Record<string, unknown>> => {
        const change = asRecord(value);
        const pathValue = stringField(change ?? {}, "path");
        const kind = asRecord(change?.kind);
        const kindType = stringField(kind ?? {}, "type");
        if (!pathValue || (kindType !== "add" && kindType !== "delete" && kindType !== "update")) return [];
        return [{ path: pathValue, kind: { type: kindType } }];
      });
      if (summaries.length !== params.changes.length) {
        const message = "Ignored malformed item/fileChange/patchUpdated notification.";
        emitLiveOutput(turn.onOutput, "tool", `${message}\n`, undefined, {
          activityKind: "approval",
          activityStatus: "failed",
          activityDetail: message
        });
        return true;
      }
      pendingFileChangeSummaries.set(itemCorrelationKey(notificationThreadId, notificationTurnId, itemId), summaries);
      return true;
    };

    const handleItemCompletedApprovalRetirement = (record: Record<string, unknown>): boolean => {
      if (stringField(record, "method") !== "item/completed") return false;
      const params = asRecord(record.params);
      const item = asRecord(params?.item);
      const notificationThreadId = stringField(params ?? {}, "threadId");
      const notificationTurnId = stringField(params ?? {}, "turnId");
      const itemId = stringField(item ?? {}, "id");
      if (!notificationThreadId || !notificationTurnId || !itemId) return true;
      for (const [requestKey, request] of pendingInboundRequests) {
        if (
          request.correlation.threadId !== notificationThreadId ||
          request.correlation.turnId !== notificationTurnId ||
          request.correlation.itemId !== itemId
        ) {
          continue;
        }
        pendingInboundRequests.delete(requestKey);
        request.answered = true;
        request.turn.outstandingServerRequestIds.delete(request.key);
        request.controller.abort(new Error("Codex completed the item before the approval was answered."));
        resumePendingTurnTimer(request.turn);
      }
      pendingFileChangeSummaries.delete(itemCorrelationKey(notificationThreadId, notificationTurnId, itemId));
      return true;
    };

    const handleGuardianReviewCompleted = (record: Record<string, unknown>): void => {
      if (stringField(record, "method") !== "item/autoApprovalReview/completed") {
        return;
      }
      const params = asRecord(record.params);
      const review = asRecord(params?.review);
      const reviewId = stringField(params ?? {}, "reviewId");
      const notificationThreadId = stringField(params ?? {}, "threadId");
      const notificationTurnId = stringField(params ?? {}, "turnId");
      const status = stringField(review ?? {}, "status");
      const targetItemId = params?.targetItemId === null
        ? null
        : stringField(params ?? {}, "targetItemId");
      if (
        !params || !review || !reviewId || !notificationThreadId || !notificationTurnId ||
        (params.targetItemId !== null && !targetItemId) ||
        (status !== "denied" && status !== "timedOut" && status !== "approved" && status !== "aborted")
      ) {
        return;
      }
      const turn = pendingTurn;
      if (
        !turn?.onCodexServerRequest ||
        notificationThreadId !== turn.threadId ||
        (turn.turnId && notificationTurnId !== turn.turnId)
      ) {
        return;
      }
      if (!turn.turnId) turn.turnId = notificationTurnId;
      const key = `${notificationThreadId}:${notificationTurnId}:${reviewId}:${targetItemId ?? "<none>"}`;
      if (seenGuardianReviewKeys.has(key)) return;
      if (seenGuardianReviewKeys.size >= 512) {
        const oldest = seenGuardianReviewKeys.values().next().value;
        if (typeof oldest === "string") seenGuardianReviewKeys.delete(oldest);
      }
      seenGuardianReviewKeys.add(key);
      turn.acceptedByProvider = true;
      if (status === "approved" || status === "aborted") return;
      if (status === "timedOut") {
        void turn.onCodexServerRequest({
          id: `guardian-timeout:${reviewId}`,
          method: CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD,
          params,
          signal: new AbortController().signal,
          responseDelivered: Promise.resolve({ turnActive: true })
        }).catch((error) => {
          void this.deps.debugLogs?.write("cli.codex-app-server.guardian-timeout-projection-failed", {
            threadId: notificationThreadId,
            turnId: notificationTurnId,
            reviewId,
            message: errorText(error)
          });
        });
        return;
      }
      let event: Record<string, unknown>;
      try {
        event = codexGuardianAssessmentEvent(params);
      } catch (error) {
        const message = `Codex Auto Review denial could not be prepared for approval: ${errorText(error)}`;
        emitLiveOutput(turn.onOutput, "tool", `${message}\n`, undefined, {
          activityKind: "approval",
          activityStatus: "failed",
          activityDetail: message
        });
        void this.deps.debugLogs?.write("cli.codex-app-server.guardian-approval-invalid", {
          threadId: notificationThreadId,
          turnId: notificationTurnId,
          reviewId,
          message: errorText(error)
        });
        return;
      }
      const controller = new AbortController();
      const approval: CodexAppServerPendingGuardianApproval = {
        key,
        controller,
        threadId: notificationThreadId,
        turnId: notificationTurnId,
        reviewId,
        targetItemId: targetItemId ?? null
      };
      pendingGuardianApprovals.set(key, approval);
      let resolveDelivery!: (delivery: CodexServerRequestDelivery) => void;
      let rejectDelivery!: (error: Error) => void;
      const responseDelivered = new Promise<CodexServerRequestDelivery>((resolve, reject) => {
        resolveDelivery = resolve;
        rejectDelivery = reject;
      });
      void responseDelivered.catch(() => undefined);
      // A Guardian denial never blocks the turn that raised it. Codex applies
      // the User's decision inside that turn while it is still running and only
      // records it in the thread history once the turn has ended, so the
      // receipt tells the chat whether a continuation is needed at all.
      void turn.onCodexServerRequest({
        id: `guardian:${reviewId}`,
        method: CODEX_GUARDIAN_DENIED_APPROVAL_METHOD,
        params,
        signal: controller.signal,
        responseDelivered
      }).then(async (result) => {
        if (pendingGuardianApprovals.get(key) !== approval || controller.signal.aborted) {
          throw new Error("The Guardian approval is no longer active.");
        }
        // Sample the turn state synchronously, as the decision is handed over,
        // before any `await`. Reading it after `await sendRequest` is unsafe:
        // Codex's acknowledgement and the turn's `turn/completed` can arrive in
        // one stdout chunk, so the completion handler clears `pendingTurn`
        // before the post-await read runs — reporting `turnActive:false` for a
        // retry Codex already applied in-turn, which would run it a second time.
        const turnActive = pendingTurn === turn;
        const decision = stringField(asRecord(result) ?? {}, "decision");
        if (decision !== "approveRetry") {
          resolveDelivery({ turnActive });
          return;
        }
        if (closed || child.exitCode !== null || child.killed || threadId !== notificationThreadId) {
          throw new Error("The Codex app-server session for this Guardian denial is no longer active.");
        }
        await sendRequest("thread/approveGuardianDeniedAction", {
          threadId: notificationThreadId,
          event
        }, 10_000);
        void this.deps.debugLogs?.write("cli.codex-app-server.guardian-approval-sent", {
          threadId: notificationThreadId,
          turnId: notificationTurnId,
          reviewId,
          turnActive
        });
        emitLiveOutput(turn.onOutput, "tool", "Recorded User approval for the Auto Review denial\n", undefined, {
          activityKind: "approval",
          activityStatus: "completed",
          activityDetail: turnActive
            ? "The User approved one retry. Codex received it inside the running response."
            : "The User approved one retry. AccordAgents will continue the participant with it."
        });
        resolveDelivery({ turnActive });
      }).catch((error) => {
        const deliveryError = error instanceof Error ? error : new Error(String(error));
        rejectDelivery(deliveryError);
        if (controller.signal.aborted) {
          return;
        }
        const message = errorText(deliveryError);
        emitLiveOutput(turn.onOutput, "tool", `Could not approve the Auto Review retry: ${message}\n`, undefined, {
          activityKind: "approval",
          activityStatus: "failed",
          activityDetail: message
        });
        void this.deps.debugLogs?.write("cli.codex-app-server.guardian-approval-failed", {
          threadId: notificationThreadId,
          turnId: notificationTurnId,
          reviewId,
          message
        });
      }).finally(() => {
        if (pendingGuardianApprovals.get(key) === approval) {
          pendingGuardianApprovals.delete(key);
        }
      });
    };

    const handleLine = (line: string): void => {
      let event: unknown;
      try {
        event = JSON.parse(line) as unknown;
      } catch {
        return;
      }
      const record = asRecord(event);
      if (!record) {
        return;
      }
      const messageKind = codexAppServerMessageKind(record);
      if (messageKind === "server-request") {
        handleServerRequest(record);
        return;
      }
      if (messageKind === "response") {
        handleResponse(record);
        return;
      }
      if (handleServerRequestResolved(record)) {
        return;
      }
      handleFileChangePatchUpdated(record);
      handleItemCompletedApprovalRetirement(record);
      if (handleCodexAppServerCompactNotification(record, participant, pendingCompact, cleanupPendingCompact, rejectPendingCompact)) {
        return;
      }
      handleGuardianReviewCompleted(record);
      this.cli.codexAppServerNotifications.handleCodexAppServerNotification(
        record,
        participant,
        pendingTurn,
        cleanupPendingTurn,
        rejectPendingTurn,
        rejectPendingGuardianApprovals
      );
    };

    const handleData = (chunk: string, stream: "stdout" | "stderr"): void => {
      if (stream === "stderr") {
        stderr = truncateText(`${stderr}${chunk}`, MAX_CLI_ERROR_CHARS);
        stderrBuffer += chunk;
      } else {
        stdoutBuffer += chunk;
      }
      let buffer = stream === "stderr" ? stderrBuffer : stdoutBuffer;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          handleLine(line);
        }
        newline = buffer.indexOf("\n");
      }
      if (stream === "stderr") {
        stderrBuffer = buffer;
      } else {
        stdoutBuffer = buffer;
      }
    };

    child.stdout.on("data", (chunk: string) => handleData(chunk, "stdout"));
    child.stderr.on("data", (chunk: string) => handleData(chunk, "stderr"));
    child.stdin.on("error", (error) => {
      closed = true;
      rejectPendingTurn(error);
      rejectPendingCompact(error);
      rejectPendingGuardianApprovals(error);
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    });
    child.on("error", (error) => {
      closed = true;
      rejectPendingTurn(error);
      rejectPendingCompact(error);
      rejectPendingGuardianApprovals(error);
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    });
    child.on("close", (exitCode, signal) => {
      closed = true;
      const exitDetail = signal
        ? ` after signal ${signal}`
        : exitCode === null
          ? ""
          : ` with code ${exitCode}`;
      const error = new Error(`codex app-server process exited${exitDetail}${!signal && stderr ? `: ${stderr}` : ""}`);
      rejectPendingTurn(error);
      rejectPendingCompact(error);
      rejectPendingGuardianApprovals(error);
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    });

    return {
      key,
      scopeKey,
      providerKind: participant.kind,
      process: child,
      processIdentity: () => processIdentity,
      capturedBackgroundProcesses: () => capturedProcesses,
      queue: Promise.resolve(),
      closed: false,
      compact: async (
        instructions?: string,
        signal?: AbortSignal,
        onSessionId?: CliAgentSessionIdCallback
      ): Promise<CliAgentCompactResult> => {
        rejectPendingGuardianApprovals(new Error("Codex Guardian approval expired because context compaction started."));
        // A native goal deliberately gives its turn an unbounded timeout. Warm
        // app-server entries can be reused by later slash workflows, but that
        // turn-specific zero must never become an immediate compact timeout.
        const timeoutMs = resolveCodexCompactTimeoutMs(options.timeoutMs);
        const currentThreadId = await ensureThread(timeoutMs);
        const compactOptions: CliAgentRunOptions = {
          ...options,
          sessionId: currentThreadId
        };
        if (instructions?.trim()) {
          compactOptions.compactInstructions = instructions;
        } else {
          delete compactOptions.compactInstructions;
        }
        delete compactOptions.clearCompactPrompt;
        const resumeResult = await sendRequest("thread/resume", codexAppServerThreadResumeParams(
          currentThreadId,
          participant,
          repoPath,
          kind,
          compactOptions
        ), timeoutMs) as CodexAppServerThreadStartResult;
        const compactThreadId = resumeResult.thread?.id ?? currentThreadId;
        threadId = compactThreadId;
        threadLoaded = true;
        takeThread(resumeResult);
        reportSessionId(onSessionId, compactThreadId);
        if (pendingCompact) {
          return { participant, ok: false, error: "codex app-server already has an active compact operation" };
        }
        const startedAt = Date.now();
        const timer = setTimeout(() => {
          rejectPendingCompact(new Error(`codex app-server compact timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        const abort = (): void => {
          rejectPendingCompact(new Error("codex app-server compact was cancelled"));
        };
        const resultPromise = new Promise<CliAgentCompactResult>((resolve, reject) => {
          pendingCompact = {
            threadId: compactThreadId,
            startedAt,
            timer,
            abort: signal ? () => signal.removeEventListener("abort", abort) : undefined,
            onSessionId,
            resolve,
            reject
          };
        });
        if (signal?.aborted) {
          abort();
          return resultPromise;
        }
        signal?.addEventListener("abort", abort, { once: true });
        try {
          void this.cli.cliRuns.writeDebugLog("cli-agent-compact-started", {
            providerKind: participant.kind,
            participantId: participant.id,
            threadId: compactThreadId,
            timeoutMs
          });
          void sendRequest("thread/compact/start", { threadId: compactThreadId }, timeoutMs)
            .then((result) => {
              const record = asRecord(result);
              if (record) {
                handleCodexAppServerCompactNotification(record, participant, pendingCompact, cleanupPendingCompact, rejectPendingCompact);
              }
            })
            .catch((error) => {
              rejectPendingCompact(error instanceof Error ? error : new Error(String(error)));
            });
          const result = await resultPromise;
          if (result.contextUsage) {
            return result;
          }
          const logUsage = await this.cli.sessionLogs.extractCodexSessionLogContextUsageWithRetry(result.sessionId ?? compactThreadId, participant);
          return logUsage ? { ...result, contextUsage: logUsage } : result;
        } finally {
          if (instructions?.trim()) {
            const clearCompactOptions: CliAgentRunOptions = {
              ...options,
              sessionId: compactThreadId,
              clearCompactPrompt: true
            };
            delete clearCompactOptions.compactInstructions;
            await sendRequest("thread/resume", codexAppServerThreadResumeParams(
              compactThreadId,
              participant,
              repoPath,
              kind,
              clearCompactOptions
            ), 10_000).catch(() => undefined);
          }
        }
      },
      run: async (
        turnPrompt: string,
        signal?: AbortSignal,
        onOutput?: CliAgentOutputCallback,
        onSessionId?: CliAgentSessionIdCallback,
        timeoutMsOverride?: number,
        nativeGoal?: NativeGoalRun,
        onCodexServerRequest?: CliAgentCodexServerRequestCallback,
        _claude?: ClaudeWarmRunContext,
        images?: CliAgentImageInput[]
      ): Promise<ParticipantRunResult> => {
        rejectPendingGuardianApprovals(new Error("Codex Guardian approval expired because a new turn started."));
        const timeoutMs = nativeGoal ? 0 : (timeoutMsOverride ?? this.cli.cliRuns.runTimeoutMs);
        const currentThreadId = await ensureThread(timeoutMs);
        reportSessionId(onSessionId, currentThreadId);
        // A fork this turn made that copied the whole thread says why.
        const cutMissed = forkCutMissed;
        forkCutMissed = undefined;
        const startedAt = Date.now();
        let aborting = false;
        const abort = (): void => {
          if (aborting) {
            return;
          }
          aborting = true;
          const current = pendingTurn;
          if (!current) {
            return;
          }
          // Native interruption can reparent a detached command before the
          // app-server exits. Retain its identity while the tree still exists.
          const capturedBeforeInterrupt = captureBeforeInterrupt();
          void cancelPendingInboundApprovals(current, "Stopped by user.")
            .catch((error) => {
              void this.deps.debugLogs?.write("cli.codex-app-server.stop-refusal-write-failed", {
                threadId: current.threadId,
                turnId: current.turnId,
                message: errorText(error)
              });
            });
          rejectPendingGuardianApprovals(new Error("Stopped by user."));
          if (current.turnId && capturedBeforeInterrupt) {
            void sendRequest("turn/interrupt", { threadId: current.threadId, turnId: current.turnId }).catch(() => undefined);
          }
          rejectPendingTurn(new Error("codex app-server turn was cancelled"));
        };
        const resultPromise = new Promise<ParticipantRunResult>((resolve, reject) => {
          pendingTurn = {
            startedAt,
            threadId: currentThreadId,
            cwd: repoPath,
            messages: [],
            streamedText: "",
            visibleTranscript: "",
            activityItems: new Map(),
            completedAgentMessages: [],
            nextAgentMessageStartsBlock: false,
            model: activeModel,
            nativeGoal: nativeGoal ? { turnCompleted: false } : undefined,
            timeoutRemainingMs: timeoutMs > 0 ? timeoutMs : undefined,
            outstandingServerRequestIds: new Set(),
            abort: signal ? () => signal.removeEventListener("abort", abort) : undefined,
            onOutput,
            onCodexServerRequest,
            resolve,
            reject
          };
        });
        // Said with the reply, and with a turn that failed or was stopped
        // (the copy is made either way).
        const reported = cutMissed
          ? resultPromise.then(
            (result) => ({ ...result, forkCutMissed: cutMissed }),
            (error: unknown) => {
              throw Object.assign(error instanceof Error ? error : new Error(String(error)), { forkCutMissed: cutMissed });
            }
          )
          : resultPromise;
        if (pendingTurn && timeoutMs > 0) {
          armPendingTurnTimer(pendingTurn, timeoutMs);
        }
        if (signal?.aborted) {
          abort();
          return reported;
        }
        signal?.addEventListener("abort", abort, { once: true });
        const codexTurnPrompt = codexPrompt(turnPrompt, repoPath, diffMode, kind, options);
        try {
          if (nativeGoal) {
            await sendRequest("thread/goal/set", {
              threadId: currentThreadId,
              objective: nativeGoal.objective,
              status: "active",
              tokenBudget: null
            });
          }
          const collaborationMode = this.cli.codexRuns.codexCollaborationMode(participant, kind, options, activeModel, activeEffort);
          const turnParams = {
            threadId: currentThreadId,
            effort: codexReasoningEffort(participant.reasoningEffort) ?? null,
            input: codexAppServerTurnInput(codexTurnPrompt, images)
          };
          let turn: CodexAppServerTurnStartResult;
          try {
            turn = await sendRequest("turn/start", collaborationMode ? { ...turnParams, collaborationMode } : turnParams, timeoutMs) as CodexAppServerTurnStartResult;
          } catch (error) {
            // A Codex that does not take the collaboration mode: its Default
            // is what it runs anyway, so the turn goes without it; Plan mode
            // never runs as something else, it fails and says why.
            if (!collaborationMode || !isCodexCollaborationModeRefusal(errorText(error))) throw error;
            if (collaborationMode.mode === "plan") {
              throw new Error("This Codex does not take Plan mode from the app. Update Codex, or turn Plan mode off.");
            }
            turn = await sendRequest("turn/start", turnParams, timeoutMs) as CodexAppServerTurnStartResult;
          }
          if (pendingTurn) {
            pendingTurn.acceptedByProvider = true;
            if (!pendingTurn.turnId) {
              pendingTurn.turnId = turn.turn?.id;
            }
          }
        } catch (error) {
          rejectPendingTurn(error instanceof Error ? error : new Error(String(error)));
        }
        return reported;
      }
    };
  }
}
