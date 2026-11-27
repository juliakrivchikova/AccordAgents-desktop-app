import { isDeviceEventBlobReference, type DeviceEventBlobReference } from "../../shared/deviceEventBlobs";
import {
  HUB_PLAN_USAGE_MAX_SNAPSHOT_BYTES, HUB_PLAN_USAGE_MAX_SNAPSHOTS, HUB_ROSTER_ROLES, isHubPhoneInviteId, isHubPhoneScope, type HubDevice,
  type HubMemberRules, type HubPlanUsagePut, type HubRosterRequest
} from "../../shared/hubProtocol";
import { normalizePlanUsageSnapshot } from "../../shared/planUsage";
import type { PlanUsageSnapshot } from "../../shared/types";
import { deviceIdForPublicKey } from "../../main/services/hubAuth";
import { CONTROL_CHARACTER } from "./constants";
import { HubRequestError } from "./httpAnswers";

export function blobReference(blobHash: string, params: URLSearchParams): DeviceEventBlobReference | undefined {
  const reference = { type: "device.event.blob", blobHash, byteLength: Number(params.get("bytes")), fragments: Number(params.get("fragments")) };
  return isDeviceEventBlobReference(reference) ? reference : undefined;
}

export const MACHINE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function machineSettingsKey(machineId: string): string {
  return `machine-settings:${machineId}`;
}

export function planUsageKey(deviceId: string): string {
  return `plan-usage:${deviceId}`;
}

/** A device's plan usage: a few small snapshots, one per CLI, in the shape
 *  the app writes, or nothing is kept. */
export function validPlanUsage(value: unknown): PlanUsageSnapshot[] {
  const snapshots = (value as Partial<HubPlanUsagePut> | undefined)?.snapshots;
  if (!Array.isArray(snapshots) || snapshots.length > HUB_PLAN_USAGE_MAX_SNAPSHOTS) throw new HubRequestError(400, "Invalid plan usage.");
  return snapshots.map((item) => {
    const snapshot = normalizePlanUsageSnapshot(item);
    if (!snapshot || Buffer.byteLength(JSON.stringify(snapshot)) > HUB_PLAN_USAGE_MAX_SNAPSHOT_BYTES) throw new HubRequestError(400, "Invalid plan usage.");
    return snapshot;
  });
}

export function validRoster(value: unknown): HubDevice[] {
  const devices = (value as HubRosterRequest | undefined)?.devices;
  if (!Array.isArray(devices) || devices.length > 200) throw new HubRequestError(400, "Invalid roster.");
  return devices.map((device) => {
    if (!device || typeof device.publicKeyDerBase64 !== "string" || deviceIdForPublicKey(device.publicKeyDerBase64) !== device.deviceId ||
        !(HUB_ROSTER_ROLES as readonly string[]).includes(device.role) || typeof device.name !== "string" || device.name.length > 200 || CONTROL_CHARACTER.test(device.name) ||
        (device.machineId !== undefined && (typeof device.machineId !== "string" || device.machineId.length > 128))) {
      throw new HubRequestError(400, "Invalid roster entry.");
    }
    // A phone is on the roster for every chat (see validInvite).
    if ((device.scope !== undefined && (device.role !== "phone" || !isHubPhoneScope(device.scope) || device.scope.scope !== "device")) ||
        (device.inviteId !== undefined && !isHubPhoneInviteId(device.inviteId))) {
      throw new HubRequestError(400, "Invalid roster entry.");
    }
    return { deviceId: device.deviceId, publicKeyDerBase64: device.publicKeyDerBase64, role: device.role, name: device.name, addedAt: "",
      ...(device.machineId ? { machineId: device.machineId } : {}),
      ...(device.scope ? { scope: device.scope } : {}),
      ...(device.inviteId ? { inviteId: device.inviteId } : {}) };
  });
}

export function validInviteIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1_000 || !value.every(isHubPhoneInviteId)) {
    throw new HubRequestError(400, "Invalid settled invites.");
  }
  return value as string[];
}

/** The User's rules for members, as her computer sends them: only what the
 *  server holds a machine to is kept. */
export function validMemberRules(value: unknown): HubMemberRules {
  const record = value as { version?: unknown; roles?: unknown; presets?: unknown } | undefined;
  const isRecord = (item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item);
  const id = (item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 256;
  const right = (item: unknown) => item === "allow" || item === "ask" || item === "deny" ? item : undefined;
  if (record?.version !== 1 || !isRecord(record.roles) || !isRecord(record.presets) ||
      Object.keys(record.roles).length > 2_000 || Object.keys(record.presets).length > 2_000) {
    throw new HubRequestError(400, "Invalid rules for members.");
  }
  const roles: HubMemberRules["roles"] = {};
  for (const [roleId, entry] of Object.entries(record.roles)) {
    if (!id(roleId) || !isRecord(entry)) throw new HubRequestError(400, "Invalid role rule.");
    const requestParticipants = right(entry.requestParticipants);
    const requestCompaction = right(entry.requestCompaction);
    roles[roleId] = {
      manageRolesParticipants: right(entry.manageRolesParticipants) ?? "deny",
      ...(requestParticipants ? { requestParticipants } : {}),
      ...(requestCompaction ? { requestCompaction } : {})
    };
  }
  const presets: HubMemberRules["presets"] = {};
  for (const [presetId, entry] of Object.entries(record.presets)) {
    if (!id(presetId) || !isRecord(entry) || !id(entry.handle) || !id(entry.roleConfigId) ||
        (entry.homeMachineId !== undefined && !id(entry.homeMachineId)) || (entry.permissions !== undefined && !isRecord(entry.permissions))) {
      throw new HubRequestError(400, "Invalid saved member.");
    }
    presets[presetId] = {
      handle: entry.handle as string,
      roleConfigId: entry.roleConfigId as string,
      ...(entry.homeMachineId !== undefined ? { homeMachineId: entry.homeMachineId as string } : {}),
      ...(entry.agentMode === "auto" || entry.agentMode === "plan" || entry.agentMode === "default" || entry.agentMode === "full-access" ? { agentMode: entry.agentMode } : {}),
      ...(entry.permissions !== undefined ? { permissions: entry.permissions as unknown as NonNullable<HubMemberRules["presets"][string]["permissions"]> } : {})
    };
  }
  // Each machine's program as the computer knows it: advisory, so an entry
  // in another shape is left out rather than refusing her rules with it.
  const machineCliModes: Record<string, boolean> = {};
  const machines = (value as { machineCliModes?: unknown } | undefined)?.machineCliModes;
  if (isRecord(machines)) {
    for (const [machineId, runs] of Object.entries(machines).slice(0, 500)) {
      if (id(machineId) && typeof runs === "boolean") machineCliModes[machineId] = runs;
    }
  }
  return {
    version: 1, roles, presets,
    ...(Object.keys(machineCliModes).length > 0 ? { machineCliModes } : {}),
    ...((value as { accordFromAnySession?: unknown } | undefined)?.accordFromAnySession === true ? { accordFromAnySession: true as const } : {})
  };
}

export function validMachineWake(value: unknown): import("../../shared/hubProtocol").HubMachineWakeRequest["machines"] {
  const machines = (value as { machines?: unknown } | undefined)?.machines;
  const text = (item: unknown, pattern: RegExp) => typeof item === "string" && pattern.test(item);
  if (!Array.isArray(machines) || machines.length > 50) throw new HubRequestError(400, "Invalid start keys.");
  return machines.map((entry) => {
    const machine = entry as { machineId?: unknown; instanceId?: unknown; region?: unknown; credentials?: { accessKeyId?: unknown; secretAccessKey?: unknown; region?: unknown } };
    if (!text(machine?.machineId, /^[A-Za-z0-9._:-]{1,128}$/) || !text(machine.instanceId, /^i-[0-9a-f]{8,32}$/) || !text(machine.region, /^[a-z]{2}(-[a-z]+)+-\d$/) ||
        !text(machine.credentials?.accessKeyId, /^[A-Z0-9]{16,128}$/) || !text(machine.credentials?.secretAccessKey, /^[A-Za-z0-9/+=]{20,128}$/) || machine.credentials?.region !== machine.region) {
      throw new HubRequestError(400, "Invalid start key.");
    }
    return {
      machineId: machine.machineId as string, instanceId: machine.instanceId as string, region: machine.region as string,
      credentials: { accessKeyId: machine.credentials!.accessKeyId as string, secretAccessKey: machine.credentials!.secretAccessKey as string, region: machine.region as string }
    };
  });
}
