import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  CHAT_MAIN_MIN_WIDTH,
  CHAT_SIDE_PANEL_MIN_WIDTH,
  chatSidePanelWidthLimits,
  clampChatSidePanelWidth
} from "./chat-split-sizing";

test("a side panel can grow until only the main timeline minimum is left", () => {
  // The User's window at 67% zoom: the old fixed 760px cap stopped the panel here.
  const wide = chatSidePanelWidthLimits(2268, { minWidth: CHAT_SIDE_PANEL_MIN_WIDTH });
  assert.equal(wide.max, 2268 - CHAT_MAIN_MIN_WIDTH);
  assert.equal(clampChatSidePanelWidth(5000, wide), 2268 - CHAT_MAIN_MIN_WIDTH);

  // Thread panel passes a 1px separator reserve.
  const thread = chatSidePanelWidthLimits(1600, { reserveWidth: 1, minWidth: CHAT_SIDE_PANEL_MIN_WIDTH });
  assert.equal(thread.max, 1600 - CHAT_MAIN_MIN_WIDTH - 1);
});

test("the panel keeps its minimum and an explicit cap still applies", () => {
  const limits = chatSidePanelWidthLimits(1200, { minWidth: CHAT_SIDE_PANEL_MIN_WIDTH });
  assert.equal(clampChatSidePanelWidth(10, limits), CHAT_SIDE_PANEL_MIN_WIDTH);
  assert.equal(chatSidePanelWidthLimits(2000, { maxWidth: 500 }).max, 500);
});

test("a narrow window still splits instead of overflowing", () => {
  const limits = chatSidePanelWidthLimits(480, { minWidth: CHAT_SIDE_PANEL_MIN_WIDTH });
  assert.ok(Number.isFinite(limits.max));
  assert.ok(limits.max >= limits.min);
  assert.ok(limits.max <= 480);
});

test("the JS main-timeline minimum matches the CSS grid minimum", () => {
  const css = readFileSync(resolve(process.cwd(), "src/renderer/styles/views/chat-conversation.css"), "utf8");
  const match = css.match(/--chat-main-min-width:\s*(\d+)px/);
  assert.ok(match, "--chat-main-min-width is declared");
  assert.equal(Number(match[1]), CHAT_MAIN_MIN_WIDTH);
});
