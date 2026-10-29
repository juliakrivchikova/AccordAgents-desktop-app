import type { ChatMessage } from "./types";

/**
 * Where a message of the User's stands on her server, shown the same way on
 * every device (the User, 2026-10-29): faded until the server took it, then
 * as any message; a member's reply appearing under it is the sign that work
 * started. Only a refusal says something, with the server's reason.
 */
export const MESSAGE_REFUSED_PREFIX = "Not taken by your server";

export type MessageDelivery =
  | { state: "unsent" }
  | { state: "refused"; text: string };

/** Undefined for a message the server took, and for any other message. */
export function messageDelivery(message: ChatMessage): MessageDelivery | undefined {
  if (message.role !== "user") return undefined;
  const refused = message.metadata?.serverRejected;
  if (typeof refused === "string" && refused) return { state: "refused", text: `${MESSAGE_REFUSED_PREFIX}: ${refused}` };
  if (typeof message.metadata?.serverSeq !== "number") return { state: "unsent" };
  return undefined;
}
