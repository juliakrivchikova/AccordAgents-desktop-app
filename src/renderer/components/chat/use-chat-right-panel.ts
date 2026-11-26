import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  CHAT_SIDE_PANEL_MIN_WIDTH,
  CHAT_THREAD_DEFAULT_WIDTH,
  chatMainMinWidth,
  chatSidePanelWidthLimits,
  clampChatSidePanelWidth
} from "../../lib/chat-split-sizing";

/**
 * What the chat's right panel shows besides artifacts and files: a thread
 * (the classic view), or in the sessions view the members list, one
 * member's whole session or an Accord (docs/main-session.md).
 */
export type ChatRightPanel =
  | { kind: "thread"; rootId: string }
  /** addAgent: opened from the Accord button to add an agent (its Agents
   *  list's Add open), a new number for each time. */
  | { kind: "members"; addAgent?: number }
  | { kind: "member"; participantId: string; focus?: { messageId: string; nonce: number } }
  | { kind: "accord"; launchId: string };

export interface ChatRightPanelState {
  panel?: ChatRightPanel;
  selectedThreadRootId?: string;
  selectThread: (rootId: string | undefined) => void;
  openMembers: () => void;
  /** The members list with its Agents list's Add open (Accord needs one more). */
  openAgentsToAdd: () => void;
  /** Opens a member's session, at a message of it when one is named. */
  openMember: (participantId: string, focusMessageId?: string) => void;
  openAccord: (launchId: string) => void;
  close: () => void;
  /** A member panel's composer draft, per member. */
  memberDrafts: Readonly<Record<string, string>>;
  setMemberDraft: (participantId: string, value: string) => void;
  reset: () => void;
}

export function useChatRightPanel(): ChatRightPanelState {
  const [panel, setPanel] = useState<ChatRightPanel | undefined>();
  const [memberDrafts, setMemberDrafts] = useState<Record<string, string>>({});
  const selectThread = useCallback((rootId: string | undefined) => {
    setPanel(rootId ? { kind: "thread", rootId } : undefined);
  }, []);
  const openMembers = useCallback(() => setPanel({ kind: "members" }), []);
  const focusNonce = useRef(0);
  const openAgentsToAdd = useCallback(() => {
    focusNonce.current += 1;
    setPanel({ kind: "members", addAgent: focusNonce.current });
  }, []);
  const openMember = useCallback((participantId: string, focusMessageId?: string) => {
    focusNonce.current += 1;
    setPanel({ kind: "member", participantId, ...(focusMessageId ? { focus: { messageId: focusMessageId, nonce: focusNonce.current } } : {}) });
  }, []);
  const openAccord = useCallback((launchId: string) => setPanel({ kind: "accord", launchId }), []);
  const close = useCallback(() => setPanel(undefined), []);
  const setMemberDraft = useCallback((participantId: string, value: string) => {
    setMemberDrafts((current) => ({ ...current, [participantId]: value }));
  }, []);
  const reset = useCallback(() => {
    setPanel(undefined);
    setMemberDrafts({});
  }, []);
  return {
    panel,
    selectedThreadRootId: panel?.kind === "thread" ? panel.rootId : undefined,
    selectThread,
    openMembers,
    openAgentsToAdd,
    openMember,
    openAccord,
    close,
    memberDrafts,
    setMemberDraft,
    reset
  };
}

/** The right panel's width: dragged by the User, clamped to the room the
 *  chat has while a panel is shown. */
export function useChatRightPanelWidth(root: () => HTMLElement | null, shown: boolean): {
  width: number;
  isResizing: boolean;
  startResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
} {
  const [width, setWidth] = useState(CHAT_THREAD_DEFAULT_WIDTH);
  // The width the User dragged to; shown clamped, so it returns with the room.
  const requestedWidthRef = useRef(CHAT_THREAD_DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const view = root();
    if (!view) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
    const rect = view.getBoundingClientRect();
    const limits = chatSidePanelWidthLimits(rect.width, {
      reserveWidth: 1,
      minWidth: CHAT_SIDE_PANEL_MIN_WIDTH,
      mainMinWidth: chatMainMinWidth(view)
    });
    const move = (moveEvent: PointerEvent): void => {
      requestedWidthRef.current = clampChatSidePanelWidth(Math.round(rect.right - moveEvent.clientX), limits);
      setWidth(requestedWidthRef.current);
    };
    const stop = (): void => {
      setIsResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  useLayoutEffect(() => {
    const view = root();
    if (!view || !shown) {
      return undefined;
    }
    const clampCurrentWidth = (): void => {
      const limits = chatSidePanelWidthLimits(view.getBoundingClientRect().width, {
        reserveWidth: 1,
        minWidth: CHAT_SIDE_PANEL_MIN_WIDTH,
        mainMinWidth: chatMainMinWidth(view)
      });
      setWidth(clampChatSidePanelWidth(requestedWidthRef.current, limits));
    };
    clampCurrentWidth();
    const resizeObserver = new ResizeObserver(clampCurrentWidth);
    resizeObserver.observe(view);
    window.addEventListener("resize", clampCurrentWidth);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", clampCurrentWidth);
    };
  }, [root, shown]);

  return { width, isResizing, startResize };
}
