export type HostProviderKind = "byo-host" | "aws" | "self-hosted" | "managed";

export interface HostProviderCapability {
  providerId: string;
  kind: HostProviderKind;
  supportsWakePath: boolean;
  alwaysOn: boolean;
  supportsStopWhenIdle: boolean;
  minimumPostWakeUptimeMs?: number;
}

export type HostProviderIdlePolicy =
  | { status: "allowed"; reason: "wake-path" | "always-on-noop" }
  | { status: "denied"; reason: "missing-wake-path" };

export function hostProviderIdlePolicy(capability: HostProviderCapability): HostProviderIdlePolicy {
  assertHostProviderCapability(capability);
  if (!capability.supportsStopWhenIdle) {
    return { status: "allowed", reason: "always-on-noop" };
  }
  if (capability.supportsWakePath) {
    return { status: "allowed", reason: "wake-path" };
  }
  if (capability.alwaysOn) {
    return { status: "allowed", reason: "always-on-noop" };
  }
  return { status: "denied", reason: "missing-wake-path" };
}

export function assertHostProviderCanStopWhenIdle(capability: HostProviderCapability): void {
  const policy = hostProviderIdlePolicy(capability);
  if (policy.status === "denied") {
    throw new Error(`Host provider ${capability.providerId} cannot stopWhenIdle without a phone-reachable wake path.`);
  }
}

export function assertHostProviderCapability(capability: HostProviderCapability): void {
  if (!capability.providerId.trim()) {
    throw new Error("Host provider capability requires providerId.");
  }
  if (capability.kind !== "byo-host" && capability.kind !== "aws" && capability.kind !== "self-hosted" && capability.kind !== "managed") {
    throw new Error(`Host provider ${capability.providerId} has invalid kind.`);
  }
  for (const [field, value] of [
    ["supportsWakePath", capability.supportsWakePath],
    ["alwaysOn", capability.alwaysOn],
    ["supportsStopWhenIdle", capability.supportsStopWhenIdle]
  ] as const) {
    if (typeof value !== "boolean") {
      throw new Error(`Host provider ${capability.providerId} ${field} must be boolean.`);
    }
  }
  if (
    capability.minimumPostWakeUptimeMs !== undefined &&
    (!Number.isSafeInteger(capability.minimumPostWakeUptimeMs) || capability.minimumPostWakeUptimeMs < 0)
  ) {
    throw new Error(`Host provider ${capability.providerId} minimumPostWakeUptimeMs is invalid.`);
  }
  if (capability.supportsWakePath && (!capability.minimumPostWakeUptimeMs || capability.minimumPostWakeUptimeMs <= 0)) {
    throw new Error(`Host provider ${capability.providerId} wake path requires minimumPostWakeUptimeMs.`);
  }
}
