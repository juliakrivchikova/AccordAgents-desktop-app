import { chatParticipants } from "../members/identity";
import { INTERRUPTED_REPLY_TEXT, markStoppedByQuit } from "./interruptions";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** The app's quit: no new turns, and the running ones ended. */
export class AppQuit {
  /** The app quits (main.ts, before-quit): as a machine drains, no turn the
   *  server asks starts here and no requester is resumed (both wait for the
   *  next start). */
  quitting = false;
  /** Requesters a quit kept from resuming: resumed if it does not happen. */
  readonly resumesSkippedWhileQuitting = new Map<string, { conversationId: string; options: { groupCheck?: boolean } }>();
  /** Turns still running when a quit turned out not to happen (endQuit): the
   *  quit closed their members' processes, and their ends, which come
   *  seconds later, are the quit's, not failures of the members. */
  private readonly runsClosedByQuit = new Set<string>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "appMcpGrants" | "approvalDecisions" | "host" | "requestRecovery" | "requesterResumes" | "serverTurns"
      | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "onReviewProgress">
  ) {}

  /** The app quits (main.ts, before-quit), as a machine drains: no turn the
   *  server asks starts here from now on (it waits there), and no requester
   *  is resumed (its recovery does it at the next start). */
  beginQuit(): void {
    this.quitting = true;
    this.runsClosedByQuit.clear();
  }

  /** Whether a run's end is the User's quit's: while she quits, or for a turn
   *  the quit closed and that ends after the quit did not happen. */
  endsByQuit(runId: unknown): boolean {
    return this.quitting || (typeof runId === "string" && this.runsClosedByQuit.has(runId));
  }

  /** The quit did not happen after all (main.ts quitWasCancelled): turns
   *  start and requesters resume again. */
  endQuit(): void {
    // The quit's steps have ended (main.ts waits for them): every member's
    // process it closed belongs to a turn still running now.
    const wasQuitting = this.quitting;
    if (wasQuitting) for (const runId of [...this.chat.activeRuns.chatRunMeta.keys(), ...this.chat.activeRuns.activeRunIds]) this.runsClosedByQuit.add(runId);
    this.quitting = false;
    // The quit stopped the app tools' server, which starts again on another
    // address with no tokens: a member's kept connection points at the old
    // one. A Claude process launched with it found no app tools, and its
    // session was then started anew (2026-11-22 QA). Each member gets a new
    // connection on its next turn. (No quit: a live process keeps its own.)
    if (wasQuitting) {
      this.chat.appMcpGrants.appMcpTokens.clear();
      this.chat.appMcpGrants.appMcpConnections.clear();
    }
    const skipped = [...this.resumesSkippedWhileQuitting];
    this.resumesSkippedWhileQuitting.clear();
    for (const [requestMessageId, resume] of skipped) {
      void this.chat.requesterResumes.autoResumeParticipantRequest(resume.conversationId, requestMessageId, this.deps.onReviewProgress, resume.options).catch((error) => {
        void this.deps.debugLogs.write("chat.participant-request.auto-resume.error", {
          conversationId: resume.conversationId,
          requestMessageId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  /** Resolves once no member's turn runs here (each saved how it ended, so
   *  its end is queued for the server), or after `timeoutMs`. A requester
   *  still collecting answers is not waited for (liveRunIds counts it): it
   *  is resumed at the next start. */
  async waitForRunsToEnd(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.chat.activeRuns.chatRunMeta.size > 0 || this.chat.activeRuns.activeRunIds.size > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await this.chat.store.settleChatSaves();
    return true;
  }

  /** Quitting, while the members' processes close: a turn of a member here
   *  that has not ended by itself ends now as the next start would close it
   *  (its bubble swept as recoverStaleChatRun does, its turn on the server
   *  finished as interrupted), in one save per chat, so the server hears it
   *  before the link closes. The run's own end comes seconds later (a closed
   *  process is told apart from a missing CLI); a reply that does end after
   *  all still replaces the swept bubble. Returns how many turns it ended. */
  async endTurnsForQuit(): Promise<number> {
    const byChat = new Map<string, Array<{ runId: string; participantId: string }>>();
    for (const [runId, meta] of this.chat.activeRuns.chatRunMeta) {
      byChat.set(meta.conversationId, [...(byChat.get(meta.conversationId) ?? []), { runId, participantId: meta.participantId }]);
    }
    let ended = 0;
    for (const [conversationId, runs] of byChat) {
      const conversation = await this.chat.store.requireChat(conversationId).catch(() => undefined);
      if (!conversation) continue;
      await this.chat.store.withChatMutation(conversation, async () => {
        let changed = false;
        for (const run of runs) {
          const participant = chatParticipants(conversation).find((item) => item.id === run.participantId);
          // A member on a machine goes on there: its turn is not this quit's
          // (nor one removed meanwhile, whose turn the next start closes).
          if (!participant || !this.chat.host.runsHere(participant)) continue;
          for (const message of conversation.messages) {
            if (message.role !== "participant" || message.participantId !== run.participantId || message.metadata?.runId !== run.runId ||
                message.status !== "pending" || message.metadata?.serverPlaceholder) continue;
            markStoppedByQuit(message, true);
            changed = true;
          }
          // Its cards (a permission, a plan, a compaction) close with it, as
          // its own end closes them, so no phone keeps them open.
          if (this.chat.approvalDecisions.markPendingAppToolApprovalsForRunTerminal(conversation, run.runId, INTERRUPTED_REPLY_TEXT)) changed = true;
          this.chat.serverTurns.finishServerTurn(run.runId, "interrupted");
          ended += 1;
        }
        // The requests those turns answered end as the next start would end
        // them (a phone showed "Waiting on …" with Stop meanwhile); one with
        // a member on a machine still at work goes on.
        if (changed && this.chat.requestRecovery.markOrphanedParticipantRequestsInterrupted(conversation, { ignoreLocalRequestLocks: true })) changed = true;
        if (changed) {
          conversation.updatedAt = new Date().toISOString();
          this.chat.store.queueSnapshot(conversation);
        }
      });
      await this.chat.store.waitForQueuedSave(conversationId);
    }
    await this.chat.store.settleChatSaves();
    return ended;
  }
}
