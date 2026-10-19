import type { MachineRecord } from "../../shared/machineLink";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type { MachineActivity } from "./machineLink";

export interface RelayAddresses {
  relayUrl: string;
  outboxUrl: string;
}

/** A move this desktop asked a machine for and has not settled yet. It is
 *  written before the request goes out and removed only once this desktop
 *  knows where the machine is, so a move whose answer never came, or that a
 *  restart of this desktop cut short, is settled by looking for the machine
 *  and never forgotten. */
export interface MachineMoveRecord {
  machineId: string;
  pairingKey: string;
  from: RelayAddresses;
  to: RelayAddresses;
  /** The runtime run that was asked: a greeting from another run at the old
   *  address means the machine started again there, so it did not move. */
  instanceId?: string;
  requestedAt: string;
}

export interface MachinePresence {
  /** Where this desktop's link to the machine is now. */
  relayUrl?: string;
  /** The machine is in the room and greeted this connection. */
  present: boolean;
  /** The runtime run that greeted last. */
  instanceId?: string;
}

export interface MachineTransportMoveLink {
  isMachineConnected(machineId: string): boolean;
  supportsTransportMove(machineId: string): boolean;
  hasTurnHold(machineId: string): boolean;
  holdTurns(machineId: string, reason: string): () => void;
  machineActivity(machineId: string): Promise<MachineActivity | undefined>;
  machinePresence(machineId: string): MachinePresence | undefined;
  requestTransportMove(machineId: string, addresses: RelayAddresses): Promise<{ status: "moved" | "refused" | "unknown"; error?: string }>;
  reconnectMachine(machineId: string, pairing?: MobilePairingPackage): Promise<void>;
  waitForHello(machineId: string, timeoutMs: number): Promise<boolean>;
  probeMachineAt(machineId: string, pairing: MobilePairingPackage, timeoutMs: number): Promise<boolean>;
  refreshTrustRosters(): Promise<void>;
}

export interface MachineTransportMoverOptions {
  link: () => MachineTransportMoveLink | undefined;
  listMachines: () => Promise<MachineRecord[]>;
  getMachinePairing: (pairingKey: string) => Promise<MobilePairingPackage | undefined>;
  listMoves: () => Promise<MachineMoveRecord[]>;
  saveMove: (record: MachineMoveRecord) => Promise<void>;
  /** Removes the record; with `adopt`, saves that pairing in the same write. */
  finishMove: (machineId: string, adopt?: { pairingKey: string; pairing: MobilePairingPackage }) => Promise<void>;
  /** The User's server's addresses, once it serves the relay. */
  target: () => Promise<RelayAddresses | undefined>;
  /** A setup, update or recovery of this machine is running or starting. */
  busyElsewhere: (machineId: string) => boolean;
  ensureMailboxRegistered: (pairing: MobilePairingPackage) => Promise<boolean>;
  /** The machine is at its new address now: tell the phones. */
  onMoved: (machineId: string) => void;
  log: (event: string, payload: Record<string, unknown>) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides for tests. */
  timing?: Partial<typeof MACHINE_MOVE_TIMING>;
}

export const MACHINE_MOVE_TIMING = {
  /** A runtime that saved its new address leaves the old one within about
   *  31 s (its stop is cut off at 30 s); one still greeting there well after
   *  that did not move. */
  exitGraceMs: 2 * 60_000,
  /** How long a move without an answer holds the machine's turns while it
   *  is looked for; after that the record waits for the next passes. */
  settleMs: 2 * 60_000 + 30_000,
  /** Between two looks during that time. */
  settleEveryMs: 5_000,
  /** One look at the new address. */
  probeMs: 8_000,
  /** How long turns wait for a machine that said it moved to greet. */
  greetMs: 2 * 60_000,
  /** After a machine refused a move or stayed, it is asked again no sooner
   *  than this, doubling up to the maximum. */
  retryMs: 5 * 60_000,
  retryMaxMs: 60 * 60_000
};

type Verdict = "moved" | "stayed" | "unknown";

/** Moves machines set up before the User's own server to it: over the
 *  machine's present link and only while it is idle, it is told to meet this
 *  desktop at the server from now on; its keys, rooms and mailbox ids stay.
 *  Turns wait while it moves. */
export class MachineTransportMover {
  private running = false;
  private readonly retries = new Map<string, { at: number; delayMs: number }>();
  /** The machine being moved now: its update waits for the move to end. */
  private moving?: string;
  private readonly timing: typeof MACHINE_MOVE_TIMING;

  constructor(private readonly options: MachineTransportMoverOptions) {
    this.timing = { ...MACHINE_MOVE_TIMING, ...options.timing };
  }

  isMoving(machineId: string): boolean {
    return this.moving === machineId;
  }

  /** One pass: first settle what earlier moves left open, then move what is
   *  due. Passes never overlap. */
  async run(): Promise<void> {
    const link = this.options.link();
    if (this.running || !link) return;
    this.running = true;
    try {
      const machines = await this.options.listMachines();
      const open = await this.settleOpenMoves(link, machines);
      const target = await this.options.target();
      if (!target) return;
      for (const machine of machines) {
        if (open.has(machine.id)) continue;
        await this.moveOne(link, machine, target).catch((error: unknown) => {
          this.options.log("machine.transport.move-error", { machineId: machine.id, message: errorMessage(error) });
        });
      }
    } catch (error) {
      this.options.log("machine.transport.pass-error", { message: errorMessage(error) });
    } finally {
      this.running = false;
    }
  }

  /** Records left by a move that did not end here: settled by where the
   *  machine is found. Returns the machines still unsettled. */
  private async settleOpenMoves(link: MachineTransportMoveLink, machines: MachineRecord[]): Promise<Set<string>> {
    const open = new Set<string>();
    const known = new Map(machines.map((machine) => [machine.id, machine]));
    for (const record of await this.options.listMoves()) {
      const machine = known.get(record.machineId);
      if (!machine) {
        // Removed meanwhile: nothing is left to settle.
        await this.options.finishMove(record.machineId).catch(() => undefined);
        continue;
      }
      const verdict = await this.settle(link, machine, record, 0).catch((error: unknown) => {
        this.options.log("machine.transport.settle-error", { machineId: record.machineId, message: errorMessage(error) });
        return "unknown" as const;
      });
      if (verdict === "unknown") open.add(record.machineId);
    }
    return open;
  }

  private async moveOne(link: MachineTransportMoveLink, machine: MachineRecord, target: RelayAddresses): Promise<void> {
    const pairing = await this.options.getMachinePairing(machine.pairingKey).catch(() => undefined);
    if (!pairing || pairing.hubUrl || !pairing.relayUrl || !pairing.outboxUrl || pairing.relayUrl === target.relayUrl) return;
    // A server on this computer (a test setup) is no place for a machine
    // that runs elsewhere.
    if (isLoopbackUrl(target.relayUrl) && !isLoopbackUrl(pairing.relayUrl)) return;
    // An older runtime moves after its update (which happens on its own).
    if (!link.isMachineConnected(machine.id) || !link.supportsTransportMove(machine.id)) return;
    const retry = this.retries.get(machine.id);
    if (retry && this.now() < retry.at) return;
    if (this.claimedElsewhere(link, machine.id)) return;
    const activity = await link.machineActivity(machine.id);
    if (!activity?.fresh || activity.activeRunIds.length || activity.pendingTerminalRunIds.length || activity.dispatchedRunIds.length) return;
    // Asked again after the last wait, with nothing in between: an update
    // that started meanwhile keeps the machine, and this pass leaves it.
    if (this.claimedElsewhere(link, machine.id)) return;
    const release = link.holdTurns(machine.id, "The machine is moving to your server.");
    this.moving = machine.id;
    try {
      const next: MobilePairingPackage = { ...pairing, ...target };
      // Its mailbox on the server is registered first, so nothing it or this
      // desktop still has to send has nowhere to go.
      if (!await this.options.ensureMailboxRegistered(next)) {
        this.options.log("machine.transport.mailbox-unregistered", { machineId: machine.id });
        return;
      }
      const record: MachineMoveRecord = {
        machineId: machine.id,
        pairingKey: machine.pairingKey,
        from: { relayUrl: pairing.relayUrl, outboxUrl: pairing.outboxUrl },
        to: target,
        ...(link.machinePresence(machine.id)?.instanceId ? { instanceId: link.machinePresence(machine.id)?.instanceId } : {}),
        requestedAt: new Date(this.now()).toISOString()
      };
      // Written before the request: without it, nothing is asked.
      await this.options.saveMove(record);
      this.options.log("machine.transport.move-requested", { machineId: machine.id, relayHost: hostOf(target.relayUrl) });
      const outcome = await link.requestTransportMove(machine.id, target);
      if (outcome.status === "refused") {
        await this.options.finishMove(machine.id).catch(() => undefined);
        this.backOff(machine.id, retry);
        this.options.log("machine.transport.move-refused", { machineId: machine.id, message: outcome.error ?? "" });
        return;
      }
      if (outcome.status === "moved") {
        await this.adopt(link, machine, record, pairing, "answered");
        return;
      }
      // No answer: it may have moved all the same. It is looked for while
      // its turns wait; the record settles it later if it is not found now.
      this.options.log("machine.transport.move-unanswered", { machineId: machine.id, message: outcome.error ?? "" });
      await this.settle(link, machine, record, this.timing.settleMs);
    } finally {
      this.moving = undefined;
      release();
    }
  }

  /** Where the machine is, looked at until `waitMs` has passed: at the new
   *  address (it moved), or greeting at the old one from another run or
   *  well after a moved runtime would have left (it stayed). */
  private async settle(link: MachineTransportMoveLink, machine: MachineRecord, record: MachineMoveRecord, waitMs: number): Promise<Verdict> {
    const deadline = this.now() + waitMs;
    for (;;) {
      const verdict = await this.observe(link, machine, record);
      if (verdict === "moved") {
        const saved = await this.options.getMachinePairing(record.pairingKey).catch(() => undefined);
        if (saved) await this.adopt(link, machine, record, saved, "found");
        return "moved";
      }
      if (verdict === "stayed") {
        await this.options.finishMove(record.machineId);
        this.backOff(record.machineId, this.retries.get(record.machineId));
        this.options.log("machine.transport.move-stayed", { machineId: record.machineId });
        return "stayed";
      }
      if (this.now() >= deadline) return "unknown";
      await this.sleep(this.timing.settleEveryMs);
    }
  }

  private async observe(link: MachineTransportMoveLink, machine: MachineRecord, record: MachineMoveRecord): Promise<Verdict> {
    const presence = link.machinePresence(record.machineId);
    if (presence?.present && presence.relayUrl === record.to.relayUrl) return "moved";
    if (presence?.present && presence.relayUrl === record.from.relayUrl) {
      if (record.instanceId && presence.instanceId && presence.instanceId !== record.instanceId) return "stayed";
      if (this.now() - Date.parse(record.requestedAt) > this.timing.exitGraceMs) return "stayed";
    }
    const saved = await this.options.getMachinePairing(record.pairingKey).catch(() => undefined);
    if (!saved) return "unknown";
    // Looked for at the new address with a connection of its own: the link
    // stays where it is until the machine is found there.
    const found = await link.probeMachineAt(machine.id, { ...saved, ...record.to }, this.timing.probeMs).catch(() => false);
    return found ? "moved" : "unknown";
  }

  /** The machine is at the new address: the pairing names it, the link and
   *  the other devices follow. */
  private async adopt(link: MachineTransportMoveLink, machine: MachineRecord, record: MachineMoveRecord, pairing: MobilePairingPackage, how: "answered" | "found"): Promise<void> {
    const next: MobilePairingPackage = { ...pairing, ...record.to };
    // A pairing that cannot be written now leaves the record, which finds
    // the machine at its new address again on a later pass.
    const written = await this.options.finishMove(record.machineId, { pairingKey: record.pairingKey, pairing: next }).then(() => true, (error: unknown) => {
      this.options.log("machine.transport.save-pending", { machineId: machine.id, message: errorMessage(error) });
      return false;
    });
    this.retries.delete(machine.id);
    const presence = link.machinePresence(machine.id);
    let greeted = presence?.present === true && presence.relayUrl === record.to.relayUrl;
    if (!greeted) {
      // Listening before the reconnect, so an early greeting is not missed.
      const greeting = link.waitForHello(machine.id, this.timing.greetMs);
      await link.reconnectMachine(machine.id, next);
      greeted = await greeting;
    }
    this.options.log("machine.transport.moved", { machineId: machine.id, relayHost: hostOf(record.to.relayUrl), how, written, greeted });
    await link.refreshTrustRosters().catch(() => undefined);
    if (written) this.options.onMoved(machine.id);
  }

  private claimedElsewhere(link: MachineTransportMoveLink, machineId: string): boolean {
    return link.hasTurnHold(machineId) || this.options.busyElsewhere(machineId);
  }

  private backOff(machineId: string, previous: { delayMs: number } | undefined): void {
    const delayMs = Math.min(this.timing.retryMaxMs, previous ? previous.delayMs * 2 : this.timing.retryMs);
    this.retries.set(machineId, { at: this.now() + delayMs, delayMs });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
