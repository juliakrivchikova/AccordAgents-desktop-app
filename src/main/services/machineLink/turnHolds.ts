import { TURN_HOLD_MS, TURN_HOLD_RENEW_MS } from "./constants";
import type { MachineLinkModules } from "./modules";
import type { MachineLinkDependencies } from "./dependencies";

/** Holds turns on a machine while it must not start new ones. */
export class TurnHolds {
  /** Why a machine cannot take turns right now (its runtime is being
   *  replaced), by machine id: shown on a waiting member's bubble. */
  private readonly turnHolds = new Map<string, Array<{ reason: string }>>();
  turnHoldTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly link: Pick<MachineLinkModules, "machineConnections" | "machineMessages">,
    private readonly deps: Pick<MachineLinkDependencies, "debugLogs" | "now">
  ) {}

  /** Holds a machine's turns while its runtime is being replaced: the
   *  machine takes no new turn from the User's server meanwhile (they wait
   *  there for the runtime that takes them), and a waiting member's bubble
   *  says why. Each caller gets its own release; turns go on once every
   *  holder let go. */
  holdTurns(machineId: string, reason: string): () => void {
    const holds = this.turnHolds.get(machineId) ?? [];
    const hold = { reason };
    holds.push(hold);
    this.turnHolds.set(machineId, holds);
    void this.deps.debugLogs.write("machine-link.turns.held", { machineId, reason });
    this.sendTurnHold(machineId);
    if (!this.turnHoldTimer) {
      // Renewed while held: the machine lets a hold lapse by itself.
      this.turnHoldTimer = setInterval(() => { for (const id of this.turnHolds.keys()) this.sendTurnHold(id); }, TURN_HOLD_RENEW_MS);
      this.turnHoldTimer.unref?.();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.turnHolds.get(machineId) ?? []).filter((item) => item !== hold);
      if (remaining.length) {
        this.turnHolds.set(machineId, remaining);
        return;
      }
      this.turnHolds.delete(machineId);
      if (this.turnHolds.size === 0 && this.turnHoldTimer) {
        clearInterval(this.turnHoldTimer);
        this.turnHoldTimer = undefined;
      }
      const connection = this.link.machineConnections.connections.get(machineId);
      if (connection?.machineDeviceId) void this.link.machineMessages.send(connection, { type: "machine.turns.release" }).catch(() => undefined);
      void this.deps.debugLogs.write("machine-link.turns.released", { machineId });
    };
  }

  sendTurnHold(machineId: string): void {
    const reason = this.turnHolds.get(machineId)?.[0]?.reason;
    const connection = this.link.machineConnections.connections.get(machineId);
    if (!reason || !connection?.machineDeviceId) return;
    void this.link.machineMessages.send(connection, { type: "machine.turns.hold", reason, until: new Date(this.deps.now().getTime() + TURN_HOLD_MS).toISOString() }).catch(() => undefined);
  }

  hasTurnHold(machineId: string): boolean {
    return this.turnHolds.has(machineId);
  }

  /** Why turns asked of this machine wait right now, when this desktop knows. */
  turnWaitReason(machineId: string): string | undefined {
    return this.turnHolds.get(machineId)?.[0]?.reason;
  }
}
