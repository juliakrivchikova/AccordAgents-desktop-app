import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type {
  ChatSearchMatch,
  ChatSearchMessageMatch,
  ChatSearchResponse,
  ChatSearchTitleMatch,
  Conversation
} from "../../../shared/types";
import type { AppState } from "../../app/app-state";
import { focusConversationMessage } from "../../app/focus-conversation-message";
import { useChatSearch, type ChatSearchState } from "../../app/use-chat-search";
import {
  ChatSearchResults,
  groupSearchMatches,
  searchActions
} from "../search/chat-search-results";

test("modal results group newest chats first, messages chronologically, and keep title-only chats actionable", () => {
  const response = okResponse([
    messageMatch("chat-a", "m-late", "2026-01-02T00:00:02.000Z", "2026-01-03T00:00:00.000Z"),
    titleMatch("chat-b", "2026-01-04T00:00:00.000Z"),
    messageMatch("chat-a", "m-early", "2026-01-02T00:00:01.000Z", "2026-01-03T00:00:00.000Z")
  ], false, undefined, 2, 2);
  const groups = groupSearchMatches(response);
  assert.deepEqual(groups.map((group) => ({
    id: group.conversationId,
    titleMatch: Boolean(group.titleMatch),
    messages: group.messages.map((item) => item.messageId)
  })), [
    { id: "chat-b", titleMatch: true, messages: [] },
    { id: "chat-a", titleMatch: false, messages: ["m-early", "m-late"] }
  ]);
  assert.deepEqual(searchActions(groups).map((action) =>
    action.kind === "message" ? action.match.messageId : action.group.conversationId
  ), ["chat-b", "chat-a", "m-early", "m-late"]);

  const openedChats: string[] = [];
  const openedMessages: string[] = [];
  const renderer = create(
    <ChatSearchResults
      query="needle"
      loading={false}
      loadingMore={false}
      response={response}
      activeIndex={0}
      onActiveIndexChange={() => undefined}
      onOpenConversation={(id) => openedChats.push(id)}
      onOpenMessage={(match) => openedMessages.push(match.messageId)}
      onLoadMore={() => undefined}
    />
  );
  const chatOptions = renderer.root.findAllByProps({ "data-testid": "chat-search-chat-result" });
  assert.equal(chatOptions[0].findByProps({ className: "aa-sr-chip" }).children.join(""), "title");
  chatOptions[0].props.onClick();
  renderer.root.findAllByProps({ "data-testid": "chat-search-message-result" })[1].props.onClick();
  assert.deepEqual(openedChats, ["chat-b"]);
  assert.deepEqual(openedMessages, ["m-late"]);
});

test("modal renders exact idle and empty copy, query-wide counters, and no coverage metadata", () => {
  const idle = create(
    <ChatSearchResults
      query=""
      loading={false}
      loadingMore={false}
      activeIndex={0}
      onActiveIndexChange={() => undefined}
      onOpenConversation={() => undefined}
      onOpenMessage={() => undefined}
      onLoadMore={() => undefined}
    />
  );
  assert.match(textContent(idle), /Search across every chat/);
  assert.match(textContent(idle), /Results group by chat, newest first/);

  const empty = create(
    <ChatSearchResults
      query="absent"
      loading={false}
      loadingMore={false}
      response={okResponse([], false, undefined, 0, 0)}
      activeIndex={0}
      onActiveIndexChange={() => undefined}
      onOpenConversation={() => undefined}
      onOpenMessage={() => undefined}
      onLoadMore={() => undefined}
    />
  );
  assert.match(textContent(empty), /Nothing matched/);
  assert.match(textContent(empty), /No message or chat title contains “absent”/);

  const results = create(
    <ChatSearchResults
      query="needle"
      loading={false}
      loadingMore={false}
      response={okResponse([messageMatch("chat-a", "m1")], false, undefined, 14, 3)}
      activeIndex={0}
      onActiveIndexChange={() => undefined}
      onOpenConversation={() => undefined}
      onOpenMessage={() => undefined}
      onLoadMore={() => undefined}
    />
  );
  assert.match(textContent(results), /14\s+results\s+in\s+3\s+chats/);
  assert.equal(results.root.findAllByProps({ "data-testid": "chat-search-coverage" }).length, 0);
});

test("modal keeps the idle body while the first query is pending", () => {
  const renderer = create(
    <ChatSearchResults
      query="needle"
      loading={true}
      loadingMore={false}
      activeIndex={0}
      onActiveIndexChange={() => undefined}
      onOpenConversation={() => undefined}
      onOpenMessage={() => undefined}
      onLoadMore={() => undefined}
    />
  );
  const body = renderer.root.findByProps({ id: "chat-search-results" });
  assert.equal(body.props["aria-busy"], "true");
  assert.match(textContent(renderer), /Search across every chat/);
  assert.match(textContent(renderer), /Results group by chat, newest first/);
});

test("modal explains canonical corruption without exposing content or rendering coverage", () => {
  const response: ChatSearchResponse = {
    status: "unavailable",
    matches: [],
    coverage: {
      eligibleChatCount: 3,
      searchedChatCount: 0,
      messagePeriod: null,
      sourceSnapshotAt: "2026-01-01T00:00:00.000Z",
      completeness: "none"
    },
    errorCode: "search-unavailable",
    failure: { stage: "source-read", conversationId: "chat-b" }
  };
  const renderer = create(
    <ChatSearchResults
      query="needle"
      loading={false}
      loadingMore={false}
      response={response}
      activeIndex={0}
      onActiveIndexChange={() => undefined}
      onOpenConversation={() => undefined}
      onOpenMessage={() => undefined}
      onLoadMore={() => undefined}
    />
  );
  assert.match(textContent(renderer), /A saved chat could not be read/i);
  assert.match(textContent(renderer), /stopped to avoid incomplete results/i);
  assert.doesNotMatch(textContent(renderer), /chat-b/i);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "chat-search-coverage" }).length, 0);
});

test("modal applies the exact handoff author labels", () => {
  const participantWithSegments: ChatSearchMessageMatch = {
    ...messageMatch("chat-a", "participant-segments"),
    role: "participant",
    authorLabel: "@alex-codex-qa-lead"
  };
  const participantWithoutSegment: ChatSearchMessageMatch = {
    ...messageMatch("chat-a", "participant-single"),
    role: "participant",
    authorLabel: "Participant"
  };
  const renderer = create(
    <ChatSearchResults
      query="needle"
      loading={false}
      loadingMore={false}
      response={okResponse([
        messageMatch("chat-a", "user"),
        participantWithSegments,
        participantWithoutSegment
      ], false)}
      activeIndex={0}
      onActiveIndexChange={() => undefined}
      onOpenConversation={() => undefined}
      onOpenMessage={() => undefined}
      onLoadMore={() => undefined}
    />
  );
  assert.deepEqual(
    renderer.root.findAllByProps({ className: "aa-sr-author" }).map((node) => node.children.join("")).sort(),
    ["You: ", "@alex: ", "Participant: "].sort()
  );
});

test("chat search hook scopes to the user, ignores late replies, deduplicates titles, and merges pagination", async () => {
  const pending = new Map<string, (response: ChatSearchResponse) => void>();
  const requests: Array<{ query: string; cursor?: string }> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      consensus: {
        searchChats: (request: { requester: { kind: string }; query: string; cursor?: string }) => {
          assert.deepEqual(request.requester, { kind: "user" });
          requests.push({ query: request.query, ...(request.cursor ? { cursor: request.cursor } : {}) });
          return new Promise<ChatSearchResponse>((resolve) => pending.set(request.cursor ?? request.query, resolve));
        }
      }
    }
  });
  let state: ChatSearchState;
  function Harness(): null {
    state = useChatSearch(true);
    return null;
  }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => {
    state!.setQuery("first");
    await wait(210);
  });
  await act(async () => {
    state!.setQuery("second");
    await wait(210);
  });
  await act(async () => {
    pending.get("second")?.(okResponse([
      titleMatch("chat-a"),
      messageMatch("chat-a", "second")
    ], true, "page-2", 2, 2));
    await wait(0);
  });
  await act(async () => {
    pending.get("first")?.(okResponse([messageMatch("chat-a", "late")], false));
    await wait(0);
  });
  assert.deepEqual(matchKeys(state!.response), ["title:chat-a", "message:second"]);
  await act(async () => {
    state!.loadMore();
    await wait(0);
    pending.get("page-2")?.(okResponse([
      titleMatch("chat-a"),
      messageMatch("chat-a", "second"),
      messageMatch("chat-b", "third")
    ], false, undefined, 2, 2));
    await wait(0);
  });
  assert.deepEqual(matchKeys(state!.response), ["title:chat-a", "message:second", "message:third"]);
  assert.deepEqual(requests.map((request) => request.cursor ?? request.query), ["first", "second", "page-2"]);
  renderer!.unmount();
});

test("search focus uses shared orchestration for old/thread targets and reports deleted targets", async () => {
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: () => void) => { callback(); return 1; }
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout }
  });
  const errors: Array<string | undefined> = [];
  let focusRequest: unknown;
  const state = {
    chatMessageFocusNonceRef: { current: 0 },
    openConversationRequestRef: { current: 0 },
    setError: (error: string | undefined) => errors.push(error),
    setChatMessageFocusRequest: (value: unknown) => {
      focusRequest = typeof value === "function" ? (value as (current: unknown) => unknown)(focusRequest) : value;
    }
  } as unknown as AppState;
  const target = { conversationId: "focus-chat", messageId: "old-reply", threadRootId: "thread-root" };
  const loadedTargets: string[] = [];
  await focusConversationMessage({
    state,
    target,
    openConversation: async () => focusConversation("focus-chat"),
    ensureTargetMessagesLoaded: async (_conversation, messageId, threadRootId) => {
      loadedTargets.push(messageId, threadRootId ?? "");
      return true;
    }
  });
  assert.deepEqual(loadedTargets, ["old-reply", "thread-root"]);
  assert.deepEqual(focusRequest, { ...target, nonce: 1 });

  await focusConversationMessage({
    state,
    target: { conversationId: "deleted", messageId: "gone" },
    openConversation: async () => undefined,
    ensureTargetMessagesLoaded: async () => true
  });
  assert.equal(errors.at(-1), "The selected search result is no longer available.");
});

function okResponse(
  matches: ChatSearchMatch[],
  hasMore: boolean,
  nextCursor?: string,
  messageMatchCount = matches.filter((match) => match.kind === "message").length,
  matchedChatCount = new Set(matches.map((match) => match.conversationId)).size
): ChatSearchResponse {
  return {
    status: "ok",
    matches,
    coverage: {
      eligibleChatCount: 2,
      searchedChatCount: 2,
      messagePeriod: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
      sourceSnapshotAt: "2026-01-02T00:00:01.000Z",
      indexedAt: "2026-01-02T00:00:01.000Z",
      completeness: "complete"
    },
    messageMatchCount,
    matchedChatCount,
    hasMore,
    ...(nextCursor ? { nextCursor } : {})
  };
}

function messageMatch(
  conversationId: string,
  messageId: string,
  createdAt = "2026-01-01T00:00:00.000Z",
  conversationUpdatedAt = "2026-01-02T00:00:00.000Z"
): ChatSearchMessageMatch {
  return {
    kind: "message",
    conversationId,
    conversationTitle: `Chat ${conversationId}`,
    conversationUpdatedAt,
    repoPath: `/repo/${conversationId}`,
    archived: false,
    messageId,
    role: "user",
    authorLabel: "You",
    createdAt,
    snippetText: `Snippet ${messageId}`,
    highlightRanges: [],
    rank: 0
  };
}

function titleMatch(
  conversationId: string,
  conversationUpdatedAt = "2026-01-02T00:00:00.000Z"
): ChatSearchTitleMatch {
  return {
    kind: "title",
    conversationId,
    conversationTitle: `Chat ${conversationId}`,
    conversationUpdatedAt,
    repoPath: `/repo/${conversationId}`,
    archived: false,
    titleText: `Chat ${conversationId}`,
    highlightRanges: [],
    rank: 0
  };
}

function matchKeys(response: ChatSearchResponse | undefined): string[] {
  return response?.status === "ok"
    ? response.matches.map((match) => match.kind === "title" ? `title:${match.conversationId}` : `message:${match.messageId}`)
    : [];
}

function textContent(renderer: ReactTestRenderer): string {
  return renderer.root.findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children)
    .filter((child): child is string => typeof child === "string")
    .join(" ");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function focusConversation(id: string): Conversation {
  return {
    id,
    title: "Focus",
    kind: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    findings: [],
    metadata: {}
  };
}
