/**
 * Handing the scoped power key to a device, and taking it back.
 *
 * Rule 3 of the signed resolution: the phone wakes a stopped AWS machine
 * itself, with a narrowly scoped key handed over sealed at pairing. The relay
 * never holds it. What the desktop keeps afterwards is a record of WHO holds a
 * copy — never a second copy of the secret.
 *
 * One property has to be stated rather than hidden: every handoff of a machine
 * carries the SAME IAM access key, because minting a key per device needs an
 * IAM identity per device. So revoking a handoff stops this desktop offering
 * the key and marks the record revoked, but it cannot make the copy a device
 * already has stop working. Only rotating the access key in AWS does that, and
 * `keyRotationRequired` says so on every revocation.
 */

import type { MachinePowerCredentials } from "./machinePower";

/** What a device receives, inside the sealed pairing package. */
export interface MachinePowerHandoff {
  version: 1;
  handoffId: string;
  machineId: string;
  instanceId: string;
  region: string;
  credentials: MachinePowerCredentials;
  issuedTo: string;
  issuedAt: string;
}

/** What the desktop keeps. Deliberately without the secret. */
export interface MachinePowerHandoffRecord {
  handoffId: string;
  machineId: string;
  instanceId: string;
  /** The device or pairing this was handed to. */
  issuedTo: string;
  issuedAt: string;
  revokedAt?: string;
  revokeReason?: string;
}

export interface MachinePowerRevocation {
  handoffId: string;
  revokedAt: string;
  /** Always true: the device kept a copy of a key shared by every handoff of
   *  this machine, so only rotating that key removes its access. */
  keyRotationRequired: true;
  /** Handoffs that are still live and would also stop working on rotation. */
  otherLiveHandoffs: number;
  detail: string;
}

export function machinePowerHandoffRecord(handoff: MachinePowerHandoff): MachinePowerHandoffRecord {
  return {
    handoffId: handoff.handoffId,
    machineId: handoff.machineId,
    instanceId: handoff.instanceId,
    issuedTo: handoff.issuedTo,
    issuedAt: handoff.issuedAt
  };
}

export function assertMachinePowerHandoff(value: unknown): asserts value is MachinePowerHandoff {
  const handoff = value as Partial<MachinePowerHandoff> | undefined;
  const credentials = handoff?.credentials;
  if (!handoff || handoff.version !== 1
    || typeof handoff.handoffId !== "string" || !handoff.handoffId.trim()
    || typeof handoff.machineId !== "string" || !handoff.machineId.trim()
    || typeof handoff.instanceId !== "string" || !/^i-[a-f0-9]{8,17}$/.test(handoff.instanceId)
    || typeof handoff.region !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(handoff.region)
    || typeof handoff.issuedTo !== "string" || !handoff.issuedTo.trim()
    || typeof handoff.issuedAt !== "string" || !handoff.issuedAt.trim()
    || !credentials || typeof credentials.accessKeyId !== "string" || !credentials.accessKeyId.trim()
    || typeof credentials.secretAccessKey !== "string" || !credentials.secretAccessKey.trim()
    || credentials.region !== handoff.region) {
    throw new Error("Invalid machine power handoff.");
  }
}

export function normalizeMachinePowerHandoffRecords(value: unknown): MachinePowerHandoffRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): MachinePowerHandoffRecord[] => {
    const record = entry as Partial<MachinePowerHandoffRecord> | undefined;
    if (!record || typeof record.handoffId !== "string" || !record.handoffId.trim()
      || typeof record.machineId !== "string" || typeof record.instanceId !== "string"
      || typeof record.issuedTo !== "string" || typeof record.issuedAt !== "string") {
      return [];
    }
    return [{
      handoffId: record.handoffId,
      machineId: record.machineId,
      instanceId: record.instanceId,
      issuedTo: record.issuedTo,
      issuedAt: record.issuedAt,
      ...(typeof record.revokedAt === "string" ? { revokedAt: record.revokedAt } : {}),
      ...(typeof record.revokeReason === "string" ? { revokeReason: record.revokeReason } : {})
    }];
  });
}
