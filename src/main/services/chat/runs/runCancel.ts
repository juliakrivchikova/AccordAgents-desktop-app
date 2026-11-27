import { newOpId } from "../../chatServerOps";
import type { ClaudeSendNowOutcome, CliAgentRunner } from "../../cliAgents";

/** How long Send now waits for a just-sent message to reach the member's
 *  Claude Code before it stops the reply for it instead (40 x 100 ms). */
const SEND_NOW_WAIT_TRIES = 40;
const SEND_NOW_WAIT_MS = 100;
/** How long a request delivered now asks a Claude Code CLI that cannot tell
 *  yet whether it takes it now (a process still starting): 60 x 500 ms. */
const DELIVER_NOW_TRIES = 60;
const DELIVER_NOW_RETRY_MS = 500;
import type { ChatMessage, Conversation } from "../../../../shared/types";
import { readActiveRunIds, withParticipantCompactionsForRunRemoved } from "../../../../shared/chatRunState";
import { chatParticipants } from "../members/identity";
import type { DeliveryWay } from "../members/roleRuntime";
import { chatRunId, markStoredParticipantRunStoppedByUser } from "./runOwnerRecords";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Stop, wherever the run is. */
export class RunCancel {
  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "approvalDecisions" | "autoWatch" | "host" | "runOwners" | "selfCompactionResumes" | "serverLink"
      | "serverTurns" | "store" | "titles" | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs" | "storage">
  ) {}

  /**
   * Send now on a message waiting behind a member's running reply: the member
   * takes it now, as the CLI's own send-now does. A Claude member here gets
   * the CLI's send-now, which ends no background task and may take the
   * message into the running step instead of ending it. Otherwise (another
   * CLI, an older Claude Code, the message not at the CLI yet) the reply is
   * stopped for it, keeps what it wrote and goes on in that message's reply,
   * never "stopped by user" (ActiveRuns.sentNowRunIds). A member on another
   * device does the same there, asked through the User's server.
   */
  async sendNow(runId: string, waitingRunId?: string): Promise<void> {
    const targetRunId = runId.trim();
    if (!targetRunId) return;
    const controllers = this.chat.activeRuns.chatRunControllers.get(targetRunId);
    if (!controllers || controllers.size === 0) {
      void this.cancelStoredRun(targetRunId, { sendNow: true, waitingRunId: waitingRunId?.trim() || undefined }).catch((error) => {
        void this.deps.debugLogs.write("chat.send-now.stored-run.error", { runId: targetRunId, message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    // A member on another device: its device does the Send now, asked through
    // the User's server; the turn this device follows goes on.
    const open = await this.chat.serverTurns.serverTurnOpens.get(targetRunId)?.catch(() => undefined);
    if (open?.kind === "remote") {
      await this.cancelStoredRun(targetRunId, { sendNow: true, waitingRunId: waitingRunId?.trim() || undefined });
      return;
    }
    const meta = this.chat.activeRuns.chatRunMeta.get(targetRunId);
    const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "memberClaudeSendNow">>;
    const ask = (): Promise<ClaudeSendNowOutcome> => meta && runner.memberClaudeSendNow
      ? runner.memberClaudeSendNow.call(this.deps.cliRunner, meta.conversationId, meta.participantId, waitingRunId?.trim() || undefined, targetRunId)
        .catch(() => "unsupported" as const)
      : Promise.resolve("unsupported" as const);
    // A message sent with Cmd+Enter (or pressed as it is sent) reaches the CLI
    // a moment after this: the CLI's own Send now needs it there.
    // Still worth acting on: the reply runs and was not stopped meanwhile, and
    // the message pressed on still waits (not taken back, not failed).
    const waitingRun = waitingRunId?.trim();
    const waits = (): boolean => waitingRun
      ? this.chat.activeRuns.chatRunControllers.has(waitingRun)
      // The composer's send-now names no message: one of this member's waits.
      : [...this.chat.activeRuns.chatRunMeta.entries()].some(([runId, other]) => runId !== targetRunId && meta !== undefined &&
        other.conversationId === meta.conversationId && other.participantId === meta.participantId);
    // A message just sent (Cmd+Enter, or a turn a machine is still preparing)
    // is not registered yet and still counts as waiting; once seen, its going
    // away means it was taken back or failed, and nothing is cut for it.
    let seenWaiting = false;
    const stillWaits = (): boolean => {
      const now = waits();
      if (now) seenWaiting = true;
      return now || !seenWaiting;
    };
    const stillWanted = (): boolean =>
      [...(this.chat.activeRuns.chatRunControllers.get(targetRunId) ?? [])].some((controller) => !controller.signal.aborted) && stillWaits();
    let outcome = await ask();
    // Wait for the message at the CLI (Claude), or for a just-sent message to
    // be registered at all (any member) before anything is cut for it.
    for (let tries = 0; (outcome === "not_at_cli" || (outcome === "unsupported" && !waits())) && tries < SEND_NOW_WAIT_TRIES && stillWanted(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, SEND_NOW_WAIT_MS));
      if (outcome === "not_at_cli") outcome = await ask();
    }
    void this.deps.debugLogs.write("chat.send-now.requested", { runId: targetRunId, outcome });
    if (outcome !== "unsupported" && outcome !== "not_at_cli") return;
    // A reply is cut only for a message that really waits behind it.
    if (!stillWanted() || !waits()) return;
    this.chat.activeRuns.sentNowRunIds.add(targetRunId);
    this.cancelRun(targetRunId);
  }

  /**
   * A request asked with `deliver: "now"` (app_chat_request_participants)
   * reaches the member here now, as a message typed into its CLI mid-turn
   * does. `into-running-turn`, once the message is in the Claude Code CLI's
   * queue: the CLI's own send-now, so the running step takes it at its next
   * tool result or is cut for it (a Claude Code without send-now hands it over
   * at the next tool result anyway). `interrupt-and-restart`: the member's
   * running turn is cut as Send now cuts it (it keeps what it wrote and ends
   * as a turn that goes on, never "stopped by user"), and the request runs
   * next in the same session (TurnQueue `next`).
   */
  async deliverNow(conversationId: string, participantId: string, waitingRunId: string, way: DeliveryWay | "steered" | "after-turn"): Promise<void> {
    // Codex took it into its running turn itself (its steer), or takes it
    // right after that turn, which waits on the User's approval (its CLI's
    // prompt holds what is typed then): only said, nothing is cut.
    if (way === "steered" || way === "after-turn") {
      void this.deps.debugLogs.write("chat.deliver-now", { conversationId, participantId, runId: waitingRunId, way });
      return;
    }
    if (way === "into-running-turn") {
      // Asked as the message is written: it is in the CLI's queue now.
      // "not_at_cli": the CLI took it already. "unsupported": the CLI cannot
      // tell yet (a process just started has not said what it can do, or no
      // step runs yet): asked again for a while, as long as the message waits.
      const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "memberClaudeSendNow">>;
      const ask = (): Promise<ClaudeSendNowOutcome> => runner.memberClaudeSendNow
        ? runner.memberClaudeSendNow.call(this.deps.cliRunner, conversationId, participantId, waitingRunId, undefined).catch(() => "unsupported" as const)
        : Promise.resolve("unsupported" as const);
      let outcome = await ask();
      let tries = 1;
      const waits = (): boolean => [...(this.chat.activeRuns.chatRunControllers.get(waitingRunId) ?? [])].some((controller) => !controller.signal.aborted);
      for (; outcome === "unsupported" && tries < DELIVER_NOW_TRIES && waits(); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, DELIVER_NOW_RETRY_MS));
        outcome = await ask();
      }
      void this.deps.debugLogs.write("chat.deliver-now", { conversationId, participantId, runId: waitingRunId, way, outcome, tries });
      return;
    }
    // The request was stopped (or ended) meanwhile: nothing is cut for it.
    const alive = [...(this.chat.activeRuns.chatRunControllers.get(waitingRunId) ?? [])].some((controller) => !controller.signal.aborted);
    if (!alive) {
      void this.deps.debugLogs.write("chat.deliver-now", { conversationId, participantId, runId: waitingRunId, way, cutRunIds: [], skipped: "request-ended" });
      return;
    }
    const cut: string[] = [];
    for (const runId of this.chat.turnQueue.runningTurnRunIds(conversationId, participantId)) {
      // A turn whose CLI has answered already is finished, not cut.
      if (runId === waitingRunId || this.chat.activeRuns.cliReturnedRunIds.has(runId)) continue;
      const controllers = this.chat.activeRuns.chatRunControllers.get(runId);
      if (!controllers || [...controllers].every((controller) => controller.signal.aborted)) continue;
      this.chat.activeRuns.sentNowRunIds.add(runId);
      this.cancelRun(runId);
      cut.push(runId);
    }
    void this.deps.debugLogs.write("chat.deliver-now", { conversationId, participantId, runId: waitingRunId, way, cutRunIds: cut });
  }

  cancelRun(runId: string): boolean {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return false;
    }
    const controllers = this.chat.activeRuns.chatRunControllers.get(targetRunId);
    const stopped = this.chat.activeRuns.chatRunMeta.get(targetRunId);
    // A request taken into another's turn does not run the member: its Stop
    // ends only that request.
    if (stopped && !this.chat.activeRuns.sentNowRunIds.has(targetRunId) && !this.chat.turnQueue.isJoinedRun(targetRunId)) {
      this.chat.selfCompactionResumes.noteMemberStopped(stopped.conversationId, stopped.participantId);
    }
    void this.deps.debugLogs.write("chat.cancel.requested", {
      runId: targetRunId,
      localControllers: controllers?.size ?? 0
    });
    let cancelled = false;
    if (controllers && controllers.size > 0) {
      for (const controller of controllers) {
        controller.abort();
      }
      cancelled = true;
    }
    if (!cancelled) {
      void this.cancelStoredRun(targetRunId).catch((error) => {
        void this.deps.debugLogs.write("chat.cancel-stored-run.error", {
          runId: targetRunId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
      return true;
    }
    return true;
  }

  private async cancelStoredRun(runId: string, options: { sendNow?: boolean; waitingRunId?: string } = {}): Promise<boolean> {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return false;
    }
    const summaries = await this.deps.storage.listConversations();
    for (const summary of summaries) {
      if (summary.kind !== "chat") {
        continue;
      }
      const conversation = await this.deps.storage.getConversation(summary.id);
      if (!conversation || conversation.kind !== "chat") {
        continue;
      }
      const activeRunIds = readActiveRunIds(conversation.metadata);
      // A row here is evidence about the run, not the authority over it. The
      // machine owns its own runs: one it has started but not yet replicated
      // here, and one whose row this copy has already settled, are both still
      // alive there. Requiring a *pending* row meant such a Stop was never
      // published to the machine at all, while cancelRun still reported it as
      // requested -- the User pressed Stop and nothing happened.
      // A run can own several rows (a resumed reply, a message the member posted
      // through an app tool, a cloud preparation row): the pending one is the
      // one Stop feedback belongs on, and a preparation row must not hide a
      // reply row that names the member.
      const runRows = conversation.messages.filter((message) => message.role === "participant" && message.metadata?.runId === targetRunId);
      const pending = runRows.find((message) => message.status === "pending");
      const runRow = pending ?? runRows.find((message) => !message.metadata?.cloudRunPreparation) ?? runRows[0];
      const knownHere = runRows.length > 0 || activeRunIds.includes(targetRunId) || chatRunId(conversation) === targetRunId;
      const participant = runRow && chatParticipants(conversation).find((member) => member.id === runRow.participantId);
      // A row that names a member settles where the run lives: a local member's
      // run stays local even when the chat also has a machine member. The
      // single-machine fallback is only for a run this copy cannot attribute at
      // all -- no row replicated yet, or a member since removed.
      const homeMachineId = participant ? participant.homeMachineId : this.chat.host.soleMachineMemberHome(conversation);
      // A run of a member on another device: its Stop is asked on the User's
      // server, which the member's own device obeys (Д2, Д4).
      if (knownHere && !runRow?.metadata?.cloudRunPreparation && this.chat.serverLink.current &&
          (participant ? !this.chat.host.runsHere(participant) : Boolean(homeMachineId && homeMachineId !== this.chat.host.hostMachineId)) &&
          await this.requestServerStop(conversation, targetRunId, runRow, options.sendNow === true, options.waitingRunId)) {
        return true;
      }
      // A copied pending row is not evidence that this process owns its
      // provider. Never sweep another host's run into a false stopped state.
      if (participant && !this.chat.host.ownsParticipant(participant) && !pending?.metadata?.cloudRunPreparation
        && !(participant.cloudRun && !participant.homeMachineId)) return false;
      if (!activeRunIds.includes(targetRunId) && chatRunId(conversation) !== targetRunId) {
        continue;
      }
      const ownerState = this.chat.runOwners.localRunOwnerState(conversation.metadata, targetRunId);
      if (ownerState === "external-live") {
        // Another live app instance owns this run (instances can share this
        // userData, e.g. a second dev/QA instance). Sweeping its stored state
        // here would strand the owner's CLI process, so record a cancel
        // request that the owning instance consumes on its run-owner
        // heartbeat.
        await this.deps.storage.requestRunCancel(conversation.id, targetRunId);
        void this.deps.debugLogs.write("chat.cancel.cross-instance-requested", {
          conversationId: conversation.id,
          runId: targetRunId
        });
        return true;
      }
      void this.deps.debugLogs.write("chat.cancel.stored-run-swept", {
        conversationId: conversation.id,
        runId: targetRunId,
        ownerState
      });
      await this.cancelStoredOrphanedRun(conversation, targetRunId);
      return true;
    }
    return false;
  }

  /**
   * Asks the User's server to stop a turn that another device runs, and
   * shows the Stop as waiting on its bubble until that device confirms (the
   * approved parity exception: a machine that cannot be reached shows
   * waiting, never "stopped"). False when this device cannot name the turn.
   */
  private async requestServerStop(
    conversation: Conversation, runId: string, row: ChatMessage | undefined, sendNow = false, waitingRunId?: string
  ): Promise<boolean> {
    const link = this.chat.serverLink.current;
    if (!link) return false;
    const turn = this.chat.serverTurns.knownServerTurn(conversation, runId, row);
    if (!turn) return false;
    // The message Send now was pressed on, by its turn on the server.
    const waitingRow = waitingRunId ? conversation.messages.find((message) => message.role === "participant" && message.metadata?.runId === waitingRunId) : undefined;
    const waitingTurn = waitingRunId ? this.chat.serverTurns.knownServerTurn(conversation, waitingRunId, waitingRow) : undefined;
    await link.enqueue([{
      opId: newOpId(), kind: "turn.stop", conversationId: conversation.id, runId: turn.runId, messageId: turn.messageId, participantId: turn.participantId,
      ...(sendNow ? { sendNow: true, ...(waitingTurn ? { waitingRunId: waitingTurn.runId } : {}) } : {})
    }]);
    void this.deps.debugLogs.write("chat.cancel.server-stop", { conversationId: conversation.id, runId: turn.runId, participantId: turn.participantId, sendNow });
    // A Send now stops nothing: its bubble does not wait for a stop.
    if (sendNow) return true;
    const member = chatParticipants(conversation).find((item) => item.id === turn.participantId);
    const machineName = member?.homeMachineId ? link.machineName(member.homeMachineId) ?? "the machine" : "this computer";
    const mark = async (stopPending: { machineName: string; at: string } | undefined): Promise<void> => {
      await this.chat.store.withChatMutation(conversation, async () => {
        let changed = false;
        for (const message of conversation.messages) {
          if (message.role !== "participant" || message.metadata?.runId !== turn.runId) continue;
          if (stopPending && message.status === "pending") {
            message.metadata = { ...message.metadata, stopPending };
            changed = true;
          } else if (!stopPending && message.metadata?.stopPending) {
            const { stopPending: _waiting, ...rest } = message.metadata;
            message.metadata = rest;
            changed = true;
          }
        }
        if (changed) this.chat.store.queueSnapshot(conversation);
      });
    };
    await mark({ machineName, at: new Date().toISOString() });
    void this.chat.serverTurns.waitForServerTurn(turn.runId, (item) => item.state === "finished" || item.state === "stopped")
      .then(() => mark(undefined))
      .catch(() => undefined);
    return true;
  }

  private async cancelStoredOrphanedRun(conversation: Conversation, runId: string): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      this.chat.activeRuns.forgetAllActiveChatRunRefs(conversation.id, runId);
      const activeBefore = readActiveRunIds(conversation.metadata);
      conversation.metadata = this.chat.activeRuns.metadataWithLiveRunState(conversation.id, conversation.metadata, runId);
      const activeAfter = new Set(readActiveRunIds(conversation.metadata));
      const removedRunIds = activeBefore.filter((activeRunId) => !activeAfter.has(activeRunId));
      for (const removedRunId of removedRunIds) {
        markStoredParticipantRunStoppedByUser(conversation, removedRunId);
        this.chat.approvalDecisions.markPendingAppToolApprovalsForRunTerminal(conversation, removedRunId, "Stopped by user.");
        conversation.metadata = withParticipantCompactionsForRunRemoved(conversation.metadata, removedRunId);
        conversation.metadata = this.chat.titles.metadataAfterAutoTitleRunTerminal(conversation.id, conversation.metadata, removedRunId);
      }
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
    });
    if (!this.chat.activeRuns.chatHasLiveWork(conversation.id)) {
      this.chat.autoWatch.scheduleAutoWatchEvaluation(conversation.id, "stored-orphaned-run-cancelled");
    }
  }
}
