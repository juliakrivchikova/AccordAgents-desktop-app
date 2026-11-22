import { chatInterimPostsOf } from "./interimPosts";
import type { ChatMessage } from "./types";

/** A part of a turn the User's next message joined
 *  (ChatMessageMetadata.turnContinues) with nothing in it: no words, steps,
 *  posts or pictures. As in the CLI's transcript, no row is drawn for it. */
export function isEmptyContinuedTurnPart(message: ChatMessage): boolean {
  const metadata = message.metadata;
  return message.role === "participant" && message.status === "done" && metadata?.turnContinues === true &&
    !message.content.trim() && !metadata.activityEvents?.length && chatInterimPostsOf(message).length === 0 &&
    !(Array.isArray(metadata.imageAttachments) && metadata.imageAttachments.length > 0);
}
