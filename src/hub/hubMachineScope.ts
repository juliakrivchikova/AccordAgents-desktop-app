/**
 * What a cloud machine may change through the User's server: what concerns
 * the members that run on it, and nothing that would let it reach the
 * members that run elsewhere (the User's computer, another machine).
 *
 * A machine runs agents with shell access; an agent that was tricked by what
 * it read can read the machine's own key and write to the server directly,
 * around the app. Through the app, a member on a machine changes exactly
 * what a member on the computer changes; these rules make the same hold for
 * a write that goes around it:
 *
 * - members that run elsewhere stay as the server has them (their
 *   permissions, mode, tools, home), except that a member may be given leave
 *   to ask other members (`/accord` names its facilitator so);
 * - a member that runs on the machine stays on it (its home is the server's);
 * - the rules that let a member act without a card ("Allow for this chat")
 *   change only for the machine's own members, and go with a member removed;
 * - the chat's project folder, title and other shared fields are not the
 *   machine's to change (it never does through the app);
 * - members are added and removed as the app does it.
 *
 * Applied to every machine's `conversation.update` before it is kept, so a
 * machine with an old copy of the chat cannot write other members' old
 * values back either. Pure: the server's copy and the machine's request in,
 * the change it may make out.
 */

import type { ChatAppToolApprovalPolicy, ChatParticipant, Conversation } from "../shared/types";

type Update = { title?: string; repoPath?: string | null; metadata?: Record<string, unknown>; removedMetadataKeys?: string[] };

/** Where a member runs: what decides which device takes its turns. */
const HOME_FIELDS = ["homeMachineId", "cloudRun", "remoteExecution"] as const;

export interface MachineScopedUpdate {
  update: Update;
  /** What was left out, for the server's log. */
  refused: string[];
}

function participantsOf(value: unknown): ChatParticipant[] {
  return Array.isArray(value) ? value.filter((item): item is ChatParticipant => Boolean(item) && typeof (item as { id?: unknown }).id === "string") : [];
}

function policiesOf(value: unknown): ChatAppToolApprovalPolicy[] {
  return Array.isArray(value) ? value.filter((item): item is ChatAppToolApprovalPolicy => Boolean(item) && typeof (item as { id?: unknown }).id === "string") : [];
}

export function runsOnMachine(participant: Pick<ChatParticipant, "homeMachineId"> | undefined, machineId: string | undefined): boolean {
  return Boolean(machineId && participant && typeof participant.homeMachineId === "string" && participant.homeMachineId === machineId);
}

function keepHome(next: ChatParticipant, current: ChatParticipant): ChatParticipant {
  const merged = { ...next } as Record<string, unknown>;
  for (const field of HOME_FIELDS) {
    const value = (current as unknown as Record<string, unknown>)[field];
    if (value === undefined) delete merged[field];
    else merged[field] = value;
  }
  return merged as unknown as ChatParticipant;
}

/** A member that runs elsewhere, as the server has it; given leave to ask
 *  other members when the machine asks for that (and only that). */
function keepElsewhere(next: ChatParticipant, current: ChatParticipant): ChatParticipant {
  const asked = (next.permissions as { requestParticipants?: unknown } | undefined)?.requestParticipants;
  const had = (current.permissions as { requestParticipants?: unknown } | undefined)?.requestParticipants;
  if (asked === "allow" && had !== "allow") {
    return { ...current, permissions: { ...(current.permissions ?? {}), requestParticipants: "allow" } as ChatParticipant["permissions"] };
  }
  return current;
}

export function scopeMachineConversationUpdate(conversation: Conversation, update: Update, machineId: string | undefined): MachineScopedUpdate {
  const refused: string[] = [];
  const scoped: Update = {};
  if (update.title !== undefined && update.title !== conversation.title) refused.push("title");
  if (update.repoPath !== undefined && (update.repoPath ?? undefined) !== conversation.repoPath) refused.push("repoPath");
  const metadata: Record<string, unknown> = { ...(update.metadata ?? {}) };
  const current = (conversation.metadata ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (key !== "participants" && key !== "appToolApprovalPolicies" && JSON.stringify(metadata[key]) !== JSON.stringify(current[key])) refused.push(key);
  }
  // A key taken away is a list emptied: the rules a machine may drop (its own
  // members') go; anything else it takes away stays.
  const removed = new Set(update.removedMetadataKeys ?? []);
  for (const key of removed) if (key !== "appToolApprovalPolicies") refused.push(`-${key}`);
  if (removed.has("appToolApprovalPolicies") && metadata.appToolApprovalPolicies === undefined) metadata.appToolApprovalPolicies = [];

  const before = participantsOf(current.participants);
  const beforeById = new Map(before.map((participant) => [participant.id, participant]));
  let members = before;
  if (metadata.participants !== undefined) {
    const proposed = participantsOf(metadata.participants);
    members = proposed.map((participant) => {
      const existing = beforeById.get(participant.id);
      if (!existing) return participant;
      if (runsOnMachine(existing, machineId)) {
        const kept = keepHome(participant, existing);
        if (HOME_FIELDS.some((field) => JSON.stringify((kept as unknown as Record<string, unknown>)[field]) !== JSON.stringify((participant as unknown as Record<string, unknown>)[field]))) {
          refused.push(`participants.${participant.id}.home`);
        }
        return kept;
      }
      const kept = keepElsewhere(participant, existing);
      if (JSON.stringify(kept) !== JSON.stringify(participant)) refused.push(`participants.${participant.id}`);
      return kept;
    });
    next.participants = members;
  }

  if (metadata.appToolApprovalPolicies !== undefined || metadata.participants !== undefined) {
    const present = new Set(members.map((participant) => participant.id));
    const own = (policy: ChatAppToolApprovalPolicy) => runsOnMachine(members.find((participant) => participant.id === policy.participantId), machineId);
    // A rule goes with a member removed (the app removes the rules it owns
    // and those aimed at it).
    const stays = (policy: ChatAppToolApprovalPolicy) => present.has(policy.participantId) && (!policy.targetParticipantId || present.has(policy.targetParticipantId));
    const beforePolicies = policiesOf(current.appToolApprovalPolicies);
    if (metadata.appToolApprovalPolicies !== undefined) {
      const proposed = policiesOf(metadata.appToolApprovalPolicies);
      const kept = [
        ...proposed.filter(own),
        ...beforePolicies.filter((policy) => !own(policy) && stays(policy))
      ];
      for (const policy of proposed) {
        if (!own(policy) && !beforePolicies.some((item) => item.id === policy.id && JSON.stringify(item) === JSON.stringify(policy))) refused.push(`appToolApprovalPolicies.${policy.id}`);
      }
      next.appToolApprovalPolicies = kept;
    }
  }

  if (Object.keys(next).length) scoped.metadata = next;
  return { update: scoped, refused };
}
