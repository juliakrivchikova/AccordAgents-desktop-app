import type { ChatEventEnvelope } from "./chatEvents";
import type { MobilePairingCapability } from "./mobilePairing";

export type ChatDeviceCapabilityEventKind =
  | "device.capability.granted"
  | "device.capability.revoked";

export interface ChatDeviceCapabilityGrantPayload {
  grantId: string;
  deviceOriginId: string;
  deviceKeyId: string;
  capabilities: MobilePairingCapability[];
  grantedAt: string;
  expiresAt?: string;
}

export interface ChatDeviceCapabilityRevokedPayload {
  grantId?: string;
  deviceOriginId: string;
  revokedAt: string;
  effectiveAfterLogicalTs?: string;
  reason?: string;
}

export type ChatDeviceCapabilityPayload =
  | ChatDeviceCapabilityGrantPayload
  | ChatDeviceCapabilityRevokedPayload;

export type ChatDeviceCapabilityEvent = ChatEventEnvelope<ChatDeviceCapabilityPayload> & {
  kind: ChatDeviceCapabilityEventKind;
};

export interface ChatDeviceCapabilityState {
  grants: Map<string, ChatDeviceCapabilityGrantPayload>;
  revocations: Map<string, ChatDeviceCapabilityRevokedPayload>;
}

export type ChatDeviceEventAcceptance = "accepted" | "missing-capability" | "capability-expired" | "revoked";

export interface ChatDeviceEventAcceptanceInput {
  event: ChatEventEnvelope;
  conversationId: string;
  requireWrite?: boolean;
  requireCloudRun?: boolean;
  now?: Date;
}

export function foldChatDeviceCapabilityEvents(events: ChatEventEnvelope[]): ChatDeviceCapabilityState {
  const grants = new Map<string, ChatDeviceCapabilityGrantPayload>();
  const revocations = new Map<string, ChatDeviceCapabilityRevokedPayload>();
  const ordered = [...events].sort(compareCapabilityEvents);
  for (const event of ordered) {
    if (event.kind === "device.capability.granted" && isGrantPayload(event.payload)) {
      grants.set(event.payload.grantId, clone(event.payload));
      continue;
    }
    if (event.kind === "device.capability.revoked" && isRevokedPayload(event.payload)) {
      const existing = revocations.get(event.payload.deviceOriginId);
      if (!existing || compareOptionalLogicalTs(event.payload.effectiveAfterLogicalTs, existing.effectiveAfterLogicalTs) < 0) {
        revocations.set(event.payload.deviceOriginId, clone(event.payload));
      }
    }
  }
  return { grants, revocations };
}

export function classifyDeviceEventAcceptance(
  state: ChatDeviceCapabilityState,
  input: ChatDeviceEventAcceptanceInput
): ChatDeviceEventAcceptance {
  const grant = [...state.grants.values()].find((candidate) =>
    candidate.deviceOriginId === input.event.originId &&
      candidate.capabilities.some((capability) => capabilityMatches(capability, input))
  );
  if (!grant) {
    return "missing-capability";
  }
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= (input.now ?? new Date()).getTime()) {
    return "capability-expired";
  }
  const revocation = state.revocations.get(input.event.originId);
  if (revocation && isEventAfterRevocation(input.event, revocation)) {
    return "revoked";
  }
  return "accepted";
}

function capabilityMatches(
  capability: MobilePairingCapability,
  input: ChatDeviceEventAcceptanceInput
): boolean {
  if (capability.scope !== "conversation" || capability.conversationId !== input.conversationId || !capability.canRead) {
    return false;
  }
  if (input.requireWrite && !capability.canWrite) {
    return false;
  }
  if (input.requireCloudRun && !capability.canRunCloudParticipants) {
    return false;
  }
  return true;
}

function isEventAfterRevocation(event: ChatEventEnvelope, revocation: ChatDeviceCapabilityRevokedPayload): boolean {
  if (!revocation.effectiveAfterLogicalTs) {
    return true;
  }
  return event.logicalTs > revocation.effectiveAfterLogicalTs;
}

function compareCapabilityEvents(left: ChatEventEnvelope, right: ChatEventEnvelope): number {
  return left.logicalTs.localeCompare(right.logicalTs) ||
    left.originId.localeCompare(right.originId) ||
    left.logScopeId.localeCompare(right.logScopeId) ||
    left.originSeq - right.originSeq ||
    left.eventId.localeCompare(right.eventId);
}

function compareOptionalLogicalTs(left: string | undefined, right: string | undefined): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return -1;
  }
  if (!right) {
    return 1;
  }
  return left.localeCompare(right);
}

function isGrantPayload(value: unknown): value is ChatDeviceCapabilityGrantPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { grantId?: unknown }).grantId === "string" &&
      typeof (value as { deviceOriginId?: unknown }).deviceOriginId === "string" &&
      typeof (value as { deviceKeyId?: unknown }).deviceKeyId === "string" &&
      Array.isArray((value as { capabilities?: unknown }).capabilities) &&
      typeof (value as { grantedAt?: unknown }).grantedAt === "string"
  );
}

function isRevokedPayload(value: unknown): value is ChatDeviceCapabilityRevokedPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { deviceOriginId?: unknown }).deviceOriginId === "string" &&
      typeof (value as { revokedAt?: unknown }).revokedAt === "string"
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
