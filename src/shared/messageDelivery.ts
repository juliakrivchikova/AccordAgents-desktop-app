import type { ChatMessage } from "./types";

/**
 * The marks a message of the User's carries, the same words on every device
 * (agreements Д3, Д5; the phone app uses these words too): not answered by her
 * server yet, refused by it, taken by it, and taken to work by each member's
 * own device.
 */
export const MESSAGE_MARK_NOT_SENT = "Not sent, retrying";
export const MESSAGE_MARK_SENT = "Sent";
export const MESSAGE_MARK_TAKEN = "Taken to work";
export const MESSAGE_MARK_REFUSED = "Not taken by your server";

/** "@a", "@a and @b", "@a, @b and @c". */
function handleList(handles: string[]): string {
  if (handles.length <= 1) return handles[0] ?? "";
  return `${handles.slice(0, -1).join(", ")} and ${handles[handles.length - 1]}`;
}

/** Where a message of the User's stands, or undefined for any other message. */
export function messageDeliveryMark(message: ChatMessage, memberHandle: (participantId: string) => string | undefined): string | undefined {
  if (message.role !== "user") return undefined;
  const refused = message.metadata?.serverRejected;
  if (typeof refused === "string" && refused) return `${MESSAGE_MARK_REFUSED}: ${refused}`;
  if (typeof message.metadata?.serverSeq !== "number") return MESSAGE_MARK_NOT_SENT;
  const taken = Object.entries(message.metadata?.serverTurns ?? {})
    .filter(([, turn]) => turn && (turn.state === "claimed" || turn.state === "finished"))
    .map(([participantId]) => {
      const handle = memberHandle(participantId);
      return handle ? `@${handle.replace(/^@/, "")}` : "a member";
    });
  return taken.length ? `${MESSAGE_MARK_TAKEN} by ${handleList(taken)}` : MESSAGE_MARK_SENT;
}
