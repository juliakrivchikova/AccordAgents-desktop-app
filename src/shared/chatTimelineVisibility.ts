import { ARTIFACT_NOTE_MESSAGE_SOURCE } from "./artifacts";
import type { ChatMessage } from "./types";

export function isParticipantRequestWaitingStatus(content: string): boolean {
  return (
    /^(?:participant request is awaiting user approval|awaiting user approval|waiting for user approval)\.?$/i.test(content.trim()) ||
    /^Asked\s+@[\w-]+(?:\s*,\s*@[\w-]+)*\.?\s+The participant request is awaiting User approval\.?$/i.test(content.trim())
  );
}

export function isChatMessageHiddenFromTimeline(
  message: Pick<ChatMessage, "role" | "content" | "metadata">,
  options: { showSystemMessages?: boolean } = {}
): boolean {
  if (message.metadata?.hiddenFromTimeline === true) {
    return true;
  }
  if (message.role === "participant") {
    return isParticipantRequestWaitingStatus(message.content);
  }
  if (message.role !== "system") {
    return false;
  }
  // Artifact notes are user-facing awareness messages ("@gera revised [Plan] · v3"),
  // not internal system context; keep them on the timeline.
  if (message.metadata?.appMessageSource === ARTIFACT_NOTE_MESSAGE_SOURCE) {
    return false;
  }
  return options.showSystemMessages !== true;
}

/** A message an auto-watching member reacts to: a finished user message, or
 *  another member's finished reply, shown on the timeline. */
export function isAutoWatchStableMessage(
  message: Pick<ChatMessage, "role" | "content" | "metadata" | "status" | "participantId">,
  participantId: string
): boolean {
  if (message.metadata?.autoWatchTrigger || isChatMessageHiddenFromTimeline(message)) {
    return false;
  }
  if (message.role === "user") {
    return message.status !== "pending";
  }
  return message.role === "participant" &&
    message.participantId !== participantId &&
    message.status !== "pending";
}
