import { isMainSessionParticipant, isRoleOfferedForNewMembers } from "../../../../shared/mainSession";
import { randomUUID } from "node:crypto";
import type {
  ChatAgentPermissions, ChatMessage, ChatParticipant, ChatParticipantInput, ChatParticipantChangeRequest,
  ChatParticipantRequestBatch, ChatParticipantRequestItem, ChatRosterChangeParticipantInput
} from "../../../../shared/types";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import {
  clampChatAgentAccess, effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions
} from "../../../../shared/agentPermissions";
import { hasChatAppToolCapability } from "../../../../shared/appTools";
import { preservedRemoteExecution } from "../../../../shared/chatParticipantHome";
import { APP_PARTICIPANTS_REQUEST_CHANGE_TOOL } from "../../appMcp";
import { newAppToolApproval, upsertAppToolApproval } from "../approvals/approvalRecords";
import { CHAT_ADMINISTRATOR_ROLE_ID, GENERIC_PARTICIPANT_ROLE_ID } from "../constants";
import { assertParticipantProvidersReady, chatParticipants, chatSessions, uniqueHandle, upsertSession } from "../members/identity";
import { delegationRefusal, markAddedWithoutCard, normalizeTaskDelegation, withTaskTitle } from "../members/removalRules";
import { delegatedMemberHandleBase, delegationRequestedPermissions, participantManagementChangeEscalates } from "../members/rosterRequests";
import { CHAT_PARTICIPANT_REQUEST_WAIT_DEFAULT_MS } from "./constants";
import { turnSegmentKey } from "./delegationGroups";
import { formatParticipantRequestMessage, participantRequestSummary, recordPreparedParticipantRequest } from "./requestRecords";
import { createChatMessage } from "../store/messages";
import type { ChatAppMcpActor, ChatTaskDelegationInput } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Tasks the main session gives to members it creates. */
export class Delegation {
  /** Members' turns running here, by chat and turn (turnSegmentId): the main
   *  session's tasks of one turn resume it once that turn is over. */
  readonly liveTurnSegments = new Set<string>();
  /** A turn of the main session that gave tasks, by chat and turn: one of
   *  its task requests, looked at again when the turn ends. */
  readonly delegatingTurns = new Map<string, { conversationId: string; requestMessageId: string }>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "agentEnvironment" | "creation" | "forks" | "host" | "memberSessions" | "participantRequests"
      | "permissionRequests" | "rosterChanges" | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "settings">
  ) {}

  /**
   * The main session gives a new member a task (app_chat_delegate_task,
   * docs/main-session.md): the member is added without a card, with nothing
   * beyond the main session's own rights, on the main session's provider,
   * model, mode and machine unless it names others, and its task is asked of
   * it at once as a request from the main session, whose answer comes back in
   * a fresh main-session turn. "fork" starts the member from a copy of the
   * main session's CLI session; where the CLI cannot do that the call says so
   * (fork_unavailable) and nothing is added.
   */
  async delegateTaskFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const caller = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!caller) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    this.chat.host.assertOwnsParticipant(caller);
    if (!hasChatAppToolCapability(actor.capabilities, "participants.delegate") || !isMainSessionParticipant(conversation.metadata, caller.id)) {
      return delegationRefusal("not_main_session", "Only the chat's main session gives tasks to new members. Ask the main session with app_chat_request_participants.");
    }
    let input: ChatTaskDelegationInput;
    try {
      input = normalizeTaskDelegation(rawRequest, await this.chat.participantRequests.chatParticipantRequestPromptMaxChars());
    } catch (error) {
      return delegationRefusal("invalid_request", error instanceof Error ? error.message : String(error));
    }
    const manage = await this.chat.permissionRequests.manageRolesParticipantsPermissionForParticipant(caller);
    if (manage !== "allow") {
      return delegationRefusal("not_allowed", manage === "ask"
        ? `User asked to approve the members @${caller.handle} adds. Add it with app_participants_request_change (User approves it on a card), then give it the task with app_chat_request_participants.`
        : `User turned off adding members for @${caller.handle}.`);
    }
    const settings = await this.deps.settings.getPublicSettings();
    const roleConfigId = input.roleConfigId ?? GENERIC_PARTICIPANT_ROLE_ID;
    // Only the roles offered for new members (not the Workflow Manager's,
    // which manages members by default: the main session took its place).
    if (roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID || !isRoleOfferedForNewMembers(roleConfigId)) {
      return delegationRefusal("invalid_role", "A member you give a task to cannot have the main session, Chat Assistant or Workflow Manager role.");
    }
    const role = settings.chatRoleConfigs.find((item) => item.id === roleConfigId && !item.archivedAt);
    if (!role) {
      return delegationRefusal("invalid_role", `No role ${roleConfigId}. Call app_participants_describe_options for the roles.`);
    }

    // What the main session really has now is the ceiling (its mode's
    // effective rights, its own right to manage members).
    const callerMode = normalizeChatAgentMode(caller.agentMode);
    const ceiling: ChatAgentPermissions = {
      ...effectiveChatAgentPermissionsForProvider(caller.kind, callerMode, normalizeChatAgentPermissions(caller.permissions)),
      manageRolesParticipants: manage
    };
    const kind = input.kind ?? caller.kind;
    const sameProvider = kind === caller.kind;
    const access = clampChatAgentAccess(kind,
      { agentMode: input.agentMode ?? callerMode, permissions: delegationRequestedPermissions(input.permissions, ceiling) },
      { agentMode: callerMode, permissions: ceiling });
    const agentMode = access.agentMode;
    const permissions = access.permissions;
    if (participantManagementChangeEscalates(role, permissions)) {
      return delegationRefusal("not_allowed", `Managing members beyond what the ${role.label} role gives needs User's approval. Ask User, or add the member with app_participants_request_change.`);
    }

    const start = input.start ?? "clean";
    const callerSession = chatSessions(conversation).find((session) => session.participantId === caller.id);
    if (start === "fork") {
      const unavailable = this.chat.forks.forkUnavailableReason(caller, callerSession, kind, sameProvider ? caller.hostId : undefined);
      if (unavailable) {
        return delegationRefusal("fork_unavailable", unavailable);
      }
      // The CLI session is kept for the folder it runs in: the copy runs in
      // the same one.
      permissions.repoRead = ceiling.repoRead;
    }

    const baseHandle = input.handle ?? delegatedMemberHandleBase(role, kind);
    const item: ChatParticipantInput = {
      handle: uniqueHandle(baseHandle, new Set(chatParticipants(conversation).map((participant) => participant.handle.toLowerCase()))),
      roleConfigId: role.id,
      kind,
      model: input.model ?? (sameProvider ? caller.model : undefined),
      reasoningEffort: normalizeChatReasoningEffort(input.reasoningEffort ?? (sameProvider ? caller.reasoningEffort : undefined), kind),
      hostId: sameProvider ? caller.hostId : undefined,
      agentMode,
      permissions,
      // Where the main session runs: a cloud main session's members run on
      // the same machine.
      remoteExecution: preservedRemoteExecution(caller.remoteExecution),
      homeMachineId: caller.homeMachineId,
      cloudRun: caller.cloudRun
    };
    try {
      const agents = await this.chat.agentEnvironment.detectAgentsForReadiness();
      assertParticipantProvidersReady([item], agents, settings.providers ?? [], settings.cliProviderHosts ?? []);
    } catch (error) {
      return delegationRefusal("provider_unavailable", error instanceof Error ? error.message : String(error));
    }

    const requesterDepth = actor.participantRequestDepth ?? 0;
    const depth = requesterDepth + 1;
    const maxDepth = await this.chat.participantRequests.chatParticipantRequestMaxDepth();
    if (depth > maxDepth) {
      return delegationRefusal("limit", `max depth (${maxDepth}) reached`);
    }

    // The tasks of one main-session turn resume it once, when that turn is
    // over and all of them have ended (autoResumeParticipantRequest). Only a
    // turn running here now: a task given after it (a CLI still at work in
    // the background) is resumed on its own, as any other request.
    const liveTurnKey = actor.turnSegmentId ? turnSegmentKey(conversation.id, actor.turnSegmentId) : undefined;
    const delegationTurnId = liveTurnKey && this.liveTurnSegments.has(liveTurnKey) ? actor.turnSegmentId : undefined;
    let added!: { child: ChatParticipant; requestMessage: ChatMessage; batch: ChatParticipantRequestBatch };
    let refusal: Record<string, unknown> | undefined;
    await this.chat.store.saveChatChange(conversation, async () => {
      // The chat as saved now: a member added meanwhile keeps its name, and
      // the main session's session is the one it has now.
      const callerNow = chatParticipants(conversation).find((participant) => participant.id === caller.id);
      if (!callerNow) {
        throw new Error("The requesting member is no longer in this chat.");
      }
      const sessionNow = chatSessions(conversation).find((session) => session.participantId === caller.id);
      if (start === "fork" && !sessionNow?.sessionId?.trim()) {
        refusal = delegationRefusal("fork_unavailable", "Your CLI session has no id yet to copy.");
        return;
      }
      // No limit on how many tasks the main session gives for one User
      // message (the User, 2026-11-20): only the depth limit above holds.
      const chainRootId = actor.chainRootId ?? actor.triggerMessageId ?? randomUUID();
      const handles = new Set(chatParticipants(conversation).map((participant) => participant.handle.toLowerCase()));
      const [validated] = await this.chat.creation.validateParticipants(
        [{ ...item, handle: uniqueHandle(baseHandle, handles) }],
        chatParticipants(conversation),
        false,
        settings.chatRoleConfigs.filter((candidate) => !candidate.archivedAt)
      );
      const summary = `Add @${validated.handle}`;
      const memberInput: ChatRosterChangeParticipantInput = {
        handle: validated.handle,
        roleConfigId: validated.roleConfigId,
        kind: validated.kind,
        model: validated.model,
        reasoningEffort: validated.reasoningEffort,
        hostId: validated.hostId,
        agentMode: validated.agentMode,
        permissions: validated.permissions,
        remoteExecution: preservedRemoteExecution(validated.remoteExecution)
      };
      // Recorded as the member change the main session made under its
      // Manage members "allow", one-off (not saved as a preset).
      const request: ChatParticipantChangeRequest = {
        reason: input.reason,
        operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: memberInput }]
      };
      const [marked] = markAddedWithoutCard(conversation, this.chat.rosterChanges.applyPreparedRosterChange(conversation, {
        request: { reason: input.reason, operations: [{ type: "add", participant: memberInput }] },
        participants: [validated],
        summary,
        managementEscalation: false
      }), callerNow.id);
      const child = withTaskTitle(conversation, marked, input.title);
      const approval = newAppToolApproval(conversation, callerNow, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, "participants.manage", request, summary, "auto-applied");
      approval.approvalScope = "chat";
      approval.appliedParticipantIds = [child.id];
      upsertAppToolApproval(conversation, approval);
      conversation.messages.push(createChatMessage("system", `Auto-applied member request from @${callerNow.handle}: ${summary}.`, undefined, {
        threadId: "system"
      }));

      const session = await this.chat.memberSessions.newSessionForParticipant(child);
      if (start === "fork" && sessionNow) {
        session.forkFrom = { participantId: callerNow.id, sessionId: sessionNow.sessionId, kind: child.kind };
        session.forkedFromParticipantId = callerNow.id;
        this.chat.forks.copyPromptContextPointersForFork(conversation, callerNow.id, child.id);
      }
      upsertSession(conversation, session);

      const now = new Date().toISOString();
      const batchId = randomUUID();
      const items: ChatParticipantRequestItem[] = [{
        targetParticipantId: child.id,
        targetHandle: child.handle,
        targetKind: child.kind,
        prompt: input.task,
        ...(input.title ? { title: input.title } : {}),
        reason: input.reason,
        status: "running",
        createdAt: now,
        updatedAt: now
      }];
      const batch: ChatParticipantRequestBatch = {
        id: batchId,
        requesterParticipantId: callerNow.id,
        requesterHandle: callerNow.handle,
        source: "mcp",
        resumeRequester: true,
        status: "running",
        depth,
        requesterDepth,
        chainRootId,
        createdAt: now,
        updatedAt: now,
        triggerMessageId: actor.triggerMessageId,
        delegation: { start, ...(delegationTurnId ? { turnId: delegationTurnId } : {}) },
        items
      };
      const requestMessage = createChatMessage(
        "participant",
        formatParticipantRequestMessage(callerNow.handle, items),
        { id: callerNow.id, kind: callerNow.kind, label: `@${callerNow.handle}`, model: callerNow.model },
        {
          threadId: actor.triggerThreadId ?? actor.triggerMessageId ?? batchId,
          parentMessageId: actor.triggerMessageId,
          sourceMessageId: actor.triggerMessageId,
          participantRequest: batch
        }
      );
      recordPreparedParticipantRequest(conversation, callerNow, {
        request: {
          requests: [{ target: child.handle, prompt: input.task, reason: input.reason }],
          resumeRequester: true,
          source: "mcp",
          requestMessageId: requestMessage.id,
          batchId
        },
        requester: callerNow,
        targets: [child],
        batch,
        requestMessage,
        summary: participantRequestSummary(callerNow.handle, [child.handle]),
        timeoutMs: CHAT_PARTICIPANT_REQUEST_WAIT_DEFAULT_MS
      }, actor);
      added = { child, requestMessage, batch };
    });
    if (refusal) {
      return refusal;
    }
    void this.deps.debugLogs.write("chat.main-session.delegated", {
      conversationId: conversation.id,
      requesterParticipantId: caller.id,
      participantId: added.child.id,
      kind: added.child.kind,
      start,
      requestMessageId: added.requestMessage.id
    });
    // While its turn runs, the main session may give more tasks: they are
    // all looked at again when the turn ends.
    if (delegationTurnId && liveTurnKey && this.liveTurnSegments.has(liveTurnKey) && !this.delegatingTurns.has(liveTurnKey)) {
      this.delegatingTurns.set(liveTurnKey, { conversationId: conversation.id, requestMessageId: added.requestMessage.id });
    }
    // The member's turn runs as its own run, here or on its machine; its
    // answer comes back to the main session in a fresh turn, with the other
    // tasks of the same turn (autoResumeParticipantRequest).
    const requesterProgress = actor.runId ? this.chat.activeRuns.runProgressCallbacks.get(actor.runId) : undefined;
    const runner = this.chat.participantRequests.startParticipantRequestRunner(conversation.id, added.requestMessage.id, added.batch.depth, requesterProgress);
    this.chat.participantRequests.resumeRequesterWhenRunnerSettles(conversation.id, added.requestMessage.id, runner, requesterProgress);
    return {
      ok: true,
      participantId: added.child.id,
      handle: `@${added.child.handle}`,
      requestId: added.batch.id,
      requestMessageId: added.requestMessage.id,
      status: "running",
      start,
      forked: start === "fork"
    };
  }
}
