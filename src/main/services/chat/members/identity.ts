import { cloudRunSelection } from "../../../../shared/cloudRunPreparation";
import { memberAsItRunsNow } from "../../../../shared/forkToNewChat";
import { inCliOwnMode } from "../../../../shared/chatAccessModes";
import { MAIN_SESSION_ROLE_ID, isMainSessionChat, mainSessionParticipantId } from "../../../../shared/mainSession";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { hasConfiguredHostPlatform, userDataPath } from "../../../platform";
import type {
  AgentHealth, ChatAgentPermissions, ChatMessage, ChatParticipant, ChatParticipantConfig, ChatParticipantInput, CliProviderHost,
  ChatParticipantSession, ChatProviderKind, ChatRoleConfig, ChatRoleParticipantDefaults, Conversation,
  CreateChatConversationRequest, ParticipantConfig, ProviderSettings, UpdateChatParticipantRuntimeRequest
} from "../../../../shared/types";
import { turnFinishedNoteOf } from "../../../../shared/turnFinishedNoteSource";
import { accordClosedLaunchId } from "../../../../shared/accordProgress";
import { cliProviderHostDefaultModel, cliProviderHostForParticipant } from "../../../../shared/cliProviderHosts";
import {
  normalizeChatParticipantRequestPermission, normalizeChatAgentPermissions, normalizeOptionalChatParticipantRequestPermission
} from "../../../../shared/agentPermissions";
import { chatParticipantHome } from "../../../../shared/chatParticipantHome";
import { claudeCodePermissionMode, type ClaudePermissionMode } from "../../cliAgents";
import { agentReadinessReason, cliProviderMetadata, providerEnabled, readinessForParticipant } from "../../../../shared/cliReadiness";
import { CHAT_ADMINISTRATOR_ROLE_ID } from "../constants";
import { normalizeBehaviorRuleIds } from "./roleRuntime";
import { delegatedMemberCeiling } from "./rosterRequests";
import { storedRemoteRunParticipantIds } from "../store/messages";

/** Whether the computer moved a sessions-view chat's members into their
 *  CLI's own mode already: its shared mark, or its own record of it (kept
 *  when a server on an older program drops the shared one). */
export function cliModesConverted(metadata: { cliModesConvertedAt?: string; cliModesConvertedHereAt?: string }): boolean {
  return Boolean(metadata.cliModesConvertedAt || metadata.cliModesConvertedHereAt);
}

/** A new chat's requested members split into the New chat screen's main
 *  session row (when the User changed it there) and everyone else. A chat
 *  has one main session. */
export function splitMainSessionInput(items: ChatParticipantInput[]): { mainSession?: ChatParticipantInput; members: ChatParticipantInput[] } {
  const mainSessions = items.filter((item) => item.roleConfigId === MAIN_SESSION_ROLE_ID);
  if (mainSessions.length > 1) {
    throw new Error("A new chat starts with only one session of its own.");
  }
  return { mainSession: mainSessions[0], members: items.filter((item) => item.roleConfigId !== MAIN_SESSION_ROLE_ID) };
}

/** Members `before` had that `after` no longer has: a member list that
 *  arrived from another device removed them. */
export function membersDroppedFrom(before: Conversation, after: Conversation): ChatParticipant[] {
  const remaining = new Set(chatParticipants(after).map((participant) => participant.id));
  return chatParticipants(before).filter((participant) => !remaining.has(participant.id));
}

export function seededParticipantInputs(
  participantConfigs: ChatParticipantConfig[],
  seedState: { seededProviders?: Partial<Record<ChatProviderKind, { participantConfigId: string }>> } | undefined,
  installedCliKinds: ChatProviderKind[],
  enableRepoRead: boolean
): CreateChatConversationRequest["participants"] {
  const selectedIds = new Set(
    installedCliKinds
      .map((kind) => seedState?.seededProviders?.[kind]?.participantConfigId)
      .filter((id): id is string => Boolean(id))
  );
  return participantConfigs
    .filter((participant) => selectedIds.has(participant.id))
    .map((participant) => ({
      participantConfigId: participant.id,
      handle: participant.handle,
      roleConfigId: participant.roleConfigId,
      behaviorRuleIds: participant.behaviorRuleIds,
      kind: participant.kind,
      model: participant.model,
      reasoningEffort: participant.reasoningEffort,
      avatarId: participant.avatarId,
      hostId: participant.hostId,
      agentMode: participant.agentMode,
      permissions: enableRepoRead
        ? {
            ...normalizeChatAgentPermissions(participant.permissions),
            repoRead: true
          }
        : participant.permissions,
      remoteExecution: participant.remoteExecution,
      homeMachineId: participant.homeMachineId,
      cloudRun: participant.cloudRun,
      skipToolchainPreflight: participant.skipToolchainPreflight
    }));
}

export function chatUserDataPath(): string {
  return hasConfiguredHostPlatform() ? userDataPath() : path.join(tmpdir(), `accordagents-tests-${process.pid}`);
}

// --- moving a member with its session (memberSessionMove) -------------------

/** Whether an update moves the member to another device (or to a Cloud
 *  choice not prepared yet). */
export function participantHomeChangeRequested(current: ChatParticipant, request: UpdateChatParticipantRuntimeRequest): boolean {
  const nextHomeMachineId = Object.prototype.hasOwnProperty.call(request, "homeMachineId")
    ? (typeof request.homeMachineId === "string" && request.homeMachineId.trim() ? request.homeMachineId.trim() : undefined)
    : current.homeMachineId;
  const nextCloudRun = Object.prototype.hasOwnProperty.call(request, "cloudRun") ? cloudRunSelection(request.cloudRun) : current.cloudRun;
  return (nextHomeMachineId ?? "") !== (current.homeMachineId ?? "") || JSON.stringify(nextCloudRun) !== JSON.stringify(current.cloudRun);
}

/** Members added to a chat with a main session, however they were added
 *  (by her from the roster, on her approval card, by a member without a
 *  card), run in their CLI's own mode: the sessions view has only the CLIs'
 *  own modes (inCliOwnMode; the User, 2026-11-22: "no Custom in the
 *  sessions view"). Elsewhere as they are. */
export function inCliOwnModeInMainSessionChat(conversation: Conversation, added: ChatParticipant[]): ChatParticipant[] {
  if (!isMainSessionChat(conversation.metadata)) return added;
  return added.map((participant) => {
    if (normalizeChatAgentPermissions(participant.permissions).cliApprovals === true) return participant;
    return { ...participant, ...inCliOwnMode(participant.kind, participant.agentMode, participant.permissions) };
  });
}

/** The member as it runs this turn: one added without a card in a chat
 *  with a main session never above the main session's mode and rights as
 *  they are now (its right to manage members is held where it adds one,
 *  requireParticipantManager); every other member as it is. Never saved. */
export function participantForRun(conversation: Conversation, participant: ChatParticipant): ChatParticipant {
  // The rule is shared (memberAsItRunsNow): the phone forks a member as it
  // runs here.
  return memberAsItRunsNow(participant, delegatedMemberCeiling(conversation, participant)?.mainSession);
}

/** In a chat with a main session, its handle for every other member (they
 *  ask it, not User: docs/main-session.md); undefined for the main session
 *  itself and in a chat without one. */
export function mainSessionHandleForMember(conversation: Conversation, participant: ChatParticipant): string | undefined {
  const mainId = mainSessionParticipantId(conversation.metadata);
  if (!mainId || mainId === participant.id) {
    return undefined;
  }
  return chatParticipants(conversation).find((item) => item.id === mainId)?.handle;
}

/** The chat's main session (shared/mainSession.ts): named by the chat, or
 *  told by its role, which no other member is given. */
export function isChatMainSession(conversation: Conversation, participant: Pick<ChatParticipant, "id" | "roleConfigId">): boolean {
  return participant.roleConfigId === MAIN_SESSION_ROLE_ID || conversation.metadata.mainSessionParticipantId === participant.id;
}

export function isAdministratorSession(session: ChatParticipantSession): boolean {
  return session.roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID;
}

export function normalizedModel(value: string | undefined): string {
  return value?.trim() ?? "";
}

/** Vendor default model for a member on an added provider; undefined for
 *  built-in members and for vendors whose catalog is the CLI's own. */
export function participantHostDefaultModel(participant: Pick<ChatParticipant, "hostId" | "hostVendor">): string | undefined {
  return participant.hostId && participant.hostVendor ? cliProviderHostDefaultModel({ vendor: participant.hostVendor }) : undefined;
}

/** The CLI config an added provider adds to every launch of the member:
 *  Codex `-c` overrides or Antigravity session settings. */
export function cliParticipantWithHost(
  cliParticipant: ParticipantConfig,
  host: { codexConfigOverrides?: string[]; geminiSettings?: Record<string, unknown> }
): ParticipantConfig {
  const codex = host.codexConfigOverrides && host.codexConfigOverrides.length > 0 ? host.codexConfigOverrides : undefined;
  const gemini = host.geminiSettings && Object.keys(host.geminiSettings).length > 0 ? host.geminiSettings : undefined;
  return codex || gemini
    ? { ...cliParticipant, ...(codex ? { codexConfigOverrides: codex } : {}), ...(gemini ? { geminiSettings: gemini } : {}) }
    : cliParticipant;
}

export function lockParticipantRoleVersion(conversation: Conversation, participant: ChatParticipant, version: number): void {
  const participants = chatParticipants(conversation).map((item) =>
    item.id === participant.id ? { ...item, roleConfigVersion: version } : item
  );
  conversation.metadata = { ...conversation.metadata, participants };
}

export function upsertSession(conversation: Conversation, session: ChatParticipantSession): void {
  if (!session.executionSessionId) {
    session.executionSessionId = randomUUID();
  }
  const sessions = chatSessions(conversation);
  const next = sessions.some((item) => item.participantId === session.participantId)
    ? sessions.map((item) => (item.participantId === session.participantId ? session : item))
    : [...sessions, session];
  conversation.metadata = { ...conversation.metadata, participantSessions: next };
}

export function normalizeParticipantPermissionsForRole(
  role: ChatRoleConfig,
  permissions: unknown,
  useRoleDefault: boolean
): ChatAgentPermissions {
  const normalized = normalizeChatAgentPermissions(permissions);
  // Role/member management is intentionally not copied from the role here.
  // Undefined means "inherit" so role edits affect inheriting participants;
  // an explicit participant value is preserved and resolved at runtime.
  return useRoleDefault && role.participantDefaults?.requestParticipants
    ? {
        ...normalized,
        requestParticipants: role.participantDefaults.requestParticipants,
        requestCompaction: normalizeChatParticipantRequestPermission(role.participantDefaults.requestCompaction)
      }
    : useRoleDefault
      ? {
          ...normalized,
          requestCompaction: normalizeChatParticipantRequestPermission(role.participantDefaults?.requestCompaction)
        }
      : normalized;
}

export function normalizeRoleParticipantDefaults(value: unknown): ChatRoleParticipantDefaults | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<ChatRoleParticipantDefaults>;
  const requestParticipants = normalizeChatParticipantRequestPermission(record.requestParticipants);
  const requestCompaction = normalizeChatParticipantRequestPermission(record.requestCompaction);
  const manageRolesParticipants = normalizeOptionalChatParticipantRequestPermission(record.manageRolesParticipants);
  const defaults: ChatRoleParticipantDefaults = {};
  if (typeof record.autoWatch === "boolean") {
    defaults.autoWatch = record.autoWatch;
  }
  if (requestParticipants !== "ask") {
    defaults.requestParticipants = requestParticipants;
  }
  if (requestCompaction !== "ask") {
    defaults.requestCompaction = requestCompaction;
  }
  if (manageRolesParticipants) {
    defaults.manageRolesParticipants = manageRolesParticipants;
  }
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

/** Member fields for a host binding: the id plus a display snapshot of the
 *  provider's name and vendor. A binding that no longer resolves is dropped so
 *  the member falls back to its built-in CLI instead of failing forever. */
export function participantHostFields(
  kind: ChatProviderKind,
  hostId: string | undefined,
  hosts: ReadonlyArray<CliProviderHost>
): Pick<ChatParticipant, "hostId" | "hostLabel" | "hostVendor"> {
  const host = cliProviderHostForParticipant(kind, hostId?.trim() || undefined, hosts);
  return host
    ? { hostId: host.id, hostLabel: host.label, hostVendor: host.vendor }
    : { hostId: undefined, hostLabel: undefined, hostVendor: undefined };
}

export function assertParticipantProvidersReady(
  items: CreateChatConversationRequest["participants"],
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">>,
  hosts: ReadonlyArray<CliProviderHost> = []
): void {
  // Production detection always returns one normalized entry per CLI,
  // including environment-check failures. Empty snapshots are accepted only
  // for legacy focused-test doubles that predate readiness detection.
  if (agents.length === 0) {
    return;
  }
  for (const item of items) {
    // A member that does not run on this computer is not blocked by what is
    // installed here: its CLI is on its machine, or it has none yet.
    if (chatParticipantHome(item).kind !== "this-machine") {
      continue;
    }
    const kind = item.kind as ChatProviderKind;
    const host = cliProviderHostForParticipant(kind, item.hostId, hosts);
    const handle = item.handle.replace(/^@/, "");
    if (item.hostId?.trim() && !host) {
      throw new Error(`@${handle}: that provider no longer exists. Pick another provider for the member.`);
    }
    const state = readinessForParticipant({ kind, host }, agents, providers);
    if (state === "sign-in-required" && host) {
      throw new Error(`@${handle}: ${host.label} has no API key. Add one under Local CLI setup in Settings.`);
    }
    if (state !== "ready") {
      const label = cliProviderMetadata(kind).label;
      throw new Error(`@${handle}: ${agentReadinessReason(state, label) ?? `${label} is not ready.`}`);
    }
  }
}

export function assertParticipantProvidersEnabled(
  items: CreateChatConversationRequest["participants"],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">>
): void {
  for (const item of items) {
    if (chatParticipantHome(item).kind !== "this-machine") {
      continue;
    }
    const kind = item.kind as ChatProviderKind;
    if (!providerEnabled(providers, kind)) {
      throw new Error(`${cliProviderMetadata(kind).label} is disabled. Enable it in Settings.`);
    }
  }
}

export function uniqueHandle(base: string, existingHandles: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (existingHandles.has(candidate.toLowerCase())) {
    const suffixText = `-${suffix}`;
    candidate = `${base.slice(0, 32 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

/** Every member id the chat lists, as stored: an entry this build cannot
 *  read whole is still a member, never one that left. */
export function chatMemberIds(conversation: Conversation): Set<string> {
  const listed = conversation.metadata?.participants;
  return new Set(Array.isArray(listed)
    ? listed.flatMap((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : [])
    : []);
}

export function conversationForMembers(conversation: Conversation): Conversation {
  return conversation.messages.some((message) => isUserOnlyMessage(message))
    ? { ...conversation, messages: conversation.messages.filter((message) => !isUserOnlyMessage(message)) }
    : conversation;
}

/** A line of the User's own view of the chat, which members never read:
 *  a turn-finished note (it points at a reply that is there in full) and a
 *  closed Accord's line. */
export function isUserOnlyMessage(message: ChatMessage): boolean {
  return Boolean(turnFinishedNoteOf(message) || accordClosedLaunchId(message));
}

export function roleLabelForParticipant(conversation: Conversation, participant: ChatParticipant): string {
  const session = chatSessions(conversation).find((item) => item.participantId === participant.id);
  return session?.roleLabel ?? participant.roleConfigId;
}

export function messageAuthor(message: ChatMessage): string {
  if (message.role === "user") {
    return "User";
  }
  if (message.role === "participant") {
    return message.participantLabel ?? "Member";
  }
  if (message.role === "script") {
    return `Scheduled task "${message.metadata?.scriptName ?? message.participantLabel ?? "task"}"`;
  }
  return message.role;
}

export function formatHandleList(handles: string[]): string {
  if (handles.length <= 2) {
    return handles.join(handles.length === 2 ? " and " : "");
  }
  return `${handles.slice(0, -1).join(", ")}, and ${handles[handles.length - 1]}`;
}

export function chatParticipants(conversation: Conversation): ChatParticipant[] {
  const value = conversation.metadata.participants;
  return Array.isArray(value) ? value.filter((item): item is ChatParticipant => isChatParticipant(item)) : [];
}

export function setParticipantCompactionPermission(
  conversation: Conversation,
  participantId: string,
  permission: ChatAgentPermissions["requestCompaction"]
): ChatParticipant | undefined {
  const participants = chatParticipants(conversation);
  let updated: ChatParticipant | undefined;
  const nextParticipants = participants.map((participant) => {
    if (participant.id !== participantId) {
      return participant;
    }
    const permissions = normalizeChatAgentPermissions(participant.permissions);
    const requestCompaction = normalizeChatParticipantRequestPermission(permission);
    if (permissions.requestCompaction === requestCompaction) {
      updated = participant;
      return participant;
    }
    updated = {
      ...participant,
      permissions: {
        ...permissions,
        requestCompaction
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

export function chatParticipantHasRun(conversation: Conversation, participantId: string): boolean {
  if (Array.isArray(conversation.metadata.participantSessions)) {
    if (conversation.metadata.participantSessions.some((session) => session.participantId === participantId)) {
      return true;
    }
  }
  if (storedRemoteRunParticipantIds(conversation.metadata.remoteRunHandles).has(participantId)) {
    return true;
  }
  return conversation.messages.some((message) => message.role === "participant" && message.participantId === participantId);
}

export function syncParticipantFromSavedConfig(
  participant: ChatParticipant,
  config: Pick<ChatParticipantConfig, "id" | "kind" | "avatarId" | "behaviorRuleIds" | "hostId" | "model">,
  options: { behaviorRules?: boolean; host?: boolean; hosts?: ReadonlyArray<CliProviderHost> } = {}
): ChatParticipant {
  let synced = participant;
  if (synced.participantConfigId !== config.id) {
    synced = { ...synced, participantConfigId: config.id };
  }
  if (options.behaviorRules !== false) {
    const behaviorRuleIds = normalizeBehaviorRuleIds(config.behaviorRuleIds);
    if (!behaviorRuleIdsEqual(synced.behaviorRuleIds, behaviorRuleIds)) {
      synced = { ...synced, behaviorRuleIds };
    }
  }
  if (synced.kind === config.kind) {
    const avatarId = config.avatarId?.trim() || undefined;
    if ((synced.avatarId?.trim() || undefined) !== avatarId) {
      synced = { ...synced, avatarId };
    }
    // The provider binding is plumbing (where the CLI sends requests), so a
    // preset edit follows into every chat bound to that preset, like an avatar.
    // A preset whose provider was removed keeps a dangling id; the member keeps
    // its own binding then and fails with "was removed" instead of silently
    // running on the built-in CLI.
    const presetHostDangling = Boolean(config.hostId?.trim()) &&
      !cliProviderHostForParticipant(config.kind, config.hostId, options.hosts ?? []);
    if (options.host !== false && !presetHostDangling) {
      const fields = participantHostFields(config.kind, config.hostId, options.hosts ?? []);
      if ((synced.hostId ?? undefined) !== (fields.hostId ?? undefined)) {
        // A model id only exists on the side it came from (glm-* vs first-party
        // aliases), so moving the preset on or off a provider also takes the
        // preset's model; otherwise the member would keep sending the old id
        // to a backend that does not serve it.
        synced = { ...synced, ...fields, model: config.model?.trim() || undefined };
      } else if (synced.hostId && (synced.hostLabel !== fields.hostLabel || synced.hostVendor !== fields.hostVendor)) {
        synced = { ...synced, ...fields };
      }
    }
  }
  return synced;
}

function behaviorRuleIdsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeBehaviorRuleIds(left)) === JSON.stringify(normalizeBehaviorRuleIds(right));
}

export function participantConfigSyncKey(handle: string, kind: ChatProviderKind): string {
  return `${kind}:${handle.trim().replace(/^@/, "").toLowerCase()}`;
}

export function chatSessions(conversation: Conversation): ChatParticipantSession[] {
  const value = conversation.metadata.participantSessions;
  return Array.isArray(value)
    ? value.filter((item): item is ChatParticipantSession => {
        const session = item as Partial<ChatParticipantSession>;
        return typeof session.participantId === "string" && typeof session.sessionId === "string";
      })
    : [];
}

function isChatParticipant(item: unknown): item is ChatParticipant {
  const participant = item as Partial<ChatParticipant>;
  return (
    typeof participant.id === "string" &&
    typeof participant.handle === "string" &&
    typeof participant.roleConfigId === "string" &&
    (participant.kind === "codex-cli" || participant.kind === "claude-code" || participant.kind === "gemini-cli")
  );
}

/** Claude Code's permission mode for a member in Claude Code's own mode
 *  (`cliApprovals`), as it runs in this chat now (a member the main session
 *  made held to the main session's mode); undefined for any other member. */
export function claudeMemberMode(conversation: Conversation, member: ChatParticipant): ClaudePermissionMode | undefined {
  if (member.kind !== "claude-code") return undefined;
  const asRun = participantForRun(conversation, member);
  const permissions = normalizeChatAgentPermissions(asRun.permissions);
  return permissions.cliApprovals === true ? claudeCodePermissionMode(asRun.agentMode, permissions) : undefined;
}
