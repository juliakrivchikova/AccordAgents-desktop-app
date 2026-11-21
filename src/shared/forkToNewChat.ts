// Fork to new chat (the User, 2026-11-21): any member of any chat (a main
// session, a member it made, a member of a chat from before with its Chat
// Assistant) is copied into a new chat as that chat's main session, with all
// it knew. The new chat opens empty; its first message forks the member's CLI
// session through the CLI's own fork (Claude Code `--resume <id>
// --fork-session`, Codex app-server `thread/fork`), as the main session's
// "fork" tasks do (docs/main-session.md). The member and its chat stay as
// they were.
//
// Shared so the desktop's menus and the phone's say why it is not offered
// with the same words the service refuses it with, and so the phone makes the
// new chat's main session as the computer does (bundled for the phone through
// mobileSharedRules.ts).

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
  ChatAgentPermissions,
  ChatParticipant,
  ChatParticipantForkOrigin,
  ChatProviderKind,
  CliProviderHost,
  ConversationMetadata,
  ProviderSettings
} from "./types";

export const FORK_TO_NEW_CHAT_LABEL = "Fork to new chat";

/** What the menus show under the item when it can be chosen. */
export const FORK_TO_NEW_CHAT_DETAIL = "A new chat whose main session starts from a copy of this session";

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
  /** Why its CLI on this computer cannot run it now (only for a member that
   *  runs here; a machine's member runs on that machine's CLI). */
  providerUnavailable?: string;
  /** For a member on a machine: what that machine's program can do. */
  machineSupport?: ForkToNewChatMachineSupport;
}

/**
 * Why this member cannot be forked to a new chat now, or undefined when it
 * can. The new chat's main session runs where the member runs (a fork never
 * crosses devices), on its CLI (never another provider), so:
 * - Antigravity has no fork;
 * - a member waiting for a machine has no session anywhere yet;
 * - a member that never ran has no session to copy;
 * - a member on a machine needs that machine's program to do the fork;
 * - a member on this computer needs its CLI ready here.
 */
export function forkToNewChatUnavailableReason(check: ForkToNewChatCheck): string | undefined {
  const { participant } = check;
  if (participant.kind === "gemini-cli") {
    return "Antigravity has no session fork.";
  }
  if (participant.kind !== "claude-code" && participant.kind !== "codex-cli") {
    return "Only Claude Code and Codex sessions can be forked.";
  }
  const home = chatParticipantHome(participant);
  if (home.kind === "unassigned" || home.kind === "cloud-pending") {
    return "It has no machine to run on yet.";
  }
  if (!check.hasSession) {
    return "It has not run yet, so it has no session to copy.";
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

/**
 * Whether the member has a CLI session to copy, as this device knows it: one
 * that runs here by its session record (an id of its own; a fork whose copy
 * was never made has none); one on a machine, whose session only that machine
 * holds, by whether it ever wrote in the chat.
 */
export function memberHasForkableSession(
  metadata: SessionsMetadata | undefined,
  participant: Pick<ChatParticipant, "id" | "homeMachineId" | "cloudRun" | "remoteExecution">,
  loadedMessages: ReadonlyArray<{ role: string; participantId?: string }> = []
): boolean {
  if (chatParticipantHome(participant).kind === "machine") {
    const pointers = metadata?.lastMessageByParticipant;
    const pointed = Boolean(pointers && typeof pointers === "object" && !Array.isArray(pointers) &&
      (pointers as Record<string, unknown>)[participant.id]);
    return pointed || loadedMessages.some((message) => message.role === "participant" && message.participantId === participant.id);
  }
  const sessions: unknown[] = Array.isArray(metadata?.participantSessions) ? metadata!.participantSessions as unknown[] : [];
  return sessions.some((session) => {
    const record = session as { participantId?: unknown; sessionId?: unknown } | null;
    return Boolean(record) && record!.participantId === participant.id && typeof record!.sessionId === "string" && record!.sessionId.trim().length > 0;
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
  if (participant.hostId && !host) return "Its provider no longer exists.";
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
 * The new chat's main session's rights: the member's access as it runs now
 * (what it may read, edit, run and reach, and its CLI's own mode) with the
 * main session's own say over members (`base`: what its role gives a new
 * main session). Never more than the member has, besides that say.
 */
export function forkedMainSessionPermissions(base: ChatAgentPermissions, memberPermissions: ChatAgentPermissions | undefined): ChatAgentPermissions {
  const own = normalizeChatAgentPermissions(memberPermissions);
  const { providerNative: _baseNative, cliApprovals: _baseApprovals, ...rest } = normalizeChatAgentPermissions(base);
  return {
    ...rest,
    repoRead: own.repoRead,
    workspaceWrite: own.workspaceWrite,
    webAccess: own.webAccess,
    shell: { enabled: own.shell.enabled, rules: own.shell.rules.map((rule) => ({ ...rule })) },
    ...(own.providerNative ? { providerNative: own.providerNative } : {}),
    ...(own.cliApprovals ? { cliApprovals: true as const } : {})
  };
}

/** Where the new chat's main session comes from (ChatParticipant.forkOrigin). */
export function forkOriginFor(source: { id: string; title: string }, member: Pick<ChatParticipant, "id" | "handle" | "kind">): ChatParticipantForkOrigin {
  return { conversationId: source.id, participantId: member.id, handle: member.handle, conversationTitle: source.title, kind: member.kind };
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
  return participant.hostId ? "Its provider no longer exists." : undefined;
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
  id: string;
}): ChatParticipant {
  const { mainSession, member } = input;
  const {
    avatarId: _avatar, model: _model, reasoningEffort: _effort, hostId: _hostId, hostLabel: _hostLabel, hostVendor: _hostVendor,
    homeMachineId: _home, cloudRun: _cloud, sessionHandoff: _handoff, forkOrigin: _origin, delegatedByParticipantId: _delegated,
    participantConfigId: _config, ...lead
  } = mainSession;
  return {
    ...lead,
    id: input.id,
    kind: member.kind,
    ...(member.model ? { model: member.model } : {}),
    ...(member.reasoningEffort ? { reasoningEffort: member.reasoningEffort } : {}),
    ...(member.hostId ? { hostId: member.hostId, hostLabel: member.hostLabel, hostVendor: member.hostVendor } : {}),
    agentMode: normalizeChatAgentMode(member.agentMode),
    permissions: forkedMainSessionPermissions(input.basePermissions, member.permissions),
    remoteExecution: preservedRemoteExecution(member.remoteExecution),
    ...(member.homeMachineId ? { homeMachineId: member.homeMachineId } : {}),
    ...(member.cloudRun ? { cloudRun: member.cloudRun } : {}),
    forkOrigin: forkOriginFor(input.source, member)
  };
}
