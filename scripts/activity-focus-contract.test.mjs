import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const conversationActions = read("src/renderer/app/use-conversation-actions.ts");
const conversationViewport = read("src/renderer/components/chat/use-chat-conversation-viewport.ts");
const focusNavigation = read("src/renderer/components/chat/use-chat-focus-navigation.ts");
const app = read("src/renderer/App.tsx");
const conversationPanel = read("src/renderer/components/conversation/conversation-panel.tsx");
const activityStyles = read("src/renderer/styles/views/activity.css");
const chatStyles = read("src/renderer/styles/views/chat-conversation.css");

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

test("Activity selection focuses the exact message while Open in chat uses the regular timeline", () => {
  assert.match(conversationActions, /options\?: \{ timelineOnly\?: boolean; markViewed\?: boolean \}/);
  assert.match(conversationActions, /if \(options\.timelineOnly && threadRootId\) \{\s*return \{ messageId: threadRootId \};\s*\}/s);
  assert.equal(
    app.match(/openConversationAndFocusActivityItem\(item, \{ timelineOnly: true \}\)/g)?.length,
    1,
    "only Open in chat should request regular timeline focus"
  );
  assert.match(
    app,
    /onSelect=\{\(item\) => \{[\s\S]*?openConversationAndFocusActivityItem\(item, \{ markViewed: false \}\);[\s\S]*?\}\}/,
    "Activity row selection must preserve the selected participant message id without marking the conversation viewed"
  );
  const onSelectBlock = app.match(/onSelect=\{\(item\) => \{([\s\S]*?)\}\}\s*onMarkRead=/)?.[1] ?? "";
  assert.ok(onSelectBlock.length > 0, "expected Activity onSelect handler before onMarkRead");
  assert.doesNotMatch(
    onSelectBlock,
    /markActivityItemRead|read: true/,
    "Activity row selection must not mark items read; only the explicit Mark read action may"
  );
});

test("clicking outside the focused message dismisses the highlight and reads the finished item", () => {
  assert.match(conversationViewport, /function dismissMessageFocus/);
  assert.match(conversationViewport, /focusAttemptGenerationRef\.current \+= 1;/, "dismissal must invalidate in-flight focus retries");
  assert.match(conversationViewport, /classList\.remove\("message-focused", "message-flash"\)/);
  assert.match(conversationPanel, /onDismissMessageFocus=/);
  assert.match(
    conversationPanel,
    /selected\?\.status === "recent"[\s\S]*?markActivityItemRead\(state, selected\.id\)/,
    "dismissal marks only the selected finished item read"
  );
});

test("focused Activity highlight is shared with Chats without resizing virtualized rows", () => {
  assert.doesNotMatch(
    chatStyles,
    /\.chat-message\.message-focused\s*\{[^}]*padding:/s
  );
  assert.match(
    chatStyles,
    /\.chat-message\.message-focused::before\s*\{[^}]*inset:\s*-16px;/s
  );
  assert.doesNotMatch(activityStyles, /\.activity-detail-body \.chat-message\.message-focused/);
  assert.match(
    activityStyles,
    /\.chat-view\[data-focus-navigating="true"\] \.chat-timeline/
  );
  assert.match(
    chatStyles,
    /\.chat-message\.message-flash \.message-body\s*\{[^}]*animation:\s*none;/s
  );
});
