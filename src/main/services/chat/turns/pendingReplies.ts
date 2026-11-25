import type {
  ChatAgentActivityEvent, ChatMessage, ChatMessageMetadata, ChatParticipant, ChatParticipantRequestBatch, ChatParticipantSession,
  ChatProcessingTranscript, Conversation, ParticipantConfig
} from "../../../../shared/types";
import type { CliAgentOutputEvent } from "../../cliAgents";
import type { ParticipantRunResult } from "../../providers";
import { chatSkillMentions } from "../choices/mentions";
import { chatParticipants } from "../members/identity";
import { isKnownRoleRuntime } from "../members/roleRuntime";
import { recordLastMessageByParticipant, upsertCompletedMessage } from "../store/lastMessages";
import { appendTurnFinishedNote } from "../store/messages";
import { hasSelectedSkillFinalStatus } from "./promptSections";
import {
  appendChatActivity, emitProgress, failedPrecreatedPendingMessageContent, processingTranscriptFromContent,
  withCliStartedReplyStart
} from "./replyMessages";
import type { ChatActivityAccumulator } from "./types";
import type { ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

const CHAT_PROGRESS_FLUSH_INTERVAL_MS = 100;

/** The reply bubble of a running turn: made, filled while the member works, finished. */
export class PendingReplies {
  /** Where each live run's streamed text and activity stand now, so a post
   *  made during the turn is placed in order with them (interimPosts.ts). */
  readonly liveRunPositions = new Map<string, () => { contentLength: number; activitySequence: number }>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "agentEnvironment" | "approvalDecisions" | "autoWatch" | "choiceExpiry" | "inferredRequests"
      | "participantRequests" | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs">
  ) {}

  async prepareExistingPendingMessageForRun(
    conversation: Conversation,
    existingPendingMessage: ChatMessage,
    cliParticipant: ParticipantConfig,
    triggerMessage: ChatMessage,
    continuation: boolean,
    inferenceContext: {
      turnSegmentId: string;
      participantRequestDepth: number;
      participantRequestBatchId?: string;
      chainRootId?: string;
    },
    queue: { keepQueued: boolean } = { keepQueued: false }
  ): Promise<ChatMessage> {
    let pendingMessage = existingPendingMessage;
    await this.chat.store.withChatMutation(conversation, async () => {
      const existingIndex = conversation.messages.findIndex((message) => message.id === existingPendingMessage.id);
      pendingMessage = existingIndex >= 0 ? conversation.messages[existingIndex] : existingPendingMessage;
      this.chat.approvalDecisions.resolveSupersededParticipantInteractions(conversation, cliParticipant.id, pendingMessage.id);
      pendingMessage.participantId = cliParticipant.id;
      pendingMessage.participantLabel = cliParticipant.label;
      const metadata: ChatMessageMetadata = {
        ...pendingMessage.metadata,
        requesterParticipantId: continuation ? triggerMessage.participantId : pendingMessage.metadata?.requesterParticipantId,
        approvedContinuation: continuation || pendingMessage.metadata?.approvedContinuation,
        turnSegmentId: inferenceContext.turnSegmentId,
        participantRequestDepth: inferenceContext.participantRequestDepth,
        ...(inferenceContext.participantRequestBatchId !== undefined
          ? { participantRequestBatchId: inferenceContext.participantRequestBatchId }
          : {}),
        ...(inferenceContext.chainRootId !== undefined
          ? { participantRequestChainRootId: inferenceContext.chainRootId }
          : {})
      };
      if (!queue.keepQueued) {
        if (metadata.queuedBehind || metadata.turnQueued) {
          // It waited behind the member's turn before it: its own turn starts now.
          metadata.turnStartedAt = new Date().toISOString();
        }
        delete metadata.queuedBehind;
        delete metadata.turnQueued;
      }
      pendingMessage.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
      if (existingIndex >= 0) {
        conversation.messages[existingIndex] = pendingMessage;
      } else {
        conversation.messages.push(pendingMessage);
      }
      this.chat.choiceExpiry.noteChoiceExpiry(conversation);
      recordLastMessageByParticipant(conversation, pendingMessage);
      conversation.updatedAt = new Date().toISOString();
      this.chat.store.queueSnapshot(conversation);
    });
    return pendingMessage;
  }

  /** The reply's start as its CLI said (cliStartedReplyStart), in the chat. */
  async noteCliStartedReply(conversation: Conversation, pendingMessageId: string, started: { turnStartedAt?: string }): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      const index = conversation.messages.findIndex((message) => message.id === pendingMessageId);
      const reply = index >= 0 ? conversation.messages[index] : undefined;
      if (!reply || reply.role !== "participant") {
        return;
      }
      if (reply.status !== "pending") {
        // It already ended: only its queue marks go, if any are left.
        if (!reply.metadata?.queuedBehind && !reply.metadata?.turnQueued) return;
        const { queuedBehind: _queuedBehind, turnQueued: _turnQueued, ...metadata } = reply.metadata;
        reply.metadata = metadata;
      } else {
        reply.metadata = withCliStartedReplyStart(reply.metadata, started);
      }
      conversation.updatedAt = new Date().toISOString();
      this.chat.store.queueSnapshot(conversation);
    });
  }

  async finalizeFailedPrecreatedPendingMessage(
    conversation: Conversation,
    pendingMessageId: string,
    participant: ChatParticipant,
    error: unknown
  ): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      const existingIndex = conversation.messages.findIndex((message) => message.id === pendingMessageId);
      if (existingIndex < 0) {
        return;
      }
      const pendingMessage = conversation.messages[existingIndex];
      if (pendingMessage.role !== "participant" || pendingMessage.status !== "pending") {
        return;
      }
      const metadata: ChatMessageMetadata = { ...pendingMessage.metadata };
      delete metadata.queuedBehind;
      delete metadata.turnQueued;
      pendingMessage.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
      pendingMessage.status = "error";
      if (!pendingMessage.content.trim()) {
        pendingMessage.content = failedPrecreatedPendingMessageContent(participant, error);
      }
      conversation.messages[existingIndex] = pendingMessage;
      recordLastMessageByParticipant(conversation, pendingMessage);
      conversation.updatedAt = new Date().toISOString();
      this.chat.store.queueSnapshot(conversation);
    });
  }

  async finalizePendingParticipantMessage(
    conversation: Conversation,
    participant: ChatParticipant,
    pendingMessage: ChatMessage
  ): Promise<void> {
    let participantRequestsToRun: Array<{ requestMessageId: string; depth: number; source: ChatParticipantRequestBatch["source"] }> = [];
    await this.chat.store.withChatMutation(conversation, async () => {
      // After refresh-then-merge, the pendingMessage object may or may not be in
      // conversation.messages. mergeStoredChatMessages prefers our in-memory
      // reference when ids match, so the in-place updates (content/status) are
      // preserved. upsertCompletedMessage re-appends when missing and repairs a
      // stale-recovery placeholder for the same id, carrying its reactions over.
      const accepted = upsertCompletedMessage(conversation, pendingMessage)
        ? [pendingMessage]
        : [];
      await this.chat.agentEnvironment.recordSuccessfulAssistantProviderForMessages(conversation, participant, accepted);
      participantRequestsToRun = await this.chat.inferredRequests.createImplicitParticipantRequestApproval(conversation, participant, accepted);
      appendTurnFinishedNote(conversation, accepted);
      conversation.updatedAt = new Date().toISOString();
      this.chat.store.queueSnapshot(conversation);
    });
    this.chat.participantRequests.startDeferredParticipantRequestRunners(conversation.id, participantRequestsToRun);
  }

  async appendParticipantTurnMessages(
    conversation: Conversation,
    turnParticipant: ChatParticipant,
    messages: ChatMessage[]
  ): Promise<Array<{ requestMessageId: string; depth: number; source: ChatParticipantRequestBatch["source"] }>> {
    // Its settings as saved now (callers refresh first): a "Request other
    // members" the User changed while the turn ran decides what its reply may
    // ask of others.
    const participant = chatParticipants(conversation).find((item) => item.id === turnParticipant.id) ?? turnParticipant;
    const accepted: ChatMessage[] = [];
    for (const message of messages) {
      if (upsertCompletedMessage(conversation, message)) {
        accepted.push(message);
      }
    }
    // Only infer participant requests from messages we actually appended/replaced.
    // A declined late message (e.g. a user-stopped run finishing) must not spawn
    // implicit request approvals from content the user never sees.
    const participantRequestsToRun = await this.chat.inferredRequests.createImplicitParticipantRequestApproval(conversation, participant, accepted);
    appendTurnFinishedNote(conversation, accepted);
    if (accepted.length > 0 && !this.chat.activeRuns.chatHasLiveWork(conversation.id)) {
      this.chat.autoWatch.scheduleAutoWatchEvaluation(conversation.id, "participant-output");
    }
    return participantRequestsToRun;
  }

  logMissingSelectedSkillStatus(
    triggerMessage: ChatMessage,
    participant: ChatParticipant,
    pendingMessage: ChatMessage,
    runId: string
  ): void {
    const selectedSkills = chatSkillMentions(triggerMessage);
    if (selectedSkills.length === 0 || hasSelectedSkillFinalStatus(pendingMessage.content)) {
      return;
    }
    void this.deps.debugLogs.write("chat.skill.status_missing", {
      runId,
      triggerMessageId: triggerMessage.id,
      participantId: participant.id,
      participantHandle: participant.handle,
      messageId: pendingMessage.id,
      selectedSkills: selectedSkills.map((skill) => ({
        displayName: skill.displayName,
        frontmatterName: skill.frontmatterName
      }))
    });
  }

  applyCliRunMetadata(
    session: ChatParticipantSession,
    result: ParticipantRunResult,
    participant: ChatParticipant,
    warnings: string[],
    /** The chat says it another way when the session was started anew (a
     *  fork's line): no warning then. */
    restartSaid = false
  ): void {
    if (isKnownRoleRuntime(result.roleRuntime)) {
      session.roleRuntime = result.roleRuntime;
    }
    if (result.appMcpClientFailed) {
      session.sessionId = "";
      session.appMcpClientGeneration = (session.appMcpClientGeneration ?? 0) + 1;
      void this.deps.debugLogs.write("chat.app-mcp-client-invalidated", {
        participantId: participant.id,
        participantHandle: participant.handle,
        appMcpClientGeneration: session.appMcpClientGeneration
      });
    } else if (result.sessionId && !(session.forkFrom && result.sessionId === session.forkFrom.sessionId)) {
      session.sessionId = result.sessionId;
      delete session.forkFrom;
    }
    if (result.sessionRestarted && !restartSaid) {
      const warning = `@${participant.handle}: previous CLI session was unavailable, so a new session was started from saved chat context.`;
      if (!warnings.includes(warning)) {
        warnings.push(warning);
      }
    }
    for (const warning of result.warnings ?? []) {
      warnings.push(warning);
    }
  }

  createAgentProgressSink(
    runId: string,
    progress: ProgressCallback | undefined,
    participant: ChatParticipant,
    messageId: string,
    mobileEventId?: string
  ): {
    emit: (event: CliAgentOutputEvent) => void;
    beginAttempt: () => void;
    finish: () => void;
    activityEvents: () => ChatAgentActivityEvent[];
    processingTranscript: (capturedAt: string) => ChatProcessingTranscript | undefined;
  } {
    const participantLabel = `@${participant.handle}`;
    let finished = false;
    let cumulative = "";
    let activity: ChatActivityAccumulator = {
      events: [],
      sequence: 0,
      omittedCount: 0
    };
    let lastFlush = 0;
    let pendingTimer: NodeJS.Timeout | undefined;
    let dirty = false;
    const position = (): { contentLength: number; activitySequence: number } => ({
      contentLength: cumulative.length,
      activitySequence: activity.sequence
    });
    this.liveRunPositions.set(runId, position);

    const flush = (): void => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
      }
      if (finished || !dirty) {
        return;
      }
      dirty = false;
      lastFlush = Date.now();
      if (!progress) {
        return;
      }
      const partialContent = cumulative ? cumulative : undefined;
      emitProgress(runId, progress, "debate", `${participantLabel} is responding.`, {
        participantLabel,
        agentProgress: {
          participantId: participant.id,
          participantLabel,
          state: "running",
          messageId,
          activity: activity.label,
          activityEvents: activity.events,
          partialContent,
          ...(mobileEventId ? { mobileEventId } : {})
        }
      });
    };

    const scheduleFlush = (): void => {
      if (finished || pendingTimer) {
        return;
      }
      const throttleMs = CHAT_PROGRESS_FLUSH_INTERVAL_MS;
      const elapsed = Date.now() - lastFlush;
      if (elapsed >= throttleMs) {
        flush();
      } else {
        pendingTimer = setTimeout(flush, throttleMs - elapsed);
        pendingTimer.unref?.();
      }
    };

    const emitNow = (event: CliAgentOutputEvent): void => {
      if (finished) {
        return;
      }
      if (event.kind === "text") {
        const next = event.cumulative ?? cumulative + event.text;
        if (next === cumulative) {
          return;
        }
        cumulative = next;
        dirty = true;
        scheduleFlush();
        return;
      }
      const nextActivity = appendChatActivity(runId, activity, event, {
        afterContentLength: cumulative.length > 0 ? cumulative.length : undefined
      });
      if (nextActivity === activity) {
        return;
      }
      activity = nextActivity;
      dirty = true;
      // Tool/status transitions are observable states, not replaceable text.
      flush();
    };

    const beginAttempt = (): void => {
      if (finished) {
        return;
      }
      cumulative = "";
      activity = {
        events: [],
        sequence: 0,
        omittedCount: 0
      };
      // Emit a snapshot so the renderer clears any prior partial content on retry.
      dirty = true;
      flush();
    };

    const finish = (): void => {
      if (finished) {
        return;
      }
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
      }
      // Retain the final text/tool snapshot before the finished marker clears
      // live rendering; the machine channel must not lose the last short burst.
      flush();
      finished = true;
      if (this.liveRunPositions.get(runId) === position) {
        this.liveRunPositions.delete(runId);
      }
      if (!progress) {
        return;
      }
      emitProgress(runId, progress, "debate", `${participantLabel} finished.`, {
        participantLabel,
        agentProgress: {
          participantId: participant.id,
          participantLabel,
          state: "finished",
          messageId,
          ...(mobileEventId ? { mobileEventId } : {})
        }
      });
    };

    return {
      emit: emitNow,
      beginAttempt,
      finish,
      activityEvents: () => activity.events,
      processingTranscript: (capturedAt: string) => processingTranscriptFromContent(cumulative, capturedAt, {
        omittedActivityEventCount: activity.omittedCount
      })
    };
  }
}
