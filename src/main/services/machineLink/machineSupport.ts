import { normalizeCliStartDefaultsByKind, type CliStartDefaultsByKind } from "../../../shared/cliStartDefaults";
import type { MachineMemberRestartSupport } from "../../../shared/memberRestart";
import type { MachineSessionMoveSupport, MachineSessionMoveTarget } from "../../../shared/memberSessionMove";
import { forkToNewChatSupportFromHello, type ForkToNewChatMachineSupport } from "../../../shared/forkToNewChat";
import { cliModesSupportFromHello, type CliModesMachineSupport } from "../../../shared/chatAccessModes";
import type { MachineLinkModules } from "./modules";

/** What a machine's runtime can do. */
export class MachineSupport {
  constructor(private readonly link: Pick<MachineLinkModules, "machineConnections">) {}

  /** Whether this machine's runtime restarts its members' processes, by the
   *  last hello it sent this desktop: "unknown" before any hello, and
   *  "disconnected" while it is not connected (a stopped machine has no
   *  member process to restart). */
  memberRestartSupport(machineId: string): MachineMemberRestartSupport {
    const connection = this.link.machineConnections.connections.get(machineId);
    const hello = connection?.record.lastHello;
    if (!connection || !hello) return "unknown";
    if (hello.memberRestartSupported !== true) return "outdated";
    return connection.machineDeviceId ? "supported" : "disconnected";
  }

  /** Whether a machine (by id, or by the AWS instance it runs on) takes and
   *  hands over members' sessions, by the last hello it sent this desktop,
   *  connected or not: its program changes only through this desktop. */
  sessionMoveTarget(target: { machineId?: string; instanceId?: string }): MachineSessionMoveTarget {
    const connection = target.machineId
      ? this.link.machineConnections.connections.get(target.machineId)
      : target.instanceId ? [...this.link.machineConnections.connections.values()].find((item) => item.record.awsInstanceId === target.instanceId) : undefined;
    if (!connection) return { support: "unknown" };
    const hello = connection.record.lastHello;
    const support: MachineSessionMoveSupport = !hello ? "unknown" : hello.sessionMoveSupported === true ? "supported" : "outdated";
    return { support, name: connection.record.name, machineId: connection.record.id, ...(connection.record.deviceId ? { deviceId: connection.record.deviceId } : {}) };
  }

  /** Whether a machine starts a main session from a copy of a member's
   *  session in another chat (Fork to new chat), by the last hello it sent
   *  this desktop, connected or not: its program changes only through this
   *  desktop. */
  forkToNewChatSupport(machineId: string): ForkToNewChatMachineSupport {
    return forkToNewChatSupportFromHello((this.link.machineConnections.connections.get(machineId)?.record ?? this.link.machineConnections.enrolled.get(machineId))?.lastHello);
  }

  /** Whether a machine runs Codex's Full Access and Plan mode as the menus
   *  set them, by the last hello it sent this desktop, connected or not: its
   *  program changes only through this desktop. */
  cliModesSupport(machineId: string): CliModesMachineSupport {
    return cliModesSupportFromHello((this.link.machineConnections.connections.get(machineId)?.record ?? this.link.machineConnections.enrolled.get(machineId))?.lastHello);
  }

  /** cliModesSupport of every machine that has greeted this desktop, for the
   *  User's server, which holds a phone's or a machine's turns to it. */
  cliModesByMachine(): Record<string, boolean> {
    const known = new Map<string, boolean>();
    for (const record of [...this.link.machineConnections.enrolled.values(), ...[...this.link.machineConnections.connections.values()].map((connection) => connection.record)]) {
      const support = cliModesSupportFromHello(record.lastHello);
      if (support !== "unknown") known.set(record.id, support === "supported");
    }
    // In one order, so an unchanged set reads the same.
    return Object.fromEntries([...known.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  /** What each CLI on a machine starts a new session in with that machine's
   *  own config, by the last hello it sent this desktop. */
  cliStartDefaults(machineId: string): CliStartDefaultsByKind | undefined {
    return normalizeCliStartDefaultsByKind((this.link.machineConnections.connections.get(machineId)?.record ?? this.link.machineConnections.enrolled.get(machineId))?.lastHello?.cliStartDefaults);
  }
}
