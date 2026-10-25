import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";

type Key = VirtualItem["key"];

// The "Load older messages" row sits above everything and never moves, so it
// cannot tell whether the messages under it moved.
const NON_ANCHOR_KEYS: ReadonlySet<Key> = new Set(["load-older"]);

/**
 * How far the row at the top of the viewport moved down the content between two
 * layouts: rows added above it (an older page loaded) or measured taller than
 * estimated push it down, rows removed above it (the "Load older messages" row
 * going away) or measured shorter pull it up. Moving the scroll position by the
 * same amount keeps that row, and so the message the User is reading, exactly
 * where it was on screen.
 */
export function anchorShiftAfterRowsChange(
  previous: readonly VirtualItem[],
  next: readonly VirtualItem[],
  scrollOffset: number,
  skipKeys: ReadonlySet<Key> = NON_ANCHOR_KEYS
): number {
  if (previous.length === 0 || next.length === 0) {
    return 0;
  }
  let nextByKey: Map<Key, VirtualItem> | undefined;
  for (let index = firstItemEndingAfter(previous, scrollOffset); index < previous.length; index += 1) {
    const item = previous[index];
    if (skipKeys.has(item.key)) {
      continue;
    }
    // Usually no row was added or removed and the anchor kept its index.
    const sameIndex = next[index];
    if (sameIndex?.key === item.key) {
      return sameIndex.start - item.start;
    }
    nextByKey ??= new Map(next.map((candidate) => [candidate.key, candidate]));
    const moved = nextByKey.get(item.key);
    if (moved) {
      return moved.start - item.start;
    }
  }
  return 0;
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
 * followed stays followed while its rows are measured or new ones arrive.
 *
 * The new offset is given to the virtualizer while rendering, before the visible
 * range is computed, and written to the DOM in the layout effect of the same
 * commit, so no frame shows the old position with the new layout.
 */
export function useAnchoredVirtualItems(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  timelineRef: RefObject<HTMLDivElement>,
  isStuckToBottom: () => boolean
): VirtualItem[] {
  // The layout last committed to the DOM: what is on screen right now.
  const committedRef = useRef<readonly VirtualItem[]>([]);
  // "bottom" pins to the real end of the scroller, padding and approval slot included.
  const pendingScrollRef = useRef<number | "bottom" | undefined>();
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = keepScrollPositionOnResize;
  let items = virtualizer.getVirtualItems();
  const layout = virtualizer.measurementsCache;
  const committed = committedRef.current;
  const timeline = timelineRef.current;
  if (timeline && committed.length > 0 && layout.length > 0 && layout !== committed) {
    const scrollTop = timeline.scrollTop;
    const committedEnd = committed[committed.length - 1].end;
    const layoutEnd = layout[layout.length - 1].end;
    let target: number | undefined;
    if (isStuckToBottom()) {
      if (Math.abs(layoutEnd - committedEnd) >= 0.5) {
        // Space below the rows (padding, approval slot) is read from the DOM, which still has the committed layout.
        target = Math.max(0, layoutEnd + (timeline.scrollHeight - committedEnd) - timeline.clientHeight);
        pendingScrollRef.current = "bottom";
      }
    } else {
      // Row offsets start below the scroller's top padding.
      const listOffset = scrollTop - (Number.parseFloat(window.getComputedStyle(timeline).paddingTop) || 0);
      const shift = anchorShiftAfterRowsChange(committed, layout, listOffset);
      if (Math.abs(shift) >= 0.5) {
        target = Math.max(0, scrollTop + shift);
        pendingScrollRef.current = target;
      }
    }
    if (target !== undefined) {
      virtualizer.scrollOffset = target;
      items = virtualizer.getVirtualItems();
    }
  }
  useLayoutEffect(() => {
    committedRef.current = layout;
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = undefined;
    const element = timelineRef.current;
    if (pending !== undefined && element) {
      element.scrollTop = pending === "bottom" ? element.scrollHeight : pending;
    }
  });
  return items;
}

// The shift above replaces the virtualizer's own correction for rows that resize.
function keepScrollPositionOnResize(): boolean {
  return false;
}

/**
 * Older messages start loading this far from the top, so the next page is
 * usually in place before the User scrolls to it. Loading only at the very top
 * left her staring at "Loading older messages..." and, once at scrollTop 0, no
 * further scroll event could ask for the page after it.
 */
export function shouldLoadOlderMessages(timeline: HTMLElement): boolean {
  return timeline.scrollTop < Math.max(96, timeline.clientHeight * 1.5);
}

/**
 * Asks for the next older page when a page has just finished loading and the
 * viewport is still near the top. A scroll event cannot be relied on for that:
 * with the position anchored the User may not scroll at all, and at scrollTop 0
 * the wheel produces none. A load that added no rows (it failed) is not retried
 * here, so an error cannot turn into a request loop.
 */
export function useOlderMessagesTopUp(
  timelineRef: RefObject<HTMLDivElement>,
  props: {
    chatTimelineRows: readonly unknown[];
    hasOlderMessages: boolean;
    olderMessagesLoading: boolean;
    onLoadOlderMessages: () => void;
  },
  isStuckToBottom: () => boolean
): void {
  const rowCount = props.chatTimelineRows.length;
  const requestedAtRowCountRef = useRef<number | undefined>();
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || props.olderMessagesLoading || !props.hasOlderMessages || isStuckToBottom()) {
      return;
    }
    if (requestedAtRowCountRef.current === rowCount || !shouldLoadOlderMessages(timeline)) {
      return;
    }
    requestedAtRowCountRef.current = rowCount;
    props.onLoadOlderMessages();
  }, [rowCount, props.hasOlderMessages, props.olderMessagesLoading]);
}
