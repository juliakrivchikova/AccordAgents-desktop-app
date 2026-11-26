import { isMainSessionParticipant, isRoleOfferedForNewMembers } from "../../../../shared/mainSession";
import { randomUUID } from "node:crypto";
import type {
  AgentHealth, AppSettings, ChatAgentPermissions, ChatMessage, ChatParticipant, ChatParticipantInput, ChatParticipantChangeRequest,
  ChatParticipantRequestBatch, ChatParticipantRequestItem, ChatParticipantRequestPermission, ChatParticipantSession,
  ChatProviderKind, ChatRosterChangeParticipantInput, Conversation
} from "../../../../shared/types";
import { accordCandidates } from "../../../../shared/accordCandidates";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import { agentReadinessReason, CLI_PROVIDER_SETUP, readinessForProvider } from "../../../../shared/cliReadiness";
import { chatSubagentProvidersOf, subagentRemovedInChat } from "../../../../shared/subagentProviders";
import {
  clampChatAgentAccess, effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions
} from "../../../../shared/agentPermissions";
import { hasChatAppToolCapability } from "../../../../shared/appTools";
import { preservedRemoteExecution } from "../../../../shared/chatParticipantHome";
import { APP_PARTICIPANTS_REQUEST_CHANGE_TOOL } from "../../appMcp";
import { newAppToolApproval, upsertAppToolApproval } from "../approvals/approvalRecords";
import { CHAT_ADMINISTRATOR_ROLE_ID, GENERIC_PARTICIPANT_ROLE_ID } from "../constants";
import { assertParticipantProvidersReady, chatParticipants, chatSessions, uniqueHandle, upsertSession } from "../members/identity";
import { chatSubagentList, readySubagentKinds } from "../members/subagentList";
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
    const prepared = await this.newMemberInput(conversation, caller, manage, settings, input);
    if ("refusal" in prepared) {
      return prepared.refusal;
    }
    const start = input.start ?? "clean";

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
      const { child, session } = await this.addNewMember(conversation, callerNow, prepared, settings, { reason: input.reason, title: input.title });
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

  /**
   * The members an Accord the User starts adds for the Agents-list CLIs it
   * names (src/shared/accordCandidates.ts). Each is made as the main
   * session's member for a task that names only its CLI: on the CLI's model
   * and effort from the list, with the main session's mode and rights at
   * most, where the main session runs. Read before the chat's queue (probing
   * the CLIs takes seconds); addAccordMembers adds them inside it.
   */
  async prepareAccordMembers(conversation: Conversation, kinds: readonly ChatProviderKind[]): Promise<PreparedAccordMembers> {
    const main = accordMainSession(conversation);
    const settings = await this.deps.settings.getPublicSettings();
    const agents = await this.readiness();
    const unique = [...new Set(kinds)];
    assertAccordProviders(conversation, unique, settings, agents);
    const manage = await this.chat.permissionRequests.manageRolesParticipantsPermissionForParticipant(main);
    const members: PreparedMember[] = [];
    for (const kind of unique) {
      const prepared = await this.newMemberInput(conversation, main, manage, settings, { kind, start: "clean" }, agents);
      if ("refusal" in prepared) {
        throw new Error(String(prepared.refusal.reason));
      }
      members.push(prepared);
    }
    return { settings, agents, members };
  }

  /** Inside the chat's queue: adds the prepared members to the chat as it is
   *  now, as the User's change (no member asked for them). */
  async addAccordMembers(conversation: Conversation, prepared: PreparedAccordMembers): Promise<ChatParticipant[]> {
    if (prepared.members.length === 0) {
      return [];
    }
    const main = accordMainSession(conversation);
    // The CLIs as read before the queue: probing them again here would hold it.
    assertAccordProviders(conversation, prepared.members.map((member) => member.item.kind), prepared.settings, prepared.agents);
    const added: ChatParticipant[] = [];
    for (const member of prepared.members) {
      const { child, session } = await this.addNewMember(conversation, main, member, prepared.settings, { byUser: true });
      upsertSession(conversation, session);
      added.push(child);
    }
    return added;
  }

  /** What the main session's new member is made of: its CLI from the chat's
   *  Agents list, its model and effort, mode and rights no broader than the
   *  main session's, the machine the main session runs on. Or why not. */
  private async newMemberInput(
    conversation: Conversation,
    caller: ChatParticipant,
    manage: ChatParticipantRequestPermission,
    settings: AppSettings,
    input: Omit<ChatTaskDelegationInput, "task" | "title" | "reason">,
    detected?: AgentHealth[]
  ): Promise<PreparedMember | { refusal: Record<string, unknown> }> {
    const refuse = (code: string, reason: string): { refusal: Record<string, unknown> } => ({ refusal: delegationRefusal(code, reason) });
    const roleConfigId = input.roleConfigId ?? GENERIC_PARTICIPANT_ROLE_ID;
    // Only the roles offered for new members (not the Workflow Manager's,
    // which manages members by default: the main session took its place).
    if (roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID || !isRoleOfferedForNewMembers(roleConfigId)) {
      return refuse("invalid_role", "A member you give a task to cannot have the main session, Chat Assistant or Workflow Manager role.");
    }
    const role = settings.chatRoleConfigs.find((item) => item.id === roleConfigId && !item.archivedAt);
    if (!role) {
      return refuse("invalid_role", `No role ${roleConfigId}. Call app_participants_describe_options for the roles.`);
    }

    // What the main session really has now is the ceiling (its mode's
    // effective rights, its own right to manage members).
    const callerMode = normalizeChatAgentMode(caller.agentMode);
    const ceiling: ChatAgentPermissions = {
      ...effectiveChatAgentPermissionsForProvider(caller.kind, callerMode, normalizeChatAgentPermissions(caller.permissions)),
      manageRolesParticipants: manage
    };
    // The chat's agents (its side panel): every CLI ready where its members
    // run, less those the chat took out. The provider asked for must be one of
    // them; none named, the main session's own when it is one, else the first.
    // A Cloud run main session's members run there too, where Antigravity does not.
    let agents: AgentHealth[];
    try {
      agents = detected ?? await this.readiness();
    } catch (error) {
      return refuse("provider_unavailable", error instanceof Error ? error.message : String(error));
    }
    const subagents = chatSubagentList(conversation, settings, agents, Boolean(caller.cloudRun));
    const subagent = input.kind
      ? subagents.find((provider) => provider.kind === input.kind)
      : subagents.find((provider) => provider.kind === caller.kind) ?? subagents[0];
    if (!subagent) {
      return subagentRefusal(conversation, settings, agents, subagents, input.kind, Boolean(caller.cloudRun));
    }
    const kind = subagent.kind;
    const sameProvider = kind === caller.kind;
    // An agent with a model of its own runs on its CLI's own backend, not on
    // another vendor the main session's CLI may be bound to; a fork goes there too.
    const childHostId = sameProvider && !subagent.model ? caller.hostId : undefined;
    // A model named without a provider is one of the main session's own CLI's.
    if (!input.kind && input.model && !sameProvider) {
      return refuse("invalid_request", `Name the provider (kind) for model ${input.model}: this chat's agents send the task to ${CLI_PROVIDER_SETUP[kind].label}, not your own CLI.`);
    }
    const access = clampChatAgentAccess(kind,
      { agentMode: input.agentMode ?? callerMode, permissions: delegationRequestedPermissions(input.permissions, ceiling) },
      { agentMode: callerMode, permissions: ceiling });
    const agentMode = access.agentMode;
    const permissions = access.permissions;
    if (participantManagementChangeEscalates(role, permissions)) {
      return refuse("not_allowed", `Managing members beyond what the ${role.label} role gives needs User's approval. Ask User, or add the member with app_participants_request_change.`);
    }

    if (input.start === "fork") {
      const callerSession = chatSessions(conversation).find((session) => session.participantId === caller.id);
      const unavailable = this.chat.forks.forkUnavailableReason(caller, callerSession, kind, childHostId);
      if (unavailable) {
        return refuse("fork_unavailable", unavailable);
      }
      // The CLI session is kept for the folder it runs in: the copy runs in
      // the same one.
      permissions.repoRead = ceiling.repoRead;
    }

    // The chat's model for the CLI (its own, else Settings'), then for the
    // main session's own CLI the main session's model.
    const childModel = input.model ?? subagent.model ?? (sameProvider ? caller.model : undefined);
    // The main session's effort goes with its own model: another model may lack it.
    const inheritsCallerEffort = sameProvider && childModel === caller.model;
    const baseHandle = input.handle ?? delegatedMemberHandleBase(role, kind);
    const item: PreparedMember["item"] = {
      handle: uniqueHandle(baseHandle, new Set(chatParticipants(conversation).map((participant) => participant.handle.toLowerCase()))),
      roleConfigId: role.id,
      kind,
      // The provider's model and effort for this chat, then the main session's own.
      model: childModel,
      reasoningEffort: normalizeChatReasoningEffort(input.reasoningEffort ?? subagent.reasoningEffort ??
        (inheritsCallerEffort ? caller.reasoningEffort : undefined), kind),
      hostId: childHostId,
      agentMode,
      permissions,
      // Where the main session runs: a cloud main session's members run on
      // the same machine.
      remoteExecution: preservedRemoteExecution(caller.remoteExecution),
      homeMachineId: caller.homeMachineId,
      cloudRun: caller.cloudRun
    };
    try {
      assertParticipantProvidersReady([item], agents, settings.providers ?? [], settings.cliProviderHosts ?? []);
    } catch (error) {
      return refuse("provider_unavailable", error instanceof Error ? error.message : String(error));
    }
    return { item, baseHandle };
  }

  /** Every CLI's readiness where this code runs (the main session's device). */
  private readiness(): Promise<AgentHealth[]> {
    return this.chat.agentEnvironment.detectAgentsForReadiness();
  }

  /** Adds a prepared member to the chat as it is now (inside its queue), held
   *  to the main session (markAddedWithoutCard), with a new CLI session. The
   *  main session's own addition is recorded as its auto-applied member
   *  request; one the User's Accord adds is said as her own addition is. */
  private async addNewMember(
    conversation: Conversation,
    mainSession: ChatParticipant,
    prepared: PreparedMember,
    settings: AppSettings,
    options: { reason?: string; title?: string; byUser?: boolean }
  ): Promise<{ child: ChatParticipant; session: ChatParticipantSession }> {
    const handles = new Set(chatParticipants(conversation).map((participant) => participant.handle.toLowerCase()));
    const [validated] = await this.chat.creation.validateParticipants(
      [{ ...prepared.item, handle: uniqueHandle(prepared.baseHandle, handles) }],
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
    const [marked] = markAddedWithoutCard(conversation, this.chat.rosterChanges.applyPreparedRosterChange(conversation, {
      request: { reason: options.reason, operations: [{ type: "add", participant: memberInput }] },
      participants: [validated],
      summary,
      managementEscalation: false
    }), mainSession.id);
    const child = withTaskTitle(conversation, marked, options.title);
    if (options.byUser) {
      conversation.messages.push(createChatMessage("system", `Added @${child.handle} to the chat for the Accord.`, undefined, { threadId: "system" }));
    } else {
      // Recorded as the member change the main session made under its
      // Manage members "allow", one-off (not saved as a preset).
      const request: ChatParticipantChangeRequest = {
        reason: options.reason,
        operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: memberInput }]
      };
      const approval = newAppToolApproval(conversation, mainSession, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, "participants.manage", request, summary, "auto-applied");
      approval.approvalScope = "chat";
      approval.appliedParticipantIds = [child.id];
      upsertAppToolApproval(conversation, approval);
      conversation.messages.push(createChatMessage("system", `Auto-applied member request from @${mainSession.handle}: ${summary}.`, undefined, {
        threadId: "system"
      }));
    }
    const session = await this.chat.memberSessions.newSessionForParticipant(child);
    return { child, session };
  }
}

interface PreparedMember {
  item: ChatParticipantInput & { kind: ChatProviderKind };
  baseHandle: string;
}

export interface PreparedAccordMembers {
  settings: AppSettings;
  /** The CLIs' readiness, read before the chat's queue. */
  agents: AgentHealth[];
  members: PreparedMember[];
}

function accordMainSession(conversation: Conversation): ChatParticipant {
  const main = chatParticipants(conversation).find((participant) => isMainSessionParticipant(conversation.metadata, participant.id));
  if (!main) {
    throw new Error("Only a chat with a main session adds agents for an Accord.");
  }
  return main;
}

/** Each CLI is still one the Accord can add: in the chat's Agents list, with
 *  no member here yet (one may have been added since the dialog opened). */
function assertAccordProviders(conversation: Conversation, kinds: readonly ChatProviderKind[], settings: AppSettings, agents: AgentHealth[]): void {
  const members = chatParticipants(conversation).filter((participant) => participant.roleConfigId !== CHAT_ADMINISTRATOR_ROLE_ID);
  const open = new Set(accordCandidates(members, conversation, { ready: readySubagentKinds(agents, settings), defaults: settings.subagentDefaults })
    .providers.map((provider) => provider.kind));
  const missing = kinds.find((kind) => !open.has(kind));
  if (missing) {
    throw new Error(`${CLI_PROVIDER_SETUP[missing].label} is not in this chat's Agents list, or it has a member here already. Start the Accord again.`);
  }
}

/** Why no agent of the chat takes the task: the chat took the CLI out, or it
 *  is not ready where the main session's members run, or the list is empty. */
function subagentRefusal(
  conversation: Conversation,
  settings: AppSettings,
  agents: AgentHealth[],
  subagents: readonly { kind: ChatProviderKind }[],
  kind: ChatProviderKind | undefined,
  cloudRun: boolean
): { refusal: Record<string, unknown> } {
  const names = (list: readonly { kind: ChatProviderKind }[]): string => list.map((provider) => CLI_PROVIDER_SETUP[provider.kind].label).join(", ");
  const listed = subagents.length > 0 ? ` This chat's agents: ${names(subagents)}.` : "";
  const refuse = (code: string, reason: string) => ({ refusal: delegationRefusal(code, reason) });
  if (!kind) {
    return refuse("provider_not_in_chat", "This chat has no agents: no CLI is ready here, or User took them all out of the chat's Agents list. Ask User to set one up in Settings or add one back in the chat's side panel.");
  }
  const label = CLI_PROVIDER_SETUP[kind].label;
  if (subagentRemovedInChat(chatSubagentProvidersOf(conversation.metadata), kind)) {
    return refuse("provider_not_in_chat", `User took ${label} out of this chat's Agents list.${listed} Give the task to one of them, or ask User to add ${label} back in the chat's side panel.`);
  }
  if (cloudRun && kind === "gemini-cli") {
    return refuse("provider_unavailable", `${label} does not run on Cloud run, where this chat's members run.${listed}`);
  }
  const reason = agentReadinessReason(readinessForProvider(kind, agents, settings.providers ?? []), label) ?? `${label} is not ready here.`;
  return refuse("provider_unavailable", `${reason}${listed}`);
}
