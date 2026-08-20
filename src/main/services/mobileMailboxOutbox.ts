import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { MobileOutboxEvent } from "./mobileRelayControl";

export interface MobileMailboxOutboxSelection {
  isConversationAllowed(conversationId: string): Promise<boolean> | boolean;
  hasAcceptedMobileEvent(conversationId: string, eventId: string): Promise<boolean> | boolean;
  hasMobileMailboxResultForMobileEvent(conversationId: string, eventId: string): Promise<boolean> | boolean;
  tryAcquireMobileEventExecution?(event: MobileOutboxEvent): Promise<boolean> | boolean;
  acceptMailboxMessageEvent(value: unknown): Promise<boolean> | boolean;
  acceptMobileOutboxEnvelope?(event: ChatEventEnvelope): Promise<boolean> | boolean;
  acceptFulfilledMobileOutboxEvent(event: ChatEventEnvelope): Promise<unknown> | unknown;
}

const MOBILE_MAILBOX_PENDING_CLAIM_TTL_MS = 15 * 60 * 1000;

export async function collectMobileMailboxOutboxEvents(
  mailboxEvents: unknown[],
  selection: MobileMailboxOutboxSelection
): Promise<MobileOutboxEvent[]> {
  const fulfilledMobileEventKeys = fulfilledMobileEventKeysFromMailboxEvents(mailboxEvents);
  const claimedMobileEventKeys = claimedMobileEventKeysFromMailboxEvents(mailboxEvents);
  const events: MobileOutboxEvent[] = [];
  for (const event of mailboxEvents) {
    const eventConversationId = mailboxEnvelopeConversationId(event);
    if (!eventConversationId || !await selection.isConversationAllowed(eventConversationId)) {
      continue;
    }
    if (await selection.acceptMailboxMessageEvent(event)) {
      continue;
    }
    const outboxEvent = mailboxEnvelopeToMobileOutboxEvent(event);
    if (!outboxEvent) {
      continue;
    }
    if (selection.acceptMobileOutboxEnvelope && !await selection.acceptMobileOutboxEnvelope(event as ChatEventEnvelope)) {
      continue;
    }
    if (await selection.hasAcceptedMobileEvent(outboxEvent.conversationId, outboxEvent.eventId)) {
      continue;
    }
    if (outboxEvent.kind === "run.cancel.requested") {
      events.push(outboxEvent);
      continue;
    }
    const outboxEventKey = mobileMailboxEventScopeKey(outboxEvent.conversationId, outboxEvent.eventId);
    if (
      fulfilledMobileEventKeys.has(outboxEventKey) ||
      claimedMobileEventKeys.has(outboxEventKey) ||
      await selection.hasMobileMailboxResultForMobileEvent(outboxEvent.conversationId, outboxEvent.eventId)
    ) {
      await selection.acceptFulfilledMobileOutboxEvent(event as ChatEventEnvelope);
      continue;
    }
    if (selection.tryAcquireMobileEventExecution && !await selection.tryAcquireMobileEventExecution(outboxEvent)) {
      await selection.acceptFulfilledMobileOutboxEvent(event as ChatEventEnvelope);
      continue;
    }
    events.push(outboxEvent);
  }
  return events;
}

export function fulfilledMobileEventKeysFromMailboxEvents(events: unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    const key = fulfilledMobileEventKeyFromMailboxEvent(event);
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

export function claimedMobileEventKeysFromMailboxEvents(events: unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    for (const key of claimedMobileEventKeysFromMailboxEvent(event)) {
      keys.add(key);
    }
  }
  return keys;
}

function claimedMobileEventKeysFromMailboxEvent(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.kind !== "mobile.timeline.events") {
    return [];
  }
  const conversationId = typeof envelope.conversationId === "string" ? envelope.conversationId.trim() : "";
  const payload = envelope.payload;
  const timelineEvents = payload && typeof payload === "object" && !Array.isArray(payload) &&
    Array.isArray((payload as { events?: unknown }).events)
    ? (payload as { events: unknown[] }).events
    : [];
  if (!conversationId || timelineEvents.length === 0) {
    return [];
  }
  return timelineEvents.flatMap((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return [];
    }
    const record = event as Record<string, unknown>;
    const status = typeof record.status === "string" ? record.status.trim() : "";
    const mobileEventId = mobileEventIdFromTimelineEvent(record);
    if (!mobileEventId) {
      return [];
    }
    if (status === "pending" && timelineClaimExpired(record, envelope)) {
      return [];
    }
    if (status !== "pending" && status !== "done" && status !== "error") {
      return [];
    }
    return [mobileMailboxEventScopeKey(conversationId, mobileEventId)];
  });
}

function mobileEventIdFromTimelineEvent(record: Record<string, unknown>): string | undefined {
  const explicit = typeof record.mobileEventId === "string" ? record.mobileEventId.trim() : "";
  if (explicit) {
    return explicit;
  }
  const runId = typeof record.runId === "string" ? record.runId.trim() : "";
  return runId.startsWith("mobile-") ? runId.slice("mobile-".length) : undefined;
}

function timelineClaimExpired(record: Record<string, unknown>, envelope: Record<string, unknown>): boolean {
  const createdAt = typeof record.createdAt === "string" && record.createdAt.trim()
    ? record.createdAt
    : typeof envelope.createdAt === "string" ? envelope.createdAt : "";
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs) && Date.now() - createdAtMs > MOBILE_MAILBOX_PENDING_CLAIM_TTL_MS;
}

function mailboxEnvelopeConversationId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const envelope = value as Record<string, unknown>;
  const conversationId = typeof envelope.conversationId === "string" ? envelope.conversationId.trim() : "";
  return conversationId || undefined;
}

function fulfilledMobileEventKeyFromMailboxEvent(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.kind !== "message.created") {
    return undefined;
  }
  const conversationId = typeof envelope.conversationId === "string" ? envelope.conversationId.trim() : "";
  const payload = envelope.payload;
  const message = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { message?: unknown }).message
    : undefined;
  if (!conversationId || !message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "participant" || (record.status !== "done" && record.status !== "error")) {
    return undefined;
  }
  const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : {};
  const explicitMobileEventId = typeof metadata.mobileEventId === "string" ? metadata.mobileEventId.trim() : "";
  const sourceMessageId = typeof metadata.sourceMessageId === "string" ? metadata.sourceMessageId.trim() : "";
  const runId = typeof metadata.runId === "string" ? metadata.runId.trim() : "";
  const mobileEventId = explicitMobileEventId || (sourceMessageId && runId === `mobile-${sourceMessageId}` ? sourceMessageId : "");
  if (!mobileEventId) {
    return undefined;
  }
  return mobileMailboxEventScopeKey(conversationId, mobileEventId);
}

export function mobileMailboxEventScopeKey(conversationId: string, eventId: string): string {
  return `${conversationId}\0${eventId}`;
}

export function mailboxEnvelopeToMobileOutboxEvent(value: unknown): MobileOutboxEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.kind !== "message.created" && envelope.kind !== "run.cancel.requested") {
    return undefined;
  }
  const eventId = typeof envelope.eventId === "string" ? envelope.eventId.trim() : "";
  const conversationId = typeof envelope.conversationId === "string" ? envelope.conversationId.trim() : "";
  const payload = envelope.payload;
  if (!eventId || !conversationId || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  if (envelope.kind === "run.cancel.requested") {
    const runId = typeof (payload as { runId?: unknown }).runId === "string"
      ? (payload as { runId: string }).runId.trim()
      : "";
    return runId ? {
      eventId,
      conversationId,
      kind: "run.cancel.requested",
      ...(typeof envelope.createdAt === "string" ? { createdAt: envelope.createdAt } : {}),
      payload: { runId }
    } : undefined;
  }
  const content = typeof (payload as { content?: unknown }).content === "string"
    ? (payload as { content: string }).content.trim()
    : "";
  if (!content) {
    return undefined;
  }
  return {
    eventId,
    conversationId,
    ...(typeof envelope.createdAt === "string" ? { createdAt: envelope.createdAt } : {}),
    payload: { content }
  };
}
