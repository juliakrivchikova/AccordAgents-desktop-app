// Fork to new chat (the User, 2026-11-21): any member of any chat (a main
// session, a member it made, a member of a chat from before with its Chat
// Assistant) is copied into a new chat as that chat's main session, with all
// it knew. The new chat opens empty; its first message forks the member's CLI
// session through the CLI's own fork (Claude Code `--resume <id>
// --fork-session`, Codex app-server `thread/fork`), as the main session's
// "fork" tasks do (docs/main-session.md). The member and its chat stay as
// they were. The copy is what the User saw when she tapped Fork (the User,
// 2026-11-21: "When you tap Fork — Like the CLI: the copy is exactly what you
// saw at that moment"): the device that makes the chat records the member's
// last reply that ended a turn (forkOrigin.seen), and the device that holds
// the session copies it only up to that turn (Claude Code
// `--resume-session-at`, Codex `lastTurnId`).
//
// Shared so the desktop's menus and the phone's say why it is not offered
// with the same words the service refuses it with, and so the phone makes the
// new chat's main session as the computer does (bundled for the phone through
// mobileSharedRules.ts).

import { inCliOwnMode } from "./chatAccessModes";
import {
  clampChatAgentAccess,
  chatAgentPermissionsEqual,
  effectiveChatAgentPermissionsForProvider,
  normalizeChatAgentMode,
  normalizeChatAgentPermissions
} from "./agentPermissions";
import { chatParticipantHome, preservedRemoteExecution } from "./chatParticipantHome";
import { cliProviderHostForParticipant } from "./cliProviderHosts";
import { agentReadinessReason, cliProviderMetadata, readinessForParticipant } from "./cliReadiness";
import type {
  AgentHealth,
  ChatAgentMode,
  ChatAgentPermissions,
  ChatForkSeenReply,
  ChatMessageSessionCut,
  ChatParticipant,
  ChatParticipantForkOrigin,
  ChatProviderKind,
  ChatSessionForkCut,
  CliProviderHost,
  ConversationMetadata,
  ProviderSettings
} from "./types";

export const FORK_TO_NEW_CHAT_LABEL = "Fork to new chat";

/** What the menus show under the item when it can be chosen, in both views:
 *  no words name a main session (the User, 2026-11-22). */
export const FORK_TO_NEW_CHAT_DETAIL = "A new chat that starts from a copy of this session";

const CHAT_TITLE_MAX_LENGTH = 80;
const FORK_TITLE_SUFFIX = " (fork)";

/** The new chat's title until its first reply names it: the source chat's,
 *  marked as a fork, within the title's length. */
export function forkedChatTitle(sourceTitle: string): string {
  const base = sourceTitle.replace(/\s+/g, " ").trim() || "Chat";
  return `${base.slice(0, CHAT_TITLE_MAX_LENGTH - FORK_TITLE_SUFFIX.length).trim()}${FORK_TITLE_SUFFIX}`;
}

/** Whether a member's machine runs a program that starts a chat from a copy
 *  of a member's session, by the last hello it sent this computer. */
export type ForkToNewChatMachineSupport = "supported" | "outdated" | "unknown";

export interface ForkToNewChatCheck {
  participant: Pick<ChatParticipant, "kind" | "homeMachineId" | "cloudRun" | "remoteExecution">;
  /** It has a CLI session to copy (it ran at least once). */
  hasSession: boolean;
  /** It runs through an added provider Settings no longer has: its copy
   *  would run on another provider (wherever it runs). */
  hostMissing?: boolean;
  /** Why its CLI on this computer cannot run it now (only for a member that
   *  runs here; a machine's member runs on that machine's CLI). */
  providerUnavailable?: string;
  /** For a member on a machine: what that machine's program can do. */
  machineSupport?: ForkToNewChatMachineSupport;
}

export const FORK_TO_NEW_CHAT_PROVIDER_GONE = "Its provider no longer exists.";

/** The CLIs whose sessions a fork can copy (Claude Code, Codex). */
export function isForkableSessionKind(kind: ChatProviderKind): kind is "claude-code" | "codex-cli" {
  return kind === "claude-code" || kind === "codex-cli";
}

/**
 * Why this member cannot be forked to a new chat now, or undefined when it
 * can. The new chat's main session runs where the member runs (a fork never
 * crosses devices), on its CLI (never another provider), so:
 * - Antigravity has no fork;
 * - a member waiting for a machine has no session anywhere yet;
 * - a member that never ran has no session to copy;
 * - a member on an added provider Settings no longer has would run on
 *   another one;
 * - a member on a machine needs that machine's program to do the fork;
 * - a member on this computer needs its CLI ready here.
 */
export function forkToNewChatUnavailableReason(check: ForkToNewChatCheck): string | undefined {
  const { participant } = check;
  if (participant.kind === "gemini-cli") {
    return "Antigravity has no session fork.";
  }
  if (!isForkableSessionKind(participant.kind)) {
    return "Only Claude Code and Codex sessions can be forked.";
  }
  const home = chatParticipantHome(participant);
  if (home.kind === "unassigned" || home.kind === "cloud-pending") {
    return "It has no machine to run on yet.";
  }
  if (!check.hasSession) {
    return "It has not run yet, so it has no session to copy.";
  }
  if (check.hostMissing) {
    return FORK_TO_NEW_CHAT_PROVIDER_GONE;
  }
  if (home.kind === "machine") {
    if (check.machineSupport === "outdated") {
      return "Its machine runs an older program. Upgrade its runtime in Settings → Machines.";
    }
    if (check.machineSupport !== "supported") {
      return "Its machine has not connected to this computer yet.";
    }
    return undefined;
  }
  return check.providerUnavailable;
}

type SessionsMetadata = Pick<ConversationMetadata, "lastMessageByParticipant"> & { participantSessions?: unknown };

/** A chat message as the rule for "it ran" reads it. */
export interface ForkMessageView {
  id?: string;
  role: string;
  participantId?: string;
  status?: string;
  metadata?: { serverPlaceholder?: unknown } | object;
}

/** A reply that shows the member ran: finished (an error too: its CLI ran),
 *  never one still being written nor the placeholder a device shows while
 *  a turn runs elsewhere. Her server reads its copy of the chat by the same
 *  rule (StorageService.conversationParticipantAnswered). */
export function isFinishedMemberReply(message: ForkMessageView, participantId: string): boolean {
  return message.role === "participant" && message.participantId === participantId && message.status !== "pending" &&
    (message.metadata as { serverPlaceholder?: unknown } | undefined)?.serverPlaceholder !== true;
}

/** A reply as the fork's cut reads it. */
export interface ForkReplyView extends ForkMessageView {
  id: string;
  createdAt?: string;
}

const SESSION_CUT_FIELD_MAX = 200;

/** A recorded cut, when it is one (ChatMessageMetadata.sessionCut). */
export function sessionCutOf(value: unknown): ChatMessageSessionCut | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { sessionId, at } = value as { sessionId?: unknown; at?: unknown };
  const usable = (text: unknown): text is string => typeof text === "string" && text.trim().length > 0 && text.length <= SESSION_CUT_FIELD_MAX;
  return usable(sessionId) && usable(at) ? { sessionId: sessionId.trim(), at: at.trim() } : undefined;
}

/** When a reply finished, on the clock of the device that ran its turn:
 *  workedMs counts from its turn's start (or its creation), as the device
 *  set both. Undefined for a reply that never ended a turn. */
export function memberReplyFinishedAt(message: Pick<ForkReplyView, "createdAt" | "metadata">): string | undefined {
  const metadata = message.metadata as { workedMs?: unknown; turnStartedAt?: unknown } | undefined;
  const worked = metadata?.workedMs;
  if (typeof worked !== "number" || !Number.isFinite(worked) || worked < 0) return undefined;
  const start = Date.parse(typeof metadata?.turnStartedAt === "string" ? metadata.turnStartedAt : message.createdAt ?? "");
  return Number.isFinite(start) ? new Date(start + worked).toISOString() : undefined;
}

/**
 * A finished reply that ended a turn of the member's CLI: its turn recorded
 * where the session stood (sessionCut) or how long it worked (workedMs, set
 * only when a turn ends). Never a post, a request or an Accord launch written
 * during a turn, so a turn still running when the User tapped Fork is left
 * out with everything it posted. Her server reads its copy of the chat by the
 * same rule (StorageService.conversationLastTurnEnd).
 */
export function isMemberTurnEnd(message: ForkReplyView, participantId: string): boolean {
  if (!isFinishedMemberReply(message, participantId)) return false;
  const metadata = message.metadata as { workedMs?: unknown; sessionCut?: unknown } | undefined;
  return (typeof metadata?.workedMs === "number" && Number.isFinite(metadata.workedMs)) || Boolean(sessionCutOf(metadata?.sessionCut));
}

/** What the fork keeps of the reply the User saw last: the same fields on
 *  the computer and the phone (through her server). */
export function forkSeenReplyOf(message: ForkReplyView): ChatForkSeenReply {
  const sessionCut = sessionCutOf((message.metadata as { sessionCut?: unknown } | undefined)?.sessionCut);
  const finishedAt = memberReplyFinishedAt(message);
  return { messageId: message.id, ...(sessionCut ? { sessionCut } : {}), ...(finishedAt ? { finishedAt } : {}) };
}

/** The member's newest reply that ended a turn among these messages (oldest
 *  first), as the fork keeps it. */
export function lastMemberTurnEnd(messages: ReadonlyArray<ForkReplyView>, participantId: string): ChatForkSeenReply | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (isMemberTurnEnd(message, participantId)) return forkSeenReplyOf(message);
  }
  return undefined;
}

/**
 * Where the copy of the member's session ends, read on the device that holds
 * it (`sessionId`: the member's session there): at the CLI's own point its
 * reply recorded (in the session that reply was in), by the reply's finish
 * for a reply from before that, and nowhere (the whole session, said in the
 * chat) when neither can be named.
 */
export function forkCutFor(seen: ChatForkSeenReply | undefined, sessionId: string): ChatSessionForkCut {
  if (!seen) return { unknown: "the app found no reply of it that ended a turn" };
  if (seen.sessionCut) {
    // Its session changed after that reply (a session lost and started
    // again): the one the reply was in is what she saw.
    return seen.sessionCut.sessionId === sessionId ? { at: seen.sessionCut.at } : { at: seen.sessionCut.at, sessionId: seen.sessionCut.sessionId };
  }
  if (seen.finishedAt) return { finishedBy: seen.finishedAt };
  return { unknown: "its last reply does not say where it ended in its session" };
}

/**
 * Whether the member has a finished reply in the chat, by the messages held
 * and its last-message pointer: the messages held can be a window, and its
 * newest message outside it was finished.
 */
export function memberHasFinishedReply(
  pointers: unknown,
  participantId: string,
  loadedMessages: ReadonlyArray<ForkMessageView> = []
): boolean {
  if (loadedMessages.some((message) => isFinishedMemberReply(message, participantId))) return true;
  const pointer = pointers && typeof pointers === "object" && !Array.isArray(pointers)
    ? (pointers as Record<string, unknown>)[participantId] as { messageId?: unknown } | undefined
    : undefined;
  if (!pointer || typeof pointer !== "object" || typeof pointer.messageId !== "string") return false;
  return !loadedMessages.some((message) => message.id === pointer.messageId);
}

/**
 * Whether the member has a CLI session to copy, as this device knows it: one
 * that runs here by its session record (an id of its own; a fork whose copy
 * was never made has none) or a session moved here that it has not taken
 * yet (the fork takes it, startFromForkOrigin); one on a machine, whose
 * session only that machine holds, by whether it has a finished reply in the
 * chat (the rule the phone reads from her server).
 */
export function memberHasForkableSession(
  metadata: SessionsMetadata | undefined,
  participant: Pick<ChatParticipant, "id" | "homeMachineId" | "cloudRun" | "remoteExecution" | "sessionHandoff">,
  loadedMessages: ReadonlyArray<ForkMessageView> = []
): boolean {
  if (chatParticipantHome(participant).kind === "machine") {
    return memberHasFinishedReply(metadata?.lastMessageByParticipant, participant.id, loadedMessages);
  }
  if (participant.sessionHandoff) return true;
  const sessions: unknown[] = Array.isArray(metadata?.participantSessions) ? metadata!.participantSessions as unknown[] : [];
  return sessions.some((session) => {
    const record = session as { participantId?: unknown; sessionId?: unknown } | null;
    return Boolean(record) && record!.participantId === participant.id && typeof record!.sessionId === "string" && record!.sessionId.trim().length > 0;
  });
}

/** What a machine's program can do for Fork to new chat, by the last hello
 *  it sent this computer (none yet: unknown). */
export function forkToNewChatSupportFromHello(hello: { forkToNewChatSupported?: boolean } | undefined): ForkToNewChatMachineSupport {
  if (!hello) return "unknown";
  return hello.forkToNewChatSupported === true ? "supported" : "outdated";
}

/**
 * Why this member of a chat (as it runs now) cannot be forked to a new chat,
 * judged on this computer: the service refuses with these words and its
 * menus show them (ChatService.forkToNewChatRefusal, the renderer's
 * forkToNewChatReasonFor).
 */
export function forkToNewChatReasonInChat(input: {
  participant: ChatParticipant;
  conversation: { metadata?: SessionsMetadata; messages?: ReadonlyArray<ForkMessageView> };
  agents: AgentHealth[];
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">>;
  hosts: ReadonlyArray<CliProviderHost>;
  machineSupport: (machineId: string) => ForkToNewChatMachineSupport;
}): string | undefined {
  const { participant } = input;
  const home = chatParticipantHome(participant);
  return forkToNewChatUnavailableReason({
    participant,
    hasSession: memberHasForkableSession(input.conversation.metadata, participant, input.conversation.messages ?? []),
    hostMissing: Boolean(participant.hostId) && !cliProviderHostForParticipant(participant.kind, participant.hostId, input.hosts),
    providerUnavailable: home.kind === "this-machine"
      ? localProviderUnavailableReason(participant, input.agents, input.providers, input.hosts)
      : undefined,
    machineSupport: home.kind === "machine" ? input.machineSupport(home.machineId) : undefined
  });
}

/** Why this computer's CLI cannot run a member that runs here now, in the
 *  words the New chat screen uses (validateChatCliAgents); undefined when it
 *  can, and when nothing was detected (no readiness to judge by). */
export function localProviderUnavailableReason(
  participant: Pick<ChatParticipant, "kind" | "hostId">,
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">> = [],
  hosts: ReadonlyArray<CliProviderHost> = []
): string | undefined {
  if (agents.length === 0) return undefined;
  const host = cliProviderHostForParticipant(participant.kind, participant.hostId, hosts);
  if (participant.hostId && !host) return FORK_TO_NEW_CHAT_PROVIDER_GONE;
  const readiness = readinessForParticipant({ kind: participant.kind, host }, agents, providers);
  if (readiness === "sign-in-required" && host) return `${host.label} has no API key. Add one under Local CLI setup in Settings.`;
  if (readiness === "ready") return undefined;
  const label = cliProviderMetadata(participant.kind).label;
  return agentReadinessReason(readiness, label) ?? `${label} is not ready.`;
}

/**
 * A member as it runs this turn: one added without a card in a chat with a
 * main session (delegatedByParticipantId) never above the main session's mode
 * and rights as they are now (its right to manage members is its own); every
 * other member as it is. The desktop's turns run it so (ChatService
 * participantForRun), and a fork copies it so, on the computer and the phone.
 */
export function memberAsItRunsNow(participant: ChatParticipant, mainSession: ChatParticipant | undefined): ChatParticipant {
  if (!participant.delegatedByParticipantId || !mainSession || mainSession.id === participant.id) {
    return participant;
  }
  const mode = normalizeChatAgentMode(mainSession.agentMode);
  const ceiling = effectiveChatAgentPermissionsForProvider(mainSession.kind, mode, normalizeChatAgentPermissions(mainSession.permissions));
  const own = normalizeChatAgentPermissions(participant.permissions);
  const access = clampChatAgentAccess(participant.kind, { agentMode: participant.agentMode, permissions: own }, { agentMode: mode, permissions: ceiling });
  const { manageRolesParticipants: _manage, ...clamped } = access.permissions;
  const permissions: ChatAgentPermissions = own.manageRolesParticipants ? { ...clamped, manageRolesParticipants: own.manageRolesParticipants } : clamped;
  const agentMode = access.agentMode;
  if (agentMode === normalizeChatAgentMode(participant.agentMode) && chatAgentPermissionsEqual(permissions, own)) {
    return participant;
  }
  return { ...participant, agentMode, permissions };
}

/**
 * The new chat's main session's mode and rights: the member's access as it
 * runs now (what it may read, edit, run and reach, and whether it compacts
 * its context or creates scheduled tasks without asking) in its CLI's own mode, the one it was running
 * in (inCliOwnMode: the sessions view has only the CLIs' own modes, never
 * "Custom"; the User, 2026-11-22), with the main session's own say over
 * members (`base`: what its role gives a new main session). Never more than
 * the member has, besides that say. Settings → General's defaults for new
 * chats are not used: the fork is the member as it is (the User, 2026-11-22:
 * a forked member allowed to compact must not be asked).
 */
export function forkedMainSessionAccess(
  base: ChatAgentPermissions,
  member: Pick<ChatParticipant, "kind" | "agentMode" | "permissions">
): { agentMode: ChatAgentMode; permissions: ChatAgentPermissions } {
  const access = inCliOwnMode(member.kind, member.agentMode, member.permissions);
  return { agentMode: access.agentMode, permissions: forkedMainSessionPermissions(base, access.permissions) };
}

/** forkedMainSessionAccess's rights for a member already in its CLI's own
 *  mode (its rights as they are, with the main session's say over members). */
export function forkedMainSessionPermissions(base: ChatAgentPermissions, memberPermissions: ChatAgentPermissions | undefined): ChatAgentPermissions {
  const own = normalizeChatAgentPermissions(memberPermissions);
  const { providerNative: _baseNative, cliApprovals: _baseApprovals, codexPlanMode: _basePlan, scheduleWithoutAsking: _baseSchedule, ...rest } = normalizeChatAgentPermissions(base);
  return {
    ...rest,
    repoRead: own.repoRead,
    workspaceWrite: own.workspaceWrite,
    webAccess: own.webAccess,
    requestCompaction: own.requestCompaction,
    ...(own.scheduleWithoutAsking ? { scheduleWithoutAsking: true as const } : {}),
    shell: { enabled: own.shell.enabled, rules: own.shell.rules.map((rule) => ({ ...rule })) },
    ...(own.providerNative ? { providerNative: own.providerNative } : {}),
    ...(own.cliApprovals ? { cliApprovals: true as const } : {}),
    ...(own.cliApprovals && own.codexPlanMode ? { codexPlanMode: true as const } : {})
  };
}

/** Where the new chat's main session comes from (ChatParticipant.forkOrigin):
 *  the member, its chat, and the reply the User saw last when she tapped
 *  Fork (the copy ends with that turn). */
export function forkOriginFor(
  source: { id: string; title: string },
  member: Pick<ChatParticipant, "id" | "handle" | "kind">,
  seen?: ChatForkSeenReply
): ChatParticipantForkOrigin {
  return {
    conversationId: source.id, participantId: member.id, handle: member.handle, conversationTitle: source.title, kind: member.kind,
    ...(seen ? { seen } : {})
  };
}

/** What the computer tells the phone, with its New chat offer, so the phone
 *  forks a member as the computer would (HubNewChatOptions.fork). */
export interface ForkToNewChatOffer {
  /** Whether the computer could tell which CLIs are ready (it detected
   *  them); otherwise no member here is refused for its CLI. */
  judged: boolean;
  /** Each CLI on the computer a forkable member can run on, with why it
   *  cannot now (localProviderUnavailableReason); none: it can. */
  localProviders: Array<{ kind: ChatProviderKind; hostId?: string; unavailable?: string }>;
  /** Each machine's program, by the last hello it sent the computer. */
  machines: Record<string, ForkToNewChatMachineSupport>;
  /** What the main session's role gives a new main session (its say over
   *  members; what it may read and do is the member's). */
  basePermissions: ChatAgentPermissions;
}

/** The computer's CLIs a forked main session can run on, as its New chat
 *  offer tells the phone: Claude Code and Codex, and each added provider
 *  that runs through either. */
export function forkToNewChatLocalProviders(
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">>,
  hosts: ReadonlyArray<CliProviderHost>
): Pick<ForkToNewChatOffer, "judged" | "localProviders"> {
  const kinds: ChatProviderKind[] = ["claude-code", "codex-cli"];
  const candidates: Array<{ kind: ChatProviderKind; hostId?: string }> = [
    ...kinds.map((kind) => ({ kind })),
    ...hosts.filter((host) => (kinds as string[]).includes(host.cli)).map((host) => ({ kind: host.cli as ChatProviderKind, hostId: host.id }))
  ];
  return {
    judged: agents.length > 0,
    localProviders: candidates.map((candidate) => {
      const unavailable = localProviderUnavailableReason(candidate, agents, providers, hosts);
      return { ...candidate, ...(unavailable ? { unavailable } : {}) };
    })
  };
}

/** The phone's reading of localProviderUnavailableReason, from what the
 *  computer offered: the same words for the same member. */
export function forkLocalProviderUnavailable(
  participant: Pick<ChatParticipant, "kind" | "hostId">,
  offer: Pick<ForkToNewChatOffer, "judged" | "localProviders">
): string | undefined {
  if (!offer.judged) return undefined;
  const entry = offer.localProviders.find((item) => item.kind === participant.kind && (item.hostId ?? "") === (participant.hostId ?? ""));
  if (entry) return entry.unavailable;
  return participant.hostId ? FORK_TO_NEW_CHAT_PROVIDER_GONE : undefined;
}

/**
 * Why the member cannot be forked now, judged on the phone from what her
 * server holds (the member, the chat's main session, whether it has a
 * finished reply) and what the computer offered: the computer's rule and
 * words. `running` is the member as it runs (memberAsItRunsNow).
 */
export function forkToNewChatReasonFromOffer(input: {
  running: ChatParticipant;
  answered: boolean;
  offer: Pick<ForkToNewChatOffer, "judged" | "localProviders" | "machines">;
}): string | undefined {
  const { running, offer } = input;
  const home = chatParticipantHome(running);
  return forkToNewChatUnavailableReason({
    participant: running,
    hasSession: input.answered,
    hostMissing: Boolean(running.hostId) && !offer.localProviders.some((item) => item.hostId === running.hostId && item.kind === running.kind),
    providerUnavailable: home.kind === "this-machine" ? forkLocalProviderUnavailable(running, offer) : undefined,
    machineSupport: home.kind === "machine" ? offer.machines[home.machineId] ?? "unknown" : undefined
  });
}

/**
 * The new chat's main session as the phone makes it: the main session the
 * computer prepared for a new chat (`mainSession`: its handle, role and say
 * over members), on the member's provider, model, effort, access and place,
 * marked with where it comes from. The computer makes the same one through
 * its own validation (ChatService.createForkedConversation).
 */
export function forkedMainSessionFor(input: {
  mainSession: ChatParticipant;
  basePermissions: ChatAgentPermissions;
  /** The member as it runs now (memberAsItRunsNow). */
  member: ChatParticipant;
  source: { id: string; title: string };
  /** The member's last reply that ended a turn, as her server read it when
   *  the phone offered the fork (HubPhoneForkSource.seen). */
  seen?: ChatForkSeenReply;
  id: string;
}): ChatParticipant {
  const { mainSession, member } = input;
  const {
    avatarId: _avatar, model: _model, reasoningEffort: _effort, hostId: _hostId, hostLabel: _hostLabel, hostVendor: _hostVendor,
    homeMachineId: _home, cloudRun: _cloud, sessionHandoff: _handoff, forkOrigin: _origin, delegatedByParticipantId: _delegated,
    participantConfigId: _config, taskTitle: _taskTitle, ...lead
  } = mainSession;
  return {
    ...lead,
    id: input.id,
    kind: member.kind,
    ...(member.model ? { model: member.model } : {}),
    ...(member.reasoningEffort ? { reasoningEffort: member.reasoningEffort } : {}),
    ...(member.hostId ? { hostId: member.hostId, hostLabel: member.hostLabel, hostVendor: member.hostVendor } : {}),
    ...forkedMainSessionAccess(input.basePermissions, member),
    remoteExecution: preservedRemoteExecution(member.remoteExecution),
    ...(member.homeMachineId ? { homeMachineId: member.homeMachineId } : {}),
    ...(member.cloudRun ? { cloudRun: member.cloudRun } : {}),
    forkOrigin: forkOriginFor(input.source, member, input.seen)
  };
}
