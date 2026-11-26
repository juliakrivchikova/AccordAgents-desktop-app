import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sourceText } from "./source-parts.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const conversationViewport = read("src/renderer/components/chat/use-chat-conversation-viewport.ts");
const focusNavigation = read("src/renderer/components/chat/use-chat-focus-navigation.ts");
const chatStyles = sourceText(repoRoot, "src/renderer/styles/views/chat-conversation.css");

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

test("clicking outside the focused message dismisses the highlight", () => {
  assert.match(conversationViewport, /function dismissMessageFocus/);
  assert.match(conversationViewport, /focusAttemptGenerationRef\.current \+= 1;/, "dismissal must invalidate in-flight focus retries");
  assert.match(conversationViewport, /classList\.remove\("message-focused", "message-flash", "approval-focused"\)/);
});

test("the focused message highlight does not resize virtualized rows", () => {
  assert.doesNotMatch(
    chatStyles,
    /\.chat-message\.message-focused\s*\{[^}]*padding:/s
  );
  assert.match(
    chatStyles,
    /\.chat-message\.message-focused::before\s*\{[^}]*inset:\s*-16px;/s
  );
  assert.match(
    chatStyles,
    /\.chat-message\.message-flash \.message-body\s*\{[^}]*animation:\s*none;/s
  );
});
