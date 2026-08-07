import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOpaqueMobilePushPayload,
  createOpaqueMobilePushPayload
} from "../../shared/mobilePush";

test("createOpaqueMobilePushPayload emits sync-only metadata", () => {
  assert.deepEqual(createOpaqueMobilePushPayload({
    reason: "run-updated",
    conversationId: "conversation-1",
    eventId: "event-1"
  }), {
    version: 1,
    reason: "run-updated",
    conversationId: "conversation-1",
    eventId: "event-1"
  });
});

test("assertOpaqueMobilePushPayload rejects sensitive message or approval fields", () => {
  assert.throws(
    () => assertOpaqueMobilePushPayload({
      version: 1,
      reason: "approval-updated",
      approvalText: "Allow command?"
    }),
    /must not include sensitive field approvalText/
  );
  assert.throws(
    () => assertOpaqueMobilePushPayload({
      version: 1,
      reason: "sync-needed",
      messageText: "secret message"
    }),
    /must not include sensitive field messageText/
  );
});
