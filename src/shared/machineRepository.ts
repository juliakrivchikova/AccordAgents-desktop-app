import type { Conversation } from "./types";

/** Only the receiver's copy gets its native filesystem path. The desktop
 * retains its path, and the map survives forwarding to another machine. */
export function conversationOnMachine(conversation: Conversation, machineId?: string): Conversation {
  const repository = conversation.metadata.machineRepository;
  if (!repository || !machineId) return conversation;
  const repoPath = repository.paths[machineId] ?? repository.sourcePath;
  if (typeof repoPath !== "string" || !repoPath.startsWith("/")) {
    throw new Error("This project has not been prepared on the member's machine. Remove and add the member again to prepare it.");
  }
  return { ...conversation, repoPath };
}
