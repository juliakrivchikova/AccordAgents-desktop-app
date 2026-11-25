import type {
  ChatAppToolApproval, ChatMessage, ChatParticipant, ChatParticipantRequestBatch, ChatSelfCompactionMark, Conversation
} from "../../../../shared/types";
import { participantRequestVisibleRootId } from "../../../../shared/chatParticipantRequestThreads";
import { APP_CHAT_SEND_MESSAGE_TOOL } from "../../appMcp";
import { repliesOfRun, selfCompactionRequestMessage, selfCompactionResumeKey, selfCompactionResumeText } from "./compactionText";
import {
  furthestSelfCompactionMark, runIdBase, type SelfCompactionEnd, type SelfCompactionResume, selfCompactionResumeFrom,
  selfCompactionResumeRunId
} from "./selfCompactionMarks";
import { chatParticipants } from "../members/identity";
import { participantRequestResumeDepth } from "../requests/requestRecords";
import { createChatMessage } from "../store/messages";
import { emitChatRunFailure } from "../turns/replyMessages";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";
import { isSelfCompactionRequest } from "../approvals/approvalRecords";

/** The turn a member goes on with after its own compaction. */
export class SelfCompactionResumes {
  /** Turns members went on in after their own compaction, begun here. */
  readonly selfCompactionResumeRuns = new Set<string>();
  // --- going on after a member's own compaction -----------------------------

  /** Compactions members asked for here and did not go on from yet, by the
   *  run that asked: a member that asked to compact its own context ended its
   *  reply for it, and its next turn is asked by the app, so work goes on
   *  without the User (2026-11-25). `card`: it waits for her answer. */
  readonly selfCompactionResumes = new Map<string, { card: boolean }>();
  /** When the User last stopped something of a member's here. */
  private readonly memberStoppedAt = new Map<string, number>();
  /** How the work of replies that asked stands, as last said here: carried by
   *  every later save of the chat, so a reply whose own end is saved after it
   *  (with "waiting") has it too. */
  readonly selfCompactionMarks = new Map<string, Map<string, { participantId: string; runId: string; mark: ChatSelfCompactionMark }>>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "appQuit" | "chatHistory" | "host" | "participantRequests" | "pendingReplies" | "promptContext"
      | "selfCompaction" | "store" | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "onReviewProgress">
  ) {}

  openSelfCompactionResume(conversationId: string, participantId: string, runId: string, card: boolean): void {
    this.selfCompactionResumes.set(selfCompactionResumeKey(conversationId, participantId, runId), { card });
  }

  /** The mark a reply takes as it ends: its member goes on after it. A Stop
   *  of the reply ends what it asked for while that is only a card. */
  selfCompactionMarkFor(conversationId: string, participantId: string, runId: string, stopped: boolean): ChatSelfCompactionMark | undefined {
    const key = selfCompactionResumeKey(conversationId, participantId, runId);
    const open = this.selfCompactionResumes.get(key);
    if (!open) return undefined;
    if (stopped) {
      if (open.card) this.selfCompactionResumes.delete(key);
      return undefined;
    }
    return { state: open.card ? "card" : "waiting" };
  }

  /** Writes on the reply that asked how its work stands now. */
  async markSelfCompaction(conversationId: string, participantId: string, runId: string, mark: ChatSelfCompactionMark): Promise<void> {
    this.noteSelfCompactionMark(conversationId, participantId, runId, mark);
    const conversation = await this.chat.store.requireChat(conversationId).catch(() => undefined);
    if (!conversation) return;
    await this.chat.store.withChatMutation(conversation, async () => {
      if (!this.withSelfCompactionMarks(conversation)) return;
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
    });
  }

  private noteSelfCompactionMark(conversationId: string, participantId: string, runId: string, mark: ChatSelfCompactionMark): void {
    const marks = this.selfCompactionMarks.get(conversationId) ?? new Map();
    const key = `${participantId}\u0000${runIdBase(runId)}`;
    const before = marks.get(key)?.mark;
    // Gone on, and it came to nothing: both are said.
    const next = before?.state === "resumed" && mark.reason ? { ...mark, state: "resumed" as const } : furthestSelfCompactionMark(mark, before)!;
    marks.delete(key);
    marks.set(key, { participantId, runId, mark: next });
    this.selfCompactionMarks.delete(conversationId);
    this.selfCompactionMarks.set(conversationId, marks);
    while (this.selfCompactionMarks.size > 200) {
      this.selfCompactionMarks.delete(this.selfCompactionMarks.keys().next().value as string);
    }
  }

  /** Puts what was said here on the replies that asked; true when one changed. */
  withSelfCompactionMarks(conversation: Conversation): boolean {
    let changed = false;
    for (const { participantId, runId, mark } of this.selfCompactionMarks.get(conversation.id)?.values() ?? []) {
      for (const message of repliesOfRun(conversation, participantId, runId)) {
        const current = message.metadata?.selfCompaction;
        const next = current && furthestSelfCompactionMark(mark, current);
        if (!current || !next || (next.state === current.state && next.reason === current.reason)) continue;
        message.metadata = { ...message.metadata, selfCompaction: { ...next } };
        changed = true;
      }
    }
    return changed;
  }

  /** Nobody goes on from this run's compaction. */
  async endSelfCompaction(
    conversationId: string,
    participantId: string,
    runId: string,
    reason: NonNullable<ChatSelfCompactionMark["reason"]>,
    error?: string
  ): Promise<void> {
    this.selfCompactionResumes.delete(selfCompactionResumeKey(conversationId, participantId, runId));
    void this.deps.debugLogs.write("chat.self-compaction.not-resumed", { conversationId, participantId, askingRunId: runId, reason, ...(error ? { message: error } : {}) });
    await this.markSelfCompaction(conversationId, participantId, runId, { state: "ended", reason, ...(error ? { error } : {}) }).catch((markError) => {
      void this.deps.debugLogs.write("chat.self-compaction.mark-error", { conversationId, participantId, message: markError instanceof Error ? markError.message : String(markError) });
    });
  }

  /** The User answered a member's compaction card, and it was not compacted
   *  from it. */
  continueFromCompactionCard(conversationId: string, approval: ChatAppToolApproval, end: SelfCompactionEnd): void {
    const asked = selfCompactionResumeFrom(approval.resumeContext);
    if (!asked) return;
    const resume: SelfCompactionResume = { ...asked, since: new Date().toISOString() };
    const instructions = isSelfCompactionRequest(approval.request) ? approval.request.instructions : undefined;
    void this.continueAfterSelfCompaction(conversationId, approval.requesterParticipantId, resume, end, instructions, approval.createdAt);
  }

  /**
   * Calls a member again after the compaction it asked for ended: compacted,
   * failed, or declined on its card. Once per asking run. Not after a Stop of
   * anything of the member's since (the turn that asked, the compaction, what
   * the User sent meanwhile), not in an archived chat, and not while the app
   * quits. `cardRaisedAt` (its card answered with no compaction): a member
   * that had another turn since went on already.
   */
  async continueAfterSelfCompaction(
    conversationId: string,
    participantId: string,
    resume: SelfCompactionResume,
    end: SelfCompactionEnd,
    instructions: string | undefined,
    cardRaisedAt?: string
  ): Promise<void> {
    const runId = selfCompactionResumeRunId(resume.runId);
    if (this.selfCompactionResumeRuns.has(runId)) return;
    this.selfCompactionResumeRuns.add(runId);
    while (this.selfCompactionResumeRuns.size > 1_000) {
      this.selfCompactionResumeRuns.delete(this.selfCompactionResumeRuns.values().next().value as string);
    }
    // Known until it goes on: an asking reply still running says so as it ends.
    this.openSelfCompactionResume(conversationId, participantId, resume.runId, false);
    try {
      const ended = await this.runAfterSelfCompaction(conversationId, participantId, resume, runId, end, instructions, cardRaisedAt);
      if (ended) await this.endSelfCompaction(conversationId, participantId, resume.runId, ended);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.debugLogs.write("chat.self-compaction.resume-error", { conversationId, participantId, askingRunId: resume.runId, message });
      // Stopped while it waited to be taken: no reply says so.
      await this.endSelfCompaction(conversationId, participantId, resume.runId, message === "Chat run cancelled." ? (this.chat.appQuit.quitting ? "interrupted" : "stopped") : "failed", message);
    }
  }

  /** The turn itself; why it did not start when it did not. */
  private async runAfterSelfCompaction(
    conversationId: string,
    participantId: string,
    resume: SelfCompactionResume,
    runId: string,
    end: SelfCompactionEnd,
    instructions: string | undefined,
    cardRaisedAt: string | undefined
  ): Promise<NonNullable<ChatSelfCompactionMark["reason"]> | undefined> {
    const progress = this.deps.onReviewProgress;
    // Behind the turn that asked (a card can be answered while it still runs)
    // and whatever the User sent meanwhile. Her next message joins it as it
    // joins a turn of her own, unless it answers another member's request,
    // as the turn it goes on from did.
    const before = this.chat.store.lastSavedSnapshots.get(conversationId)?.snapshot ?? await this.chat.store.requireChat(conversationId);
    const asksIn = selfCompactionRequestMessage(before, resume)?.metadata?.participantRequest;
    const answersRequest = asksIn?.items.some((item) => item.targetParticipantId === participantId) === true;
    const reservation = this.chat.turnQueue.reserveParticipantTurn(conversationId, participantId, answersRequest ? "exclusive" : "following");
    let handedOff = false;
    try {
      await reservation.wait();
      await this.chat.selfCompaction.askingReplyEnded(conversationId, participantId, resume.runId);
      const ingest = await this.chat.activeRuns.withChatRunLock(conversationId, async () => {
        const conversation = await this.chat.store.requireChat(conversationId);
        // Decided on the chat as saved now, behind whatever its queue holds (a
        // stopped reply's own save).
        const begun = await this.chat.store.withChatMutation(conversation, async (): Promise<NonNullable<ChatSelfCompactionMark["reason"]> | { participant: ChatParticipant; event: ChatMessage; batch: ChatParticipantRequestBatch | undefined }> => {
          if (this.chat.appQuit.quitting) return "interrupted";
          const participant = chatParticipants(conversation).find((item) => item.id === participantId);
          // It left, or (a machine's) it moved: its new device takes its turns.
          if (!participant || conversation.metadata.archived === true || (this.chat.host.machineRuntime && !this.chat.host.runsHere(participant))) return "not-continued";
          if (this.chat.selfCompaction.selfCompactionsCancelled.has(runId) || this.memberStoppedSince(conversation, participantId, resume)) return "stopped";
          const asked = repliesOfRun(conversation, participantId, resume.runId);
          if (cardRaisedAt && conversation.messages.some((message) => message.role === "participant" && message.participantId === participantId &&
            message.createdAt > cardRaisedAt && !asked.includes(message) && message.metadata?.appMessageSource !== APP_CHAT_SEND_MESSAGE_TOOL)) {
            return "not-continued";
          }
          const trigger = conversation.messages.find((message) => message.id === resume.triggerMessageId);
          const requestMessage = selfCompactionRequestMessage(conversation, resume);
          const requestRootId = requestMessage ? participantRequestVisibleRootId(conversation.messages, requestMessage) : undefined;
          const event = createChatMessage("system", selfCompactionResumeText(participant, end, instructions), undefined, trigger
            ? {
                threadId: trigger.metadata?.threadId ?? trigger.id,
                parentMessageId: trigger.id,
                chatThreadRootId: requestRootId ?? trigger.metadata?.chatThreadRootId,
                sourceMessageId: trigger.id
              }
            : undefined);
          conversation.messages.push(event);
          this.noteSelfCompactionMark(conversationId, participantId, resume.runId, { state: "resumed" });
          conversation.updatedAt = new Date().toISOString();
          await this.chat.store.saveConversation(conversation);
          return { participant, event, batch: requestMessage?.metadata?.participantRequest };
        });
        if (typeof begun === "string") return begun;
        await this.chat.activeRuns.beginChatRun(conversation, runId, [begun.participant.id]);
        return { conversation, ...begun };
      });
      if (typeof ingest === "string") return ingest;
      this.selfCompactionResumes.delete(selfCompactionResumeKey(conversationId, participantId, resume.runId));
      const { conversation, participant, event, batch } = ingest;
      void this.deps.debugLogs.write("chat.self-compaction.resumed", { conversationId, participantId, askingRunId: resume.runId, runId, end: end.kind });
      // Her message sent as this turn starts is written to the CLI after it.
      const writeGate = participant.kind === "claude-code" ? this.chat.promptContext.openClaudeWriteGate(conversationId, participantId) : undefined;
      try {
        handedOff = true;
        const messages = await this.chat.turnQueue.runParticipantTurnSerialized(conversation, participant, event, runId, undefined, progress, {
          continuation: true,
          warnings: [],
          turnReservation: reservation,
          ...(writeGate ? { writeGate } : {}),
          participantRequestDepth: batch ? participantRequestResumeDepth(batch, participant.id) : undefined,
          participantRequestBatchId: batch?.id,
          chainRootId: batch?.chainRootId
        });
        const participantRequestsToRun = await this.chat.store.withChatMutation(conversation, async () => {
          const toRun = await this.chat.pendingReplies.appendParticipantTurnMessages(conversation, participant, messages);
          conversation.updatedAt = new Date().toISOString();
          this.chat.store.queueSnapshot(conversation);
          return toRun;
        });
        this.chat.participantRequests.startDeferredParticipantRequestRunners(conversation.id, participantRequestsToRun);
        await this.chat.chatHistory.ensureHistoryFiles(conversation);
        // Stopped on the server before anyone took it: it has no reply.
        return messages.length > 0 ? undefined : "stopped";
      } catch (error) {
        emitChatRunFailure(runId, progress, error);
        throw error;
      } finally {
        writeGate?.markWritten();
        await this.chat.activeRuns.endChatRun(conversation, runId);
      }
    } finally {
      if (!handedOff) reservation.release();
    }
  }

  /** Whether the User stopped the turn that asked to compact, or anything of
   *  the member's since: the work it would go on with waits for her. */
  private memberStoppedSince(conversation: Conversation, participantId: string, resume: SelfCompactionResume): boolean {
    const asked = repliesOfRun(conversation, participantId, resume.runId);
    const since = resume.since ?? asked[0]?.createdAt;
    const stoppedAt = this.memberStoppedAt.get(`${conversation.id}\u0000${participantId}`);
    if (stoppedAt !== undefined && since !== undefined && stoppedAt >= Date.parse(since)) return true;
    return conversation.messages.some((message) => message.role === "participant" && message.participantId === participantId &&
      (message.metadata?.terminalReason === "user-stopped" || message.metadata?.terminalReason === "stop-unconfirmed") &&
      (asked.includes(message) || (since !== undefined && message.createdAt >= since)));
  }

  /** `at`: when it was stopped (a turn the server tells again keeps its time). */
  noteMemberStopped(conversationId: string, participantId: string, at = Date.now()): void {
    const key = `${conversationId}\u0000${participantId}`;
    if (!Number.isFinite(at) || at <= (this.memberStoppedAt.get(key) ?? 0)) return;
    this.memberStoppedAt.delete(key);
    this.memberStoppedAt.set(key, at);
    while (this.memberStoppedAt.size > 1_000) this.memberStoppedAt.delete(this.memberStoppedAt.keys().next().value as string);
  }
}
