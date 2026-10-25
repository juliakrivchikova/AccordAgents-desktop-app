import assert from "node:assert/strict";
import test from "node:test";
import { act, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";

import { measureRowAndRemember, unmeasuredRowClip, useAnchoredVirtualItems } from "./chat-timeline-scroll";

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
  overscan?: number;
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
    measureElement: measureRowAndRemember,
    initialOffset: props.initialOffset ?? 0,
    overscan: props.overscan ?? 1,
    useFlushSync: false,
    // As in the app. jsdom has no scrollend event, so the virtualizer falls back to a
    // timer that re-applies the last scroll event's position; keep it out of the way.
    useScrollendEvent: true,
    isScrollingResetDelay: 60_000
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
              style={unmeasuredRowClip(virtualizer, item)}
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

test("rows of a landed page that are off screen above are mounted one frame later", async () => {
  let items: VirtualItem[] = [];
  const onItems = (next: VirtualItem[]): void => { items = next; };
  let virtualizer: Virtualizer<HTMLDivElement, Element> | undefined;
  const onVirtualizer = (next: Virtualizer<HTMLDivElement, Element>): void => { virtualizer = next; };
  // As in the app, several rows above the viewport are rendered ahead of time.
  const view = await mount({ rows: rows(10, 30, 100), stuck: false, onItems, onVirtualizer, overscan: 8 });
  try {
    await view.scrollTo(518);
    await view.rerender({ rows: [...rows(0, 10, 50), ...rows(10, 30, 100)], stuck: false, onItems, onVirtualizer, overscan: 8 });
    const firstFrame = items.map((item) => String(item.key));
    assert.ok(firstFrame.includes("m15"), "what the User sees is there at once");
    assert.ok(!firstFrame.includes("m9"), "the new rows above the viewport wait");
    // A row measured on mount re-renders the timeline before the frame is painted.
    await act(async () => { virtualizer?.resizeItem(items.findIndex((item) => item.key === "m16") >= 0 ? items.find((item) => item.key === "m16")!.index : 0, 120); });
    assert.ok(!items.some((item) => item.key === "m9"), "and keep waiting through that render");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    assert.ok(items.some((item) => item.key === "m9"), "and arrive in the next frame");
    assert.equal(screenTop(items, "m15", view.timeline().scrollTop), 0, "m15 did not move");
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

test("a row not measured yet is clipped to its estimated height, and not once it is measured", async () => {
  let items: VirtualItem[] = [];
  let virtualizer: Virtualizer<HTMLDivElement, Element> | undefined;
  const onItems = (next: VirtualItem[]): void => { items = next; };
  const onVirtualizer = (next: Virtualizer<HTMLDivElement, Element>): void => { virtualizer = next; };
  const tallRows = rows(0, 20, 100).map((row) => row.id === "m6" ? { ...row, realSize: 900 } : row);
  const view = await mount({ rows: tallRows, stuck: false, renderRows: true, onItems, onVirtualizer });
  try {
    await view.scrollTo(1518);
    // The User is scrolling: the virtualizer does not measure rows that mount now.
    await act(async () => {
      if (virtualizer) virtualizer.isScrolling = true;
      view.timeline().scrollTop = 518;
    });
    await act(async () => {
      if (virtualizer) virtualizer.isScrolling = true;
      view.timeline().dispatchEvent(new window.Event("scroll"));
    });
    const m6 = items.find((item) => item.key === "m6");
    assert.ok(m6 && virtualizer, "m6 is rendered");
    assert.match(unmeasuredRowClip(virtualizer, m6).clipPath ?? "", /calc\(100% \+ \d+px\) 100px/, "drawn no taller than its estimate");
    const outset = Number(/^polygon\(-(\d+)px -(\d+)px/.exec(unmeasuredRowClip(virtualizer, m6).clipPath ?? "")?.[2]);
    assert.ok(outset >= 100, "nothing above or beside it is cut (the hover toolbar sits 10 px above a row)");

    // Its ResizeObserver reports it, as the virtualizer does after the frame is painted.
    const element = view.timeline().querySelector(`[data-index="${m6.index}"]`);
    assert.ok(element);
    await act(async () => { virtualizer?.resizeItem(m6.index, virtualizer.options.measureElement(element, undefined, virtualizer)); });
    const measured = items.find((item) => item.key === "m6");
    assert.ok(measured);
    assert.deepEqual(unmeasuredRowClip(virtualizer, measured), {}, "measured: not clipped");
  } finally {
    await view.unmount();
  }
});

test("the last row is never clipped: nothing under it can be painted over", async () => {
  let items: VirtualItem[] = [];
  let virtualizer: Virtualizer<HTMLDivElement, Element> | undefined;
  const view = await mount({ rows: rows(0, 3, 100), stuck: false, onItems: (next) => { items = next; }, onVirtualizer: (next) => { virtualizer = next; } });
  try {
    const last = items.find((item) => item.key === "m2");
    const middle = items.find((item) => item.key === "m1");
    assert.ok(last && middle && virtualizer);
    assert.deepEqual(unmeasuredRowClip(virtualizer, last), {});
    assert.ok(unmeasuredRowClip(virtualizer, middle).clipPath, "an unmeasured row with rows under it is clipped");
  } finally {
    await view.unmount();
  }
});

test("a row exactly as tall as its estimate is not clipped once measured", async () => {
  let items: VirtualItem[] = [];
  let virtualizer: Virtualizer<HTMLDivElement, Element> | undefined;
  const view = await mount({ rows: rows(0, 20, 100), stuck: false, renderRows: true, onItems: (next) => { items = next; }, onVirtualizer: (next) => { virtualizer = next; } });
  try {
    const m1 = items.find((item) => item.key === "m1");
    assert.ok(m1 && virtualizer);
    assert.deepEqual(unmeasuredRowClip(virtualizer, m1), {}, "measured on mount at its estimated height: no clip left on it");
    const element = view.timeline().querySelector<HTMLElement>(`[data-index="${m1.index}"]`);
    assert.equal(element?.style.clipPath ?? "", "", "and none on the element either");
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
