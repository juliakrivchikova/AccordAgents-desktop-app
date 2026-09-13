import type { MachineRecord } from "./machineLink";

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

export interface PrepareCloudRunResult {
  machine: MachineRecord;
}
