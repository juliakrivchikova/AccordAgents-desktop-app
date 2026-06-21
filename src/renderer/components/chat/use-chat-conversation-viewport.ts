import { useEffect, useLayoutEffect, useRef } from "react";
import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";

import type { ChatMessage, Conversation, ReviewProgress } from "../../../shared/types";
import { focusRenderedMessage } from "../content/markdown-text";
import type { ChatTimelineRow } from "./chat-conversation-data";
import type { ChatMessageFocusRequest } from "./chat-conversation-types";

type ThreadSummaryMap = Map<string, { replies: Conversation["messages"]; latestReplyAt?: string }>;

// How long a roster-jump focus keeps retrying after its page load resolves. Bounds the
// retry effect so an unreachable target (compacted/deleted message, or a thread reply whose
// root never loads) stops re-running on every timeline change for the rest of the session.
const PENDING_FOCUS_DEADLINE_MS = 5000;

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
  focusChatMessage: (messageId: string, threadRootId?: string) => boolean;
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
  const forceStickToBottomRef = useRef(false);
  const previousMessageCountRef = useRef(props.topLevelMessages.length);
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

  function updateStickToBottom(): void {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    stickToBottomRef.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 96;
    if (timeline.scrollTop < 96 && props.hasOlderMessages && !props.olderMessagesLoading) {
      props.onLoadOlderMessages();
    }
  }

  function scrollToChatBottom(): void {
    if (props.chatTimelineRows.length === 0) {
      return;
    }
    chatVirtualizer.scrollToIndex(props.chatTimelineRows.length - 1, { align: "end" });
    const timeline = timelineRef.current;
    if (timeline) {
      timeline.scrollTop = timeline.scrollHeight;
    }
  }

  function scheduleScrollToChatBottom(): void {
    scrollToChatBottom();
    window.requestAnimationFrame(() => {
      scrollToChatBottom();
      window.requestAnimationFrame(scrollToChatBottom);
    });
    window.setTimeout(scrollToChatBottom, 80);
    window.setTimeout(scrollToChatBottom, 180);
  }

  function scheduleFocusRenderedMessage(messageId: string): void {
    const focus = (): boolean => focusRenderedMessage(viewRef.current, messageId);
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
      });
    });
  }

  function scheduleScrollToRowAndFocus(messageId: string, rowIndex: number): void {
    const attempt = (): boolean => {
      if (focusRenderedMessage(viewRef.current, messageId)) {
        return true;
      }
      chatVirtualizer.scrollToIndex(rowIndex, { align: "center" });
      return false;
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
    });
  }

  function focusLoadedChatMessage(messageId: string, threadRootId?: string): boolean {
    if (focusRenderedMessage(viewRef.current, messageId)) {
      return true;
    }

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

  useEffect(() => {
    pendingFocusMessageIdRef.current = undefined;
    pendingFocusThreadRootIdRef.current = undefined;
    pendingFocusDeadlineRef.current = 0;
    loadingFocusMessageIdRef.current = undefined;
    stickToBottomRef.current = true;
    forceStickToBottomRef.current = true;
    scheduleScrollToChatBottom();
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
    const request = props.messageFocusRequest;
    if (!request) {
      return;
    }
    focusChatMessage(request.messageId, request.threadRootId);
  }, [props.messageFocusRequest?.nonce]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const messageCountChanged = previousMessageCountRef.current !== props.topLevelMessages.length;
    previousMessageCountRef.current = props.topLevelMessages.length;
    const shouldFollowBottom = stickToBottomRef.current || forceStickToBottomRef.current || messageCountChanged;
    if (!timeline || !shouldFollowBottom) {
      return;
    }
    scheduleScrollToChatBottom();
    stickToBottomRef.current = true;
    if (messageCountChanged) {
      forceStickToBottomRef.current = false;
    }
  }, [
    props.topLevelMessages.length,
    props.latestMessage?.content,
    props.latestMessage?.status,
    props.latestProgress?.message,
    props.thinkingSignature,
    props.draft,
    props.isRunning,
    props.pendingApprovalCount,
    props.chatTimelineRows.length,
    chatVirtualizer
  ]);

  useLayoutEffect(() => {
    scheduleScrollToChatBottom();
    stickToBottomRef.current = true;
  }, [props.conversationId]);

  return {
    chatVirtualItems,
    chatVirtualizer,
    focusChatMessage,
    timelineRef,
    updateStickToBottom,
    viewRef
  };
}
