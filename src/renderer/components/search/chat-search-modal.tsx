import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import type { ChatSearchMessageMatch, ChatSearchResponse } from "../../../shared/types";
import { ChatSearchResults, groupSearchMatches, searchActionDomId, searchActions } from "./chat-search-results";

export function ChatSearchModal({
  open,
  query,
  loading,
  loadingMore,
  response,
  onOpenChange,
  onQueryChange,
  onClear,
  onLoadMore,
  onOpenConversation,
  onOpenMessage
}: {
  open: boolean;
  query: string;
  loading: boolean;
  loadingMore: boolean;
  response?: ChatSearchResponse;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onClear: () => void;
  onLoadMore: () => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenMessage: (match: ChatSearchMessageMatch) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const groups = useMemo(() => groupSearchMatches(response), [response]);
  const actions = useMemo(() => searchActions(groups), [groups]);
  const searching = query.trim().length > 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeIndex >= actions.length) {
      setActiveIndex(Math.max(0, actions.length - 1));
    }
  }, [actions.length, activeIndex]);

  useEffect(() => {
    if (open && actions.length > 0) {
      document.getElementById(searchActionDomId(activeIndex))?.scrollIntoView({ block: "nearest" });
    }
  }, [actions.length, activeIndex, open]);

  const chooseActive = (): void => {
    const action = actions[activeIndex];
    if (!action) {
      return;
    }
    if (action.kind === "message") {
      onOpenMessage(action.match);
    } else {
      onOpenConversation(action.group.conversationId);
    }
    onOpenChange(false);
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" && actions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % actions.length);
    } else if (event.key === "ArrowUp" && actions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + actions.length) % actions.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      chooseActive();
    } else if (event.key === "Escape") {
      event.stopPropagation();
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="aa-searchmodal-scrim"
          data-testid="chat-search-scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              onOpenChange(false);
            }
          }}
        >
          <DialogPrimitive.Content
            className="aa-searchmodal"
            aria-label="Search chats"
            data-testid="chat-search-modal"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              window.requestAnimationFrame(() => inputRef.current?.focus());
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              document.getElementById("chat-search-trigger")?.focus();
            }}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenChange(false);
            }}
          >
            <DialogPrimitive.Title className="sr-only">Search chats</DialogPrimitive.Title>
            <div className="aa-searchmodal-field">
              <Search size={17} aria-hidden />
              <input
                ref={inputRef}
                className="aa-searchmodal-input"
                value={query}
                placeholder="Search messages and chat titles"
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={handleInputKeyDown}
                aria-label="Search chats"
                role="combobox"
                aria-expanded="true"
                aria-controls="chat-search-results"
                aria-activedescendant={actions.length > 0 ? searchActionDomId(activeIndex) : undefined}
                autoComplete="off"
              />
              {searching && (
                <button className="aa-search-clear" type="button" onClick={onClear} title="Clear search" aria-label="Clear search">
                  ×
                </button>
              )}
              <kbd className="aa-searchmodal-kbd">esc</kbd>
            </div>
            <ChatSearchResults
              query={query}
              loading={loading}
              loadingMore={loadingMore}
              response={response}
              activeIndex={activeIndex}
              onActiveIndexChange={setActiveIndex}
              onOpenConversation={(conversationId) => {
                onOpenConversation(conversationId);
                onOpenChange(false);
              }}
              onOpenMessage={(match) => {
                onOpenMessage(match);
                onOpenChange(false);
              }}
              onLoadMore={onLoadMore}
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
