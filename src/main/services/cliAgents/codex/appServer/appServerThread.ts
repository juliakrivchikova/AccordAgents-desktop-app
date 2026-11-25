import {
  codexForkCut, FORK_CUT_NOT_IN_SESSION, FORK_CUT_SESSION_GONE, FORK_CUT_TURNS_UNLISTED, isForkCutMissingError
} from "../../../forkCut";
import type { CodexTurnSummary, ForkCutDecision } from "../../../forkCut";
import type { ChatReasoningEffort } from "../../../../../shared/types";
import {
  codexAppServerThreadForkParams, codexAppServerThreadResumeParams, codexAppServerThreadStartParams, codexReasoningEffort
} from "../appServerParams";
import { isForkSourceMissingError } from "../../runs/forkSource";
import { errorText } from "../../runs/outputText";
import { asRecord, stringField } from "../../runs/records";
import type { CodexAppServerThreadStartResult } from "./types";
import type { AppServerModules } from "./modules";
import type { AppServerLaunch } from "./launch";

// Fork to new chat from a reply from before its turn id was recorded: the
// source thread's turns are read newest first, a page at a time (the reply
// is usually among the newest), at most this many.
const CODEX_FORK_CUT_PAGE_SIZE = 50;

const CODEX_FORK_CUT_MAX_PAGES = 40;

/** The thread a member's turns run in: started, resumed, or forked from a copy. */
export class AppServerThread {
  threadId?: string;
  threadLoaded = false;
  private initialized = false;
  activeModel: string | undefined;
  // The effort the thread runs at as Codex says (her config's when the
  // member sets none): a collaboration mode said on a turn keeps it.
  activeEffort?: ChatReasoningEffort;
  // Fork to new chat: why the fork just made copied the whole thread
  // instead of ending where it was asked to (the next run reports it).
  forkCutMissed?: string;
  // Said once the copy is made (thread/fork answered, still before the
  // turn runs): a source that is gone gets no copy, and its fork says only
  // that it starts clean.
  private forkCutMissedPending?: string;

  constructor(
    private readonly server: Pick<AppServerModules, "connection">,
    private readonly launch: Pick<AppServerLaunch, "cli" | "kind" | "options" | "participant" | "repoPath">
  ) {}

  // The model and effort the thread runs at, as Codex said on start,
  // resume or fork.
  takeThread(result: CodexAppServerThreadStartResult): void {
    this.activeModel = result.model ?? this.activeModel;
    this.activeEffort = codexReasoningEffort((result.reasoningEffort ?? undefined) as ChatReasoningEffort | undefined) ?? this.activeEffort;
  }

  private async initialize(timeoutMs?: number): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.server.connection.sendRequest("initialize", {
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
    this.initialized = true;
  }

  private missedCut(reason: string): void {
    this.forkCutMissedPending = reason;
  }

  /** Where a Fork to new chat's copy ends (options.forkCut): the turn its
   *  reply recorded, or, for a reply from before that, the last turn that
   *  ended by the reply's finish, read from the thread's turns newest
   *  first; undefined for all of it (nothing came after, or no point can
   *  be named: forkCutMissed says why). */
  private async codexForkLastTurnId(sourceThreadId: string, timeoutMs?: number): Promise<string | undefined> {
    const cut = this.launch.options.forkCut;
    if (!cut) return undefined;
    if (cut.unknown) {
      this.missedCut(cut.unknown);
      return undefined;
    }
    if (cut.at) return cut.at;
    if (!cut.finishedBy) return undefined;
    let decision: ForkCutDecision | undefined;
    try {
      const turns: CodexTurnSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < CODEX_FORK_CUT_MAX_PAGES && !decision; page += 1) {
        const listed = asRecord(await this.server.connection.sendRequest("thread/turns/list", {
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
      void this.launch.cli.cliRuns.writeDebugLog("cli-agent-codex-fork-cut-unlisted", { participantId: this.launch.participant.id, error: errorText(error) });
    }
    const resolved: ForkCutDecision = decision ?? { kind: "missed", reason: FORK_CUT_TURNS_UNLISTED };
    void this.launch.cli.cliRuns.writeDebugLog("cli-agent-codex-fork-cut", {
      participantId: this.launch.participant.id,
      decision: resolved.kind,
      ...(resolved.kind === "missed" ? { reason: resolved.reason } : {})
    });
    if (resolved.kind === "missed") this.missedCut(resolved.reason);
    return resolved.kind === "cut" ? resolved.at : undefined;
  }

  async ensureThread(timeoutMs?: number): Promise<string> {
    await this.initialize(timeoutMs);
    if (this.threadId && this.threadLoaded) {
      return this.threadId;
    }
    if (!this.threadId && this.launch.options.forkFromSessionId) {
      // A member made as a fork of another member's thread: its own thread
      // starts as a copy (Codex 0.155.1 forks a thread another process is
      // still running a turn on). Never the source's id: the member must
      // not write to the session it was copied from.
      const sourceThreadId = this.launch.options.forkFromSessionId;
      this.forkCutMissed = undefined;
      this.forkCutMissedPending = undefined;
      const forkParams = codexAppServerThreadForkParams(sourceThreadId, this.launch.participant, this.launch.repoPath, this.launch.kind, this.launch.options);
      let forkedThreadId: string | undefined;
      let result: CodexAppServerThreadStartResult;
      try {
        // Fork to new chat: only through the turn of the reply the User saw
        // last (Codex 0.155.1 `lastTurnId`, inclusive), in the thread that
        // reply was in (the member's own now, unless it changed after it).
        const lastTurnId = await this.codexForkLastTurnId(sourceThreadId, timeoutMs);
        const replyThreadId = lastTurnId && this.launch.options.forkCut?.sessionId?.trim() ? this.launch.options.forkCut.sessionId.trim() : sourceThreadId;
        try {
          result = await this.server.connection.sendRequest("thread/fork", lastTurnId ? { ...forkParams, threadId: replyThreadId, lastTurnId } : forkParams, timeoutMs) as CodexAppServerThreadStartResult;
        } catch (error) {
          const text = errorText(error);
          const earlierGone = replyThreadId !== sourceThreadId && (isForkSourceMissingError(text) || /thread not (?:found|loaded)/i.test(text));
          if (!lastTurnId || (!earlierGone && !isForkCutMissingError(text))) throw error;
          // Codex does not know that turn, or the thread it was in is gone:
          // the whole of the member's thread, and the chat says so.
          void this.launch.cli.cliRuns.writeDebugLog("cli-agent-codex-fork-cut-refused", { participantId: this.launch.participant.id, earlierGone });
          this.missedCut(earlierGone ? FORK_CUT_SESSION_GONE : FORK_CUT_NOT_IN_SESSION);
          result = await this.server.connection.sendRequest("thread/fork", forkParams, timeoutMs) as CodexAppServerThreadStartResult;
        }
        forkedThreadId = result.thread?.id ?? result.thread?.sessionId;
        if (!forkedThreadId || forkedThreadId === this.launch.options.forkFromSessionId) {
          throw new Error("codex app-server did not return a thread id for the fork");
        }
      } catch (error) {
        // No copy was made: the caller may try again or start clean
        // (ParticipantRunResult.forkCopyFailed).
        this.forkCutMissedPending = undefined;
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { forkCopyFailed: true });
      }
      if (this.forkCutMissedPending) {
        this.forkCutMissed = this.forkCutMissedPending;
        this.forkCutMissedPending = undefined;
        this.launch.options.onForkCutMissed?.(this.forkCutMissed);
      }
      this.threadId = forkedThreadId;
      this.threadLoaded = true;
      this.takeThread(result);
      return forkedThreadId;
    }
    if (this.threadId) {
      if (this.launch.options.sessionId && this.threadId === this.launch.options.sessionId) {
        const result = await this.server.connection.sendRequest("thread/resume", codexAppServerThreadResumeParams(this.launch.options.sessionId, this.launch.participant, this.launch.repoPath, this.launch.kind, this.launch.options), timeoutMs) as CodexAppServerThreadStartResult;
        this.threadId = result.thread?.id ?? this.launch.options.sessionId;
        this.takeThread(result);
      }
      this.threadLoaded = true;
      return this.threadId;
    }
    const result = await this.server.connection.sendRequest("thread/start", codexAppServerThreadStartParams(this.launch.participant, this.launch.repoPath, this.launch.kind, this.launch.options), timeoutMs) as CodexAppServerThreadStartResult;
    const nextThreadId = result.thread?.id ?? result.thread?.sessionId;
    if (!nextThreadId) {
      throw new Error("codex app-server did not return a thread id");
    }
    this.threadId = nextThreadId;
    this.threadLoaded = true;
    this.takeThread(result);
    return nextThreadId;
  }
}
