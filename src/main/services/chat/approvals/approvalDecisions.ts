import { CLAUDE_PLAN_KEEP_PLANNING_ID, isClaudePlanApprovalRequest } from "../../../../shared/claudePlanApproval";
import { randomUUID } from "node:crypto";
import type { HubApprovalCardAnswer } from "../../../../shared/hubCards";
import type {
  ChatAppToolApproval, ChatParticipant, ChatRosterChangeRequest, Conversation, RespondToChatAppToolApprovalRequest
} from "../../../../shared/types";
import { CODEX_APPROVAL_TOOL_NAME } from "../../codexApprovals";
import {
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_CHAT_REQUEST_COMPACTION_TOOL, APP_CONNECTOR_SIGN_IN_TOOL,
  APP_PERMISSIONS_REQUEST_CHANGE_TOOL, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_ROLES_REQUEST_CHANGE_TOOL,
  APP_ROSTER_REQUEST_CHANGE_TOOL, APP_TOOL_PERMISSION_TOOL, APP_SCRIPTS_REQUEST_CHANGE_TOOL
} from "../../appMcp";
import { isConnectorSignInRequest } from "../../../../shared/connectorSignIn";
import {
  chatAppToolApprovals, isCodexApprovalRequest, isParticipantRemovalRequest, isParticipantRequestApprovalRequest,
  isRoleParticipantChangeRequest, isScriptChangeRequest, isSelfCompactionRequest, isToolPermissionRequest,
  permissionApprovalResumeRunId, upsertAppToolApproval
} from "./approvalRecords";
import { applyPreparedPermissionChange, formatPermissionChangeGrantList, preparePermissionChange } from "./permissionGrants";
import type { PreparedPermissionChange } from "./types";
import { recordSelfCompactionRequested, selfCompactionRequestGuard } from "../compaction/compactionText";
import { selfCompactionResumeFrom } from "../compaction/selfCompactionMarks";
import { chatParticipants, formatHandleList, setParticipantCompactionPermission } from "../members/identity";
import { memberRemovalHandles, upsertRosterChatPolicy } from "../members/removalRules";
import {
  normalizeParticipantChangeRequest, normalizeRoleChangeRequest, normalizeRoleParticipantChangeRequest
} from "../members/rosterRequests";
import {
  applyParticipantRequestApprovalDecision, participantRequestApprovalTargetIds, participantRequestHasUnfinishedItems,
  resolveParticipantRequestApprovalItems, resolveParticipantRequestTargetItem, terminalParticipantRequestBatch
} from "../requests/requestRecords";
import { createChatMessage } from "../store/messages";
import { emitProgress } from "../turns/replyMessages";
import type {
  ChatApprovalExecutionGuard, PreparedParticipantChange, PreparedRoleChange, PreparedRoleParticipantChange, PreparedRosterChange,
  ProgressCallback
} from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

export interface ChatAppToolApprovalDecisionEvent {
  conversationId: string;
  approval: ChatAppToolApproval;
  status: Extract<ChatAppToolApproval["status"], "approved" | "denied">;
}

/** The User's decision on any approval card, and what a turn's end does to open ones. */
export class ApprovalDecisions {
  private readonly appToolApprovalDecisionListeners = new Set<(event: ChatAppToolApprovalDecisionEvent) => Promise<void> | void>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "codexApprovals" | "connectorSignIns" | "host" | "participantRequests" | "permissionRequests" | "queuedRosterChanges"
      | "requestGrants" | "requestRecovery" | "requesterResumes" | "rosterChanges" | "scheduledTasks" | "selfCompaction"
      | "selfCompactionResumes" | "serverCards" | "store" | "toolPermissions"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "storage">
  ) {}

  onAppToolApprovalDecision(listener: (event: ChatAppToolApprovalDecisionEvent) => Promise<void> | void): () => void {
    this.appToolApprovalDecisionListeners.add(listener);
    return () => {
      this.appToolApprovalDecisionListeners.delete(listener);
    };
  }

  async emitAppToolApprovalDecision(event: ChatAppToolApprovalDecisionEvent): Promise<void> {
    for (const listener of this.appToolApprovalDecisionListeners) {
      try {
        await listener(event);
      } catch (error) {
        await this.deps.debugLogs.write("chat.app-tool-approval-decision-listener.error", {
          conversationId: event.conversationId,
          approvalId: event.approval.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  async respondToAppToolApproval(
    request: RespondToChatAppToolApprovalRequest,
    progress?: ProgressCallback,
    execution?: ChatApprovalExecutionGuard
  ): Promise<Conversation | undefined> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return conversation;
    }
    const approval = chatAppToolApprovals(conversation).find((item) => item.id === request.approvalId);
    if (!approval) {
      throw new Error("App tool approval request was not found.");
    }
    // A card a member on another device raised is answered on the User's
    // server and applied there (answerAppToolApprovalCard), never here.
    if (approval.homeMachineId && approval.homeMachineId !== this.chat.host.hostMachineId) {
      throw new Error("This request is answered on the device its member runs on.");
    }
    const approvalOwner = chatParticipants(conversation).find(item => item.id === approval.requesterParticipantId);
    if (approvalOwner) this.chat.host.assertOwnsParticipant(approvalOwner);
    if (approval.toolName === APP_TOOL_PERMISSION_TOOL && isToolPermissionRequest(approval.request)) {
      return this.chat.toolPermissions.respondToToolPermissionApproval(request, execution);
    }
    if (approval.toolName === APP_CONNECTOR_SIGN_IN_TOOL && isConnectorSignInRequest(approval.request)) {
      return this.chat.connectorSignIns.respondToConnectorSignInApproval(request, execution);
    }
    if (approval.status !== "pending") {
      throw new Error("App tool approval request has already been answered.");
    }
    if (approval.toolName === CODEX_APPROVAL_TOOL_NAME && isCodexApprovalRequest(approval.request)) {
      return this.chat.codexApprovals.respondToCodexApproval(conversation, request, progress, execution);
    }
    const now = new Date().toISOString();
    if (!request.approve) {
      await execution?.beforeApply(approval);
      if (approval.toolName === APP_SCRIPTS_REQUEST_CHANGE_TOOL && isScriptChangeRequest(approval.request)) {
        await this.chat.scheduledTasks.scriptHost?.rejectPending(approval.request);
      }
      const deniedApproval: ChatAppToolApproval = {
        ...approval,
        status: "denied",
        updatedAt: now
      };
      await this.chat.store.saveChatChange(conversation, () => {
        if (approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL && isParticipantRequestApprovalRequest(approval.request)) {
          applyParticipantRequestApprovalDecision(conversation, approval, "denied", request.scope);
        }
        upsertAppToolApproval(conversation, deniedApproval);
        if (approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL && isParticipantRemovalRequest(approval.request)) {
          // The asking member reads this in the chat: nothing was removed.
          const handles = memberRemovalHandles(approval.request);
          conversation.messages.push(createChatMessage(
            "system",
            `User declined @${approval.requesterHandle}'s request to remove ${handles}. ${handles} ${approval.request.operations.length === 1 ? "stays" : "stay"} in this chat.`,
            undefined,
            { threadId: "system" }
          ));
        }
      });
      await this.emitAppToolApprovalDecision({
        conversationId: conversation.id,
        approval: deniedApproval,
        status: "denied"
      });
      if (approval.toolName === APP_CHAT_REQUEST_COMPACTION_TOOL) {
        this.chat.selfCompactionResumes.continueFromCompactionCard(conversation.id, approval, { kind: "declined" });
      }
      const deniedParticipantRequest = isParticipantRequestApprovalRequest(approval.request) ? approval.request : undefined;
      if (approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL && deniedParticipantRequest?.requestMessageId) {
        const requestMessageId = deniedParticipantRequest.requestMessageId;
        void this.chat.requesterResumes.autoResumeParticipantRequest(conversation.id, requestMessageId, progress).catch((error) => {
          void this.deps.debugLogs.write("chat.participant-request.deny-auto-resume.error", {
            conversationId: conversation.id,
            requestMessageId,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
      return conversation;
    }

    if (approval.toolName === APP_SCRIPTS_REQUEST_CHANGE_TOOL && isScriptChangeRequest(approval.request)) {
      const host = this.chat.scheduledTasks.scriptHost;
      if (!host) {
        throw new Error("Scheduled tasks are not available on this host.");
      }
      // A script approval is always for this one proposal: never "for this
      // chat", never with an edited draft. Missing keys keep it pending.
      await host.assertApprovable(approval.request);
      await execution?.beforeApply(approval);
      const appliedSummary = await host.applyApproved(approval.request);
      await this.chat.store.withChatMutation(conversation, async () => {
        const current = chatAppToolApprovals(conversation).find((item) => item.id === approval.id) ?? approval;
        upsertAppToolApproval(conversation, {
          ...current,
          status: "approved",
          approvalScope: "once",
          updatedAt: new Date().toISOString()
        });
        conversation.messages.push(createChatMessage("system", appliedSummary, undefined, { threadId: "system" }));
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
      });
      return conversation;
    }

    const scope = request.scope === "chat" ? "chat" : "once";
    // Keyed on the stored request, before the draft-override branches below:
    // a removal card is approved as shown, never turned into another change.
    if (approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL && isParticipantRemovalRequest(approval.request)) {
      return this.chat.queuedRosterChanges.approveParticipantRemoval(conversation, approval, approval.request, execution);
    }
    if (approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL && isParticipantRequestApprovalRequest(approval.request)) {
      await execution?.beforeApply(approval);
      const participantScope = approval.request.source === "inferred" ? "once" : scope;
      const participantRequest = approval.request;
      const requestMessageId = participantRequest.requestMessageId;
      await this.chat.store.saveChatChange(conversation, () => {
        upsertAppToolApproval(conversation, {
          ...approval,
          status: "approved",
          approvalScope: participantScope,
          appliedParticipantIds: participantRequestApprovalTargetIds(conversation, participantRequest),
          updatedAt: now
        });
        if (participantScope === "chat") {
          this.chat.requestGrants.setParticipantRequestPermission(conversation, approval.requesterParticipantId, "allow");
        }
        if (requestMessageId) {
          applyParticipantRequestApprovalDecision(conversation, approval, "approved", participantScope);
        }
      });
      if (requestMessageId) {
        const batch = conversation.messages.find((message) => message.id === requestMessageId)?.metadata?.participantRequest;
        const runner = this.chat.participantRequests.startParticipantRequestRunner(conversation.id, requestMessageId, batch?.depth ?? 1, progress);
        this.chat.participantRequests.resumeRequesterWhenRunnerSettles(conversation.id, requestMessageId, runner, progress);
      }
      return conversation;
    }

    if (approval.toolName === APP_CHAT_REQUEST_COMPACTION_TOOL && isSelfCompactionRequest(approval.request)) {
      const requester = chatParticipants(conversation).find((participant) => participant.id === approval.requesterParticipantId);
      const guard = requester
        ? selfCompactionRequestGuard(conversation, requester, approval.id)
        : { status: "rejected", error: "The requesting member is no longer in this chat." };
      if (!requester || guard) {
        await this.chat.store.saveChatChange(conversation, () => {
          upsertAppToolApproval(conversation, {
            ...approval,
            status: "denied",
            updatedAt: now,
            error: guard?.error ?? "The requesting member is no longer in this chat."
          });
        });
        if (requester) this.chat.selfCompactionResumes.continueFromCompactionCard(conversation.id, approval, { kind: "failed", reason: guard?.error });
        return conversation;
      }
      await execution?.beforeApply(approval);
      const runId = randomUUID();
      await this.chat.store.saveChatChange(conversation, () => {
        if (scope === "chat") {
          setParticipantCompactionPermission(conversation, requester.id, "allow");
        }
        recordSelfCompactionRequested(conversation, requester.id, now);
        upsertAppToolApproval(conversation, {
          ...approval,
          status: "approved",
          approvalScope: scope,
          appliedParticipantIds: [requester.id],
          updatedAt: now
        });
      });
      const resume = selfCompactionResumeFrom(approval.resumeContext);
      this.chat.selfCompaction.startQueuedSelfCompaction(conversation, requester, approval.request, runId, resume && { ...resume, since: now });
      return conversation;
    }

    if (
      approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL &&
      isRoleParticipantChangeRequest(request.draftOverride ?? approval.request)
    ) {
      let prepared: PreparedRoleParticipantChange;
      try {
        prepared = await this.chat.rosterChanges.prepareRoleParticipantChange(
          conversation,
          normalizeRoleParticipantChangeRequest(request.draftOverride ?? approval.request)
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.chat.store.saveChatChange(conversation, () => {
          upsertAppToolApproval(conversation, {
            ...approval,
            status: "denied",
            updatedAt: now,
            error: message
          });
          conversation.messages.push(createChatMessage("system", `Could not approve role and member request from @${approval.requesterHandle}: ${message}`, undefined, {
            threadId: "system"
          }));
        });
        return conversation;
      }
      await execution?.beforeApply(approval);
      await this.chat.store.saveChatChange(conversation, async () => {
        const applied = await this.chat.rosterChanges.applyPreparedRoleParticipantChange(conversation, prepared);
        upsertAppToolApproval(conversation, {
          ...approval,
          status: "approved",
          request: applied.request,
          approvalScope: "chat",
          appliedParticipantIds: applied.participants.map((participant) => participant.id),
          updatedAt: now
        });
        conversation.messages.push(createChatMessage(
          "system",
          `Applied role and member request from @${approval.requesterHandle}: ${applied.summary}.`,
          undefined,
          { threadId: "system" }
        ));
      });
      return conversation;
    }

    if (approval.toolName === APP_ROLES_REQUEST_CHANGE_TOOL) {
      let prepared: PreparedRoleChange;
      try {
        prepared = await this.chat.rosterChanges.prepareRoleChange(normalizeRoleChangeRequest(request.draftOverride ?? approval.request));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.chat.store.saveChatChange(conversation, () => {
          upsertAppToolApproval(conversation, {
            ...approval,
            status: "denied",
            updatedAt: now,
            error: message
          });
          conversation.messages.push(createChatMessage("system", `Could not approve role request from @${approval.requesterHandle}: ${message}`, undefined, {
            threadId: "system"
          }));
        });
        return conversation;
      }
      await execution?.beforeApply(approval);
      const appliedRoles = await this.chat.rosterChanges.applyPreparedRoleChange(prepared);
      await this.chat.store.saveChatChange(conversation, () => {
        upsertAppToolApproval(conversation, {
          ...approval,
          status: "approved",
          request: prepared.request,
          approvalScope: "chat",
          updatedAt: now
        });
        conversation.messages.push(createChatMessage(
          "system",
          `Applied role request from @${approval.requesterHandle}: ${formatHandleList(appliedRoles.map((role) => `"${role.label}"`))}.`,
          undefined,
          { threadId: "system" }
        ));
      });
      return conversation;
    }

    if (approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL) {
      let prepared: PreparedParticipantChange;
      try {
        prepared = await this.chat.rosterChanges.prepareParticipantChange(conversation, normalizeParticipantChangeRequest(request.draftOverride ?? approval.request));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.chat.store.saveChatChange(conversation, () => {
          upsertAppToolApproval(conversation, {
            ...approval,
            status: "denied",
            updatedAt: now,
            error: message
          });
          conversation.messages.push(createChatMessage("system", `Could not approve member request from @${approval.requesterHandle}: ${message}`, undefined, {
            threadId: "system"
          }));
        });
        return conversation;
      }
      await execution?.beforeApply(approval);
      await this.chat.store.saveChatChange(conversation, async () => {
        const applied = await this.chat.rosterChanges.applyPreparedParticipantChange(conversation, prepared);
        upsertAppToolApproval(conversation, {
          ...approval,
          status: "approved",
          request: prepared.request,
          approvalScope: "chat",
          appliedParticipantIds: applied.map((participant) => participant.id),
          updatedAt: now
        });
        conversation.messages.push(createChatMessage(
          "system",
          `Applied member request from @${approval.requesterHandle}: ${prepared.summary}.`,
          undefined,
          { threadId: "system" }
        ));
      });
      return conversation;
    }

    const isPermissionApproval = approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL;
    const requester = chatParticipants(conversation).find((participant) => participant.id === approval.requesterParticipantId);
    let prepared: PreparedPermissionChange | PreparedRosterChange | undefined;
    try {
      prepared = isPermissionApproval
        ? preparePermissionChange(requester, approval.request)
        : await this.chat.rosterChanges.prepareRosterChange(conversation, approval.request as ChatRosterChangeRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.chat.store.saveChatChange(conversation, () => {
        upsertAppToolApproval(conversation, {
          ...approval,
          status: "denied",
          updatedAt: now
        });
        conversation.messages.push(createChatMessage(
          "system",
          `Could not approve app tool request from @${approval.requesterHandle}: ${message}`,
          undefined,
          { threadId: "system" }
        ));
      });
      return conversation;
    }
    if (!prepared) {
      return conversation;
    }
    await execution?.beforeApply(approval);
    const updatedApproval = await this.chat.store.saveChatChange(conversation, () => {
      const applied = isPermissionApproval
        ? scope === "once"
          ? [requester].filter((participant): participant is ChatParticipant => Boolean(participant))
          : [applyPreparedPermissionChange(conversation, approval.requesterParticipantId, prepared as PreparedPermissionChange)]
        : this.chat.rosterChanges.applyPreparedRosterChange(conversation, prepared as PreparedRosterChange);
      const updatedApproval: ChatAppToolApproval = {
        ...approval,
        status: "approved",
        request: isPermissionApproval ? (prepared as PreparedPermissionChange).request : approval.request,
        approvalScope: scope,
        appliedParticipantIds: applied.map((participant) => participant.id),
        updatedAt: now
      };
      upsertAppToolApproval(conversation, updatedApproval);
      if (scope === "chat" && approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL) {
        upsertRosterChatPolicy(conversation, approval, now);
      }
      const permissionGrantList = isPermissionApproval
        ? formatPermissionChangeGrantList((prepared as PreparedPermissionChange).request)
        : undefined;
      const approvalMessage = isPermissionApproval
        ? scope === "chat"
          ? `Granted @${approval.requesterHandle} ${permissionGrantList} for this chat.`
          : `Granted @${approval.requesterHandle} ${permissionGrantList} once.`
        : scope === "chat"
          ? `Allowed for this chat and applied app tool request from @${approval.requesterHandle}: ${approval.summary}.`
          : `Allowed once and applied app tool request from @${approval.requesterHandle}: ${approval.summary}.`;
      conversation.messages.push(createChatMessage(
        "system",
        approvalMessage,
        undefined,
        { threadId: "system" }
      ));
      return updatedApproval;
    });
    if (isPermissionApproval) {
      await this.emitAppToolApprovalDecision({
        conversationId: conversation.id,
        approval: updatedApproval,
        status: "approved"
      });
    }
    if (isPermissionApproval && updatedApproval.resumeContext && updatedApproval.resumeContext.remoteRun !== true) {
      void this.chat.permissionRequests.autoResumePermissionApproval(conversation.id, updatedApproval.id, progress).catch((error) => {
        // Said on the resume's own run: the asking run has ended.
        emitProgress(permissionApprovalResumeRunId(updatedApproval.id), progress, "error", error instanceof Error ? error.message : String(error));
        void this.deps.debugLogs.write("chat.permission-approval.auto-resume.error", {
          conversationId: conversation.id,
          approvalId: updatedApproval.id,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return conversation;
  }

  resolveSupersededParticipantInteractions(
    conversation: Conversation,
    participantId: string,
    excludeMessageId?: string
  ): boolean {
    const now = new Date().toISOString();
    const reason = "Superseded by a newer turn from this member.";
    let changed = false;
    for (const message of conversation.messages) {
      if (message.id === excludeMessageId || !message.metadata) {
        continue;
      }
      let metadata = message.metadata;
      if (message.participantId === participantId) {
        if (metadata.pendingMentions?.some((mention) => mention.status === "pending")) {
          metadata = {
            ...metadata,
            pendingMentions: metadata.pendingMentions.map((mention) =>
              mention.status === "pending" ? { ...mention, status: "rejected" as const } : mention
            )
          };
          changed = true;
        }
      }
      const batch = metadata.participantRequest;
      if (batch?.requesterParticipantId === participantId
        && participantRequestHasUnfinishedItems(batch)
        // A new turn from the requester does not cancel a delegation that is
        // still being worked on. Asking a member for its status IS a new turn,
        // and this used to mark every request it had issued as interrupted —
        // the work carried on while the User was told it had been interrupted.
        // Only an interaction that can no longer make progress is closed here;
        // an explicit Stop still closes it through its own path.
        && !this.chat.requestRecovery.participantRequestIsStillRunning(conversation, batch)) {
        const nextBatch = terminalParticipantRequestBatch(batch, "interrupted", reason, now);
        if (nextBatch !== batch) {
          metadata = {
            ...metadata,
            participantRequest: nextBatch
          };
          changed = true;
        }
      }
      if (metadata !== message.metadata) {
        message.metadata = metadata;
      }
    }
    return changed;
  }

  markPendingAppToolApprovalsForRunTerminal(
    conversation: Conversation,
    runId: string,
    reason: string,
    /** A turn that failed on its own; otherwise a Stop or a quit ended it. */
    failed = false,
    now = new Date().toISOString()
  ): boolean {
    const approvals = chatAppToolApprovals(conversation);
    let changed = false;
    const nextApprovals = approvals.map((approval) => {
      if (approval.status !== "pending" || approval.resumeContext?.runId !== runId) {
        return approval;
      }
      // A compaction card outlives a turn that failed (compacting may be what
      // helps); a Stop or a quit closes it with the work it was for.
      if (failed && approval.toolName === APP_CHAT_REQUEST_COMPACTION_TOOL) {
        return approval;
      }
      changed = true;
      if (approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL && isParticipantRequestApprovalRequest(approval.request)) {
        resolveParticipantRequestApprovalItems(conversation, approval, "interrupted", reason, now);
      } else if (approval.resumeContext?.participantRequestBatchId) {
        resolveParticipantRequestTargetItem(
          conversation,
          approval.resumeContext.participantRequestBatchId,
          approval.requesterParticipantId,
          "interrupted",
          reason,
          now
        );
      }
      if (approval.toolName === APP_TOOL_PERMISSION_TOOL && isToolPermissionRequest(approval.request)) {
        this.chat.toolPermissions.resolveToolPermissionApproval(approval.id, {
          approve: false,
          source: "abort",
          reason
        });
      }
      if (approval.toolName === APP_CONNECTOR_SIGN_IN_TOOL) {
        // Closed with the member's turn, not declined by the User.
        this.chat.toolPermissions.resolveToolPermissionApproval(approval.id, { approve: false, source: "abort", reason });
        return {
          ...approval,
          status: /stop|cancel/i.test(reason) ? "cancelled" as const : "expired" as const,
          error: reason,
          updatedAt: now
        };
      }
      if (approval.toolName === CODEX_APPROVAL_TOOL_NAME && isCodexApprovalRequest(approval.request)) {
        const resolver = this.chat.codexApprovals.codexApprovalResolvers.get(approval.id);
        if (resolver) {
          resolver.cleanup();
          resolver.reject(new Error(reason));
        }
        return {
          ...approval,
          status: /stop|cancel/i.test(reason) ? "cancelled" as const : "expired" as const,
          error: reason,
          updatedAt: now
        };
      }
      return {
        ...approval,
        // Withdrawn with the turn, not the User's Not now.
        status: approval.toolName === APP_CHAT_REQUEST_COMPACTION_TOOL ? "cancelled" as const : "denied" as const,
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

  /** The User's answer to an app-tool approval (a permission or a roster
   *  change), from this device's card: written to the User's server. */
  async answerAppToolApprovalCard(request: RespondToChatAppToolApprovalRequest): Promise<void> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "chat") throw new Error("The chat is not available.");
    const approval = chatAppToolApprovals(conversation).find((item) => item.id === request.approvalId);
    if (!approval) throw new Error("App tool approval request was not found.");
    if (approval.status !== "pending" || approval.machineDecisionPending) throw new Error("App tool approval request has already been answered.");
    // Claude Code's plan approval: Activity's Deny is the CLI's "No, keep
    // planning" without words.
    const planDecision = request.planDecision ??
      (!request.approve && isClaudePlanApprovalRequest(approval.request) ? { optionId: CLAUDE_PLAN_KEEP_PLANNING_ID } : undefined);
    const answer: HubApprovalCardAnswer = {
      approve: request.approve,
      ...(request.scope === "once" || request.scope === "chat" ? { scope: request.scope } : {}),
      ...(request.codexDecisionId ? { codexDecisionId: request.codexDecisionId } : {}),
      ...(request.draftOverride ? { draftOverride: request.draftOverride } : {}),
      ...(planDecision ? { planDecision: { optionId: planDecision.optionId, ...(planDecision.feedback ? { feedback: planDecision.feedback } : {}) } } : {})
    };
    await this.chat.serverCards.answerServerCard({ conversationId: conversation.id, cardId: approval.id, answer: answer as unknown as Record<string, unknown>,
      raisedHere: this.chat.serverCards.cardRaisedHere(conversation, approval.id) });
  }
}
