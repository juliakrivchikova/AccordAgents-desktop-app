import assert from "node:assert/strict";
import test from "node:test";
import {
  applyChatActivityItemPreferences, buildChatActivityItems, chatActivityItemPreferencesAfterClear,
  buildChatActivityItemsForConversationUpdate, limitChatActivityItems, mergeChatActivityItems, preservedRecentChatActivityItems,
  reconcileChatActivityRefreshItems, resolveSelectedChatActivityItem, sortChatActivityItems
} from "../../shared/chatActivity";
import type { ChatActivityItem, ChatAppToolApproval, ChatMessage } from "../../shared/types";
import { conversation, NOW, participant, participantMessage } from "./chat/test/activityFixtures";

test("mergeChatActivityItems drops a cancelled card preserved from older renderer state", () => {
  const staleCancelled: ChatActivityItem = {
    id: "choice:conversation-1:choice-message:choice-1",
    conversationId: "conversation-1",
    conversationTitle: "Chat",
    status: "recent",
    read: true,
    kind: "choice",
    title: "Choice cancelled",
    preview: "A member choice was cancelled.",
    createdAt: "2026-01-08T10:00:00.000Z",
    updatedAt: "2026-01-08T11:10:00.000Z",
    participant: { id: participant.id, handle: participant.handle, kind: "claude-code" },
    target: { messageId: "choice-message", sourceMessageId: "choice-message", choiceId: "choice-1" }
  };
  const finished = buildChatActivityItems(conversation({
    messages: [participantMessage("finished", { createdAt: "2026-01-08T11:25:00.000Z", metadata: { runId: "finished-run" } })]
  }), { now: NOW });

  const merged = mergeChatActivityItems([staleCancelled], finished);

  assert.deepEqual(merged.map((item) => item.id), finished.map((item) => item.id));
});

test("buildChatActivityItems collapses a member's finished updates into one counted row", () => {
  const items = buildChatActivityItems(conversation({
    messages: [
      participantMessage("first", { createdAt: "2026-01-08T09:00:00.000Z", metadata: { runId: "run-1" } }),
      participantMessage("second", { createdAt: "2026-01-08T10:00:00.000Z", metadata: { runId: "run-2" } }),
      participantMessage("third", { createdAt: "2026-01-08T11:00:00.000Z", metadata: { runId: "run-3" } })
    ]
  }), { now: NOW });

  assert.equal(items.length, 1);
  assert.equal(items[0].target.messageId, "third");
  assert.equal(items[0].groupedCount, 3);
});

test("repeated merges of the same rows do not inflate the collapsed count", () => {
  const conversationWithBoth = conversation({
    messages: [
      participantMessage("first", { createdAt: "2026-01-08T09:00:00.000Z", metadata: { runId: "run-1" } }),
      participantMessage("second", { createdAt: "2026-01-08T10:00:00.000Z", metadata: { runId: "run-2" } })
    ]
  });
  const full = buildChatActivityItems(conversationWithBoth, { now: NOW });
  const olderRowOnly = buildChatActivityItems(conversation({
    messages: [participantMessage("first", { createdAt: "2026-01-08T09:00:00.000Z", metadata: { runId: "run-1" } })]
  }), { now: NOW });

  // A delta that re-supplies the older message arrives again and again; the row it folds into
  // must keep reporting two updates, not three, four, five.
  let merged = full;
  for (let round = 0; round < 4; round += 1) {
    merged = mergeChatActivityItems(merged, [...olderRowOnly, ...full]);
  }

  assert.equal(merged.length, 1);
  assert.equal(merged[0].groupedCount, 2);
});

test("a cleared update is no longer counted by the row that replaces it", () => {
  const messages = [
    participantMessage("old", { createdAt: "2026-01-08T09:00:00.000Z", metadata: { runId: "run-old" } }),
    participantMessage("new", { createdAt: "2026-01-08T11:00:00.000Z", metadata: { runId: "run-new" } })
  ];
  const [collapsed] = buildChatActivityItems(conversation({ messages: [messages[0]] }), { now: NOW });
  const preferences = chatActivityItemPreferencesAfterClear(
    { readItemIds: new Set(), clearedItemIds: new Set() },
    [collapsed],
    collapsed.id
  );

  const items = buildChatActivityItems(conversation({ messages }), { now: NOW, preferences });

  assert.equal(items.length, 1);
  assert.equal(items[0].target.messageId, "new");
  assert.equal(items[0].groupedCount, undefined);
});

test("limitChatActivityItems caps finished rows without dropping pending or running ones", () => {
  const pending = { ...syntheticItem("pending-1", "2026-01-08T11:00:00.000Z"), status: "pending" as const, kind: "choice" as const };
  const running = { ...syntheticItem("running-1", "2026-01-08T11:00:00.000Z"), status: "running" as const, kind: "run" as const };
  const finished = [1, 2, 3].map((index) => syntheticItem(`finished-${index}`, `2026-01-08T1${index}:00:00.000Z`));

  const extraPending = { ...syntheticItem("pending-2", "2026-01-08T10:00:00.000Z"), status: "pending" as const, kind: "choice" as const };

  const limited = limitChatActivityItems(sortChatActivityItems([...finished, pending, extraPending, running]), 1);

  // Each status keeps its own budget: finished rows cannot evict a waiting card, and no status
  // is exempt from a bound.
  assert.deepEqual(limited.map((item) => item.id), ["pending-1", "running-1", "finished-3"]);
});

function syntheticItem(id: string, updatedAt: string): ChatActivityItem {
  return {
    id,
    conversationId: "conversation-1",
    conversationTitle: "Chat",
    status: "recent",
    kind: "message",
    title: id,
    preview: id,
    createdAt: updatedAt,
    updatedAt,
    participant: { id: `${id}-member`, handle: id, kind: "claude-code" },
    target: { messageId: id }
  };
}

test("buildChatActivityItems surfaces an unread finished run over an older denied approval on the same run", () => {
  const approval: ChatAppToolApproval = {
    id: "approval-denied-run",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: "engineer",
    toolName: "shell",
    capability: "permissions.request",
    status: "denied",
    request: { kind: "portable", permissions: ["webAccess"] },
    summary: "Web access requested",
    createdAt: "2026-01-08T09:00:00.000Z",
    updatedAt: "2026-01-08T10:30:00.000Z",
    resumeContext: { runId: "shared-run", triggerMessageId: "finished-after-denial" }
  };
  const items = buildChatActivityItems(conversation({
    metadata: { pendingAppToolApprovals: [approval] },
    messages: [
      participantMessage("finished-after-denial", {
        createdAt: "2026-01-08T11:00:00.000Z",
        metadata: { runId: "shared-run" }
      })
    ]
  }), { now: NOW, lastViewedAt: "2026-01-08T10:00:00.000Z" });

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "message");
  assert.equal(items[0].status, "recent");
  assert.equal(items[0].target.messageId, "finished-after-denial");
  assert.equal(items[0].read, undefined);
});

test("buildChatActivityItems keeps a newer same-participant turn unread when an older turn was read", () => {
  const items = buildChatActivityItems(conversation({
    messages: [
      participantMessage("old", {
        createdAt: "2026-01-08T09:00:00.000Z",
        metadata: { runId: "old-run" }
      }),
      participantMessage("new", {
        createdAt: "2026-01-08T11:00:00.000Z",
        metadata: { runId: "new-run" }
      })
    ]
  }), {
    now: NOW,
    lastViewedAt: "2026-01-08T10:00:00.000Z"
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].target.messageId, "new");
  assert.equal(items[0].read, undefined);
});

test("buildChatActivityItems uses completion time for finished run read state", () => {
  const items = buildChatActivityItems(conversation({
    messages: [
      participantMessage("finished-after-view", {
        createdAt: "2026-01-08T10:00:00.000Z",
        metadata: {
          runId: "finished-after-view-run",
          workedMs: 60 * 60 * 1000
        }
      })
    ]
  }), {
    now: NOW,
    lastViewedAt: "2026-01-08T10:30:00.000Z"
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].status, "recent");
  assert.equal(items[0].target.messageId, "finished-after-view");
  assert.equal(items[0].createdAt, "2026-01-08T10:00:00.000Z");
  assert.equal(items[0].updatedAt, "2026-01-08T11:00:00.000Z");
  assert.equal(items[0].read, undefined);
});

test("buildChatActivityItemsForConversationUpdate treats active snapshots as viewed", () => {
  const activeSnapshot = conversation({
    messages: [
      participantMessage("finished", {
        createdAt: "2026-01-08T11:00:00.000Z",
        metadata: { runId: "finished-run" }
      })
    ]
  });
  const staleLastViewedAt = "2026-01-08T10:00:00.000Z";

  const unreadItems = buildChatActivityItemsForConversationUpdate(activeSnapshot, {
    now: NOW,
    lastViewedAt: staleLastViewedAt
  });
  const viewedItems = buildChatActivityItemsForConversationUpdate(activeSnapshot, {
    now: NOW,
    lastViewedAt: staleLastViewedAt,
    treatAsViewed: true
  });

  assert.deepEqual(unreadItems.map((item) => item.status), ["recent"]);
  assert.deepEqual(viewedItems.map((item) => item.status), ["recent"]);
  assert.equal(viewedItems[0]?.read, true);
});

test("applyChatActivityItemPreferences does not backfill older finished rows after clearing a collapsed item", () => {
  const items = buildChatActivityItems(conversation({
    messages: [
      participantMessage("old", {
        createdAt: "2026-01-08T10:30:00.000Z",
        metadata: { runId: "old-run" }
      }),
      participantMessage("new", {
        createdAt: "2026-01-08T11:00:00.000Z",
        metadata: { runId: "new-run" }
      })
    ]
  }), { now: NOW });
  assert.deepEqual(items.map((item) => item.target.messageId), ["new"]);

  const preferred = applyChatActivityItemPreferences(items, {
    clearedItemIds: new Set([items[0].id])
  });

  assert.deepEqual(preferred, []);
});

test("resolveSelectedChatActivityItem keeps a selected recent target after it is cleared from the list", () => {
  const [selected] = buildChatActivityItems(conversation({
    messages: [
      participantMessage("finished", {
        createdAt: "2026-01-08T11:00:00.000Z",
        metadata: { runId: "finished-run" }
      })
    ]
  }), {
    now: NOW,
    lastViewedAt: "2026-01-08T10:00:00.000Z"
  });
  assert.ok(selected);

  const resolved = resolveSelectedChatActivityItem([], selected);

  assert.equal(resolved?.id, selected.id);
  assert.equal(resolved?.target.messageId, "finished");
});

test("reconcileChatActivityRefreshItems preserves newer live state without marking it read", () => {
  const [liveItem] = buildChatActivityItems(conversation({
    messages: [participantMessage("live-finished", {
      createdAt: "2026-01-08T11:00:00.000Z",
      metadata: { runId: "live-run" }
    })]
  }), {
    now: NOW,
    lastViewedAt: "2026-01-08T10:00:00.000Z"
  });

  const reconciled = reconcileChatActivityRefreshItems([liveItem], [], {
    revisionsAtStart: { "conversation-1": 1 },
    revisionsNow: { "conversation-1": 2 }
  });

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, liveItem.id);
  assert.equal(reconciled[0].read, undefined);
});

test("reconcileChatActivityRefreshItems preserves only explicit read recents and drops archived rows", () => {
  const [recentItem] = buildChatActivityItems(conversation({
    messages: [participantMessage("finished", {
      createdAt: "2026-01-08T11:00:00.000Z",
      metadata: { runId: "finished-run" }
    })]
  }), {
    now: NOW,
    lastViewedAt: "2026-01-08T10:00:00.000Z"
  });
  const readItem = { ...recentItem, read: true };

  assert.deepEqual(reconcileChatActivityRefreshItems([recentItem], [], {
    revisionsAtStart: {},
    revisionsNow: {}
  }), []);
  assert.equal(reconcileChatActivityRefreshItems([readItem], [], {
    revisionsAtStart: {},
    revisionsNow: {}
  })[0]?.read, true);
  assert.deepEqual(reconcileChatActivityRefreshItems([readItem], [], {
    revisionsAtStart: {},
    revisionsNow: {},
    archivedConversationIds: new Set(["conversation-1"])
  }), []);
});

test("preservedRecentChatActivityItems drops archived live rows and only marks active rows read", () => {
  const [recentItem] = buildChatActivityItems(conversation({
    messages: [participantMessage("finished", {
      createdAt: "2026-01-08T11:00:00.000Z",
      metadata: { runId: "finished-run" }
    })]
  }), {
    now: NOW,
    lastViewedAt: "2026-01-08T10:00:00.000Z"
  });

  assert.deepEqual(preservedRecentChatActivityItems([recentItem], "conversation-1", {
    archived: true,
    treatAsRead: true
  }), []);
  assert.deepEqual(preservedRecentChatActivityItems([recentItem], "conversation-1", {
    archived: false,
    treatAsRead: false
  }), []);
  assert.equal(preservedRecentChatActivityItems([recentItem], "conversation-1", {
    archived: false,
    treatAsRead: true
  })[0]?.read, true);
});

test("buildChatActivityItems sorts by status priority and dedupes running run recents", () => {
  const items = buildChatActivityItems(conversation({
    metadata: {
      activeRunIds: ["run-1"],
      activeRunParticipantIdsByRunId: {
        "run-1": participant.id
      }
    },
    messages: [
      participantMessage("running-done", {
        createdAt: "2026-01-08T11:00:00.000Z",
        metadata: { runId: "run-1" }
      }),
      participantMessage("recent", {
        createdAt: "2026-01-08T10:00:00.000Z",
        metadata: { runId: "run-2" }
      }),
      participantMessage("choice", {
        createdAt: "2026-01-08T09:00:00.000Z",
        metadata: {
          pendingChoice: {
            id: "choice-1",
            title: "Choose",
            question: "Choose",
            options: [{ id: "yes", label: "Yes" }],
            status: "pending"
          }
        }
      })
    ]
  }), {
    now: NOW,
    lastViewedAt: "2026-01-08T08:00:00.000Z"
  });

  assert.deepEqual(items.map((item) => [item.status, item.target.runId]), [
    ["pending", undefined],
    ["running", "run-1"],
    ["recent", "run-2"]
  ]);
});

test("repeated conversation updates for an open chat do not inflate the collapsed count", () => {
  const messages: ChatMessage[] = [];
  let current: ChatActivityItem[] = [];
  for (let index = 1; index <= 5; index += 1) {
    messages.push(participantMessage(`update-${index}`, {
      createdAt: new Date(Date.parse("2026-01-08T09:00:00.000Z") + index * 60_000).toISOString(),
      metadata: { runId: `run-${index}` }
    }));
    // Mirrors the renderer: rebuild the updated chat, then merge back the preserved read rows.
    const rebuilt = buildChatActivityItemsForConversationUpdate(conversation({ messages: [...messages] }), {
      now: NOW,
      treatAsViewed: true
    });
    const preservedRead = preservedRecentChatActivityItems(current, "conversation-1", { archived: false, treatAsRead: true });
    current = mergeChatActivityItems(current, [...rebuilt, ...preservedRead], { replaceConversationId: "conversation-1" });
    assert.equal(current.length, 1);
    assert.equal(current[0].groupedCount ?? 1, index);
  }

  // The same state delivered again is not new work and must not raise the count.
  for (let round = 0; round < 3; round += 1) {
    const rebuilt = buildChatActivityItemsForConversationUpdate(conversation({ messages: [...messages] }), {
      now: NOW,
      treatAsViewed: true
    });
    const preservedRead = preservedRecentChatActivityItems(current, "conversation-1", { archived: false, treatAsRead: true });
    current = mergeChatActivityItems(current, [...rebuilt, ...preservedRead], { replaceConversationId: "conversation-1" });
    assert.equal(current[0].groupedCount, 5);
  }
});
