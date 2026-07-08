import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatActivityItems,
  buildChatActivityItemsForConversationUpdate,
  resolveSelectedChatActivityItem
} from "../../shared/chatActivity";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, Conversation } from "../../shared/types";

const NOW = "2026-01-08T12:00:00.000Z";
const participant: ChatParticipant = {
  id: "participant-1",
  handle: "drew-codex-engineer",
  roleConfigId: "engineer",
  kind: "codex-cli"
};
const remoteParticipant: ChatParticipant = {
  id: "participant-2",
  handle: "taylor-claude-engineer",
  roleConfigId: "engineer",
  kind: "claude-code"
};

function conversation(patch: Partial<Conversation> = {}): Conversation {
  const { metadata, ...rest } = patch;
  return {
    id: "conversation-1",
    title: "Feature chat",
    kind: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: NOW,
    messages: [],
    findings: [],
    ...rest,
    metadata: {
      participants: [participant, remoteParticipant],
      ...metadata
    }
  };
}

function participantMessage(id: string, patch: Partial<ChatMessage> = {}, target: ChatParticipant = participant): ChatMessage {
  return {
    id,
    role: "participant",
    participantId: target.id,
    participantLabel: `@${target.handle}`,
    content: `${id} content`,
    createdAt: NOW,
    status: "done",
    ...patch,
    metadata: {
      ...patch.metadata
    }
  };
}

test("buildChatActivityItems emits running items from activeRunIds and legacy runId", () => {
  const items = buildChatActivityItems(conversation({
    metadata: {
      activeRunIds: ["run-1"],
      runId: "legacy-run",
      activeRunParticipantIdsByRunId: {
        "run-1": participant.id,
        "legacy-run": remoteParticipant.id
      }
    },
    messages: [
      participantMessage("reply-1", { metadata: { runId: "run-1" } }),
      participantMessage("reply-2", { metadata: { runId: "legacy-run" } }, remoteParticipant)
    ]
  }));

  assert.deepEqual(items.map((item) => [item.status, item.kind, item.target.runId]), [
    ["running", "run", "run-1"],
    ["running", "run", "legacy-run"]
  ]);
  assert.equal(items[1].participant?.handle, "taylor-claude-engineer");
});

test("buildChatActivityItems keeps pending participant messages visible as running", () => {
  const items = buildChatActivityItems(conversation({
    messages: [
      participantMessage("pending", {
        status: "pending",
        metadata: { runId: "pending-run" }
      })
    ]
  }));

  assert.equal(items.length, 1);
  assert.equal(items[0].status, "running");
  assert.equal(items[0].target.runId, "pending-run");
  assert.equal(items[0].target.messageId, "pending");
});

test("buildChatActivityItems resolves non-terminal remote run handles", () => {
  const items = buildChatActivityItems(conversation({
    metadata: {
      activeRunIds: ["remote-run"],
      remoteRunHandles: {
        "remote-run": {
          runId: "remote-run",
          conversationId: "conversation-1",
          participantId: remoteParticipant.id,
          worker: { host: "worker.example" },
          status: "running",
          startedAt: NOW,
          updatedAt: NOW
        }
      }
    }
  }));

  assert.equal(items.length, 1);
  assert.equal(items[0].status, "running");
  assert.equal(items[0].participant?.handle, "taylor-claude-engineer");
});

test("buildChatActivityItems emits pending approval, choice, mentions, and participant request", () => {
  const approval: ChatAppToolApproval = {
    id: "approval-1",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: "engineer",
    toolName: "shell",
    capability: "permissions.request",
    status: "pending",
    request: { kind: "portable", permissions: ["webAccess"] },
    summary: "Web access requested",
    createdAt: "2026-01-08T11:00:00.000Z",
    updatedAt: "2026-01-08T11:00:00.000Z"
  };
  const items = buildChatActivityItems(conversation({
    metadata: {
      pendingAppToolApprovals: [approval]
    },
    messages: [
      participantMessage("choice", {
        createdAt: "2026-01-08T10:00:00.000Z",
        metadata: {
          pendingChoice: {
            id: "choice-1",
            title: "Choose scope",
            question: "Phase 1 or full handoff?",
            options: [{ id: "phase-1", label: "Phase 1" }],
            status: "pending"
          }
        }
      }),
      participantMessage("mention", {
        createdAt: "2026-01-08T09:00:00.000Z",
        metadata: {
          pendingMentions: [{ targetParticipantId: "p2", targetHandle: "taylor", status: "pending" }]
        }
      }),
      participantMessage("request", {
        createdAt: "2026-01-08T08:00:00.000Z",
        metadata: {
          participantRequest: {
            id: "request-1",
            requesterParticipantId: participant.id,
            requesterHandle: participant.handle,
            source: "mcp",
            resumeRequester: true,
            status: "pending_approval",
            depth: 0,
            createdAt: NOW,
            updatedAt: NOW,
            items: [{
              targetParticipantId: remoteParticipant.id,
              targetHandle: remoteParticipant.handle,
              prompt: "Review",
              status: "pending_approval",
              createdAt: NOW,
              updatedAt: NOW
            }]
          }
        }
      })
    ]
  }));

  assert.deepEqual(items.map((item) => item.kind), ["approval", "choice", "mention", "participant-request"]);
  assert.ok(items.every((item) => item.status === "pending"));
  assert.equal(items[0].target.approvalId, "approval-1");
});

test("buildChatActivityItems emits recent finished participant messages after last viewed", () => {
  const items = buildChatActivityItems(conversation({
    messages: [
      participantMessage("old", {
        createdAt: "2026-01-08T09:00:00.000Z",
        metadata: { runId: "old-run" }
      }),
      participantMessage("new", {
        createdAt: "2026-01-08T11:00:00.000Z",
        metadata: { runId: "new-run", chatThreadRootId: "root" }
      })
    ]
  }), {
    now: NOW,
    lastViewedAt: "2026-01-08T10:00:00.000Z"
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].status, "recent");
  assert.equal(items[0].target.messageId, "new");
  assert.equal(items[0].target.threadRootId, "root");
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
  assert.deepEqual(viewedItems, []);
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

test("buildChatActivityItems excludes archived and non-chat conversations", () => {
  assert.deepEqual(buildChatActivityItems(conversation({ metadata: { archived: true } })), []);
  assert.deepEqual(buildChatActivityItems(conversation({ kind: "general" })), []);
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
