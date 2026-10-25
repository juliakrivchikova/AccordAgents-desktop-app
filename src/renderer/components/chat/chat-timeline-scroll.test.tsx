import assert from "node:assert/strict";
import test from "node:test";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";

import type { ChatAppToolApproval, ChatMessage } from "../../../shared/types";
import { chatTimelineRows } from "./chat-conversation-progress";
import { anchorShiftAfterRowsChange, useAnchoredVirtualItems, useOlderMessagesTopUp } from "./chat-timeline-scroll";

function layout(rows: Array<[string, number]>): VirtualItem[] {
  let start = 0;
  return rows.map(([key, size], index) => {
    const item = { key, index, start, size, end: start + size, lane: 0 };
    start += size;
    return item;
  });
}

test("an older page loaded above the viewport moves the view down by exactly its height", () => {
  const before = layout([["load-older", 56], ["m10", 200], ["m11", 300], ["m12", 100]]);
  const after = layout([["load-older", 56], ["m7", 120], ["m8", 80], ["m9", 400], ["m10", 200], ["m11", 300], ["m12", 100]]);
  // m11 is at the top of the viewport.
  assert.equal(anchorShiftAfterRowsChange(before, after, 300), 600);
});

test("the load-older row going away pulls the view up by its height", () => {
  const before = layout([["load-older", 56], ["m0", 200], ["m1", 300]]);
  const after = layout([["m0", 200], ["m1", 300]]);
  assert.equal(anchorShiftAfterRowsChange(before, after, 300), -56);
});

test("a row above the viewport measured taller moves the view by the difference, a row below does not", () => {
  const before = layout([["m0", 170], ["m1", 170], ["m2", 170], ["m3", 170]]);
  const tallerAbove = layout([["m0", 2071], ["m1", 170], ["m2", 170], ["m3", 170]]);
  const tallerBelow = layout([["m0", 170], ["m1", 170], ["m2", 170], ["m3", 900]]);
  assert.equal(anchorShiftAfterRowsChange(before, tallerAbove, 200), 1901);
  assert.equal(anchorShiftAfterRowsChange(before, tallerBelow, 200), 0);
});

test("the load-older row is never the anchor, even at the very top", () => {
  const before = layout([["load-older", 56], ["m10", 200]]);
  const after = layout([["load-older", 56], ["m9", 150], ["m10", 200]]);
  assert.equal(anchorShiftAfterRowsChange(before, after, 0), 150);
});

function message(id: string, createdAt: string): ChatMessage {
  return { id, role: "participant", content: id, createdAt } as ChatMessage;
}

function approval(id: string, createdAt: string): ChatAppToolApproval {
  return { id, createdAt, status: "approved", toolName: "codex_auto_review_approval" } as ChatAppToolApproval;
}

test("resolved approvals older than the loaded messages wait for their page", () => {
  const messages = [message("m1", "2026-09-15T10:00:00.000Z"), message("m2", "2026-09-15T11:00:00.000Z")];
  const approvals = [approval("old", "2026-09-10T00:00:00.000Z"), approval("inside", "2026-09-15T10:30:00.000Z")];
  const windowed = chatTimelineRows({
    hasOlderMessages: true,
    olderMessagesLoading: false,
    isRunning: false,
    loadedMessages: messages,
    topLevelMessages: messages,
    resolvedApprovals: approvals,
    thinkingRows: []
  });
  assert.deepEqual(windowed.map((row) => row.id), ["load-older", "m1", "inside", "m2"]);

  const complete = chatTimelineRows({
    hasOlderMessages: false,
    olderMessagesLoading: false,
    isRunning: false,
    loadedMessages: messages,
    topLevelMessages: messages,
    resolvedApprovals: approvals,
    thinkingRows: []
  });
  assert.deepEqual(complete.map((row) => row.id), ["old", "m1", "inside", "m2"]);
});

// A scroller jsdom can lay out: fixed viewport, content height from the virtualizer.
function installScroller(node: HTMLDivElement, viewport: number, contentHeight: () => number): void {
  Object.defineProperty(node, "offsetHeight", { configurable: true, get: () => viewport });
  Object.defineProperty(node, "offsetWidth", { configurable: true, get: () => 600 });
  Object.defineProperty(node, "clientHeight", { configurable: true, get: () => viewport });
  Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => Math.max(viewport, contentHeight()) });
  node.scrollTo = ((options: ScrollToOptions) => {
    node.scrollTop = options.top ?? node.scrollTop;
  }) as typeof node.scrollTo;
}

type Row = { id: string; size: number };

function Harness(props: { rows: Row[]; stuck: boolean; onItems: (items: VirtualItem[]) => void }): JSX.Element {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const totalRef = useRef(0);
  const virtualizer = useVirtualizer({
    count: props.rows.length,
    getScrollElement: () => timelineRef.current,
    estimateSize: (index) => props.rows[index]?.size ?? 100,
    getItemKey: (index) => props.rows[index]?.id ?? index,
    overscan: 1,
    useFlushSync: false
  });
  const items = useAnchoredVirtualItems(virtualizer, timelineRef, () => props.stuck);
  totalRef.current = virtualizer.getTotalSize();
  props.onItems(items);
  return (
    <div
      data-testid="timeline"
      ref={(node) => {
        if (node && timelineRef.current !== node) {
          installScroller(node, 300, () => totalRef.current);
        }
        timelineRef.current = node;
      }}
    />
  );
}

function rows(from: number, to: number, size: number): Row[] {
  return Array.from({ length: to - from }, (_, offset) => ({ id: `m${from + offset}`, size }));
}

test("loading an older page keeps the message on screen in place, in the same commit", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let items: VirtualItem[] = [];
  const timeline = (): HTMLDivElement => host.querySelector("[data-testid=timeline]") as HTMLDivElement;
  try {
    await act(async () => { root.render(<Harness rows={rows(10, 30, 100)} stuck={false} onItems={(next) => { items = next; }} />); });
    // Scrolled up so that m15 is at the top of the viewport.
    await act(async () => {
      timeline().scrollTop = 500;
      timeline().dispatchEvent(new window.Event("scroll"));
    });
    assert.equal(items.find((item) => item.key === "m15")?.start, 500);

    await act(async () => { root.render(<Harness rows={[...rows(0, 10, 50), ...rows(10, 30, 100)]} stuck={false} onItems={(next) => { items = next; }} />); });

    assert.equal(timeline().scrollTop, 1000);
    const m15 = items.find((item) => item.key === "m15");
    assert.equal(m15?.start, 1000, "m15 is rendered, at the same distance from the top of the viewport");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("a followed chat stays at the bottom when rows grow under it", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const timeline = (): HTMLDivElement => host.querySelector("[data-testid=timeline]") as HTMLDivElement;
  try {
    await act(async () => { root.render(<Harness rows={rows(0, 10, 100)} stuck onItems={() => {}} />); });
    await act(async () => {
      timeline().scrollTop = 700;
      timeline().dispatchEvent(new window.Event("scroll"));
    });
    await act(async () => { root.render(<Harness rows={rows(0, 12, 100)} stuck onItems={() => {}} />); });
    assert.equal(timeline().scrollTop, 1200);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

function TopUpHarness(props: {
  rowCount: number;
  loading: boolean;
  scrollTop: number;
  onLoad: () => void;
}): JSX.Element {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  useOlderMessagesTopUp(timelineRef, {
    chatTimelineRows: Array.from({ length: props.rowCount }),
    hasOlderMessages: true,
    olderMessagesLoading: props.loading,
    onLoadOlderMessages: props.onLoad
  }, () => false);
  return (
    <div
      ref={(node) => {
        if (node) {
          Object.defineProperty(node, "clientHeight", { configurable: true, get: () => 500 });
          node.scrollTop = props.scrollTop;
        }
        timelineRef.current = node;
      }}
    />
  );
}

test("a page that lands with the view still near the top asks for the next one, once", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let loads = 0;
  const onLoad = (): void => { loads += 1; };
  try {
    await act(async () => { root.render(<TopUpHarness rowCount={81} loading scrollTop={0} onLoad={onLoad} />); });
    assert.equal(loads, 0, "nothing while a page is loading");

    await act(async () => { root.render(<TopUpHarness rowCount={161} loading={false} scrollTop={120} onLoad={onLoad} />); });
    assert.equal(loads, 1, "the page landed near the top: the next one is requested without a scroll event");

    await act(async () => { root.render(<TopUpHarness rowCount={161} loading scrollTop={120} onLoad={onLoad} />); });
    await act(async () => { root.render(<TopUpHarness rowCount={161} loading={false} scrollTop={120} onLoad={onLoad} />); });
    assert.equal(loads, 1, "a load that added nothing (it failed) is not retried in a loop");

    await act(async () => { root.render(<TopUpHarness rowCount={241} loading={false} scrollTop={4000} onLoad={onLoad} />); });
    assert.equal(loads, 1, "far from the top nothing more is loaded");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
