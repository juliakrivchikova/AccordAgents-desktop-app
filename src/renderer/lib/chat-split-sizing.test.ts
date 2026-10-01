import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  CHAT_MAIN_MIN_WIDTH,
  CHAT_SIDE_PANEL_FALLBACK_SHARE,
  CHAT_SIDE_PANEL_FLOOR_WIDTH,
  CHAT_SIDE_PANEL_MIN_WIDTH,
  chatSidePanelWidthLimits,
  clampChatSidePanelWidth
} from "./chat-split-sizing";

const css = (file: string): string => readFileSync(resolve(process.cwd(), "src/renderer/styles/views", file), "utf8");

// The main column floor the CSS grid applies: min(var(--chat-main-min-width), calc(55% - 1px)).
const cssMainFloor = (containerWidth: number, mainMinWidth: number): number =>
  Math.min(mainMinWidth, containerWidth * (1 - CHAT_SIDE_PANEL_FALLBACK_SHARE) - 1);

test("a side panel can grow until only the main timeline minimum is left", () => {
  // The User's window at 67% zoom: the old fixed 760px cap stopped the panel here.
  const wide = chatSidePanelWidthLimits(2268, { minWidth: CHAT_SIDE_PANEL_MIN_WIDTH });
  assert.equal(wide.max, 2268 - CHAT_MAIN_MIN_WIDTH);
  assert.equal(clampChatSidePanelWidth(5000, wide), 2268 - CHAT_MAIN_MIN_WIDTH);

  // Thread panel passes a 1px separator reserve; Activity raises the main minimum.
  const thread = chatSidePanelWidthLimits(1600, { reserveWidth: 1, minWidth: CHAT_SIDE_PANEL_MIN_WIDTH, mainMinWidth: 412 });
  assert.equal(thread.max, 1600 - 412 - 1);
  assert.equal(clampChatSidePanelWidth(10, thread), CHAT_SIDE_PANEL_MIN_WIDTH);
});

test("JS limits and the CSS grid agree at every container width", () => {
  for (const mainMinWidth of [CHAT_MAIN_MIN_WIDTH, 412]) {
    for (const reserveWidth of [0, 1]) {
      for (let width = 360; width <= 2600; width += 1) {
        const limits = chatSidePanelWidthLimits(width, { reserveWidth, minWidth: CHAT_SIDE_PANEL_MIN_WIDTH, mainMinWidth });
        const label = `width ${width}, main ${mainMinWidth}, reserve ${reserveWidth}`;
        assert.ok(limits.min <= limits.max, label);
        // The widest panel always fits beside the column floor the CSS enforces.
        assert.ok(limits.max + reserveWidth + cssMainFloor(width, mainMinWidth) <= width, label);
        if (width - mainMinWidth - reserveWidth >= CHAT_SIDE_PANEL_FLOOR_WIDTH) {
          // With room for both, the main timeline keeps its full minimum.
          assert.equal(width - limits.max - reserveWidth, mainMinWidth, label);
        }
      }
    }
  }
});

test("the CSS grid uses the same main minimum and fallback split as the JS", () => {
  const chat = css("chat-conversation.css");
  assert.equal(Number(chat.match(/--chat-main-min-width:\s*(\d+)px/)?.[1]), CHAT_MAIN_MIN_WIDTH);
  const mainShare = Math.round((1 - CHAT_SIDE_PANEL_FALLBACK_SHARE) * 100);
  assert.match(chat, new RegExp(`--chat-main-floor: min\\(var\\(--chat-main-min-width\\), calc\\(${mainShare}% - 1px\\)\\);`));
  assert.equal(chat.match(/minmax\(var\(--chat-main-floor\), 1fr\)/g)?.length, 3);
  assert.doesNotMatch(chat, /minmax\(var\(--chat-main-min-width\)/);
  assert.match(css("activity.css"), /\.activity-detail-body \.chat-view \{\s*--chat-main-min-width: 412px;/);
});
