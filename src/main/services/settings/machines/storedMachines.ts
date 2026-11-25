import type { MachineRecord } from "../../../../shared/machineLink";
import type { MachineInstallRecord } from "../../../../shared/machineInstall";
import type { StoredSettings } from "../types";

export function normalizeMachineInstalls(value: unknown): MachineInstallRecord[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const records = value.flatMap((entry): MachineInstallRecord[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Partial<MachineInstallRecord>;
    const host = record.target && typeof record.target === "object" ? record.target.host : undefined;
    if (typeof record.machineId !== "string" || !record.machineId.trim() || typeof host !== "string" || !host.trim()) {
      return [];
    }
    return [{ ...record, machineId: record.machineId.trim() } as MachineInstallRecord];
  });
  return records.length > 0 ? records : undefined;
}

export function normalizeMachines(value: unknown): MachineRecord[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const machines = value.flatMap((entry): MachineRecord[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Partial<MachineRecord>;
    if (typeof record.id !== "string" || !record.id.trim() || typeof record.name !== "string" || typeof record.pairingKey !== "string" || !record.pairingKey.trim()) {
      return [];
    }
    return [{
      id: record.id.trim(),
      name: record.name.trim() || "Machine",
      ...(typeof record.awsInstanceId === "string" && /^i-[a-f0-9]+$/.test(record.awsInstanceId) ? { awsInstanceId: record.awsInstanceId } : {}),
      deviceId: typeof record.deviceId === "string" ? record.deviceId : "",
      pairingKey: record.pairingKey.trim(),
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
      ...(typeof record.lastSeenAt === "string" ? { lastSeenAt: record.lastSeenAt } : {}),
      ...(record.lastHello && typeof record.lastHello === "object" ? { lastHello: record.lastHello } : {}),
      ...(typeof record.devicePublicKeyDerBase64 === "string" && record.devicePublicKeyDerBase64 ? { devicePublicKeyDerBase64: record.devicePublicKeyDerBase64 } : {})
    }];
  });
  return machines.length > 0 ? machines : undefined;
}

export function removeDeviceTrust(stored: StoredSettings, deviceId: string): void {
  stored.trustedDevices = (stored.trustedDevices ?? []).filter(entry => entry.deviceId !== deviceId);
  stored.machineDeviceRevocations = { ...stored.machineDeviceRevocations, [deviceId]: new Date().toISOString() };
}
