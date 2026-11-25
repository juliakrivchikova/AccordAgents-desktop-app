import type { ChatMessage } from "../../../../shared/types";
import { CHAT_DELIVERY_POLICY_OPTIONS } from "../../../../shared/chatDeliveryPolicy";

/** The members a User's message names, as resolved where it was written. */
export function deliveryTargetsOf(message: ChatMessage): string[] {
  const value = (message.metadata as { deliveryTargets?: unknown } | undefined)?.deliveryTargets;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/** The members a User's message asks: those the server asks (deliveryTargets)
 *  and those the device it was written on asks itself. */
export function askedParticipantIdsOf(message: ChatMessage): string[] {
  const later = message.metadata?.askedParticipantIds;
  return [...deliveryTargetsOf(message), ...(Array.isArray(later) ? later.filter((id): id is string => typeof id === "string" && id.length > 0) : [])];
}

/** The options shared with the phone and the User's server, so a draft
 *  is routed the same way wherever it is resolved. */
export function chatDeliveryPolicyOptions() {
  return { ...CHAT_DELIVERY_POLICY_OPTIONS, administratorHandles: [...CHAT_DELIVERY_POLICY_OPTIONS.administratorHandles] };
}
