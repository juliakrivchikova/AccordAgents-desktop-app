import { mainSessionParticipantId } from "../../../../shared/mainSession";
import { randomUUID } from "node:crypto";
import type {
  ChatMessage, ChatMessageMetadata, ChatParticipant, ChatParticipantRequestApprovalRequest, ChatParticipantRequestBatch,
  ChatParticipantRequestInput, ChatParticipantRequestItem, ChatParticipantRequestStatus, Conversation
} from "../../../../shared/types";
import { chatMessageMemberText } from "../../../../shared/interimPosts";
import { participantRequestVisibleRootId } from "../../../../shared/chatParticipantRequestThreads";
import {
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT, CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT
} from "../../../../shared/chatParticipantRequests";
import { normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { hasChatAppToolCapability } from "../../../../shared/appTools";
import { hasPendingPermissionApprovalForParticipantTurn } from "../approvals/approvalRecords";
import { participantForMentionHandle } from "../choices/mentions";
import { PARTICIPANT_REQUEST_CUT_BY_SEND_NOW, PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION, PARTICIPANT_REQUEST_STOPPED_BY_USER } from "../constants";
import { chatParticipants, participantForRun } from "../members/identity";
import { memberDeliveryWay } from "../members/roleRuntime";
import { CombinedTurnStopped } from "../turns/turnQueue";
import {
  awaitParticipantRequestRunner, formatParticipantRequestMessage, isOpenParticipantRequestStatus, normalizeParticipantRequest,
  participantRequestBatchForTool, participantRequestFailedToolResult, participantRequestLimitError, participantRequestSummary,
  participantRequestToolResult, recordPreparedParticipantRequest, rollupParticipantRequestStatus, settleRequestsAnsweredWith,
  updateParticipantRequestBatch
} from "./requestRecords";
import { itemWaitsOnOwnRequests, memberWorksOnAfter, messagesById } from "./ownRequests";
import { answerThroughOwnWork, type OwnWorkAnswer } from "./ownRequestWaits";
import type { ParticipantRequestRunResult, PreparedParticipantRequest } from "./types";
import { createChatMessage } from "../store/messages";
import type { ChatAppMcpActor, ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Requests members send one another: asked, run and answered. */
export class ParticipantRequests {
  readonly participantRequestRunners = new Map<string, Promise<ParticipantRequestRunResult>>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "appQuit" | "chatHistory" | "host" | "pendingReplies" | "requestRecovery" | "requesterResumes"
      | "selfCompaction" | "serverTurns" | "store" | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "onReviewProgress" | "settings">
  ) {}

  queueParticipantRequestAutoResumes(conversationId: string, requestMessageIds: string[]): void {
    for (const requestMessageId of Array.from(new Set(requestMessageIds))) {
      void this.chat.requesterResumes.autoResumeParticipantRequest(conversationId, requestMessageId, this.deps.onReviewProgress).catch((error) => {
        void this.deps.debugLogs.write("chat.remote-run.participant-request-auto-resume.error", {
          conversationId,
          requestMessageId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  async requestParticipantsFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    this.chat.host.assertOwnsParticipant(requester);
    if (!hasChatAppToolCapability(actor.capabilities, "participants.request")) {
      return participantRequestFailedToolResult("This member is not allowed to request other members.");
    }

    // Prepared and recorded on the chat as saved now (refreshed by the
    // mutation), not on the copy read above: a member the User removed or
    // added meanwhile is neither asked nor written back.
    let prepared!: PreparedParticipantRequest;
    let pendingTargets: ChatParticipantRequestItem[] = [];
    let deliverRefused = false;
    const failure = await this.chat.store.withChatMutation(conversation, async () => {
      const requesterNow = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
      if (!requesterNow) {
        throw new Error("The requesting member is no longer in this chat.");
      }
      try {
        const normalized = normalizeParticipantRequest(rawRequest);
        // Only the chat's main session delivers a request now (the User,
        // 2026-11-27): a member's request never cuts another member's turn.
        deliverRefused = normalized.requests.some((request) => request.deliver === "now") && requesterNow.id !== mainSessionParticipantId(conversation.metadata);
        prepared = await this.prepareParticipantRequest(conversation, requesterNow, normalized, actor, "mcp");
      } catch (error) {
        return participantRequestFailedToolResult(error instanceof Error ? error.message : String(error));
      }
      recordPreparedParticipantRequest(conversation, requesterNow, prepared, actor);
      pendingTargets = prepared.batch.items.filter((item) => item.status === "pending_approval");
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
      return undefined;
    });
    if (failure) {
      return failure;
    }
    // Which way each busy target takes it, as things stand when it is asked.
    const delivery = prepared.batch.items.some((item) => item.deliver === "now") ? this.deliveryOf(conversation, prepared.batch) : undefined;
    const withDelivery = (extra: Record<string, unknown>): Record<string, unknown> => ({
      ...extra,
      ...(delivery ? { delivery } : {}),
      ...(deliverRefused ? { deliverRefused: "Only the chat's main session delivers a request now: this one waits its turn, as without deliver." } : {})
    });

    const hasRunningTargets = prepared.batch.items.some((item) => item.status === "running");
    if (!hasRunningTargets) {
      return participantRequestToolResult(conversation, prepared.requestMessage.id, withDelivery({
        status: prepared.batch.status,
        approvalRequired: pendingTargets.length > 0
      }));
    }

    const requesterProgress = actor.runId ? this.chat.activeRuns.runProgressCallbacks.get(actor.runId) : undefined;
    // The shared runner handles local targets here and delegates the others
    // to their homes, for tool requests and inferred requests alike. Each
    // target runs as its own run, so stopping the requester or one target
    // never stops the others.
    // An inline request is the requester's foreground work, as a foreground
    // subagent is in the CLI: stopping the requester stops it too. A request
    // answered in a fresh turn is background work and outlives the turn.
    const inlineParentSignal = prepared.batch.resumeRequester || !actor.runId
      ? undefined
      : this.chat.activeRuns.firstChatRunController(actor.runId)?.signal;
    const runner = this.startParticipantRequestRunner(
      conversation.id,
      prepared.requestMessage.id,
      prepared.batch.depth,
      requesterProgress,
      inlineParentSignal
    );
    // When replies come back in a fresh requester turn, there is nothing to
    // wait for here: holding the call open would only keep the requester busy
    // and unreachable. The bounded wait is for inline replies only.
    const result = prepared.batch.resumeRequester
      ? { timedOut: true as const }
      : await awaitParticipantRequestRunner(runner, prepared.timeoutMs);
    if (result.timedOut) {
      this.resumeRequesterWhenRunnerSettles(conversation.id, prepared.requestMessage.id, runner, requesterProgress);
      const latest = await this.chat.store.requireChat(conversation.id);
      return participantRequestToolResult(latest, prepared.requestMessage.id, withDelivery({ status: "running", approvalRequired: false }));
    }

    const latest = await this.chat.store.requireChat(conversation.id);
    const finished = await this.chat.store.withChatMutation(latest, async () => {
      const latestBatch = latest.messages.find((message) => message.id === prepared.requestMessage.id)?.metadata?.participantRequest;
      const hasUnfinishedItems = latestBatch?.items.some((item) => isOpenParticipantRequestStatus(item.status));
      const approvalRequired = latestBatch?.items.some((item) => item.status === "pending_approval") ?? false;
      let status = latestBatch?.status ?? result.result.batch.status;
      // Only an inline request (resumeRequester false) waits, so finished
      // replies here are returned in this same call.
      if (!hasUnfinishedItems) {
        const completedBatch = updateParticipantRequestBatch(latest, prepared.requestMessage.id, (batch) => ({
          ...batch,
          completedInToolCall: true,
          status: "completed",
          updatedAt: new Date().toISOString()
        }));
        status = completedBatch?.status ?? "completed";
        void this.deps.debugLogs.write("chat.participant-request.completed-in-tool-call", {
          conversationId: conversation.id,
          requestMessageId: prepared.requestMessage.id,
          batchId: completedBatch?.id ?? latestBatch?.id
        });
      }
      await this.chat.store.saveConversation(latest);
      return { status, approvalRequired };
    });
    return participantRequestToolResult(latest, prepared.requestMessage.id, withDelivery(finished));
  }

  /** What a request asked with `deliver: "now"` does with each target it
   *  runs now: the requester is told which way it went. A target whose turn
   *  waits for the User's approval is delivered once she approves it. */
  private deliveryOf(conversation: Conversation, batch: ChatParticipantRequestBatch): Array<{ target: string; way: string; note: string }> {
    const participants = chatParticipants(conversation);
    return batch.items.filter((item) => item.status === "running" && item.deliver === "now").flatMap((item) => {
      const target = participants.find((participant) => participant.id === item.targetParticipantId);
      if (!target) return [];
      const activity = this.chat.turnQueue.memberActivity(conversation.id, target.id);
      const busyElsewhere = !this.chat.host.runsHere(target) && [...this.chat.serverTurns.serverTurnStates.values()].some((turn) =>
        turn.conversationId === conversation.id && turn.participantId === target.id && turn.state === "claimed");
      const handle = `@${target.handle}`;
      if (activity.goingOn) {
        return [{ target: handle, way: "after-operation", note: `${handle} has just compacted its context and goes on with its work: it takes the request right after that turn, before anything else waiting for it.` }];
      }
      if (activity.compacting) {
        return [{ target: handle, way: "after-operation", note: `${handle} is compacting its context: it takes the request right after that and the turn it goes on in, before anything else waiting for it.` }];
      }
      if (activity.running === "operation") {
        return [{ target: handle, way: "after-operation", note: `${handle} is being compacted, restarted or moved: it takes the request as soon as that ends, before anything else waiting for it.` }];
      }
      if (activity.running === "none" && !busyElsewhere) {
        return [{ target: handle, way: "started", note: `${handle} was not working: it starts on the request now.` }];
      }
      if (memberDeliveryWay(target) === "into-running-turn") {
        return [{
          target: handle,
          way: "into-running-turn",
          note: target.kind === "codex-cli"
            ? `${handle} is working: the request goes into its running turn now, as a message typed into Codex mid-turn (Codex steers the turn with it). While that turn waits on the User's approval, it takes the request right after the turn. If Codex cannot take it there, the running turn is interrupted (what it wrote stays) and it goes on at once in the same session with this request.`
            : `${handle} is working: the request goes into its running turn now, as a message typed into Claude Code mid-turn (it takes it at its next tool result, or its step is cut for it).`
        }];
      }
      const cli = target.kind === "gemini-cli" ? "Antigravity" : target.kind === "codex-cli" ? "Codex" : "its CLI";
      return [{
        target: handle,
        way: "interrupted-and-restarted",
        note: `${handle} is working, and ${cli} cannot take a message in the middle of a turn: its running turn is interrupted (what it wrote stays, as after a Stop) and it goes on at once in the same session with this request. Work that was waiting for it runs after.`
      }];
    });
  }

  async participantRequestStatusForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    const record = rawRequest && typeof rawRequest === "object" && !Array.isArray(rawRequest)
      ? rawRequest as { requestId?: unknown }
      : {};
    const requestId = typeof record.requestId === "string" ? record.requestId.trim() : "";
    await this.chat.store.withChatMutation(conversation, async () => {
      let changed = false;
      for (const message of conversation.messages) {
        const batch = message.metadata?.participantRequest;
        if (!batch || (requestId && batch.id !== requestId)) {
          continue;
        }
        if (this.chat.requestRecovery.markOrphanedParticipantRequestInterrupted(conversation, message)) {
          changed = true;
        }
      }
      if (changed) {
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
      }
    });
    const batches = conversation.messages
      .map((message) => message.metadata?.participantRequest)
      .filter((batch): batch is ChatParticipantRequestBatch => Boolean(batch))
      .filter((batch) => requestId ? batch.id === requestId : batch.requesterParticipantId === requester.id)
      .slice(-10)
      .reverse();
    return {
      ok: true,
      requests: batches.map((batch) => participantRequestBatchForTool(conversation, batch))
    };
  }

  async prepareParticipantRequest(
    conversation: Conversation,
    requester: ChatParticipant,
    normalized: { requests: ChatParticipantRequestInput[]; timeoutMs: number; resumeRequester: boolean },
    actor: ChatAppMcpActor,
    source: "mcp" | "inferred"
  ): Promise<PreparedParticipantRequest> {
    const batchId = randomUUID();
    const requesterDepth = actor.participantRequestDepth ?? 0;
    const depth = requesterDepth + 1;
    const chainRootId = actor.chainRootId ?? actor.triggerMessageId ?? batchId;
    const maxDepth = await this.chatParticipantRequestMaxDepth();
    // A member asking the main session (and only it) is not held to the
    // chain limit: members ask the main session, not User, as often as they
    // need (docs/main-session.md).
    const mainId = mainSessionParticipantId(conversation.metadata);
    const chatMembers = chatParticipants(conversation);
    const asksMainSessionOnly = Boolean(mainId) && requester.id !== mainId &&
      normalized.requests.every((request) => participantForMentionHandle(chatMembers, request.target)?.id === mainId);
    const limitError = participantRequestLimitError(conversation, requester, actor, depth, maxDepth, chainRootId, asksMainSessionOnly);
    if (limitError) {
      throw new Error(limitError);
    }
    const promptMaxChars = await this.chatParticipantRequestPromptMaxChars();
    for (const request of normalized.requests) {
      if (request.prompt.length > promptMaxChars) {
        throw new Error(`Member request prompt for @${request.target} exceeds ${promptMaxChars} characters; it is rejected, not truncated.`);
      }
    }
    const permission = normalizeChatAgentPermissions(participantForRun(conversation, requester).permissions).requestParticipants;
    if (permission === "deny") {
      throw new Error(`Member requests are disabled for @${requester.handle}.`);
    }
    const requestStatus: ChatParticipantRequestStatus = permission === "allow" ? "running" : "pending_approval";
    const participants = chatParticipants(conversation);
    const targets = new Map<string, ChatParticipant>();
    const requests: ChatParticipantRequestInput[] = [];
    for (const request of normalized.requests) {
      const target = participantForMentionHandle(participants, request.target);
      if (!target) {
        throw new Error(`No member named @${request.target}.`);
      }
      if (target.id === requester.id) {
        throw new Error("A member cannot request itself.");
      }
      if (targets.has(target.id)) {
        continue;
      }
      targets.set(target.id, target);
      requests.push({ ...request, target: target.handle });
    }
    if (targets.size === 0) {
      throw new Error("Member request did not include any runnable targets.");
    }

    const now = new Date().toISOString();
    const items: ChatParticipantRequestItem[] = Array.from(targets.values()).map((target) => {
      const request = requests.find((item) => item.target.toLowerCase() === target.handle.toLowerCase());
      return {
        targetParticipantId: target.id,
        targetHandle: target.handle,
        targetKind: target.kind,
        prompt: request?.prompt ?? "",
        ...(request?.title ? { title: request.title } : {}),
        reason: request?.reason,
        status: requestStatus,
        ...(source === "mcp" && request?.deliver === "now" && requester.id === mainId ? { deliver: "now" as const } : {}),
        createdAt: now,
        updatedAt: now
      };
    });
    const batch: ChatParticipantRequestBatch = {
      id: batchId,
      requesterParticipantId: requester.id,
      requesterHandle: requester.handle,
      source,
      resumeRequester: source === "inferred" ? true : normalized.resumeRequester,
      status: rollupParticipantRequestStatus(items),
      depth,
      requesterDepth,
      chainRootId,
      createdAt: now,
      updatedAt: now,
      triggerMessageId: actor.triggerMessageId,
      ...(actor.turnSegmentId ? { requesterTurnSegmentId: actor.turnSegmentId } : {}),
      items
    };
    const requestMetadata: ChatMessageMetadata = {
      threadId: actor.triggerThreadId ?? actor.triggerMessageId ?? batchId,
      parentMessageId: actor.triggerMessageId,
      sourceMessageId: actor.triggerMessageId,
      participantRequest: batch
    };
    if (source === "inferred") {
      requestMetadata.hiddenFromTimeline = true;
      requestMetadata.chatThreadRootId = actor.triggerChatThreadRootId ?? actor.triggerMessageId;
    }
    const requestMessage = createChatMessage(
      "participant",
      formatParticipantRequestMessage(requester.handle, items),
      { id: requester.id, kind: requester.kind, label: `@${requester.handle}`, model: requester.model },
      requestMetadata
    );
    const request: ChatParticipantRequestApprovalRequest = {
      requests,
      resumeRequester: batch.resumeRequester,
      source,
      requestMessageId: requestMessage.id,
      batchId
    };
    return {
      request,
      requester,
      targets: Array.from(targets.values()),
      batch,
      requestMessage,
      summary: participantRequestSummary(requester.handle, Array.from(targets.values()).map((target) => target.handle)),
      timeoutMs: normalized.timeoutMs
    };
  }

  async chatParticipantRequestMaxDepth(): Promise<number> {
    return this.deps.settings.getChatParticipantRequestMaxDepth?.() ?? CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT;
  }

  async chatParticipantRequestPromptMaxChars(): Promise<number> {
    return this.deps.settings.getChatParticipantRequestPromptMaxChars?.() ?? CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT;
  }

  startParticipantRequestRunner(
    conversationId: string,
    requestMessageId: string,
    depth: number,
    progress?: ProgressCallback,
    inlineParentSignal?: AbortSignal
  ): Promise<ParticipantRequestRunResult> {
    const existing = this.participantRequestRunners.get(requestMessageId);
    if (existing) {
      return existing;
    }
    const runnerProgress = progress ?? this.deps.onReviewProgress;
    this.chat.activeRuns.incrementBackgroundRunner(conversationId);
    const runner = this.runParticipantRequest(conversationId, requestMessageId, depth, runnerProgress, inlineParentSignal)
      .finally(() => {
        this.participantRequestRunners.delete(requestMessageId);
        this.chat.activeRuns.decrementBackgroundRunner(conversationId);
      });
    this.participantRequestRunners.set(requestMessageId, runner);
    return runner;
  }

  private startParticipantRequestRunnerAfterQueuedSave(
    conversationId: string,
    requestMessageId: string,
    depth: number,
    source: ChatParticipantRequestBatch["source"]
  ): void {
    void Promise.resolve()
      .then(async () => {
        await this.chat.store.waitForQueuedSave(conversationId);
        const runner = this.startParticipantRequestRunner(conversationId, requestMessageId, depth);
        this.resumeRequesterWhenRunnerSettles(conversationId, requestMessageId, runner, this.deps.onReviewProgress);
      })
      .catch((error) => {
        void this.deps.debugLogs.write("chat.participant-request.background-run.error", {
          conversationId,
          requestMessageId,
          source,
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }

  startDeferredParticipantRequestRunners(
    conversationId: string,
    requests: Array<{ requestMessageId: string; depth: number; source: ChatParticipantRequestBatch["source"] }>
  ): void {
    for (const request of requests) {
      this.startParticipantRequestRunnerAfterQueuedSave(
        conversationId,
        request.requestMessageId,
        request.depth,
        request.source
      );
    }
  }

  private async runParticipantRequest(
    conversationId: string,
    requestMessageId: string,
    depth: number,
    progress?: ProgressCallback,
    /** Set only for an inline request: the requester's own run, whose Stop
     *  also stops these targets. */
    inlineParentSignal?: AbortSignal
  ): Promise<ParticipantRequestRunResult> {
    const warnings: string[] = [];
    const conversation = await this.chat.store.requireChat(conversationId);
    const requestMessage = conversation.messages.find((message) => message.id === requestMessageId);
    const batch = requestMessage?.metadata?.participantRequest;
    if (!requestMessage || !batch) {
      throw new Error("Member request message was not found.");
    }
    const participants = chatParticipants(conversation);
    // Every target runs as its own turn: here when it is this device's
    // member, otherwise on its own device, asked through the User's server
    // (runParticipantTurnSerialized), wherever the request was made.
    const runnableItems = batch.items.filter((item) => item.status === "running");
    const replies: ParticipantRequestRunResult["replies"] = [];
    await Promise.all(runnableItems.map(async (item) => {
      const target = participants.find((participant) => participant.id === item.targetParticipantId);
      if (!target) {
        const now = new Date().toISOString();
        updateParticipantRequestBatch(conversation, requestMessageId, (current) => ({
          ...current,
          items: current.items.map((candidate) => candidate.targetParticipantId === item.targetParticipantId
            ? { ...candidate, status: "failed", error: "Target member is no longer in this chat.", updatedAt: now }
            : candidate),
          updatedAt: now
        }));
        return;
      }
      let participantRequestsToRun: Array<{ requestMessageId: string; depth: number; source: ChatParticipantRequestBatch["source"] }> = [];
      let targetRunId: string | undefined;
      let targetRunBegun = false;
      let targetController: AbortController | undefined;
      const abortFromInlineParent = (): void => targetController?.abort();
      try {
        const requestRootId = participantRequestVisibleRootId(conversation.messages, requestMessage);
        const targetTriggerMessage: ChatMessage = {
          ...requestMessage,
          metadata: {
            ...requestMessage.metadata,
            chatThreadRootId: requestRootId
          }
        };
        // Every target is its own run: its Stop control stops only this
        // member, and nothing the requester does reaches it. It is a real
        // chat run from the start, so Stop all and a Stop from another window
        // reach it even while it still waits behind the member's own turn.
        // As in a mention fan-out, the run's Stop control exists before the
        // run is announced as active, so a Stop in between is never lost.
        targetRunId = randomUUID();
        targetController = new AbortController();
        if (inlineParentSignal?.aborted) {
          targetController.abort();
        } else {
          inlineParentSignal?.addEventListener("abort", abortFromInlineParent, { once: true });
        }
        this.chat.activeRuns.registerTargetRun(targetRunId, targetController, {
          conversationId: conversation.id,
          participantId: target.id,
          participantHandle: target.handle
        });
        await this.chat.activeRuns.beginChatRun(conversation, targetRunId);
        targetRunBegun = true;
        const messages = await this.chat.turnQueue.runParticipantTurnSerialized(conversation, target, targetTriggerMessage, targetRunId, targetController.signal, progress, {
          warnings,
          participantRequestDepth: depth,
          participantRequestBatchId: batch.id,
          chainRootId: batch.chainRootId,
          // Waiting for a busy member, it goes out with the requests waiting
          // next to it in one turn: not one delivered now (it does not wait),
          // nor one its requester's turn waits for (that turn's Stop stops it).
          ...(item.deliver !== "now" && !item.replyMessageId && !inlineParentSignal ? { combine: { chars: item.prompt.length, maxChars: await this.chatParticipantRequestPromptMaxChars() } } : {})
        });
        if (this.chat.turnQueue.takeAnsweredTogether(targetRunId)) {
          // Answered by the turn of a request it went out with: it ends as
          // that request does, with its reply.
          const settled = await this.linkAnsweredTogether(conversation, requestMessageId, target, messages[0]);
          const answer = settled?.replyMessageId ? conversation.messages.find((message) => message.id === settled.replyMessageId) : undefined;
          replies.push({ targetHandle: target.handle, messageId: settled?.replyMessageId, content: answer ? chatMessageMemberText(answer) : undefined, error: settled?.error });
          return;
        }
        let reply = messages[0];
        // A reply that asked to compact the member's context is not its
        // answer yet: the one it goes on to is (continueAfterSelfCompaction).
        // Nor is one that ended while the member waits on what it asked
        // others itself (app_chat_request_participants, resumed with the
        // answers): the turn it is resumed in is (ownRequests.ts).
        let continues = false;
        await this.chat.store.withChatMutation(conversation, async () => {
          participantRequestsToRun = await this.chat.pendingReplies.appendParticipantTurnMessages(conversation, target, messages);
          const waitingOnPermissionApproval = hasPendingPermissionApprovalForParticipantTurn(
            conversation,
            target,
            requestMessage.id,
            batch.id
          );
          const now = new Date().toISOString();
          const remoteReplyStillRunning = false;
          // A reply the User's quit ended is interrupted, as the requests the
          // quit itself ends are (endTurnsForQuit), however it ended first.
          const endedByQuit = this.chat.appQuit.endsByQuit(reply?.metadata?.runId) && reply?.metadata?.terminalReason === "user-stopped";
          // A reply cut short for a message the User sent now (or joined by
          // one) did not finish answering: the request is interrupted. So is
          // a turn stopped before its member started (no reply at all), here
          // or on a machine alike; one that did not start otherwise failed.
          const notRun = !reply;
          const stoppedByUser = reply?.metadata?.terminalReason === "user-stopped" || reply?.metadata?.turnContinues === true ||
            (notRun && targetController!.signal.aborted);
          continues = !waitingOnPermissionApproval && !stoppedByUser && Boolean(reply && (
            (reply.metadata?.selfCompaction && reply.metadata.runId) || memberWorksOnAfter(conversation, target.id, requestMessageId, reply)
          ));
          updateParticipantRequestBatch(conversation, requestMessageId, (current) => ({
            ...current,
            items: current.items.map((candidate) => candidate.targetParticipantId === item.targetParticipantId
              ? {
                  ...candidate,
                  status: waitingOnPermissionApproval || remoteReplyStillRunning || continues
                    ? "running"
                    : stoppedByUser
                      ? "interrupted"
                      : reply?.status === "error" || notRun
                        ? "failed"
                        : "answered",
                  replyMessageId: reply?.id,
                  error: waitingOnPermissionApproval || remoteReplyStillRunning || continues
                    ? undefined
                    : endedByQuit
                      ? PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION
                      : stoppedByUser
                        ? (reply?.metadata?.turnContinues === true || (notRun && this.chat.activeRuns.sentNowRunIds.has(targetRunId!))
                          ? PARTICIPANT_REQUEST_CUT_BY_SEND_NOW : PARTICIPANT_REQUEST_STOPPED_BY_USER)
                        : reply?.status === "error" ? reply.content : notRun ? `@${target.handle} did not start on this request.` : undefined,
                  updatedAt: now
                }
              : candidate),
            updatedAt: now
          }));
          this.chat.store.queueSnapshot(conversation);
        });
        // Requests its reply made by mentions start now, not after the wait
        // below (they are not what it waits on).
        this.startDeferredParticipantRequestRunners(conversation.id, participantRequestsToRun);
        participantRequestsToRun = [];
        // What it wrote before each compaction of its own and before each
        // resume after its own requests; the last reply is its answer. Its
        // run stays live meanwhile: the member's Stop ends the request.
        const earlier: ChatMessage[] = [];
        // Its own compaction goes on in this run. A wait on its own requests
        // runs in a run of its own, begun before this one ends: this turn is
        // over, and its cards (its own requests' cards among them) stay
        // with it, so a quit meanwhile leaves them to the User as it does
        // after any finished turn.
        const endTurnRun = async (): Promise<void> => {
          if (targetRunBegun && targetRunId) await this.chat.activeRuns.endChatRun(conversation, targetRunId);
          targetRunBegun = false;
          if (targetRunId && targetController) this.chat.activeRuns.unregisterTargetRun(targetRunId, targetController);
        };
        const through = !continues || !reply ? undefined
          : reply.metadata?.selfCompaction
            ? await answerThroughOwnWork(this.chat, conversation.id, requestMessageId, target.id, reply, [], targetController.signal)
            : await this.answerWithLiveRun(conversation, requestMessageId, target, reply, [], { parentSignal: targetController.signal, onLive: endTurnRun });
        if (through?.kind === "answer") {
          reply = through.reply;
          earlier.push(...through.earlier);
          await this.chat.selfCompaction.settleSelfCompactedItem(conversation, requestMessageId, batch.id, target, through);
        }
        if (through?.kind === "closed") {
          // Ended meanwhile elsewhere (its member's resume will not be
          // made): it stays as it was ended there.
          const ended = through.item?.replyMessageId ? conversation.messages.find((message) => message.id === through.item?.replyMessageId) : undefined;
          replies.push({ targetHandle: target.handle, messageId: ended?.id, content: ended ? chatMessageMemberText(ended) : undefined, error: through.item?.error });
        } else {
          replies.push({
            targetHandle: target.handle,
            messageId: reply?.id,
            content: reply ? [...earlier, reply].map((message) => chatMessageMemberText(message)).filter(Boolean).join("\n\n") : undefined,
            error: reply?.status === "error" ? reply.content
              // Cut short for a message the User sent now: what it wrote is not its answer.
              : reply?.metadata?.turnContinues === true ? `@${target.handle} was interrupted before it finished: it was sent a message to take now (by the User, or a request delivered now).`
              : !reply ? (!targetController.signal.aborted ? `@${target.handle} did not start on this request.`
                : this.chat.activeRuns.sentNowRunIds.has(targetRunId) ? PARTICIPANT_REQUEST_CUT_BY_SEND_NOW : PARTICIPANT_REQUEST_STOPPED_BY_USER) : undefined
          });
        }
      } catch (error) {
        // A Stop that lands before any reply exists (the member still waits
        // for its turn, or its machine is still being prepared) ends here.
        // Or the reply it went out in was stopped before the member started.
        const stoppedBeforeStart = targetController?.signal.aborted === true || error instanceof CombinedTurnStopped;
        // Cut for a request delivered now, not stopped by the User.
        const cut = targetRunId !== undefined && this.chat.activeRuns.sentNowRunIds.has(targetRunId);
        const message = stoppedBeforeStart
          ? (cut ? PARTICIPANT_REQUEST_CUT_BY_SEND_NOW : PARTICIPANT_REQUEST_STOPPED_BY_USER)
          : error instanceof Error ? error.message : String(error);
        const now = new Date().toISOString();
        updateParticipantRequestBatch(conversation, requestMessageId, (current) => ({
          ...current,
          items: current.items.map((candidate) => candidate.targetParticipantId === item.targetParticipantId
            ? { ...candidate, status: stoppedBeforeStart ? "interrupted" : "failed", error: message, updatedAt: now }
            : candidate),
          updatedAt: now
        }));
        replies.push({ targetHandle: target.handle, error: message });
      } finally {
        inlineParentSignal?.removeEventListener("abort", abortFromInlineParent);
        if (targetRunBegun && targetRunId) {
          await this.chat.activeRuns.endChatRun(conversation, targetRunId);
        }
        if (targetRunId && targetController) {
          this.chat.activeRuns.unregisterTargetRun(targetRunId, targetController);
          this.chat.turnQueue.endJoinedRun(targetRunId);
        }
      }
      conversation.updatedAt = new Date().toISOString();
      this.chat.store.queueSnapshot(conversation);
      this.startDeferredParticipantRequestRunners(conversation.id, participantRequestsToRun);
    }));
    await this.chat.chatHistory.ensureHistoryFiles(conversation);
    // The runner's copy is as old as its last turn: the batch's final status
    // is recorded on the chat as saved now.
    const updatedBatch = await this.chat.store.saveChatChange(conversation, () => updateParticipantRequestBatch(conversation, requestMessageId, (current) => {
      const status = rollupParticipantRequestStatus(current.items);
      return {
        ...current,
        status: status === "answered" ? "answered" : status,
        updatedAt: new Date().toISOString()
      };
    })) ?? batch;
    return { batch: updatedBatch, replies };
  }

  /** After a restart, a request whose member was waiting on its own requests
   *  (itemWaitsOnOwnRequests; its runner went with the old process) is waited
   *  on again here, on its requester's device, as its runner did, and the
   *  requester is resumed once it ends. One wait per request at a time. */
  resumeOwnRequestWait(conversationId: string, requestMessageId: string): void {
    if (this.participantRequestRunners.has(requestMessageId)) return;
    this.chat.activeRuns.incrementBackgroundRunner(conversationId);
    this.chat.activeRuns.waitOnlyRequests.add(requestMessageId);
    const waited = this.waitOnOwnRequestsAgain(conversationId, requestMessageId).finally(() => {
      this.participantRequestRunners.delete(requestMessageId);
      this.chat.activeRuns.waitOnlyRequests.delete(requestMessageId);
      this.chat.activeRuns.decrementBackgroundRunner(conversationId);
    });
    const runner = waited.then((outcome) => outcome.result);
    this.participantRequestRunners.set(requestMessageId, runner);
    // Nothing waited here (the start's look ended it, it was answered
    // meanwhile, or it ended elsewhere): what ended it resumes its
    // requester, or decided not to.
    void waited.then((outcome) => {
      if (outcome.waited) this.resumeRequesterWhenRunnerSettles(conversationId, requestMessageId, runner, this.deps.onReviewProgress);
    }, () => this.resumeRequesterWhenRunnerSettles(conversationId, requestMessageId, runner, this.deps.onReviewProgress));
  }

  private async waitOnOwnRequestsAgain(
    conversationId: string,
    requestMessageId: string
  ): Promise<{ waited: boolean; result: ParticipantRequestRunResult }> {
    await this.chat.store.waitForQueuedSave(conversationId);
    const conversation = await this.chat.store.requireChat(conversationId);
    const requestMessage = conversation.messages.find((message) => message.id === requestMessageId);
    const batch = requestMessage?.metadata?.participantRequest;
    if (!requestMessage || !batch) throw new Error("Member request message was not found.");
    const replies: ParticipantRequestRunResult["replies"] = [];
    const waiting = batch.items.filter((item) => !item.answeredWith && itemWaitsOnOwnRequests(conversation, requestMessage, item));
    if (waiting.length === 0) return { waited: false, result: { batch, replies } };
    const byId = messagesById(conversation);
    let settled = 0;
    await Promise.all(waiting.map(async (item) => {
      const target = chatParticipants(conversation).find((participant) => participant.id === item.targetParticipantId);
      const first = item.replyMessageId ? byId.get(item.replyMessageId) : undefined;
      if (!target || !first) return;
      const earlier = (item.earlierReplyMessageIds ?? []).flatMap((id) => byId.get(id) ?? []);
      void this.deps.debugLogs.write("chat.participant-request.own-requests.wait-again", { conversationId, requestMessageId, participantId: target.id });
      const through = await this.answerWithLiveRun(conversation, requestMessageId, target, first, earlier);
      if (through.kind !== "answer") return;
      settled += 1;
      await this.chat.selfCompaction.settleSelfCompactedItem(conversation, requestMessageId, batch.id, target, through);
      replies.push({ targetHandle: target.handle, messageId: through.reply.id, content: [...through.earlier, through.reply].map((message) => chatMessageMemberText(message)).filter(Boolean).join("\n\n") });
    }));
    const updatedBatch = await this.chat.store.saveChatChange(conversation, () => updateParticipantRequestBatch(conversation, requestMessageId, (current) => ({
      ...current,
      status: rollupParticipantRequestStatus(current.items),
      updatedAt: new Date().toISOString()
    }))) ?? batch;
    return { waited: settled > 0, result: { batch: updatedBatch, replies } };
  }

  /** The member's answer to a request after the work of its own in between
   *  (answerThroughOwnWork), waited for with a run of the member's live, as
   *  its first turn's run stays live in runParticipantRequest: its Stop ends
   *  the request, it shows working, and a turn its requester starts meanwhile
   *  does not take the request for one nobody works on any more. */
  async answerWithLiveRun(
    conversation: Conversation,
    requestMessageId: string,
    target: ChatParticipant,
    first: ChatMessage,
    earlier: readonly ChatMessage[],
    options: {
      /** Stopping it (an inline requester's Stop, a Stop that came in the
       *  turn before) stops this wait too. */
      parentSignal?: AbortSignal;
      /** Called once this run is live (the turn before ends its run then). */
      onLive?: () => Promise<void>;
    } = {}
  ): Promise<OwnWorkAnswer> {
    const runId = randomUUID();
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (options.parentSignal?.aborted) controller.abort();
    else options.parentSignal?.addEventListener("abort", abort, { once: true });
    this.chat.activeRuns.waitOnlyRunIds.add(runId);
    this.chat.activeRuns.waitOnlyRequests.add(requestMessageId);
    this.chat.activeRuns.registerTargetRun(runId, controller, { conversationId: conversation.id, participantId: target.id, participantHandle: target.handle });
    let begun = false;
    try {
      await this.chat.activeRuns.beginChatRun(conversation, runId);
      begun = true;
      await options.onLive?.();
      return await answerThroughOwnWork(this.chat, conversation.id, requestMessageId, target.id, first, earlier, controller.signal);
    } finally {
      options.parentSignal?.removeEventListener("abort", abort);
      if (begun) await this.chat.activeRuns.endChatRun(conversation, runId);
      this.chat.activeRuns.unregisterTargetRun(runId, controller);
      this.chat.activeRuns.waitOnlyRunIds.delete(runId);
      this.chat.activeRuns.waitOnlyRequests.delete(requestMessageId);
    }
  }

  /** A request answered by the turn of a request before it, which it went
   *  out with (TurnQueue takeCombinableTurns): linked to that request
   *  (ChatParticipantRequestItem.answeredWith), it ends as that request's
   *  item for the member ends, with its reply, now if that one has ended
   *  already, otherwise whenever it does (after an approval, a compaction of
   *  the member's own), wherever it ends (settleRequestsAnsweredWith); its
   *  requester is resumed then (requesterResumes). Its own run ends now.
   *  The item as it is now. */
  private async linkAnsweredTogether(
    conversation: Conversation,
    requestMessageId: string,
    target: ChatParticipant,
    reply: ChatMessage | undefined
  ): Promise<ChatParticipantRequestItem | undefined> {
    const itemOf = (messageId: string | undefined) => conversation.messages.find((message) => message.id === messageId)?.metadata?.participantRequest?.items
      .find((item) => item.targetParticipantId === target.id);
    return this.chat.store.withChatMutation(conversation, async () => {
      const own = itemOf(requestMessageId);
      if (!own || !isOpenParticipantRequestStatus(own.status)) return own;
      const leadRequestMessageId = reply?.metadata?.sourceMessageId;
      const leadBatch = conversation.messages.find((message) => message.id === leadRequestMessageId)?.metadata?.participantRequest;
      const now = new Date().toISOString();
      updateParticipantRequestBatch(conversation, requestMessageId, (current) => ({
        ...current,
        items: current.items.map((candidate) => candidate.targetParticipantId !== target.id ? candidate
          // Its request gone (removed with its message): the reply answers it.
          : !leadBatch ? { ...candidate, status: reply?.status === "error" ? "failed" as const : "answered" as const, replyMessageId: reply?.id,
            error: reply?.status === "error" ? reply.content : undefined, updatedAt: now }
          : { ...candidate, answeredWith: { requestMessageId: leadRequestMessageId!, ...(reply?.id ? { replyMessageId: reply.id } : {}) }, updatedAt: now }),
        updatedAt: now
      }));
      // Ended already: it ends with it now.
      if (leadBatch && leadRequestMessageId) settleRequestsAnsweredWith(conversation, leadRequestMessageId, leadBatch);
      this.chat.store.queueSnapshot(conversation);
      return itemOf(requestMessageId);
    });
  }

  /** Background request: once every target is done, the requester gets a
   *  fresh turn with the answers. If the runner itself fails, the request is
   *  closed as failed and the requester is still resumed, so it never waits
   *  on a request that can no longer finish. */
  resumeRequesterWhenRunnerSettles(
    conversationId: string,
    requestMessageId: string,
    runner: Promise<ParticipantRequestRunResult>,
    progress?: ProgressCallback
  ): void {
    void runner
      .catch(async (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        void this.deps.debugLogs.write("chat.participant-request.runner.error", { conversationId, requestMessageId, message: reason });
        const conversation = await this.chat.store.requireChat(conversationId);
        await this.chat.store.withChatMutation(conversation, async () => {
          const now = new Date().toISOString();
          updateParticipantRequestBatch(conversation, requestMessageId, (batch) => {
            const items = batch.items.map((item) => isOpenParticipantRequestStatus(item.status)
              ? { ...item, status: "failed" as const, error: item.error ?? reason, updatedAt: now }
              : item);
            return { ...batch, items, status: rollupParticipantRequestStatus(items), updatedAt: now };
          });
          conversation.updatedAt = now;
          this.chat.store.queueSnapshot(conversation);
        });
        // The resume reads stored state; it must see these items closed.
        await this.chat.store.waitForQueuedSave(conversationId);
      })
      .then(() => this.chat.requesterResumes.autoResumeParticipantRequest(conversationId, requestMessageId, progress))
      .catch((error) => {
        void this.deps.debugLogs.write("chat.participant-request.auto-resume.error", {
          conversationId,
          requestMessageId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }
}
