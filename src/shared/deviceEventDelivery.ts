import type { ChatEventEnvelope } from "./chatEvents";

/** A roster entry is a destination, never a transport choice on a participant. */
export interface DeviceEventRecipient {
  deviceId: string;
  channelId: string;
}

export interface DeviceEventIngress {
  deviceId: string;
  channelId: string;
}

export interface DeviceEventAppendOptions {
  recipients?: DeviceEventRecipient[];
  ingress?: DeviceEventIngress;
}

export type DeviceEventApplyOutcome = "applied" | "superseded";

export interface DeviceEventDelivery {
  event: ChatEventEnvelope;
  recipient: DeviceEventRecipient;
  deliveredAt?: string;
  acknowledgedAt?: string;
  outcome?: DeviceEventApplyOutcome;
}

/** A pending outbox entry without its envelope: enough to decide whether it is
 *  due again, and to probe for it, without reading the event body. */
export interface DeviceEventPendingHeader {
  rowId: number;
  eventId: string;
  eventHash: string;
  originId: string;
  originSeq: number;
  logScopeId: string;
  deliveredAt?: string | null;
}

export interface DeviceEventReceipt {
  eventId: string;
  eventHash: string;
  outcome: DeviceEventApplyOutcome;
  appliedAt: string;
}

export interface DeviceEventGap {
  originId: string;
  logScopeId: string;
  fromSeq: number;
  toSeq: number;
}

/** Ingress is durable; its domain owner will retry from the local inbox.
 * A transport cursor may advance without claiming that application succeeded. */
export class DeviceEventProjectionPendingError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

/** SQL and network readers page by bytes as well as count, on real chat data. */
export const DEVICE_EVENT_PAGE_BYTES = 1024 * 1024;
export const DEVICE_EVENT_PAGE_COUNT = 100;
/** Headers carry no body, so a retry pass reads them in larger pages. */
export const DEVICE_EVENT_HEADER_PAGE_COUNT = 500;
/** Most event headers one receipt probe may carry. Every runtime already in
 *  the field refuses a larger probe, so a sender splits instead. */
export const DEVICE_EVENT_PROBE_LIMIT = 100;
