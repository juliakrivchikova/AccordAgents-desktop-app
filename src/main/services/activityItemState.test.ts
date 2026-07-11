import assert from "node:assert/strict";
import test from "node:test";
import {
  applyChatActivityItemPreferences,
  chatActivityItemPreferencesAfterClear
} from "../../shared/chatActivity";
import type { ChatActivityItem } from "../../shared/types";

test("clearing the final visible finished item keeps older history hidden after restart", () => {
  const visible = activityItem("visible", "2026-07-11T07:00:00.000Z");
  const olderBackfill = activityItem("older", "2026-07-05T07:00:00.000Z");
  const preferences = chatActivityItemPreferencesAfterClear(
    { readItemIds: new Set(), clearedItemIds: new Set() },
    [visible],
    visible.id
  );

  assert.equal(preferences.clearedRecentThrough, visible.updatedAt);
  assert.deepEqual(applyChatActivityItemPreferences([olderBackfill], preferences), []);
});

test("finished activity created after the clear horizon remains visible", () => {
  const newer = activityItem("newer", "2026-07-11T08:00:00.000Z");

  const filtered = applyChatActivityItemPreferences([newer], {
    clearedRecentThrough: "2026-07-11T07:30:00.000Z"
  });

  assert.deepEqual(filtered.map((item) => item.id), [newer.id]);
});

test("clearing one of several finished items does not dismiss the rest", () => {
  const first = activityItem("first", "2026-07-11T07:00:00.000Z");
  const second = activityItem("second", "2026-07-11T06:00:00.000Z");

  const preferences = chatActivityItemPreferencesAfterClear(
    { readItemIds: new Set(), clearedItemIds: new Set() },
    [first, second],
    first.id
  );

  assert.equal(preferences.clearedRecentThrough, undefined);
  assert.deepEqual(applyChatActivityItemPreferences([first, second], preferences).map((item) => item.id), [second.id]);
});

test("clear horizon follows a future-dated item and hides older backfill", () => {
  const futureDated = activityItem("future", "2026-07-11T09:00:00.000Z");
  const olderBackfill = activityItem("older", "2026-07-11T08:00:00.000Z");
  const preferences = chatActivityItemPreferencesAfterClear(
    { readItemIds: new Set(), clearedItemIds: new Set() },
    [futureDated],
    futureDated.id
  );

  assert.equal(preferences.clearedRecentThrough, futureDated.updatedAt);
  assert.deepEqual(applyChatActivityItemPreferences([olderBackfill], preferences), []);
});

test("clear horizon never moves backward", () => {
  const item = activityItem("item", "2026-07-11T08:00:00.000Z");
  const existingHorizon = "2026-07-11T09:00:00.000Z";
  const preferences = chatActivityItemPreferencesAfterClear(
    {
      readItemIds: new Set(),
      clearedItemIds: new Set(),
      clearedRecentThrough: existingHorizon
    },
    [item],
    item.id
  );

  assert.equal(preferences.clearedRecentThrough, existingHorizon);
});

function activityItem(id: string, updatedAt: string): ChatActivityItem {
  return {
    id,
    conversationId: "conversation-1",
    conversationTitle: "Activity",
    status: "recent",
    kind: "message",
    title: id,
    preview: id,
    createdAt: updatedAt,
    updatedAt,
    target: { messageId: id }
  };
}
