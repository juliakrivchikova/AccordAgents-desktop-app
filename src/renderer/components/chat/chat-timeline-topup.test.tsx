import assert from "node:assert/strict";
import test from "node:test";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";

import { useLoadOlderUntilMember } from "./chat-sessions-right-panel";
import { useOlderMessagesTopUp } from "./chat-timeline-scroll";

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

test("a timeline that shows few of the loaded messages stops loading by itself after two pages that added no row", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let loads = 0;
  const onLoad = (): void => { loads += 1; };
  function Sparse(props: { count: number; rows: number }): JSX.Element {
    const timelineRef = useRef<HTMLDivElement | null>(null);
    useOlderMessagesTopUp(timelineRef, {
      loadedMessageCount: props.count, hasOlderMessages: true, olderMessagesLoading: false, onLoadOlderMessages: onLoad,
      visibleRowCount: props.rows, maxBarrenLoads: 2
    });
    return <div ref={(node) => { if (node) { Object.defineProperty(node, "clientHeight", { configurable: true, get: () => 500 }); node.scrollTop = 0; } timelineRef.current = node; }} />;
  }
  const render = async (count: number, rows: number): Promise<void> => {
    await act(async () => { root.render(<Sparse count={count} rows={rows} />); });
  };
  try {
    await render(80, 3);
    assert.equal(loads, 1, "the first page is asked for");
    await render(160, 3);
    assert.equal(loads, 2, "one page without a row: the next is still asked for");
    await render(240, 3);
    assert.equal(loads, 2, "two pages in a row without a row: it stops, Load older goes on");
    await render(320, 4);
    assert.equal(loads, 3, "a page (asked by Load older) that added a row starts it again");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("Load older in a member's session goes on until a page brings a message of that member, or the chat's start, a few pages at most", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let loads = 0;
  let click: () => void = () => {};
  function Panel(props: { own: number; hasOlder: boolean; loading: boolean }): null {
    click = useLoadOlderUntilMember(props.own, props.hasOlder, props.loading, () => { loads += 1; });
    return null;
  }
  const render = async (own: number, hasOlder: boolean, loading: boolean): Promise<void> => {
    await act(async () => { root.render(<Panel own={own} hasOlder={hasOlder} loading={loading} />); });
  };
  try {
    await render(2, true, false);
    await act(async () => click());
    assert.equal(loads, 1, "the click loads a page");
    await render(2, true, true);
    await render(2, true, false);
    assert.equal(loads, 2, "nothing of this member in it: the next page");
    await render(2, true, true);
    await render(3, true, false);
    assert.equal(loads, 2, "a message of this member arrived: it stops");
    await act(async () => click());
    await render(3, true, true);
    await render(3, false, false);
    assert.equal(loads, 3, "the chat's start: it stops");
    await act(async () => click());
    for (let page = 0; page < 10; page += 1) {
      await render(3, true, true);
      await render(3, true, false);
    }
    assert.equal(loads, 3 + 6, "a few pages at most");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
