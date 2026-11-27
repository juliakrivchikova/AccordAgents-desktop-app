import { randomUUID } from "node:crypto";
import path from "node:path";
import { newOpId } from "../../chatServerOps";
import type { HubTurn } from "../../../../shared/hubOps";
import type {
  ChatAgentMode, ChatAgentPermissions, ChatParticipant, ChatParticipantSession, CompactChatParticipantRequest, Conversation,
  StartReviewResult
} from "../../../../shared/types";
import { isMachineCompactionLine } from "../../../../shared/machineLink";
import { machineStopPendingText, machineWaitingText } from "../../../../shared/machineWaitingText";
import { effectiveChatAgentPermissionsForProvider, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import type { CliAgentCompactResult, CliAgentRunOptions } from "../../cliAgents";
import {
  compactionAnchor, compactionFailureLine, compactMessageMetadata, compactRequestParticipant, compactSuccessMessage,
  machineCompactionFailureLine, normalizeCompactInstructions
} from "./compactionText";
import { updateParticipantContextUsage } from "./contextUsage";
import type { SelfCompactionEnd } from "./selfCompactionMarks";
import { CHAT_WARM_AGENT_IDLE_TIMEOUT_MS, INSTRUCTIONS_ACCESS_RESTATE } from "../constants";
import { startFailedOnMissingPath } from "../host/runFolders";
import { chatParticipants, cliParticipantWithHost, participantForRun, upsertSession } from "../members/identity";
import {
  agentModeForSession, appMcpClientGenerationIdFor, cliParticipantForSession, memoryIndexKey, runPathForParticipant,
  warmAgentContextKey
} from "../members/roleRuntime";
import { abortableWait } from "../runs/abortableWait";
import { createChatMessage } from "../store/messages";
import {
  appMcpToolInventoryKeyFor, appMcpToolNamesFor, appToolCapabilitiesForRun, preauthorizedAppMcpToolNamesFor
} from "../turns/promptSections";
import { emitChatRunFailure, emitProgress } from "../turns/replyMessages";
import type { ChatAppMcpTokenGrant, ParticipantTurnReservation, ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Compacts a member's session, here or on its machine. */
export class Compaction {
  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "accord" | "activeRuns" | "agentEnvironment" | "appMcpGrants" | "backgroundTasks" | "chatHistory" | "host" | "memberMoves"
      | "memberSessions" | "promptSuggestions" | "remoteTurns" | "scheduledTasks" | "selfCompaction" | "selfResumedTurns"
      | "serverLink" | "serverTurns" | "store" | "turnPrompt" | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "appMcp" | "cliRunner" | "debugLogs">
  ) {}

  async compactParticipant(
    request: CompactChatParticipantRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback,
    /** How it ended here (a member's own compaction goes on from it). */
    onEnded?: (end: SelfCompactionEnd) => void,
    /** It holds the member's turns: any turn asked after this runs after it. */
    onQueued?: () => void,
    /** The member's turns, held already by the caller (from before its turn
     *  on the server was taken); released here whatever happens. */
    heldTurns?: ParticipantTurnReservation
  ): Promise<StartReviewResult> {
    try {
      return await this.compactParticipantHeld(request, signal, progress, onEnded, onQueued, heldTurns);
    } finally {
      // Released by the compaction once it ran; before that, here.
      heldTurns?.release();
    }
  }

  private async compactParticipantHeld(
    request: CompactChatParticipantRequest,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    onEnded: ((end: SelfCompactionEnd) => void) | undefined,
    onQueued: (() => void) | undefined,
    heldTurns: ParticipantTurnReservation | undefined
  ): Promise<StartReviewResult> {
    const runId = request.runId ?? randomUUID();
    // A member that is moving is compacted once it moved, where it runs then;
    // one whose turns are held already is not moving (its move waits for
    // them), and it is compacted where it runs now.
    const stored = (await this.chat.store.readStoredChatStateForRefresh(request.conversationId)).stored;
    const compacted = stored && stored.kind === "chat" ? compactRequestParticipant(stored, request) : undefined;
    const moving = compacted && !heldTurns ? this.chat.memberMoves.memberMoveGate(request.conversationId, compacted.id) : undefined;
    if (moving) await abortableWait(moving, signal);
    const triggeredBy = request.triggeredBy === "agent" ? "agent" : "user";
    const compactInstructions = normalizeCompactInstructions(request.instructions);
    const warnings: string[] = [];
    const auditBase = {
      conversationId: request.conversationId,
      runId,
      triggeredBy,
      requestedParticipantId: request.participantId,
      requestedHandle: request.handle,
      instructionsProvided: Boolean(compactInstructions)
    };
    await this.deps.debugLogs.write("chat.compaction.requested", auditBase);
    let ingest: {
      conversation: Conversation;
      participant: ChatParticipant;
      /** Undefined for a member on a machine: its session is there. */
      session?: ChatParticipantSession;
      runStarted: boolean;
    };
    try {
      ingest = await this.chat.activeRuns.withChatRunLock(request.conversationId, async () => {
        const conversation = await this.chat.store.requireChat(request.conversationId);
        const participant = compactRequestParticipant(conversation, request);
        if (!participant) {
          throw new Error("Chat member was not found.");
        }
        // A member on a machine is compacted there, through the same command
        // path as its turns; its session is known only there. One whose
        // machine has not been prepared yet has never run, so has none.
        const onMachine = this.compactsOnMachine(participant);
        if (!onMachine) this.chat.host.assertOwnsParticipant(participant);
        const session = onMachine ? undefined : (await this.chat.memberSessions.sessionForParticipant(conversation, participant)).session;
        if (onMachine ? !participant.homeMachineId : !session?.sessionId) {
          await this.chat.store.withChatMutation(conversation, async () => {
            conversation.messages.push(createChatMessage(
              "system",
              `@${participant.handle} does not have an active session to compact yet.`,
              undefined,
              compactMessageMetadata(request, participant, "no-active-session")
            ));
            conversation.updatedAt = new Date().toISOString();
            await this.chat.store.saveConversation(conversation);
          });
          return { conversation, participant, session, runStarted: false };
        }
        await this.chat.activeRuns.beginChatParticipantCompactionRun(conversation, runId, participant.id);
        // The run's mutation refreshed the chat: a member removed since the
        // read above is not compacted.
        if (!chatParticipants(conversation).some((item) => item.id === participant.id)) {
          await this.chat.activeRuns.endChatRun(conversation, runId);
          throw new Error("Chat member was not found.");
        }
        await this.chat.store.waitForQueuedSave(conversation.id);
        return { conversation, participant, session, runStarted: true };
      });
    } catch (error) {
      await this.deps.debugLogs.write("chat.compaction.finished", {
        ...auditBase,
        outcome: signal?.aborted ? "cancelled" : "failed",
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    if (!ingest.runStarted) {
      onEnded?.({ kind: "failed", reason: "no active session" });
      await this.deps.debugLogs.write("chat.compaction.finished", {
        ...auditBase,
        participantId: ingest.participant.id,
        participantHandle: ingest.participant.handle,
        outcome: "no-active-session"
      });
      return { conversation: ingest.conversation, warnings };
    }

    emitProgress(runId, progress, "initial", `Compacting @${ingest.participant.handle}.`, {
      participantLabel: `@${ingest.participant.handle}`
    });
    const reservation = heldTurns ?? this.chat.turnQueue.reserveParticipantTurn(ingest.conversation.id, ingest.participant.id);
    onQueued?.();
    try {
      await reservation.wait();
      const conversation = ingest.conversation;
      const participant = ingest.participant;
      const session = ingest.session;
      // It moved while this waited: what was read is another device's now.
      const placedNow = await this.chat.memberMoves.memberWhereItRunsNow(conversation, participant);
      if ((placedNow.homeMachineId ?? "") !== (participant.homeMachineId ?? "") || JSON.stringify(placedNow.cloudRun) !== JSON.stringify(participant.cloudRun)) {
        throw new Error(`@${participant.handle} moved while its compaction waited. Compact it again.`);
      }
      if (!session) {
        return await this.compactParticipantOnMachine(conversation, participant, request, runId, compactInstructions, warnings, auditBase, signal, progress);
      }
      const workspacePath = await this.chat.chatHistory.ensureHistoryFiles(conversation);
      const agentMode = agentModeForSession(session, participant);
      const permissions = await this.chat.scheduledTasks.withSchedulingWhileOn(normalizeChatAgentPermissions(participantForRun(conversation, participant).permissions));
      session.participantPermissions = permissions;
      // The member's tools as its turns have them (the User's Accord switch too).
      const accordFromAnySession = await this.chat.accord.accordFromAnySession();
      const runPath = runPathForParticipant(conversation, participant, workspacePath, agentMode, permissions);
      const baseCliParticipant = cliParticipantForSession(participant, session);
      const agentEnvGeneration = this.deps.cliRunner.environmentGeneration?.();
      const agentEnvironment = await this.chat.agentEnvironment.agentEnvironmentForParticipant(participant, baseCliParticipant.model);
      const cliParticipant = cliParticipantWithHost(baseCliParticipant, agentEnvironment);
      if (agentEnvironment.problem) {
        await this.chat.agentEnvironment.closeWarmAgentsForParticipant(conversation.id, participant.id);
      }
      const result: CliAgentCompactResult = agentEnvironment.problem
        ? { participant: cliParticipant, ok: false, error: agentEnvironment.problem }
        : await this.deps.cliRunner.compactSession(cliParticipant, runPath, undefined, "chat", signal, {
            ...this.memberProcessOptionsForCompaction(conversation, participant, session, request, runId, runPath, workspacePath, agentMode, permissions, accordFromAnySession),
            agentEnv: agentEnvironment.env,
            settingsEnv: agentEnvironment.settingsEnv,
            agentEnvKey: agentEnvironment.version,
            agentEnvGeneration,
            ...(compactInstructions ? { compactInstructions } : {}),
            onSessionId: (sessionId) => {
              this.chat.memberSessions.persistParticipantSessionId(conversation, session, sessionId);
            }
          });
      await this.chat.store.refreshStoredChatState(conversation);
      const now = new Date().toISOString();
      session.updatedAt = now;
      if (result.sessionId) {
        session.sessionId = result.sessionId;
      }
      let usage = result.contextUsage;
      if (!usage && !agentEnvironment.problem) {
        try {
          usage = await this.deps.cliRunner.contextUsageForSession(cliParticipant, session.sessionId);
        } catch (error) {
          await this.deps.debugLogs.write("chat.compact.context-usage-refresh.error", {
            conversationId: conversation.id,
            participantId: participant.id,
            sessionId: session.sessionId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
      updateParticipantContextUsage(conversation, participant.id, usage);
      // The list of memory notes was in the context that is now summarized:
      // the member's next turn shows it again.
      if (result.ok) this.chat.memberSessions.memoryIndexDue.add(memoryIndexKey(conversation.id, participant.id));
      // The CLI rebuilt the member's instructions from the text its process
      // was launched with, which may hold an older access: said again.
      this.chat.turnPrompt.noteMemberCompactions(conversation.id, participant);
      if (result.ok) {
        this.chat.memberSessions.accessRestateDue.add(memoryIndexKey(conversation.id, participant.id));
        if (session.instructionsAccessHash) session.instructionsAccessHash = INSTRUCTIONS_ACCESS_RESTATE;
      }
      if (result.ok && session.roleRuntime === "prompt-fallback") {
        // Emulated Gemini compaction swaps to a fresh seeded conversation. Force
        // the existing instruction-refresh path to redeliver the prompt-fallback
        // role once on the next participant turn.
        session.runtimeConfigVersion = undefined;
      }
      upsertSession(conversation, session);
      // A start that failed because the project folder is gone says so.
      const missingFolder = !result.ok && !signal?.aborted && !agentEnvironment.problem && runPath !== workspacePath && startFailedOnMissingPath(result)
        ? (await this.chat.host.missingRunFolder(conversation, runPath))?.reason : undefined;
      await this.chat.store.withChatMutation(conversation, async () => {
        const content = result.ok
          ? compactSuccessMessage(participant.handle, compactInstructions, requesterHandle(conversation, request))
          : compactionFailureLine(participant.handle, missingFolder ?? result.error);
        conversation.messages.push(createChatMessage(
          "system",
          content,
          undefined,
          compactMessageMetadata(request, participant, result.ok ? "completed" : "failed")
        ));
        if (!result.ok) {
          warnings.push(content);
        }
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
      });
      onEnded?.(result.ok ? { kind: "completed" } : { kind: "failed", reason: missingFolder ?? result.error });
      emitProgress(runId, progress, result.ok ? "done" : "error", result.ok ? `Compacted @${participant.handle}.` : `Could not compact @${participant.handle}.`, {
        participantLabel: `@${participant.handle}`
      });
      await this.deps.debugLogs.write("chat.compaction.finished", {
        ...auditBase,
        participantId: participant.id,
        participantHandle: participant.handle,
        outcome: result.ok ? "completed" : "failed"
      });
      return { conversation, warnings };
    } catch (error) {
      emitChatRunFailure(runId, progress, error);
      await this.deps.debugLogs.write("chat.compaction.finished", {
        ...auditBase,
        participantId: ingest.participant.id,
        participantHandle: ingest.participant.handle,
        outcome: signal?.aborted ? "cancelled" : "failed",
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      reservation.release();
      await this.chat.activeRuns.endChatRun(ingest.conversation, runId);
    }
  }

  /**
   * What the member's live process is started with when a compaction finds
   * none alive: what its turn would start it with (session, role, app MCP
   * connection and tools, permissions, observers), so the process stays the
   * member's and serves its next turn. The app tool grant follows the turn's
   * rules for each CLI: a Claude Code process that is alive keeps the grant
   * its own replies act for, and one started for the compaction gets the
   * member's current grant before it connects; Codex is granted before it
   * runs. Gemini's compaction runs no app tools.
   */
  private memberProcessOptionsForCompaction(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    request: CompactChatParticipantRequest,
    runId: string,
    runPath: string,
    workspacePath: string,
    agentMode: ChatAgentMode,
    permissions: ChatAgentPermissions,
    accordFromAnySession: boolean
  ): CliAgentRunOptions {
    const appToolCapabilities = appToolCapabilitiesForRun(conversation, participant, session, permissions, accordFromAnySession);
    const appMcpToolNames = appMcpToolNamesFor(appToolCapabilities);
    const appMcpToolInventoryKey = appMcpToolInventoryKeyFor(appMcpToolNames);
    const appMcpClientGenerationId = appMcpClientGenerationIdFor(conversation, participant, session, appMcpToolInventoryKey);
    const memberKey = `${conversation.id}:${participant.id}`;
    const grant: ChatAppMcpTokenGrant = {
      conversationId: conversation.id,
      participantId: participant.id,
      roleConfigId: session.roleConfigId,
      roleConfigVersion: session.roleConfigVersion,
      capabilities: appToolCapabilities,
      clientGenerationId: appMcpClientGenerationId,
      expectedToolNames: appMcpToolNames,
      triggerMessageId: request.parentMessageId,
      triggerThreadId: request.threadId ?? request.parentMessageId,
      triggerParentMessageId: request.parentMessageId,
      triggerChatThreadRootId: request.chatThreadRootId,
      continuation: false,
      runId,
      turnSegmentId: randomUUID(),
      agentMode,
      runPermissions: effectiveChatAgentPermissionsForProvider(participant.kind, agentMode, permissions),
      participantRequestDepth: 0,
      historyMarkdownPath: path.join(workspacePath, "history.md"),
      historyJsonPath: path.join(workspacePath, "history.json")
    };
    const grantCompaction = (): { url: string; token: string } | undefined => {
      const issued = this.chat.appMcpGrants.issueAppMcpConnection(conversation, participant, grant);
      if (issued && participant.kind === "claude-code") {
        this.chat.appMcpGrants.lastAppMcpGrants.set(memberKey, grant);
      }
      return issued;
    };
    let appMcp: { url: string; token: string } | undefined;
    let grantBeforeStart: (() => void) | undefined;
    if (participant.kind === "claude-code") {
      const existingConnection = this.chat.appMcpGrants.appMcpTokens.has(memberKey) ? this.chat.appMcpGrants.appMcpConnections.get(memberKey) : undefined;
      appMcp = existingConnection ?? grantCompaction();
      grantBeforeStart = existingConnection ? () => { grantCompaction(); } : undefined;
    } else if (participant.kind === "codex-cli") {
      appMcp = grantCompaction();
    }
    return {
      persistSession: true,
      sessionId: session.sessionId,
      extraReadableDirs: [workspacePath],
      // The session's instructions, as its next turn gives them: Claude Code
      // renders its system prompt again from them once it has compacted. The
      // prompt fallback is never sent for a resumed session.
      role: session.roleRuntime === "prompt-fallback" ? undefined : this.chat.agentEnvironment.cliRoleOptions(conversation, participant, session, { agentMode, permissions }, workspacePath, ""),
      appMcp: appMcp
        ? {
            ...appMcp,
            toolNames: appMcpToolNames,
            autoPreauthorizedToolNames: preauthorizedAppMcpToolNamesFor(appMcpToolNames),
            clientGenerationId: appMcpClientGenerationId,
            clientStatus: (clientGenerationId: string) => this.deps.appMcp?.clientStatus?.(clientGenerationId)
          }
        : undefined,
      agentMode,
      permissions,
      warm: {
        conversationId: conversation.id,
        participantId: participant.id,
        contextKey: warmAgentContextKey(conversation, participant, session, runPath, workspacePath, permissions, appMcpToolInventoryKey),
        idleTimeoutMs: CHAT_WARM_AGENT_IDLE_TIMEOUT_MS,
        // Called only before a process is started for the compaction.
        onReplyStarted: grantBeforeStart,
        onSelfResumedTurn: (turn) => this.chat.selfResumedTurns.handleSelfResumedTurn(conversation.id, participant.id, turn),
        onBackgroundTasksChanged: (tasks, environmentPending) => this.chat.backgroundTasks.handleBackgroundTasksChanged(conversation.id, participant.id, tasks, environmentPending),
        // Started with suggestions on, as a turn starts it; the compaction
        // itself is not a reply a suggestion follows.
        onPromptSuggestion: (text) => this.chat.promptSuggestions.receiveMemberPromptSuggestion({
          conversationId: conversation.id,
          participantId: participant.id,
          runId,
          text
        })
      }
    };
  }

  /** A member whose home is a machine (or will be one, once its cloud
   *  machine is prepared) is compacted there, exactly as its turns run there. */
  compactsOnMachine(participant: ChatParticipant): boolean {
    return !this.chat.host.machineRuntime && Boolean(participant.cloudRun || participant.homeMachineId);
  }

  /**
   * Desktop side of compacting a member that runs on a machine. The compaction
   * is a turn of that member on the User's server (Д4): asked of its machine
   * there, taken and run by it with this service's own compactParticipant,
   * which writes the outcome line this desktop then shows, with the same
   * status and Stop as a local compaction. Whatever kept the machine from
   * running it (no server link, stopped before it was taken) ends exactly as a
   * local compaction that could not start. A compaction the member's machine
   * asked for itself (`observedServerTurns`) is shown here the same way,
   * without being asked again.
   */
  private async compactParticipantOnMachine(
    conversation: Conversation,
    participant: ChatParticipant,
    request: CompactChatParticipantRequest,
    runId: string,
    compactInstructions: string | undefined,
    warnings: string[],
    auditBase: Record<string, unknown>,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    const link = this.chat.serverLink.current;
    const observed = this.chat.selfCompaction.observedCompactionTurns.get(runId);
    const serverRunId = observed?.runId ?? (runId.startsWith("turn-") ? runId : `turn-${runId}`);
    const compacting = `Compacting @${participant.handle}.`;
    const status = (message: string): void => {
      emitProgress(runId, progress, "initial", message, { participantLabel: `@${participant.handle}` });
    };
    let turn: HubTurn | undefined = observed;
    let failure: { status: "interrupted" | "failed"; error?: string } | undefined;
    let anchorId: string | undefined = observed?.messageId;
    if (signal?.aborted) {
      failure = { status: "interrupted" };
    } else if (!link) {
      failure = { status: "failed", error: `@${participant.handle} runs on a cloud machine, which this device reaches only through your server; it is not linked to it yet` };
    } else {
      const machineName = participant.homeMachineId ? link.machineName(participant.homeMachineId) ?? "the machine" : "the machine";
      const placed = (item: HubTurn) => item.state !== "requested";
      const ended = (item: HubTurn) => item.state === "finished" || item.state === "stopped";
      try {
        if (!turn) {
          const anchor = compactionAnchor(conversation, request);
          if (!anchor) {
            // Nothing in this chat reached the server yet: the member never
            // ran in it, so it has no session there to compact.
            return await this.compactionWithoutSession(conversation, participant, request, runId, warnings, auditBase);
          }
          anchorId = anchor.id;
          const opId = newOpId();
          await link.enqueue([{
            opId, kind: "turn.request", conversationId: conversation.id, runId: serverRunId, messageId: anchor.id, participantId: participant.id,
            request: {
              kind: "compaction",
              triggeredBy: request.triggeredBy === "agent" ? "agent" : "user",
              ...(compactInstructions ? { instructions: compactInstructions } : {}),
              ...(request.requestedByParticipantId ? { requestedByParticipantId: request.requestedByParticipantId } : {}),
              ...(request.threadId?.trim() ? { threadId: request.threadId.trim() } : {}),
              ...(request.parentMessageId?.trim() ? { parentMessageId: request.parentMessageId.trim() } : {}),
              ...(request.chatThreadRootId?.trim() ? { chatThreadRootId: request.chatThreadRootId.trim() } : {})
            }
          }]);
          const asked = await link.opAnswered(opId, signal);
          if (asked.status === "rejected") throw new Error(`@${participant.handle} could not be compacted on ${machineName}: ${asked.reason}`);
          turn = asked.turn;
        }
        if (!turn || !placed(turn)) {
          // The same words a turn's bubble shows while its machine has not
          // taken it; back to "Compacting" once it has.
          const reason = participant.homeMachineId ? this.chat.remoteTurns.machineWaitReason?.(participant.homeMachineId) : undefined;
          status(`${compacting} ${machineWaitingText(machineName, reason)}`);
          turn = await this.chat.serverTurns.waitForServerTurn(serverRunId, placed, signal);
          if (!ended(turn)) status(compacting);
        }
        if (!ended(turn)) turn = await this.chat.serverTurns.waitForServerTurn(serverRunId, ended, signal);
      } catch (error) {
        if (!signal?.aborted) {
          failure = { status: "failed", error: error instanceof Error ? error.message : String(error) };
        } else if (anchorId) {
          // Stop: asked on the server, and shown as waiting until the machine
          // confirms (the approved parity exception), as on a turn's bubble.
          void this.deps.debugLogs.write("chat.compaction.stop-pending", { conversationId: conversation.id, runId, machineName });
          await link.enqueue([{ opId: newOpId(), kind: "turn.stop", conversationId: conversation.id, runId: serverRunId, messageId: anchorId, participantId: participant.id }]);
          status(`${compacting} ${machineStopPendingText(machineName)}`);
          turn = await this.chat.serverTurns.waitForServerTurn(serverRunId, ended);
        } else {
          failure = { status: "interrupted" };
        }
      }
    }
    // The lines the machine's compaction of this run wrote reached this
    // device through the server, before the turn's end did.
    const refreshed = await this.chat.store.requireChat(conversation.id).catch(() => conversation);
    const compactionLines = refreshed.messages.filter((message) => isMachineCompactionLine(message, serverRunId, participant.id));
    const outcomeMessage = compactionLines.at(-1);
    const reported = outcomeMessage?.metadata?.compaction?.outcome;
    let outcome: "completed" | "failed" | "no-active-session" = reported === "completed" || reported === "no-active-session" ? reported : "failed";
    if (!outcomeMessage) {
      // It never ran on the machine: the same line a local compaction that
      // could not start writes (a Stop before it started: word for word).
      const stoppedBeforeStart = turn?.state === "stopped" && !turn.executorDeviceId;
      const content = failure
        ? machineCompactionFailureLine(participant.handle, failure.status, failure.error)
        : machineCompactionFailureLine(participant.handle, stoppedBeforeStart ? "interrupted" : "failed",
          stoppedBeforeStart ? undefined : "the machine ended the compaction without saying how it went");
      await this.chat.store.withChatMutation(conversation, async () => {
        conversation.messages.push(createChatMessage("system", content, undefined, compactMessageMetadata(request, participant, "failed")));
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
      });
      warnings.push(content);
      outcome = "failed";
    }
    if (outcome !== "no-active-session") {
      emitProgress(runId, progress, outcome === "completed" ? "done" : "error", outcome === "completed" ? `Compacted @${participant.handle}.` : `Could not compact @${participant.handle}.`, {
        participantLabel: `@${participant.handle}`
      });
    }
    await this.deps.debugLogs.write("chat.compaction.finished", {
      ...auditBase,
      participantId: participant.id,
      participantHandle: participant.handle,
      outcome,
      homeMachineId: participant.homeMachineId,
      serverTurn: turn ? { state: turn.state, outcome: turn.outcome } : undefined
    });
    return { conversation: refreshed, warnings };
  }

  /** The line a compaction of a member that has no session writes. */
  private async compactionWithoutSession(
    conversation: Conversation,
    participant: ChatParticipant,
    request: CompactChatParticipantRequest,
    runId: string,
    warnings: string[],
    auditBase: Record<string, unknown>
  ): Promise<StartReviewResult> {
    await this.chat.store.withChatMutation(conversation, async () => {
      conversation.messages.push(createChatMessage(
        "system",
        `@${participant.handle} does not have an active session to compact yet.`,
        undefined,
        compactMessageMetadata({ ...request, runId }, participant, "no-active-session")
      ));
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
    });
    await this.deps.debugLogs.write("chat.compaction.finished", { ...auditBase, participantId: participant.id, participantHandle: participant.handle, outcome: "no-active-session" });
    return { conversation, warnings };
  }
}

/** The main session's handle when it asked for this compaction. */
function requesterHandle(conversation: Conversation, request: CompactChatParticipantRequest): string | undefined {
  const id = request.requestedByParticipantId;
  return id ? chatParticipants(conversation).find((participant) => participant.id === id)?.handle : undefined;
}
