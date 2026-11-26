import { cloudRunSelection } from "../../../../shared/cloudRunPreparation";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { userDataPath } from "../../../platform";
import { newOpId } from "../../chatServerOps";
import type { HubTurn } from "../../../../shared/hubOps";
import { HubHttpError } from "../../hubClient";
import {
  findClaudeTranscript, packMemberSession, placeClaudeTranscript, portableMemberSession, readClaudeTranscript, unpackMemberSession
} from "../../memberSessionFiles";
import {
  MEMBER_SESSION_EXPORT_HOLD_MS, MEMBER_SESSION_EXPORT_TURN_KIND, MEMBER_SESSION_EXPORT_TURN_TTL_MS, cloudMachineName,
  memberMovedLine, memberSessionMoves, USER_COMPUTER_NAME, type ChatSessionHandoff, type MemberSessionExportReport,
  type MemberSessionExportTurnRequest
} from "../../../../shared/memberSessionMove";
import type { ChatParticipant, ChatParticipantSession, Conversation, UpdateChatParticipantRuntimeRequest } from "../../../../shared/types";
import { CliAgentRunner } from "../../cliAgents";
import { compactionAnchor } from "../compaction/compactionText";
import { chatParticipants, chatSessions } from "./identity";
import { createChatMessage, placeName } from "../store/messages";
import { normalizedPromptContextPointers } from "../turns/promptContextRecords";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Moves a member between the computer and machines with its session. */
export class MemberMoves {
  /** Members moving (on the computer) or whose session this machine just
   *  handed over: their turns wait for it (memberMoveGate). */
  readonly memberMoveGates = new Map<string, { done: Promise<void>; release: () => void }>();
  /** Handoffs being taken here, and those taken, so one is taken once. */
  private readonly sessionHandoffsTaking = new Map<string, Promise<void>>();
  private readonly sessionHandoffsTaken = new Set<string>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "backgroundTasks" | "bodyTransport" | "host" | "machineSupport" | "memberRestart" | "memberSessions"
      | "members" | "remoteTurns" | "serverLink" | "serverTurns" | "store" | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs">
  ) {}

  /** While a member moves (or a machine has just handed its session over), its
   *  turns wait: a turn routed by the old home would run on the old session. */
  memberMoveGate(conversationId: string, participantId: string): Promise<void> | undefined {
    return this.memberMoveGates.get(`${conversationId}:${participantId}`)?.done;
  }

  private openMemberMoveGate(conversationId: string, participantId: string): () => void {
    const key = `${conversationId}:${participantId}`;
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const gate = { done, release: () => {
      if (this.memberMoveGates.get(key) === gate) this.memberMoveGates.delete(key);
      release();
    } };
    this.memberMoveGates.set(key, gate);
    return gate.release;
  }

  /** The member as the saved chat has it now, when where it runs changed
   *  since `participant` was read (it moved): the chat is read again. */
  async memberWhereItRunsNow(conversation: Conversation, participant: ChatParticipant): Promise<ChatParticipant> {
    const stored = (await this.chat.store.readStoredChatStateForRefresh(conversation.id)).stored;
    const saved = stored && stored.kind === "chat" ? chatParticipants(stored).find((item) => item.id === participant.id) : undefined;
    if (!saved || ((saved.homeMachineId ?? "") === (participant.homeMachineId ?? "") && JSON.stringify(saved.cloudRun) === JSON.stringify(participant.cloudRun))) {
      return participant;
    }
    await this.chat.store.refreshStoredChatState(conversation);
    return chatParticipants(conversation).find((item) => item.id === participant.id) ?? saved;
  }

  /**
   * Desktop: a Claude Code member that already ran moves to another device
   * with its session, through the User's server. Leaving this computer, its
   * transcript is put on the server here; leaving a machine, the machine is
   * asked for it by a turn of the member (a stopped one is started for it).
   * The member's `sessionHandoff` names it, and the device it arrives on
   * takes it before its next turn (takeSessionHandoff); arriving here, that
   * happens at once. Refused while the member answers or has background
   * tasks; one move of a member at a time, and its turns wait for it.
   */
  async moveParticipant(request: UpdateChatParticipantRuntimeRequest, conversation: Conversation, member: ChatParticipant): Promise<Conversation | undefined> {
    const label = `@${member.handle}`;
    if (this.memberMoveGate(conversation.id, member.id)) throw new Error(`${label} is already moving.`);
    if (conversation.metadata.archived === true) throw new Error("This chat is archived. Unarchive it to move its members.");
    const nextHomeMachineId = Object.prototype.hasOwnProperty.call(request, "homeMachineId")
      ? (typeof request.homeMachineId === "string" && request.homeMachineId.trim() ? request.homeMachineId.trim() : undefined)
      : member.homeMachineId;
    const nextCloudRun = Object.prototype.hasOwnProperty.call(request, "cloudRun") ? cloudRunSelection(request.cloudRun) : member.cloudRun;
    const toHere = !nextHomeMachineId && !nextCloudRun;
    const destination = toHere ? undefined : this.chat.machineSupport.machineSessionMove?.(nextHomeMachineId ? { machineId: nextHomeMachineId } : { instanceId: nextCloudRun?.instanceId })
      ?? { support: "unknown" as const };
    const destinationName = toHere ? "this computer" : destination?.name ?? "its cloud machine";
    if (!toHere && destination?.machineId && destination.support !== "supported") {
      // A machine not set up yet runs this version; one that is set up says
      // in its hello whether it takes a member's session.
      throw new Error(destination.support === "outdated"
        ? `Could not move ${label}: ${destinationName} still runs an older version of AccordAgents that cannot take a member's session. This computer updates it the next time it is connected and idle; move it again after that.`
        : `Could not move ${label}: ${destinationName} has not connected to this computer yet. Move it again once it is connected.`);
    }
    const refuseBusy = (chat: Conversation): void => {
      if (this.chat.members.memberAnswersNow(chat, member.id) || this.chat.memberRestart.memberRestartsInFlight.has(`${chat.id}:${member.id}`)) {
        throw new Error(`${label} is busy. Move it when it is done.`);
      }
      if ((this.chat.backgroundTasks.memberBackgroundTasks.get(chat.id)?.get(member.id)?.tasks.length ?? 0) > 0) {
        throw new Error(`${label} has background tasks running. Move it when they are done.`);
      }
    };
    refuseBusy(conversation);
    const releaseGate = this.openMemberMoveGate(conversation.id, member.id);
    const reservation = this.chat.turnQueue.reserveParticipantTurn(conversation.id, member.id, "exclusive");
    let moved: Conversation | undefined;
    // A machine that handed the session over holds the member's turns for
    // the move; a move that then fails tells it to let them go.
    let exportedFrom: { runId: string; machineId: string } | undefined;
    let applied = false;
    try {
      await reservation.wait();
      // As it is now: a turn, a compaction or a restart that began just
      // before may have changed it, or still be under way.
      const latest = await this.chat.store.requireChat(conversation.id);
      const current = chatParticipants(latest).find((item) => item.id === member.id);
      if (!current) throw new Error(`${label} was removed from this chat.`);
      refuseBusy(latest);
      const fromHere = this.chat.host.runsHere(current);
      const sourceMachineId = current.homeMachineId;
      if ((fromHere && toHere) || (sourceMachineId && destination?.machineId === sourceMachineId) ||
        (!sourceMachineId && !fromHere && !toHere && JSON.stringify(nextCloudRun) === JSON.stringify(current.cloudRun))) {
        // Where it already runs: nothing moves.
        return conversation;
      }
      const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "memberProcessAnswering" | "closeWarmAgents">>;
      let handoff: ChatSessionHandoff | undefined;
      let sessionNote: string | undefined;
      let dropLocalSession = false;
      if (!toHere && destination?.machineId && conversation.repoPath) {
        // The project is on the machine before the member is: a turn of it
        // there (the phone's too) finds its folder.
        await this.chat.remoteTurns.prepareParticipantProjects(conversation.repoPath, [{ homeMachineId: destination.machineId }]).catch((error: unknown) => {
          throw new Error(`Could not move ${label}: the project could not be copied to ${destinationName} (${error instanceof Error ? error.message : String(error)}).`);
        });
      }
      if (fromHere) {
        if (runner.memberProcessAnswering?.call(this.deps.cliRunner, conversation.id, member.id)) throw new Error(`${label} is busy. Move it when it is done.`);
        const session = chatSessions(latest).find((item) => item.participantId === member.id);
        dropLocalSession = Boolean(session);
        if (current.sessionHandoff && session?.importedHandoff !== current.sessionHandoff.blob.blobHash) {
          // Handed here and not taken yet: that session goes on, as it is.
          handoff = current.sessionHandoff;
        } else if (session?.sessionId) {
          await runner.closeWarmAgents?.call(this.deps.cliRunner, conversation.id, member.id, "member-moved");
          handoff = await this.packLocalSession(latest, session, label);
          if (!handoff) sessionNote = "Its session was not found on this computer, so it starts a new one there.";
        }
      } else if (sourceMachineId) {
        const exported = await this.exportSessionFromMachine(latest, current);
        handoff = exported.handoff;
        sessionNote = exported.note;
        exportedFrom = exported.runId ? { runId: exported.runId, machineId: sourceMachineId } : undefined;
      } else {
        // A Cloud choice not prepared yet: what it was handed still waits.
        handoff = current.sessionHandoff;
      }
      if (handoff) {
        // What the member is told on its first turn there: where it was, and
        // where it is now. A session passed on without having run here keeps
        // where it last ran.
        const passedOn = Boolean(current.sessionHandoff && handoff.blob.blobHash === current.sessionHandoff.blob.blobHash);
        const fromName = passedOn ? current.sessionHandoff?.fromName
          : fromHere ? USER_COMPUTER_NAME : sourceMachineId ? cloudMachineName(this.chat.serverLink.current?.machineName(sourceMachineId)) : handoff.fromName;
        handoff = { ...handoff, ...(fromName ? { fromName } : {}), toName: toHere ? USER_COMPUTER_NAME : cloudMachineName(destination?.name) };
      }
      const line = [memberMovedLine(member.handle, destinationName, Boolean(handoff)), sessionNote].filter(Boolean).join(" ");
      // A known machine that takes sessions is its home at once, so its turns
      // (the phone's too) go there without waiting for a Cloud preparation.
      const appliedRequest: UpdateChatParticipantRuntimeRequest = !toHere && !nextHomeMachineId && destination?.machineId && destination.support === "supported"
        ? { ...request, homeMachineId: destination.machineId }
        : request;
      await this.chat.members.updateParticipantRuntime(appliedRequest, { handoff, dropLocalSession, line });
      applied = true;
      void this.deps.debugLogs.write("chat.member-move.done", {
        conversationId: conversation.id, participantId: member.id, from: fromHere ? "here" : sourceMachineId ?? "cloud-pending",
        to: toHere ? "here" : appliedRequest.homeMachineId ?? nextCloudRun?.instanceId ?? "cloud-pending", withSession: Boolean(handoff), bytes: handoff?.blob.byteLength
      });
      moved = await this.chat.store.requireChat(conversation.id);
      const arrived = chatParticipants(moved).find((item) => item.id === member.id);
      if (toHere && arrived?.sessionHandoff) {
        // Arriving here: taken now, before any turn of it starts, so the
        // server lets go of it; a failure for now is tried again before its
        // next turn, which then says why.
        await this.takeSessionHandoff(moved, arrived).catch((error) => {
          void this.deps.debugLogs.write("chat.member-move.take-deferred", { conversationId: conversation.id, participantId: member.id, message: error instanceof Error ? error.message : String(error) });
        });
        moved = await this.chat.store.requireChat(conversation.id);
      }
    } catch (error) {
      if (exportedFrom && !applied) {
        // The member stays on its machine: its turns there go on now.
        await this.chat.store.withChatMutation(conversation, async () => {
          conversation.messages.push(createChatMessage("system", `@${member.handle} stays where it was.`, undefined,
            { hiddenFromTimeline: true, memberMoveCancelled: { participantId: member.id, runId: exportedFrom!.runId } }));
          conversation.updatedAt = new Date().toISOString();
          await this.chat.store.saveConversation(conversation);
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      reservation.release();
      releaseGate();
    }
    // Turns asked of the member while it moved wait on the server for its
    // new device; this one takes those now its own.
    void this.chat.serverTurns.resumeServerTurns().catch(() => undefined);
    return moved;
  }

  /** This computer's session of a member, packed and put on the User's
   *  server; undefined when its transcript is not here (the CLI removes old
   *  sessions). */
  private async packLocalSession(conversation: Conversation, session: ChatParticipantSession, label: string): Promise<ChatSessionHandoff | undefined> {
    const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "claudeProjectsDirectory">>;
    if (!runner.claudeProjectsDirectory) throw new Error(`Could not move ${label}: this device cannot read Claude Code's sessions.`);
    const file = await findClaudeTranscript(await runner.claudeProjectsDirectory.call(this.deps.cliRunner), session.sessionId);
    if (!file) return undefined;
    if (!this.chat.bodyTransport.hubBlobWriter) throw new Error(`Could not move ${label}: this device is not linked to your server, which carries the session.`);
    // How far the chat reached the session goes with it: the next turn there
    // sends only what is new to it, as a resumed CLI session expects.
    const pointers = normalizedPromptContextPointers(conversation.metadata.promptContextPointers)[session.participantId];
    const packed = await packMemberSession(portableMemberSession(session), await readClaudeTranscript(file), pointers ? { promptContextPointers: pointers } : {});
    const blob = await this.chat.bodyTransport.hubBlobWriter(packed).catch((error: unknown) => {
      throw new Error(`Could not move ${label}: its session did not reach your server (${error instanceof Error ? error.message : String(error)}).`);
    });
    return { provider: "claude-code", sessionId: session.sessionId, blob, at: new Date().toISOString() };
  }

  /**
   * Desktop: asks a member's machine for its session, as a turn of the member
   * on the User's server (request kind "session.export"), so a stopped
   * machine is started for it like for any turn. The machine answers on a
   * hidden line naming where it put the session, and keeps the member's turns
   * waiting until the move is made; nothing else changes there.
   */
  private async exportSessionFromMachine(conversation: Conversation, member: ChatParticipant): Promise<{ handoff?: ChatSessionHandoff; note?: string; runId?: string }> {
    const label = `@${member.handle}`;
    const machineId = member.homeMachineId!;
    const link = this.chat.serverLink.current;
    if (!link) throw new Error(`Could not move ${label}: it runs on a cloud machine, which this device reaches only through your server; it is not linked to it yet.`);
    const machineName = link.machineName(machineId) ?? "its cloud machine";
    const support = this.chat.machineSupport.machineSessionMove?.({ machineId })?.support ?? "unknown";
    if (support === "outdated") {
      throw new Error(`Could not move ${label}: ${machineName} still runs an older version of AccordAgents that cannot hand over a member's session. This computer updates it the next time it is connected and idle; move it again after that.`);
    }
    if (support === "unknown") {
      throw new Error(`Could not move ${label}: ${machineName} has not connected to this computer yet. Move it again once it is connected.`);
    }
    const anchor = compactionAnchor(conversation, {});
    if (!anchor) throw new Error(`Could not move ${label}: this chat has nothing on your server yet to ask ${machineName} by. Try again in a moment.`);
    const serverRunId = `turn-${randomUUID()}`;
    const turnRequest: MemberSessionExportTurnRequest = { kind: MEMBER_SESSION_EXPORT_TURN_KIND, askedAt: new Date().toISOString() };
    const placed = (item: HubTurn) => item.state !== "requested";
    const ended = (item: HubTurn) => item.state === "finished" || item.state === "stopped";
    const signal = AbortSignal.timeout(MEMBER_SESSION_EXPORT_TURN_TTL_MS);
    const opId = newOpId();
    let turn: HubTurn | undefined;
    try {
      await link.enqueue([{
        opId, kind: "turn.request", conversationId: conversation.id, runId: serverRunId, messageId: anchor.id, participantId: member.id,
        request: { ...turnRequest }
      }]);
      const asked = await link.opAnswered(opId, signal);
      if (asked.status === "rejected") throw new Error(`Could not move ${label} from ${machineName}: ${asked.reason}`);
      turn = asked.turn;
      if (!turn || !placed(turn)) turn = await this.chat.serverTurns.waitForServerTurn(serverRunId, placed, signal);
      if (!ended(turn)) turn = await this.chat.serverTurns.waitForServerTurn(serverRunId, ended, signal);
    } catch (error) {
      if (signal.aborted) {
        // Never taken: taken back. Taken: the Stop ends it there, and the
        // machine lets the member's turns go.
        const withdrawn = await link.withdraw?.(opId).catch(() => undefined);
        if (withdrawn?.status !== "withdrawn") {
          await link.enqueue([{ opId: newOpId(), kind: "turn.stop", conversationId: conversation.id, runId: serverRunId, messageId: anchor.id, participantId: member.id }]).catch(() => undefined);
        }
        throw new Error(`Could not move ${label}: ${machineName} did not hand over its session in time. It stays on ${machineName}.`);
      }
      throw error;
    }
    void this.deps.debugLogs.write("chat.member-move.export-finished", { conversationId: conversation.id, participantId: member.id, machineName, state: turn.state, outcome: turn.outcome });
    // The machine's hidden line reached this device through the server
    // before the turn's end did; only the machine that took the turn speaks.
    const refreshed = await this.chat.store.requireChat(conversation.id);
    const line = refreshed.messages.filter((message) => message.role === "system" && message.metadata?.memberSessionExport?.runId === serverRunId
      && message.metadata.memberSessionExport.participantId === member.id
      && Boolean(turn?.executorDeviceId) && message.metadata.serverWriter === turn?.executorDeviceId).at(-1);
    const report = line?.metadata?.memberSessionExport;
    const stays = `It stays on ${machineName}.`;
    if (turn.state !== "finished" || !report) {
      throw new Error(`Could not move ${label}: ${machineName} did not hand over its session (it stopped before it was done). ${stays}`);
    }
    // What the machine says is never the chat's words: only which case it is.
    switch (report.reason) {
      case "busy": throw new Error(`${label} is busy on ${machineName}. Move it when it is done.`);
      case "background": throw new Error(`${label} has background tasks running on ${machineName}. Move it when they are done.`);
      case "not-found": return { note: `Its session was not found on ${machineName}, so it starts a new one.`, runId: serverRunId };
      case "none": return { runId: serverRunId };
      case undefined: break;
      default: throw new Error(`Could not move ${label}: ${machineName} could not hand over its session. ${stays}`);
    }
    if (turn.outcome !== "done" || !report.blob || !report.sessionId) {
      throw new Error(`Could not move ${label}: ${machineName} could not hand over its session. ${stays}`);
    }
    return { handoff: { provider: "claude-code", sessionId: report.sessionId, blob: report.blob, at: new Date().toISOString() }, runId: serverRunId };
  }

  /** Machine side: the turn that asks this machine for a member's session.
   *  Taken on the server first, like any turn; answered on a hidden line.
   *  From the moment it is taken the member's other turns wait, until its
   *  home changes (the move was made) or the hold ends. A Stop ends it. */
  async runServerSessionExportTurn(turn: HubTurn, chat: Conversation, participant: ChatParticipant, controller: AbortController): Promise<void> {
    if (!this.chat.host.machineRuntime) return;
    if (await this.chat.serverTurns.claimServerTurnHere(turn, controller.signal) !== "claimed") return;
    const releaseGate = this.openMemberMoveGate(chat.id, participant.id);
    this.chat.activeRuns.registerRunController(turn.runId, controller);
    let outcome: "done" | "error" | "stopped" = "error";
    let handedOver = false;
    try {
      const request = (turn.request ?? {}) as Partial<MemberSessionExportTurnRequest>;
      const askedAt = typeof request.askedAt === "string" ? Date.parse(request.askedAt) : Number.NaN;
      if (!Number.isFinite(askedAt) || Date.now() - askedAt > MEMBER_SESSION_EXPORT_TURN_TTL_MS) {
        throw new Error("the move was asked too long ago");
      }
      let report: MemberSessionExportReport;
      try {
        report = { runId: turn.runId, participantId: participant.id, ...await this.exportSessionHere(chat, participant, controller.signal) };
      } catch (error) {
        void this.deps.debugLogs.write("chat.member-move.export-failed", { conversationId: chat.id, participantId: participant.id, runId: turn.runId, message: error instanceof Error ? error.message : String(error) });
        report = { runId: turn.runId, participantId: participant.id, reason: "failed" };
      }
      if (controller.signal.aborted) {
        outcome = "stopped";
        return;
      }
      await this.chat.store.withChatMutation(chat, async () => {
        chat.messages.push(createChatMessage("system", `Handed @${participant.handle}'s session over for its move.`, undefined,
          { hiddenFromTimeline: true, memberSessionExport: report }));
        chat.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(chat);
      });
      handedOver = !report.reason || report.reason === "none" || report.reason === "not-found";
      outcome = report.reason && !handedOver ? "error" : "done";
    } catch (error) {
      void this.deps.debugLogs.write("chat.member-move.export-failed", { conversationId: chat.id, participantId: participant.id, runId: turn.runId, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.chat.activeRuns.unregisterRunController(turn.runId, controller);
      this.chat.serverTurns.finishServerTurn(turn.runId, outcome);
      if (handedOver) {
        // Held until the computer makes the move (its home leaves here), or
        // for long enough that it plainly will not.
        setTimeout(() => {
          releaseGate();
          void this.chat.serverTurns.resumeServerTurns().catch(() => undefined);
        }, MEMBER_SESSION_EXPORT_HOLD_MS).unref?.();
      } else {
        releaseGate();
        void this.chat.serverTurns.resumeServerTurns().catch(() => undefined);
      }
    }
  }

  /** A member's session on this device, put on the User's server for its
   *  move; refused while it answers or has background tasks. One handed here
   *  and not taken yet is passed on as it is. */
  private async exportSessionHere(chat: Conversation, participant: ChatParticipant, signal: AbortSignal): Promise<Omit<MemberSessionExportReport, "runId" | "participantId">> {
    if (this.chat.members.memberAnswersNow(chat, participant.id)) return { reason: "busy" };
    if ((this.chat.backgroundTasks.memberBackgroundTasks.get(chat.id)?.get(participant.id)?.tasks.length ?? 0) > 0) return { reason: "background" };
    const reservation = this.chat.turnQueue.reserveParticipantTurn(chat.id, participant.id, "exclusive");
    try {
      await reservation.wait();
      if (signal.aborted) return { reason: "failed" };
      const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "memberProcessAnswering" | "closeWarmAgents">>;
      if (runner.memberProcessAnswering?.call(this.deps.cliRunner, chat.id, participant.id)) return { reason: "busy" };
      const latest = await this.chat.store.requireChat(chat.id);
      const current = chatParticipants(latest).find((item) => item.id === participant.id) ?? participant;
      const session = chatSessions(latest).find((item) => item.participantId === participant.id);
      const handoff = current.sessionHandoff;
      if (handoff && session?.importedHandoff !== handoff.blob.blobHash) {
        return { sessionId: handoff.sessionId, blob: handoff.blob };
      }
      if (!session?.sessionId) return { reason: "none" };
      await runner.closeWarmAgents?.call(this.deps.cliRunner, chat.id, participant.id, "member-moved");
      const packed = await this.packLocalSession(latest, session, `@${participant.handle}`);
      if (!packed) return { reason: "not-found" };
      return { sessionId: packed.sessionId, blob: packed.blob };
    } finally {
      reservation.release();
    }
  }

  /** Machine: members that ran here and run elsewhere now (moved): their
   *  turns wait no more here, their process closes, and the session this
   *  device kept of them goes (a later move back hands them their session
   *  again). */
  async retireMovedMembers(conversation: Conversation, before: ReadonlySet<string>): Promise<void> {
    const left = chatParticipants(conversation).filter((member) => before.has(member.id) && !this.chat.host.runsHere(member));
    if (left.length === 0) return;
    const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "closeWarmAgents">>;
    for (const member of left) {
      this.memberMoveGates.get(`${conversation.id}:${member.id}`)?.release();
      await runner.closeWarmAgents?.call(this.deps.cliRunner, conversation.id, member.id, "member-moved").catch(() => undefined);
    }
    const ids = new Set(left.map((member) => member.id));
    await this.chat.store.withChatMutation(conversation, async () => {
      const sessions = chatSessions(conversation);
      if (!sessions.some((session) => ids.has(session.participantId))) return;
      conversation.metadata.participantSessions = sessions.filter((session) => !ids.has(session.participantId));
      await this.chat.store.saveConversation(conversation);
    });
  }

  /** Whether a member runs here now that did not before. */
  membersArrivedHere(before: ReadonlySet<string>, conversation: Conversation): boolean {
    return chatParticipants(conversation).some((member) => this.chat.host.runsHere(member) && !before.has(member.id));
  }

  /**
   * The device a member runs on takes the session it was handed
   * (`sessionHandoff`) before it first uses one: read from the User's
   * server, its transcript put where Claude Code looks for it here, and kept
   * as this device's session of the member. Once per handoff, whichever turn
   * gets there first; the others wait for it and read the chat again. A
   * handoff that can never be taken (gone from the server, damaged, a folder
   * Claude cannot be given it in) is let go with a line saying the member
   * starts a new session; one that failed for now (the server out of reach)
   * stops the turn, and the next tries again. A machine then says on a
   * hidden line that it took it, so the computer lets the server go of it.
   */
  async takeSessionHandoff(conversation: Conversation, participant: ChatParticipant): Promise<void> {
    const current = chatParticipants(conversation).find((item) => item.id === participant.id) ?? participant;
    const handoff = current.sessionHandoff;
    if (!handoff || !this.chat.host.runsHere(current) || !memberSessionMoves(current)) return;
    const key = `${conversation.id}:${participant.id}:${handoff.blob.blobHash}`;
    if (this.sessionHandoffsTaken.has(key)) {
      if (!chatSessions(conversation).some((session) => session.participantId === participant.id && session.importedHandoff === handoff.blob.blobHash)) {
        await this.chat.store.refreshStoredChatState(conversation);
      }
      return;
    }
    const existing = chatSessions(conversation).find((session) => session.participantId === participant.id);
    if (existing?.importedHandoff === handoff.blob.blobHash) return;
    const running = this.sessionHandoffsTaking.get(key);
    if (running) {
      await running;
      await this.chat.store.refreshStoredChatState(conversation);
      return;
    }
    const taking = this.takeSessionHandoffNow(conversation, current, handoff)
      .then(() => { this.sessionHandoffsTaken.add(key); })
      .finally(() => this.sessionHandoffsTaking.delete(key));
    this.sessionHandoffsTaking.set(key, taking);
    return taking;
  }

  private async takeSessionHandoffNow(conversation: Conversation, participant: ChatParticipant, handoff: ChatSessionHandoff): Promise<void> {
    const label = `@${participant.handle}`;
    // A copy of the chat read before another turn took it here.
    await this.chat.store.refreshStoredChatState(conversation);
    if (chatSessions(conversation).some((session) => session.participantId === participant.id && session.importedHandoff === handoff.blob.blobHash)) return;
    let taken: ChatParticipantSession | undefined;
    let lostReason: string | undefined;
    let contextPointers: ReturnType<typeof normalizedPromptContextPointers>[string] | undefined;
    try {
      if (!this.chat.bodyTransport.hubBlobReader) throw new Error("this device is not linked to your server");
      const bytes = await this.chat.bodyTransport.hubBlobReader(handoff.blob).catch((error: unknown) => {
        if (error instanceof HubHttpError && (error.status === 404 || error.status === 410)) {
          lostReason = "it is no longer on your server";
        } else if (error instanceof Error && /does not match its name/.test(error.message)) {
          lostReason = "your server's copy of it is damaged";
        }
        throw error;
      });
      let unpacked: Awaited<ReturnType<typeof unpackMemberSession>>;
      try {
        unpacked = await unpackMemberSession(bytes);
        if (unpacked.session.sessionId !== handoff.sessionId) throw new Error("the moved session names another session");
        const moved = normalizedPromptContextPointers({ [participant.id]: unpacked.promptContextPointers })[participant.id];
        if (moved && Object.keys(moved).length > 0) contextPointers = moved;
      } catch (error) {
        lostReason = error instanceof Error ? error.message : String(error);
        throw error;
      }
      const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "closeWarmAgents" | "claudeProjectsDirectory">>;
      if (!runner.claudeProjectsDirectory) {
        lostReason = "this device cannot write Claude Code's sessions";
        throw new Error(lostReason);
      }
      const projectsDir = await runner.claudeProjectsDirectory.call(this.deps.cliRunner);
      // Where its CLI runs here: the project, or the chat's own folder when
      // it may not read the project; both name it (the chat's folder is
      // named, not written: a turn writes its history there).
      const folders = [conversation.repoPath, path.join(userDataPath(), "chats", conversation.id)].filter((item): item is string => Boolean(item));
      await placeClaudeTranscript(projectsDir, folders, handoff.sessionId, unpacked.transcript).catch((error: unknown) => {
        if (error instanceof Error && /path too long|no folder/.test(error.message)) lostReason = error.message;
        throw error;
      });
      // A process an older session of it left here would answer from that one.
      await runner.closeWarmAgents?.call(this.deps.cliRunner, conversation.id, participant.id, "member-moved").catch(() => undefined);
      // This device's own record of the member (its mode, permissions,
      // provider, model), with only what belongs to the session from the
      // one it left: which session, how far the chat reached it, and the
      // role it was given, so a changed role is sent again.
      const local = await this.chat.memberSessions.newSessionForParticipant(participant);
      const moved = unpacked.session;
      taken = {
        ...local,
        sessionId: handoff.sessionId,
        ...(typeof moved.lastSyncedMessageId === "string" ? { lastSyncedMessageId: moved.lastSyncedMessageId } : {}),
        ...(typeof moved.roleConfigId === "string" && moved.roleConfigId === local.roleConfigId && typeof moved.roleConfigVersion === "number"
          ? { roleConfigVersion: moved.roleConfigVersion } : {}),
        ...(typeof moved.roleInstructions === "string" ? { roleInstructions: moved.roleInstructions } : {}),
        ...(typeof moved.roleLabel === "string" ? { roleLabel: moved.roleLabel } : {}),
        ...(Array.isArray(moved.participantBehaviorRules) ? { participantBehaviorRules: moved.participantBehaviorRules } : {}),
        importedHandoff: handoff.blob.blobHash,
        movedHere: {
          from: placeName(handoff.fromName) ?? "another computer",
          to: placeName(handoff.toName) ?? (this.chat.host.machineRuntime ? cloudMachineName(undefined) : USER_COMPUTER_NAME),
          at: new Date().toISOString()
        },
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      void this.deps.debugLogs.write("chat.member-move.take-failed", {
        conversationId: conversation.id, participantId: participant.id, permanent: Boolean(lostReason), message: error instanceof Error ? error.message : String(error)
      });
      if (!lostReason) {
        throw new Error(`Could not take over ${label}'s session here: ${error instanceof Error ? error.message : String(error)}. It is tried again with its next message.`);
      }
    }
    await this.chat.store.withChatMutation(conversation, async () => {
      const member = chatParticipants(conversation).find((item) => item.id === participant.id);
      if (!member || member.sessionHandoff?.blob.blobHash !== handoff.blob.blobHash) return;
      const sessions = chatSessions(conversation).filter((session) => session.participantId !== participant.id);
      if (taken) {
        sessions.push(taken);
      } else {
        // Never to be had: the member starts a new session here, and says so.
        const fresh = await this.chat.memberSessions.newSessionForParticipant(member);
        sessions.push({ ...fresh, importedHandoff: handoff.blob.blobHash });
        conversation.messages.push(createChatMessage("system", `${label}'s session could not be moved here (${lostReason}). It starts a new session.`));
      }
      conversation.metadata.participantSessions = sessions;
      if (taken && contextPointers) {
        const pointers = normalizedPromptContextPointers(conversation.metadata.promptContextPointers);
        conversation.metadata.promptContextPointers = { ...pointers, [participant.id]: contextPointers };
      }
      if (this.chat.host.machineRuntime) {
        // The computer lets the server go of it once it reads this.
        conversation.messages.push(createChatMessage("system", `Took @${member.handle}'s session over.`, undefined,
          { hiddenFromTimeline: true, memberSessionTaken: { participantId: member.id, blobHash: handoff.blob.blobHash, taken: Boolean(taken) } }));
      } else {
        // The computer writes members' homes: taken here, the server lets go.
        conversation.metadata.participants = chatParticipants(conversation).map((item) => {
          if (item.id !== participant.id) return item;
          const { sessionHandoff: _taken, ...rest } = item;
          return rest;
        });
      }
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
    });
    void this.deps.debugLogs.write("chat.member-move.taken", { conversationId: conversation.id, participantId: participant.id, taken: Boolean(taken), bytes: handoff.blob.byteLength });
  }

  /** Desktop: the members whose machine said it took the session they were
   *  handed (on a hidden line written by that machine). */
  takenSessionHandoffs(conversation: Conversation): string[] {
    if (this.chat.host.machineRuntime) return [];
    const waiting = chatParticipants(conversation).filter((member) => member.sessionHandoff && member.homeMachineId);
    if (waiting.length === 0) return [];
    return waiting.filter((member) => {
      const writer = this.chat.machineSupport.machineSessionMove?.({ machineId: member.homeMachineId })?.deviceId;
      return conversation.messages.some((message) => message.role === "system"
        && message.metadata?.memberSessionTaken?.participantId === member.id
        && message.metadata.memberSessionTaken.blobHash === member.sessionHandoff?.blob.blobHash
        && Boolean(writer) && message.metadata.serverWriter === writer);
    }).map((member) => member.id);
  }

  /** Desktop: lets go of those sessions on the User's server. */
  async clearTakenSessionHandoffs(conversation: Conversation): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      const due = new Set(this.takenSessionHandoffs(conversation));
      if (due.size === 0) return;
      conversation.metadata.participants = chatParticipants(conversation).map((item) => {
        if (!due.has(item.id)) return item;
        const { sessionHandoff: _taken, ...rest } = item;
        return rest;
      });
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
    });
  }
}
