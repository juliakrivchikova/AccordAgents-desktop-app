import { cloudRunSelection } from "../../../../shared/cloudRunPreparation";
import { applyChatAccessOptionById, inCliOwnMode } from "../../../../shared/chatAccessModes";
import { newChatMainSessionStart, withNewChatRights } from "../../../../shared/newChatDefaults";
import {
  DEFAULT_CHAT_VIEW, MAIN_SESSION_HANDLE, MAIN_SESSION_ROLE_ID, MAIN_SESSION_ROLE_MISSING_MESSAGE, mainSessionMemberOf
} from "../../../../shared/mainSession";
import { randomUUID } from "node:crypto";
import type {
  ChatAgentMode, ChatAgentPermissions, ChatParticipant, ChatParticipantInput, ChatProviderKind, ChatRoleConfig, Conversation,
  CreateChatConversationRequest, ProviderSettings, StartReviewResult
} from "../../../../shared/types";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import { newChatMemberPermissions, chatAgentModeForKind } from "../../../../shared/agentPermissions";
import { preservedRemoteExecution } from "../../../../shared/chatParticipantHome";
import { normalizeAutoChatTitle } from "../../../../shared/chatTitles";
import { NO_READY_CLI_MESSAGE, readyProviderKinds, resolveAssistantProviderKind } from "../../../../shared/cliReadiness";
import { CHAT_ADMINISTRATOR_ROLE_ID, HANDLE_PATTERN } from "../constants";
import {
  assertParticipantProvidersReady, chatParticipants, normalizeBehaviorRuleIds, normalizeParticipantPermissionsForRole,
  participantHostFields, seededParticipantInputs, splitMainSessionInput, uniqueHandle
} from "../members/identity";
import { rebuildLastMessagesByParticipant } from "../store/lastMessages";
import { chatCreateLogPayload, createChatMessage } from "../store/messages";
import { chatIntro, newChatBlockedReason } from "../store/titles";
import { emitProgress } from "../turns/replyMessages";
import type { ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

const CHAT_ADMINISTRATOR_HANDLE = "assistant";

/** Creates a chat with its first members. */
export class ChatCreation {
  constructor(
    private readonly chat: Pick<ChatModules, "agentEnvironment" | "forks" | "store">,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs" | "settings">
  ) {}

  async createConversation(request: CreateChatConversationRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    signal?.throwIfAborted();
    const report = (message: string): void => {
      if (request.runId && !signal?.aborted) emitProgress(request.runId, progress, "initial", message);
    };
    if (request.forkOf) {
      return this.chat.forks.createForkedConversation(request.forkOf, signal);
    }
    report("Checking participants…");
    const now = new Date().toISOString();
    const requestedTitle = request.title ?? "";
    const requestedRepoPath = request.repoPath?.trim() || undefined;
    await this.deps.debugLogs.write("chat.create.requested", {
      titlePreview: requestedTitle.trim().replace(/\s+/g, " ").slice(0, 160),
      titleLength: requestedTitle.length,
      repoPath: requestedRepoPath,
      requestedParticipantCount: request.participants.length,
      skipDefaultParticipants: request.skipDefaultParticipants === true
    }).catch(() => undefined);

    let conversation: Conversation | undefined;
    let stage = "initializing";
    try {
      const agents = await this.chat.agentEnvironment.detectAgentsForReadiness("submit");
      signal?.throwIfAborted();
      await this.deps.settings.ensureAssistantProviderDefault(agents);
      const settings = await this.deps.settings.ensureGenericChatParticipantSeeds(agents);
      const assistantProviderKind = resolveAssistantProviderKind({
        agents,
        providers: settings.providers,
        explicitKind: settings.assistantProviderKind
      });
      const readyKinds = readyProviderKinds(agents, settings.providers);
      const cannotStart = newChatBlockedReason(agents, settings, assistantProviderKind);
      if (cannotStart || !assistantProviderKind) {
        throw new Error(cannotStart ?? "Could not choose a provider for the new chat. Check General Settings and try again.");
      }
      const hasRequestedParticipants = request.participants.length > 0;
      const skipDefaultParticipants = request.skipDefaultParticipants === true;
      const participantInputs = hasRequestedParticipants
        ? request.participants
        : skipDefaultParticipants
          ? []
          : seededParticipantInputs(
            settings.chatParticipantConfigs,
            settings.chatParticipantSeedState,
            readyKinds,
            Boolean(requestedRepoPath)
          );
      assertParticipantProvidersReady(participantInputs, agents, settings.providers, settings.cliProviderHosts ?? []);
      // Every new chat has its main session instead of the Chat Assistant
      // (docs/main-session.md); the New chat screen's own row for it, when
      // the User changed it there, is that main session.
      const { mainSession: mainSessionInput, members: memberInputs } = splitMainSessionInput(participantInputs);
      const requestedParticipants = await this.validateParticipants(memberInputs, [], true);
      const participants = await this.ensureMainSessionParticipant(requestedParticipants, assistantProviderKind, {
        repoPath: requestedRepoPath,
        requested: mainSessionInput,
        newChatDefaults: true
      });
      const mainSession = mainSessionMemberOf(participants);
      signal?.throwIfAborted();
      conversation = {
        id: randomUUID(),
        title: normalizeAutoChatTitle(requestedTitle),
        kind: "chat",
        createdAt: now,
        updatedAt: now,
        repoPath: requestedRepoPath,
        messages: [
          createChatMessage("system", chatIntro(participants), undefined, {
            threadId: "system"
          })
        ],
        findings: [],
        metadata: {
          participants,
          participantSessions: [],
          warnings: [],
          running: false,
          // No changes of its own to its Agents list: the chat gives tasks to
          // every ready CLI, on Settings' model and effort.
          subagentProviders: { entries: [] },
          // Every new chat opens in the sessions view (the User, 2026-11-22);
          // its header switches it afterwards.
          ...(mainSession ? { mainSessionParticipantId: mainSession.id, chatView: DEFAULT_CHAT_VIEW } : {})
        }
      };
      rebuildLastMessagesByParticipant(conversation);
      const logPayload = chatCreateLogPayload(conversation);
      stage = "saving";
      report("Opening your chat…");
      await this.deps.debugLogs.write("chat.create.save-started", logPayload).catch(() => undefined);
      signal?.throwIfAborted();
      await this.chat.store.saveConversation(conversation);
      stage = "saved";
      await this.deps.debugLogs.write("chat.create.saved", logPayload).catch(() => undefined);
      return { conversation, warnings: [] };
    } catch (error) {
      await this.deps.debugLogs.write("chat.create.failed", {
        conversationId: conversation?.id,
        stage,
        titlePreview: conversation
          ? conversation.title
          : requestedTitle.trim().replace(/\s+/g, " ").slice(0, 160),
        repoPath: conversation?.repoPath ?? requestedRepoPath,
        participantCount: conversation ? chatParticipants(conversation).length : undefined,
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
      throw error;
    }
  }

  async validateParticipants(
    items: CreateChatConversationRequest["participants"],
    existing: ChatParticipant[] = [],
    allowEmpty = false,
    availableRoles?: ChatRoleConfig[],
    options: { mainSession?: boolean } = {}
  ): Promise<ChatParticipant[]> {
    if (items.length === 0 && existing.length === 0 && !allowEmpty) {
      throw new Error("Add at least one chat member.");
    }
    const settings = await this.deps.settings.getPublicSettings();
    const roles = availableRoles ?? settings.chatRoleConfigs.filter((role) => !role.archivedAt);
    const hosts = settings.cliProviderHosts ?? [];
    const handles = new Set(existing.map((participant) => participant.handle.toLowerCase()));
    let autoWatchAlreadyAssigned = existing.some((participant) => participant.autoWatch === true);
    return items.map((item) => {
      const handle = item.handle.trim().replace(/^@/, "");
      if (!HANDLE_PATTERN.test(handle)) {
        throw new Error("Member names may use letters, numbers, underscores, and hyphens only.");
      }
      const normalized = handle.toLowerCase();
      if (handles.has(normalized)) {
        throw new Error(`Duplicate member name: @${handle}.`);
      }
      handles.add(normalized);
      if (item.kind !== "codex-cli" && item.kind !== "claude-code" && item.kind !== "gemini-cli") {
        throw new Error("Chat supports local CLI members only.");
      }
      const role = roles.find((candidate) => candidate.id === item.roleConfigId);
      if (!role) {
        const archived = settings.chatRoleConfigs.find((role) => role.id === item.roleConfigId && role.archivedAt);
        if (archived) {
          throw new Error(`Deleted role "${archived.label}" cannot be used for a new member.`);
        }
        throw new Error(`Unknown role for @${handle}.`);
      }
      // A chat makes its one main session itself (ensureMainSessionParticipant);
      // no other member is given that role.
      if (role.id === MAIN_SESSION_ROLE_ID && options.mainSession !== true) {
        throw new Error(`The "${role.label}" role cannot be given to @${handle}: a chat gives it only to its own session.`);
      }
      if (item.cloudRun && item.kind !== "codex-cli" && item.kind !== "claude-code") throw new Error("This provider does not support Cloud run.");
      const requestedRuleIds = new Set(normalizeBehaviorRuleIds(item.behaviorRuleIds));
      const behaviorRuleIds = (settings.chatBehaviorRules ?? []).map((rule) => rule.id).filter((id) => requestedRuleIds.has(id));
      const wantsAutoWatch = item.autoWatch === true || (item.autoWatch === undefined && role.participantDefaults?.autoWatch === true);
      const autoWatch = wantsAutoWatch && !autoWatchAlreadyAssigned;
      if (autoWatch) {
        autoWatchAlreadyAssigned = true;
      }
      return {
        id: randomUUID(),
        participantConfigId: item.participantConfigId?.trim() || undefined,
        handle,
        roleConfigId: item.roleConfigId,
        behaviorRuleIds,
        kind: item.kind as ChatProviderKind,
        model: item.model?.trim() || undefined,
        reasoningEffort: normalizeChatReasoningEffort(item.reasoningEffort, item.kind as ChatProviderKind),
        avatarId: item.avatarId?.trim() || undefined,
        ...participantHostFields(item.kind as ChatProviderKind, item.hostId, hosts),
        // Codex's Full Access is Codex's alone: another CLI stores Auto.
        agentMode: chatAgentModeForKind(item.kind as ChatProviderKind, item.agentMode),
        permissions: normalizeParticipantPermissionsForRole(role, item.permissions, item.permissions === undefined),
        remoteExecution: preservedRemoteExecution(item.remoteExecution),
        homeMachineId: item.homeMachineId || undefined,
        cloudRun: cloudRunSelection(item.cloudRun),
        skipToolchainPreflight: item.skipToolchainPreflight === true,
        autoWatch
      };
    });
  }

  /**
   * A new chat's main session (docs/main-session.md), first among its
   * members: an ordinary working member, on the CLI Settings names for it
   * (the provider the Chat Assistant had, resolved the same way), with the
   * rights an ordinary member starts with in this chat. Its role lets it ask
   * and add members without a card. The New chat screen's own row for it
   * (`requested`, when the User changed it there) is used as given.
   * `newChatDefaults`: a new chat (not a fork), which starts as Settings →
   * General → New chats says (src/shared/newChatDefaults.ts): without a row
   * from the screen, on its model, effort, mode and machine; always with its
   * compaction right and whether it creates scheduled tasks without a card,
   * which the screen has no control for.
   */
  async ensureMainSessionParticipant(
    participants: ChatParticipant[],
    preferredKind: ChatProviderKind | undefined,
    options: { repoPath?: string; hasProject?: boolean; requested?: ChatParticipantInput; newChatDefaults?: boolean } = {}
  ): Promise<ChatParticipant[]> {
    const existing = mainSessionMemberOf(participants);
    if (existing) {
      return [existing, ...participants.filter((participant) => participant !== existing)];
    }
    const settings = await this.deps.settings.getPublicSettings();
    const role = settings.chatRoleConfigs.find((candidate) => candidate.id === MAIN_SESSION_ROLE_ID);
    if (!role) {
      throw new Error(MAIN_SESSION_ROLE_MISSING_MESSAGE);
    }
    const requested = options.requested;
    const handles = new Set(participants.map((participant) => participant.handle.toLowerCase()));
    const handle = uniqueHandle(requested?.handle.trim().replace(/^@/, "") || MAIN_SESSION_HANDLE, handles);
    const kind = (requested?.kind as ChatProviderKind | undefined)
      ?? preferredKind
      ?? participants[0]?.kind
      ?? await this.defaultAdministratorProviderKind(settings.providers);
    const hasProject = options.hasProject ?? Boolean(options.repoPath?.trim());
    let agentMode: ChatAgentMode = requested?.agentMode ?? "default";
    let permissions: ChatAgentPermissions = requested?.permissions
      ?? normalizeParticipantPermissionsForRole(role, newChatMemberPermissions(hasProject), true);
    let started: Pick<ChatParticipantInput, "model" | "reasoningEffort" | "homeMachineId"> = {};
    if (options.newChatDefaults) {
      const machineIds = await Promise.resolve().then(() => this.deps.settings.listMachines())
        .then((machines) => machines.map((machine) => machine.id), () => undefined);
      const start = newChatMainSessionStart(settings.newChatDefaults, { kind, hostId: requested?.hostId?.trim() || undefined }, machineIds);
      if (!requested) {
        if (start.access) ({ agentMode, permissions } = applyChatAccessOptionById(kind, start.access, permissions));
        started = {
          ...(start.model ? { model: start.model } : {}),
          ...(start.reasoningEffort ? { reasoningEffort: start.reasoningEffort } : {}),
          ...(start.homeMachineId ? { homeMachineId: start.homeMachineId } : {})
        };
      }
      // A new chat's main session always runs in its CLI's own mode (the
      // sessions view has no other; the User, 2026-11-22): a row from a screen
      // that gave none runs in the CLI mode its settings amount to. The
      // phone's offer (no row) is left as it is: the phone applies the mode
      // for where its chat runs (newChatMainSessionFor).
      if (requested) ({ agentMode, permissions } = inCliOwnMode(kind, agentMode, permissions));
      permissions = withNewChatRights(permissions, start);
    }
    const [mainSession] = await this.validateParticipants([
      {
        ...(requested ?? {}),
        ...started,
        // Never a saved member: each chat makes its own main session.
        participantConfigId: undefined,
        handle,
        roleConfigId: role.id,
        kind,
        agentMode,
        permissions
      }
    ], participants, false, undefined, { mainSession: true });
    return mainSession ? [mainSession, ...participants] : participants;
  }

  private async ensureAdministratorParticipant(
    participants: ChatParticipant[],
    preferredKind?: ChatProviderKind
  ): Promise<ChatParticipant[]> {
    if (participants.some((participant) => participant.roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID)) {
      return participants;
    }
    const settings = await this.deps.settings.getPublicSettings();
    const adminRole = settings.chatRoleConfigs.find((role) => role.id === CHAT_ADMINISTRATOR_ROLE_ID);
    if (!adminRole) {
      return participants;
    }
    const existingHandles = new Set(participants.map((participant) => participant.handle.toLowerCase()));
    const handle = uniqueHandle(CHAT_ADMINISTRATOR_HANDLE, existingHandles);
    const kind = preferredKind ?? participants[0]?.kind ?? await this.defaultAdministratorProviderKind(settings.providers);
    const [administrator] = await this.validateParticipants([
      {
        handle,
        roleConfigId: adminRole.id,
        kind,
        avatarId: undefined,
        agentMode: "default",
        permissions: {
          repoRead: false,
          workspaceWrite: false,
          webAccess: false,
          requestParticipants: "ask",
          requestCompaction: "ask",
          shell: {
            enabled: false,
            rules: []
          }
        }
      }
    ], participants);
    return administrator ? [administrator, ...participants] : participants;
  }

  async defaultAdministratorProviderKind(
    providers: Array<Pick<ProviderSettings, "kind" | "enabled">>
  ): Promise<ChatProviderKind> {
    const agents = await this.deps.cliRunner.detectAgents().catch(() => []);
    const settings = await this.deps.settings.ensureAssistantProviderDefault(agents);
    const kind = resolveAssistantProviderKind({
      agents,
      providers: settings.providers.length > 0 ? settings.providers : providers,
      explicitKind: settings.assistantProviderKind
    });
    if (!kind) {
      throw new Error(NO_READY_CLI_MESSAGE);
    }
    return kind;
  }
}
