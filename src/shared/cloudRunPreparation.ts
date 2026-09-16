import type { MachineRecord } from "./machineLink";

/** Saved user intent, independent of enrollment, connectivity and provider login. */
export interface CloudRunSelection {
  instanceId?: string;
}

export function cloudRunSelection(value: unknown): CloudRunSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const instanceId = (value as CloudRunSelection).instanceId;
  return typeof instanceId === "string" && instanceId.trim() ? { instanceId: instanceId.trim() } : {};
}

export interface PrepareCloudRunRequest {
  operationId: string;
  provider: "codex-cli" | "claude-code";
  instanceId?: string;
}

export interface CloudRunPreparationProgress {
  operationId: string;
  message: string;
  authUrl?: string;
  authCode?: string;
  authProvider?: "codex-cli" | "claude-code";
  authRequestId?: string;
}

export interface CloudRunPreparationState extends CloudRunPreparationProgress {
  provider: PrepareCloudRunRequest["provider"];
  instanceId?: string;
  phase: "preparing" | "ready" | "error";
  machine?: MachineRecord;
}

export interface PrepareCloudRunResult {
  machine: MachineRecord;
}
