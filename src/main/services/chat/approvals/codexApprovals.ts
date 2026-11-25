import { randomUUID } from "node:crypto";
import type {
  ChatAppToolApproval, ChatCodexApprovalOption, ChatMessage, ChatParticipant, ChatParticipantSession, Conversation,
  RespondToChatAppToolApprovalRequest
} from "../../../../shared/types";
import {
  CODEX_APPROVAL_TOOL_NAME, codexApprovalCancellationResult, prepareCodexApproval, type CodexServerRequestDelivery
} from "../../codexApprovals";
import { CHAT_CODEX_APPROVAL_CANCEL_DECISION_ID, isCodexGuardianTimedOutApprovalMethod } from "../../../../shared/codexApproval";
import type { CliAgentCodexServerRequest } from "../../cliAgents";
import { sanitizeWarningText } from "../../../../shared/warnings";
import {
  chatAppToolApprovals, codexApprovalSummary, isCodexApprovalRequest, isGuardianDeniedApproval, upsertAppToolApproval
} from "./approvalRecords";
import { chatParticipants } from "../members/identity";
import { recordLastMessageByParticipant } from "../store/lastMessages";
import { createChatMessage } from "../store/messages";
import { abortReasonError, emitChatRunFailure, emitProgress } from "../turns/replyMessages";
import type { ChatApprovalExecutionGuard, ParticipantTurnReservation, ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

// Mirrors the dedicated CLI's bounded human approval wait. The provider turn
// timer is paused separately while a direct callback is outstanding.
const CHAT_CODEX_APPROVAL_WAIT_MS = 30 * 60_000;

const CHAT_CODEX_APPROVAL_CONTROL_APPROVE = "[AccordAgents approval control] Retry exactly the action I just approved, once. If it succeeds, continue the unfinished work from my original request that directly depends on it. Do not broaden the approved action or start unrelated work. If the retry cannot run, clearly explain why.";
const CHAT_CODEX_APPROVAL_CONTROL_DENY = "[AccordAgents approval control] Do not retry the action I just denied. Continue the unfinished work from my original request without it. If you cannot continue, clearly explain why.";

interface CodexApprovalResolver {
  conversationId: string;
  runId: string;
  responseByOptionId: ReadonlyMap<string, unknown>;
  responseDelivered: Promise<CodexServerRequestDelivery>;
  submitted: boolean;
  timer?: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** Codex's own approval prompts and its Guardian's decisions. */
export class CodexApprovals {
  private readonly codexApprovalContinuations = new Set<string>();
  readonly codexApprovalResolvers = new Map<string, CodexApprovalResolver>();
  private codexApprovalWaitMs = CHAT_CODEX_APPROVAL_WAIT_MS;

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "chatHistory" | "participantRequests" | "pendingReplies" | "store" | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs">
  ) {}

  setCodexApprovalWaitMsForTests(timeoutMs: number): void {
    this.codexApprovalWaitMs = Math.max(1, Math.floor(timeoutMs));
  }

  async requestCodexApprovalFromCli(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    runId: string,
    triggerMessageId: string,
    request: CliAgentCodexServerRequest
  ): Promise<unknown> {
    if (request.signal.aborted) {
      throw abortReasonError(request.signal, "Codex approval request was cancelled.");
    }
    const prepared = prepareCodexApproval(request);
    const now = new Date().toISOString();
    const guardianTimedOut = isCodexGuardianTimedOutApprovalMethod(prepared.request.method);
    const approval: ChatAppToolApproval = {
      id: randomUUID(),
      conversationId: conversation.id,
      requesterParticipantId: participant.id,
      requesterHandle: participant.handle,
      requesterRoleConfigId: session.roleConfigId,
      toolName: CODEX_APPROVAL_TOOL_NAME,
      capability: "permissions.request",
      status: guardianTimedOut ? "expired" : "pending",
      request: prepared.request,
      summary: codexApprovalSummary(prepared.request),
      createdAt: now,
      updatedAt: now,
      resumeContext: {
        runId,
        triggerMessageId
      },
      error: guardianTimedOut ? "Codex Auto Review timed out. The action remains denied and cannot be retried from this card." : undefined
    };

    if (guardianTimedOut) {
      await this.chat.store.withChatMutation(conversation, async () => {
        upsertAppToolApproval(conversation, approval);
        conversation.updatedAt = now;
        await this.chat.store.saveConversation(conversation);
      });
      return codexApprovalCancellationResult(prepared.request.method);
    }

    let resolveDecision!: (result: unknown) => void;
    let rejectDecision!: (error: Error) => void;
    const decisionPromise = new Promise<unknown>((resolve, reject) => {
      resolveDecision = resolve;
      rejectDecision = reject;
    });
    // A connection, Stop, compaction, or next-turn invalidation can arrive while
    // the durable card mutation is still awaiting storage. Attach a handler
    // immediately so early cancellation cannot surface as a process-level
    // unhandled rejection; callers still observe the original promise below.
    void decisionPromise.catch(() => undefined);
    let finished = false;
    let resolver!: CodexApprovalResolver;
    const onAbort = (): void => {
      if (finished || resolver.submitted) {
        return;
      }
      const reason = abortReasonError(request.signal, "Codex approval request was cancelled.");
      resolver.cleanup();
      rejectDecision(reason);
      void this.markCodexApprovalTerminal(
        conversation,
        approval.id,
        reason.message,
        reason.message === "Stopped by user." ? "cancelled" : "expired"
      );
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (resolver.timer) clearTimeout(resolver.timer);
      request.signal.removeEventListener("abort", onAbort);
      this.codexApprovalResolvers.delete(approval.id);
    };
    resolver = {
      conversationId: conversation.id,
      runId,
      responseByOptionId: prepared.responseByOptionId,
      responseDelivered: request.responseDelivered,
      submitted: false,
      resolve: resolveDecision,
      reject: rejectDecision,
      cleanup
    };
    resolver.timer = setTimeout(() => {
      if (finished || resolver.submitted) return;
      resolver.submitted = true;
      resolveDecision(codexApprovalCancellationResult(prepared.request.method));
      void resolver.responseDelivered
        .catch((error) => {
          void this.deps.debugLogs.write("chat.codex-approval.timeout-delivery-failed", {
            conversationId: conversation.id,
            runId,
            approvalId: approval.id,
            message: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          resolver.cleanup();
          void this.markCodexApprovalTerminal(
            conversation,
            approval.id,
            "Timed out waiting for User approval. Codex received the method-supported refusal.",
            "expired"
          );
        });
    }, this.codexApprovalWaitMs);
    resolver.timer.unref();
    this.codexApprovalResolvers.set(approval.id, resolver);

    try {
      await this.chat.store.withChatMutation(conversation, async () => {
        upsertAppToolApproval(conversation, approval);
        conversation.updatedAt = now;
        await this.chat.store.saveConversation(conversation);
      });
      void this.deps.debugLogs.write("chat.codex-approval.requested", {
        conversationId: conversation.id,
        participantId: participant.id,
        runId,
        approvalId: approval.id,
        method: prepared.request.method,
        itemId: prepared.request.itemId,
        callbackApprovalId: prepared.request.approvalId
      });
    } catch (error) {
      cleanup();
      throw error;
    }
    return decisionPromise;
  }

  async respondToCodexApproval(
    conversation: Conversation,
    request: RespondToChatAppToolApprovalRequest,
    progress?: ProgressCallback,
    execution?: ChatApprovalExecutionGuard
  ): Promise<Conversation> {
    const selected = await this.chat.store.withChatMutation(conversation, async () => {
      const approval = chatAppToolApprovals(conversation).find((item) => item.id === request.approvalId);
      if (!approval || !isCodexApprovalRequest(approval.request)) {
        throw new Error("Codex approval request was not found.");
      }
      if (approval.status !== "pending") {
        throw new Error("Codex approval request has already been answered.");
      }
      const resolver = this.codexApprovalResolvers.get(approval.id);
      if (!resolver || resolver.conversationId !== conversation.id) {
        const now = new Date().toISOString();
        upsertAppToolApproval(conversation, {
          ...approval,
          status: "expired",
          updatedAt: now,
          error: "The Codex app-server connection that requested this approval is no longer active."
        });
        conversation.updatedAt = now;
        await this.chat.store.saveConversation(conversation);
        throw new Error("The Codex app-server connection that requested this approval is no longer active.");
      }
      if (resolver.submitted) {
        throw new Error("Codex approval request has already been answered.");
      }
      const decisionId = request.codexDecisionId?.trim();
      const cancelGuardian = decisionId === CHAT_CODEX_APPROVAL_CANCEL_DECISION_ID &&
        !request.approve &&
        isGuardianDeniedApproval(approval);
      const option: ChatCodexApprovalOption | undefined = cancelGuardian
        ? { id: "cancel", label: "Cancel", outcome: "cancel" }
        : approval.request.options.find((item) => item.id === decisionId);
      const response = cancelGuardian
        ? codexApprovalCancellationResult(approval.request.method)
        : decisionId
          ? resolver.responseByOptionId.get(decisionId)
          : undefined;
      if (!option || response === undefined) {
        throw new Error("Select one of the decisions offered by this Codex approval request.");
      }
      if (request.approve !== (option.outcome === "approve")) {
        throw new Error("The selected Codex decision does not match the approval outcome.");
      }
      const status: ChatAppToolApproval["status"] = option.outcome === "approve"
        ? "approved"
        : option.outcome === "cancel"
          ? "cancelled"
          : "denied";
      await execution?.beforeApply(approval);
      if (this.codexApprovalResolvers.get(approval.id) !== resolver || resolver.submitted) {
        throw new Error("The native approval ended while its decision was being recorded.");
      }
      resolver.submitted = true;
      if (resolver.timer) {
        clearTimeout(resolver.timer);
        resolver.timer = undefined;
      }
      const now = new Date().toISOString();
      const completed: ChatAppToolApproval = { ...approval, status, updatedAt: now };
      upsertAppToolApproval(conversation, completed);
      conversation.updatedAt = now;
      await this.chat.store.saveConversation(conversation);
      return { approval: completed, option, response, resolver, method: approval.request.method };
    });
    selected.resolver.resolve(selected.response);
    void this.finishCodexApprovalDecision(
      conversation.id,
      selected.approval,
      selected.option.outcome,
      selected.resolver,
      progress
    ).catch((error) => {
      void this.deps.debugLogs.write("chat.codex-approval.completion.error", {
        conversationId: conversation.id,
        runId: selected.resolver.runId,
        approvalId: selected.approval.id,
        message: error instanceof Error ? error.message : String(error)
      });
    });
    void this.deps.debugLogs.write("chat.codex-approval.responded", {
      conversationId: conversation.id,
      runId: selected.resolver.runId,
      approvalId: selected.approval.id,
      method: selected.method,
      outcome: selected.option.outcome
    });
    if (execution?.awaitNativeDelivery) await selected.resolver.responseDelivered;
    return conversation;
  }

  private async finishCodexApprovalDecision(
    conversationId: string,
    approval: ChatAppToolApproval,
    outcome: ChatCodexApprovalOption["outcome"],
    resolver: CodexApprovalResolver,
    progress?: ProgressCallback
  ): Promise<void> {
    let delivery: CodexServerRequestDelivery;
    try {
      delivery = await resolver.responseDelivered;
    } catch (error) {
      resolver.cleanup();
      const message = `Codex could not receive this decision: ${error instanceof Error ? error.message : String(error)}`;
      if (isGuardianDeniedApproval(approval)) {
        await this.appendCodexContinuationStartFailure(conversationId, approval, message);
      } else {
        emitProgress(resolver.runId, progress, "error", message);
      }
      void this.deps.debugLogs.write("chat.codex-approval.delivery-failed", {
        conversationId,
        runId: resolver.runId,
        approvalId: approval.id,
        message
      });
      return;
    }
    resolver.cleanup();
    if (!isGuardianDeniedApproval(approval) || (outcome !== "approve" && outcome !== "deny")) {
      return;
    }
    // A decision that reached Codex while the original response was still
    // running is applied inside that response (an approved retry runs there);
    // a continuation would start a second turn and could run the retry twice.
    // Only a response that had already ended needs to be continued with it.
    if (delivery.turnActive) {
      void this.deps.debugLogs.write("chat.codex-approval.continuation-skipped", {
        conversationId,
        runId: resolver.runId,
        approvalId: approval.id,
        outcome,
        reason: "original-run-active"
      });
      return;
    }
    try {
      await this.autoResumeCodexGuardianDecision(conversationId, approval.id, progress);
    } catch (error) {
      const message = `Codex could not start the continuation: ${error instanceof Error ? error.message : String(error)}`;
      await this.appendCodexContinuationStartFailure(conversationId, approval, message);
      void this.deps.debugLogs.write("chat.codex-approval.continuation-start-failed", {
        conversationId,
        runId: resolver.runId,
        approvalId: approval.id,
        message
      });
    }
  }

  private async autoResumeCodexGuardianDecision(
    conversationId: string,
    approvalId: string,
    progress?: ProgressCallback
  ): Promise<void> {
    if (this.codexApprovalContinuations.has(approvalId)) {
      return;
    }
    this.codexApprovalContinuations.add(approvalId);
    let backgroundStarted = false;
    let releaseReservation: (() => void) | undefined;
    try {
      const ingest = await this.chat.activeRuns.withChatRunLock(conversationId, async () => {
        const conversation = await this.chat.store.requireChat(conversationId);
        const approval = chatAppToolApprovals(conversation).find((item) => item.id === approvalId);
        if (
          !approval ||
          (approval.status !== "approved" && approval.status !== "denied") ||
          !isGuardianDeniedApproval(approval) ||
          !approval.resumeContext
        ) {
          return;
        }
        const participant = chatParticipants(conversation).find((item) => item.id === approval.requesterParticipantId);
        const trigger = conversation.messages.find((message) => message.id === approval.resumeContext?.triggerMessageId);
        if (!participant) {
          throw new Error("The participant that requested this decision is no longer in the chat.");
        }
        if (!trigger) {
          throw new Error("The original request for this decision is no longer available.");
        }
        const instruction = approval.status === "approved"
          ? CHAT_CODEX_APPROVAL_CONTROL_APPROVE
          : CHAT_CODEX_APPROVAL_CONTROL_DENY;
        const controlMessage = createChatMessage("user", instruction, undefined, {
          threadId: trigger.metadata?.threadId ?? trigger.id,
          parentMessageId: trigger.id,
          chatThreadRootId: trigger.metadata?.chatThreadRootId,
          sourceMessageId: trigger.id,
          hiddenFromTimeline: true
        });
        const resumeRunId = randomUUID();
        const turnReservation = this.chat.turnQueue.reserveParticipantTurn(conversation.id, participant.id);
        releaseReservation = turnReservation.release;
        const pendingMessage = createChatMessage(
          "participant",
          "",
          { id: participant.id, kind: participant.kind, label: `@${participant.handle}`, model: participant.model },
          {
            threadId: controlMessage.metadata?.threadId ?? controlMessage.id,
            parentMessageId: controlMessage.id,
            chatThreadRootId: controlMessage.metadata?.chatThreadRootId,
            sourceMessageId: controlMessage.id,
            approvedContinuation: true,
            runId: resumeRunId,
            queuedBehind: turnReservation.queued ? { handle: participant.handle } : undefined,
            turnQueued: turnReservation.queued ? true : undefined
          },
          "pending"
        );
        this.chat.activeRuns.setTargetRunPendingMessageId(resumeRunId, pendingMessage.id);
        await this.chat.activeRuns.beginChatRun(conversation, resumeRunId);
        try {
          await this.chat.store.withChatMutation(conversation, async () => {
            conversation.messages.push(controlMessage, pendingMessage);
            recordLastMessageByParticipant(conversation, pendingMessage);
            conversation.updatedAt = new Date().toISOString();
            this.chat.store.queueSnapshot(conversation);
          });
          await this.chat.store.waitForQueuedSave(conversation.id);
        } catch (error) {
          await this.chat.activeRuns.endChatRun(conversation, resumeRunId);
          throw error;
        }
        return { conversation, approval, participant, controlMessage, pendingMessage, resumeRunId, turnReservation };
      });
      if (!ingest) {
        return;
      }
      backgroundStarted = true;
      releaseReservation = undefined;
      void this.runCodexGuardianDecisionContinuation(
        ingest.conversation,
        ingest.participant,
        ingest.controlMessage,
        ingest.pendingMessage,
        ingest.resumeRunId,
        ingest.turnReservation,
        approvalId,
        progress
      )
        .catch((error) => {
          void this.deps.debugLogs.write("chat.codex-approval.continuation.background.error", {
            conversationId,
            runId: ingest.resumeRunId,
            approvalId,
            message: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          this.codexApprovalContinuations.delete(approvalId);
        });
    } finally {
      if (!backgroundStarted) {
        releaseReservation?.();
        this.codexApprovalContinuations.delete(approvalId);
      }
    }
  }

  private async runCodexGuardianDecisionContinuation(
    conversation: Conversation,
    participant: ChatParticipant,
    controlMessage: ChatMessage,
    pendingMessage: ChatMessage,
    resumeRunId: string,
    turnReservation: ParticipantTurnReservation,
    approvalId: string,
    progress?: ProgressCallback
  ): Promise<void> {
    try {
      const messages = await this.chat.turnQueue.runParticipantTurnSerialized(
        conversation,
        participant,
        controlMessage,
        resumeRunId,
        undefined,
        progress,
        {
          continuation: true,
          warnings: [],
          existingPendingMessage: pendingMessage,
          turnReservation
        }
      );
      const participantRequestsToRun = await this.chat.store.withChatMutation(conversation, async () => {
        const toRun = await this.chat.pendingReplies.appendParticipantTurnMessages(conversation, participant, messages);
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
        return toRun;
      });
      this.chat.participantRequests.startDeferredParticipantRequestRunners(conversation.id, participantRequestsToRun);
      await this.chat.chatHistory.ensureHistoryFiles(conversation);
      emitProgress(resumeRunId, progress, "done", "Codex approval continuation finished.");
    } catch (error) {
      await this.chat.pendingReplies.finalizeFailedPrecreatedPendingMessage(conversation, pendingMessage.id, participant, error);
      await this.chat.store.withChatMutation(conversation, async () => {
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
      });
      emitChatRunFailure(resumeRunId, progress, error);
      void this.deps.debugLogs.write("chat.codex-approval.continuation.error", {
        conversationId: conversation.id,
        runId: resumeRunId,
        approvalId,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await this.chat.activeRuns.endChatRun(conversation, resumeRunId);
    }
  }

  private async appendCodexContinuationStartFailure(
    conversationId: string,
    approvalSnapshot: ChatAppToolApproval,
    message: string
  ): Promise<void> {
    await this.chat.activeRuns.withChatRunLock(conversationId, async () => {
      const conversation = await this.chat.store.requireChat(conversationId);
      const approval = chatAppToolApprovals(conversation).find((item) => item.id === approvalSnapshot.id) ?? approvalSnapshot;
      const participant = chatParticipants(conversation).find((item) => item.id === approval.requesterParticipantId);
      const trigger = conversation.messages.find((item) => item.id === approval.resumeContext?.triggerMessageId);
      const content = `@${approval.requesterHandle} could not continue after this ${approval.status === "approved" ? "approval" : "denial"}: ${sanitizeWarningText(message)}`;
      const failure = participant
        ? createChatMessage(
            "participant",
            content,
            { id: participant.id, kind: participant.kind, label: `@${participant.handle}`, model: participant.model },
            {
              threadId: trigger?.metadata?.threadId ?? trigger?.id ?? "system",
              parentMessageId: trigger?.id,
              chatThreadRootId: trigger?.metadata?.chatThreadRootId,
              sourceMessageId: trigger?.id,
              runId: randomUUID()
            },
            "error"
          )
        : createChatMessage("system", content, undefined, { threadId: trigger?.metadata?.threadId ?? "system" });
      await this.chat.store.withChatMutation(conversation, async () => {
        conversation.messages.push(failure);
        if (participant) {
          recordLastMessageByParticipant(conversation, failure);
        }
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
      });
    });
  }

  private async markCodexApprovalTerminal(
    conversation: Conversation,
    approvalId: string,
    reason: string,
    status: Extract<ChatAppToolApproval["status"], "cancelled" | "expired">
  ): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      const approval = chatAppToolApprovals(conversation).find((item) => item.id === approvalId);
      if (!approval || approval.status !== "pending" || !isCodexApprovalRequest(approval.request)) {
        return;
      }
      const now = new Date().toISOString();
      upsertAppToolApproval(conversation, {
        ...approval,
        status,
        updatedAt: now,
        error: reason
      });
      conversation.updatedAt = now;
      await this.chat.store.saveConversation(conversation);
    });
  }

  expireOrphanedCodexApprovals(
    conversation: Conversation,
    reason = "The Codex app-server connection that requested this approval is no longer active."
  ): boolean {
    const approvals = chatAppToolApprovals(conversation);
    const now = new Date().toISOString();
    let changed = false;
    const nextApprovals = approvals.map((approval) => {
      if (
        approval.status !== "pending" ||
        approval.toolName !== CODEX_APPROVAL_TOOL_NAME ||
        !isCodexApprovalRequest(approval.request) ||
        this.codexApprovalResolvers.has(approval.id)
      ) {
        return approval;
      }
      changed = true;
      return {
        ...approval,
        status: "expired" as const,
        error: reason,
        updatedAt: now
      };
    });
    if (!changed) {
      return false;
    }
    conversation.metadata = {
      ...conversation.metadata,
      pendingAppToolApprovals: nextApprovals
    };
    return true;
  }
}
