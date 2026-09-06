import type { ChatEventEnvelope } from "./chatEvents";
import type { DeviceEventBlobFragment } from "./deviceEventBlobs";
import type { DeviceEventGap, DeviceEventReceipt } from "./deviceEventDelivery";

export const DEVICE_EVENT_CHANNEL_PROTOCOL = "accord-device-events-v1";

export type DeviceEventPacket = {
  protocol: typeof DEVICE_EVENT_CHANNEL_PROTOCOL;
  from: string;
  to: string;
  /** A repair delivery gets a fresh buffer entry; the signed inner event never
   * changes. Otherwise a mailbox cursor could already be beyond its old copy. */
  deliveryId?: string;
} & (
  | { type: "event"; event: ChatEventEnvelope }
  | { type: "fragment"; fragment: DeviceEventBlobFragment }
  | { type: "ack"; receipt: DeviceEventReceipt }
  | { type: "resend"; gap: DeviceEventGap; requestId: string }
  | { type: "probe"; events: Array<Pick<ChatEventEnvelope, "eventId" | "eventHash" | "originId" | "originSeq" | "logScopeId">> }
);

export function isDeviceEventPacket(value: unknown): value is DeviceEventPacket {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const packet = value as Partial<DeviceEventPacket>;
  return packet.protocol === DEVICE_EVENT_CHANNEL_PROTOCOL && typeof packet.from === "string" &&
    typeof packet.to === "string" && ["event", "fragment", "ack", "resend", "probe"].includes(packet.type ?? "");
}
