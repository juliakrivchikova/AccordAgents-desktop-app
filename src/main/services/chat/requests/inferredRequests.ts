import { chatViewFor, isMainSessionChat, isMainSessionParticipant } from "../../../../shared/mainSession";
import type { ChatInterimPost, ChatMessage, ChatParticipant, ChatParticipantRequestBatch, Conversation } from "../../../../shared/types";
import { APP_CHAT_SEND_MESSAGE_TOOL, APP_CHAT_REQUEST_PARTICIPANTS_TOOL } from "../../appMcp";
import { newAppToolApproval, upsertAppToolApproval } from "../approvals/approvalRecords";
import { hasStandaloneAccordSkillToken, participantForMentionHandle } from "../choices/mentions";
import { chatParticipants } from "../members/identity";
import { CHAT_PARTICIPANT_REQUEST_MAX_ITEMS, CHAT_PARTICIPANT_REQUEST_WAIT_DEFAULT_MS } from "./constants";
import {
  hasActiveParticipantRequestForTargets, inferParticipantRequestTargets, inferredParticipantRequestPrompt,
  inferredParticipantRequestSuppression, inferredParticipantRequestTargetsForSegment, inferredParticipantRequestWarning
} from "./inferredRequestText";
import { participantRequestSummary } from "./requestRecords";
import type { InferredParticipantRequestSuppressionScope, PreparedParticipantRequest } from "./types";
import { recordLastMessageByParticipant } from "../store/lastMessages";
import { addConversationWarning } from "../store/messages";
import type { ChatAppMcpActor } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Requests read from a member's own reply when it did not use the tool. */
export class InferredRequests {
  constructor(
    private readonly chat: Pick<ChatModules, "host" | "participantRequests" | "requestGrants">,
    private readonly deps: Pick<ChatDependencies, "debugLogs">
  ) {}

  /** A post's @mentions ask the members it names, as a posted message's do:
   *  inferred from the post's words, filed under the reply it is part of. */
  async inferParticipantRequestsFromInterimPost(
    conversation: Conversation,
    requester: ChatParticipant,
    reply: ChatMessage,
    post: ChatInterimPost,
    actor: ChatAppMcpActor
  ): Promise<Array<{ requestMessageId: string; depth: number; source: ChatParticipantRequestBatch["source"] }>> {
    const source: ChatMessage = {
      ...reply,
      content: post.content,
      status: "done",
      metadata: {
        ...reply.metadata,
        appMessageSource: APP_CHAT_SEND_MESSAGE_TOOL,
        turnSegmentId: actor.turnSegmentId ?? reply.metadata?.turnSegmentId
      }
    };
    try {
      return await this.createImplicitParticipantRequestApproval(conversation, requester, [source]);
    } catch (error) {
      addConversationWarning(
        conversation,
        `Participant mentions in @${requester.handle}'s message were not triggered because inferred-request processing failed.`
      );
      void this.deps.debugLogs.write("chat.participant-request.inferred-tool-error", {
        conversationId: conversation.id,
        messageId: reply.id,
        postId: post.id,
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        message: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  async createImplicitParticipantRequestApproval(
    conversation: Conversation,
    participant: ChatParticipant,
    messages: ChatMessage[]
  ): Promise<Array<{ requestMessageId: string; depth: number; source: ChatParticipantRequestBatch["source"] }>> {
    const participantRequestsToRun: Array<{ requestMessageId: string; depth: number; source: ChatParticipantRequestBatch["source"] }> = [];
    // Only the authoring host infers actions. Other copies retain its messages
    // and the request rows it publishes, without creating a second request.
    if (!this.chat.host.ownsParticipant(participant)) return participantRequestsToRun;
    for (const sourceMessage of messages) {
      if (
        sourceMessage.role !== "participant" ||
        sourceMessage.participantId !== participant.id ||
        sourceMessage.status === "error" ||
        sourceMessage.metadata?.participantRequest
      ) {
        continue;
      }

      const inferred = inferParticipantRequestTargets(conversation, participant, sourceMessage.content);
      if (inferred.length === 0) {
        continue;
      }
      // In the sessions view an @handle in a member's reply or post starts
      // nobody, as a mention in text wakes nobody in Claude Code (the User,
      // 2026-11-22): a member is asked with app_chat_request_participants or
      // app_chat_delegate_task (its answer to such a task goes back to the
      // main session), an Accord is started with app_chat_start_accord, and
      // no warning is shown for an "@x /accord" either. The classic view
      // keeps reading such a mention as a request. Every device that runs a
      // member (this computer, a cloud machine) decides it here; the User's
      // server refuses a turn for such a request from an older program
      // (hubOps applyTurn).
      if (chatViewFor(conversation.metadata) === "sessions") {
        void this.deps.debugLogs.write("chat.participant-request.inferred-skipped-sessions-view", {
          conversationId: conversation.id,
          messageId: sourceMessage.id,
          requesterParticipantId: participant.id,
          targets: inferred.map((item) => item.targetHandle)
        });
        continue;
      }
      // In a chat with a main session only it starts an Accord
      // (docs/main-session.md); another member's "@x /accord" starts nothing.
      if (hasStandaloneAccordSkillToken(sourceMessage.content) && isMainSessionChat(conversation.metadata) &&
        !isMainSessionParticipant(conversation.metadata, participant.id)) {
        addConversationWarning(conversation, `@${participant.handle} cannot start an Accord in this chat; only this chat's own session starts one.`);
        void this.deps.debugLogs.write("chat.accord.inferred-refused", {
          conversationId: conversation.id,
          messageId: sourceMessage.id,
          requesterParticipantId: participant.id,
          targets: inferred.map((item) => item.targetHandle)
        });
        continue;
      }
      const suppression = inferredParticipantRequestSuppression(
        conversation,
        participant,
        sourceMessage
      );
      const suppressed = inferred.filter((item) => suppression.targetHandles.has(item.targetHandle.toLowerCase()));
      let candidates = inferred.filter((item) => !suppression.targetHandles.has(item.targetHandle.toLowerCase()));
      if (suppressed.length > 0) {
        const targetsByScope = new Map<InferredParticipantRequestSuppressionScope, string[]>();
        for (const item of suppressed) {
          const scope = suppression.scopeByTarget.get(item.targetHandle.toLowerCase());
          if (!scope) {
            continue;
          }
          targetsByScope.set(scope, [...(targetsByScope.get(scope) ?? []), item.targetHandle]);
        }
        for (const [decidingScope, targets] of targetsByScope) {
          void this.deps.debugLogs.write("chat.participant-request.inferred-skipped-existing", {
            conversationId: conversation.id,
            messageId: sourceMessage.id,
            requesterParticipantId: participant.id,
            requesterHandle: participant.handle,
            targets,
            decidingScope
          });
        }
      }
      if (candidates.length === 0) {
        continue;
      }

      const targetHandles = candidates.map((item) => item.targetHandle);
      if (hasActiveParticipantRequestForTargets(conversation, participant, sourceMessage.id, targetHandles)) {
        void this.deps.debugLogs.write("chat.participant-request.inferred-skipped-existing", {
          conversationId: conversation.id,
          messageId: sourceMessage.id,
          requesterParticipantId: participant.id,
          requesterHandle: participant.handle,
          targets: targetHandles,
          decidingScope: "active-overlap"
        });
        continue;
      }

      const segmentTargets = inferredParticipantRequestTargetsForSegment(
        conversation,
        participant,
        sourceMessage.metadata?.turnSegmentId
      );
      let remainingNewTargets = Math.max(0, CHAT_PARTICIPANT_REQUEST_MAX_ITEMS - segmentTargets.size);
      const cappedTargets: string[] = [];
      candidates = candidates.filter((item) => {
        const handle = item.targetHandle.toLowerCase();
        if (segmentTargets.has(handle)) {
          return true;
        }
        if (remainingNewTargets <= 0) {
          cappedTargets.push(item.targetHandle);
          return false;
        }
        segmentTargets.add(handle);
        remainingNewTargets -= 1;
        return true;
      });
      if (cappedTargets.length > 0) {
        void this.deps.debugLogs.write("chat.participant-request.inferred-turn-cap", {
          conversationId: conversation.id,
          messageId: sourceMessage.id,
          requesterParticipantId: participant.id,
          requesterHandle: participant.handle,
          turnSegmentId: sourceMessage.metadata?.turnSegmentId,
          cap: CHAT_PARTICIPANT_REQUEST_MAX_ITEMS,
          targets: cappedTargets
        });
      }
      if (candidates.length === 0) {
        continue;
      }

      this.chat.requestGrants.allowParticipantRequestsForInferredAccordIfSelected(conversation, sourceMessage, inferred);

      let prepared: PreparedParticipantRequest;
      try {
        prepared = await this.chat.participantRequests.prepareParticipantRequest(
          conversation,
          participant,
          {
            requests: candidates.map((item) => ({
              target: item.targetHandle,
              prompt: inferredParticipantRequestPrompt(participant.handle, item.snippet),
              title: item.title,
              reason: `Inferred from @${participant.handle}'s chat reply.`
            })),
            timeoutMs: CHAT_PARTICIPANT_REQUEST_WAIT_DEFAULT_MS,
            resumeRequester: true
          },
          {
            conversationId: conversation.id,
            participantId: participant.id,
            roleConfigId: participant.roleConfigId,
            roleConfigVersion: participant.roleConfigVersion ?? 0,
            capabilities: ["participants.request"],
            triggerMessageId: sourceMessage.id,
            triggerThreadId: sourceMessage.metadata?.threadId ?? sourceMessage.id,
            triggerParentMessageId: sourceMessage.metadata?.parentMessageId,
            triggerChatThreadRootId: sourceMessage.metadata?.chatThreadRootId,
            snapshotMaxSequence: Math.max(0, conversation.messages.length - 1),
            continuation: false,
            participantRequestDepth: sourceMessage.metadata?.participantRequestDepth ?? 0,
            chainRootId: sourceMessage.metadata?.participantRequestChainRootId
          },
          "inferred"
        );
      } catch (error) {
        addConversationWarning(
          conversation,
          inferredParticipantRequestWarning(participant.handle, candidates.map((item) => item.targetHandle), error)
        );
        void this.deps.debugLogs.write("chat.participant-request.inferred-create-error", {
          conversationId: conversation.id,
          messageId: sourceMessage.id,
          requesterParticipantId: participant.id,
          requesterHandle: participant.handle,
          targets: targetHandles,
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      conversation.messages.push(prepared.requestMessage);
      recordLastMessageByParticipant(conversation, prepared.requestMessage);
      const pendingTargets = prepared.batch.items.filter((item) => item.status === "pending_approval");
      if (pendingTargets.length > 0) {
        const participants = chatParticipants(conversation);
        const approval = newAppToolApproval(
          conversation,
          participant,
          APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
          "participants.request",
          {
            ...prepared.request,
            requests: prepared.request.requests.filter((request) => {
              const target = participantForMentionHandle(participants, request.target);
              return target ? pendingTargets.some((item) => item.targetParticipantId === target.id) : false;
            }),
            requestMessageId: prepared.requestMessage.id,
            batchId: prepared.batch.id
          },
          participantRequestSummary(participant.handle, pendingTargets.map((item) => item.targetHandle)),
          "pending"
        );
        upsertAppToolApproval(conversation, approval);
      }
      if (prepared.batch.items.some((item) => item.status === "running")) {
        participantRequestsToRun.push({
          requestMessageId: prepared.requestMessage.id,
          depth: prepared.batch.depth,
          source: "inferred"
        });
      }
      void this.deps.debugLogs.write("chat.participant-request.inferred-created", {
        conversationId: conversation.id,
        messageId: sourceMessage.id,
        requestMessageId: prepared.requestMessage.id,
        requesterParticipantId: participant.id,
        requesterHandle: participant.handle,
        targets: prepared.batch.items.map((item) => item.targetHandle),
        approvalRequired: pendingTargets.length > 0
      });
    }
    return participantRequestsToRun;
  }
}
