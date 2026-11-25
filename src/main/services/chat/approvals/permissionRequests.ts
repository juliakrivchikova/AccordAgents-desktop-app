import type {
  ChatAgentPermissions, ChatAppToolApproval, ChatMessage, ChatParticipant, ChatParticipantRequestPermission,
  ChatParticipantRequestBatch, ChatParticipantSession, ChatPermissionRequestToolResult, Conversation
} from "../../../../shared/types";
import { participantRequestVisibleRootId } from "../../../../shared/chatParticipantRequestThreads";
import { normalizeChatAgentPermissions, resolveChatManageRolesParticipantsPermission } from "../../../../shared/agentPermissions";
import { hasChatAppToolCapability, normalizeChatAppToolCapabilities } from "../../../../shared/appTools";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "../../appMcp";
import {
  chatAppToolApprovals, hasPendingPermissionApprovalForResume, isPermissionChangeRequest, permissionApprovalResumeRunId
} from "./approvalRecords";
import {
  applyPermissionChangeRequestFromTool, applyPermissionChangeToPermissions, oneTimePermissionApprovalsForParticipant
} from "./permissionGrants";
import { chatParticipants, participantForRun } from "../members/identity";
import {
  applyPermissionResumeToParticipantRequest, participantRequestMessageForResumeContext, participantRequestResumeDepth
} from "../requests/requestRecords";
import { createChatMessage } from "../store/messages";
import { emitChatRunFailure, emitProgress } from "../turns/replyMessages";
import type { ChatAppMcpActor, ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Members' requests for more access, and the turn that goes on once they are decided. */
export class PermissionRequests {
  /** Once-only permission approvals applied by a turn still running, by run. */
  readonly oneTimeApprovalClaims = new Map<string, string>();
  private readonly permissionApprovalAutoResumes = new Set<string>();
  /** Requests whose member's answer is waited for here outside a runner (a
   *  permission approval's resume): a sweep leaves them open. */
  readonly heldParticipantRequests = new Set<string>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "agentEnvironment" | "chatHistory" | "host" | "participantRequests" | "pendingReplies"
      | "requesterResumes" | "selfCompaction" | "store" | "turnQueue"
    >,
    private readonly deps: Pick<ChatDependencies, "appMcp" | "debugLogs">
  ) {}

  async requestPermissionChangeFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<ChatPermissionRequestToolResult> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    this.chat.host.assertOwnsParticipant(requester);
    if (!hasChatAppToolCapability(actor.capabilities, "permissions.request")) {
      throw new Error("The issued app-tool token does not grant permission requests.");
    }

    // Decided and recorded on the chat as saved now, through the queue: the
    // read above can be older than a member change the User saved meanwhile.
    const applied = await this.chat.store.withChatMutation(conversation, async () => {
      const requesterNow = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
      if (!requesterNow) {
        throw new Error("The requesting member is no longer in this chat.");
      }
      const outcome = await applyPermissionChangeRequestFromTool(conversation, requesterNow, actor, rawRequest);
      if (outcome.mutated) {
        await this.chat.store.saveConversation(conversation);
      }
      return outcome;
    });
    return applied.result;
  }

  async manageRolesParticipantsPermissionForParticipant(participant: ChatParticipant): Promise<ChatParticipantRequestPermission> {
    const role = await this.chat.agentEnvironment.resolvedRoleForParticipant(participant);
    return resolveChatManageRolesParticipantsPermission(
      role?.participantDefaults?.manageRolesParticipants,
      normalizeChatAgentPermissions(participant.permissions).manageRolesParticipants
    ).effective;
  }

  canRequestPermissionChanges(session: ChatParticipantSession): boolean {
    return Boolean(this.deps.appMcp) && hasChatAppToolCapability([
      ...normalizeChatAppToolCapabilities(session.roleAppToolCapabilities),
      "permissions.request"
    ], "permissions.request");
  }

  async autoResumePermissionApproval(
    conversationId: string,
    approvalId: string,
    progress?: ProgressCallback
  ): Promise<void> {
    const approvalResumeKey = `approval:${approvalId}`;
    if (this.permissionApprovalAutoResumes.has(approvalResumeKey)) {
      return;
    }
    this.permissionApprovalAutoResumes.add(approvalResumeKey);
    const resumeKeys = [approvalResumeKey];
    let backgroundStarted = false;
    try {
      const ingest = await this.chat.activeRuns.withChatRunLock(conversationId, async () => {
        const conversation = await this.chat.store.requireChat(conversationId);
        const approval = chatAppToolApprovals(conversation).find((item) => item.id === approvalId);
        if (
          !approval ||
          approval.status !== "approved" ||
          approval.toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL ||
          !approval.resumeContext ||
          !isPermissionChangeRequest(approval.request)
        ) {
          return;
        }
        if (hasPendingPermissionApprovalForResume(conversation, approval)) {
          return;
        }
        const requester = chatParticipants(conversation).find((participant) => participant.id === approval.requesterParticipantId);
        const trigger = conversation.messages.find((message) => message.id === approval.resumeContext?.triggerMessageId);
        if (!requester || !trigger || !this.chat.host.ownsParticipant(requester)) {
          return;
        }
        const participantRequestMessage = approval.resumeContext.participantRequestBatchId
          ? participantRequestMessageForResumeContext(
              conversation,
              approval.resumeContext.triggerMessageId,
              approval.resumeContext.participantRequestBatchId
            )
          : undefined;
        const participantRequestBatch = participantRequestMessage?.metadata?.participantRequest;
        const participantRequestRootId = participantRequestMessage
          ? participantRequestVisibleRootId(conversation.messages, participantRequestMessage)
          : undefined;
        const resumeTrigger: ChatMessage = participantRequestMessage
          ? {
              ...trigger,
              metadata: {
                ...trigger.metadata,
                chatThreadRootId: participantRequestRootId
              }
            }
          : trigger;
        const triggerResumeKey = `trigger:${conversation.id}:${approval.requesterParticipantId}:${trigger.id}`;
        if (this.permissionApprovalAutoResumes.has(triggerResumeKey)) {
          return;
        }
        this.permissionApprovalAutoResumes.add(triggerResumeKey);
        resumeKeys.push(triggerResumeKey);
        // Never the run that asked: its turn on the server is over.
        const resumeRunId = permissionApprovalResumeRunId(approval.id);
        const participantLabel = `@${requester.handle}`;
        emitProgress(resumeRunId, progress, "initial", `Resuming ${participantLabel} after permission approval.`, {
          participantLabel
        });
        const now = new Date().toISOString();
        conversation.messages.push(createChatMessage(
          "system",
          `Auto-resumed @${requester.handle} after permission approval.`,
          undefined,
          {
            threadId: trigger.metadata?.threadId ?? trigger.id,
            parentMessageId: trigger.id,
            chatThreadRootId: participantRequestRootId ?? trigger.metadata?.chatThreadRootId,
            sourceMessageId: trigger.id
          }
        ));
        await this.chat.activeRuns.beginChatRun(conversation, resumeRunId, [requester.id]);
        return {
          conversation,
          approval,
          requester,
          trigger: resumeTrigger,
          participantRequestMessage,
          participantRequestBatch,
          resumeRunId
        };
      });

      if (!ingest) {
        return;
      }
      backgroundStarted = true;
      void this.runPermissionApprovalResumeFlow(
        ingest.conversation,
        ingest.approval,
        ingest.requester,
        ingest.trigger,
        ingest.participantRequestMessage,
        ingest.participantRequestBatch,
        ingest.resumeRunId,
        progress
      )
        .catch((error) => {
          void this.deps.debugLogs.write("chat.permission-approval.auto-resume.error", {
            conversationId,
            approvalId,
            message: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          for (const key of resumeKeys) {
            this.permissionApprovalAutoResumes.delete(key);
          }
        });
    } finally {
      if (!backgroundStarted) {
        for (const key of resumeKeys) {
          this.permissionApprovalAutoResumes.delete(key);
        }
      }
    }
  }

  private async runPermissionApprovalResumeFlow(
    conversation: Conversation,
    approval: ChatAppToolApproval,
    requester: ChatParticipant,
    trigger: ChatMessage,
    participantRequestMessage: ChatMessage | undefined,
    participantRequestBatch: ChatParticipantRequestBatch | undefined,
    resumeRunId: string,
    progress?: ProgressCallback
  ): Promise<void> {
    if (participantRequestMessage) this.heldParticipantRequests.add(participantRequestMessage.id);
    try {
      const messages = await this.chat.turnQueue.runParticipantTurnSerialized(conversation, requester, trigger, resumeRunId, undefined, progress, {
        warnings: [],
        ownServerTurn: true,
        participantRequestDepth: participantRequestBatch
          ? participantRequestResumeDepth(participantRequestBatch, requester.id)
          : undefined,
        participantRequestBatchId: participantRequestBatch?.id,
        chainRootId: participantRequestBatch?.chainRootId
      });
      const { participantRequestsToRun, participantRequestResumeMessageId } = await this.chat.store.withChatMutation(conversation, async () => {
        const toRun = await this.chat.pendingReplies.appendParticipantTurnMessages(conversation, requester, messages);
        // It compacts its own context next: its answer is the turn after that.
        const resumeMessageId = participantRequestMessage && participantRequestBatch && !messages[0]?.metadata?.selfCompaction
          ? applyPermissionResumeToParticipantRequest(conversation, participantRequestMessage.id, participantRequestBatch.id, requester, messages)
          : undefined;
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
        return { participantRequestsToRun: toRun, participantRequestResumeMessageId: resumeMessageId };
      });
      this.chat.participantRequests.startDeferredParticipantRequestRunners(conversation.id, participantRequestsToRun);
      await this.chat.chatHistory.ensureHistoryFiles(conversation);
      emitProgress(resumeRunId, progress, "done", "Permission approval resume finished.");
      const compacting = messages[0];
      if (participantRequestMessage && participantRequestBatch && compacting?.metadata?.selfCompaction) {
        const through = await this.chat.selfCompaction.answerThroughSelfCompactions(conversation.id, requester.id, compacting, undefined);
        await this.chat.selfCompaction.settleSelfCompactedItem(conversation, participantRequestMessage.id, participantRequestBatch.id, requester, through, true);
        await this.chat.store.waitForQueuedSave(conversation.id);
        this.heldParticipantRequests.delete(participantRequestMessage.id);
        await this.chat.requesterResumes.autoResumeParticipantRequest(conversation.id, participantRequestMessage.id, progress);
      }
      if (participantRequestResumeMessageId) {
        void this.chat.requesterResumes.autoResumeParticipantRequest(conversation.id, participantRequestResumeMessageId, progress).catch((error) => {
          void this.deps.debugLogs.write("chat.permission-approval.participant-request-auto-resume.error", {
            conversationId: conversation.id,
            requestMessageId: participantRequestResumeMessageId,
            approvalId: approval.id,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
    } catch (error) {
      emitChatRunFailure(resumeRunId, progress, error);
      throw error;
    } finally {
      if (participantRequestMessage) this.heldParticipantRequests.delete(participantRequestMessage.id);
      await this.chat.activeRuns.endChatRun(conversation, resumeRunId);
    }
  }

  oneTimeApprovalClaimedByOtherRun(approvalId: string, runId: string): boolean {
    const claimRunId = this.oneTimeApprovalClaims.get(approvalId);
    if (!claimRunId || claimRunId === runId) {
      return false;
    }
    if (!this.chat.activeRuns.chatRunControllers.has(claimRunId)) {
      this.oneTimeApprovalClaims.delete(approvalId);
      return false;
    }
    return true;
  }

  participantPermissionsForRun(
    conversation: Conversation,
    participant: ChatParticipant,
    oneTimeApprovals: ChatAppToolApproval[] = oneTimePermissionApprovalsForParticipant(conversation, participant),
    appliedOneTimeApprovalIds?: string[]
  ): ChatAgentPermissions {
    // Held to the main session's rights first; what the User granted once
    // for this turn is hers to give.
    let permissions = normalizeChatAgentPermissions(participantForRun(conversation, participant).permissions);
    for (const approval of oneTimeApprovals) {
      if (!isPermissionChangeRequest(approval.request)) {
        continue;
      }
      try {
        permissions = applyPermissionChangeToPermissions(permissions, approval.request);
        appliedOneTimeApprovalIds?.push(approval.id);
      } catch (error) {
        void this.deps.debugLogs.write("chat.permissions.once-overlay.invalid", {
          conversationId: conversation.id,
          approvalId: approval.id,
          participantId: participant.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return permissions;
  }
}
