import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatParticipant, ChatParticipantRequestBatch, Conversation } from "../../../../shared/types";
import { participantRequestVisibleRootId } from "../../../../shared/chatParticipantRequestThreads";
import { PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION } from "../constants";
import { chatParticipants } from "../members/identity";
import { delegationGroupResumeText, delegationTurnGroup, turnSegmentKey } from "./delegationGroups";
import { markOwnRequestResumeEnded, requestWaitingOnOwnRequest } from "./ownRequests";
import {
  markParticipantRequestAutoResumeFailed, participantRequestBatchRequesterDepth, participantRequestHasUnfinishedItems,
  updateParticipantRequestBatch
} from "./requestRecords";
import { createChatMessage } from "../store/messages";
import { emitChatRunFailure } from "../turns/replyMessages";
import type { ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** The turn that gives a requester its answers back. */
export class RequesterResumes {
  readonly participantRequestAutoResumes = new Set<string>();
  /** Requests asked to resume while a look at them was under way. */
  private readonly autoResumeRechecks = new Set<string>();
  /** Groups of the main session's tasks being resumed now, by chat and turn. */
  readonly delegationGroupResumes = new Set<string>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "appQuit" | "chatHistory" | "delegation" | "host" | "participantRequests" | "pendingReplies" | "store"
      | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "onReviewProgress">
  ) {}

  /** `groupCheck`: a look at the main session's tasks of one turn after
   *  their turn ended or a restart ended one of them; it goes ahead while a
   *  look at the same request is under way (the tasks' own guard, under the
   *  chat's run lock, keeps it to one resume). */
  async autoResumeParticipantRequest(
    conversationId: string,
    requestMessageId: string,
    progress?: ProgressCallback,
    options: { groupCheck?: boolean } = {}
  ): Promise<void> {
    const resumeProgress = progress ?? this.deps.onReviewProgress;
    // Quitting: the requester is resumed at the next start (its recovery,
    // requesterResumeRecoveryKey: the main session's tasks and requests made
    // with app_chat_request_participants; an inferred request is not), or
    // once the quit turns out not to happen (endQuit).
    if (this.chat.appQuit.quitting) {
      this.chat.appQuit.resumesSkippedWhileQuitting.set(requestMessageId, { conversationId, options });
      void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId, "quitting");
      return;
    }
    const ownsEntry = !this.participantRequestAutoResumes.has(requestMessageId);
    if (!ownsEntry && !options.groupCheck) {
      // The look under way may have read it unfinished a moment before it
      // ended: it looks again when it is done (a request that went out with
      // another ends when that one does).
      this.autoResumeRechecks.add(requestMessageId);
      void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId, "already-auto-resuming");
      return;
    }
    if (ownsEntry) this.participantRequestAutoResumes.add(requestMessageId);
    let backgroundStarted = false;
    let claimedGroupKey: string | undefined;
    // The requests that went out in one turn with this one ended with it
    // (settleRequestsAnsweredWith): their requesters are resumed too.
    let answeredWith: string[] = [];
    try {
      const ingest = await this.chat.activeRuns.withChatRunLock(conversationId, async () => {
        // Read as saved: a task of the same turn that ended a moment ago
        // must be seen ended.
        await this.chat.store.waitForQueuedSave(conversationId);
        const conversation = await this.chat.store.requireChat(conversationId);
        answeredWith = conversation.messages.filter((message) => message.metadata?.participantRequest?.items
          .some((item) => item.answeredWith?.requestMessageId === requestMessageId)).map((message) => message.id);
        const requestMessage = conversation.messages.find((message) => message.id === requestMessageId);
        const batch = requestMessage?.metadata?.participantRequest;
        if (!requestMessage || !batch) {
          void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId, "missing-request-message-or-batch");
          return;
        }
        if (!batch.resumeRequester) {
          void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId, "resume-requester-false", batch);
          return;
        }
        if (batch.completedInToolCall) {
          void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId, "completed-in-tool-call", batch);
          return;
        }
        if (!ownsEntry && !batch.delegation?.turnId) {
          void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId, "already-auto-resuming", batch);
          return;
        }
        // The main session's tasks of one turn resume it once, when the turn
        // is over and all of them have ended; any other request on its own.
        if (batch.autoResumeMessageId) {
          void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId, "already-auto-resumed", batch);
          return;
        }
        const group = delegationTurnGroup(conversation, requestMessage, batch);
        const groupKey = batch.delegation?.turnId ? turnSegmentKey(conversationId, batch.delegation.turnId) : undefined;
        if (groupKey && (this.delegationGroupResumes.has(groupKey) || (group.length > 1 && group.some((entry) => entry.batch.status === "resuming_requester")))) {
          void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId, "already-auto-resuming", batch);
          return;
        }
        if (groupKey && this.chat.delegation.liveTurnSegments.has(groupKey)) {
          void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId, "delegating-turn-running", batch);
          return;
        }
        const unfinished = group.find((entry) => participantRequestHasUnfinishedItems(entry.batch));
        if (unfinished) {
          void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId,
            unfinished.message.id === requestMessageId ? "unfinished-items" : "waiting-for-tasks-of-the-same-turn", batch);
          return;
        }
        const items = group.flatMap((entry) => entry.batch.items);
        // A request a member made while it answers another, and that the one
        // it answers waits on (ownRequests.ts), resumes it even when every
        // target was declined: its answer comes from that turn.
        const allDenied = items.length > 0 && items.every((item) => item.status === "denied");
        const answeringRequest = allDenied && group.some((entry) => requestWaitingOnOwnRequest(conversation, entry.message));
        if (allDenied && !answeringRequest) {
          void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId, "all-items-denied", batch);
          return;
        }
        // The main session's tasks that only a restart ended
        // (markOrphanedParticipantRequestInterrupted) do not wake it. A request
        // made with app_chat_request_participants does, with the interruption:
        // its requester waits for that answer and has no other way back to it.
        if (batch.delegation && items.length > 0 &&
          items.every((item) => item.status === "interrupted" && item.error === PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION)) {
          void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId, "all-items-interrupted-before-completion", batch);
          // Not resumed: a request its turn answered, waiting on these, ends
          // as the restart ended them, wherever it is waited on.
          const asker = chatParticipants(conversation).find((participant) => participant.id === batch.requesterParticipantId);
          // Only its own device writes it (it is its requester's request).
          if (asker && this.chat.host.ownsParticipant(asker)) await this.chat.store.withChatMutation(conversation, async () => {
            const marked = group.map((entry) => markOwnRequestResumeEnded(conversation, entry.message.id, "not-made")).some(Boolean);
            if (!marked) return;
            conversation.updatedAt = new Date().toISOString();
            this.chat.store.queueSnapshot(conversation);
          });
          return;
        }
        const requester = chatParticipants(conversation).find((participant) => participant.id === batch.requesterParticipantId);
        if (!requester || !this.chat.host.ownsParticipant(requester)) {
          void this.logParticipantRequestAutoResumeSkipped(conversationId, requestMessageId,
            requester ? "requester-owned-elsewhere" : "requester-missing", batch);
          return;
        }
        if (groupKey) {
          this.delegationGroupResumes.add(groupKey);
          claimedGroupKey = groupKey;
        }
        const now = new Date().toISOString();
        for (const entry of group) {
          updateParticipantRequestBatch(conversation, entry.message.id, (current) => ({
            ...current,
            status: "resuming_requester",
            updatedAt: now
          }));
        }
        const first = group[0]!.message;
        const participantRequestRootId = participantRequestVisibleRootId(conversation.messages, first);
        const trigger = createChatMessage(
          "system",
          // The main session's tasks always come back as a list of each task
          // and how it ended (stopped, failed, answered), one task too.
          group.length > 1 || batch.delegation
            ? delegationGroupResumeText(conversation, requester, group)
            : [
                `Auto-resumed @${requester.handle} after member request.`,
                "Target replies/errors are in the transcript above. Continue from your request using the available answers and errors.",
                // A reply cut short (for a message delivered now, a Stop) may
                // hold no words at all: why it ended is said here.
                ...batch.items.filter((item) => item.status === "interrupted" && item.error).map((item) => `@${item.targetHandle}: ${item.error}`),
                // Declined, it was resumed only because a request waits on its answer.
                ...(answeringRequest ? batch.items.filter((item) => item.status === "denied").map((item) => `@${item.targetHandle}: User declined this request; it was not asked.`) : [])
              ].join("\n"),
          undefined,
          {
            threadId: first.metadata?.threadId ?? first.id,
            parentMessageId: first.id,
            chatThreadRootId: participantRequestRootId,
            sourceMessageId: first.id
          }
        );
        conversation.messages.push(trigger);
        const resumeRunId = randomUUID();
        await this.chat.activeRuns.beginChatRun(conversation, resumeRunId, [requester.id]);
        // The replies of the other tasks are not in the first one's thread:
        // the turn reads them as well, and what a member wrote before it went
        // on after a compaction of its own, and a reply in another request's
        // thread (it answered requests that went out together in one turn).
        const compacted = group.some((entry) => entry.batch.items.some((item) => item.earlierReplyMessageIds?.length));
        const answeredElsewhere = group.some((entry) => entry.batch.items.some((item) => item.answeredWith));
        const extraPromptContextMessageIds = group.length > 1 || compacted || answeredElsewhere
          ? group.flatMap((entry) => entry.batch.items.flatMap((item) => [...(item.earlierReplyMessageIds ?? []), ...(item.replyMessageId ? [item.replyMessageId] : [])]))
          : undefined;
        if (group.length > 1) {
          void this.deps.debugLogs.write("chat.participant-request.auto-resume.group", {
            conversationId,
            requestMessageIds: group.map((entry) => entry.message.id),
            turnId: batch.delegation?.turnId
          });
        }
        return {
          conversation,
          requestMessageIds: group.map((entry) => entry.message.id),
          batch: group[0]!.batch,
          requester,
          trigger,
          resumeRunId,
          extraPromptContextMessageIds
        };
      });

      if (!ingest) {
        return;
      }
      backgroundStarted = true;
      void this.runParticipantRequestAutoResumeFlow(
        ingest.conversation,
        ingest.requestMessageIds,
        ingest.batch,
        ingest.requester,
        ingest.trigger,
        ingest.resumeRunId,
        resumeProgress,
        ingest.extraPromptContextMessageIds
      )
        .catch((error) => {
          void this.deps.debugLogs.write("chat.participant-request.auto-resume.error", {
            conversationId,
            requestMessageId,
            message: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          if (ownsEntry) {
            this.participantRequestAutoResumes.delete(requestMessageId);
            this.autoResumeRechecks.delete(requestMessageId);
          }
          if (claimedGroupKey) this.delegationGroupResumes.delete(claimedGroupKey);
        });
    } finally {
      if (!backgroundStarted) {
        if (ownsEntry) this.participantRequestAutoResumes.delete(requestMessageId);
        if (claimedGroupKey) this.delegationGroupResumes.delete(claimedGroupKey);
      }
      if (ownsEntry && this.autoResumeRechecks.delete(requestMessageId) && !backgroundStarted) {
        void this.autoResumeParticipantRequest(conversationId, requestMessageId, resumeProgress, options).catch(() => undefined);
      }
      for (const linked of answeredWith) {
        void this.autoResumeParticipantRequest(conversationId, linked, resumeProgress).catch(() => undefined);
      }
    }
  }

  private async logParticipantRequestAutoResumeSkipped(
    conversationId: string,
    requestMessageId: string,
    reason: string,
    batch?: ChatParticipantRequestBatch
  ): Promise<void> {
    await this.deps.debugLogs.write("chat.participant-request.auto-resume.skipped", {
      conversationId,
      requestMessageId,
      batchId: batch?.id,
      reason
    });
  }

  private async runParticipantRequestAutoResumeFlow(
    conversation: Conversation,
    requestMessageIds: readonly string[],
    batch: ChatParticipantRequestBatch,
    requester: ChatParticipant,
    trigger: ChatMessage,
    resumeRunId: string,
    progress?: ProgressCallback,
    extraPromptContextMessageIds?: readonly string[]
  ): Promise<void> {
    // Its turn ran and was recorded: what fails after it is not its resume's.
    let resumeRecorded = false;
    try {
      const messages = await this.chat.turnQueue.runParticipantTurnSerialized(conversation, requester, trigger, resumeRunId, undefined, progress, {
        continuation: true,
        warnings: [],
        participantRequestDepth: participantRequestBatchRequesterDepth(batch),
        participantRequestBatchId: batch.id,
        chainRootId: batch.chainRootId,
        ...(extraPromptContextMessageIds?.length ? { extraPromptContextMessageIds } : {})
      });
      const stoppedBeforeStart = this.chat.turnQueue.takeStoppedBeforeStart(resumeRunId);
      const participantRequestsToRun = await this.chat.store.withChatMutation(conversation, async () => {
        const toRun = await this.chat.pendingReplies.appendParticipantTurnMessages(conversation, requester, messages);
        const now = new Date().toISOString();
        for (const requestMessageId of requestMessageIds) {
          updateParticipantRequestBatch(conversation, requestMessageId, (current) => ({
            ...current,
            status: "completed",
            autoResumeMessageId: messages[0]?.id,
            // Its turn was stopped on the User's server before it began: a
            // request waiting on this requester's answer ends with it
            // (ownRequests.ts). One the server gave another device is not.
            ...(!messages[0] && stoppedBeforeStart ? { requesterResumeEnded: { reason: "stopped" as const, at: now } } : {}),
            updatedAt: now
          }));
        }
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
        return toRun;
      });
      resumeRecorded = true;
      this.chat.participantRequests.startDeferredParticipantRequestRunners(conversation.id, participantRequestsToRun);
      await this.chat.chatHistory.ensureHistoryFiles(conversation);
    } catch (error) {
      // Cut by the app's quit: the next start weighs it (a resume a quit
      // cut short), as for a member's own compaction (selfCompactionResumes).
      // Stopped while it waited its turn (TurnQueue: "Chat run cancelled."):
      // a request waiting on this requester's answer ends stopped.
      if (!this.chat.appQuit.quitting && !resumeRecorded) {
        const stopped = error instanceof Error && (error.message === "Chat run cancelled." || error.name === "AbortError");
        await this.chat.store.withChatMutation(conversation, async () => {
          for (const requestMessageId of requestMessageIds) {
            markParticipantRequestAutoResumeFailed(conversation, requestMessageId, error, stopped);
          }
          this.chat.store.queueSnapshot(conversation);
        }).catch((markError: unknown) => {
          void this.deps.debugLogs.write("chat.participant-request.auto-resume.mark-failed", {
            conversationId: conversation.id,
            requestMessageIds: [...requestMessageIds],
            message: markError instanceof Error ? markError.message : String(markError)
          });
        });
      }
      emitChatRunFailure(resumeRunId, progress, error);
      throw error;
    } finally {
      await this.chat.activeRuns.endChatRun(conversation, resumeRunId);
    }
  }

  /** The main session's turn that gave tasks is over: once all of them have
   *  ended it is resumed now, with every answer (autoResumeParticipantRequest
   *  waits for the rest otherwise). */
  resumeDelegationsOfEndedTurn(liveTurnKey: string): void {
    const delegating = this.chat.delegation.delegatingTurns.get(liveTurnKey);
    if (!delegating) return;
    this.chat.delegation.delegatingTurns.delete(liveTurnKey);
    void this.autoResumeParticipantRequest(delegating.conversationId, delegating.requestMessageId, this.deps.onReviewProgress, { groupCheck: true }).catch((error) => {
      void this.deps.debugLogs.write("chat.participant-request.auto-resume.error", {
        conversationId: delegating.conversationId,
        requestMessageId: delegating.requestMessageId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }
}
