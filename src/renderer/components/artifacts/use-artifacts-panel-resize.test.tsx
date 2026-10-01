import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { ARTIFACT_PANEL_DEFAULT_WIDTH, CHAT_MAIN_MIN_WIDTH } from "../../lib/chat-split-sizing";
import { useArtifactsPanelResize } from "./use-artifacts-panel-resize";

// A container whose width the test sets, with a ResizeObserver the test fires.
let containerWidth = 2268;
const observers: Array<() => void> = [];
class TestResizeObserver {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe(): void {
    observers.push(this.callback);
  }
  unobserve(): void {}
  disconnect(): void {
    observers.splice(observers.indexOf(this.callback), 1);
  }
}

function Harness(): JSX.Element {
  const resize = useArtifactsPanelResize();
  return (
    <div ref={(node) => {
      if (node) node.getBoundingClientRect = () => ({ width: containerWidth }) as DOMRect;
    }}>
      <div ref={resize.panelRef} data-testid="panel" style={{ width: `${resize.panelWidth}px` }}>
        <div role="separator" tabIndex={0} aria-valuemax={resize.limits.max} onKeyDown={resize.resizeWithKeyboard}
          onDoubleClick={resize.resetWidth} />
      </div>
    </div>
  );
}

test("the artifact panel reaches the container minus the main minimum and gets it back after a squeeze", async () => {
  const previousObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const panel = (): HTMLElement => host.querySelector("[data-testid=panel]") as HTMLElement;
  const separator = (): HTMLElement => host.querySelector("[role=separator]") as HTMLElement;
  const resizeContainer = async (width: number): Promise<void> => {
    containerWidth = width;
    await act(async () => { for (const notify of [...observers]) notify(); });
  };
  try {
    containerWidth = 2268;
    await act(async () => { root.render(<Harness />); });
    // The range comes from the container, not the window, from the first frame on.
    assert.equal(separator().getAttribute("aria-valuemax"), String(2268 - CHAT_MAIN_MIN_WIDTH));

    await act(async () => {
      separator().dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    assert.equal(panel().style.width, `${2268 - CHAT_MAIN_MIN_WIDTH}px`);

    // Opening the sidebar squeezes the panel; closing it brings the chosen width back.
    await resizeContainer(1948);
    assert.equal(panel().style.width, `${1948 - CHAT_MAIN_MIN_WIDTH}px`);
    assert.equal(separator().getAttribute("aria-valuemax"), String(1948 - CHAT_MAIN_MIN_WIDTH));
    await resizeContainer(2268);
    assert.equal(panel().style.width, `${2268 - CHAT_MAIN_MIN_WIDTH}px`);

    // A reset while squeezed asks for the default width, not for the squeezed one.
    await resizeContainer(520);
    await act(async () => {
      separator().dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    });
    assert.equal(panel().style.width, "234px");
    await resizeContainer(2268);
    assert.equal(panel().style.width, `${ARTIFACT_PANEL_DEFAULT_WIDTH}px`);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.ResizeObserver = previousObserver;
  }
});
