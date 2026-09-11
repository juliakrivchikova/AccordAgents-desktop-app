import { useEffect, useRef, useState } from "react";

import type { ChatSearchMatch, ChatSearchResponse } from "../../shared/types";
import { hasSearchTerms } from "./chat-search-query";

const SEARCH_DEBOUNCE_MS = 180;

export interface ChatSearchState {
  query: string;
  loading: boolean;
  loadingMore: boolean;
  response?: ChatSearchResponse;
  setQuery: (query: string) => void;
  clear: () => void;
  loadMore: () => void;
}

export function useChatSearch(open: boolean): ChatSearchState {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [response, setResponse] = useState<ChatSearchResponse>();
  const generationRef = useRef(0);

  useEffect(() => {
    if (open) {
      return;
    }
    generationRef.current += 1;
    setQuery("");
    setLoading(false);
    setLoadingMore(false);
    setResponse(undefined);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    generationRef.current += 1;
    const generation = generationRef.current;
    setLoadingMore(false);
    if (!hasSearchTerms(query)) {
      setLoading(false);
      setResponse(undefined);
      return;
    }

    setLoading(true);
    const timeoutId = window.setTimeout(() => {
      void window.consensus.searchChats({ requester: { kind: "user" }, query }).then((result) => {
        if (generationRef.current !== generation) {
          return;
        }
        setResponse(result);
        setLoading(false);
      }).catch(() => {
        if (generationRef.current !== generation) {
          return;
        }
        setResponse(unavailableClientResponse());
        setLoading(false);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [open, query]);

  return {
    query,
    loading,
    loadingMore,
    response,
    setQuery,
    clear: () => setQuery(""),
    loadMore: () => {
      const current = response;
      if (!open || loading || loadingMore || current?.status !== "ok" || !current.hasMore || !current.nextCursor) {
        return;
      }
      const generation = generationRef.current;
      setLoadingMore(true);
      void window.consensus.searchChats({
        requester: { kind: "user" },
        query,
        cursor: current.nextCursor
      }).then((next) => {
        if (generationRef.current !== generation) {
          return;
        }
        if (next.status !== "ok") {
          setResponse(next);
          return;
        }
        const seen = new Set(current.matches.map(matchKey));
        setResponse({
          ...next,
          matches: [...current.matches, ...next.matches.filter((match) => !seen.has(matchKey(match)))]
        });
      }).catch(() => {
        if (generationRef.current === generation) {
          setResponse(unavailableClientResponse());
        }
      }).finally(() => {
        if (generationRef.current === generation) {
          setLoadingMore(false);
        }
      });
    }
  };
}

function matchKey(match: ChatSearchMatch): string {
  return match.kind === "title"
    ? `title\u0000${match.conversationId}`
    : `message\u0000${match.conversationId}\u0000${match.messageId}`;
}

function unavailableClientResponse(): ChatSearchResponse {
  return {
    status: "unavailable",
    matches: [],
    coverage: {
      eligibleChatCount: 0,
      searchedChatCount: 0,
      messagePeriod: null,
      sourceSnapshotAt: new Date().toISOString(),
      completeness: "none"
    },
    errorCode: "search-unavailable",
    failure: { stage: "index-query" }
  };
}
