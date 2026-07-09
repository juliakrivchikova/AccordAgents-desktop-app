import assert from "node:assert/strict";
import test from "node:test";
import { executeChatActivityFocus } from "../../shared/chatActivityFocus";

test("executeChatActivityFocus clears pending state and reports target paging failures", async () => {
  const events: string[] = [];

  const result = await executeChatActivityFocus({
    isCurrent: () => true,
    openConversation: async () => ({ id: "conversation-1" }),
    resolveTarget: () => ({ messageId: "message-1" }),
    onTargetResolved: () => events.push("resolved"),
    ensureTargetLoaded: async () => {
      throw new Error("page failed");
    },
    beforeCommit: async () => {},
    commit: () => events.push("committed"),
    clear: () => events.push("cleared"),
    fail: (error) => events.push(`failed:${(error as Error).message}`)
  });

  assert.equal(result, "failed");
  assert.deepEqual(events, ["resolved", "failed:page failed", "cleared"]);
});

test("executeChatActivityFocus prevents a stale selection from committing or clearing newer state", async () => {
  let current = true;
  const events: string[] = [];

  const result = await executeChatActivityFocus({
    isCurrent: () => current,
    openConversation: async () => ({ id: "conversation-1" }),
    resolveTarget: () => ({ messageId: "message-1" }),
    onTargetResolved: () => events.push("resolved"),
    ensureTargetLoaded: async () => {
      current = false;
      return true;
    },
    beforeCommit: async () => {
      events.push("frame");
    },
    commit: () => events.push("committed"),
    clear: () => events.push("cleared"),
    fail: () => events.push("failed")
  });

  assert.equal(result, "stale");
  assert.deepEqual(events, ["resolved"]);
});

test("executeChatActivityFocus commits only after loading and the final frame", async () => {
  const events: string[] = [];

  const result = await executeChatActivityFocus({
    isCurrent: () => true,
    openConversation: async () => ({ id: "conversation-1" }),
    resolveTarget: () => ({ messageId: "message-1" }),
    onTargetResolved: () => events.push("resolved"),
    ensureTargetLoaded: async () => {
      events.push("loaded");
      return true;
    },
    beforeCommit: async () => {
      events.push("frame");
    },
    commit: () => events.push("committed"),
    clear: () => events.push("cleared"),
    fail: () => events.push("failed")
  });

  assert.equal(result, "completed");
  assert.deepEqual(events, ["resolved", "loaded", "frame", "committed"]);
});
