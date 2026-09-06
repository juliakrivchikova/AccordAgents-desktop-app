import assert from "node:assert/strict";
import test from "node:test";
import {
  applyChatActivityItemPreferences,
  chatActivityItemPreferencesAfterClear,
  MAX_CHAT_ACTIVITY_CLEAR_HORIZONS
} from "../../shared/chatActivity";
import type { ChatActivityItem } from "../../shared/types";

test("clearing a collapsed finished row keeps that member's older updates hidden after restart", () => {
  const visible = activityItem("visible", "2026-07-11T07:00:00.000Z");
  const olderBackfill = activityItem("older", "2026-07-05T07:00:00.000Z");
  const preferences = chatActivityItemPreferencesAfterClear(
    { readItemIds: new Set(), clearedItemIds: new Set() },
    [visible],
    visible.id
  );

  assert.deepEqual(preferences.clearedRecentThroughByGroup, {
    "conversation-1:id:member-1": visible.updatedAt
  });
  assert.deepEqual(applyChatActivityItemPreferences([olderBackfill], preferences), []);
});

test("finished activity created after the clear horizon remains visible", () => {
  const newer = activityItem("newer", "2026-07-11T08:00:00.000Z");

  const filtered = applyChatActivityItemPreferences([newer], {
    clearedRecentThroughByGroup: { "conversation-1:id:member-1": "2026-07-11T07:30:00.000Z" }
  });

  assert.deepEqual(filtered.map((item) => item.id), [newer.id]);
});

test("clearing one member's finished row leaves another member's older row in the same chat", () => {
  const cleared = activityItem("cleared", "2026-07-11T07:00:00.000Z");
  const otherMember = activityItem("other-member", "2026-07-11T06:00:00.000Z", { participantId: "member-2" });

  const preferences = chatActivityItemPreferencesAfterClear(
    { readItemIds: new Set(), clearedItemIds: new Set() },
    [cleared, otherMember],
    cleared.id
  );

  assert.deepEqual(
    applyChatActivityItemPreferences([otherMember], preferences).map((item) => item.id),
    [otherMember.id]
  );
});

test("clearing the last finished row of one chat leaves older rows of another chat visible", () => {
  const cleared = activityItem("cleared", "2026-07-11T07:00:00.000Z");
  const otherChat = activityItem("other-chat", "2026-07-05T07:00:00.000Z", { conversationId: "conversation-2" });

  const preferences = chatActivityItemPreferencesAfterClear(
    { readItemIds: new Set(), clearedItemIds: new Set() },
    [cleared],
    cleared.id
  );

  assert.deepEqual(
    applyChatActivityItemPreferences([otherChat], preferences).map((item) => item.id),
    [otherChat.id]
  );
});

test("clear horizon follows a future-dated item and hides older backfill", () => {
  const futureDated = activityItem("future", "2026-07-11T09:00:00.000Z");
  const olderBackfill = activityItem("older", "2026-07-11T08:00:00.000Z");
  const preferences = chatActivityItemPreferencesAfterClear(
    { readItemIds: new Set(), clearedItemIds: new Set() },
    [futureDated],
    futureDated.id
  );

  assert.equal(preferences.clearedRecentThroughByGroup?.["conversation-1:id:member-1"], futureDated.updatedAt);
  assert.deepEqual(applyChatActivityItemPreferences([olderBackfill], preferences), []);
});

test("clear horizon never moves backward", () => {
  const item = activityItem("item", "2026-07-11T08:00:00.000Z");
  const existingHorizon = "2026-07-11T09:00:00.000Z";
  const preferences = chatActivityItemPreferencesAfterClear(
    {
      readItemIds: new Set(),
      clearedItemIds: new Set(),
      clearedRecentThroughByGroup: { "conversation-1:id:member-1": existingHorizon }
    },
    [item],
    item.id
  );

  assert.equal(preferences.clearedRecentThroughByGroup?.["conversation-1:id:member-1"], existingHorizon);
});

test("clearing a pending row does not create a finished clear horizon", () => {
  const pending: ChatActivityItem = { ...activityItem("pending", "2026-07-11T08:00:00.000Z"), status: "pending", kind: "choice" };

  const preferences = chatActivityItemPreferencesAfterClear(
    { readItemIds: new Set(), clearedItemIds: new Set() },
    [pending],
    pending.id
  );

  assert.equal(preferences.clearedRecentThroughByGroup, undefined);
  assert.ok(preferences.clearedItemIds.has(pending.id));
});

function activityItem(
  id: string,
  updatedAt: string,
  options: { conversationId?: string; participantId?: string } = {}
): ChatActivityItem {
  const conversationId = options.conversationId ?? "conversation-1";
  const participantId = options.participantId ?? "member-1";
  return {
    id,
    conversationId,
    conversationTitle: "Activity",
    status: "recent",
    kind: "message",
    title: id,
    preview: id,
    createdAt: updatedAt,
    updatedAt,
    participant: { id: participantId, handle: participantId, kind: "claude-code" },
    target: { messageId: id }
  };
}

test("the legacy global clear cutoff keeps pre-upgrade rows hidden and never grows", () => {
  const olderThanUpgrade = activityItem("older", "2026-07-10T07:00:00.000Z");
  const afterUpgrade = activityItem("newer", "2026-07-12T07:00:00.000Z", { participantId: "member-2" });
  const legacy = { readItemIds: new Set<string>(), clearedItemIds: new Set<string>(), clearedRecentThroughBefore: "2026-07-11T00:00:00.000Z" };

  assert.deepEqual(
    applyChatActivityItemPreferences([olderThanUpgrade, afterUpgrade], legacy).map((item) => item.id),
    [afterUpgrade.id]
  );

  const preferences = chatActivityItemPreferencesAfterClear(legacy, [afterUpgrade], afterUpgrade.id);
  assert.equal(preferences.clearedRecentThroughBefore, "2026-07-11T00:00:00.000Z");
  assert.deepEqual(Object.keys(preferences.clearedRecentThroughByGroup ?? {}), ["conversation-1:id:member-2"]);
});

test("clearing a group again keeps its horizon when the bounded store evicts the oldest", () => {
  let preferences = { readItemIds: new Set<string>(), clearedItemIds: new Set<string>() } as Parameters<typeof chatActivityItemPreferencesAfterClear>[0];
  for (let index = 0; index < MAX_CHAT_ACTIVITY_CLEAR_HORIZONS; index += 1) {
    const item = activityItem(`filler-${index}`, "2026-07-11T07:00:00.000Z", { participantId: `member-${index}` });
    preferences = chatActivityItemPreferencesAfterClear(preferences, [item], item.id);
  }
  const firstGroupAgain = activityItem("first-again", "2026-07-11T09:00:00.000Z", { participantId: "member-0" });

  preferences = chatActivityItemPreferencesAfterClear(preferences, [firstGroupAgain], firstGroupAgain.id);

  const horizons = preferences.clearedRecentThroughByGroup ?? {};
  assert.equal(Object.keys(horizons).length, MAX_CHAT_ACTIVITY_CLEAR_HORIZONS);
  assert.equal(horizons["conversation-1:id:member-0"], firstGroupAgain.updatedAt);
});
