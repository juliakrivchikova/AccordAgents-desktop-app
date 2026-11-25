import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatParticipant, ChatParticipantRequestBatch, Conversation } from "../../../../shared/types";
import { formatHandleList } from "../members/identity";
import { participantTurnMode } from "../members/roleRuntime";
import { turnShown } from "../runs/runOwnerRecords";
import { RemoteTurnNotStartedError } from "../server/remoteTurnErrors";
import { recordLastMessageByParticipant, repairLastMessagePointerAfterRemoval } from "../store/lastMessages";
import { markChatMessageRemoved } from "../store/mergeStoredChat";
import { clone, createChatMessage } from "../store/messages";
import { promptContextScopeForTrigger } from "./promptContextRecords";
import { emitProgress } from "./replyMessages";
import { takenBackMark } from "./takenBackMessages";
import type { ProgressCallback, ServerTurnOpen } from "../types";
import type { ChatModules } from "../modules";

/** Runs the turns of one message's members together. */
export class ParticipantBatch {
  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "agentEnvironment" | "appQuit" | "approvalDecisions" | "chatHistory" | "members" | "messageSending"
      | "participantRequests" | "pendingReplies" | "promptContext" | "serverLink" | "serverPlaceholders" | "serverTurns"
      | "store" | "titles" | "turnQueue"
    >
  ) {}

  async runParticipantBatch(
    conversation: Conversation,
    participants: ChatParticipant[],
    triggerMessage: ChatMessage,
    runId: string,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    warnings: string[],
    options: {
      targetRunIds?: ReadonlyMap<string, string>;
      /** Machines transport: a machine hosting a turn reuses the pending
       *  message id the desktop created, so both copies name the same bubble. */
      pendingMessageIds?: ReadonlyMap<string, string>;
      onTargetRunBegun?: (participantId: string, runId: string) => Promise<void> | void;
    } = {}
  ): Promise<void> {
    if (conversation.metadata.archived === true) throw new Error("Unarchive the chat before starting a member.");
    // Taken before anything awaits, in the order the User sent the messages:
    // a Claude Code member gets them in that order even when they overlap.
    const writeGates = new Map(participants
      .filter((participant) => participantTurnMode(participant, triggerMessage) === "shared")
      .map((participant) => [participant.id, this.chat.promptContext.openClaudeWriteGate(conversation.id, participant.id)] as const));
    // Each member cannot be removed from here until its turn is registered
    // below (chatRunMeta), before that turn's first await.
    const memberClaims = new Map<string, () => void>();
    for (const participant of participants) {
      if (!memberClaims.has(participant.id)) memberClaims.set(participant.id, this.chat.members.claimMemberWork(conversation.id, [participant.id]));
    }
    let completed = 0;
    let workspacePath: string;
    const turnSnapshot = clone(conversation);
    try {
      workspacePath = await this.chat.chatHistory.ensureHistoryFiles(turnSnapshot);
    } catch (error) {
      for (const release of memberClaims.values()) release();
      throw error;
    }
    const labels = participants.map((participant) => `@${participant.handle}`);
    emitProgress(runId, progress, "debate", `${formatHandleList(labels)} ${participants.length === 1 ? "is" : "are"} responding in parallel.`, {
      completed,
      total: participants.length
    });
    const appendCompletedTurn = async (participant: ChatParticipant, messages: ChatMessage[]): Promise<void> => {
      let participantRequestsToRun: Array<{ requestMessageId: string; depth: number; source: ChatParticipantRequestBatch["source"] }> = [];
      await this.chat.store.withChatMutation(conversation, async () => {
        participantRequestsToRun = await this.chat.pendingReplies.appendParticipantTurnMessages(conversation, participant, messages);
        await this.chat.agentEnvironment.recordSuccessfulAssistantProviderForMessages(conversation, participant, messages);
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
      });
      this.chat.participantRequests.startDeferredParticipantRequestRunners(conversation.id, participantRequestsToRun);
    };
    await Promise.all(
      participants.map(async (participant) => {
        const targetRunId = options.targetRunIds?.get(participant.id) ?? randomUUID();
        const targetController = new AbortController();
        const onParentAbort = (): void => {
          if (!targetController.signal.aborted) {
            targetController.abort();
          }
        };
        if (signal?.aborted) {
          targetController.abort();
        } else {
          signal?.addEventListener("abort", onParentAbort, { once: true });
        }
        this.chat.activeRuns.registerTargetRun(targetRunId, targetController, {
          conversationId: conversation.id,
          participantId: participant.id,
          participantHandle: participant.handle
        });
        memberClaims.get(participant.id)?.();
        const skillBlock = await this.chat.messageSending.skillRunBlockForParticipant(conversation, participant, triggerMessage);
        if (skillBlock) {
          await this.chat.store.withChatMutation(conversation, async () => {
            conversation.messages.push(createChatMessage("system", skillBlock, undefined, {
              threadId: triggerMessage.metadata?.threadId ?? triggerMessage.id,
              parentMessageId: triggerMessage.id,
              chatThreadRootId: triggerMessage.metadata?.chatThreadRootId
            }));
            conversation.updatedAt = new Date().toISOString();
            this.chat.store.queueSnapshot(conversation);
          });
          this.chat.activeRuns.unregisterTargetRun(targetRunId, targetController);
          writeGates.get(participant.id)?.markWritten();
          await this.chat.titles.clearAutoTitleEligibilityForTerminalRun(conversation, targetRunId);
          signal?.removeEventListener("abort", onParentAbort);
          completed += 1;
          emitProgress(runId, progress, "debate", `@${participant.handle} skipped.`, {
            participantLabel: `@${participant.handle}`,
            completed,
            total: participants.length
          });
          return;
        }
        // The User's server first (Д4, Д13): the message this turn answers is
        // on it, and the turn is taken here or asked of the member's device.
        let serverTurn: ServerTurnOpen = { kind: "none" };
        if (this.chat.serverLink.current) {
          try {
            serverTurn = await this.chat.serverTurns.openServerTurn(conversation, participant, triggerMessage, targetRunId, targetController.signal);
          } catch (error) {
            serverTurn = { kind: "skip", serverRunId: "", reason: error instanceof Error ? error.message : String(error) };
            if (!targetController.signal.aborted) warnings.push(`@${participant.handle} could not start: ${serverTurn.reason}`);
            else serverTurn = { kind: "stopped", serverRunId: "" };
          }
          if (serverTurn.kind === "stopped" || serverTurn.kind === "skip") {
            if (serverTurn.kind === "stopped" && !turnShown(conversation, triggerMessage, participant, serverTurn.serverRunId)) {
              await this.chat.serverTurns.noteTurnStoppedBeforeStart(conversation, triggerMessage, participant);
            }
            this.chat.serverTurns.serverTurnOpens.delete(targetRunId);
            this.chat.activeRuns.unregisterTargetRun(targetRunId, targetController);
            writeGates.get(participant.id)?.markWritten();
            await this.chat.titles.clearAutoTitleEligibilityForTerminalRun(conversation, targetRunId);
            signal?.removeEventListener("abort", onParentAbort);
            completed += 1;
            emitProgress(runId, progress, "debate", `@${participant.handle} ${serverTurn.kind === "stopped" ? "stopped" : "skipped"}.`, {
              participantLabel: `@${participant.handle}`,
              completed,
              total: participants.length
            });
            return;
          }
        }
        const turnReservation = this.chat.turnQueue.reserveParticipantTurn(conversation.id, participant.id, participantTurnMode(participant, triggerMessage));
        // Its CLI holds a message sent while the member works (behindMemberTurn)
        // where the CLI runs: a member on a machine says so on its own bubble
        // (turnQueued), which replaces this one; a local mark here would stay.
        const queuedHere = turnReservation.queued || (serverTurn.kind !== "remote" && Boolean(turnReservation.behindMemberTurn));
        // Pre-create the pending message inside the shared mutation queue, before
        // the per-participant turn queue wait, so the queued/streaming bubble is
        // visible immediately even if a prior same-participant turn is still running.
        const pendingMessage = createChatMessage(
          "participant",
          "",
          { id: participant.id, kind: participant.kind, label: `@${participant.handle}`, model: participant.model },
          {
            threadId: triggerMessage.metadata?.threadId ?? triggerMessage.id,
            parentMessageId: triggerMessage.id,
            chatThreadRootId: triggerMessage.metadata?.chatThreadRootId,
            sourceMessageId: triggerMessage.id,
            runId: targetRunId,
            queuedBehind: queuedHere ? { handle: participant.handle } : undefined,
            turnQueued: queuedHere ? true : undefined
          },
          "pending"
        );
        const pendingMessageIdOverride = options.pendingMessageIds?.get(participant.id);
        if (pendingMessageIdOverride) {
          pendingMessage.id = pendingMessageIdOverride;
        }
        if (serverTurn.kind === "remote") {
          // Shown here until the member's own device writes the real bubble.
          pendingMessage.metadata = { ...pendingMessage.metadata, serverPlaceholder: true, runId: serverTurn.serverRunId };
        }
        this.chat.activeRuns.setTargetRunPendingMessageId(targetRunId, pendingMessage.id);
        // Register the run as active before persisting the pending bubble, and keep the
        // persist inside the try so endChatRun always balances beginChatRun. Otherwise a
        // crash/refresh in the gap can observe a saved "pending" participant message
        // whose run id is not yet in activeRunIds and sweep it as "Interrupted".
        let reservationHandedOff = false;
        let runBegun = false;
        try {
          await this.chat.activeRuns.beginChatRun(conversation, targetRunId);
          runBegun = true;
          await options.onTargetRunBegun?.(participant.id, targetRunId);
          await this.chat.store.withChatMutation(conversation, async () => {
            // A machine-hosted turn reuses the desktop's bubble id, and that
            // bubble may already be in this copy through replication.
            const existingIndex = conversation.messages.findIndex((message) => message.id === pendingMessage.id);
            if (existingIndex >= 0) {
              conversation.messages[existingIndex] = pendingMessage;
            } else {
              conversation.messages.push(pendingMessage);
            }
            recordLastMessageByParticipant(conversation, pendingMessage);
            conversation.updatedAt = new Date().toISOString();
            this.chat.store.queueSnapshot(conversation);
          });
          reservationHandedOff = true;
          const messages = await this.chat.turnQueue.runParticipantTurnSerialized(conversation, participant, triggerMessage, targetRunId, targetController.signal, progress, {
            warnings,
            promptConversation: turnSnapshot,
            workspacePath,
            promptContextScope: promptContextScopeForTrigger(triggerMessage),
            existingPendingMessage: pendingMessage,
            turnReservation,
            writeGate: writeGates.get(participant.id)
          });
          if (serverTurn.kind === "remote") {
            // The member's own device wrote its reply and ran what follows it.
            await this.chat.serverPlaceholders.dropServerPlaceholder(conversation, pendingMessage.id);
          } else if (targetController.signal.aborted) {
            await this.discardStoppedTargetRun(conversation, targetRunId, participant, pendingMessage.id);
          } else {
            await appendCompletedTurn(participant, messages);
          }
        } catch (error) {
          if (serverTurn.kind === "remote" && error instanceof RemoteTurnNotStartedError && !targetController.signal.aborted) {
            await this.chat.pendingReplies.finalizeFailedPrecreatedPendingMessage(conversation, pendingMessage.id, participant, new Error(error.message));
          } else if (serverTurn.kind === "remote") {
            await this.chat.serverPlaceholders.dropServerPlaceholder(conversation, pendingMessage.id);
            if (!targetController.signal.aborted) warnings.push(error instanceof Error ? error.message : String(error));
          } else if (targetController.signal.aborted) {
            await this.discardStoppedTargetRun(conversation, targetRunId, participant, pendingMessage.id);
          } else {
            await this.chat.pendingReplies.finalizeFailedPrecreatedPendingMessage(conversation, pendingMessage.id, participant, error);
            throw error;
          }
        } finally {
          signal?.removeEventListener("abort", onParentAbort);
          writeGates.get(participant.id)?.markWritten();
          if (!reservationHandedOff) {
            turnReservation.release();
          }
          if (runBegun) {
            await this.chat.activeRuns.endChatRun(conversation, targetRunId);
          }
          this.chat.activeRuns.unregisterTargetRun(targetRunId, targetController);
        }
        completed += 1;
        emitProgress(runId, progress, "debate", `@${participant.handle} finished.`, {
          participantLabel: `@${participant.handle}`,
          completed,
          total: participants.length
        });
      })
    );
    await this.chat.chatHistory.ensureHistoryFiles(conversation);
  }

  private async discardStoppedTargetRun(
    conversation: Conversation,
    runId: string,
    participant: ChatParticipant,
    pendingMessageIdOverride?: string
  ): Promise<void> {
    const meta = this.chat.activeRuns.chatRunMeta.get(runId);
    const pendingMessageId = pendingMessageIdOverride ?? meta?.pendingMessageId;
    await this.chat.store.withChatMutation(conversation, async () => {
      let threadId: string | undefined;
      let chatThreadRootId: string | undefined;
      let keptStoppedParticipantMessage = false;
      let takenBack: ReturnType<typeof takenBackMark>;
      if (pendingMessageId) {
        const idx = conversation.messages.findIndex((message) => message.id === pendingMessageId);
        if (idx >= 0) {
          const pending = conversation.messages[idx];
          threadId = pending.metadata?.threadId;
          chatThreadRootId = pending.metadata?.chatThreadRootId;
          if (!this.chat.appQuit.endsByQuit(runId)) takenBack = takenBackMark(pending);
          if (pending.role === "participant" && pending.status === "pending") {
            conversation.messages.splice(idx, 1);
            markChatMessageRemoved(conversation, pendingMessageId);
            // The pending bubble was recorded as this participant's last-message pointer when
            // the turn began. Pointers only ever advance, so removing it would leave the roster
            // jump aimed at a message that no longer exists (a silent no-op). Repair from the
            // remaining full history (refreshStoredChatState already merged it here).
            repairLastMessagePointerAfterRemoval(conversation, pendingMessageId);
          } else if (pending.metadata?.queuedBehind || pending.metadata?.turnQueued) {
            const { queuedBehind: _queuedBehind, turnQueued: _turnQueued, ...metadata } = pending.metadata;
            conversation.messages[idx] = {
              ...pending,
              metadata: { ...metadata, ...takenBack }
            };
          }
          if (
            pending.role === "participant" &&
            pending.status === "error" &&
            (pending.metadata?.terminalReason === "user-stopped" || pending.metadata?.terminalReason === "stop-unconfirmed")
          ) {
            // An unconfirmed stop (Rule 2) stays as it is: no "stopped by user" line.
            keptStoppedParticipantMessage = true;
          }
        }
      }
      this.chat.approvalDecisions.markPendingAppToolApprovalsForRunTerminal(
        conversation,
        runId,
        `@${participant.handle} stopped before pending approval was resolved.`
      );
      if (!keptStoppedParticipantMessage) {
        conversation.messages.push(createChatMessage(
          "system",
          `@${participant.handle} stopped by user.`,
          undefined,
          { threadId, chatThreadRootId, ...takenBack }
        ));
      }
      conversation.updatedAt = new Date().toISOString();
      this.chat.store.queueSnapshot(conversation);
    });
  }

  ensureChatTurnController(
    conversation: Conversation,
    participant: ChatParticipant,
    runId: string,
    parentSignal: AbortSignal | undefined
  ): { signal: AbortSignal; cleanup: () => void } {
    const existingController = this.chat.activeRuns.firstChatRunController(runId);
    if (existingController && parentSignal === existingController.signal) {
      this.chat.activeRuns.chatRunMeta.set(runId, {
        conversationId: conversation.id,
        participantId: participant.id,
        participantHandle: participant.handle
      });
      return {
        signal: parentSignal,
        cleanup: () => {
          // The parent registration owns this controller and its metadata;
          // its final unregister announces the settled run exactly once.
        }
      };
    }
    const controller = new AbortController();
    const inheritedSignal = parentSignal ?? existingController?.signal;
    const abortFromInherited = (): void => controller.abort();
    if (inheritedSignal?.aborted) {
      controller.abort();
    } else {
      inheritedSignal?.addEventListener("abort", abortFromInherited, { once: true });
    }
    this.chat.activeRuns.registerTargetRun(runId, controller, {
      conversationId: conversation.id,
      participantId: participant.id,
      participantHandle: participant.handle
    });
    return {
      signal: controller.signal,
      cleanup: () => {
        inheritedSignal?.removeEventListener("abort", abortFromInherited);
        this.chat.activeRuns.unregisterTargetRun(runId, controller);
      }
    };
  }

  registerBackgroundRunController(runId: string, parentSignal: AbortSignal | undefined): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const abortFromParent = (): void => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    if (parentSignal?.aborted) {
      controller.abort();
    } else {
      parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    }
    this.chat.activeRuns.registerRunController(runId, controller);
    let cleaned = false;
    return {
      signal: controller.signal,
      cleanup: () => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        parentSignal?.removeEventListener("abort", abortFromParent);
        this.chat.activeRuns.unregisterRunController(runId, controller);
      }
    };
  }
}
