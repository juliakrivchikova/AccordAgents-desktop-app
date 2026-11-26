import { isRoleOfferedForNewMembers, mainSessionParticipantId } from "../../../../shared/mainSession";
import type {
  AgentHealth, AppSettings, ChatAppToolApproval, ChatParticipant, ChatParticipantRequestPermission, ChatProviderKind,
  ChatRosterAvailableOptions, ChatRosterAvailableProvider, Conversation
} from "../../../../shared/types";
import { reasoningEffortOptionsForProvider } from "../../../../shared/reasoningEffort";
import {
  chatAgentModeWithin, chatAgentPermissionsWithin, chatParticipantRequestPermissionRank, effectiveChatAgentPermissionsForProvider,
  normalizeChatAgentMode, normalizeChatAgentPermissions
} from "../../../../shared/agentPermissions";
import { hasChatAppToolCapability, normalizeChatAppToolCapabilities } from "../../../../shared/appTools";
import { preservedRemoteExecution } from "../../../../shared/chatParticipantHome";
import { APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_ROLES_REQUEST_CHANGE_TOOL, APP_ROSTER_REQUEST_CHANGE_TOOL } from "../../appMcp";
import { CLI_PROVIDER_SETUP, readinessForProvider, resolveAssistantProviderKind } from "../../../../shared/cliReadiness";
import { chatSubagentProjectKey, chatSubagentProvidersOf, effectiveSubagentProviders } from "../../../../shared/subagentProviders";
import { matchingAppToolApprovalPolicy, newAppToolApproval, upsertAppToolApproval } from "../approvals/approvalRecords";
import { HANDLE_PATTERN } from "../constants";
import { CHAT_ROSTER_CHANGE_MAX_OPERATIONS } from "./constants";
import { chatParticipants, delegatedMemberCeiling } from "./identity";
import { markAddedWithoutCard, prepareParticipantRemoval } from "./removalRules";
import { manageRolesParticipantsResolutionForRole } from "./roleRuntime";
import {
  normalizeParticipantChangeRequest, normalizeRoleChangeRequest, normalizeRosterChangeRequest,
  pendingRoleApprovalForParticipantRequest, rosterParticipantSummary, splitParticipantRemovalInput
} from "./rosterRequests";
import type { ParticipantRemovalInput } from "./types";
import { createChatMessage } from "../store/messages";
import type { ChatAppMcpActor } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

interface ParticipantManagementAuthorization {
  requester: ChatParticipant;
  manageRolesParticipants: ChatParticipantRequestPermission;
}

/** Members' app tools that ask for role and roster changes. */
export class RosterTools {
  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "agentEnvironment" | "permissionRequests" | "queuedRosterChanges" | "rosterChanges" | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "settings">
  ) {}

  async requestRosterChangeFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const { requester, manageRolesParticipants } = await this.requireParticipantManager(conversation, actor);

    const prepared = await this.chat.rosterChanges.prepareRosterChange(conversation, normalizeRosterChangeRequest(rawRequest));
    const policy = matchingAppToolApprovalPolicy(conversation, requester, APP_ROSTER_REQUEST_CHANGE_TOOL, "participants.manage");
    if ((manageRolesParticipants === "allow" || policy) && !prepared.managementEscalation &&
      !await this.additionsExceedMainSession(conversation, requester, prepared.participants)) {
      const approval = newAppToolApproval(
        conversation,
        requester,
        APP_ROSTER_REQUEST_CHANGE_TOOL,
        "participants.manage",
        prepared.request,
        prepared.summary,
        "auto-applied"
      );
      const applied = await this.chat.store.saveChatChange(conversation, () => {
        const added = markAddedWithoutCard(conversation, this.chat.rosterChanges.applyPreparedRosterChange(conversation, prepared), requester.id);
        approval.appliedParticipantIds = added.map((participant) => participant.id);
        approval.updatedAt = new Date().toISOString();
        upsertAppToolApproval(conversation, approval);
        conversation.messages.push(createChatMessage("system", `Auto-applied app tool request from @${requester.handle}: ${prepared.summary}.`, undefined, {
          threadId: "system"
        }));
        return added;
      });
      return {
        ok: true,
        status: "auto_applied",
        approvalId: approval.id,
        summary: prepared.summary,
        addedParticipants: applied.map((participant) => `@${participant.handle}`)
      };
    }

    const approval = newAppToolApproval(
      conversation,
      requester,
      APP_ROSTER_REQUEST_CHANGE_TOOL,
      "participants.manage",
      prepared.request,
      prepared.summary,
      "pending"
    );
    await this.chat.store.saveChatChange(conversation, () => {
      upsertAppToolApproval(conversation, approval);
      conversation.messages.push(createChatMessage("system", `App tool approval needed from @${requester.handle}: ${prepared.summary}.`, undefined, {
        threadId: "system"
      }));
    });
    return {
      ok: true,
      status: "pending_user_approval",
      approvalId: approval.id,
      summary: prepared.summary
    };
  }

  /** In a chat with a main session, a member any member adds without a card
   *  gets nothing beyond the rights of the member adding it and of the main
   *  session (docs/main-session.md): one that would is put to User on a card
   *  instead, as her server holds a machine's additions
   *  (hub/hubMachineScope.ts). The main session's rights as they are now. */
  async additionsExceedMainSession(conversation: Conversation, requester: ChatParticipant, additions: ChatParticipant[]): Promise<boolean> {
    const mainId = mainSessionParticipantId(conversation.metadata);
    const mainSession = mainId ? chatParticipants(conversation).find((participant) => participant.id === mainId) : undefined;
    if (!mainSession) {
      return false;
    }
    const ceilings = requester.id === mainSession.id ? [mainSession] : [requester, mainSession];
    for (const ceilingMember of ceilings) {
      if (await this.additionsExceedMember(ceilingMember, additions)) {
        return true;
      }
    }
    return false;
  }

  /** Whether any of these members would have more than `ceilingMember`
   *  really has (the rights it may delegate, clampChatAgentPermissions): its
   *  mode, what it may do in that mode (as it runs now), and its right to
   *  manage members. */
  private async additionsExceedMember(ceilingMember: ChatParticipant, additions: ChatParticipant[]): Promise<boolean> {
    const ceilingMode = normalizeChatAgentMode(ceilingMember.agentMode);
    const ceiling = effectiveChatAgentPermissionsForProvider(ceilingMember.kind, ceilingMode, normalizeChatAgentPermissions(ceilingMember.permissions));
    const ceilingManage = chatParticipantRequestPermissionRank(await this.chat.permissionRequests.manageRolesParticipantsPermissionForParticipant(ceilingMember));
    for (const member of additions) {
      const memberMode = normalizeChatAgentMode(member.agentMode);
      if (!chatAgentModeWithin(memberMode, ceilingMode)) {
        return true;
      }
      if (!chatAgentPermissionsWithin(effectiveChatAgentPermissionsForProvider(member.kind, memberMode, normalizeChatAgentPermissions(member.permissions)), ceiling)) {
        return true;
      }
      if (chatParticipantRequestPermissionRank(await this.chat.permissionRequests.manageRolesParticipantsPermissionForParticipant(member)) > ceilingManage) {
        return true;
      }
    }
    return false;
  }

  /** The chat's sub-agents for the main session to give tasks to (shared/subagentProviders.ts). */
  private chatSubagentsFor(conversation: Conversation, settings: AppSettings): Pick<ChatRosterAvailableOptions, "chatSubagents"> {
    const subagents = effectiveSubagentProviders(
      settings.subagentProvidersByProject?.[chatSubagentProjectKey(conversation) ?? ""],
      chatSubagentProvidersOf(conversation.metadata)
    );
    return subagents ? {
      chatSubagents: subagents.map((provider) => ({
        kind: provider.kind,
        label: CLI_PROVIDER_SETUP[provider.kind].label,
        model: provider.model,
        reasoningEffort: provider.reasoningEffort
      }))
    } : {};
  }

  async describeRosterOptionsForTool(actor: ChatAppMcpActor): Promise<ChatRosterAvailableOptions> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const participants = chatParticipants(conversation);
    const { requester } = await this.requireParticipantManager(conversation, actor);

    const agents = await this.deps.cliRunner.detectAgents().catch((): AgentHealth[] => []);
    const settings = await this.deps.settings.ensureAssistantProviderDefault(agents);
    const roleById = new Map(settings.chatRoleConfigs.map((role) => [role.id, role]));
    const defaultKind = resolveAssistantProviderKind({
      agents,
      providers: settings.providers,
      explicitKind: settings.assistantProviderKind
    }) ?? requester.kind;
    const providers: ChatRosterAvailableProvider[] = await Promise.all((["codex-cli", "claude-code", "gemini-cli"] as ChatProviderKind[]).map(async (kind) => {
      const provider = settings.providers.find((item) => item.kind === kind);
      const health = agents.find((item) => item.kind === kind);
      const readiness = readinessForProvider(kind, agents, settings.providers);
      const configuredModel = provider?.model?.trim() || undefined;
      return {
        kind,
        label: provider?.label ?? health?.label ?? (kind === "codex-cli" ? "Codex CLI" : kind === "gemini-cli" ? "Gemini CLI (Antigravity)" : "Claude Code"),
        enabled: Boolean(provider?.enabled),
        installed: Boolean(health?.installed),
        selectedByDefault: kind === defaultKind,
        configuredModel,
        modelCatalog: await this.chat.agentEnvironment.safeCliModelCatalog(kind, configuredModel),
        reasoningEfforts: reasoningEffortOptionsForProvider(kind),
        version: health?.version,
        readiness,
        diagnosticCode: health?.diagnosticCode
      };
    }));

    return {
      conversationId: conversation.id,
      requester: {
        ...rosterParticipantSummary(conversation, requester),
        permissions: normalizeChatAgentPermissions(requester.permissions),
        manageRolesParticipants: manageRolesParticipantsResolutionForRole(roleById.get(requester.roleConfigId), requester.permissions),
        appToolCapabilities: normalizeChatAppToolCapabilities(actor.capabilities)
      },
      currentParticipants: participants.map((participant) => ({
        ...rosterParticipantSummary(conversation, participant),
        permissions: normalizeChatAgentPermissions(participant.permissions),
        manageRolesParticipants: manageRolesParticipantsResolutionForRole(roleById.get(participant.roleConfigId), participant.permissions)
      })),
      // The roles a new member may be given: not the main session's or the
      // Workflow Manager's (isRoleOfferedForNewMembers).
      roles: settings.chatRoleConfigs.filter((role) => isRoleOfferedForNewMembers(role.id)).map((role) => ({
        id: role.id,
        label: role.label,
        version: role.version,
        builtIn: Boolean(role.builtIn),
        archivedAt: role.archivedAt,
        archived: Boolean(role.archivedAt),
        appToolCapabilities: normalizeChatAppToolCapabilities(role.appToolCapabilities),
        participantDefaults: role.participantDefaults
      })),
      providers,
      ...this.chatSubagentsFor(conversation, settings),
      agentModes: ["default", "plan", "auto"],
      reasoningEfforts: reasoningEffortOptionsForProvider(defaultKind),
      defaults: {
        kind: defaultKind,
        agentMode: "default",
        reasoningEffort: undefined,
        permissions: normalizeChatAgentPermissions(undefined)
      },
      handleRules: {
        pattern: HANDLE_PATTERN.source,
        maxLength: 32,
        duplicatePolicy: "Handles must be unique within this chat; omit the leading @."
      },
      rosterChange: {
        supportedOperations: ["add"],
        maxOperations: CHAT_ROSTER_CHANGE_MAX_OPERATIONS,
        modelPolicy: "The model field is optional. Omit it to use the CLI/provider default. Prefer a provider's modelCatalog.models id when present; configuredModel is included as a fallback when the current settings model is not in the discovered catalog.",
        reasoningEffortPolicy: "The reasoningEffort field is optional. Omit it to use the CLI/provider default. Codex supports none, minimal, low, medium, high, xhigh, max, and ultra; available efforts depend on the selected model's CLI catalog. Claude supports low, medium, high, xhigh, and max."
      }
    };
  }

  async describeRoleOptionsForTool(actor: ChatAppMcpActor): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const { requester } = await this.requireParticipantManager(conversation, actor);
    const settings = await this.deps.settings.getPublicSettings();
    const presetUsageCounts = new Map<string, number>();
    for (const participant of settings.chatParticipantConfigs) {
      presetUsageCounts.set(participant.roleConfigId, (presetUsageCounts.get(participant.roleConfigId) ?? 0) + 1);
    }
    const chatUsageCounts = new Map<string, number>();
    for (const participant of chatParticipants(conversation)) {
      chatUsageCounts.set(participant.roleConfigId, (chatUsageCounts.get(participant.roleConfigId) ?? 0) + 1);
    }
    return {
      conversationId: conversation.id,
      requester: {
        ...rosterParticipantSummary(conversation, requester),
        appToolCapabilities: normalizeChatAppToolCapabilities(actor.capabilities)
      },
      roles: settings.chatRoleConfigs.filter((role) => isRoleOfferedForNewMembers(role.id)).map((role) => ({
        id: role.id,
        label: role.label,
        version: role.version,
        builtIn: Boolean(role.builtIn),
        archivedAt: role.archivedAt,
        archived: Boolean(role.archivedAt),
        appToolCapabilities: normalizeChatAppToolCapabilities(role.appToolCapabilities),
        participantDefaults: role.participantDefaults,
        instructions: role.instructions,
        usage: {
          savedParticipantPresets: presetUsageCounts.get(role.id) ?? 0,
          currentChatParticipants: chatUsageCounts.get(role.id) ?? 0
        }
      })),
      roleChange: {
        supportedOperations: ["create_role", "edit_role", "archive_role"],
        editPolicy: "Built-in roles are available for matching but cannot be edited or deleted by Chat Assistant. Create a custom role when no built-in role fits. Use archive_role to delete an unused custom role; roles with saved member preset usage cannot be deleted."
      }
    };
  }

  async describeParticipantOptionsForTool(actor: ChatAppMcpActor): Promise<Record<string, unknown>> {
    const roster = await this.describeRosterOptionsForTool(actor);
    const settings = await this.deps.settings.getPublicSettings();
    const roleById = new Map(settings.chatRoleConfigs.map((role) => [role.id, role]));
    return {
      ...roster,
      savedParticipants: settings.chatParticipantConfigs.map((participant) => ({
        id: participant.id,
        handle: participant.handle,
        roleConfigId: participant.roleConfigId,
        behaviorRuleIds: participant.behaviorRuleIds,
        kind: participant.kind,
        model: participant.model,
        reasoningEffort: participant.reasoningEffort,
        avatarId: participant.avatarId,
        hostId: participant.hostId,
        agentMode: normalizeChatAgentMode(participant.agentMode),
        permissions: normalizeChatAgentPermissions(participant.permissions),
        manageRolesParticipants: manageRolesParticipantsResolutionForRole(roleById.get(participant.roleConfigId), participant.permissions),
        remoteExecution: preservedRemoteExecution(participant.remoteExecution),
        skipToolchainPreflight: participant.skipToolchainPreflight === true,
        updatedAt: participant.updatedAt
      })),
      participantChange: {
        supportedOperations: ["add_new_participant_to_chat", "add_existing_participant_to_chat", "remove_participant_from_chat"],
        savePolicy: "For add_new_participant_to_chat, saveAsPreset defaults to true. Set it to false only for a one-off chat member. Do not use archived roles for new members; archived roles are returned only so existing saved/current references can still be understood.",
        removalPolicy: "remove_participant_from_chat takes a current member's participantId or handle and takes that member out of this chat only; its saved preset is kept. It can be combined with additions in one request (the answer then has `additions` and `removals`). Like an addition, it follows your Manage members setting: with allow it needs no User approval (status auto_approved: decided, made after your turn), with ask the User approves it on a card. A removal takes effect after your turn ends and no member is running. The Chat Assistant, the main session and the last member cannot be removed."
      }
    };
  }

  async requestRoleChangeFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const { requester, manageRolesParticipants } = await this.requireParticipantManager(conversation, actor);
    const prepared = await this.chat.rosterChanges.prepareRoleChange(normalizeRoleChangeRequest(rawRequest));
    if (manageRolesParticipants === "allow" && !prepared.managementEscalation) {
      const approval = newAppToolApproval(
        conversation,
        requester,
        APP_ROLES_REQUEST_CHANGE_TOOL,
        "participants.manage",
        prepared.request,
        prepared.summary,
        "auto-applied"
      );
      const appliedRoles = await this.chat.rosterChanges.applyPreparedRoleChange(prepared);
      await this.chat.store.saveChatChange(conversation, () => {
        upsertAppToolApproval(conversation, {
          ...approval,
          updatedAt: new Date().toISOString()
        });
        conversation.messages.push(createChatMessage(
          "system",
          `Auto-applied role request from @${requester.handle}: ${prepared.summary}.`,
          undefined,
          { threadId: "system" }
        ));
      });
      return {
        ok: true,
        status: "auto_applied",
        approvalId: approval.id,
        summary: prepared.summary,
        roles: appliedRoles.map((role) => ({ id: role.id, label: role.label })),
        createdRoleRefs: prepared.request.operations
          .map((operation, operationIndex) => operation.type === "create_role"
            ? {
                operationIndex,
                label: operation.role.label,
                roleConfigId: appliedRoles.find((role) => role.label === operation.role.label)?.id
              }
            : undefined)
          .filter((item): item is { operationIndex: number; label: string; roleConfigId: string | undefined } => Boolean(item))
      };
    }
    const approval = newAppToolApproval(
      conversation,
      requester,
      APP_ROLES_REQUEST_CHANGE_TOOL,
      "participants.manage",
      prepared.request,
      prepared.summary,
      "pending"
    );
    await this.chat.store.saveChatChange(conversation, () => {
      upsertAppToolApproval(conversation, approval);
      conversation.messages.push(createChatMessage("system", `Role approval needed from @${requester.handle}: ${prepared.summary}.`, undefined, {
        threadId: "system"
      }));
    });
    return {
      ok: true,
      status: "pending_user_approval",
      approvalId: approval.id,
      summary: prepared.summary,
      createdRoleRefs: prepared.request.operations
        .map((operation, operationIndex) => operation.type === "create_role"
          ? {
              operationIndex,
              label: operation.role.label,
              draftRoleRef: operation.role.draftRoleRef
            }
          : undefined)
        .filter((item): item is { operationIndex: number; label: string; draftRoleRef: string | undefined } => Boolean(item))
    };
  }

  async requestParticipantChangeFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const { requester, manageRolesParticipants } = await this.requireParticipantManager(conversation, actor);
    const { removal, additions, additionNumbers } = splitParticipantRemovalInput(rawRequest);
    if (!removal) {
      return this.requestParticipantAdditionFromTool(conversation, requester, manageRolesParticipants, rawRequest);
    }
    if (!additions) {
      return this.requestParticipantRemovalFromTool(conversation, requester, removal, manageRolesParticipants);
    }
    // Additions and removals in one request: each part goes exactly as it
    // would on its own, under the same Manage members setting. The removal is
    // checked first, so a request it cannot make changes nothing (the last
    // member rule is checked once the additions are made).
    prepareParticipantRemoval(conversation, requester.id, removal, undefined, { afterAdditions: true });
    let added: Record<string, unknown>;
    try {
      added = await this.requestParticipantAdditionFromTool(conversation, requester, manageRolesParticipants, additions);
    } catch (error) {
      // Numbered as the member wrote its whole request.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/Member operation (\d+)/g, (_text, number: string) =>
        `Member operation ${additionNumbers?.[Number(number) - 1] ?? number}`));
    }
    let removed: Record<string, unknown>;
    try {
      removed = await this.requestParticipantRemovalFromTool(conversation, requester, removal, manageRolesParticipants);
    } catch (error) {
      removed = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (removed.ok === false) {
      return {
        ok: false,
        status: "removal_failed",
        additions: added,
        removals: removed,
        next: "The additions went as `additions` says; only the removal failed. Do not ask for the additions again."
      };
    }
    return { ok: true, status: "combined", additions: added, removals: removed };
  }

  /** The additions of a member change request (everything but removals). */
  private async requestParticipantAdditionFromTool(
    conversation: Conversation,
    requester: ChatParticipant,
    manageRolesParticipants: ChatParticipantRequestPermission,
    rawRequest: unknown
  ): Promise<Record<string, unknown>> {
    const request = normalizeParticipantChangeRequest(rawRequest);
    const pendingRoleApproval = pendingRoleApprovalForParticipantRequest(conversation, requester, request);
    if (pendingRoleApproval) {
      const prepared = await this.chat.rosterChanges.prepareRoleParticipantChange(conversation, {
        kind: "role_participant_change",
        reason: request.reason ?? pendingRoleApproval.roleRequest.reason,
        roleRequest: pendingRoleApproval.roleRequest,
        participantRequest: request
      });
      if (manageRolesParticipants === "allow" && !prepared.managementEscalation &&
        !await this.additionsExceedMainSession(conversation, requester, prepared.participant.participants)) {
        const { applied, approval } = await this.chat.store.saveChatChange(conversation, async () => {
          const applied = await this.chat.rosterChanges.applyPreparedRoleParticipantChange(conversation, prepared);
          applied.participants = markAddedWithoutCard(conversation, applied.participants, requester.id);
          const approval: ChatAppToolApproval = {
            ...pendingRoleApproval.approval,
            toolName: APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
            request: applied.request,
            summary: applied.summary,
            status: "auto-applied",
            approvalScope: "chat",
            appliedParticipantIds: applied.participants.map((participant) => participant.id),
            updatedAt: new Date().toISOString()
          };
          upsertAppToolApproval(conversation, approval);
          conversation.messages.push(createChatMessage(
            "system",
            `Auto-applied role and member request from @${requester.handle}: ${applied.summary}.`,
            undefined,
            { threadId: "system" }
          ));
          return { applied, approval };
        });
        return {
          ok: true,
          status: "auto_applied",
          approvalId: approval.id,
          summary: applied.summary,
          addedParticipants: applied.participants.map((participant) => `@${participant.handle}`)
        };
      }
      const approval: ChatAppToolApproval = {
        ...pendingRoleApproval.approval,
        toolName: APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
        request: prepared.request,
        summary: prepared.summary,
        updatedAt: new Date().toISOString()
      };
      await this.chat.store.saveChatChange(conversation, () => {
        upsertAppToolApproval(conversation, approval);
        conversation.messages.push(createChatMessage("system", `Role and member approval needed from @${requester.handle}: ${prepared.summary}.`, undefined, {
          threadId: "system"
        }));
      });
      return {
        ok: true,
        status: "pending_user_approval",
        approvalId: approval.id,
        summary: prepared.summary
      };
    }

    const prepared = await this.chat.rosterChanges.prepareParticipantChange(conversation, request);
    if (manageRolesParticipants === "allow" && !prepared.managementEscalation &&
      !await this.additionsExceedMainSession(conversation, requester, prepared.participants)) {
      const approval = newAppToolApproval(
        conversation,
        requester,
        APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
        "participants.manage",
        prepared.request,
        prepared.summary,
        "auto-applied"
      );
      const applied = await this.chat.store.saveChatChange(conversation, async () => {
        const added = markAddedWithoutCard(conversation, await this.chat.rosterChanges.applyPreparedParticipantChange(conversation, prepared), requester.id);
        approval.appliedParticipantIds = added.map((participant) => participant.id);
        approval.updatedAt = new Date().toISOString();
        upsertAppToolApproval(conversation, approval);
        conversation.messages.push(createChatMessage(
          "system",
          `Auto-applied member request from @${requester.handle}: ${prepared.summary}.`,
          undefined,
          { threadId: "system" }
        ));
        return added;
      });
      return {
        ok: true,
        status: "auto_applied",
        approvalId: approval.id,
        summary: prepared.summary,
        addedParticipants: applied.map((participant) => `@${participant.handle}`)
      };
    }
    const approval = newAppToolApproval(
      conversation,
      requester,
      APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
      "participants.manage",
      prepared.request,
      prepared.summary,
      "pending"
    );
    await this.chat.store.saveChatChange(conversation, () => {
      upsertAppToolApproval(conversation, approval);
      conversation.messages.push(createChatMessage("system", `Member approval needed from @${requester.handle}: ${prepared.summary}.`, undefined, {
        threadId: "system"
      }));
    });
    return {
      ok: true,
      status: "pending_user_approval",
      approvalId: approval.id,
      summary: prepared.summary
    };
  }

  /** A member's removal request. The asking member's Manage members setting
   *  decides, exactly as for an addition: "allow" makes it without a card,
   *  "ask" puts it on a card for the User. Either way it is made once the
   *  chat has no live work, the asking member's own turn included, by the
   *  same removal core as the member list (applyQueuedMemberRemovals). */
  private async requestParticipantRemovalFromTool(
    conversation: Conversation,
    requester: ChatParticipant,
    input: ParticipantRemovalInput,
    manageRolesParticipants: ChatParticipantRequestPermission
  ): Promise<Record<string, unknown>> {
    const allowed = manageRolesParticipants === "allow";
    let result!: Record<string, unknown>;
    await this.chat.store.withChatMutation(conversation, async () => {
      const prepared = prepareParticipantRemoval(conversation, requester.id, input);
      const current = chatParticipants(conversation).find((participant) => participant.id === requester.id) ?? requester;
      const approval = newAppToolApproval(
        conversation,
        current,
        APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
        "participants.manage",
        prepared.request,
        prepared.summary,
        allowed ? "auto-applied" : "pending"
      );
      if (allowed) {
        approval.memberRemovalQueuedAt = approval.createdAt;
        conversation.messages.push(createChatMessage("system", `Auto-approved member removal from @${current.handle}: ${prepared.summary}.`, undefined, {
          threadId: "system"
        }));
      } else {
        conversation.messages.push(createChatMessage("system", `Member removal approval needed from @${current.handle}: ${prepared.summary}.`, undefined, {
          threadId: "system"
        }));
      }
      upsertAppToolApproval(conversation, approval);
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
      result = allowed
        ? {
            ok: true,
            status: "auto_approved",
            approvalId: approval.id,
            summary: prepared.summary,
            next: "Your Manage members setting allows this removal without asking the User. It takes effect after your turn ends and no member is running; the outcome is posted to the chat as a system message. Do not say the member was removed before that."
          }
        : {
            ok: true,
            status: "pending_user_approval",
            approvalId: approval.id,
            summary: prepared.summary,
            next: "The User decides on a removal card. If approved, the removal takes effect after your turn ends and no member is running; the outcome is posted to the chat as a system message. Do not say the member was removed before that."
          };
    });
    if (allowed) {
      // Indexed only once the decision is stored (see approveParticipantRemoval).
      this.chat.queuedRosterChanges.noteQueuedMemberRemoval(conversation.id);
      await this.chat.queuedRosterChanges.applyQueuedMemberRemovalsOnce(conversation.id, conversation);
    }
    return result;
  }

  private async requireParticipantManager(
    conversation: Conversation,
    actor: ChatAppMcpActor
  ): Promise<ParticipantManagementAuthorization> {
    const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    if (!hasChatAppToolCapability(actor.capabilities, "participants.manage")) {
      throw new Error("The issued app-tool token does not grant member management.");
    }
    let manageRolesParticipants = await this.chat.permissionRequests.manageRolesParticipantsPermissionForParticipant(requester);
    // A member the main session made manages members no more freely than
    // the main session can now.
    const ceiling = delegatedMemberCeiling(conversation, requester);
    if (ceiling) {
      const mainManage = await this.chat.permissionRequests.manageRolesParticipantsPermissionForParticipant(ceiling.mainSession);
      if (chatParticipantRequestPermissionRank(mainManage) < chatParticipantRequestPermissionRank(manageRolesParticipants)) {
        manageRolesParticipants = mainManage;
      }
    }
    if (manageRolesParticipants === "deny") {
      throw new Error("This participant's role is not allowed to manage roles or participants.");
    }
    return { requester, manageRolesParticipants };
  }
}
