import type { CliStartDefaultsByKind } from "../../../../shared/cliStartDefaults";
import type { ForkToNewChatMachineSupport } from "../../../../shared/forkToNewChat";
import { cliModesTurnRefusal, type CliModesMachineSupport } from "../../../../shared/chatAccessModes";
import type { HubNewChatOptions } from "../../../../shared/hubProtocol";
import type { MachineSessionMoveTarget } from "../../../../shared/memberSessionMove";
import type {
  ChatParticipant, ChatProviderKind, Conversation, CloudRunWorkerDoctorReport, CloudRunWorkerSettings
} from "../../../../shared/types";
import type { MachineMemberRestartSupport } from "../../../../shared/memberRestart";
import { participantForRun } from "../members/identity";
import type { ChatModules } from "../modules";

// AWS-managed worker hook: resolves a run-ready SSH target (starting the
// instance if needed) and tracks activity for idle auto-stop.
export interface CloudRunAwsResolver {
  ensureWorkerForRun(): Promise<CloudRunWorkerSettings>;
  noteRunStarted(runId: string): void;
  noteRunEnded(runId: string): Promise<void>;
}

export interface CloudRunDoctorProbe {
  diagnose(
    settings: CloudRunWorkerSettings,
    options?: { requirePersistentStorage?: boolean; requiredProviderKind?: ChatProviderKind }
  ): Promise<CloudRunWorkerDoctorReport>;
}

/** What each machine's runtime can do for its members, as the desktop last heard from it. */
export class MachineSupport {
  machineMemberRestartSupport?: (machineId: string) => MachineMemberRestartSupport;
  /** Desktop side: whether a machine takes and hands over members' sessions
   *  (its last hello), and its name; by machine id or AWS instance id. */
  machineSessionMove?: (target: { machineId?: string; instanceId?: string }) => MachineSessionMoveTarget;
  /** Desktop side: whether a machine starts a main session from a copy of a
   *  member's session in another chat (Fork to new chat; its last hello). */
  machineForkToNewChatSupport?: (machineId: string) => ForkToNewChatMachineSupport;
  machineCliModesSupport?: (machineId: string) => CliModesMachineSupport;
  private machineCliStartDefaults?: (machineId: string) => CliStartDefaultsByKind | undefined;
  private cloudRunAws?: CloudRunAwsResolver;
  private cloudRunDoctor?: CloudRunDoctorProbe;

  constructor(private readonly chat: Pick<ChatModules, "serverLink">) {}

  /** Desktop side: whether a machine's runtime restarts its members (its hello). */
  setMachineMemberRestartSupport(support: ((machineId: string) => MachineMemberRestartSupport) | undefined): void {
    this.machineMemberRestartSupport = support;
  }

  /** Desktop side: see machineSessionMove. */
  setMachineSessionMove(lookup: ((target: { machineId?: string; instanceId?: string }) => MachineSessionMoveTarget) | undefined): void {
    this.machineSessionMove = lookup;
  }

  /** Desktop side: see machineForkToNewChatSupport. */
  setMachineForkToNewChatSupport(lookup: ((machineId: string) => ForkToNewChatMachineSupport) | undefined): void {
    this.machineForkToNewChatSupport = lookup;
  }

  /** What each CLI on a machine starts a new session in with that machine's
   *  own config (its last hello): the phone's New chat starts a main session
   *  that runs there in it. */
  setMachineCliStartDefaults(lookup: ((machineId: string) => CliStartDefaultsByKind | undefined) | undefined): void {
    this.machineCliStartDefaults = lookup;
  }

  /** Desktop side: whether a machine runs Codex's Full Access and Plan mode
   *  (its last hello), for the phone's New chat offer and before a turn is
   *  asked of it (machineCliModesRefusal). */
  setMachineCliModesSupport(lookup: ((machineId: string) => CliModesMachineSupport) | undefined): void {
    this.machineCliModesSupport = lookup;
  }

  /** Desktop side: why a member's turn is not asked of its machine, whose
   *  program would run its stored mode otherwise than its controls say
   *  (cliModesTurnRefusal): refused with a line, never run as something
   *  else. A machine never asks it of another (the User's server refuses
   *  that, hubOps.ts). */
  machineCliModesRefusal(conversation: Conversation, participant: ChatParticipant): string | undefined {
    const machineId = participant.homeMachineId;
    if (!machineId || !this.machineCliModesSupport) return undefined;
    // As it runs this turn: one held to its main session's mode by that.
    return cliModesTurnRefusal(participantForRun(conversation, participant), {
      name: this.chat.serverLink.current?.machineName(machineId),
      support: this.machineCliModesSupport(machineId)
    });
  }

  setCloudRunAwsService(service: CloudRunAwsResolver): void {
    this.cloudRunAws = service;
  }

  setCloudRunDoctorService(service: CloudRunDoctorProbe): void {
    this.cloudRunDoctor = service;
  }

  newChatMachineStartDefaults(machines: ReadonlyArray<{ id: string }>): Pick<HubNewChatOptions, "cliStart"> {
    const known = machines.map((machine) => [machine.id, this.machineCliStartDefaults?.(machine.id)] as const)
      .filter((entry): entry is readonly [string, CliStartDefaultsByKind] => Boolean(entry[1]));
    return known.length > 0 ? { cliStart: { machines: Object.fromEntries(known) } } : {};
  }
}
