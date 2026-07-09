import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const conversationActions = read("src/renderer/app/use-conversation-actions.ts");
const conversationViewport = read("src/renderer/components/chat/use-chat-conversation-viewport.ts");
const focusNavigation = read("src/renderer/components/chat/use-chat-focus-navigation.ts");
const activityStyles = read("src/renderer/styles/views/activity.css");

test("Activity focus intent is registered before opening the target conversation", () => {
  const actionStart = conversationActions.indexOf("async function openConversationAndFocusActivityItem");
  const pendingIntent = conversationActions.indexOf("pending: true", actionStart);
  const openConversation = conversationActions.indexOf("await openConversationForSelection", actionStart);

  assert.ok(actionStart >= 0, "expected Activity focus action");
  assert.ok(pendingIntent > actionStart, "expected pending focus intent");
  assert.ok(pendingIntent < openConversation, "focus intent must precede conversation rendering");
  assert.doesNotMatch(conversationActions, /scheduleActivityDomFocus/);
});

test("chat viewport has one focus scroll owner", () => {
  assert.match(conversationViewport, /hasUnconsumedFocusIntent/);
  assert.match(conversationViewport, /request\.pending \|\| request\.nonce !== handledFocusNonceRef\.current/);
  assert.match(focusNavigation, /data-focus-navigating/);
  assert.match(focusNavigation, /stableFrames >= 6/);
  assert.doesNotMatch(conversationViewport, /scheduleFocusedMessageStabilization/);
  assert.doesNotMatch(conversationViewport, /scheduleScrollToRowAndFocus\(messageId, rootRowIndex\)/);
  assert.match(
    conversationViewport,
    /setSelectedThreadRootId\(rootId\);\s*scheduleFocusRenderedMessage\(messageId\);/
  );
});

test("focused Activity highlight does not resize virtualized message rows", () => {
  assert.doesNotMatch(
    activityStyles,
    /\.activity-detail-body \.chat-message\.message-focused\s*\{[^}]*padding:/s
  );
  assert.match(
    activityStyles,
    /\.activity-detail-body \.chat-message\.message-focused::before\s*\{[^}]*inset:\s*-16px;/s
  );
  assert.match(
    activityStyles,
    /\.chat-view\[data-focus-navigating="true"\] \.chat-timeline/
  );
  assert.match(
    activityStyles,
    /\.activity-detail-body \.chat-message\.message-flash \.message-body\s*\{[^}]*animation:\s*none;/s
  );
});
