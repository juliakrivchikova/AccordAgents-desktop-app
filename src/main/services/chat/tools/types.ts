import type { ChatMessageReactions } from "../../../../shared/types";

export interface ChatReactionMutationResult {
  status: "added" | "removed";
  messageId: string;
  sequence: number;
  emoji: string;
  author: string;
  contentPreview: string;
  reactions: ChatMessageReactions;
}
