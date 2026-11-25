import assert from "node:assert/strict";
import test from "node:test";
import { applyChatActivityItemPreferences, buildChatActivityItems } from "../../shared/chatActivity";
import type { ChatAppToolApproval } from "../../shared/types";
import { chatAssistant, conversation, NOW, participant, participantMessage, remoteParticipant } from "./chat/test/activityFixtures";

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
  assert.equal(items.find((item) => item.kind === "choice")?.target.sourceMessageId, "choice");
  assert.equal(items.find((item) => item.kind === "choice")?.target.choiceId, "choice-1");
  assert.equal(items.find((item) => item.kind === "mention")?.target.sourceMessageId, "mention");
  assert.deepEqual(items.find((item) => item.kind === "mention")?.target.mentionTargetParticipantIds, ["p2"]);
  assert.equal(items.find((item) => item.kind === "choice")?.preview, "choice content");
  assert.equal(items.find((item) => item.kind === "mention")?.preview, "mention content");
  assert.equal(items.find((item) => item.kind === "participant-request")?.preview, "request content");
});

test("buildChatActivityItems marks only Codex approvals as typed Activity decisions", () => {
  const ordinaryApproval: ChatAppToolApproval = {
    id: "ordinary-approval",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: "engineer",
    toolName: "app_permissions_request_change",
    capability: "permissions.request",
    status: "pending",
    request: { kind: "portable", permissions: ["webAccess"] },
    summary: "Web access requested",
    createdAt: "2026-01-08T10:00:00.000Z",
    updatedAt: "2026-01-08T10:00:00.000Z"
  };
  const codexApproval: ChatAppToolApproval = {
    ...ordinaryApproval,
    id: "codex-approval",
    toolName: "codex_auto_review_approval",
    request: {
      kind: "codexApproval",
      method: "item/commandExecution/requestApproval",
      requestId: 1,
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      action: "command",
      options: [
        { id: "decline", label: "Deny", outcome: "deny" },
        { id: "cancel", label: "Cancel turn", outcome: "cancel" }
      ]
    },
    createdAt: "2026-01-08T11:00:00.000Z",
    updatedAt: "2026-01-08T11:00:00.000Z"
  };

  const items = buildChatActivityItems(conversation({
    metadata: { pendingAppToolApprovals: [ordinaryApproval, codexApproval] }
  }));

  const codexItem = items.find((item) => item.target.approvalId === codexApproval.id);
  const ordinaryItem = items.find((item) => item.target.approvalId === ordinaryApproval.id);
  assert.equal(codexItem?.target.approvalKind, "codex");
  assert.equal(ordinaryItem?.target.approvalKind, undefined);
});

test("buildChatActivityItems keeps cancelled pending cards out of activity entirely", () => {
  const approval: ChatAppToolApproval = {
    id: "approval-1",
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
    updatedAt: "2026-01-08T11:00:00.000Z"
  };
  const items = buildChatActivityItems(conversation({
    updatedAt: "2026-01-08T11:30:00.000Z",
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
            status: "cancelled",
            cancelledAt: "2026-01-08T11:10:00.000Z"
          }
        }
      }),
      participantMessage("mention", {
        createdAt: "2026-01-08T09:00:00.000Z",
        metadata: {
          pendingMentions: [{
            targetParticipantId: "p2",
            targetHandle: "taylor",
            status: "rejected",
            rejectedAt: "2026-01-08T11:20:00.000Z"
          }]
        }
      }),
      participantMessage("finished", {
        createdAt: "2026-01-08T11:25:00.000Z",
        metadata: { runId: "finished-run" }
      })
    ]
  }), { now: NOW });

  // The cancelled approval, choice and mention cards are gone, and so are the messages that
  // carried the closed choice and mention: cancelling a card in Pending must not bring the same
  // message back under Finished (the User, 2026-10-07). Only the ordinary update remains.
  assert.deepEqual(items.map((item) => item.kind), ["message"]);
  assert.equal(items[0].target.messageId, "finished");
  assert.equal(items[0].groupedCount, undefined);
});

test("buildChatActivityItems lists a pending card once and drops its message after it is cancelled", () => {
  const choice = {
    id: "choice-1",
    title: "Choose scope",
    question: "Phase 1 or full handoff?",
    options: [{ id: "phase-1", label: "Phase 1" }]
  };
  const pending = buildChatActivityItems(conversation({
    messages: [participantMessage("asking", {
      createdAt: "2026-01-08T10:00:00.000Z",
      metadata: { runId: "run-asking", pendingChoice: { ...choice, status: "pending" } }
    })]
  }), { now: NOW });
  assert.deepEqual(pending.map((item) => [item.status, item.kind]), [["pending", "choice"]]);

  const cancelled = buildChatActivityItems(conversation({
    messages: [participantMessage("asking", {
      createdAt: "2026-01-08T10:00:00.000Z",
      metadata: { runId: "run-asking", pendingChoice: { ...choice, status: "cancelled", cancelledAt: "2026-01-08T11:00:00.000Z" } }
    })]
  }), { now: NOW });
  assert.deepEqual(cancelled, []);

  // Mentions the app closed itself (the member took a newer turn) were not declined by the User.
  const superseded = buildChatActivityItems(conversation({
    messages: [participantMessage("asking", {
      createdAt: "2026-01-08T10:00:00.000Z",
      metadata: { runId: "run-asking", pendingMentions: [{ targetParticipantId: "p2", targetHandle: "taylor", status: "rejected" }] }
    })]
  }), { now: NOW });
  assert.deepEqual(superseded.map((item) => [item.status, item.kind]), [["recent", "message"]]);

  // An answered choice is not closed business: its message stays a finished update.
  const answered = buildChatActivityItems(conversation({
    messages: [participantMessage("asking", {
      createdAt: "2026-01-08T10:00:00.000Z",
      metadata: { runId: "run-asking", pendingChoice: { ...choice, status: "selected", selectedOptionId: "phase-1" } }
    })]
  }), { now: NOW });
  assert.deepEqual(answered.map((item) => [item.status, item.kind, item.target.messageId]), [["recent", "message", "asking"]]);
});

test("buildChatActivityItems falls back to pending metadata when a pending message has no body", () => {
  const items = buildChatActivityItems(conversation({
    messages: [
      participantMessage("choice", {
        content: "",
        metadata: {
          pendingChoice: {
            id: "choice-1",
            title: "Manual Check",
            question: "Is the opened app instance acceptable?",
            options: [{ id: "accept", label: "Accept" }],
            status: "pending"
          }
        }
      }),
      participantMessage("mention", {
        content: "",
        metadata: {
          pendingMentions: [{ targetParticipantId: "p2", targetHandle: "taylor", status: "pending" }]
        }
      })
    ]
  }));

  assert.equal(items.find((item) => item.kind === "choice")?.preview, "Is the opened app instance acceptable?");
  assert.equal(items.find((item) => item.kind === "mention")?.preview, "@taylor");
});

test("buildChatActivityItems targets visible requester message for approval without trigger message", () => {
  const approval: ChatAppToolApproval = {
    id: "approval-1",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: "engineer",
    toolName: "app_roles_request_change",
    capability: "participants.manage",
    status: "pending",
    request: { kind: "portable", permissions: ["workspaceWrite"] },
    summary: "Create role \"Mathematician\"",
    createdAt: "2026-01-08T11:00:00.000Z",
    updatedAt: "2026-01-08T11:00:00.000Z"
  };
  const items = buildChatActivityItems(conversation({
    metadata: { pendingAppToolApprovals: [approval] },
    messages: [
      participantMessage("source", {
        content: "Requested a new `Mathematician` role. Please approve it in the app review card.",
        createdAt: "2026-01-08T10:59:00.000Z"
      }),
      {
        id: "hidden-system",
        role: "system",
        content: "Role approval needed from @drew-codex-engineer: Create role \"Mathematician\".",
        createdAt: "2026-01-08T11:00:00.000Z",
        status: "done",
        metadata: { threadId: "system" }
      }
    ]
  }));

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "approval");
  assert.equal(items[0].target.messageId, "source");
  assert.equal(items[0].preview, "Requested a new `Mathematician` role. Please approve it in the app review card.");
});

test("buildChatActivityItems shows the target message actor for approval activity", () => {
  const approval: ChatAppToolApproval = {
    id: "approval-1",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: "engineer",
    toolName: "app_roles_request_change",
    capability: "participants.manage",
    status: "pending",
    request: { kind: "portable", permissions: ["workspaceWrite"] },
    summary: "Create role \"Mathematician\"",
    createdAt: "2026-01-08T11:00:00.000Z",
    updatedAt: "2026-01-08T11:00:00.000Z",
    resumeContext: { runId: "approval-run", triggerMessageId: "assistant-message" }
  };
  const items = buildChatActivityItems(conversation({
    metadata: { pendingAppToolApprovals: [approval] },
    messages: [
      participantMessage("requester-message", {
        content: "Please create a role.",
        createdAt: "2026-01-08T10:58:00.000Z"
      }),
      participantMessage("assistant-message", {
        participantId: chatAssistant.id,
        participantLabel: "@admin",
        content: "Requested a new `Mathematician` role. Please approve it in the app review card.",
        createdAt: "2026-01-08T10:59:00.000Z"
      }, chatAssistant)
    ]
  }));

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "approval");
  assert.equal(items[0].target.messageId, "assistant-message");
  assert.equal(items[0].participant?.handle, "admin");
  assert.equal(items[0].participant?.roleConfigId, "administrator");
});

test("buildChatActivityItems follows hidden approval triggers to a visible source message", () => {
  const approval: ChatAppToolApproval = {
    id: "approval-hidden-trigger",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: "engineer",
    toolName: "app_roles_request_change",
    capability: "participants.manage",
    status: "pending",
    request: { kind: "portable", permissions: ["workspaceWrite"] },
    summary: "Create role",
    createdAt: "2026-01-08T11:00:00.000Z",
    updatedAt: "2026-01-08T11:00:00.000Z",
    resumeContext: { runId: "approval-run", triggerMessageId: "hidden-trigger" }
  };
  const items = buildChatActivityItems(conversation({
    metadata: { pendingAppToolApprovals: [approval] },
    messages: [
      participantMessage("visible-source", {
        content: "Visible approval request",
        createdAt: "2026-01-08T10:58:00.000Z"
      }),
      participantMessage("hidden-trigger", {
        content: "Internal trigger",
        createdAt: "2026-01-08T10:59:00.000Z",
        metadata: {
          hiddenFromTimeline: true,
          sourceMessageId: "visible-source"
        }
      })
    ]
  }));

  assert.equal(items[0]?.target.messageId, "visible-source");
  assert.equal(items[0]?.preview, "Visible approval request");
});

test("buildChatActivityItems never targets hidden internal messages", () => {
  const items = buildChatActivityItems(conversation({
    messages: [
      participantMessage("visible-source", {
        content: "Visible source message",
        createdAt: "2026-01-08T10:58:00.000Z"
      }),
      participantMessage("hidden-choice", {
        content: "Internal request wrapper",
        createdAt: "2026-01-08T10:59:00.000Z",
        metadata: {
          hiddenFromTimeline: true,
          sourceMessageId: "visible-source",
          pendingChoice: {
            id: "choice-hidden",
            title: "Internal choice",
            question: "Choose",
            options: [{ id: "yes", label: "Yes" }],
            status: "pending"
          }
        }
      }),
      participantMessage("hidden-finished", {
        content: "Internal completed wrapper",
        createdAt: "2026-01-08T11:00:00.000Z",
        metadata: {
          hiddenFromTimeline: true,
          sourceMessageId: "visible-source"
        }
      })
    ]
  }), {
    now: NOW,
    lastViewedAt: "2026-01-08T10:00:00.000Z"
  });

  assert.equal(items.find((item) => item.kind === "choice")?.target.messageId, "visible-source");
  assert.equal(items.find((item) => item.kind === "choice")?.preview, "Visible source message");
  assert.ok(items.every((item) => item.target.messageId !== "hidden-choice"));
  assert.ok(items.every((item) => item.target.messageId !== "hidden-finished"));
});

test("buildChatActivityItems keeps only newest finished item per participant in a chat", () => {
  const items = buildChatActivityItems(conversation({
    messages: [
      participantMessage("old", {
        createdAt: "2026-01-08T09:00:00.000Z",
        metadata: { runId: "old-run" }
      }),
      participantMessage("new", {
        createdAt: "2026-01-08T11:00:00.000Z",
        metadata: { runId: "new-run", chatThreadRootId: "root" }
      }),
      participantMessage("remote-old", {
        createdAt: "2026-01-08T09:30:00.000Z",
        metadata: { runId: "remote-run" }
      }, remoteParticipant),
      participantMessage("remote-newer", {
        createdAt: "2026-01-08T09:45:00.000Z",
        metadata: { runId: "remote-newer-run" }
      }, remoteParticipant)
    ]
  }), {
    now: NOW,
    lastViewedAt: "2026-01-08T10:00:00.000Z"
  });

  assert.deepEqual(items.map((item) => [
    item.status,
    item.target.messageId,
    item.participant?.handle,
    item.read
  ]), [
    ["recent", "new", "drew-codex-engineer", undefined],
    ["recent", "remote-newer", "taylor-claude-engineer", true]
  ]);
  assert.equal(items[0].target.threadRootId, "root");
});

test("buildChatActivityItems emits recent finished participant messages without a run id", () => {
  const items = buildChatActivityItems(conversation({
    messages: [participantMessage("runless-finished", {
      createdAt: "2026-01-08T11:00:00.000Z",
      metadata: {}
    })]
  }), {
    now: NOW,
    lastViewedAt: "2026-01-08T10:00:00.000Z"
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].id, "recent:conversation-1:runless-finished");
  assert.equal(items[0].target.messageId, "runless-finished");
  assert.equal(items[0].target.runId, undefined);
});

test("applyChatActivityItemPreferences persists per-item read and clear state", () => {
  const items = buildChatActivityItems(conversation({
    messages: [
      participantMessage("keep", {
        createdAt: "2026-01-08T11:00:00.000Z",
        metadata: { runId: "keep-run" }
      }),
      participantMessage("clear", {
        createdAt: "2026-01-08T10:30:00.000Z",
        metadata: { runId: "clear-run" }
      }, remoteParticipant)
    ]
  }), { now: NOW });
  const keptItem = items.find((item) => item.target.messageId === "keep");
  const clearedItem = items.find((item) => item.target.messageId === "clear");
  assert.ok(keptItem);
  assert.ok(clearedItem);

  const preferred = applyChatActivityItemPreferences(items, {
    readItemIds: new Set([keptItem.id]),
    clearedItemIds: new Set([clearedItem.id])
  });

  assert.deepEqual(preferred.map((item) => item.id), [keptItem.id]);
  assert.equal(preferred[0]?.read, true);
});

test("buildChatActivityItems excludes archived and non-chat conversations", () => {
  assert.deepEqual(buildChatActivityItems(conversation({ metadata: { archived: true } })), []);
  assert.deepEqual(buildChatActivityItems(conversation({ kind: "general" })), []);
});

test("an approval anchored to a message it is not about does not hide the newest finished row", () => {
  const approval: ChatAppToolApproval = {
    id: "approval-anchor",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: "engineer",
    toolName: "shell",
    capability: "permissions.request",
    status: "pending",
    request: { kind: "portable", permissions: ["webAccess"] },
    summary: "Web access requested",
    createdAt: "2026-01-08T11:30:00.000Z",
    updatedAt: "2026-01-08T11:30:00.000Z"
  };
  const items = buildChatActivityItems(conversation({
    metadata: { pendingAppToolApprovals: [approval] },
    messages: [
      participantMessage("first", { createdAt: "2026-01-08T09:00:00.000Z", metadata: { runId: "run-1" } }),
      participantMessage("second", { createdAt: "2026-01-08T10:00:00.000Z", metadata: { runId: "run-2" } }),
      participantMessage("newest", { createdAt: "2026-01-08T11:00:00.000Z", metadata: { runId: "run-3" } })
    ]
  }), { now: NOW });

  const finished = items.find((item) => item.kind === "message");
  const pendingApproval = items.find((item) => item.kind === "approval");
  assert.equal(pendingApproval?.target.messageId, "newest");
  assert.equal(pendingApproval?.target.messageIsApproximate, true);
  assert.equal(finished?.target.messageId, "newest");
  assert.equal(finished?.groupedCount, 3);
});
