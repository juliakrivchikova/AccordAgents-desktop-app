import assert from "node:assert/strict";
import test from "node:test";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";

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
