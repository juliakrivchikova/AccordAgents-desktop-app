import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";

import { LOAD_OLDER_ROW_ID } from "./chat-conversation-progress";

// Smaller layout changes than this are rounding, not movement.
const SUBPIXEL_PX = 0.5;
// How long after a click or key press inside a row a resize counts as the User's own.
const ROW_INTERACTION_MS = 1000;
// Older messages start loading within this many screens of the top.
const OLDER_PAGE_PREFETCH_SCREENS = 1.5;
const OLDER_PAGE_PREFETCH_MIN_PX = 96;

/**
 * How far the row the User is looking at moved down the content between two
 * layouts: rows added above it (an older page loaded) or measured taller than
 * estimated push it down, rows removed above it (the "Load older messages" row
 * going away) or measured shorter pull it up. Moving the scroll position by the
 * same amount keeps that row, and so the message the User is reading, exactly
 * where it was on screen.
 *
 * The anchor is the first row that starts inside the viewport, so a row only
 * peeking in at the top that gets measured grows upward, out of view, instead of
 * pushing down everything under it. With `anchorOnTopRow` (the User opened or
 * closed something herself) it is the first row visible at all, so what she
 * clicked opens downward and stays under the pointer.
 */
export function anchorShiftAfterRowsChange(
  previous: readonly VirtualItem[],
  next: readonly VirtualItem[],
  viewport: { offset: number; size: number },
  anchorOnTopRow = false
): number {
  if (previous.length === 0 || next.length === 0) {
    return 0;
  }
  const first = firstItemEndingAfter(previous, viewport.offset);
  let anchorIndex = -1;
  for (let index = first; index < previous.length; index += 1) {
    const item = previous[index];
    // The "Load older messages" row sits above everything and never moves, so it
    // cannot tell whether the messages under it moved.
    if (item.key === LOAD_OLDER_ROW_ID) {
      continue;
    }
    if (anchorIndex < 0) {
      anchorIndex = index;
    }
    if (anchorOnTopRow || item.start >= viewport.offset) {
      // A row taller than the viewport leaves nothing else starting in view.
      if (item.start < viewport.offset + viewport.size) {
        anchorIndex = index;
      }
      break;
    }
  }
  if (anchorIndex < 0) {
    return 0;
  }
  const anchor = previous[anchorIndex];
  // Usually no row was added or removed and the anchor kept its index.
  const sameIndex = next[anchorIndex];
  if (sameIndex?.key === anchor.key) {
    return sameIndex.start - anchor.start;
  }
  const moved = next.find((candidate) => candidate.key === anchor.key);
  return moved ? moved.start - anchor.start : 0;
}

function firstItemEndingAfter(items: readonly VirtualItem[], offset: number): number {
  let low = 0;
  let high = items.length - 1;
  let found = items.length;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle].end > offset) {
      found = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found;
}

/**
 * The virtual items to render, with the scroll position carried along whenever
 * the layout under the viewport changes, so what the User is reading stays put:
 *
 * - rows added or removed above it (an older page loaded, the "Load older
 *   messages" row went away) used to leave the scroll position where it was, so
 *   the view jumped to the top of the new page;
 * - a row above it measured taller or shorter than estimated was corrected by the
 *   virtualizer scrolling the DOM at once while the rows moved only on the next
 *   render, so the content jumped for a frame, and went partly blank when the row
 *   was a long message.
 *
 * At the bottom the view stays pinned to the bottom instead, so a chat that is
 * followed stays followed while its rows are measured or new ones arrive. A row
 * the User has just opened or closed herself (an activity entry, "Show more") is
 * the exception: it opens downward under the pointer, as it did before.
 *
 * The new offset is given to the virtualizer while rendering, before the visible
 * range is computed, and written to the DOM in the layout effect of the same
 * commit, so no frame shows the old position with the new layout.
 */
// Relies on @tanstack/virtual-core 3.14 reading `scrollOffset` when it computes the
// visible range and on `shouldAdjustScrollPositionOnItemSizeChange` (both public
// fields). Its scrollToOffset scrolls the DOM at once, so it is only called from the
// layout effect, after the rows have moved. chat-timeline-scroll.test.tsx drives the
// real virtualizer and fails if that changes.
export function useAnchoredVirtualItems(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  timelineRef: RefObject<HTMLDivElement>,
  isStuckToBottom: () => boolean
): VirtualItem[] {
  // The layout last committed to the DOM: what is on screen right now.
  const committedRef = useRef<readonly VirtualItem[]>([]);
  // "bottom" pins to the real end of the scroller, padding and approval slot included.
  const pendingScrollRef = useRef<number | "bottom" | undefined>();
  const lastRowInteractionAtRef = useRef(0);
  const measuredOnMountRef = useRef(new WeakSet<Element>());
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = keepScrollPositionOnResize;
  let items = virtualizer.getVirtualItems();
  const layout = virtualizer.measurementsCache;
  const committed = committedRef.current;
  const timeline = timelineRef.current;
  if (timeline && committed.length > 0 && layout.length > 0) {
    const change = layoutChange(committed, layout);
    const stuck = isStuckToBottom();
    const layoutEnd = layout[layout.length - 1].end;
    // Opened at the end of a chat that fits on screen: the DOM cannot scroll, so no
    // scroll event brings the virtualizer back from past the end, and the rows at the
    // top would never render. Checked without reading the DOM, on every render.
    const pastEnd = (virtualizer.scrollOffset ?? 0) > layoutEnd;
    if (change !== "none" || pastEnd) {
      const scrollTop = timeline.scrollTop;
      const committedEnd = committed[committed.length - 1].end;
      const toggledByUser = change === "resized" && performance.now() - lastRowInteractionAtRef.current < ROW_INTERACTION_MS;
      let target: number | undefined;
      if (pastEnd || (stuck && !toggledByUser)) {
        const bottom = Math.max(0, layoutEnd + spaceAroundRows(timeline) - timeline.clientHeight);
        if (stuck && Math.abs(layoutEnd - committedEnd) >= SUBPIXEL_PX) {
          target = bottom;
          pendingScrollRef.current = "bottom";
        } else if ((virtualizer.scrollOffset ?? 0) > bottom + SUBPIXEL_PX) {
          target = bottom;
        }
      } else if (change !== "none") {
        // Row offsets start below the scroller's top padding.
        const offset = scrollTop - (Number.parseFloat(window.getComputedStyle(timeline).paddingTop) || 0);
        const shift = anchorShiftAfterRowsChange(committed, layout, { offset, size: timeline.clientHeight }, toggledByUser);
        if (Math.abs(shift) >= SUBPIXEL_PX) {
          target = Math.max(0, scrollTop + shift);
          pendingScrollRef.current = target;
        }
      }
      if (target !== undefined) {
        virtualizer.scrollOffset = target;
        items = virtualizer.getVirtualItems();
      }
    }
  }
  useLayoutEffect(() => {
    // Rows mounted while the User scrolls are not measured by the virtualizer until a
    // ResizeObserver callback re-renders after the frame is painted, so for one frame a
    // long message overlapped the rows under it. Measuring a row once when it mounts
    // re-renders before paint; later size changes still come from the ResizeObserver.
    for (const element of virtualizer.elementsCache.values()) {
      if (!element.isConnected || measuredOnMountRef.current.has(element)) {
        continue;
      }
      measuredOnMountRef.current.add(element);
      const index = virtualizer.indexFromElement(element);
      const item = virtualizer.measurementsCache[index];
      if (item && item.key === virtualizer.options.getItemKey(index)) {
        const size = virtualizer.options.measureElement(element, undefined, virtualizer);
        if (Math.abs(size - item.size) >= 1) {
          virtualizer.resizeItem(index, size);
        }
      }
    }
  });
  useLayoutEffect(() => {
    committedRef.current = layout;
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = undefined;
    const element = timelineRef.current;
    if (pending === "bottom") {
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    } else if (pending !== undefined) {
      // Through the virtualizer, so a jump it is still steering by row index (for up to
      // five seconds) is not steered back to that index, which now holds another row.
      virtualizer.scrollToOffset(pending, { align: "start" });
    }
    if (pending !== undefined && element) {
      // The browser reports the new position with a scroll event only on the next frame.
      // Until then the virtualizer still holds the old one, and its end-of-scroll timer
      // could apply it and paint the rows of the old position: report it now.
      element.dispatchEvent(new Event("scroll"));
    }
  });
  useEffect(() => {
    const element = timelineRef.current;
    if (!element) {
      return undefined;
    }
    // A click or key press inside a row (not on the scroller itself) is what opens
    // and closes disclosures.
    const noteRowInteraction = (event: Event): void => {
      if (event.target !== element) {
        lastRowInteractionAtRef.current = performance.now();
      }
    };
    element.addEventListener("pointerdown", noteRowInteraction, true);
    element.addEventListener("keydown", noteRowInteraction, true);
    return () => {
      element.removeEventListener("pointerdown", noteRowInteraction, true);
      element.removeEventListener("keydown", noteRowInteraction, true);
    };
  }, [timelineRef]);
  return items;
}

// The scroller's own padding plus whatever it holds besides the rows (the pending
// approval slot). The rows container is its first child (chat-conversation-timeline.tsx).
function spaceAroundRows(timeline: HTMLElement): number {
  const style = window.getComputedStyle(timeline);
  let space = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  for (const child of Array.from(timeline.children).slice(1)) {
    space += (child as HTMLElement).offsetHeight;
  }
  return space;
}

// The shift above replaces the virtualizer's own correction for rows that resize.
function keepScrollPositionOnResize(): boolean {
  return false;
}

/**
 * How two layouts differ: not at all, only in row sizes (the same rows, measured
 * or resized), or in which rows there are. Compared by value because the
 * virtualizer hands out a new layout array on most renders even when nothing moved.
 */
export function layoutChange(previous: readonly VirtualItem[], next: readonly VirtualItem[]): "none" | "resized" | "rows" {
  if (previous === next) {
    return "none";
  }
  if (previous.length !== next.length) {
    return "rows";
  }
  let resized = false;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index].key !== next[index].key) {
      return "rows";
    }
    if (previous[index].size !== next[index].size) {
      resized = true;
    }
  }
  return resized ? "resized" : "none";
}

/**
 * Older messages start loading this far from the top, so the next page is
 * usually in place before the User scrolls to it. Loading only at the very top
 * left her staring at "Loading older messages..." and, once at scrollTop 0, no
 * further scroll event could ask for the page after it.
 */
export function shouldLoadOlderMessages(timeline: HTMLElement): boolean {
  return timeline.scrollTop < Math.max(OLDER_PAGE_PREFETCH_MIN_PX, timeline.clientHeight * OLDER_PAGE_PREFETCH_SCREENS);
}

/**
 * Loads the next older page when the view is near the top: after a scroll, and
 * when a page has just finished loading. A scroll event alone is not enough: with
 * the position anchored the User may not scroll at all, and at scrollTop 0 the
 * wheel produces none. Progress is counted in loaded messages, not rows, so a page
 * made only of thread replies still counts. After a load that added no messages
 * (it failed) nothing is retried automatically until the chat changes, so an
 * error cannot turn into a request on every scroll; "Load older messages" still
 * retries. Returns the check to run on scroll.
 */
export function useOlderMessagesTopUp(
  timelineRef: RefObject<HTMLDivElement>,
  state: {
    loadedMessageCount: number;
    hasOlderMessages: boolean;
    olderMessagesLoading: boolean;
    onLoadOlderMessages: () => void;
  },
  canLoad: () => boolean = () => true
): () => void {
  const requestedAtCountRef = useRef<number | undefined>();
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestOlderMessages = (): void => {
    const current = stateRef.current;
    const timeline = timelineRef.current;
    if (!timeline || current.olderMessagesLoading || !current.hasOlderMessages || !canLoad()) {
      return;
    }
    if (requestedAtCountRef.current === current.loadedMessageCount || !shouldLoadOlderMessages(timeline)) {
      return;
    }
    requestedAtCountRef.current = current.loadedMessageCount;
    current.onLoadOlderMessages();
  };
  useEffect(requestOlderMessages, [state.loadedMessageCount, state.hasOlderMessages, state.olderMessagesLoading]);
  return requestOlderMessages;
}
