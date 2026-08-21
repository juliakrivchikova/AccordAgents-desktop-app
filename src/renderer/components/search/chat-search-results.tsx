import { Fragment, useEffect, useMemo, useRef } from "react";

import type {
  ChatSearchHighlightRange,
  ChatSearchMessageMatch,
  ChatSearchResponse,
  ChatSearchTitleMatch
} from "../../../shared/types";

export interface ChatSearchResultGroup {
  conversationId: string;
  conversationTitle: string;
  conversationUpdatedAt: string;
  repoPath?: string;
  titleMatch?: ChatSearchTitleMatch;
  messages: ChatSearchMessageMatch[];
}

export type ChatSearchAction =
  | { kind: "conversation"; group: ChatSearchResultGroup }
  | { kind: "message"; match: ChatSearchMessageMatch };

export function ChatSearchResults({
  query,
  loading,
  loadingMore,
  response,
  activeIndex,
  onActiveIndexChange,
  onOpenConversation,
  onOpenMessage,
  onLoadMore
}: {
  query: string;
  loading: boolean;
  loadingMore: boolean;
  response?: ChatSearchResponse;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenMessage: (match: ChatSearchMessageMatch) => void;
  onLoadMore: () => void;
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const groups = useMemo(() => groupSearchMatches(response), [response]);
  const actions = useMemo(() => searchActions(groups), [groups]);

  useEffect(() => {
    if (response?.status !== "ok" || !response.hasMore || loadingMore) {
      return;
    }
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onLoadMore();
      }
    }, { root: bodyRef.current, rootMargin: "80px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadingMore, onLoadMore, response]);

  return (
    <div
      ref={bodyRef}
      id="chat-search-results"
      className="aa-searchmodal-body"
      aria-busy={loading ? "true" : undefined}
    >
      {!query.trim() || (loading && response === undefined) ? (
        <SearchEmpty title="Search across every chat" body="Results group by chat, newest first." />
      ) : response?.status === "unavailable" ? (
        <SearchEmpty title="Search unavailable" body={unavailableCause(response)} testId="chat-search-unavailable" />
      ) : response?.status === "ok" && groups.length === 0 ? (
        <SearchEmpty
          title="Nothing matched"
          body={`No message or chat title contains “${query.trim()}”.`}
          testId="chat-search-empty"
        />
      ) : response?.status === "ok" ? (
        <>
          <div className="aa-sr-summary">
            <span>
              {response.messageMatchCount} {response.messageMatchCount === 1 ? "result" : "results"} in{" "}
              {response.matchedChatCount} {response.matchedChatCount === 1 ? "chat" : "chats"}
            </span>
            <span className="aa-sr-keys">↑↓ ↵</span>
          </div>
          <div role="listbox" aria-label="Saved chat search results">
            {groups.map((group) => {
              const headerIndex = actions.findIndex((action) =>
                action.kind === "conversation" && action.group.conversationId === group.conversationId
              );
              return (
                <div className="aa-sr-group" key={group.conversationId} role="group" aria-label={group.conversationTitle}>
                  <button
                    id={searchActionDomId(headerIndex)}
                    type="button"
                    className={`aa-sr-head${activeIndex === headerIndex ? " active" : ""}`}
                    role="option"
                    aria-selected={activeIndex === headerIndex}
                    onMouseMove={() => onActiveIndexChange(headerIndex)}
                    onClick={() => onOpenConversation(group.conversationId)}
                    data-testid="chat-search-chat-result"
                    data-conversation-id={group.conversationId}
                  >
                    <span className="aa-sr-chat">{group.conversationTitle}</span>
                    {group.repoPath && <span className="aa-sr-proj">{projectLabel(group.repoPath)}</span>}
                    {group.titleMatch && <span className="aa-sr-chip">title</span>}
                    {group.messages.length > 0 && <span className="aa-sr-count">{group.messages.length}</span>}
                  </button>
                  {group.messages.map((match) => {
                    const index = actions.findIndex((action) =>
                      action.kind === "message" && action.match.messageId === match.messageId &&
                      action.match.conversationId === match.conversationId
                    );
                    return (
                      <button
                        key={match.messageId}
                        id={searchActionDomId(index)}
                        type="button"
                        className={`aa-sr-row${activeIndex === index ? " active" : ""}`}
                        role="option"
                        aria-selected={activeIndex === index}
                        onMouseMove={() => onActiveIndexChange(index)}
                        onClick={() => onOpenMessage(match)}
                        data-testid="chat-search-message-result"
                        data-conversation-id={match.conversationId}
                        data-message-id={match.messageId}
                      >
                        <span className="aa-sr-snip">
                          <span className="aa-sr-author">{shortAuthor(match.authorLabel)}: </span>
                          <HighlightedText
                            text={match.snippetText}
                            ranges={match.highlightRanges}
                          />
                        </span>
                        <time className="aa-sr-when" dateTime={match.createdAt}>{formatSearchTime(match.createdAt)}</time>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {response.hasMore && (
            <span ref={sentinelRef} className="aa-search-sentinel" aria-hidden data-testid="chat-search-sentinel" />
          )}
        </>
      ) : null}
    </div>
  );
}

export function groupSearchMatches(response: ChatSearchResponse | undefined): ChatSearchResultGroup[] {
  if (response?.status !== "ok") {
    return [];
  }
  const byConversationId = new Map<string, ChatSearchResultGroup>();
  for (const match of response.matches) {
    const group = byConversationId.get(match.conversationId) ?? {
      conversationId: match.conversationId,
      conversationTitle: match.conversationTitle,
      conversationUpdatedAt: match.conversationUpdatedAt,
      ...(match.repoPath ? { repoPath: match.repoPath } : {}),
      messages: []
    };
    if (match.kind === "title") {
      group.titleMatch = match;
    } else {
      group.messages.push(match);
    }
    byConversationId.set(match.conversationId, group);
  }
  return [...byConversationId.values()]
    .map((group) => ({
      ...group,
      messages: group.messages.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId)
      )
    }))
    .sort((left, right) =>
      right.conversationUpdatedAt.localeCompare(left.conversationUpdatedAt) ||
      left.conversationId.localeCompare(right.conversationId)
    );
}

export function searchActions(groups: ChatSearchResultGroup[]): ChatSearchAction[] {
  return groups.flatMap((group) => [
    { kind: "conversation" as const, group },
    ...group.messages.map((match) => ({ kind: "message" as const, match }))
  ]);
}

export function searchActionDomId(index: number): string {
  return `chat-search-action-${index}`;
}

function SearchEmpty({ title, body, testId }: { title: string; body: string; testId?: string }): JSX.Element {
  return (
    <div className="aa-sr-empty" role="status" data-testid={testId}>
      <div className="aa-sr-empty-title">{title}</div>
      <div className="aa-sr-empty-body">{body}</div>
    </div>
  );
}

function HighlightedText({ text, ranges }: { text: string; ranges: ChatSearchHighlightRange[] }): JSX.Element {
  const valid = ranges
    .filter((range) => range.start >= 0 && range.end > range.start && range.end <= text.length)
    .sort((left, right) => left.start - right.start);
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const [index, range] of valid.entries()) {
    if (range.start < cursor) {
      continue;
    }
    if (range.start > cursor) {
      nodes.push(<Fragment key={`text-${index}`}>{text.slice(cursor, range.start)}</Fragment>);
    }
    nodes.push(<span key={`mark-${index}`} className="aa-sr-mark">{text.slice(range.start, range.end)}</span>);
    cursor = range.end;
  }
  if (cursor < text.length) {
    nodes.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>);
  }
  return <>{nodes}</>;
}

function unavailableCause(response: Extract<ChatSearchResponse, { status: "unavailable" }>): string {
  if (response.failure?.stage === "source-snapshot" || response.failure?.stage === "source-read") {
    return "A saved chat could not be read. Search stopped to avoid incomplete results.";
  }
  if (response.failure?.stage === "index-prepare" || response.failure?.stage === "index-write") {
    return "The saved-chat search index could not be prepared. No chats were searched.";
  }
  return "The saved-chat corpus was not searched.";
}

function projectLabel(repoPath: string): string {
  const segments = repoPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? repoPath;
}

function shortAuthor(author: string): string {
  const normalized = author.trim();
  if (!normalized || normalized === "You") {
    return normalized || author;
  }
  return normalized.split("-")[0]?.trim() || normalized;
}

function formatSearchTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }
  const today = new Date();
  return new Intl.DateTimeFormat(undefined, date.toDateString() === today.toDateString()
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
  ).format(date);
}
