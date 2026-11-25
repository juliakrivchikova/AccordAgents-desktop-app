import { newOpId } from "../../chatServerOps";
import type { ChatMessage, Conversation } from "../../../../shared/types";
import { readActiveRunIds, withParticipantCompactionsForRunRemoved } from "../../../../shared/chatRunState";
import { chatParticipants } from "../members/identity";
import { chatRunId, markStoredParticipantRunStoppedByUser } from "./runOwnerRecords";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Stop, wherever the run is. */
export class RunCancel {
  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "approvalDecisions" | "autoWatch" | "host" | "runOwners" | "selfCompactionResumes" | "serverLink"
      | "serverTurns" | "store" | "titles"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "storage">
  ) {}

  cancelRun(runId: string): boolean {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return false;
    }
    const controllers = this.chat.activeRuns.chatRunControllers.get(targetRunId);
    const stopped = this.chat.activeRuns.chatRunMeta.get(targetRunId);
    if (stopped) this.chat.selfCompactionResumes.noteMemberStopped(stopped.conversationId, stopped.participantId);
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

  private async cancelStoredRun(runId: string): Promise<boolean> {
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
          await this.requestServerStop(conversation, targetRunId, runRow)) {
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
  private async requestServerStop(conversation: Conversation, runId: string, row: ChatMessage | undefined): Promise<boolean> {
    const link = this.chat.serverLink.current;
    if (!link) return false;
    const turn = this.chat.serverTurns.knownServerTurn(conversation, runId, row);
    if (!turn) return false;
    await link.enqueue([{ opId: newOpId(), kind: "turn.stop", conversationId: conversation.id, runId: turn.runId, messageId: turn.messageId, participantId: turn.participantId }]);
    void this.deps.debugLogs.write("chat.cancel.server-stop", { conversationId: conversation.id, runId: turn.runId, participantId: turn.participantId });
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
