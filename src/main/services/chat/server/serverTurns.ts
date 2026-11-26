import { newOpId, serverSeqOf } from "../../chatServerOps";
import { hubTurnRunId, isHubTurnRunId, type HubOp, type HubTurn } from "../../../../shared/hubOps";
import { isMemberSessionExportTurnRequest } from "../../../../shared/memberSessionMove";
import type { AgentContextUsage, ChatMessage, ChatParticipant, Conversation } from "../../../../shared/types";
import { isMemberRestartTurnRequest } from "../../../../shared/memberRestart";
import { markStopUnconfirmed } from "../../machineTurnOutcome";
import { advanceAutoWatchCursorForDirectTargets } from "../autoWatch/watchers";
import { bareCompactCommand, parseCompactCommand } from "../compaction/compactionText";
import { agentContextUsageByParticipant } from "../compaction/contextUsage";
import { type SelfCompactionEnd, selfCompactionResumeFrom } from "../compaction/selfCompactionMarks";
import { assertParticipantProvidersEnabled, chatParticipants } from "../members/identity";
import { abortableWait } from "../runs/abortableWait";
import { INTERRUPTED_REPLY_TEXT } from "../runs/interruptions";
import { endAbortedServerTurn, turnShown } from "../runs/runOwnerRecords";
import { createChatMessage } from "../store/messages";
import { deliveryTargetsOf } from "../turns/deliveryTargets";
import type { ServerTurnOpen } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** How long the end of a turn run here waits for the save that writes its
 *  member's last bubble before it is sent anyway. */
const DEFERRED_SERVER_FINISH_MS = 10_000;

/** Members' turns the server asks for, and their ends told to it. */
export class ServerTurns {
  /** This machine knows which turns wait for it on the server (resumeServerTurns). */
  serverTurnsRead = false;
  /** Machine side: runs before a server turn asked of a member here starts
   *  (the machine's settings are made current first); false leaves the turn
   *  waiting on the server (an idle stop is under way). */
  private serverTurnPreparation?: (turn: HubTurn) => Promise<boolean>;
  // --- the User's server owns the chat (agreements Д1–Д13) -----------------

  /** Server turns this process runs or waits for itself (its own sends):
   *  the feed's executor leaves them alone. */
  readonly inProcessServerTurns = new Set<string>();
  /** A local run's server turn (and its chat), and back (Stop from another device). */
  private readonly serverRunOfLocal = new Map<string, { runId: string; conversationId: string; participantId: string }>();
  /** Ends of turns run here, held until the save that writes the member's
   *  last bubble of the run, so the server hears the end after the reply
   *  (whoever waits for the end reads the reply then). */
  readonly deferredServerFinishes = new Map<string, { conversationId: string; participantId: string; op: HubOp; timer: ReturnType<typeof setTimeout> }>();
  private readonly localRunOfServer = new Map<string, string>();
  /** How each local run's turn was opened on the server (memoized per run). */
  readonly serverTurnOpens = new Map<string, Promise<ServerTurnOpen>>();
  /** Waiting for a turn's state to change (a member running elsewhere). */
  private readonly serverTurnWaiters = new Map<string, Array<(turn: HubTurn) => void>>();
  /** The newest state heard of each recent turn, so a wait that starts late
   *  does not miss what already happened. */
  readonly serverTurnStates = new Map<string, HubTurn>();
  /** Turns the feed asked this device to run, while they are being started. */
  private readonly pendingServerTurns = new Map<string, AbortController>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "appQuit" | "compaction" | "host" | "memberMoves" | "memberRestart" | "members" | "participantBatch"
      | "runCancel" | "selfCompaction" | "selfCompactionResumes" | "serverChat" | "serverLink" | "store" | "titles" | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "onReviewProgress" | "settings" | "storage">
  ) {}

  /** Turns the server asked of members here that this device took and that
   *  are not over: from before they become a run (reading the chat,
   *  preparing the machine) to their end. */
  serverTurnsStarting(): number {
    return this.pendingServerTurns.size;
  }

  /** Machine side: what must happen before a turn the server asked of a
   *  member here starts (see serverTurnPreparation). */
  setServerTurnPreparation(prepare: ((turn: HubTurn) => Promise<boolean>) | undefined): void {
    this.serverTurnPreparation = prepare;
  }

  /** The server turn a run of this chat belongs to: as the server last said,
   *  as a message's turn marks keep it, or as the member's bubble names it. */
  knownServerTurn(conversation: Conversation, runId: string, row: ChatMessage | undefined): Pick<HubTurn, "runId" | "messageId" | "participantId"> | undefined {
    const known = this.serverTurnStates.get(runId);
    if (known && known.conversationId === conversation.id) return known;
    for (const message of conversation.messages) {
      for (const [participantId, mark] of Object.entries(message.metadata?.serverTurns ?? {})) {
        if (mark?.runId === runId) return { runId, messageId: message.id, participantId };
      }
    }
    const trigger = row?.metadata?.sourceMessageId ?? row?.metadata?.parentMessageId;
    if (row?.participantId && trigger && isHubTurnRunId(runId)) return { runId, messageId: trigger, participantId: row.participantId };
    return undefined;
  }

  /** A turn changed on the server: start it here when it is this device's
   *  to run, stop it when it was asked to stop, and tell whoever waits. */
  noteServerTurn(turn: HubTurn): void {
    this.serverTurnStates.delete(turn.runId);
    this.serverTurnStates.set(turn.runId, turn);
    while (this.serverTurnStates.size > 2_000) {
      const oldest = this.serverTurnStates.keys().next().value;
      if (oldest === undefined) break;
      this.serverTurnStates.delete(oldest);
    }
    const waiters = this.serverTurnWaiters.get(turn.runId);
    if (waiters) for (const resolve of [...waiters]) resolve(turn);
    if (turn.state === "finished" || turn.state === "stopped") {
      for (const listener of [...this.chat.store.chatSavedListeners.get(turn.conversationId) ?? []]) listener(undefined);
    }
    const me = this.chat.serverLink.current?.deviceId();
    // Stopped here before this device knew it was taken: stopped as it stands.
    if (this.chat.selfCompaction.remoteSelfCompactionsStopped.has(turn.runId) && (turn.state === "requested" || turn.state === "claimed") && !turn.stopRequestedAt) {
      void this.chat.serverLink.current?.enqueue([{ opId: newOpId(), kind: "turn.stop", conversationId: turn.conversationId, runId: turn.runId, messageId: turn.messageId, participantId: turn.participantId }]).catch(() => undefined);
    }
    this.chat.selfCompaction.observeServerCompaction(turn);
    if (turn.state === "requested") {
      void this.startServerTurn(turn).catch((error) => {
        void this.deps.debugLogs.write("chat.server-turn.start-error", { runId: turn.runId, message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (turn.state === "claimed" && turn.stopRequestedAt && turn.executorDeviceId === me) {
      this.chat.runCancel.cancelRun(this.localRunOfServer.get(turn.runId) ?? turn.runId);
      return;
    }
    if (turn.state === "stopped" && !turn.executorDeviceId) {
      this.chat.selfCompactionResumes.noteMemberStopped(turn.conversationId, turn.participantId, Date.parse(turn.finishedAt ?? ""));
      // Stopped before anyone took it: a start waiting here never begins, and
      // the member's own device says so in the chat, once.
      this.pendingServerTurns.get(turn.runId)?.abort();
      void this.noteServerTurnStoppedBeforeStart(turn).catch(() => undefined);
    }
  }

  private async noteServerTurnStoppedBeforeStart(turn: HubTurn): Promise<void> {
    // A compaction that never started is said by the device that asked for
    // it (compactParticipantOnMachine), with a compaction's own words.
    // A restart asked of a machine says nothing in the chat unless it ran.
    if (this.inProcessServerTurns.has(turn.runId) || turn.request?.kind === "compaction" || isMemberRestartTurnRequest(turn.request) || isMemberSessionExportTurnRequest(turn.request)) return;
    const conversation = await this.deps.storage.getConversation(turn.conversationId);
    if (!conversation || conversation.kind !== "chat") return;
    const participant = chatParticipants(conversation).find((item) => item.id === turn.participantId);
    const message = conversation.messages.find((item) => item.id === turn.messageId);
    if (!participant || !message || !this.chat.host.runsHere(participant)) return;
    if (turnShown(conversation, message, participant, turn.runId)) return;
    await this.noteTurnStoppedBeforeStart(conversation, message, participant);
  }

  /** Runs, here, a turn the server asked of one of this device's members
   *  (a User's message from any device, a request from a member elsewhere). */
  async startServerTurn(turn: HubTurn): Promise<void> {
    // Quitting: the turn waits on the server for this device's next start.
    if (!this.chat.serverLink.current || turn.state !== "requested" || this.chat.appQuit.quitting) return;
    const runId = turn.runId;
    if (this.inProcessServerTurns.has(runId) || this.pendingServerTurns.has(runId) || this.chat.activeRuns.conversationIdForRun(runId)) return;
    // Taken here before anything awaits: the feed and a resume after a
    // restart can both offer the same turn, and it runs once.
    const controller = new AbortController();
    this.pendingServerTurns.set(runId, controller);
    const release = (): void => { if (this.pendingServerTurns.get(runId) === controller) this.pendingServerTurns.delete(runId); };
    // The member it asks for cannot be removed from here until this turn
    // ends; a removal that passed its check just before is caught where the
    // turn starts (startServerTurnNow).
    const releaseMemberClaim = this.chat.members.claimMemberWork(turn.conversationId, [turn.participantId]);
    let started = false;
    try {
      started = await this.startServerTurnNow(turn, controller);
    } finally {
      releaseMemberClaim();
      if (!started) release();
    }
  }

  /** startServerTurn once the turn is reserved here; false when it was not
   *  started (not this device's, or this device takes nothing now). */
  private async startServerTurnNow(turn: HubTurn, controller: AbortController): Promise<boolean> {
    const runId = turn.runId;
    let conversation = await this.deps.storage.getConversation(turn.conversationId);
    // A chat (or the message it answers) this device has not read yet (it is
    // reading the server's chats for the first time): read it now.
    if ((!conversation || !conversation.messages.some((item) => item.id === turn.messageId)) && this.chat.serverChat.serverChatReader &&
        !await this.deps.storage.conversationTombstones?.().isDeleted(turn.conversationId)) {
      await this.chat.serverChat.reloadChatFromServer(turn.conversationId);
      conversation = await this.deps.storage.getConversation(turn.conversationId);
    }
    if (!conversation || conversation.kind !== "chat" || conversation.metadata.archived === true) return false;
    const participant = chatParticipants(conversation).find((item) => item.id === turn.participantId);
    if (!participant || !this.chat.host.runsHere(participant)) return false;
    // Moving: on a machine that handed its session over, its turns wait on
    // the server for its new device (or for the hold to end); on the
    // computer, they wait for the move and go where it runs then.
    const moving = isMemberSessionExportTurnRequest(turn.request) ? undefined : this.chat.memberMoves.memberMoveGate(conversation.id, participant.id);
    if (moving && this.chat.host.machineRuntime) return false;
    if (moving) {
      await abortableWait(moving, controller.signal);
      return this.startServerTurnNow(turn, controller);
    }
    if (isMemberSessionExportTurnRequest(turn.request) && !this.chat.host.machineRuntime) return false;
    const message = conversation.messages.find((item) => item.id === turn.messageId);
    if (!message) return false;
    // A machine makes its settings current first, and takes nothing while it
    // stops (the turn waits on the server for its next start).
    const prepared = await (this.serverTurnPreparation?.(turn) ?? Promise.resolve(true)).catch((error) => {
      void this.deps.debugLogs.write("chat.server-turn.prepare-error", { conversationId: turn.conversationId, runId, message: error instanceof Error ? error.message : String(error) });
      return true;
    });
    if (!prepared || controller.signal.aborted) return false;
    const warnings: string[] = [];
    const chat = await this.chat.store.requireChat(turn.conversationId);
    try {
      if (isMemberRestartTurnRequest(turn.request)) {
        // Before the provider check: closing a process needs no provider, and
        // a refusal there would leave the asking device waiting for a turn
        // nobody ends.
        await this.chat.memberRestart.runServerRestartTurn(turn, chat, participant, controller);
        return true;
      }
      if (isMemberSessionExportTurnRequest(turn.request)) {
        // Handing a session over needs no provider either.
        await this.chat.memberMoves.runServerSessionExportTurn(turn, chat, participant, controller);
        return true;
      }
      const settings = await this.deps.settings.getPublicSettings();
      assertParticipantProvidersEnabled([participant], settings.providers ?? []);
      if (participant.autoWatch === true) {
        await this.chat.store.withChatMutation(chat, async () => {
          advanceAutoWatchCursorForDirectTargets(chat, [participant], message);
          this.chat.store.queueSnapshot(chat);
        });
      }
      // `@handle /compact`, or `/compact` with no handle written to this
      // member (as sendMessage does it), never with pictures, skills or files.
      const bareCompact = message.role === "user" &&
        !message.metadata?.imageAttachments?.length && !message.metadata?.skillMentions?.length && !message.metadata?.repoFileMentions?.length
        ? bareCompactCommand(message.content) : undefined;
      const compact = message.role === "user"
        ? parseCompactCommand(message.content) ?? (bareCompact ? { handle: participant.handle, instructions: bareCompact.instructions } : undefined)
        : undefined;
      const request = turn.request ?? {};
      if (request.kind === "compaction" || (compact && compact.handle.toLowerCase() === participant.handle.toLowerCase())) {
        // The main session's compaction of a member holds the member's turns
        // from before it is taken: the work it gives that member a moment
        // later runs after it (app_chat_compact_participant).
        const heldEarly = request.kind === "compaction" && typeof request.requestedByParticipantId === "string"
          ? this.chat.turnQueue.reserveParticipantTurn(chat.id, participant.id) : undefined;
        // Taken on the server first, like any turn (Д5); a Stop from any
        // device reaches it by its run id.
        let claimed: Awaited<ReturnType<ServerTurns["claimServerTurnHere"]>>;
        try {
          claimed = await this.claimServerTurnHere(turn, controller.signal);
        } catch (error) {
          heldEarly?.release();
          throw error;
        }
        if (claimed !== "claimed") {
          heldEarly?.release();
          return true;
        }
        const run = this.chat.participantBatch.registerBackgroundRunController(runId, controller.signal);
        let outcome: "done" | "error" | "stopped" = "error";
        let usage: AgentContextUsage | undefined;
        // A member's own compaction: it goes on from it here.
        const resume = request.kind === "compaction" && request.triggeredBy === "agent" ? selfCompactionResumeFrom(request.resume) : undefined;
        let end: SelfCompactionEnd = { kind: "failed" };
        const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
        try {
          const compacted = await this.chat.compaction.compactParticipant({
            conversationId: chat.id, participantId: participant.id, handle: participant.handle,
            instructions: typeof request.instructions === "string" ? request.instructions : compact?.instructions,
            triggeredBy: request.triggeredBy === "agent" ? "agent" : "user", runId,
            // The chat's main session asked for it (app_chat_compact_participant).
            ...(request.kind === "compaction" && typeof request.requestedByParticipantId === "string"
              ? { requestedByParticipantId: request.requestedByParticipantId } : {}),
            // Asked as a compaction: in the thread it was asked from (none for
            // a member's own); typed as a message: under that message.
            ...(request.kind === "compaction"
              ? { threadId: text(request.threadId), parentMessageId: text(request.parentMessageId), chatThreadRootId: text(request.chatThreadRootId) }
              : { threadId: message.metadata?.threadId ?? message.id, parentMessageId: message.id, chatThreadRootId: message.metadata?.chatThreadRootId })
          }, run.signal, this.deps.onReviewProgress, (ended) => { end = ended; }, undefined, heldEarly);
          usage = agentContextUsageByParticipant(compacted.conversation)[participant.id];
          outcome = run.signal.aborted ? "stopped" : "done";
        } catch (error) {
          outcome = run.signal.aborted ? "stopped" : "error";
          end = { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
          throw error;
        } finally {
          run.cleanup();
          this.finishServerTurn(runId, outcome, usage);
          if (resume && outcome !== "stopped") {
            void this.chat.selfCompactionResumes.continueAfterSelfCompaction(chat.id, participant.id, resume, end,
              typeof request.instructions === "string" ? request.instructions : undefined);
          } else if (resume) {
            void this.chat.selfCompactionResumes.endSelfCompaction(chat.id, participant.id, resume.runId, this.chat.appQuit.quitting ? "interrupted" : "stopped");
          }
        }
        return true;
      }
      const stillMember = await this.chat.store.withChatMutation(chat, async () => {
        // A removal saved before this turn was claimed here (startServerTurn)
        // is in the chat this mutation refreshed: its member does not run.
        if (!chatParticipants(chat).some((item) => item.id === participant.id)) return false;
        if (this.chat.titles.armServerChatTitle(chat, message)) this.chat.store.queueSnapshot(chat);
        return true;
      });
      if (!stillMember) return false;
      await this.chat.participantBatch.runParticipantBatch(chat, [participant], message, runId, controller.signal, this.deps.onReviewProgress, warnings, {
        targetRunIds: new Map([[participant.id, runId]]),
        ...(turn.pendingMessageId ? { pendingMessageIds: new Map([[participant.id, turn.pendingMessageId]]) } : {})
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        const reason = error instanceof Error ? error.message : String(error);
        void this.deps.debugLogs.write("chat.server-turn.error", { conversationId: chat.id, runId, message: reason });
        warnings.push(`@${participant.handle} could not start: ${reason}`);
      }
    } finally {
      if (this.pendingServerTurns.get(runId) === controller) this.pendingServerTurns.delete(runId);
      if (warnings.length > 0) await this.chat.store.appendConversationWarnings(chat, warnings).catch(() => undefined);
    }
    return true;
  }

  /** After a start or a reconnect: every turn this device took and that
   *  nothing runs any more is closed (it stopped or restarted in the middle
   *  of it), and every turn asked of its members that nobody took yet starts
   *  (the computer or machine was off). */
  async resumeServerTurns(): Promise<void> {
    const link = this.chat.serverLink.current;
    if (!link) return;
    this.chat.serverChat.repairRepliesLeftRunningOnce(link);
    const { requested, claimed } = await link.waitingTurns();
    // What waits is known before the chats are looked through for replies a
    // restart left waiting (recoverSelfCompactions).
    for (const turn of [...claimed, ...requested]) if (!this.serverTurnStates.has(turn.runId)) this.serverTurnStates.set(turn.runId, turn);
    this.serverTurnsRead = true;
    for (const turn of claimed) {
      await this.closeOrphanedServerTurn(turn).catch((error) => {
        void this.deps.debugLogs.write("chat.server-turn.orphan-error", { runId: turn.runId, message: error instanceof Error ? error.message : String(error) });
      });
    }
    for (const turn of requested) await this.startServerTurn(turn).catch(() => undefined);
  }

  /** Takes a turn the server asked of a member here, for a run that has no
   *  turn of its own to open it (a compaction). */
  async claimServerTurnHere(turn: HubTurn, signal: AbortSignal): Promise<"claimed" | "stopped" | "skip"> {
    const link = this.chat.serverLink.current;
    if (!link) return "skip";
    this.inProcessServerTurns.add(turn.runId);
    this.serverRunOfLocal.set(turn.runId, { runId: turn.runId, conversationId: turn.conversationId, participantId: turn.participantId });
    this.localRunOfServer.set(turn.runId, turn.runId);
    const forget = () => {
      this.serverRunOfLocal.delete(turn.runId);
      this.localRunOfServer.delete(turn.runId);
    };
    try {
      const opId = newOpId();
      await link.enqueue([{ opId, kind: "turn.claim", conversationId: turn.conversationId, runId: turn.runId, messageId: turn.messageId, participantId: turn.participantId }]);
      const answer = await link.opAnswered(opId, signal);
      if (answer.status === "rejected") throw new Error(`The server did not give this turn: ${answer.reason}`);
      void this.deps.debugLogs.write("chat.server-turn.claim", { conversationId: turn.conversationId, runId: turn.runId, participantId: turn.participantId, claim: answer.claim });
      if (answer.claim === "claimed" || answer.claim === "already-yours") return "claimed";
      forget();
      return answer.claim === "stopped" ? "stopped" : "skip";
    } catch (error) {
      forget();
      throw error;
    }
  }

  /**
   * A turn this device took that nothing here runs any more: this device
   * stopped or restarted while it ran. Its bubble here is closed (never as
   * "stopped": a Stop asked meanwhile was not confirmed, the parity
   * exception's "restarted before confirming the stop") and the turn is
   * finished on the server as interrupted, so whoever waits for it stops
   * waiting.
   */
  private async closeOrphanedServerTurn(turn: HubTurn): Promise<void> {
    const link = this.chat.serverLink.current;
    if (!link || turn.state !== "claimed" || turn.executorDeviceId !== link.deviceId()) return;
    if (this.inProcessServerTurns.has(turn.runId) || this.pendingServerTurns.has(turn.runId) || this.localRunOfServer.has(turn.runId) ||
        this.chat.activeRuns.activeRunIds.has(turn.runId) || this.chat.activeRuns.chatRunControllers.has(turn.runId)) return;
    this.inProcessServerTurns.add(turn.runId);
    const conversation = await this.chat.store.requireChat(turn.conversationId).catch(() => undefined);
    if (conversation) {
      const participant = chatParticipants(conversation).find((item) => item.id === turn.participantId);
      const handle = participant?.handle ?? "member";
      await this.chat.store.withChatMutation(conversation, async () => {
        let changed = false;
        for (const message of conversation.messages) {
          if (message.role !== "participant" || message.participantId !== turn.participantId || message.metadata?.runId !== turn.runId) continue;
          const swept = message.metadata?.staleRunRecovery?.runId === turn.runId;
          if (message.status !== "pending" && !swept) continue;
          if (turn.stopRequestedAt) {
            markStopUnconfirmed(message, handle, `${this.chat.host.machineRuntime ? "The machine" : "This computer"} restarted before confirming the stop.`);
          } else if (message.status === "pending") {
            message.status = "error";
            if (!message.content) message.content = INTERRUPTED_REPLY_TEXT;
          }
          changed = true;
        }
        if (changed) {
          conversation.updatedAt = new Date().toISOString();
          this.chat.store.queueSnapshot(conversation);
        }
      });
      await this.chat.store.waitForQueuedSave(conversation.id);
    }
    void this.deps.debugLogs.write("chat.server-turn.orphan-closed", { conversationId: turn.conversationId, runId: turn.runId, stopRequested: Boolean(turn.stopRequestedAt) });
    await link.enqueue([{ opId: newOpId(), kind: "turn.finish", conversationId: turn.conversationId, runId: turn.runId, outcome: "interrupted" }]);
  }

  /** Opens a member's turn on the server before anything of it is shown or
   *  run (Д4, Д5, Д13): the message it answers must be on the server first,
   *  then the turn is taken here (a member that runs here) or asked of the
   *  device it runs on. Memoized per local run. `ownTurn`: never the turn
   *  the User's message asked of the member (see runParticipantTurnSerialized). */
  openServerTurn(conversation: Conversation, participant: ChatParticipant, triggerMessage: ChatMessage, localRunId: string, signal?: AbortSignal, ownTurn = false): Promise<ServerTurnOpen> {
    const known = this.serverTurnOpens.get(localRunId);
    if (known) return known;
    const opening = this.openServerTurnNow(conversation, participant, triggerMessage, localRunId, signal, ownTurn);
    this.serverTurnOpens.set(localRunId, opening);
    void opening.catch(() => this.serverTurnOpens.delete(localRunId));
    return opening;
  }

  private async openServerTurnNow(conversation: Conversation, participant: ChatParticipant, triggerMessage: ChatMessage, localRunId: string, signal?: AbortSignal, ownTurn = false): Promise<ServerTurnOpen> {
    const link = this.chat.serverLink.current;
    if (!link) return { kind: "none" };
    const targets = deliveryTargetsOf(triggerMessage);
    const canonical = !ownTurn && triggerMessage.role === "user" && targets.includes(participant.id);
    const serverRunId = canonical ? hubTurnRunId(triggerMessage.id, participant.id) : localRunId.startsWith("turn-") ? localRunId : `turn-${localRunId}`;
    this.inProcessServerTurns.add(serverRunId);
    this.serverRunOfLocal.set(localRunId, { runId: serverRunId, conversationId: conversation.id, participantId: participant.id });
    this.localRunOfServer.set(serverRunId, localRunId);
    let claimOpId: string | undefined;
    try {
      // A member that is moving is routed once it moved, by its new home; a
      // Stop meanwhile ends the turn on the server like any Stop before it starts.
      const moving = this.chat.memberMoves.memberMoveGate(conversation.id, participant.id);
      if (moving) await abortableWait(moving, signal);
      participant = await this.chat.memberMoves.memberWhereItRunsNow(conversation, participant);
      // Д13: the message this turn answers is on the server before the
      // member starts — with no server reachable, it waits, visibly unsent.
      await this.chat.store.waitForQueuedSave(conversation.id);
      const stored = conversation.messages.find((message) => message.id === triggerMessage.id) ?? triggerMessage;
      if (serverSeqOf(stored) === undefined) {
        const answer = await link.messageAccepted(conversation.id, triggerMessage.id, signal);
        if (answer?.status === "rejected") throw new Error(`The server did not accept the message this turn answers: ${answer.reason}`);
      }
      if (!this.chat.host.runsHere(participant)) return { kind: "remote", serverRunId, canonical };
      const opId = newOpId();
      claimOpId = opId;
      await link.enqueue([{ opId, kind: "turn.claim", conversationId: conversation.id, runId: serverRunId, messageId: triggerMessage.id, participantId: participant.id }]);
      const answer = await link.opAnswered(opId, signal);
      if (answer.status === "rejected") throw new Error(`The server did not give @${participant.handle} this turn: ${answer.reason}`);
      void this.deps.debugLogs.write("chat.server-turn.claim", { conversationId: conversation.id, runId: serverRunId, participantId: participant.id, claim: answer.claim });
      if (answer.claim === "claimed" || answer.claim === "already-yours") return { kind: "local", serverRunId };
      if (answer.claim === "stopped") return { kind: "stopped", serverRunId };
      return { kind: "skip", serverRunId, reason: answer.claim ?? "unknown" };
    } catch (error) {
      if (signal?.aborted) {
        // Stopped while waiting for the server: the turn never starts anywhere.
        void endAbortedServerTurn(link, { conversationId: conversation.id, runId: serverRunId, messageId: triggerMessage.id, participantId: participant.id }, claimOpId)
          .catch(() => undefined);
      }
      this.serverRunOfLocal.delete(localRunId);
      this.localRunOfServer.delete(serverRunId);
      throw error;
    }
  }

  /** The end of a turn this device ran, said on the server. */
  finishServerTurn(localRunId: string, outcome: "done" | "error" | "stopped" | "interrupted", contextUsage?: AgentContextUsage): void {
    const queue = this.chat.serverLink.serverQueue();
    const server = this.serverRunOfLocal.get(localRunId);
    this.serverTurnOpens.delete(localRunId);
    if (!queue || !server) return;
    this.serverRunOfLocal.delete(localRunId);
    this.localRunOfServer.delete(server.runId);
    const op: HubOp = { opId: newOpId(), kind: "turn.finish", conversationId: server.conversationId, runId: server.runId, outcome,
      ...(contextUsage ? { contextUsage: contextUsage as unknown as Record<string, unknown> } : {}) };
    // The member's last bubble of the run is saved by the caller right after
    // this: the end goes with that save (persistConversationSnapshotNow), or
    // at once when nothing of the run is still pending here.
    const timer = setTimeout(() => this.releaseDeferredServerFinish(server.runId), DEFERRED_SERVER_FINISH_MS);
    timer.unref?.();
    this.deferredServerFinishes.set(server.runId, { conversationId: server.conversationId, participantId: server.participantId, op, timer });
    void (async () => {
      await this.chat.store.waitForQueuedSave(server.conversationId);
      const stored = await this.deps.storage.getConversation(server.conversationId);
      const pending = stored?.messages.some((message) => message.participantId === server.participantId && message.metadata?.runId === server.runId && message.status === "pending");
      if (!pending) this.releaseDeferredServerFinish(server.runId);
    })().catch(() => this.releaseDeferredServerFinish(server.runId));
  }

  private releaseDeferredServerFinish(serverRunId: string): void {
    const deferred = this.deferredServerFinishes.get(serverRunId);
    if (!deferred) return;
    this.deferredServerFinishes.delete(serverRunId);
    clearTimeout(deferred.timer);
    void this.chat.serverLink.serverQueue()?.enqueue([deferred.op]).catch(() => undefined);
  }

  /** Waits for a turn on the server to reach one of `states`. */
  waitForServerTurn(runId: string, done: (turn: HubTurn) => boolean, signal?: AbortSignal): Promise<HubTurn> {
    return new Promise((resolve, reject) => {
      const list = this.serverTurnWaiters.get(runId) ?? [];
      const onAbort = () => { remove(); reject(signal?.reason ?? new Error("Chat run cancelled.")); };
      const remove = () => {
        const current = (this.serverTurnWaiters.get(runId) ?? []).filter((item) => item !== check);
        if (current.length) this.serverTurnWaiters.set(runId, current); else this.serverTurnWaiters.delete(runId);
        signal?.removeEventListener("abort", onAbort);
      };
      const check = (turn: HubTurn) => {
        if (!done(turn)) return;
        remove();
        resolve(turn);
      };
      this.serverTurnWaiters.set(runId, [...list, check]);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const known = this.serverTurnStates.get(runId);
      if (known) check(known);
    });
  }

  /** A member stopped before its turn started (on the server, from any
   *  device): the line a member stopped while queued gets. */
  async noteTurnStoppedBeforeStart(conversation: Conversation, message: ChatMessage, participant: ChatParticipant): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      conversation.messages.push(createChatMessage("system", `@${participant.handle} stopped by user.`, undefined, {
        threadId: message.metadata?.threadId ?? message.id,
        parentMessageId: message.id,
        chatThreadRootId: message.metadata?.chatThreadRootId
      }));
      conversation.updatedAt = new Date().toISOString();
      this.chat.store.queueSnapshot(conversation);
    });
  }
}
