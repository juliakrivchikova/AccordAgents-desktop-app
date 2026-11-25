import { chatInterimPostsOf } from "./interimPosts";
import type { ChatMessage } from "./types";

/** The note the app itself adds under a reply that left work running
 *  (noteClaudeBackgroundWorkStillRunning): no step of the member's. */
const LEFT_RUNNING_NOTE = /^Running in the background: /;

/** A finished reply with nothing in it: no words, steps, posts, pictures,
 *  tasks, questions or cards. A part of a turn the User's next message joined
 *  (ChatMessageMetadata.turnContinues), or a step Claude Code started and
 *  ended by itself with nothing to do (replies kept from before the app left
 *  those out). As in the CLI's transcript, no row is drawn for it. */
export function isEmptyFinishedReply(message: ChatMessage): boolean {
  if (message.role !== "participant" || message.status !== "done" || message.content.trim()) return false;
  const metadata = message.metadata;
  if (!metadata) return false;
  const steps = (metadata.activityEvents ?? []).filter((event) => !(event.kind === "status" && LEFT_RUNNING_NOTE.test(event.label)));
  return steps.length === 0 && !metadata.processingTranscript?.content?.trim() &&
    chatInterimPostsOf(message).length === 0 && !(Array.isArray(metadata.imageAttachments) && metadata.imageAttachments.length > 0) &&
    !metadata.pendingChoice && !metadata.participantRequest && !metadata.pendingMentions?.length && !metadata.urgentAlert &&
    !metadata.accordResolution && !metadata.artifactEventId && !metadata.missingProjectCopy && !metadata.compaction &&
    !metadata.nativeCommand && Object.keys(metadata.reactions ?? {}).length === 0;
}
