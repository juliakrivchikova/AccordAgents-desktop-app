import { isMainSessionParticipant } from "../../../../shared/mainSession";
import type {
  ChatAgentPermissions, ChatMessage, ChatParticipant, ChatParticipantRequestPermission, ChatSkillMention, Conversation
} from "../../../../shared/types";
import {
  chatParticipantRequestPermissionRank, normalizeChatParticipantRequestPermission, normalizeChatAgentPermissions
} from "../../../../shared/agentPermissions";
import { hasStandaloneAccordSkillToken, participantForMentionHandle } from "../choices/mentions";
import { chatParticipants } from "../members/identity";
import type { ChatDependencies } from "../dependencies";

/** Member-request permissions a flow gave on its own copy of a chat before that copy is saved. */
export class RequestGrants {
  /** Members a flow gave "Request other members: allow" on its own copy of
   *  the chat (an accord start, an approval "for this chat") that has not been
   *  saved yet: only that grant survives the refresh from storage. Any other
   *  value the copy holds is older than the saved one, which the User may
   *  have changed meanwhile. Settled once a save of the copy is written. */
  readonly requestPermissionGrants = new WeakMap<Conversation, Set<string>>();

  constructor(private readonly deps: Pick<ChatDependencies, "debugLogs">) {}

  allowParticipantRequestsForInferredAccordIfSelected(
    conversation: Conversation,
    sourceMessage: ChatMessage,
    inferred: Array<{ targetHandle: string; snippet: string }>
  ): void {
    if (inferred.length !== 1 || !hasStandaloneAccordSkillToken(sourceMessage.content)) {
      return;
    }
    const participants = chatParticipants(conversation);
    const facilitator = participantForMentionHandle(participants, inferred[0].targetHandle);
    if (!facilitator) {
      return;
    }
    // The main session gives its facilitator leave to ask members only as far
    // as it may ask them itself (as app_chat_start_accord does).
    const mainSession = sourceMessage.role === "participant" && isMainSessionParticipant(conversation.metadata, sourceMessage.participantId)
      ? participants.find((participant) => participant.id === sourceMessage.participantId)
      : undefined;
    const leave: ChatParticipantRequestPermission = mainSession
      ? normalizeChatParticipantRequestPermission(normalizeChatAgentPermissions(mainSession.permissions).requestParticipants)
      : "allow";
    if (mainSession && chatParticipantRequestPermissionRank(normalizeChatParticipantRequestPermission(normalizeChatAgentPermissions(facilitator.permissions).requestParticipants)) >=
      chatParticipantRequestPermissionRank(leave)) {
      return;
    }
    this.setParticipantRequestPermission(conversation, facilitator.id, leave);
    void this.deps.debugLogs.write("chat.accord.permission-enabled", {
      conversationId: conversation.id,
      facilitatorId: facilitator.id,
      facilitatorHandle: facilitator.handle,
      source: "inferred",
      messageId: sourceMessage.id
    });
  }

  allowParticipantRequestsForManualAccordIfSelected(
    conversation: Conversation,
    skillMentions: ChatSkillMention[],
    targets: ChatParticipant[]
  ): ChatParticipant[] {
    if (targets.length !== 1 || !skillMentions.some((mention) => mention.frontmatterName === "accord")) {
      return targets;
    }
    const facilitator = targets[0];
    const updatedFacilitator = this.setParticipantRequestPermission(conversation, facilitator.id, "allow") ?? facilitator;
    void this.deps.debugLogs.write("chat.accord.permission-enabled", {
      conversationId: conversation.id,
      facilitatorId: facilitator.id,
      facilitatorHandle: facilitator.handle,
      source: "manual"
    });
    return [updatedFacilitator];
  }

  setParticipantRequestPermission(
    conversation: Conversation,
    participantId: string,
    permission: ChatAgentPermissions["requestParticipants"]
  ): ChatParticipant | undefined {
    const participants = chatParticipants(conversation);
    let updated: ChatParticipant | undefined;
    const nextParticipants = participants.map((participant) => {
      if (participant.id !== participantId) {
        return participant;
      }
      const permissions = normalizeChatAgentPermissions(participant.permissions);
      const requestParticipants = normalizeChatParticipantRequestPermission(permission);
      if (permissions.requestParticipants === requestParticipants) {
        updated = participant;
        return participant;
      }
      if (requestParticipants === "allow") {
        const grants = this.requestPermissionGrants.get(conversation) ?? new Set<string>();
        grants.add(participant.id);
        this.requestPermissionGrants.set(conversation, grants);
      }
      updated = {
        ...participant,
        permissions: {
          ...permissions,
          requestParticipants
        }
      };
      return updated;
    });
    if (updated) {
      conversation.metadata = {
        ...conversation.metadata,
        participants: nextParticipants
      };
    }
    return updated;
  }

  /** The grants a copy had when a save of it was built; once that save is
   *  written they are in the saved chat (settleRequestPermissionGrants). */
  pendingRequestPermissionGrants(conversation: Conversation): ReadonlySet<string> | undefined {
    const grants = this.requestPermissionGrants.get(conversation);
    return grants && grants.size > 0 ? new Set(grants) : undefined;
  }

  settleRequestPermissionGrants(conversation: Conversation, saved: ReadonlySet<string> | undefined): void {
    const grants = this.requestPermissionGrants.get(conversation);
    if (!grants || !saved) {
      return;
    }
    for (const participantId of saved) grants.delete(participantId);
    if (grants.size === 0) this.requestPermissionGrants.delete(conversation);
  }
}
