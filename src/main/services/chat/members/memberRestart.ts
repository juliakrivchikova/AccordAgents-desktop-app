import { randomUUID } from "node:crypto";
import { newOpId } from "../../chatServerOps";
import type { HubTurn } from "../../../../shared/hubOps";
import type { ChatParticipant, RestartChatParticipantRequest, Conversation, ReviewProgress } from "../../../../shared/types";
import { machineWaitingText } from "../../../../shared/machineWaitingText";
import { CliAgentRunner } from "../../cliAgents";
import { memberProcessRestartable } from "../../../../shared/chatParticipantStatus";
import {
  MEMBER_RESTART_TURN_KIND, MEMBER_RESTART_TURN_TTL_MS, memberRestartLine, type MemberRestartTurnRequest
} from "../../../../shared/memberRestart";
import { compactionAnchor } from "../compaction/compactionText";
import { chatParticipants } from "./identity";
import { createChatMessage } from "../store/messages";
import { emitProgress } from "../turns/replyMessages";
import type { ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Restarts a member's CLI, here or on its machine. */
export class MemberRestart {
  /** Restarts asked here that have not ended, by chat and member: one at a time. */
  readonly memberRestartsInFlight = new Set<string>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "backgroundTasks" | "compaction" | "host" | "machineSupport" | "memberMoves" | "members" | "remoteTurns" | "serverLink"
      | "serverTurns" | "store" | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs">
  ) {}

  /**
   * The User restarts a member's CLI process (the members list): the live
   * process and the background tasks it carries end now, and the member's
   * next turn starts a new process that resumes the same session with what
   * is configured then (MCP servers, keys, Claude in Chrome), as quitting
   * the dedicated CLI and resuming the session does. Only while the member
   * is not answering: the button is off then, and a turn that started
   * meanwhile refuses it where the member runs. Background tasks are stopped
   * only when the User agreed to it. A member on a machine is restarted
   * there, as a turn of that member on the User's server, like its
   * compaction. Gemini starts a new process for every message: it has
   * nothing to restart. One restart of a member at a time.
   */
  async restartParticipant(request: RestartChatParticipantRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<void> {
    const runId = request.runId ?? randomUUID();
    const conversation = await this.chat.store.requireChat(request.conversationId);
    const participant = chatParticipants(conversation).find((item) => item.id === request.participantId);
    if (!participant) throw new Error("Chat member was not found.");
    if (!memberProcessRestartable(participant.kind)) {
      throw new Error(`@${participant.handle} starts a new process for every message; there is nothing to restart.`);
    }
    const inFlightKey = `${conversation.id}:${participant.id}`;
    if (this.memberRestartsInFlight.has(inFlightKey)) throw new Error(`@${participant.handle} is already restarting.`);
    if (this.chat.memberMoves.memberMoveGate(conversation.id, participant.id)) throw new Error(`@${participant.handle} is moving. Restart it once it moved.`);
    this.memberRestartsInFlight.add(inFlightKey);
    try {
      void this.deps.debugLogs.write("chat.restart.requested", {
        conversationId: conversation.id, participantId: participant.id, runId, homeMachineId: participant.homeMachineId
      });
      if (this.chat.compaction.compactsOnMachine(participant)) {
        await this.restartParticipantOnMachine(conversation, participant, runId, request.stopBackgroundTasks === true, signal, progress);
        return;
      }
      this.chat.host.assertOwnsParticipant(participant);
      const label = `@${participant.handle}`;
      const details = { participantLabel: label, memberRestart: { participantId: participant.id } };
      emitProgress(runId, progress, "initial", `Restarting ${label}.`, details);
      try {
        await this.restartParticipantHere(conversation, participant.id, request.stopBackgroundTasks === true);
        emitProgress(runId, progress, "done", `Restarted ${label}.`, details);
      } catch (error) {
        void this.deps.debugLogs.write("chat.restart.failed", { conversationId: conversation.id, participantId: participant.id, runId, message: error instanceof Error ? error.message : String(error) });
        emitProgress(runId, progress, "error", `Could not restart ${label}.`, details);
        throw error;
      }
    } finally {
      this.memberRestartsInFlight.delete(inFlightKey);
    }
  }

  /** Restarts a member that runs on this device: refused while it answers
   *  and, unless the User agreed, while it has background tasks; otherwise
   *  its processes close and the chat says so. Exclusive in the member's turn
   *  queue: a turn that started just before waits to its end (never cut
   *  off), and none starts on the old process meanwhile. `conversation` is
   *  the chat as just read; the line's mutation refreshes it. */
  private async restartParticipantHere(conversation: Conversation, participantId: string, stopBackgroundTasks: boolean): Promise<void> {
    const conversationId = conversation.id;
    const member = chatParticipants(conversation).find((item) => item.id === participantId);
    if (!member) throw new Error("Chat member was not found.");
    const busy = new Error(`@${member.handle} is busy. Restart it when it is done.`);
    if (this.chat.members.memberAnswersNow(conversation, participantId)) throw busy;
    const reservation = this.chat.turnQueue.reserveParticipantTurn(conversationId, participantId, "exclusive", { operation: true });
    try {
      await reservation.wait();
      // A reply its CLI started on its own (a background task finished) is
      // not a run of the chat yet; the process knows it.
      const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "memberProcessAnswering" | "closeWarmAgents">>;
      if (runner.memberProcessAnswering?.call(this.deps.cliRunner, conversationId, participantId)) throw busy;
      const backgroundTasks = this.chat.backgroundTasks.memberBackgroundTasks.get(conversationId)?.get(participantId)?.tasks.length ?? 0;
      if (backgroundTasks > 0 && !stopBackgroundTasks) {
        throw new Error(`@${member.handle} has background tasks running. Restart it again to stop them.`);
      }
      try {
        await runner.closeWarmAgents?.call(this.deps.cliRunner, conversationId, participantId, "user-restart");
      } catch (error) {
        // Its children may still run: the next turn would start a second
        // process beside them, and the chat must not say it restarted.
        throw new Error(`Could not restart @${member.handle}: its process did not close (${error instanceof Error ? error.message : String(error)}).`);
      }
      await this.chat.store.withChatMutation(conversation, async () => {
        // The mutation refreshed the chat: a member removed meanwhile gets no line.
        if (!chatParticipants(conversation).some((item) => item.id === participantId)) return;
        conversation.messages.push(createChatMessage("system", memberRestartLine(member.handle, backgroundTasks)));
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
      });
      void this.deps.debugLogs.write("chat.restart.done", { conversationId, participantId, backgroundTasks });
    } finally {
      reservation.release();
    }
  }

  /**
   * Desktop side of restarting a member that runs on a machine: a turn of
   * that member on the User's server (Д4), request kind "restart", taken and
   * run by its machine with restartParticipantHere, which writes the line
   * this desktop then shows. Only a connected runtime that says it restarts
   * members is asked: an older one would take the turn as an ordinary one,
   * and a stopped machine has no process to restart (asking would only wake
   * it). While the machine has not taken it, the status says so in the words
   * a turn uses; the User can stop waiting (the spinning button).
   */
  private async restartParticipantOnMachine(
    conversation: Conversation,
    participant: ChatParticipant,
    runId: string,
    stopBackgroundTasks: boolean,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<void> {
    const label = `@${participant.handle}`;
    // In the machine's hands from the start: the members list shows its word
    // and lets the User stop waiting, also while the server does not answer.
    const status = (phase: ReviewProgress["phase"], message: string): void => {
      emitProgress(runId, progress, phase, message, { participantLabel: label, memberRestart: { participantId: participant.id, waiting: true } });
    };
    const machineId = participant.homeMachineId;
    if (!machineId) throw new Error(`${label} has not started on its cloud machine yet; there is nothing to restart.`);
    const link = this.chat.serverLink.current;
    if (!link) throw new Error(`${label} runs on a cloud machine, which this device reaches only through your server; it is not linked to it yet.`);
    const machineName = link.machineName(machineId) ?? "the machine";
    const support = this.chat.machineSupport.machineMemberRestartSupport?.(machineId) ?? "unknown";
    if (support === "outdated") {
      throw new Error(`Could not restart ${label}: ${machineName} still runs an older version of AccordAgents that cannot restart members. This computer updates it the next time it is connected and idle; restart again after that.`);
    }
    if (support === "disconnected") {
      throw new Error(`Could not restart ${label}: ${machineName} is not connected. A stopped machine starts its members anew with the current settings; otherwise restart again once it is connected.`);
    }
    if (support === "unknown") {
      throw new Error(`Could not restart ${label}: ${machineName} has not connected to this computer yet. Restart again once it is connected.`);
    }
    if (this.chat.members.memberAnswersNow(conversation, participant.id)) {
      throw new Error(`${label} is busy. Restart it when it is done.`);
    }
    const anchor = compactionAnchor(conversation, {});
    if (!anchor) throw new Error(`${label} has not run in this chat yet; there is nothing to restart.`);
    const serverRunId = `turn-${runId}`;
    const restarting = `Restarting ${label}.`;
    const placed = (item: HubTurn) => item.state !== "requested";
    const ended = (item: HubTurn) => item.state === "finished" || item.state === "stopped";
    const turnRequest: MemberRestartTurnRequest = {
      kind: MEMBER_RESTART_TURN_KIND, askedAt: new Date().toISOString(), ...(stopBackgroundTasks ? { stopBackgroundTasks } : {})
    };
    status("initial", restarting);
    const opId = newOpId();
    let turn: HubTurn | undefined;
    try {
      await link.enqueue([{
        opId, kind: "turn.request", conversationId: conversation.id, runId: serverRunId, messageId: anchor.id, participantId: participant.id,
        request: { ...turnRequest }
      }]);
      const asked = await link.opAnswered(opId, signal);
      if (asked.status === "rejected") throw new Error(`Could not restart ${label} on ${machineName}: ${asked.reason}`);
      turn = asked.turn;
      if (!turn || !placed(turn)) {
        status("initial", `${restarting} ${machineWaitingText(machineName, this.chat.remoteTurns.machineWaitReason?.(machineId))}`);
        turn = await this.chat.serverTurns.waitForServerTurn(serverRunId, placed, signal);
        if (!ended(turn)) status("initial", restarting);
      }
      if (!ended(turn)) turn = await this.chat.serverTurns.waitForServerTurn(serverRunId, ended, signal);
    } catch (error) {
      if (signal?.aborted) {
        // Never sent: taken back. Asked and not taken: nobody ever takes it.
        // Taken: it ends there anyway, and its line says so.
        const withdrawn = await link.withdraw?.(opId).catch(() => undefined);
        if (withdrawn?.status !== "withdrawn") {
          await link.enqueue([{ opId: newOpId(), kind: "turn.stop", conversationId: conversation.id, runId: serverRunId, messageId: anchor.id, participantId: participant.id }]).catch(() => undefined);
        }
      }
      void this.deps.debugLogs.write("chat.restart.failed", { conversationId: conversation.id, participantId: participant.id, runId, machineName, message: error instanceof Error ? error.message : String(error) });
      status(signal?.aborted ? "cancelled" : "error", `Could not restart ${label}.`);
      throw signal?.aborted ? new Error(`Stopped restarting ${label}.`) : error;
    }
    void this.deps.debugLogs.write("chat.restart.machine-finished", {
      conversationId: conversation.id, participantId: participant.id, runId, machineName, state: turn.state, outcome: turn.outcome
    });
    if (turn.state !== "finished" || turn.outcome !== "done") {
      status("error", `Could not restart ${label}.`);
      throw new Error(turn.state === "stopped"
        ? `Could not restart ${label}: the restart was stopped before ${machineName} took it.`
        : `Could not restart ${label} on ${machineName}: it was busy, had background tasks to stop, or the machine stopped before it was done.`);
    }
    status("done", `Restarted ${label}.`);
  }

  /** Machine side: a restart turn the server asked of one of this device's
   *  members. Taken on the server first, like any turn; the line it writes
   *  is what the device that asked for it shows. A restart asked too long
   *  ago is ended unrun. */
  async runServerRestartTurn(turn: HubTurn, chat: Conversation, participant: ChatParticipant, controller: AbortController): Promise<void> {
    if (await this.chat.serverTurns.claimServerTurnHere(turn, controller.signal) !== "claimed") return;
    let outcome: "done" | "error" = "error";
    try {
      const request = (turn.request ?? {}) as Partial<MemberRestartTurnRequest>;
      const askedAt = typeof request.askedAt === "string" ? Date.parse(request.askedAt) : Number.NaN;
      if (!Number.isFinite(askedAt) || Date.now() - askedAt > MEMBER_RESTART_TURN_TTL_MS) {
        throw new Error("the restart was asked too long ago");
      }
      await this.restartParticipantHere(chat, participant.id, request.stopBackgroundTasks === true);
      outcome = "done";
    } catch (error) {
      void this.deps.debugLogs.write("chat.restart.failed", { conversationId: chat.id, participantId: participant.id, runId: turn.runId, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.chat.serverTurns.finishServerTurn(turn.runId, outcome);
    }
  }
}
