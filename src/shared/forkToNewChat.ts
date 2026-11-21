// Fork to new chat (the User, 2026-11-21): any member of any chat (a main
// session, a member it made, a member of a chat from before with its Chat
// Assistant) is copied into a new chat as that chat's main session, with all
// it knew. The new chat opens empty; its first message forks the member's CLI
// session through the CLI's own fork (Claude Code `--resume <id>
// --fork-session`, Codex app-server `thread/fork`), as the main session's
// "fork" tasks do (docs/main-session.md). The member and its chat stay as
// they were.
//
// Shared so the desktop's menus say why it is not offered with the same words
// the service refuses it with.

import { chatParticipantHome } from "./chatParticipantHome";
import { cliProviderHostForParticipant } from "./cliProviderHosts";
import { agentReadinessReason, cliProviderMetadata, readinessForParticipant } from "./cliReadiness";
import type { AgentHealth, ChatParticipant, CliProviderHost, ConversationMetadata, ProviderSettings } from "./types";

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
