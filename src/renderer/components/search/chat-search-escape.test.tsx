import assert from "node:assert/strict";
import test from "node:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

import type { ChatSearchMessageMatch } from "../../../shared/types";
import { ChatSearchModal } from "./chat-search-modal";

declare global {
  var ACCORD_RENDERER_JSDOM: boolean | undefined;
}

test("Escape closes only search and preserves an underlying dismissable surface", async () => {
  assert.equal(globalThis.ACCORD_RENDERER_JSDOM, true, "run this test with scripts/renderer-jsdom-setup.mjs");
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => { callback(0); return 1; }
  });
  const trigger = document.createElement("button");
  trigger.id = "chat-search-trigger";
  document.body.append(trigger);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let searchOpen = true;
  let underlyingSurfaceOpen = true;
  const underlyingEscapeHandler = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      underlyingSurfaceOpen = false;
    }
  };
  document.addEventListener("keydown", underlyingEscapeHandler);

  function Harness(): JSX.Element {
    const [open, setOpen] = useState(true);
    return (
      <ChatSearchModal
        open={open}
        query="needle"
        loading={false}
        loadingMore={false}
        onOpenChange={(open) => {
          searchOpen = open;
          setOpen(open);
        }}
        onQueryChange={() => undefined}
        onClear={() => undefined}
        onLoadMore={() => undefined}
        onOpenConversation={() => undefined}
        onOpenMessage={(_match: ChatSearchMessageMatch) => undefined}
      />
    );
  }

  try {
    await act(async () => { root.render(<Harness />); });
    const input = document.querySelector<HTMLInputElement>(".aa-searchmodal-input");
    assert.ok(input);
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(searchOpen, false);
    assert.equal(document.querySelector("[data-testid='chat-search-modal']"), null);
    assert.equal(underlyingSurfaceOpen, true);
    assert.equal(document.activeElement, trigger);
  } finally {
    document.removeEventListener("keydown", underlyingEscapeHandler);
    await act(async () => { root.unmount(); });
    container.remove();
    trigger.remove();
  }
});
