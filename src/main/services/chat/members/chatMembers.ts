import { cloudRunSelection } from "../../../../shared/cloudRunPreparation";
import { randomUUID } from "node:crypto";
import { memberSessionMoves, type ChatSessionHandoff } from "../../../../shared/memberSessionMove";
import type {
  AddChatParticipantRequest, ChatParticipant, ChatParticipantConfig, CliProviderHost, ChatParticipantSession, ChatProviderKind,
  Conversation, UpdateChatParticipantRuntimeRequest, RemoveChatParticipantRequest
} from "../../../../shared/types";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import { cliProviderHostDefaultModel } from "../../../../shared/cliProviderHosts";
import { CODEX_APPROVAL_TOOL_NAME } from "../../codexApprovals";
import { normalizeChatAgentPermissions, chatAgentModeForKind } from "../../../../shared/agentPermissions";
import { preservedRemoteExecution } from "../../../../shared/chatParticipantHome";
import { APP_CONNECTOR_SIGN_IN_TOOL } from "../../appMcp";
import { readActiveRunIds, readParticipantCompactions } from "../../../../shared/chatRunState";
import { activeRunSummaryForConversation, chatMemberIdsWithLiveWork } from "../../../../shared/chatRosterStatus";
import { chatAppToolApprovalPolicies, chatAppToolApprovals, isCodexApprovalRequest } from "../approvals/approvalRecords";
import { metadataWithAutoWatchDisabled, metadataWithAutoWatchEnabled } from "../autoWatch/watchers";
import { CHAT_ADMINISTRATOR_ROLE_ID } from "../constants";
import {
  assertParticipantProvidersReady, chatParticipantHasRun, chatParticipants, chatSessions, inCliOwnModeInMainSessionChat,
  isChatMainSession, participantConfigSyncKey, participantHomeChangeRequested, syncParticipantFromSavedConfig
} from "./identity";
import {
  appToolApprovalReferencesParticipant, cleanupRemovedParticipantMessageState, MAIN_SESSION_NOT_REMOVABLE_MESSAGE
} from "./removalRules";
import { normalizeBehaviorRuleIds } from "./roleRuntime";
import { isOpenParticipantRequestStatus } from "../requests/requestRecords";
import { createChatMessage } from "../store/messages";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** A member's move as updateParticipantRuntime saves it: the session it
 *  carries (none, or the one on the User's server) and the chat's line. */
export interface ParticipantMoveApplied {
  handoff?: ChatSessionHandoff;
  /** Its session was here and left with it. */
  dropLocalSession: boolean;
  line: string;
}

/** The chat's roster: adding, changing and removing members, and keeping them in step with Settings. */
export class ChatMembers {
  /** Members a flow here is about to run, or will resume, before their own
   *  turn is registered in chatRunMeta or shows a reply: removing one
   *  meanwhile would start a turn for a member that is gone. Keyed by the
   *  flow's run id (dropped with the run, forgetActiveChatRun) or by a token
   *  the claiming code releases itself. */
  readonly memberWorkClaims = new Map<string, { conversationId: string; participantIds: Set<string> }>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "agentEnvironment" | "autoWatch" | "choiceExpiry" | "codexApprovals" | "creation" | "host"
      | "memberMoves" | "participantRequests" | "promptSuggestions" | "runOwners" | "store" | "toolPermissions"
    >,
    private readonly deps: Pick<ChatDependencies, "settings" | "storage">
  ) {}

  /** A removed member's warm CLI process, and the background tasks it
   *  carries, end with its membership instead of lingering until the idle
   *  timeout. Called once the removal is saved. Only that member's own
   *  processes in this chat are closed (another member's turn is untouched),
   *  and only on the host that runs it: a machine member's process is closed
   *  by its machine when the member list it receives no longer has it (see
   *  membersDroppedFrom). Closing reports its background tasks as ended. */
  retireRemovedMembers(conversationId: string, removed: ChatParticipant[]): void {
    // Their waiting cards close (sweepChoiceExpiry), on whichever device wrote
    // them: a removal that arrived from another device included.
    if (removed.length > 0) this.chat.choiceExpiry.scheduleChoiceExpiry(conversationId, this.chat.choiceExpiry.choiceExpiryNow(), { replace: true });
    for (const participant of removed) {
      if (!this.chat.host.ownsParticipant(participant)) {
        continue;
      }
      void this.chat.agentEnvironment.closeWarmAgentsForParticipant(conversationId, participant.id, "member-removed");
    }
  }

  async addParticipant(request: AddChatParticipantRequest): Promise<Conversation | undefined> {
    const read = (await this.chat.store.readStoredChatStateForRefresh(request.conversationId)).stored;
    if (!read || read.kind !== "chat") {
      return read;
    }
    const conversation: Conversation = { ...read, messages: [], metadata: {} };
    // Checked before the chat's queue: probing the CLIs takes seconds, and
    // members that are running meanwhile save through the same queue.
    const settings = await this.deps.settings.getPublicSettings();
    const agents = await this.chat.agentEnvironment.detectAgentsForReadiness();
    assertParticipantProvidersReady([request.participant], agents, settings.providers ?? [], settings.cliProviderHosts ?? []);
    return this.chat.store.withSavedChat(conversation, async () => {
      const participants = chatParticipants(conversation);
      const [nextParticipant] = inCliOwnModeInMainSessionChat(conversation, await this.chat.creation.validateParticipants([request.participant], participants));
      conversation.metadata = {
        ...conversation.metadata,
        participants: [...participants, nextParticipant]
      };
      conversation.updatedAt = new Date().toISOString();
      conversation.messages.push(
        createChatMessage("system", `Added @${nextParticipant.handle} to the chat.`, undefined, {
          threadId: "system"
        })
      );
      await this.chat.store.saveConversation(conversation);
      if (nextParticipant.autoWatch === true) {
        this.chat.autoWatch.scheduleAutoWatchEvaluation(conversation.id, "participant-added");
      }
      return conversation;
    });
  }

  async updateParticipantRuntime(request: UpdateChatParticipantRuntimeRequest, moved?: ParticipantMoveApplied): Promise<Conversation | undefined> {
    const read = (await this.chat.store.readStoredChatStateForRefresh(request.conversationId)).stored;
    if (!read || read.kind !== "chat") {
      return read;
    }
    if (!moved && !this.chat.host.machineRuntime) {
      // A Claude Code member that already ran moves with its session.
      const current = chatParticipants(read).find((participant) => participant.id === request.participantId);
      if (current && memberSessionMoves(current) && participantHomeChangeRequested(current, request)) {
        const full = await this.chat.store.requireChat(request.conversationId);
        const member = chatParticipants(full).find((participant) => participant.id === request.participantId);
        if (member && chatParticipantHasRun(full, member.id)) return this.chat.memberMoves.moveParticipant(request, full, member);
      }
    }
    const conversation: Conversation = { ...read, messages: [], metadata: {} };
    return this.chat.store.withSavedChat(conversation, async () => {
      const participants = chatParticipants(conversation);
      const target = participants.find((participant) => participant.id === request.participantId);
      if (!target) {
        throw new Error("Chat member was not found.");
      }
      const nextRemoteExecution = preservedRemoteExecution(
        Object.prototype.hasOwnProperty.call(request, "remoteExecution")
          ? request.remoteExecution
          : target.remoteExecution
      );
      if (
        !moved &&
        nextRemoteExecution !== preservedRemoteExecution(target.remoteExecution) &&
        chatParticipantHasRun(conversation, target.id)
      ) {
        throw new Error("Run location is locked after the member has run. Remove and re-add the member to change it.");
      }
      // Machines transport: the member's sessions live on its home machine, so
      // the home is fixed once the member has run in this chat.
      const nextHomeMachineId = Object.prototype.hasOwnProperty.call(request, "homeMachineId")
        ? (typeof request.homeMachineId === "string" && request.homeMachineId.trim() ? request.homeMachineId.trim() : undefined)
        : target.homeMachineId;
      if (!moved && (nextHomeMachineId ?? "") !== (target.homeMachineId ?? "") && chatParticipantHasRun(conversation, target.id)) {
        throw new Error("The machine is locked after the member has run. Remove and re-add the member to change it.");
      }
      const nextCloudRun = Object.prototype.hasOwnProperty.call(request, "cloudRun")
        ? cloudRunSelection(request.cloudRun) : target.cloudRun;
      if (nextCloudRun && target.kind !== "codex-cli" && target.kind !== "claude-code") {
        throw new Error("This provider does not support Cloud run.");
      }
      if (!moved && JSON.stringify(nextCloudRun) !== JSON.stringify(target.cloudRun) && chatParticipantHasRun(conversation, target.id)) {
        throw new Error("Run location is locked after the member has run. Remove and re-add the member to change it.");
      }
      const autoWatchRequested = Object.prototype.hasOwnProperty.call(request, "autoWatch");
      const autoWatchChanged = autoWatchRequested && (request.autoWatch === true) !== (target.autoWatch === true);
      if (
        autoWatchChanged &&
        request.autoWatch === true &&
        participants.some((participant) => participant.id !== target.id && participant.autoWatch === true)
      ) {
        throw new Error("Only one member can watch a chat. Turn off the current watcher first.");
      }
      const updated: ChatParticipant = {
        ...target,
        model: typeof request.model === "string" ? request.model.trim() || undefined : target.model,
        // Sent at all, it is the effort from now on: none ("" or undefined)
        // is the CLI's own effort again.
        reasoningEffort: Object.prototype.hasOwnProperty.call(request, "reasoningEffort")
          ? normalizeChatReasoningEffort(request.reasoningEffort, target.kind)
          : target.reasoningEffort,
        agentMode: chatAgentModeForKind(target.kind, request.agentMode ?? target.agentMode),
        permissions: request.permissions !== undefined
          ? normalizeChatAgentPermissions(request.permissions)
          : target.permissions,
        remoteExecution: nextRemoteExecution,
        homeMachineId: nextHomeMachineId,
        cloudRun: nextCloudRun,
        sessionHandoff: moved ? moved.handoff : target.sessionHandoff,
        skipToolchainPreflight: Object.prototype.hasOwnProperty.call(request, "skipToolchainPreflight")
          ? request.skipToolchainPreflight === true
          : target.skipToolchainPreflight,
        autoWatch: autoWatchRequested ? request.autoWatch === true : target.autoWatch
      };
      let nextMetadata = conversation.metadata;
      if (autoWatchChanged) {
        nextMetadata = request.autoWatch === true
          ? metadataWithAutoWatchEnabled(conversation, target.id)
          : metadataWithAutoWatchDisabled(conversation.metadata, target.id);
      }
      if (!updated.sessionHandoff) delete updated.sessionHandoff;
      conversation.metadata = {
        ...nextMetadata,
        participants: participants.map((participant) => (participant.id === target.id ? updated : participant))
      };
      if (moved) {
        // The session left this device with the member (or never was here).
        if (moved.dropLocalSession) {
          conversation.metadata.participantSessions = chatSessions(conversation).filter((session) => session.participantId !== target.id);
        }
        conversation.messages.push(createChatMessage("system", moved.line));
      }
      conversation.updatedAt = new Date().toISOString();
      await this.chat.store.saveConversation(conversation);
      if (autoWatchChanged && request.autoWatch === true) {
        this.chat.autoWatch.scheduleAutoWatchEvaluation(conversation.id, "toggle-on");
      }
      return conversation;
    });
  }

  async removeParticipant(request: RemoveChatParticipantRequest): Promise<Conversation | undefined> {
    const read = (await this.chat.store.readStoredChatStateForRefresh(request.conversationId)).stored;
    if (!read || read.kind !== "chat") {
      return read;
    }
    const conversation: Conversation = { ...read, messages: [], metadata: {} };
    const retired: ChatParticipant[] = [];
    // Queued under the run lock, which every flow that starts a member's turn
    // holds while it picks its members: either this removal is queued first,
    // and the flow's next mutation (and the check where its turn starts,
    // runParticipantTurnSerialized) sees the member gone; or the flow has
    // claimed the member by the time this removal checks it (synchronously
    // once the lock is released, while this removal still reads the chat).
    // Only the queuing holds the lock, not the save.
    const queued = await this.chat.activeRuns.withChatRunLock(conversation.id, async () => ({
      done: this.chat.store.withSavedChat(conversation, async () => {
        retired.push(...this.removeParticipantsInMutation(conversation, [request.participantId], new Date().toISOString()));
        await this.chat.store.saveConversation(conversation);
        return conversation;
      })
    }));
    const saved = await queued.done;
    this.retireRemovedMembers(conversation.id, retired);
    return saved;
  }

  /**
   * The one member removal, shared by the member list (removeParticipant) and
   * an approved member request (applyQueuedMemberRemovals). The caller holds
   * the chat mutation and saves, and once the save succeeded passes the
   * returned members to retireRemovedMembers. Every target is checked before
   * anything is changed, so a refused removal leaves the chat untouched.
   *
   * Each removed member must be idle: its own turn would keep writing its
   * reply, approvals and session after this cleanup ran, and an open member
   * request involving it would resume a member that is gone. Another member's
   * work does not stop it. (An approved member request waits for the whole
   * chat to be idle before it gets here, memberRemovalMustWait.)
   */
  removeParticipantsInMutation(conversation: Conversation, participantIds: string[], now: string): ChatParticipant[] {
    const participants = chatParticipants(conversation);
    const targets: ChatParticipant[] = [];
    for (const participantId of new Set(participantIds)) {
      const target = participants.find((participant) => participant.id === participantId);
      if (!target) {
        throw new Error("Chat member was not found.");
      }
      targets.push(target);
    }
    const busy = targets.find((target) => this.memberHasLiveWork(conversation, target.id));
    if (busy) {
      throw new Error(`@${busy.handle} is busy and cannot be removed until its work ends.`);
    }
    const assistantId = participants.find((item) => item.roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID)?.id;
    if (targets.some((target) => target.id === assistantId)) {
      throw new Error("Chat Assistant cannot be removed from the chat.");
    }
    if (targets.some((target) => isChatMainSession(conversation, target))) {
      throw new Error(MAIN_SESSION_NOT_REMOVABLE_MESSAGE);
    }
    if (participants.length - targets.length < 1) {
      throw new Error("The last chat member cannot be removed.");
    }
    for (const target of targets) {
      // Drop the participant plus its resumable CLI session so a future re-add starts clean.
      const sessions = Array.isArray(conversation.metadata.participantSessions)
        ? (conversation.metadata.participantSessions as ChatParticipantSession[]).filter(
            (session) => session.participantId !== target.id
          )
        : conversation.metadata.participantSessions;
      conversation.metadata = {
        ...conversation.metadata,
        participants: chatParticipants(conversation).filter((participant) => participant.id !== target.id),
        participantSessions: sessions
      };
      conversation.metadata = metadataWithAutoWatchDisabled(conversation.metadata, target.id);
      this.cleanupRemovedParticipantState(conversation, target, now);
      this.chat.promptSuggestions.suggestions.forgetParticipant(conversation.id, target.id);
    }
    conversation.updatedAt = now;
    return targets;
  }

  memberRemovalBlockedByLiveWork(conversation: Conversation): boolean {
    return conversation.metadata.running === true || this.chat.activeRuns.chatHasLiveWork(conversation.id);
  }

  /** Whether this member's own work in the chat is live: what the saved chat
   *  shows (chatMemberIdsWithLiveWork), its turn registered here, a flow here
   *  that is about to run or resume it, or a member request it asked or
   *  answers that a runner here still works on. A run another app instance
   *  owns that names no member could be anyone's, so it counts for all. */
  private memberHasLiveWork(conversation: Conversation, participantId: string): boolean {
    if (chatMemberIdsWithLiveWork(conversation).has(participantId)) {
      return true;
    }
    for (const meta of this.chat.activeRuns.chatRunMeta.values()) {
      if (meta.conversationId === conversation.id && meta.participantId === participantId) {
        return true;
      }
    }
    for (const claim of this.memberWorkClaims.values()) {
      if (claim.conversationId === conversation.id && claim.participantIds.has(participantId)) {
        return true;
      }
    }
    for (const requestMessageId of this.chat.participantRequests.participantRequestRunners.keys()) {
      const batch = conversation.messages.find((message) => message.id === requestMessageId)?.metadata?.participantRequest;
      if (batch && (
        batch.requesterParticipantId === participantId ||
        batch.items.some((item) => item.targetParticipantId === participantId && isOpenParticipantRequestStatus(item.status))
      )) {
        return true;
      }
    }
    const attributed = activeRunSummaryForConversation(conversation).participantIdsByRunId;
    const compactionRunIds = new Set(Object.values(readParticipantCompactions(conversation.metadata)).map((state) => state.runId));
    return readActiveRunIds(conversation.metadata).some((runId) =>
      !attributed.has(runId) && !compactionRunIds.has(runId) && this.chat.runOwners.localRunOwnerState(conversation.metadata, runId) === "external-live"
    );
  }

  /** Claims these members for a flow until `release` (idempotent) is called. */
  claimMemberWork(conversationId: string, participantIds: readonly string[]): () => void {
    if (participantIds.length === 0) {
      return () => undefined;
    }
    const token = `claim:${randomUUID()}`;
    this.memberWorkClaims.set(token, { conversationId, participantIds: new Set(participantIds) });
    return () => { this.memberWorkClaims.delete(token); };
  }

  /** Claims members for a run until the run ends here (forgetActiveChatRun). */
  claimMembersForRun(conversationId: string, runId: string, participantIds: readonly string[] | undefined): void {
    if (!participantIds?.length) {
      return;
    }
    const existing = this.memberWorkClaims.get(runId);
    if (existing && existing.conversationId === conversationId) {
      for (const participantId of participantIds) existing.participantIds.add(participantId);
      return;
    }
    this.memberWorkClaims.set(runId, { conversationId, participantIds: new Set(participantIds) });
  }

  /** A turn of this member runs or waits here, or the saved chat shows one
   *  (its bubble, its compaction, a member request it answers or is being
   *  resumed for). A member that only waits for a request it asked is not
   *  answering: the reply resumes its session, which a restart keeps. */
  memberAnswersNow(conversation: Conversation, participantId: string): boolean {
    if (activeRunSummaryForConversation(conversation).participantIds.includes(participantId)) return true;
    const compaction = readParticipantCompactions(conversation.metadata)[participantId];
    if (compaction && readActiveRunIds(conversation.metadata).includes(compaction.runId)) return true;
    for (const message of conversation.messages) {
      if (message.role === "participant" && message.status === "pending" && message.participantId === participantId) return true;
      const batch = message.metadata?.participantRequest;
      if (batch?.items.some((item) => (item.status === "running" && item.targetParticipantId === participantId) ||
        (item.status === "resuming_requester" && batch.requesterParticipantId === participantId))) return true;
    }
    for (const meta of this.chat.activeRuns.chatRunMeta.values()) {
      if (meta.conversationId === conversation.id && meta.participantId === participantId) return true;
    }
    return false;
  }

  async syncSavedParticipantAvatar(
    previous: Pick<ChatParticipantConfig, "handle" | "kind"> | undefined,
    next: Pick<ChatParticipantConfig, "id" | "handle" | "kind" | "avatarId" | "hostId" | "model">
  ): Promise<void> {
    await this.syncSavedParticipantConfig(previous, next, { behaviorRules: false });
  }

  async syncSavedParticipantConfig(
    previous: Pick<ChatParticipantConfig, "handle" | "kind"> | undefined,
    next: Pick<ChatParticipantConfig, "id" | "handle" | "kind" | "avatarId" | "behaviorRuleIds" | "hostId" | "model">,
    options: { behaviorRules?: boolean } = {}
  ): Promise<void> {
    const hosts = (await this.deps.settings.getPublicSettings()).cliProviderHosts ?? [];
    const normalizedPreviousHandle = previous?.handle.trim().replace(/^@/, "").toLowerCase();
    const normalizedNextHandle = next.handle.trim().replace(/^@/, "").toLowerCase();
    const handleMatches = new Set([normalizedPreviousHandle, normalizedNextHandle].filter((handle): handle is string => Boolean(handle)));
    const kindMatches = new Set([previous?.kind, next.kind].filter((kind): kind is ChatProviderKind => Boolean(kind)));
    const summaries = await this.deps.storage.listConversations();
    for (const summary of summaries) {
      if (summary.kind !== "chat") {
        continue;
      }
      const conversation = await this.deps.storage.getConversation(summary.id);
      if (!conversation || conversation.kind !== "chat") {
        continue;
      }
      await this.chat.store.withChatMutation(conversation, async () => {
        const participants = chatParticipants(conversation);
        let changed = false;
        const hostMoved = new Set<string>();
        const syncedParticipants = participants.map((participant) => {
          const sameSavedParticipant = participant.participantConfigId === next.id || participant.id === next.id;
          const sameLegacyHandleAndKind = !participant.participantConfigId &&
            kindMatches.has(participant.kind) &&
            handleMatches.has(participant.handle.toLowerCase());
          if (!sameSavedParticipant && !sameLegacyHandleAndKind) {
            return participant;
          }
          // The handle+kind fallback exists for members created before presets
          // carried ids; it may follow cosmetics, but never a backend switch.
          const synced = syncParticipantFromSavedConfig(participant, next, { ...options, host: sameSavedParticipant, hosts });
          if ((synced.hostId ?? undefined) !== (participant.hostId ?? undefined)) {
            hostMoved.add(participant.id);
          }
          changed = changed || synced !== participant;
          return synced;
        });
        if (!changed) {
          return;
        }
        conversation.metadata = {
          ...conversation.metadata,
          participants: syncedParticipants
        };
        if (hostMoved.size > 0) {
          // A CLI session transcript belongs to the backend that produced it
          // (thinking blocks are signed by that side), so a member that moved on
          // or off a provider starts a fresh session on its next turn.
          for (const participantId of hostMoved) {
            await this.chat.agentEnvironment.closeWarmAgentsForParticipant(conversation.id, participantId);
          }
          conversation.metadata = {
            ...conversation.metadata,
            participantSessions: chatSessions(conversation).filter((session) => !hostMoved.has(session.participantId))
          };
        }
        await this.chat.store.saveConversation(conversation);
        this.chat.store.queueSnapshot(conversation);
      });
    }
  }

  async removeBehaviorRuleFromChatParticipants(ruleId: string): Promise<void> {
    const normalized = ruleId.trim();
    if (!normalized) {
      return;
    }
    const summaries = await this.deps.storage.listConversations();
    for (const summary of summaries) {
      if (summary.kind !== "chat") {
        continue;
      }
      const conversation = await this.deps.storage.getConversation(summary.id);
      if (!conversation || conversation.kind !== "chat") {
        continue;
      }
      await this.chat.store.withChatMutation(conversation, async () => {
        const participants = chatParticipants(conversation);
        let changed = false;
        const syncedParticipants = participants.map((participant) => {
          const behaviorRuleIds = normalizeBehaviorRuleIds(participant.behaviorRuleIds);
          const nextRuleIds = behaviorRuleIds.filter((id) => id !== normalized);
          if (nextRuleIds.length === behaviorRuleIds.length) {
            return participant;
          }
          changed = true;
          return { ...participant, behaviorRuleIds: nextRuleIds };
        });
        if (!changed) {
          return;
        }
        conversation.metadata = {
          ...conversation.metadata,
          participants: syncedParticipants
        };
        await this.chat.store.saveConversation(conversation);
      });
    }
  }

  async syncConversationParticipantsFromSettings(conversation: Conversation): Promise<boolean> {
    const settings = await this.deps.settings.getPublicSettings();
    const participantConfigs = settings.chatParticipantConfigs ?? [];
    if (participantConfigs.length === 0) {
      return false;
    }
    const hosts = settings.cliProviderHosts ?? [];
    const configsById = new Map(participantConfigs.map((config) => [config.id, config]));
    const configsByHandleAndKind = new Map(
      participantConfigs.map((config) => [participantConfigSyncKey(config.handle, config.kind), config])
    );
    const participants = chatParticipants(conversation);
    let changed = false;
    const syncedParticipants = participants.map((participant) => {
      const config = participant.participantConfigId
        ? configsById.get(participant.participantConfigId)
        : configsByHandleAndKind.get(participantConfigSyncKey(participant.handle, participant.kind));
      if (!config) {
        return participant;
      }
      const synced = syncParticipantFromSavedConfig(participant, config, { host: Boolean(participant.participantConfigId), hosts });
      changed = changed || synced !== participant;
      return synced;
    });
    if (!changed) {
      return false;
    }
    conversation.metadata = {
      ...conversation.metadata,
      participants: syncedParticipants
    };
    return true;
  }

  /** A provider was removed in Settings: retire every warm process still holding
   *  its key. Bindings stay (members fail visibly on their next turn). */
  async retireCliProviderHost(hostId: string): Promise<void> {
    const summaries = await this.deps.storage.listConversations();
    for (const summary of summaries) {
      if (summary.kind !== "chat") {
        continue;
      }
      const conversation = await this.deps.storage.getConversation(summary.id);
      if (!conversation || conversation.kind !== "chat") {
        continue;
      }
      for (const participant of chatParticipants(conversation)) {
        if (participant.hostId === hostId) {
          await this.chat.agentEnvironment.closeWarmAgentsForParticipant(conversation.id, participant.id);
        }
      }
    }
  }

  /** A provider was edited in Settings: refresh the name/vendor snapshot on every
   *  chat member bound to it, and give members whose vendor changed a fresh CLI
   *  session (transcripts belong to the backend that produced them). */
  async syncCliProviderHost(host: CliProviderHost): Promise<void> {
    const summaries = await this.deps.storage.listConversations();
    for (const summary of summaries) {
      if (summary.kind !== "chat") {
        continue;
      }
      const conversation = await this.deps.storage.getConversation(summary.id);
      if (!conversation || conversation.kind !== "chat") {
        continue;
      }
      await this.chat.store.withChatMutation(conversation, async () => {
        const vendorChanged = new Set<string>();
        let changed = false;
        const participants = chatParticipants(conversation).map((participant) => {
          if (participant.hostId !== host.id || participant.kind !== host.cli) {
            return participant;
          }
          if (participant.hostLabel === host.label && participant.hostVendor === host.vendor) {
            return participant;
          }
          if (participant.hostVendor !== host.vendor) {
            vendorChanged.add(participant.id);
          }
          changed = true;
          return {
            ...participant,
            hostLabel: host.label,
            hostVendor: host.vendor,
            model: participant.hostVendor !== host.vendor ? cliProviderHostDefaultModel(host) : participant.model
          };
        });
        if (!changed) {
          return;
        }
        for (const participantId of vendorChanged) {
          await this.chat.agentEnvironment.closeWarmAgentsForParticipant(conversation.id, participantId);
        }
        conversation.metadata = {
          ...conversation.metadata,
          participants,
          participantSessions: vendorChanged.size > 0
            ? chatSessions(conversation).filter((session) => !vendorChanged.has(session.participantId))
            : conversation.metadata.participantSessions
        };
        await this.chat.store.saveConversation(conversation);
        this.chat.store.queueSnapshot(conversation);
      });
    }
  }

  private cleanupRemovedParticipantState(conversation: Conversation, participant: ChatParticipant, now: string): void {
    const removalError = "Member was removed from this chat.";
    const approvals = chatAppToolApprovals(conversation).map((approval) => {
      if (approval.status !== "pending" || !appToolApprovalReferencesParticipant(conversation, approval, participant)) {
        return approval;
      }
      if (approval.toolName === APP_CONNECTOR_SIGN_IN_TOOL) {
        this.chat.toolPermissions.resolveToolPermissionApproval(approval.id, { approve: false, source: "abort", reason: removalError });
        return { ...approval, status: "expired" as const, updatedAt: now, error: removalError };
      }
      if (approval.toolName === CODEX_APPROVAL_TOOL_NAME && isCodexApprovalRequest(approval.request)) {
        const resolver = this.chat.codexApprovals.codexApprovalResolvers.get(approval.id);
        if (resolver) {
          resolver.cleanup();
          resolver.reject(new Error(removalError));
        }
        return {
          ...approval,
          status: "expired" as const,
          updatedAt: now,
          error: removalError
        };
      }
      return {
        ...approval,
        status: "denied" as const,
        updatedAt: now,
        error: removalError
      };
    });
    const policies = chatAppToolApprovalPolicies(conversation).filter((policy) =>
      policy.participantId !== participant.id && policy.targetParticipantId !== participant.id
    );
    conversation.metadata = {
      ...conversation.metadata,
      pendingAppToolApprovals: approvals,
      appToolApprovalPolicies: policies
    };
    conversation.messages = conversation.messages.map((message) =>
      cleanupRemovedParticipantMessageState(message, participant, now, removalError)
    );
  }
}
