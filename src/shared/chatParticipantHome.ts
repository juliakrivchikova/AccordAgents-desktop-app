/**
 * Where a member runs.
 *
 * A member lives on exactly one machine — this computer, or a machine that was
 * added and enrolled. Only that machine runs its sessions.
 *
 * Before machines existed, a member was marked `remoteExecution: "remote"` and
 * ran through a per-turn SSH pipeline that no longer exists. Such a member is
 * not silently moved to this computer: it has no home until the User picks one,
 * and it says so instead of running somewhere it was never meant to run.
 */
import type { ChatParticipant, ChatParticipantConfig, CloudRunRemoteExecutionMode } from "./types";

export type ChatParticipantHome =
  | { kind: "this-machine" }
  | { kind: "machine"; machineId: string }
  /** Was set to run in the cloud through the transport that is gone. */
  | { kind: "unassigned" };

interface ParticipantHomeFields {
  homeMachineId?: string;
  remoteExecution?: CloudRunRemoteExecutionMode;
}

export function chatParticipantHome(participant: ParticipantHomeFields | ChatParticipant | ChatParticipantConfig): ChatParticipantHome {
  const machineId = typeof participant.homeMachineId === "string" ? participant.homeMachineId.trim() : "";
  if (machineId) {
    return { kind: "machine", machineId };
  }
  return participant.remoteExecution === "remote" ? { kind: "unassigned" } : { kind: "this-machine" };
}

export function chatParticipantHomeIsUnassigned(participant: ParticipantHomeFields | ChatParticipant | ChatParticipantConfig): boolean {
  return chatParticipantHome(participant).kind === "unassigned";
}

/** Shown wherever the member appears, so the User can see which members are
 *  waiting to be given a machine rather than discovering it on a send. */
export const CHAT_PARTICIPANT_HOME_UNASSIGNED_LABEL = "Needs a machine";

export function chatParticipantHomeUnassignedMessage(handle: string): string {
  return `@${handle} was set to run on a cloud worker. That way of running members has been replaced by machines, `
    + "so this member has no machine to run on yet. Choose its machine in the member settings.";
}

/**
 * What is written back for a member's legacy `remoteExecution` field.
 *
 * "remote" is kept, because it is what marks a member as one that still needs a
 * machine; anything else settles on this computer. Losing the marker would turn
 * a member the User set up for the cloud into one that quietly runs here.
 */
export function preservedRemoteExecution(value: unknown): CloudRunRemoteExecutionMode {
  return value === "remote" ? "remote" : "local";
}
