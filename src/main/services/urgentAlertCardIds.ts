import { createHash } from "node:crypto";
import { URGENT_ALERT_UNSENT_ID_PREFIX } from "../../shared/urgentAlerts";

/**
 * The id of an alert's card in its chat: the same on the User's server
 * (which writes the card) and on the device that raised it (which may put
 * the card up itself first, while the server could not take the alert), so
 * the server's card replaces that one in place. Shaped as a UUID, as every
 * message id is.
 */
export function urgentAlertCardMessageId(conversationId: string, participantId: string, requestId: string): string {
  const hex = alertKeyHash(conversationId, participantId, requestId);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The alert id of the card a device put up itself (state "unsent"). */
export function urgentAlertUnsentId(conversationId: string, participantId: string, requestId: string): string {
  return `${URGENT_ALERT_UNSENT_ID_PREFIX}${alertKeyHash(conversationId, participantId, requestId).slice(0, 32)}`;
}

function alertKeyHash(conversationId: string, participantId: string, requestId: string): string {
  return createHash("sha256").update(`urgent-alert-card\n${conversationId}\n${participantId}\n${requestId}`).digest("hex");
}
