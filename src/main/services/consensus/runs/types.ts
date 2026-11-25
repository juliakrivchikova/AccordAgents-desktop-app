import type { Conversation } from "../../../../shared/types";

export interface CliSessionContext {
  conversation: Conversation;
  warnings: string[];
  sessionKey: string;
}
