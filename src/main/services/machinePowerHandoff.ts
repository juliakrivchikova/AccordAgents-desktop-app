/**
 * Issues, lists and revokes the scoped power-key handoffs a device needs to
 * wake a stopped machine (Rule 3). The secret only ever leaves here inside the
 * sealed pairing package; what stays behind is a record of who holds a copy.
 */

import { randomUUID } from "node:crypto";
import type { AwsMachinePowerConfig } from "../../shared/machinePower";
import {
  machinePowerHandoffRecord,
  type MachinePowerHandoff,
  type MachinePowerHandoffRecord,
  type MachinePowerRevocation
} from "../../shared/machinePowerHandoff";

export interface MachinePowerHandoffStore {
  getMachinePower(): Promise<AwsMachinePowerConfig | undefined>;
  listMachinePowerHandoffs(): Promise<MachinePowerHandoffRecord[]>;
  saveMachinePowerHandoffs(records: MachinePowerHandoffRecord[]): Promise<void>;
}

export class MachinePowerHandoffService {
  constructor(
    private readonly store: MachinePowerHandoffStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID
  ) {}

  /** The package a device is paired with. Called while minting the pairing, so
   *  the key travels sealed with it and never separately. */
  async issue(request: { machineId: string; issuedTo: string }): Promise<MachinePowerHandoff> {
    const machineId = request.machineId.trim();
    const issuedTo = request.issuedTo.trim();
    if (!machineId || !issuedTo) throw new Error("A power handoff needs the machine and the device it is for.");
    const config = await this.store.getMachinePower();
    if (!config) {
      throw new Error("This machine has no power configuration, so it cannot be woken by a device.");
    }
    const handoff: MachinePowerHandoff = {
      version: 1,
      handoffId: this.newId(),
      machineId,
      instanceId: config.instanceId,
      region: config.credentials.region,
      credentials: config.credentials,
      issuedTo,
      issuedAt: this.now().toISOString()
    };
    const records = await this.store.listMachinePowerHandoffs();
    await this.store.saveMachinePowerHandoffs([...records, machinePowerHandoffRecord(handoff)]);
    return handoff;
  }

  async list(): Promise<MachinePowerHandoffRecord[]> {
    return this.store.listMachinePowerHandoffs();
  }

  /**
   * Marks a handoff revoked. The returned outcome always says the key must be
   * rotated: the device kept a copy of a key every handoff shares, and no
   * local record can take that copy back.
   */
  async revoke(handoffId: string, reason: string): Promise<MachinePowerRevocation> {
    const records = await this.store.listMachinePowerHandoffs();
    const target = records.find((record) => record.handoffId === handoffId);
    if (!target) throw new Error("That power handoff is not on record.");
    const revokedAt = this.now().toISOString();
    if (!target.revokedAt) {
      await this.store.saveMachinePowerHandoffs(records.map((record) => record.handoffId === handoffId
        ? { ...record, revokedAt, revokeReason: reason }
        : record));
    }
    const otherLive = records.filter((record) => record.handoffId !== handoffId
      && record.machineId === target.machineId && !record.revokedAt).length;
    return {
      handoffId,
      revokedAt: target.revokedAt ?? revokedAt,
      keyRotationRequired: true,
      otherLiveHandoffs: otherLive,
      detail: `${target.issuedTo} kept a copy of this machine's power key, which every device shares. `
        + "Rotate that access key in AWS to end its access"
        + (otherLive > 0
          ? `; ${otherLive} other device${otherLive === 1 ? "" : "s"} will need a new handoff afterwards.`
          : ".")
    };
  }

  /** Refuses a revoked handoff, so this desktop never re-offers one. */
  async isLive(handoffId: string): Promise<boolean> {
    const records = await this.store.listMachinePowerHandoffs();
    const record = records.find((entry) => entry.handoffId === handoffId);
    return Boolean(record && !record.revokedAt);
  }

  /** Revokes every handoff of a machine, for removing the machine itself. */
  async revokeForMachine(machineId: string, reason: string): Promise<MachinePowerRevocation[]> {
    const records = await this.store.listMachinePowerHandoffs();
    const live = records.filter((record) => record.machineId === machineId && !record.revokedAt);
    const outcomes: MachinePowerRevocation[] = [];
    for (const record of live) {
      outcomes.push(await this.revoke(record.handoffId, reason));
    }
    return outcomes;
  }
}
