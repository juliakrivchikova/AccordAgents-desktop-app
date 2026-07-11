import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";

import type { ChatMessage, Conversation, ReviewProgress } from "../../../shared/types";
import { focusRenderedMessage } from "../content/markdown-text";
import type { ChatTimelineRow } from "./chat-conversation-data";
import type { ChatMessageFocusRequest } from "./chat-conversation-types";
import { useChatFocusNavigation } from "./use-chat-focus-navigation";

type ThreadSummaryMap = Map<string, { replies: Conversation["messages"]; latestReplyAt?: string }>;

// How long a roster-jump focus keeps retrying after its page load resolves. Bounds the
// retry effect so an unreachable target (compacted/deleted message, or a thread reply whose
// root never loads) stops re-running on every timeline change for the rest of the session.
const PENDING_FOCUS_DEADLINE_MS = 5000;
const USER_SCROLL_INTENT_MS = 900;

export function useChatConversationViewport(props: {
  conversationId: string;
  messages: Conversation["messages"];
  topLevelMessages: ChatMessage[];
  threadSummaries: ThreadSummaryMap;
  selectedThreadRootId?: string;
  setSelectedThreadRootId: (messageId: string | undefined) => void;
  chatTimelineRows: ChatTimelineRow[];
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  draft: string;
  isRunning: boolean;
  pendingApprovalCount: number;
  latestMessage?: ChatMessage;
  latestProgress?: ReviewProgress;
  thinkingSignature: string;
  messageFocusRequest?: ChatMessageFocusRequest;
  onLoadOlderMessages: () => void;
  onLoadMessagePageForMessage: (messageId: string) => Promise<boolean>;
}): {
  chatVirtualItems: VirtualItem[];
  chatVirtualizer: Virtualizer<HTMLDivElement, Element>;
  dismissMessageFocus: (target?: EventTarget | null) => boolean;
  focusChatMessage: (messageId: string, threadRootId?: string) => boolean;
  isStuckToBottom: boolean;
  markUserScrollIntent: () => void;
  scrollToChatBottom: () => void;
  timelineRef: React.RefObject<HTMLDivElement>;
  updateStickToBottom: () => void;
  viewRef: React.RefObject<HTMLDivElement>;
} {
  const viewRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pendingFocusMessageIdRef = useRef<string | undefined>();
  const pendingFocusThreadRootIdRef = useRef<string | undefined>();
  const pendingFocusDeadlineRef = useRef<number>(0);
  const loadingFocusMessageIdRef = useRef<string | undefined>();
  const stickToBottomRef = useRef(true);
  const [isStuckToBottom, setIsStuckToBottom] = useState(true);
  const scrollScheduleIdRef = useRef(0);
  const handledFocusNonceRef = useRef(0);
  const userScrollIntentUntilRef = useRef(0);
  const focusAttemptGenerationRef = useRef(0);
  const chatVirtualizer = useVirtualizer({
    count: props.chatTimelineRows.length,
    getScrollElement: () => timelineRef.current,
    estimateSize: (index) => {
      const row = props.chatTimelineRows[index];
      if (row?.type === "message") {
        return 170;
      }
      if (row?.type === "approval") {
        return 220;
      }
      return 56;
    },
    getItemKey: (index) => props.chatTimelineRows[index]?.id ?? index,
    overscan: 8,
    useFlushSync: false
  });
  const chatVirtualItems = chatVirtualizer.getVirtualItems();
  const focusNavigation = useChatFocusNavigation({
    viewRef,
    renderedMessageElement,
    scrollParentForMessage,
    alignRenderedMessageToTimelineStart,
    alignRenderedMessageElementToTimelineStart,
    onHandled: (nonce) => {
      handledFocusNonceRef.current = nonce;
    }
  });

  function setStickToBottom(next: boolean): void {
    stickToBottomRef.current = next;
    setIsStuckToBottom((current) => (current === next ? current : next));
  }

  function hasRecentUserScrollIntent(): boolean {
    return Date.now() <= userScrollIntentUntilRef.current;
  }

  function clearUserScrollIntent(): void {
    userScrollIntentUntilRef.current = 0;
  }

  function markUserScrollIntent(): void {
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }

  function detachFromBottom(): void {
    setStickToBottom(false);
    scrollScheduleIdRef.current += 1;
  }

  function updateStickToBottom(): void {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const nextStickToBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 96;
    if (nextStickToBottom) {
      setStickToBottom(true);
      clearUserScrollIntent();
    } else if (hasRecentUserScrollIntent() || !stickToBottomRef.current) {
      detachFromBottom();
    }
    if (timeline.scrollTop < 96 && props.hasOlderMessages && !props.olderMessagesLoading) {
      props.onLoadOlderMessages();
    }
  }

  function scrollToChatBottom(): void {
    if (props.chatTimelineRows.length === 0) {
      return;
    }
    clearUserScrollIntent();
    chatVirtualizer.scrollToIndex(props.chatTimelineRows.length - 1, { align: "end" });
    const timeline = timelineRef.current;
    if (timeline) {
      timeline.scrollTop = timeline.scrollHeight;
    }
  }

  function scheduleScrollToChatBottom(): void {
    const scheduleId = scrollScheduleIdRef.current + 1;
    scrollScheduleIdRef.current = scheduleId;
    const scrollIfCurrent = (): void => {
      if (scrollScheduleIdRef.current === scheduleId && !hasRecentUserScrollIntent()) {
        scrollToChatBottom();
      }
    };

    scrollIfCurrent();
    window.requestAnimationFrame(() => {
      scrollIfCurrent();
      window.requestAnimationFrame(scrollIfCurrent);
    });
    window.setTimeout(scrollIfCurrent, 80);
    window.setTimeout(scrollIfCurrent, 180);
  }

  function scrollToLatest(): void {
    clearUserScrollIntent();
    setStickToBottom(true);
    scheduleScrollToChatBottom();
  }

  function matchingFocusRequest(): ChatMessageFocusRequest | undefined {
    const request = props.messageFocusRequest;
    return request && (!request.conversationId || request.conversationId === props.conversationId)
      ? request
      : undefined;
  }

  function hasUnconsumedFocusIntent(): boolean {
    const request = matchingFocusRequest();
    return Boolean(request && (request.pending || request.nonce !== handledFocusNonceRef.current));
  }

  function suppressAutoScrollForFocus(): void {
    scrollScheduleIdRef.current += 1;
    setStickToBottom(false);
  }

  function scheduleFocusRenderedMessage(messageId: string): void {
    const generation = focusAttemptGenerationRef.current;
    let focused = false;
    const focus = (): boolean => {
      if (focusAttemptGenerationRef.current !== generation) {
        // The focus was dismissed; stop retrying so the highlight is not re-applied.
        return true;
      }
      if (!focused) {
        focused = alignRenderedMessageToTimelineStart(messageId);
      }
      return focused;
    };
    window.requestAnimationFrame(() => {
      if (focus()) {
        return;
      }
      window.requestAnimationFrame(() => {
        if (focus()) {
          return;
        }
        window.setTimeout(focus, 80);
        window.setTimeout(focus, 180);
        window.setTimeout(focus, 320);
        window.setTimeout(focus, 640);
      });
    });
  }

  function renderedMessageElement(messageId: string): HTMLElement | undefined {
    return Array.from(viewRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])
      .find((candidate) => candidate.dataset.messageId === messageId);
  }

  function alignRenderedMessageToTimelineStart(messageId: string): boolean {
    if (!focusRenderedMessage(viewRef.current, messageId, { scroll: false })) {
      return false;
    }
    const message = renderedMessageElement(messageId);
    return message ? alignRenderedMessageElementToTimelineStart(message) : true;
  }

  function alignRenderedMessageElementToTimelineStart(message: HTMLElement): boolean {
    const scroller = message ? scrollParentForMessage(message) : timelineRef.current;
    if (!scroller) {
      return true;
    }
    const scrollPaddingTop = Number.parseFloat(window.getComputedStyle(scroller).scrollPaddingTop);
    const focusOffset = Number.isFinite(scrollPaddingTop) ? scrollPaddingTop : 0;
    const delta = message.getBoundingClientRect().top - scroller.getBoundingClientRect().top - focusOffset;
    if (Number.isFinite(delta) && Math.abs(delta) > 1) {
      scroller.scrollTop += delta;
    }
    return true;
  }

  function scrollParentForMessage(message: HTMLElement): HTMLElement | undefined {
    let current = message.parentElement;
    while (current && current !== viewRef.current?.parentElement) {
      const style = window.getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 2) {
        return current;
      }
      current = current.parentElement;
    }
    return timelineRef.current ?? undefined;
  }

  function scheduleScrollToRowAndFocus(messageId: string, rowIndex: number): void {
    const generation = focusAttemptGenerationRef.current;
    let focused = false;
    const attempt = (): boolean => {
      if (focused || focusAttemptGenerationRef.current !== generation) {
        return true;
      }
      detachFromBottom();
      chatVirtualizer.scrollToIndex(rowIndex, { align: "start" });
      focused = alignRenderedMessageToTimelineStart(messageId);
      return focused;
    };
    if (attempt()) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (attempt()) {
        return;
      }
      window.requestAnimationFrame(attempt);
      window.setTimeout(attempt, 80);
      window.setTimeout(attempt, 180);
      window.setTimeout(attempt, 320);
      window.setTimeout(attempt, 640);
    });
  }

  function focusLoadedChatMessage(messageId: string, threadRootId?: string): boolean {
    const rowIndex = props.chatTimelineRows.findIndex((row) => row.type === "message" && row.message.id === messageId);
    if (rowIndex >= 0) {
      scheduleScrollToRowAndFocus(messageId, rowIndex);
      return true;
    }

    for (const [rootId, summary] of props.threadSummaries) {
      if ((threadRootId && rootId !== threadRootId) || !summary.replies.some((reply) => reply.id === messageId)) {
        continue;
      }
      // The reply renders only inside its thread panel, which opens only when the root is a
      // loaded top-level message. If the root is paginated out of the window, selecting it
      // is immediately reverted (see the selectedThreadRootId guard effect), so the panel
      // never opens and the flash never lands. Report failure here so the caller pages the
      // root in first; loadConversationMessagePageForMessage extends the window contiguously,
      // so the reply stays loaded once the root arrives and the retry effect opens the thread.
      if (!props.topLevelMessages.some((message) => message.id === rootId)) {
        return false;
      }
      detachFromBottom();
      props.setSelectedThreadRootId(rootId);
      scheduleFocusRenderedMessage(messageId);
      return true;
    }

    return false;
  }

  async function loadAndFocusMessage(messageId: string, threadRootId?: string): Promise<void> {
    const loadKey = `${threadRootId ?? ""}:${messageId}`;
    if (loadingFocusMessageIdRef.current === loadKey) {
      return;
    }
    loadingFocusMessageIdRef.current = loadKey;
    pendingFocusMessageIdRef.current = messageId;
    pendingFocusThreadRootIdRef.current = threadRootId;
    // Bound the retry even if the load below throws or never resolves.
    pendingFocusDeadlineRef.current = Date.now() + PENDING_FOCUS_DEADLINE_MS;
    try {
      const isLoaded = (id: string): boolean => props.messages.some((message) => message.id === id);
      const loaded = threadRootId && !isLoaded(threadRootId)
        ? await props.onLoadMessagePageForMessage(threadRootId)
        : !isLoaded(messageId)
          ? await props.onLoadMessagePageForMessage(messageId)
          : true;
      if (loaded) {
        // Restart the clock now that paging is done, giving the focus/thread-open retry a
        // full window regardless of how long the load itself took.
        pendingFocusDeadlineRef.current = Date.now() + PENDING_FOCUS_DEADLINE_MS;
        detachFromBottom();
        scheduleFocusRenderedMessage(messageId);
        return;
      }
      if (pendingFocusMessageIdRef.current === messageId) {
        pendingFocusMessageIdRef.current = undefined;
        pendingFocusThreadRootIdRef.current = undefined;
        pendingFocusDeadlineRef.current = 0;
      }
    } finally {
      if (loadingFocusMessageIdRef.current === loadKey) {
        loadingFocusMessageIdRef.current = undefined;
      }
    }
  }

  function focusChatMessage(messageId: string, threadRootId?: string): boolean {
    if (focusLoadedChatMessage(messageId, threadRootId)) {
      return true;
    }
    if (props.hasOlderMessages && !props.olderMessagesLoading) {
      void loadAndFocusMessage(messageId, threadRootId);
      return true;
    }
    return false;
  }

  function dismissMessageFocus(target?: EventTarget | null): boolean {
    const view = viewRef.current;
    const focused = view?.querySelector<HTMLElement>(".message-focused");
    if (!view || !focused) {
      return false;
    }
    if (target instanceof Node && focused.contains(target)) {
      return false;
    }
    // Invalidate in-flight focus retries so none re-applies the highlight, stop the
    // reveal loop, and record the request as handled so auto-scroll suppression ends.
    focusAttemptGenerationRef.current += 1;
    pendingFocusMessageIdRef.current = undefined;
    pendingFocusThreadRootIdRef.current = undefined;
    pendingFocusDeadlineRef.current = 0;
    focusNavigation.cancel();
    const request = matchingFocusRequest();
    if (request) {
      handledFocusNonceRef.current = request.nonce;
    }
    view.querySelectorAll<HTMLElement>(".message-focused").forEach((element) => {
      element.classList.remove("message-focused", "message-flash");
    });
    return true;
  }

  useEffect(() => {
    pendingFocusMessageIdRef.current = undefined;
    pendingFocusThreadRootIdRef.current = undefined;
    pendingFocusDeadlineRef.current = 0;
    loadingFocusMessageIdRef.current = undefined;
    clearUserScrollIntent();
    if (hasUnconsumedFocusIntent()) {
      suppressAutoScrollForFocus();
    } else {
      setStickToBottom(true);
    }
  }, [props.conversationId]);

  useEffect(() => {
    const pendingMessageId = pendingFocusMessageIdRef.current;
    if (!pendingMessageId) {
      return;
    }
    if (focusLoadedChatMessage(pendingMessageId, pendingFocusThreadRootIdRef.current)) {
      pendingFocusMessageIdRef.current = undefined;
      pendingFocusThreadRootIdRef.current = undefined;
      pendingFocusDeadlineRef.current = 0;
      return;
    }
    // Unreachable target: give up once the deadline passes so this effect stops re-running
    // on every timeline change for the rest of the session. The next change after the
    // deadline clears it (the effect is change-driven, so there is no wasted timer tick).
    if (pendingFocusDeadlineRef.current && Date.now() > pendingFocusDeadlineRef.current) {
      pendingFocusMessageIdRef.current = undefined;
      pendingFocusThreadRootIdRef.current = undefined;
      pendingFocusDeadlineRef.current = 0;
    }
  }, [props.chatTimelineRows, props.selectedThreadRootId, props.threadSummaries]);

  useEffect(() => {
    const request = matchingFocusRequest();
    if (!request || request.pending || !request.messageId) {
      return;
    }
    if (focusChatMessage(request.messageId, request.threadRootId)) {
      focusNavigation.revealWhenStable(request.messageId, request.nonce);
    }
  }, [props.messageFocusRequest?.nonce, props.messageFocusRequest?.pending]);

  useLayoutEffect(() => {
    if (hasUnconsumedFocusIntent()) {
      suppressAutoScrollForFocus();
      return;
    }
    const timeline = timelineRef.current;
    if (!timeline || !stickToBottomRef.current) {
      return;
    }
    scheduleScrollToChatBottom();
    setStickToBottom(true);
  }, [
    props.topLevelMessages.length,
    props.latestMessage?.content,
    props.latestMessage?.status,
    props.latestProgress?.message,
    props.latestProgress?.agentProgress?.partialContent,
    props.latestProgress?.agentProgress?.activity,
    props.latestProgress?.agentProgress?.activityEvents?.length,
    props.thinkingSignature,
    props.draft,
    props.isRunning,
    props.pendingApprovalCount,
    props.chatTimelineRows.length,
    chatVirtualizer
  ]);

  useLayoutEffect(() => {
    if (hasUnconsumedFocusIntent()) {
      focusNavigation.begin();
      suppressAutoScrollForFocus();
      return;
    }
    focusNavigation.cancel();
    setStickToBottom(true);
    scheduleScrollToChatBottom();
  }, [props.conversationId, props.messageFocusRequest?.nonce, props.messageFocusRequest?.pending]);

  return {
    chatVirtualItems,
    chatVirtualizer,
    dismissMessageFocus,
    focusChatMessage,
    isStuckToBottom,
    markUserScrollIntent,
    scrollToChatBottom: scrollToLatest,
    timelineRef,
    updateStickToBottom,
    viewRef
  };
}
