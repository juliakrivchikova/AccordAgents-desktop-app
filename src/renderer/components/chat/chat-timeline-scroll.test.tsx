import assert from "node:assert/strict";
import test from "node:test";
import { act, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";

import { useAnchoredVirtualItems, useOlderMessagesTopUp } from "./chat-timeline-scroll";

// jsdom has no animation frames; the virtualizer steers its scrolls on them.
if (typeof window.requestAnimationFrame !== "function") {
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => window.setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = (handle: number): void => window.clearTimeout(handle);
}

// A scroller jsdom can lay out like the real one: fixed viewport, the timeline's
// padding (18 px top, 8 px bottom), content height from the virtualizer, and a
// scroll position the browser clamps to what can be scrolled.
const VIEWPORT = 300;
const PADDING_TOP = 18;
const PADDING_BOTTOM = 8;

const installedScrollers = new WeakSet<HTMLDivElement>();

function installScroller(node: HTMLDivElement, contentHeight: () => number): void {
  // An inline ref runs again on every render; install once per element.
  if (installedScrollers.has(node)) {
    return;
  }
  installedScrollers.add(node);
  node.style.paddingTop = `${PADDING_TOP}px`;
  node.style.paddingBottom = `${PADDING_BOTTOM}px`;
  const scrollHeight = (): number => Math.max(VIEWPORT, contentHeight() + PADDING_TOP + PADDING_BOTTOM);
  let top = 0;
  Object.defineProperty(node, "offsetHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(node, "offsetWidth", { configurable: true, get: () => 600 });
  Object.defineProperty(node, "clientHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(node, "scrollHeight", { configurable: true, get: scrollHeight });
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      const next = Math.max(0, Math.min(value, scrollHeight() - VIEWPORT));
      if (next !== top) {
        top = next;
        // Like a browser, a changed scroll position fires a scroll event, asynchronously.
        setTimeout(() => node.dispatchEvent(new window.Event("scroll")), 0);
      }
    }
  });
  node.scrollTo = ((options: ScrollToOptions) => {
    node.scrollTop = options.top ?? node.scrollTop;
  }) as typeof node.scrollTo;
}

type Row = { id: string; size: number; realSize?: number };
type HarnessProps = {
  rows: Row[];
  stuck: boolean;
  renderRows?: boolean;
  onItems?: (items: VirtualItem[]) => void;
  onVirtualizer?: (virtualizer: Virtualizer<HTMLDivElement, Element>) => void;
  initialOffset?: number;
};

function Harness(props: HarnessProps): JSX.Element {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const totalRef = useRef(0);
  const rowsRef = useRef(props.rows);
  rowsRef.current = props.rows;
  // Stable callbacks, as a memoized production config would pass: the hook must
  // not depend on the virtualizer rebuilding its layout on every render.
  const estimateSize = useCallback((index: number) => rowsRef.current[index]?.size ?? 100, []);
  const getItemKey = useCallback((index: number) => rowsRef.current[index]?.id ?? index, []);
  const virtualizer = useVirtualizer({
    count: props.rows.length,
    getScrollElement: () => timelineRef.current,
    estimateSize,
    getItemKey,
    initialOffset: props.initialOffset ?? 0,
    overscan: 1,
    useFlushSync: false
  });
  props.onVirtualizer?.(virtualizer);
  const items = useAnchoredVirtualItems(virtualizer, timelineRef, () => props.stuck);
  totalRef.current = virtualizer.getTotalSize();
  props.onItems?.(items);
  return (
    <div
      data-testid="timeline"
      ref={(node) => {
        if (node) {
          installScroller(node, () => totalRef.current);
        }
        timelineRef.current = node;
      }}
    >
      <div className="rows">
        <button type="button" data-testid="toggle">toggle</button>
        {props.renderRows && items.map((item) => {
          const row = props.rows[item.index];
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={(node) => {
                if (node) {
                  // jsdom lays nothing out: the row's real height is what the test says.
                  Object.defineProperty(node, "offsetHeight", { configurable: true, get: () => row?.realSize ?? row?.size ?? 0 });
                }
                virtualizer.measureElement(node);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function rows(from: number, to: number, size: number): Row[] {
  return Array.from({ length: to - from }, (_, offset) => ({ id: `m${from + offset}`, size }));
}

async function mount(props: HarnessProps): Promise<{
  rerender: (next: HarnessProps) => Promise<void>;
  timeline: () => HTMLDivElement;
  scrollTo: (top: number) => Promise<void>;
  unmount: () => Promise<void>;
}> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const timeline = (): HTMLDivElement => host.querySelector("[data-testid=timeline]") as HTMLDivElement;
  await act(async () => { root.render(<Harness {...props} />); });
  return {
    rerender: async (next) => { await act(async () => { root.render(<Harness {...next} />); }); },
    timeline,
    scrollTo: async (top) => {
      await act(async () => {
        timeline().scrollTop = top;
        timeline().dispatchEvent(new window.Event("scroll"));
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    }
  };
}

// Where a row's top edge is on screen, relative to the top of the viewport.
function screenTop(items: VirtualItem[], key: string, scrollTop: number): number | undefined {
  const item = items.find((candidate) => candidate.key === key);
  return item === undefined ? undefined : item.start + PADDING_TOP - scrollTop;
}

test("loading an older page keeps the message on screen in place, in the same commit", async () => {
  let items: VirtualItem[] = [];
  const onItems = (next: VirtualItem[]): void => { items = next; };
  const view = await mount({ rows: rows(10, 30, 100), stuck: false, onItems });
  try {
    await view.scrollTo(518);
    assert.equal(screenTop(items, "m15", 518), 0, "m15 starts at the top of the viewport");

    await view.rerender({ rows: [...rows(0, 10, 50), ...rows(10, 30, 100)], stuck: false, onItems });

    assert.equal(view.timeline().scrollTop, 1018);
    assert.equal(screenTop(items, "m15", view.timeline().scrollTop), 0, "m15 is rendered in the same place");
  } finally {
    await view.unmount();
  }
});

test("a jump the virtualizer is still steering is not pulled to another row when a page loads above", async () => {
  let items: VirtualItem[] = [];
  let virtualizer: Virtualizer<HTMLDivElement, Element> | undefined;
  const onItems = (next: VirtualItem[]): void => { items = next; };
  const onVirtualizer = (next: Virtualizer<HTMLDivElement, Element>): void => { virtualizer = next; };
  const view = await mount({ rows: rows(10, 30, 100), stuck: false, onItems, onVirtualizer });
  try {
    // Jump to m15: the virtualizer keeps steering to row index 5 for a while.
    await act(async () => {
      virtualizer?.scrollToIndex(5, { align: "start" });
      view.timeline().dispatchEvent(new window.Event("scroll"));
    });
    const before = screenTop(items, "m15", view.timeline().scrollTop);
    assert.notEqual(before, undefined, "m15 is on screen after the jump");
    await view.rerender({ rows: [...rows(0, 10, 50), ...rows(10, 30, 100)], stuck: false, onItems, onVirtualizer });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    assert.equal(screenTop(items, "m15", view.timeline().scrollTop), before, "m15 is still where the jump put it");
  } finally {
    await view.unmount();
  }
});

test("a row above the viewport measured taller is corrected once, not twice", async () => {
  let items: VirtualItem[] = [];
  let virtualizer: Virtualizer<HTMLDivElement, Element> | undefined;
  const props: HarnessProps = { rows: rows(0, 20, 100), stuck: false, onItems: (next) => { items = next; }, onVirtualizer: (next) => { virtualizer = next; } };
  const view = await mount(props);
  try {
    await view.scrollTo(1018);
    assert.equal(screenTop(items, "m10", 1018), 0);
    // m8 sits in the overscan above the viewport and turns out 400 px taller.
    await act(async () => { virtualizer?.resizeItem(8, 500); });
    assert.equal(view.timeline().scrollTop, 1418);
    assert.equal(screenTop(items, "m10", view.timeline().scrollTop), 0, "m10 did not move");
  } finally {
    await view.unmount();
  }
});

test("the row starting at the top of the viewport, below the padding, keeps its place when it grows", async () => {
  let items: VirtualItem[] = [];
  let virtualizer: Virtualizer<HTMLDivElement, Element> | undefined;
  const view = await mount({ rows: rows(0, 20, 100), stuck: false, onItems: (next) => { items = next; }, onVirtualizer: (next) => { virtualizer = next; } });
  try {
    await view.scrollTo(1018);
    assert.equal(screenTop(items, "m10", 1018), 0, "m10 starts right at the top of the viewport");
    await act(async () => { virtualizer?.resizeItem(10, 500); });
    assert.equal(view.timeline().scrollTop, 1018);
    assert.equal(screenTop(items, "m10", view.timeline().scrollTop), 0, "m10 grew downward and stayed at the top");
  } finally {
    await view.unmount();
  }
});

test("rows mounted while the User scrolls are measured before they are painted", async () => {
  let items: VirtualItem[] = [];
  let virtualizer: Virtualizer<HTMLDivElement, Element> | undefined;
  const onItems = (next: VirtualItem[]): void => { items = next; };
  const onVirtualizer = (next: Virtualizer<HTMLDivElement, Element>): void => { virtualizer = next; };
  const tallRows = rows(0, 20, 100).map((row) => row.id === "m6" ? { ...row, realSize: 900 } : row);
  const view = await mount({ rows: tallRows, stuck: false, renderRows: true, onItems, onVirtualizer });
  try {
    await view.scrollTo(1518);
    // The User is scrolling: the virtualizer itself would not measure m6 until later.
    await act(async () => {
      if (virtualizer) virtualizer.isScrolling = true;
      // m5 at the top of the viewport, m6 (not mounted yet) right under it.
      view.timeline().scrollTop = 518;
    });
    await act(async () => {
      if (virtualizer) virtualizer.isScrolling = true;
      view.timeline().dispatchEvent(new window.Event("scroll"));
    });
    assert.equal(items.find((item) => item.key === "m6")?.size, 900, "m6 has its real height");
    assert.equal(items.find((item) => item.key === "m7")?.start, (items.find((item) => item.key === "m6")?.start ?? 0) + 900, "and m7 starts below it");
  } finally {
    await view.unmount();
  }
});

test("a row the User opens while following the chat opens downward instead of pulling the view", async () => {
  let virtualizer: Virtualizer<HTMLDivElement, Element> | undefined;
  const props: HarnessProps = { rows: rows(0, 10, 100), stuck: true, onVirtualizer: (next) => { virtualizer = next; } };
  const view = await mount(props);
  try {
    await view.scrollTo(10_000);
    const bottom = view.timeline().scrollTop;
    assert.equal(bottom, 1000 + PADDING_TOP + PADDING_BOTTOM - VIEWPORT);
    await act(async () => {
      view.timeline().querySelector("[data-testid=toggle]")?.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    });
    // She opened the last-but-one message: 300 px more of it.
    await act(async () => { virtualizer?.resizeItem(8, 400); });
    assert.equal(view.timeline().scrollTop, bottom, "the view did not jump to the new bottom");
  } finally {
    await view.unmount();
  }
});

test("a followed chat shows its newest row at the bottom when rows grow under it, in the same commit", async () => {
  let items: VirtualItem[] = [];
  const onItems = (next: VirtualItem[]): void => { items = next; };
  const view = await mount({ rows: rows(0, 10, 100), stuck: true, onItems });
  try {
    await view.scrollTo(10_000);
    await view.rerender({ rows: rows(0, 12, 100), stuck: true, onItems });
    const max = 1200 + PADDING_TOP + PADDING_BOTTOM - VIEWPORT;
    assert.equal(view.timeline().scrollTop, max);
    assert.ok(items.some((item) => item.key === "m11"), "the newest row is rendered in that commit");
    assert.equal(items[0]?.key, "m8", "rendered for the new bottom, not the old position (one row of overscan)");
    assert.equal(screenTop(items, "m11", max), VIEWPORT - PADDING_BOTTOM - 100, "and sits at the bottom");
  } finally {
    await view.unmount();
  }
});

test("a chat that opens at its end but fits on screen renders all of its rows", async () => {
  let items: VirtualItem[] = [];
  // Six 40 px rows in a 300 px viewport, opened at the end like a chat is.
  const view = await mount({ rows: rows(0, 6, 40), stuck: true, initialOffset: Number.MAX_SAFE_INTEGER, onItems: (next) => { items = next; } });
  try {
    assert.deepEqual(items.map((item) => item.key), ["m0", "m1", "m2", "m3", "m4", "m5"]);
  } finally {
    await view.unmount();
  }
});

function TopUpHarness(props: {
  loadedMessageCount: number;
  loading: boolean;
  scrollTop: number;
  onLoad: () => void;
  blocked?: boolean;
  hasOlderMessages?: boolean;
  onRequest?: (request: () => void) => void;
}): JSX.Element {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const request = useOlderMessagesTopUp(timelineRef, {
    loadedMessageCount: props.loadedMessageCount,
    hasOlderMessages: props.hasOlderMessages ?? true,
    olderMessagesLoading: props.loading,
    onLoadOlderMessages: props.onLoad
  }, () => !props.blocked);
  props.onRequest?.(request);
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
  let requestOnScroll: () => void = () => {};
  const onLoad = (): void => { loads += 1; };
  const render = async (props: Omit<Parameters<typeof TopUpHarness>[0], "onLoad">): Promise<void> => {
    await act(async () => { root.render(<TopUpHarness {...props} onLoad={onLoad} onRequest={(request) => { requestOnScroll = request; }} />); });
  };
  try {
    await render({ loadedMessageCount: 80, loading: true, scrollTop: 0 });
    assert.equal(loads, 0, "nothing while a page is loading");

    await render({ loadedMessageCount: 160, loading: false, scrollTop: 120 });
    assert.equal(loads, 1, "the page landed near the top: the next one is requested without a scroll event");

    await render({ loadedMessageCount: 160, loading: true, scrollTop: 120 });
    await render({ loadedMessageCount: 160, loading: false, scrollTop: 120 });
    requestOnScroll();
    requestOnScroll();
    assert.equal(loads, 1, "a load that added nothing (it failed) is not retried, not even on scroll");

    await render({ loadedMessageCount: 240, loading: false, scrollTop: 4000 });
    assert.equal(loads, 1, "far from the top nothing more is loaded");

    await render({ loadedMessageCount: 241, loading: false, scrollTop: 0, blocked: true });
    await render({ loadedMessageCount: 242, loading: false, scrollTop: 0, hasOlderMessages: false });
    assert.equal(loads, 1, "nothing loads during a jump to a message, or when nothing older exists");

    await render({ loadedMessageCount: 243, loading: false, scrollTop: 0 });
    assert.equal(loads, 2, "a changed chat near the top loads again");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
