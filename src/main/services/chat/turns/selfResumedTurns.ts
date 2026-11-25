import { randomUUID } from "node:crypto";
import type { ChatExecutionLeaseMetadata, Conversation } from "../../../../shared/types";
import type { CliAgentReplyOrigin, CliAgentSelfResumedTurn } from "../../cliAgents";
import { sanitizeWarningText } from "../../../../shared/warnings";
import { pendingChoiceFromAgentReply } from "../choices/choiceRecords";
import { updateParticipantContextUsage } from "../compaction/contextUsage";
import { INSTRUCTIONS_ACCESS_RESTATE } from "../constants";
import { chatParticipants, chatSessions } from "../members/identity";
import { recordReplySessionCut } from "../sessions/forkNotes";
import { recordLastMessageByParticipant } from "../store/lastMessages";
import { createChatMessage } from "../store/messages";
import {
  emitProgress, failedPrecreatedPendingMessageContent, markParticipantMessageStoppedByUser,
  processingTranscriptWithTerminalMessage
} from "./replyMessages";
import type { ChatAppMcpTokenGrant } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Replies a member's CLI starts on its own, after background work. */
export class SelfResumedTurns {
  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "appMcpGrants" | "approvalDecisions" | "claudeModes" | "deletion" | "executorLeases" | "host"
      | "memberSessions" | "pendingReplies" | "promptSuggestions" | "store" | "turnPrompt" | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "appMcp" | "debugLogs" | "onReviewProgress">
  ) {}

  /** A Claude Code member's CLI started a reply on its own: background work
   *  the member started earlier finished while it was idle. The dedicated CLI
   *  shows that continuation as a new turn of its transcript; here it becomes a
   *  new reply next to the reply that started the work, with the same Stop,
   *  live progress and persistence as any other reply. */
  handleSelfResumedTurn(conversationId: string, participantId: string, turn: CliAgentSelfResumedTurn): void {
    // Called as the CLI starts the step: its app tool calls act for this new
    // reply from the first one on, before the reply is even stored.
    const runId = randomUUID();
    if (!this.chat.host.machineRuntime) {
      // A reply the member starts on its own replaces the one a suggestion follows.
      this.chat.promptSuggestions.suggestions.replyStarted(conversationId, participantId, runId);
    }
    this.grantAppToolsToSelfResumedTurn(conversationId, participantId, runId, turn.origin);
    void this.runSelfResumedTurn(conversationId, participantId, turn, runId).catch((error) => {
      void this.deps.debugLogs.write("chat.self-resumed-turn.error", {
        conversationId,
        participantId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async runSelfResumedTurn(conversationId: string, participantId: string, turn: CliAgentSelfResumedTurn, runId: string): Promise<void> {
    const drain = async (reason: string): Promise<void> => {
      void this.deps.debugLogs.write("chat.self-resumed-turn.dropped", { conversationId, participantId, reason });
      await turn.attach({}).catch(() => undefined);
    };
    if (this.chat.deletion.deletedConversationIds.has(conversationId)) {
      await drain("chat-deleted");
      return;
    }
    const controller = new AbortController();
    const progress = this.deps.onReviewProgress;
    let begunIn: Conversation | undefined;
    const ingest = await this.chat.activeRuns.withChatRunLock(conversationId, async () => {
      const conversation = await this.chat.store.requireChat(conversationId);
      const participant = chatParticipants(conversation).find((candidate) => candidate.id === participantId);
      if (!participant || !this.chat.host.ownsParticipant(participant) || conversation.metadata.archived === true) {
        return undefined;
      }
      const originMessageId = turn.origin?.messageId;
      const origin = originMessageId ? conversation.messages.find((message) => message.id === originMessageId) : undefined;
      const pendingMessage = createChatMessage(
        "participant",
        "",
        { id: participant.id, kind: participant.kind, label: `@${participant.handle}`, model: participant.model },
        {
          threadId: origin ? origin.metadata?.threadId ?? origin.id : undefined,
          parentMessageId: origin?.id,
          chatThreadRootId: origin?.metadata?.chatThreadRootId,
          sourceMessageId: origin?.id,
          runId
        },
        "pending"
      );
      this.chat.activeRuns.registerTargetRun(runId, controller, { conversationId, participantId, participantHandle: participant.handle });
      this.chat.activeRuns.setTargetRunPendingMessageId(runId, pendingMessage.id);
      await this.chat.activeRuns.beginChatRun(conversation, runId);
      begunIn = conversation;
      await this.chat.store.withChatMutation(conversation, async () => {
        conversation.messages.push(pendingMessage);
        recordLastMessageByParticipant(conversation, pendingMessage);
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
      });
      return { conversation, participant, origin, pendingMessage };
    }).catch(async (error) => {
      void this.deps.debugLogs.write("chat.self-resumed-turn.ingest-failed", {
        conversationId,
        participantId,
        message: error instanceof Error ? error.message : String(error)
      });
      if (begunIn) {
        await this.chat.activeRuns.endChatRun(begunIn, runId).catch(() => undefined);
      }
      this.chat.activeRuns.unregisterTargetRun(runId, controller);
      return undefined;
    });
    if (!ingest) {
      await drain("not-shown-here");
      return;
    }
    const { conversation, participant, origin, pendingMessage } = ingest;
    const reservation = this.chat.turnQueue.reserveParticipantTurn(conversationId, participantId, "shared");
    const progressSink = this.chat.pendingReplies.createAgentProgressSink(runId, progress, participant, pendingMessage.id);
    const unregisterRunProgressCallback = this.chat.activeRuns.registerRunProgressCallback(runId, progress);
    const session = chatSessions(conversation).find((candidate) => candidate.participantId === participantId);
    let executionLease: ChatExecutionLeaseMetadata | undefined;
    try {
      if (session) {
        try {
          // The step runs on the member's session like any other turn of it.
          executionLease = this.chat.executorLeases.acquireParticipantExecutorLease(conversation, participant, session, "desktop");
        } catch (error) {
          void this.deps.debugLogs.write("chat.self-resumed-turn.lease-unavailable", {
            conversationId,
            participantId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
      emitProgress(runId, progress, "debate", `@${participant.handle} is responding.`, {
        participantLabel: `@${participant.handle}`,
        agentProgress: {
          participantId: participant.id,
          participantLabel: `@${participant.handle}`,
          state: "running",
          messageId: pendingMessage.id
        }
      });
      // Its CLI may still run a wider mode than the member's: switched first,
      // else the reply is stopped.
      if (await this.chat.claudeModes.alignSelfStartedClaudeReply(conversation, participant)) controller.abort();
      progressSink.beginAttempt();
      const result = await turn.attach({
        signal: controller.signal,
        onOutput: progressSink.emit,
        onSessionId: (sessionId) => {
          if (session) {
            this.chat.memberSessions.persistParticipantSessionId(conversation, session, sessionId);
          }
        }
      });
      const now = new Date().toISOString();
      updateParticipantContextUsage(conversation, participant.id, result.contextUsage);
      pendingMessage.content = result.content;
      if (controller.signal.aborted) {
        markParticipantMessageStoppedByUser(pendingMessage, participant, {
          preserveContent: result.ok && result.content.trim().length > 0
        });
      } else if (result.ok) {
        pendingMessage.status = "done";
      } else {
        pendingMessage.status = "error";
        pendingMessage.content = result.error
          ? `@${participant.handle}: ${sanitizeWarningText(result.error)}`
          : `@${participant.handle} run failed.`;
        this.chat.approvalDecisions.markPendingAppToolApprovalsForRunTerminal(conversation, runId, pendingMessage.content, true);
      }
      if (result.ok && result.turnContinues && !controller.signal.aborted) {
        // The User's next message joined this step the CLI started itself:
        // as on the main path, no "Worked for" of its own.
        const { workedMs: _workedMs, ...metadata } = pendingMessage.metadata ?? {};
        pendingMessage.metadata = { ...metadata, turnContinues: true };
      } else {
        const workedMs = Date.parse(now) - Date.parse(pendingMessage.createdAt);
        if (Number.isFinite(workedMs) && workedMs >= 0) {
          pendingMessage.metadata = { ...pendingMessage.metadata, workedMs };
        }
      }
      recordReplySessionCut(pendingMessage, result);
      const pendingChoice = !controller.signal.aborted && result.ok && result.content.trim()
        ? pendingChoiceFromAgentReply(result.content)
        : undefined;
      if (pendingChoice) {
        pendingMessage.metadata = { ...pendingMessage.metadata, pendingChoice };
      }
    } catch (error) {
      if (controller.signal.aborted) {
        markParticipantMessageStoppedByUser(pendingMessage, participant);
      } else {
        pendingMessage.status = "error";
        pendingMessage.content = failedPrecreatedPendingMessageContent(participant, error);
      }
    } finally {
      unregisterRunProgressCallback();
      if (pendingMessage.status === "pending") {
        pendingMessage.status = "error";
      }
      const activityEvents = progressSink.activityEvents();
      if (activityEvents.length > 0) {
        pendingMessage.metadata = { ...pendingMessage.metadata, activityEvents };
      }
      const capturedAt = new Date().toISOString();
      let processingTranscript = progressSink.processingTranscript(capturedAt);
      if (processingTranscript && controller.signal.aborted) {
        processingTranscript = processingTranscriptWithTerminalMessage(processingTranscript, pendingMessage.content);
      }
      if (processingTranscript) {
        pendingMessage.metadata = { ...pendingMessage.metadata, processingTranscript };
      }
      if (session) {
        session.updatedAt = capturedAt;
        // A compaction in this reply: the member's next turn says its access again.
        if (this.chat.turnPrompt.noteMemberCompactions(conversation.id, participant) && session.instructionsAccessHash) {
          session.instructionsAccessHash = INSTRUCTIONS_ACCESS_RESTATE;
        }
      }
      this.chat.executorLeases.releaseParticipantExecutorLease(conversation, executionLease);
      try {
        await this.chat.pendingReplies.finalizePendingParticipantMessage(conversation, participant, pendingMessage);
      } finally {
        progressSink.finish();
        reservation.release();
        await this.chat.activeRuns.endChatRun(conversation, runId);
        this.chat.activeRuns.unregisterTargetRun(runId, controller);
      }
    }
  }

  /** App tools the CLI calls during a reply it started itself act for that
   *  reply: its run, in the thread where the finished work was started. The
   *  member's last grant supplies its tools and permissions; nothing of the
   *  turn it belonged to (a member request, a continuation) carries over. */
  private grantAppToolsToSelfResumedTurn(
    conversationId: string,
    participantId: string,
    runId: string,
    origin: CliAgentReplyOrigin | undefined
  ): void {
    const key = `${conversationId}:${participantId}`;
    const previous = this.chat.appMcpGrants.lastAppMcpGrants.get(key);
    const token = this.chat.appMcpGrants.appMcpTokens.get(key);
    if (!previous || !token || !this.deps.appMcp?.updateToken) {
      return;
    }
    const grant: ChatAppMcpTokenGrant = {
      ...previous,
      runId,
      turnSegmentId: randomUUID(),
      continuation: false,
      participantRequestDepth: 0,
      participantRequestBatchId: undefined,
      chainRootId: undefined,
      snapshotMaxSequence: undefined,
      triggerMessageId: origin?.messageId,
      triggerThreadId: origin ? origin.threadId ?? origin.messageId : undefined,
      triggerParentMessageId: origin?.messageId,
      triggerChatThreadRootId: origin?.chatThreadRootId
    };
    const updated = this.deps.appMcp.updateToken(token, grant);
    if (updated) {
      this.chat.appMcpGrants.appMcpConnections.set(key, updated);
      this.chat.appMcpGrants.lastAppMcpGrants.set(key, grant);
    }
  }
}
