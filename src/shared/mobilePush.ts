export const MOBILE_PUSH_PAYLOAD_VERSION = 1;

export type MobilePushReason = "sync-needed" | "run-updated" | "approval-updated";

export interface MobilePushPayload {
  version: typeof MOBILE_PUSH_PAYLOAD_VERSION;
  reason: MobilePushReason;
  eventId?: string;
  conversationId?: string;
}

const FORBIDDEN_PUSH_FIELDS = new Set([
  "message",
  "messageText",
  "content",
  "prompt",
  "approval",
  "approvalText",
  "toolData",
  "output"
]);

export function createOpaqueMobilePushPayload(input: Omit<MobilePushPayload, "version">): MobilePushPayload {
  const payload: MobilePushPayload = {
    version: MOBILE_PUSH_PAYLOAD_VERSION,
    reason: input.reason,
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {})
  };
  assertOpaqueMobilePushPayload(payload);
  return payload;
}

export function assertOpaqueMobilePushPayload(value: unknown): asserts value is MobilePushPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mobile push payload must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PUSH_FIELDS.has(key)) {
      throw new Error(`Mobile push payload must not include sensitive field ${key}.`);
    }
  }
  const record = value as Record<string, unknown>;
  if (record.version !== MOBILE_PUSH_PAYLOAD_VERSION) {
    throw new Error("Mobile push payload version is invalid.");
  }
  if (record.reason !== "sync-needed" && record.reason !== "run-updated" && record.reason !== "approval-updated") {
    throw new Error("Mobile push payload reason is invalid.");
  }
  for (const field of ["eventId", "conversationId"] as const) {
    if (record[field] !== undefined && (typeof record[field] !== "string" || !record[field].trim())) {
      throw new Error(`Mobile push payload ${field} must be a non-empty string.`);
    }
  }
}
