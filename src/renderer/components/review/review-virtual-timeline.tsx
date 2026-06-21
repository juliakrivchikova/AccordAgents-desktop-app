import React, { useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { TimelineLoadMoreRow } from "../conversation/timeline-primitives";
import type {
  SlackTimelineRow,
  TimelineItem
} from "./review-timeline-types";

export function VirtualSlackTimeline(props: {
  header: React.ReactNode;
  items: TimelineItem[];
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  onLoadOlderMessages: () => void;
  renderItem: (item: TimelineItem) => React.ReactNode;
}): JSX.Element {
  const timelineRef = useRef<HTMLElement>(null);
  const stickToBottomRef = useRef(true);
  const previousLastRowIdRef = useRef<string | undefined>();
  const rows = useMemo<SlackTimelineRow[]>(() => {
    return props.hasOlderMessages || props.olderMessagesLoading
      ? [{ id: "load-older", type: "load-older" }, ...props.items]
      : props.items;
  }, [props.hasOlderMessages, props.items, props.olderMessagesLoading]);
  const lastRowId = rows[rows.length - 1]?.id;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => timelineRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      return row?.type === "message" ? 190 : row?.type === "load-older" ? 56 : 150;
    },
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 8,
    useFlushSync: false
  });
  const virtualItems = virtualizer.getVirtualItems();

  function scrollToBottom(): void {
    if (rows.length === 0) {
      return;
    }
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    const timeline = timelineRef.current;
    if (timeline) {
      timeline.scrollTop = timeline.scrollHeight;
    }
  }

  function scheduleScrollToBottom(): void {
    scrollToBottom();
    window.requestAnimationFrame(() => {
      scrollToBottom();
      window.requestAnimationFrame(scrollToBottom);
    });
    window.setTimeout(scrollToBottom, 80);
    window.setTimeout(scrollToBottom, 180);
  }

  function handleScroll(): void {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    stickToBottomRef.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 96;
    if (timeline.scrollTop < 96 && props.hasOlderMessages && !props.olderMessagesLoading) {
      props.onLoadOlderMessages();
    }
  }

  useLayoutEffect(() => {
    const previousLastRowId = previousLastRowIdRef.current;
    previousLastRowIdRef.current = lastRowId;
    const lastRowChanged = previousLastRowId !== lastRowId;
    if (stickToBottomRef.current || lastRowChanged) {
      scheduleScrollToBottom();
      stickToBottomRef.current = true;
    }
  }, [lastRowId, rows.length, virtualizer]);

  return (
    <section className="slack-timeline virtual-timeline" aria-label="Consensus timeline" ref={timelineRef} onScroll={handleScroll}>
      {props.header}
      <div className="virtual-timeline-inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualItems.map((virtualItem) => {
          const row = rows[virtualItem.index];
          if (!row) {
            return null;
          }
          return (
            <div
              className="virtual-timeline-item"
              data-index={virtualItem.index}
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              {row.type === "load-older" ? (
                <TimelineLoadMoreRow
                  loading={props.olderMessagesLoading}
                  disabled={!props.hasOlderMessages || props.olderMessagesLoading}
                  onClick={props.onLoadOlderMessages}
                />
              ) : (
                props.renderItem(row)
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
