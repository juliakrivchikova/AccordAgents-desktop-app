export type ChatSearchRequester =
  | { kind: "user" }
  | { kind: "participant"; conversationId: string; participantId: string };

export interface ChatSearchRequest {
  requester: ChatSearchRequester;
  query: string;
  limit?: number;
  cursor?: string;
  /** The server's own use (a member's search of its project's chats): a
   *  message with any word asked, in any form, best match first. */
  anyWord?: boolean;
  /** The server's own use: only the chats of this project folder (null:
   *  chats with no project). */
  repoPath?: string | null;
}

export interface ChatSearchHighlightRange {
  start: number;
  end: number;
}

export interface ChatSearchMatchBase {
  conversationId: string;
  conversationTitle: string;
  conversationUpdatedAt: string;
  repoPath?: string;
  archived: boolean;
  rank: number;
}

export interface ChatSearchTitleMatch extends ChatSearchMatchBase {
  kind: "title";
  titleText: string;
  highlightRanges: ChatSearchHighlightRange[];
}

export interface ChatSearchMessageMatch extends ChatSearchMatchBase {
  kind: "message";
  messageId: string;
  threadRootId?: string;
  role: "user" | "participant";
  authorLabel: string;
  /** The chat is shown in the sessions view, which names no member: the
   *  result shows no author for a member's message. */
  sessionsView?: boolean;
  createdAt: string;
  snippetText: string;
  highlightRanges: ChatSearchHighlightRange[];
}

export type ChatSearchMatch = ChatSearchTitleMatch | ChatSearchMessageMatch;

export type ChatSearchCompleteness = "complete" | "partial" | "none";

export interface ChatSearchCoverage {
  eligibleChatCount: number;
  searchedChatCount: number;
  messagePeriod: { from: string; to: string } | null;
  sourceSnapshotAt: string;
  indexedAt?: string;
  completeness: ChatSearchCompleteness;
}

export type ChatSearchFailureStage =
  | "source-snapshot"
  | "requester-scope"
  | "index-prepare"
  | "source-read"
  | "index-write"
  | "index-query";

export interface ChatSearchFailureDetail {
  stage: ChatSearchFailureStage;
  conversationId?: string;
}

export type ChatSearchResponse =
  | {
      status: "ok";
      matches: ChatSearchMatch[];
      coverage: ChatSearchCoverage;
      messageMatchCount: number;
      matchedChatCount: number;
      hasMore: boolean;
      nextCursor?: string;
    }
  | {
      status: "unavailable";
      matches: [];
      coverage: ChatSearchCoverage;
      errorCode: "search-unavailable" | "requester-not-authorized" | "invalid-request";
      failure?: ChatSearchFailureDetail;
    };
