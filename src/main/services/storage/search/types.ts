import type { ChatParticipant, Conversation } from "../../../../shared/types";
import type { ChatSearchDocument } from "../../../../shared/chatSearchDocuments";

export class InvalidChatSearchSourceError extends Error {
  constructor(readonly conversationId: string, cause?: unknown) {
    super(`Saved chat ${conversationId} could not be read for search.`, { cause });
    this.name = "InvalidChatSearchSourceError";
  }
}

export interface ChatSearchConversationSnapshot {
  conversationId: string;
  title: string;
  repoPath?: string;
  archived: boolean;
  updatedAt: string;
  messageCount: number;
  oldestMessageAt?: string;
  newestMessageAt?: string;
  participants: ChatParticipant[];
  /** The chat's main session and view, for how its results name authors
   *  (the sessions view names none). */
  mainSessionParticipantId?: string;
  chatView?: string;
  sourceReadable?: boolean;
}

export interface ChatSearchConversationRead {
  snapshot: ChatSearchConversationSnapshot;
  conversation: Conversation;
}

export interface ChatSearchDocumentReplacement {
  snapshot: ChatSearchConversationSnapshot;
  documents: ChatSearchDocument[];
  indexedAt: string;
}

export interface ChatSearchIndexState {
  conversationId: string;
  sourceTitle: string;
  sourceUpdatedAt: string;
  sourceMessageCount: number;
  sourceNewestMessageAt?: string;
  indexedAt: string;
  indexSchemaVersion: number;
}

export interface StoredChatSearchTitleMatch {
  kind: "title";
  conversationId: string;
  titleText: string;
  snippet: string;
  rank: number;
}

export interface StoredChatSearchMessageMatch {
  kind: "message";
  conversationId: string;
  messageId: string;
  threadRootId?: string;
  role: "user" | "participant";
  authorLabel: string;
  createdAt: string;
  snippet: string;
  rank: number;
}

export interface StoredChatSearchQueryResult {
  titleMatches: StoredChatSearchTitleMatch[];
  messageMatches: StoredChatSearchMessageMatch[];
  messageMatchCount: number;
  matchedChatCount: number;
}
