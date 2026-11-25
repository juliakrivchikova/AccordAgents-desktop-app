import { chatViewFor } from "../../../../shared/mainSession";
import type { AgentContextUsage, ChatParticipant, Conversation } from "../../../../shared/types";
import { agentContextUsageByParticipant, contextUsageUpdatesAfterRefresh, sameAgentContextUsage } from "./contextUsage";
import { chatParticipants, chatSessions, cliModesConverted } from "../members/identity";
import { cliParticipantForSession } from "../members/roleRuntime";
import { rebuildLastMessagesByParticipantIfChanged } from "../store/lastMessages";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** How full each member's context is. */
export class ContextMeter {
  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "codexApprovals" | "connectorSignIns" | "host" | "list" | "members" | "participantRequests" | "queuedRosterChanges"
      | "requestRecovery" | "runOwners" | "selfCompaction" | "store" | "toolPermissions"
    >,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs">
  ) {}

  async hydrateContextUsage(conversation: Conversation): Promise<Conversation> {
    if (conversation.kind !== "chat") {
      return conversation;
    }
    // A chat in the sessions view opened here with members on rights from
    // the classic view: they move into their CLI's own mode, once.
    if (!this.chat.host.machineRuntime && chatViewFor(conversation.metadata) === "sessions" && !cliModesConverted(conversation.metadata)) {
      this.chat.list.convertMembersForSessionsView(conversation.id, true);
    }
    const participants = new Map(chatParticipants(conversation).map((participant) => [participant.id, participant]));
    const existingUsage = agentContextUsageByParticipant(conversation);
    let nextUsage: Record<string, AgentContextUsage> | undefined;
    for (const session of chatSessions(conversation)) {
      if (!session.sessionId) {
        continue;
      }
      const participant = participants.get(session.participantId);
      if (!participant || !this.chat.host.ownsParticipant(participant)) {
        continue;
      }
      let usage: AgentContextUsage | undefined;
      try {
        // Read once: this runs on every chat open, and waiting for logs that
        // no longer exist made opening a chat take a second.
        usage = await this.deps.cliRunner.contextUsageForSession(
          cliParticipantForSession(participant, session),
          session.sessionId,
          { waitForLog: false, known: existingUsage[session.participantId] }
        );
      } catch (error) {
        await this.deps.debugLogs.write("chat.context-usage-refresh.error", {
          conversationId: conversation.id,
          participantId: participant.id,
          sessionId: session.sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      if (!usage) {
        continue;
      }
      if (sameAgentContextUsage(existingUsage[session.participantId], usage)) {
        continue;
      }
      nextUsage = {
        ...(nextUsage ?? {}),
        [participant.id]: usage
      };
    }

    let hydrated = conversation;
    const autoResumeRequestMessageIds = new Set<string>();
    await this.chat.store.withChatMutation(conversation, async () => {
      const participantsSynced = await this.chat.members.syncConversationParticipantsFromSettings(conversation);
      const orphanedCodexApprovalsExpired = this.chat.codexApprovals.expireOrphanedCodexApprovals(conversation);
      const signInsExpired = this.chat.connectorSignIns.expireOrphanedConnectorSignIns(conversation);
      const orphanedSignInsExpired = this.chat.toolPermissions.expireOrphanedToolPermissions(conversation) || signInsExpired;
      const recoveredRunState = this.chat.runOwners.recoverStaleChatRun(conversation);
      const orphanedRequestsInterrupted = this.chat.requestRecovery.markOrphanedParticipantRequestsInterrupted(conversation);
      const delegationGroupsRecovered = [this.chat.requestRecovery.recoverDelegationGroupsOfEndedTurns(conversation), this.chat.selfCompaction.recoverSelfCompactions(conversation)].some(Boolean);
      const interruptedRequests = orphanedRequestsInterrupted || delegationGroupsRecovered;
      const usageUpdates = nextUsage ? contextUsageUpdatesAfterRefresh(conversation, existingUsage, nextUsage) : undefined;
      // conversation.messages is full history here (refreshStoredChatState merged it).
      // Heal pointer maps left stale by the pre-fix index-ordering so roster jump targets
      // the participant's true latest message even before they post again.
      const pointersHealed = rebuildLastMessagesByParticipantIfChanged(conversation);
      if (!usageUpdates && !interruptedRequests && !recoveredRunState && !participantsSynced && !pointersHealed && !orphanedCodexApprovalsExpired && !orphanedSignInsExpired) {
        hydrated = conversation;
        return;
      }
      if (usageUpdates) {
        conversation.metadata = {
          ...conversation.metadata,
          agentContextUsageByParticipant: {
            ...agentContextUsageByParticipant(conversation),
            ...usageUpdates
          }
        };
      }
      if (interruptedRequests || recoveredRunState || orphanedCodexApprovalsExpired || orphanedSignInsExpired) {
        conversation.updatedAt = new Date().toISOString();
      }
      await this.chat.store.saveConversation(conversation);
      hydrated = conversation;
      if (recoveredRunState) {
        // A swept stale run can be what an approved member removal waits for.
        this.chat.queuedRosterChanges.scheduleQueuedMemberRemovals(conversation.id);
      }
    });
    this.chat.participantRequests.queueParticipantRequestAutoResumes(conversation.id, Array.from(autoResumeRequestMessageIds));
    return hydrated;
  }

  /** A member's context read from its CLI's session log now (the member's
   *  own device only); undefined when there is no log to read. */
  async liveContextUsage(conversation: Conversation, participant: ChatParticipant): Promise<AgentContextUsage | undefined> {
    const session = chatSessions(conversation).find((item) => item.participantId === participant.id && Boolean(item.sessionId?.trim()));
    if (!session?.sessionId || !this.chat.host.ownsParticipant(participant)) {
      return undefined;
    }
    try {
      return await this.deps.cliRunner.contextUsageForSession(cliParticipantForSession(participant, session), session.sessionId, {
        waitForLog: false,
        known: agentContextUsageByParticipant(conversation)[participant.id]
      });
    } catch (error) {
      await this.deps.debugLogs.write("chat.context-usage-live.error", {
        conversationId: conversation.id,
        participantId: participant.id,
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }
}
