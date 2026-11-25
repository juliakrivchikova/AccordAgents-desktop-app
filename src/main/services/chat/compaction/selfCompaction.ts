import { randomUUID } from "node:crypto";
import { newOpId } from "../../chatServerOps";
import type { HubTurn } from "../../../../shared/hubOps";
import type {
  ChatMessage, ChatParticipant, ChatParticipantRequestStatus, ChatSelfCompactionRequest, Conversation
} from "../../../../shared/types";
import { normalizeChatParticipantRequestPermission, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { hasChatAppToolCapability } from "../../../../shared/appTools";
import { APP_CHAT_REQUEST_COMPACTION_TOOL } from "../../appMcp";
import { APP_TOOL_PERMISSION_WAIT_MS } from "../../../../shared/appMcpToolContracts";
import { readParticipantCompactions } from "../../../../shared/chatRunState";
import { hasPendingPermissionApprovalForParticipantTurn, newAppToolApproval, upsertAppToolApproval } from "../approvals/approvalRecords";
import {
  compactionAnchor, compactionFailureLine, compactMessageMetadata, normalizeSelfCompactionRequest, pendingCompactionCard,
  recordSelfCompactionRequested, repliesOfRun, selfCompactionRequestGuard, selfCompactionResumeKey
} from "./compactionText";
import { agentContextUsageByParticipant, updateParticipantContextUsage } from "./contextUsage";
import {
  runIdBase, type SelfCompactedAnswer, type SelfCompactionEnd, type SelfCompactionResume, selfCompactionResumeFrom,
  selfCompactionResumeRunId
} from "./selfCompactionMarks";
import { PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION, PARTICIPANT_REQUEST_STOPPED_BY_USER } from "../constants";
import { chatParticipants, participantForRun } from "../members/identity";
import { rollupParticipantRequestStatus, updateParticipantRequestBatch } from "../requests/requestRecords";
import { createChatMessage } from "../store/messages";
import type { ChatAppMcpActor } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** What a member that asked to compact its own context does next, in the
 *  tool's answer: end its reply; the app calls it again. */
const SELF_COMPACTION_QUEUED_NEXT = "Say in this reply what is done and what comes next, then end it: the compaction runs right after, and the app calls you again to go on. Nobody has to call you.";

const SELF_COMPACTION_CARD_NEXT = "Say in this reply what is done and what comes next, then end it. Once User answers the card the app calls you again to go on, with your context compacted, or as it is if she declines.";

/** How long the turn a member goes on in waits for the reply that asked to be
 *  written as ended (its turn is over by then). */
const SELF_COMPACTION_REPLY_WAIT_MS = 10_000;

/** How often a wait for a member to go on looks again with nothing saved. */
const SELF_COMPACTION_LOOK_AGAIN_MS = 60_000;

/** A member's compaction card holds the answer its requester waits for as
 *  long as a permission card holds a turn (APP_TOOL_PERMISSION_WAIT_MS). */
const SELF_COMPACTION_CARD_WAIT_MS = APP_TOOL_PERMISSION_WAIT_MS;

/** Compactions a member asks for itself. */
export class SelfCompaction {
  /** Chats looked through for replies a restart left waiting (recoverSelfCompactions). */
  private readonly selfCompactionsRecovered = new Set<string>();
  /** Compactions of machine members this desktop shows as runs while their
   *  machine compacts them (asked by the member itself, on its machine). */
  private readonly observedServerCompactions = new Set<string>();
  /** The server turn of each such compaction while this desktop shows it,
   *  by its run id (the same id the machine runs it under). */
  readonly observedCompactionTurns = new Map<string, HubTurn>();
  /** Turns members would have gone on in, stopped before they began. */
  readonly selfCompactionsCancelled = new Set<string>();
  /** The same for members that run on another device: their turn is stopped
   *  whenever the server tells of it. */
  readonly remoteSelfCompactionsStopped = new Set<string>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "appQuit" | "compaction" | "contextMeter" | "host" | "participantBatch" | "runCancel"
      | "selfCompactionResumes" | "serverLink" | "serverTurns" | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "onReviewProgress" | "storage">
  ) {}

  async requestSelfCompactionFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      return { ok: false, status: "rejected", error: "The requesting member is no longer in this chat." };
    }
    if (!hasChatAppToolCapability(actor.capabilities, "compaction.request")) {
      return { ok: false, status: "rejected", error: "This member is not allowed to request context compaction." };
    }
    const permission = normalizeChatParticipantRequestPermission(
      normalizeChatAgentPermissions(participantForRun(conversation, requester).permissions).requestCompaction
    );
    if (permission === "deny") {
      return { ok: false, status: "rejected", error: `Context compaction requests are disabled for @${requester.handle}.` };
    }
    const request = normalizeSelfCompactionRequest(rawRequest);
    const summary = `Compact @${requester.handle} context`;
    // A reply its CLI began on its own (background work finished) answers no
    // message: the member goes on from that reply.
    const resume = selfCompactionResumeFrom({
      ...actor,
      triggerMessageId: actor.triggerMessageId ?? (actor.runId ? repliesOfRun(conversation, requester.id, actor.runId)[0]?.id : undefined),
      since: new Date().toISOString()
    });
    // The card's meter: the member's context as it stands now. It asks in
    // the middle of its turn, so its session log (written as it goes) is
    // read again; the indicator's figure from its last finished turn stays
    // when the log cannot be read. The card carries the figure, the same on
    // every device.
    const liveUsage = await this.chat.contextMeter.liveContextUsage(conversation, requester);
    const contextPercentage = (liveUsage ?? agentContextUsageByParticipant(conversation)[requester.id])?.percentage;
    const cardRequest: ChatSelfCompactionRequest = contextPercentage === undefined ? request : { ...request, contextPercentage };
    // Checked and recorded on the chat as saved now, through the queue.
    let compactingRequester = requester;
    const decided = await this.chat.store.withChatMutation(conversation, async (): Promise<Record<string, unknown> | undefined> => {
      const requesterNow = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
      if (!requesterNow) {
        return { ok: false, status: "rejected", error: "The requesting member is no longer in this chat." };
      }
      compactingRequester = requesterNow;
      const permissionNow = normalizeChatParticipantRequestPermission(
        normalizeChatAgentPermissions(participantForRun(conversation, requesterNow).permissions).requestCompaction
      );
      if (permissionNow === "deny") {
        return { ok: false, status: "rejected", error: `Context compaction requests are disabled for @${requesterNow.handle}.` };
      }
      const guard = selfCompactionRequestGuard(conversation, requesterNow) ?? this.selfCompactionAnsweredInRun(actor.runId);
      if (guard) {
        return { ok: false, ...guard };
      }
      // The indicator shows what the card does.
      updateParticipantContextUsage(conversation, requesterNow.id, liveUsage);
      if (permissionNow === "ask") {
        const approval = newAppToolApproval(
          conversation,
          requesterNow,
          APP_CHAT_REQUEST_COMPACTION_TOOL,
          "compaction.request",
          cardRequest,
          summary,
          "pending"
        );
        // The turn that asked: her answer calls the member again to go on
        // from it (continueAfterSelfCompaction).
        if (resume?.triggerMessageId) {
          const { since: _asked, ...context } = resume;
          approval.resumeContext = { ...context, triggerMessageId: resume.triggerMessageId };
        }
        upsertAppToolApproval(conversation, approval);
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
        if (resume?.triggerMessageId) this.chat.selfCompactionResumes.openSelfCompactionResume(conversation.id, requesterNow.id, resume.runId, true);
        return {
          ok: true,
          status: "pending_user_approval",
          approvalId: approval.id,
          summary,
          ...(resume?.triggerMessageId ? { next: SELF_COMPACTION_CARD_NEXT } : {})
        };
      }
      recordSelfCompactionRequested(conversation, requesterNow.id, new Date().toISOString());
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
      return undefined;
    });
    if (decided) {
      return decided;
    }

    const runId = randomUUID();
    this.startQueuedSelfCompaction(conversation.id, compactingRequester, request, runId, resume);
    return {
      ok: true,
      status: "queued",
      runId,
      summary,
      ...(resume ? { next: SELF_COMPACTION_QUEUED_NEXT } : {})
    };
  }

  /** A member's answer to a request through the compactions of its own it
   *  makes in the middle of it: the last reply it wrote, what came of it and
   *  what it wrote before. */
  async answerThroughSelfCompactions(
    conversationId: string,
    participantId: string,
    first: ChatMessage,
    signal: AbortSignal | undefined
  ): Promise<{ answer: SelfCompactedAnswer; reply: ChatMessage; earlier: ChatMessage[] }> {
    const earlier: ChatMessage[] = [];
    let reply = first;
    let answer: SelfCompactedAnswer = { kind: "went-on", reply };
    while (answer.kind === "went-on" && reply.metadata?.selfCompaction && reply.metadata.runId && reply.metadata.terminalReason !== "user-stopped") {
      const asking = reply;
      answer = await this.selfCompactedAnswer(conversationId, participantId, asking, signal);
      if (answer.kind === "went-on") {
        earlier.push(asking);
        reply = answer.reply;
      }
    }
    return { answer, reply, earlier };
  }

  /** How a request's target ended after it compacted its own context in the
   *  middle of it. A permission card raised in the turn it went on in holds
   *  the item as one raised in its first turn does. */
  async settleSelfCompactedItem(
    conversation: Conversation,
    requestMessageId: string,
    batchId: string,
    target: ChatParticipant,
    { answer, reply, earlier }: { answer: SelfCompactedAnswer; reply: ChatMessage; earlier: readonly ChatMessage[] },
    /** The call that asked is over: the requester is resumed with it. */
    callIsOver = false
  ): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      const now = new Date().toISOString();
      const askedAs = reply.metadata?.sourceMessageId;
      const onPermissionCard = answer.kind === "went-on" && Boolean(askedAs) &&
        hasPendingPermissionApprovalForParticipantTurn(conversation, target, askedAs!, batchId);
      const stopped = answer.kind === "went-on" ? reply.metadata?.terminalReason === "user-stopped" : answer.reason === "stopped";
      const interrupted = answer.kind === "went-on" ? stopped && this.chat.appQuit.endsByQuit(reply.metadata?.runId) : answer.reason === "interrupted";
      const failed = answer.kind === "ended" ? answer.reason === "failed" : reply.status === "error";
      const status: ChatParticipantRequestStatus = onPermissionCard ? "running" : stopped || interrupted ? "interrupted" : failed ? "failed" : "answered";
      const error = status === "interrupted"
        ? interrupted ? PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION : PARTICIPANT_REQUEST_STOPPED_BY_USER
        : status === "failed" ? (answer.kind === "ended" ? answer.error : reply.content) || "It could not go on after its compaction." : undefined;
      updateParticipantRequestBatch(conversation, requestMessageId, (current) => {
        if (current.id !== batchId) return current;
        const items = current.items.map((candidate) => candidate.targetParticipantId === target.id
          ? {
              ...candidate,
              status,
              replyMessageId: reply.id,
              ...(earlier.length > 0 ? { earlierReplyMessageIds: earlier.map((message) => message.id) } : {}),
              error,
              updatedAt: now
            }
          : candidate);
        return {
          ...current,
          ...(callIsOver ? { completedInToolCall: false } : {}),
          items,
          status: rollupParticipantRequestStatus(items),
          updatedAt: now
        };
      });
      this.chat.store.queueSnapshot(conversation);
    });
  }

  /** A card of this very reply's that the User (or the app) already answered:
   *  the member is called again once it ends, so it is not asked again. */
  private selfCompactionAnsweredInRun(runId: string | undefined): { status: string; error: string } | undefined {
    if (!runId || !this.chat.selfCompactionResumes.selfCompactionResumeRuns.has(selfCompactionResumeRunId(runId))) return undefined;
    return { status: "declined", error: "Your request to compact was already answered in this reply. End it: the app calls you again to go on." };
  }

  startQueuedSelfCompaction(
    conversationId: string,
    participant: ChatParticipant,
    request: ChatSelfCompactionRequest,
    runId: string,
    resume: SelfCompactionResume | undefined
  ): void {
    // Known from here on: the asking reply says so as it ends, or (a card
    // answered after it) says now that it no longer waits for the User.
    if (resume) {
      this.chat.selfCompactionResumes.openSelfCompactionResume(conversationId, participant.id, resume.runId, false);
      void this.chat.selfCompactionResumes.markSelfCompaction(conversationId, participant.id, resume.runId, { state: "waiting" }).catch(() => undefined);
    }
    // A member on a machine asked for it there: it is a turn of that member
    // on the User's server, which this machine takes and runs like any other
    // (startServerTurn), and every other device sees and can stop.
    if (this.chat.host.machineRuntime && this.chat.serverLink.current) {
      void this.requestServerSelfCompaction(conversationId, participant, request, runId, resume).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.deps.debugLogs.write("chat.self-compaction.request-error", { conversationId, participantId: participant.id, runId, message });
        await this.recordSelfCompactionFailure(conversationId, participant, runId, request.instructions, message);
        if (resume) await this.chat.selfCompactionResumes.continueAfterSelfCompaction(conversationId, participant.id, resume, { kind: "failed", reason: message }, request.instructions);
      });
      return;
    }
    this.runQueuedSelfCompaction(conversationId, participant, request, runId, resume);
  }

  /** Machine side: a member's own compaction, asked on the server. */
  private async requestServerSelfCompaction(
    conversationId: string,
    participant: ChatParticipant,
    request: ChatSelfCompactionRequest,
    runId: string,
    resume: SelfCompactionResume | undefined
  ): Promise<void> {
    const link = this.chat.serverLink.current;
    if (!link) throw new Error("This machine is not linked to your server.");
    await this.chat.store.waitForQueuedSave(conversationId);
    const conversation = await this.chat.store.requireChat(conversationId);
    const anchor = compactionAnchor(conversation, {});
    if (!anchor) throw new Error("Nothing in this chat has reached your server yet");
    const serverRunId = runId.startsWith("turn-") ? runId : `turn-${runId}`;
    const opId = newOpId();
    await link.enqueue([{ opId, kind: "turn.request", conversationId, runId: serverRunId, messageId: anchor.id, participantId: participant.id,
      request: { kind: "compaction", triggeredBy: "agent", ...(request.instructions ? { instructions: request.instructions } : {}), ...(resume ? { resume: { ...resume } } : {}) } }]);
    const answer = await link.opAnswered(opId);
    if (answer.status === "rejected") throw new Error(answer.reason);
    void this.deps.debugLogs.write("chat.self-compaction.requested", { conversationId, participantId: participant.id, runId: serverRunId });
    if (resume) {
      // Stopped before this machine took it: nobody goes on from it.
      void this.chat.serverTurns.waitForServerTurn(serverRunId, (turn) => turn.state === "finished" || turn.state === "stopped").then((turn) => {
        if (turn.outcome === "interrupted") return this.chat.selfCompactionResumes.endSelfCompaction(conversationId, participant.id, resume.runId, "interrupted");
        if (turn.state === "stopped" || turn.outcome === "stopped") return this.chat.selfCompactionResumes.endSelfCompaction(conversationId, participant.id, resume.runId, "stopped");
        return undefined;
      });
    }
  }

  /** Desktop side: a compaction of a machine member that another device asked
   *  for (the member itself, on its machine, or the phone) is shown here as a
   *  run while that machine compacts it, with the same status line and Stop as
   *  one the User started here. Asked once per turn. */
  observeServerCompaction(turn: HubTurn): void {
    const link = this.chat.serverLink.current;
    if (this.chat.host.machineRuntime || !link || turn.request?.kind !== "compaction") return;
    if (turn.state !== "requested" && turn.state !== "claimed") return;
    if (turn.requestedBy === link.deviceId() || this.chat.serverTurns.inProcessServerTurns.has(turn.runId) || this.observedServerCompactions.has(turn.runId)) return;
    this.observedServerCompactions.add(turn.runId);
    if (this.observedServerCompactions.size > 1_000) {
      this.observedServerCompactions.delete(this.observedServerCompactions.values().next().value as string);
    }
    void (async () => {
      const opened = typeof this.deps.storage.openConversation === "function"
        ? (await this.deps.storage.openConversation(turn.conversationId, 1))?.conversation
        : await this.deps.storage.getConversation(turn.conversationId);
      if (!opened || opened.kind !== "chat") return;
      const participant = chatParticipants(opened).find((item) => item.id === turn.participantId);
      if (!participant || this.chat.host.runsHere(participant)) return;
      const request = turn.request ?? {};
      this.observedCompactionTurns.set(turn.runId, turn);
      const run = this.chat.participantBatch.registerBackgroundRunController(turn.runId, undefined);
      try {
        await this.chat.compaction.compactParticipant({
          conversationId: turn.conversationId,
          participantId: participant.id,
          runId: turn.runId,
          triggeredBy: request.triggeredBy === "agent" ? "agent" : "user",
          ...(typeof request.instructions === "string" ? { instructions: request.instructions } : {})
        }, run.signal, this.deps.onReviewProgress);
      } finally {
        run.cleanup();
        this.observedCompactionTurns.delete(turn.runId);
      }
    })().catch((error) => {
      void this.deps.debugLogs.write("chat.compaction.observe-error", { conversationId: turn.conversationId, runId: turn.runId, message: error instanceof Error ? error.message : String(error) });
    });
  }

  /** The line a member's own compaction that could not run leaves. */
  private async recordSelfCompactionFailure(conversationId: string, participant: ChatParticipant, runId: string, instructions: string | undefined, message: string): Promise<void> {
    const latest = await this.chat.store.requireChat(conversationId).catch(() => undefined);
    if (!latest) return;
    await this.chat.store.withChatMutation(latest, async () => {
      latest.messages.push(createChatMessage(
        "system",
        compactionFailureLine(participant.handle, message),
        undefined,
        {
          ...compactMessageMetadata({ runId, triggeredBy: "agent", instructions }, participant.id, "failed"),
          threadId: "system"
        }
      ));
      latest.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(latest);
      this.chat.store.queueSnapshot(latest);
    });
  }

  private runQueuedSelfCompaction(
    conversationId: string,
    participant: ChatParticipant,
    request: ChatSelfCompactionRequest,
    runId: string,
    resume: SelfCompactionResume | undefined
  ): void {
    const backgroundController = this.chat.participantBatch.registerBackgroundRunController(runId, undefined);
    let end: SelfCompactionEnd = { kind: "failed" };
    void this.chat.compaction.compactParticipant({
      conversationId,
      participantId: participant.id,
      instructions: request.instructions,
      triggeredBy: "agent",
      runId
    }, backgroundController.signal, this.deps.onReviewProgress, (ended) => { end = ended; }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      end = { kind: "failed", reason: message };
      await this.deps.debugLogs.write("chat.self-compaction.run.error", {
        conversationId,
        participantId: participant.id,
        runId,
        message
      });
      if (backgroundController.signal.aborted) {
        return;
      }
      await this.recordSelfCompactionFailure(conversationId, participant, runId, request.instructions, message);
    }).finally(() => {
      const stopped = backgroundController.signal.aborted;
      backgroundController.cleanup();
      if (!resume) return;
      // Stop ends it there: the member waits for the User.
      if (stopped) void this.chat.selfCompactionResumes.endSelfCompaction(conversationId, participant.id, resume.runId, this.chat.appQuit.quitting ? "interrupted" : "stopped");
      else void this.chat.selfCompactionResumes.continueAfterSelfCompaction(conversationId, participant.id, resume, end, request.instructions);
    });
  }

  /** The reply of the run that asked is written as ended (its turn is over
   *  here before its reply is stored): a Stop of it is seen. */
  async askingReplyEnded(conversationId: string, participantId: string, runId: string): Promise<void> {
    const deadline = Date.now() + SELF_COMPACTION_REPLY_WAIT_MS;
    const read = async (): Promise<Conversation> => this.chat.store.lastSavedSnapshots.get(conversationId)?.snapshot ?? await this.chat.store.requireChat(conversationId);
    let conversation = await read();
    while (Date.now() < deadline && !this.chat.appQuit.quitting && repliesOfRun(conversation, participantId, runId).some((message) => message.status === "pending")) {
      conversation = await this.chat.store.nextChatSave(conversationId, Math.max(1, deadline - Date.now()), undefined) ?? await read();
    }
  }

  /** A compaction turn of this run's that ended on the server with nobody to
   *  go on from it (its machine was stopped or lost it). */
  private selfCompactionTurnLost(conversationId: string, participantId: string, runId: string): "stopped" | "interrupted" | undefined {
    const base = runIdBase(runId);
    for (const turn of this.chat.serverTurns.serverTurnStates.values()) {
      if (turn.conversationId !== conversationId || turn.participantId !== participantId || turn.request?.kind !== "compaction") continue;
      const asked = selfCompactionResumeFrom(turn.request.resume);
      if (!asked || runIdBase(asked.runId) !== base) continue;
      if (turn.outcome === "interrupted") return "interrupted";
      if (turn.state === "stopped" || turn.outcome === "stopped") return "stopped";
    }
    return undefined;
  }

  /**
   * A member's answer is not the reply that asked to compact but the one it
   * goes on to: waits for it, wherever the member runs (its device writes on
   * the reply how its work stands). Her card holds it as long as a permission
   * card holds a turn. Aborted: what it waits for is stopped too.
   */
  private async selfCompactedAnswer(
    conversationId: string,
    participantId: string,
    askingReply: ChatMessage,
    signal: AbortSignal | undefined
  ): Promise<SelfCompactedAnswer> {
    const askingRunId = askingReply.metadata!.runId!;
    const resumeRunId = selfCompactionResumeRunId(askingRunId);
    let cardEnds: number | undefined;
    let conversation = await this.chat.store.requireChat(conversationId);
    for (;;) {
      if (signal?.aborted) {
        await this.stopSelfCompaction(conversation, participantId, askingRunId);
        return { kind: "ended", reason: this.chat.appQuit.quitting ? "interrupted" : "stopped" };
      }
      const reply = repliesOfRun(conversation, participantId, resumeRunId).filter((message) => message.status !== "pending" && !message.metadata?.serverPlaceholder).at(-1);
      if (reply) return { kind: "went-on", reply };
      const mark = conversation.messages.find((message) => message.id === askingReply.id)?.metadata?.selfCompaction;
      if (!mark) return { kind: "ended", reason: "not-continued" };
      if (mark.state === "ended" || mark.reason) return { kind: "ended", reason: mark.reason ?? "not-continued", ...(mark.error ? { error: mark.error } : {}) };
      const lost = mark.state === "waiting" ? this.selfCompactionTurnLost(conversationId, participantId, askingRunId) : undefined;
      if (lost) return { kind: "ended", reason: lost };
      cardEnds = mark.state === "card" ? cardEnds ?? Date.now() + SELF_COMPACTION_CARD_WAIT_MS : undefined;
      if (cardEnds !== undefined && Date.now() >= cardEnds) return { kind: "ended", reason: "not-continued" };
      const saved = await this.chat.store.nextChatSave(conversationId, cardEnds === undefined ? SELF_COMPACTION_LOOK_AGAIN_MS : Math.max(1, cardEnds - Date.now()), signal);
      conversation = saved ?? this.chat.store.lastSavedSnapshots.get(conversationId)?.snapshot ?? await this.chat.store.requireChat(conversationId);
    }
  }

  /** Stops a member's own compaction and the turn it goes on in, wherever it
   *  runs: the request they answer was stopped. */
  private async stopSelfCompaction(conversation: Conversation, participantId: string, askingRunId: string): Promise<void> {
    const resumeRunId = selfCompactionResumeRunId(askingRunId);
    const participant = chatParticipants(conversation).find((item) => item.id === participantId);
    if (!participant || this.chat.host.runsHere(participant)) {
      this.selfCompactionsCancelled.add(resumeRunId);
      while (this.selfCompactionsCancelled.size > 1_000) this.selfCompactionsCancelled.delete(this.selfCompactionsCancelled.values().next().value as string);
      const compaction = readParticipantCompactions(conversation.metadata)[participantId];
      if (compaction && this.chat.activeRuns.chatRunControllers.has(compaction.runId)) this.chat.runCancel.cancelRun(compaction.runId);
      if (this.chat.activeRuns.chatRunControllers.has(resumeRunId)) {
        this.chat.runCancel.cancelRun(resumeRunId);
        return;
      }
      // Not begun: it never is, and a card of it still open asks nothing now.
      await this.chat.store.saveChatChange(conversation, () => {
        const card = pendingCompactionCard(conversation, participantId, askingRunId);
        if (card) upsertAppToolApproval(conversation, { ...card, status: "cancelled", error: PARTICIPANT_REQUEST_STOPPED_BY_USER, updatedAt: new Date().toISOString() });
      });
      await this.chat.selfCompactionResumes.endSelfCompaction(conversation.id, participantId, askingRunId, this.chat.appQuit.quitting ? "interrupted" : "stopped");
      return;
    }
    const link = this.chat.serverLink.current;
    if (!link || this.chat.appQuit.quitting) return;
    this.remoteSelfCompactionsStopped.add(resumeRunId);
    while (this.remoteSelfCompactionsStopped.size > 1_000) this.remoteSelfCompactionsStopped.delete(this.remoteSelfCompactionsStopped.values().next().value as string);
    const base = runIdBase(askingRunId);
    const known = [...this.chat.serverTurns.serverTurnStates.values()].filter((turn) => turn.conversationId === conversation.id && turn.participantId === participantId &&
      (turn.runId === resumeRunId || (turn.request?.kind === "compaction" && runIdBase(selfCompactionResumeFrom(turn.request.resume)?.runId ?? "") === base)));
    const stops = known.filter((turn) => turn.state !== "finished" && turn.state !== "stopped").map((turn) => ({ runId: turn.runId, messageId: turn.messageId }));
    // The turn it would go on in, not asked yet: the server gives it to nobody.
    const askingReply = repliesOfRun(conversation, participantId, askingRunId)[0];
    if (askingReply && !known.some((turn) => turn.runId === resumeRunId)) stops.push({ runId: resumeRunId, messageId: askingReply.id });
    if (stops.length > 0) {
      await link.enqueue(stops.map((stop) => ({ opId: newOpId(), kind: "turn.stop" as const, conversationId: conversation.id, ...stop, participantId })));
    }
  }

  /** Once per chat since the app started: replies of this device's members
   *  that waited for a compaction a quit or a restart cut short. A card still
   *  open goes on waiting; a machine's compaction waits on the server and goes
   *  on from there. Returns whether one changed. */
  recoverSelfCompactions(conversation: Conversation): boolean {
    // A machine looks once the server told it which turns wait there.
    if (this.selfCompactionsRecovered.has(conversation.id) || (this.chat.host.machineRuntime && (!this.chat.host.hostMachineId || !this.chat.serverTurns.serverTurnsRead))) return false;
    this.selfCompactionsRecovered.add(conversation.id);
    let changed = false;
    for (const message of conversation.messages) {
      const mark = message.metadata?.selfCompaction;
      const runId = message.metadata?.runId;
      if (!mark || mark.state === "ended" || !runId || !message.participantId) continue;
      const participant = chatParticipants(conversation).find((item) => item.id === message.participantId);
      if (!participant || !this.chat.host.runsHere(participant)) continue;
      if (this.chat.selfCompactionResumes.selfCompactionResumes.has(selfCompactionResumeKey(conversation.id, participant.id, runId))) continue;
      if (mark.state === "waiting" && this.selfCompactionTurnOpen(conversation.id, participant.id, runId)) continue;
      if (mark.state === "card" && pendingCompactionCard(conversation, participant.id, runId)) continue;
      const resumeRunId = selfCompactionResumeRunId(runId);
      if (mark.state === "resumed" && (this.chat.activeRuns.hasActiveRunForConversation(conversation.id, resumeRunId) || repliesOfRun(conversation, participant.id, resumeRunId).length > 0)) continue;
      // "resumed" with no reply: its turn never began.
      message.metadata = { ...message.metadata, selfCompaction: { state: mark.state === "resumed" ? "resumed" : "ended", reason: "interrupted" } };
      changed = true;
    }
    return changed;
  }

  /** A compaction turn of this run's still asked for or taken on the server. */
  private selfCompactionTurnOpen(conversationId: string, participantId: string, runId: string): boolean {
    const base = runIdBase(runId);
    return [...this.chat.serverTurns.serverTurnStates.values()].some((turn) => turn.conversationId === conversationId && turn.participantId === participantId &&
      turn.request?.kind === "compaction" && (turn.state === "requested" || turn.state === "claimed") &&
      runIdBase(selfCompactionResumeFrom(turn.request.resume)?.runId ?? "") === base);
  }
}
