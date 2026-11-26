import assert from "node:assert/strict";
import test from "node:test";

import { followsLatestAfterScroll } from "./chat-timeline-follow";

test("a scroll up by the User leaves the end of the chat at once, even a few pixels from it", () => {
  const cases: Array<[string, Parameters<typeof followsLatestAfterScroll>[0], boolean]> = [
    // The flicker: each small trackpad step inside the last 96 px re-pinned the chat,
    // and the next streamed chunk pulled the view back down.
    ["a small step up near the end", { distanceFromBottom: 8, moved: -4, contentShrank: false, userScrolling: true, following: true }, false],
    ["back down into the end", { distanceFromBottom: 40, moved: 20, contentShrank: false, userScrolling: true, following: false }, true],
    // A Retina momentum tail moves by half a pixel; it is not a scroll down.
    ["a half-pixel tail while left just above the end", { distanceFromBottom: 50, moved: -0.5, contentShrank: false, userScrolling: true, following: false }, false],
    // Creeping up by half pixels while following still leaves the end.
    // From the very end a slow trackpad moves by a pixel; it still leaves.
    ["a one-pixel step up from the very end", { distanceFromBottom: 1, moved: -1, contentShrank: false, userScrolling: true, following: true }, false],
    ["a half-pixel step up from a followed end", { distanceFromBottom: 1.5, moved: -0.5, contentShrank: false, userScrolling: true, following: true }, false],
    ["a sub-pixel jitter down while left just above the end", { distanceFromBottom: 50, moved: 0.3, contentShrank: false, userScrolling: true, following: false }, false],
    ["a scroll event that moved nothing", { distanceFromBottom: 50, moved: 0, contentShrank: false, userScrolling: true, following: false }, false],
    ["the end moved away from a followed chat (content grew)", { distanceFromBottom: 300, moved: 0, contentShrank: false, userScrolling: false, following: true }, true],
    ["content shrank above a followed chat, nobody scrolling", { distanceFromBottom: 10, moved: -6, contentShrank: true, userScrolling: false, following: true }, true],
    ["reading higher up, a row grew", { distanceFromBottom: 600, moved: 0, contentShrank: false, userScrolling: false, following: false }, false],
    ["scrolled down but not to the end", { distanceFromBottom: 400, moved: 40, contentShrank: false, userScrolling: true, following: false }, false],
    // The app keeping a row in place writes its own position, which is not a move of hers.
    ["left just above the end, the app keeps a row in place", { distanceFromBottom: 40, moved: 0, contentShrank: false, userScrolling: false, following: false }, false],
    // Space on a disclosure counts as scrolling; the row collapsing clamps the view to the end.
    ["a row collapsed under a followed chat, clamped to the end", { distanceFromBottom: 0, moved: -30, contentShrank: true, userScrolling: true, following: true }, true]
  ];
  for (const [name, scroll, follows] of cases) {
    assert.equal(followsLatestAfterScroll(scroll), follows, name);
  }
});
