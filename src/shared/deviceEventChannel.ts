import type { ChatEventEnvelope } from "./chatEvents";
import type { DeviceEventBlobFragment } from "./deviceEventBlobs";
import type { DeviceEventGap, DeviceEventReceipt } from "./deviceEventDelivery";

/** The state one peer is missing: an artifact revision, named by the target it
 *  belongs to and its own identity. */
export interface ChatActionDependency {
  targetKey: string;
  stateId: string;
}

export function isChatActionDependency(value: unknown): value is ChatActionDependency {
  if (!value || typeof value !== "object") return false;
  const dependency = value as Partial<ChatActionDependency>;
  return typeof dependency.targetKey === "string" && dependency.targetKey.length > 0 && dependency.targetKey.length <= 400
    && typeof dependency.stateId === "string" && dependency.stateId.length > 0 && dependency.stateId.length <= 400;
}

export const DEVICE_EVENT_CHANNEL_PROTOCOL = "accord-device-events-v1";

export type DeviceEventPacket = {
  protocol: typeof DEVICE_EVENT_CHANNEL_PROTOCOL;
  from: string;
  to: string;
  /** A repair delivery gets a fresh buffer entry; the signed inner event never
   * changes. Otherwise a mailbox cursor could already be beyond its old copy. */
  deliveryId?: string;
  /** Sender signature over the complete packet, including recipient. Events
   * also carry their immutable inner signature for shared-log forwarding. */
  signature?: string;
} & (
  | { type: "event"; event: ChatEventEnvelope }
  | { type: "fragment"; fragment: DeviceEventBlobFragment }
  | { type: "ack"; receipt: DeviceEventReceipt }
  | { type: "resend"; gap: DeviceEventGap; requestId: string }
  /** What a deferred action is waiting for, named by the state itself rather
   *  than by a sequence number: the event that carries it may predate this
   *  peer's enrollment, so there is no gap to ask about. */
  | { type: "need"; dependency: ChatActionDependency; requestId: string }
  | { type: "unavailable"; dependency: ChatActionDependency; requestId: string }
  | { type: "probe"; events: Array<Pick<ChatEventEnvelope, "eventId" | "eventHash" | "originId" | "originSeq" | "logScopeId">> }
);

export function isDeviceEventPacket(value: unknown): value is DeviceEventPacket {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const packet = value as Partial<DeviceEventPacket>;
  return packet.protocol === DEVICE_EVENT_CHANNEL_PROTOCOL && typeof packet.from === "string" &&
    typeof packet.to === "string" && ["event", "fragment", "ack", "resend", "need", "unavailable", "probe"].includes(packet.type ?? "");
}
