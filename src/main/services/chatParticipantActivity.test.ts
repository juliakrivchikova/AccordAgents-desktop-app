import assert from "node:assert/strict";
import test from "node:test";
import { buildChatParticipantActivitySnapshot } from "../../shared/chatParticipantActivity";
import type {
  ChatAppToolApproval,
  ChatMessage,
  ChatParticipant,
  ChatParticipantRequestBatch,
  Conversation
} from "../../shared/types";
import {
  APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL,
  AppMcpService
} from "./appMcp";
import { detachedWorkerScript } from "./remoteRuns";

const SNAPSHOT_AT = "2026-07-31T09:00:00.000Z";

test("participant activity returns roster-ordered authoritative statuses and complete finished messages", () => {
  const requester = participant("requester", "codex", "codex-cli", "gpt-5");
  const target = participant("target", "taylor", "claude-code");
  const untouched = participant("untouched", "gemini", "gemini-cli");
  const conversation = chatConversation([requester, target, untouched], {
    activeRunIds: ["requester-run"],
    activeRunParticipantIdsByRunId: {
      "requester-run": requester.id
    },
    activeRunOwnersByRunId: {
      "requester-run": {
        processId: 42,
        startedAt: "2026-07-31T08:58:00.000Z",
        updatedAt: "2026-07-31T08:59:30.000Z"
      }
    }
  });
  conversation.messages.push(
    message("origin", "user", "Please continue.", "2026-07-31T08:57:00.000Z"),
    participantMessage(target, "finished", "I’m continuing, but no operation remains.", {
      createdAt: "2026-07-31T08:57:30.000Z"
    }),
    participantMessage(requester, "requester-output", "Working", {
      createdAt: "2026-07-31T08:58:00.000Z",
      status: "pending",
      metadata: {
        runId: "requester-run",
        sourceMessageId: "origin",
        threadId: "main",
        activityEvents: [{
          id: "activity-1",
          sequence: 0,
          kind: "tool",
          label: "Inspecting",
          createdAt: "2026-07-31T08:59:45.000Z"
        }]
      }
    }),
    message("resuming-batch", "system", "Resuming requester.", "2026-07-31T08:59:00.000Z", {
      participantRequest: participantRequestBatch(requester, target, {
        status: "resuming_requester",
        itemStatus: "answered"
      }),
      sourceMessageId: "origin"
    })
  );

  const snapshot = buildChatParticipantActivitySnapshot(conversation, SNAPSHOT_AT);

  assert.deepEqual(Object.keys(snapshot), [
    "snapshotAt",
    "hasActiveParticipants",
    "statusCounts",
    "participants"
  ]);
  assert.deepEqual(snapshot.participants.map((entry) => entry.participantId), [
    requester.id,
    target.id,
    untouched.id
  ]);
  assert.equal(snapshot.snapshotAt, SNAPSHOT_AT);
  assert.equal(snapshot.hasActiveParticipants, true);
  assert.deepEqual(snapshot.statusCounts, {
    idle: 2,
    running: 1,
    pending: 0,
    compacting: 0,
    stopped: 0,
    error: 0
  });

  const requesterActivity = snapshot.participants[0];
  assert.equal(requesterActivity.provider, "codex-cli");
  assert.equal(requesterActivity.model, "gpt-5");
  assert.equal(requesterActivity.status, "running");
  assert.deepEqual(requesterActivity.activeWork.map((work) => work.kind), [
    "participant_request",
    "run"
  ]);
  const runWork = requesterActivity.activeWork.find((work) => work.kind === "run");
  const requestWork = requesterActivity.activeWork.find((work) => work.kind === "participant_request");
  assert.deepEqual(runWork, {
    kind: "run",
    status: "running",
    runId: "requester-run",
    messageId: "origin",
    threadId: "main",
    startedAt: "2026-07-31T08:58:00.000Z",
    lastActivityAt: "2026-07-31T08:59:45.000Z"
  });
  assert.equal(requestWork?.status, "resuming_requester");
  assert.equal(requesterActivity.lastFinishedMessage, null);

  const targetActivity = snapshot.participants[1];
  assert.equal(targetActivity.status, "idle", "finished text must not infer activity");
  assert.deepEqual(targetActivity.activeWork, [], "resuming_requester must not be attributed to the target");
  assert.deepEqual(targetActivity.lastFinishedMessage, {
    messageId: "finished",
    sequence: 1,
    createdAt: "2026-07-31T08:57:30.000Z",
    status: "done",
    content: "I’m continuing, but no operation remains."
  });
  assert.equal(snapshot.participants[2].model, null);
  assert.equal(snapshot.participants[2].lastFinishedMessage, null);
});

test("participant activity projects compaction, requests, approvals, and terminal state without duplicate runs", () => {
  const compacting = participant("compacting", "compactor", "codex-cli");
  const requested = participant("requested", "reviewer", "claude-code");
  const awaiting = participant("awaiting", "chooser", "gemini-cli");
  const failed = participant("failed", "failed", "codex-cli");
  const approval = appToolApproval(awaiting);
  const conversation = chatConversation([compacting, requested, awaiting, failed], {
    activeRunIds: ["compact-run"],
    activeRunParticipantIdsByRunId: {
      "compact-run": compacting.id
    },
    participantCompactionsByParticipantId: {
      [compacting.id]: {
        runId: "compact-run",
        startedAt: "2026-07-31T08:50:00.000Z"
      }
    },
    pendingAppToolApprovals: [approval]
  });
  conversation.messages.push(
    participantMessage(compacting, "compact-output", "", {
      createdAt: "2026-07-31T08:50:00.000Z",
      status: "pending",
      metadata: { runId: "compact-run" }
    }),
    message("request", "system", "Waiting.", "2026-07-31T08:51:00.000Z", {
      participantRequest: participantRequestBatch(awaiting, requested, {
        status: "pending_approval",
        itemStatus: "pending_approval"
      }),
      threadId: "request-thread",
      chatThreadRootId: "request-root"
    }),
    participantMessage(awaiting, "choice", "Choose a path.", {
      createdAt: "2026-07-31T08:52:00.000Z",
      metadata: {
        pendingChoice: {
          id: "choice-1",
          title: "Path",
          question: "Which path?",
          options: [
            { id: "one", label: "One" },
            { id: "two", label: "Two" }
          ],
          status: "pending"
        },
        pendingMentions: [{
          targetParticipantId: requested.id,
          targetHandle: requested.handle,
          status: "pending"
        }]
      }
    }),
    participantMessage(failed, "hidden-failure", "internal", {
      createdAt: "2026-07-31T08:53:00.000Z",
      status: "error",
      metadata: { hiddenFromTimeline: true }
    }),
    participantMessage(failed, "visible-failure", "Complete failure text.", {
      createdAt: "2026-07-31T08:52:30.000Z",
      status: "error",
      metadata: {
        terminalReason: "user-stopped",
        threadId: "failure-thread",
        parentMessageId: "parent",
        chatThreadRootId: "root"
      }
    })
  );

  const snapshot = buildChatParticipantActivitySnapshot(conversation, SNAPSHOT_AT);
  const compactingActivity = snapshot.participants[0];
  assert.equal(compactingActivity.status, "compacting");
  assert.equal(compactingActivity.activeWork.length, 1);
  assert.deepEqual(compactingActivity.activeWork[0], {
    kind: "compaction",
    status: "running",
    phase: "compacting",
    runId: "compact-run",
    messageId: "compact-output",
    startedAt: "2026-07-31T08:50:00.000Z",
    lastActivityAt: "2026-07-31T08:50:00.000Z"
  });

  const requestedActivity = snapshot.participants[1];
  assert.equal(requestedActivity.status, "pending");
  assert.equal(requestedActivity.activeWork.length, 1);
  assert.deepEqual(requestedActivity.activeWork[0], {
    kind: "participant_request",
    status: "pending_approval",
    requestId: "request-1",
    messageId: "request",
    threadId: "request-thread",
    chatThreadRootId: "request-root",
    startedAt: "2026-07-31T08:51:00.000Z",
    lastActivityAt: "2026-07-31T08:51:30.000Z",
    approvalDependency: {
      type: "user",
      summary: "Approval required to request @reviewer."
    }
  });

  const awaitingActivity = snapshot.participants[2];
  assert.equal(awaitingActivity.status, "pending");
  assert.deepEqual(
    awaitingActivity.activeWork.map((work) =>
      work.kind === "approval" ? work.approvalType : work.kind
    ),
    ["app_tool", "pending_mention", "pending_choice"]
  );

  const failedActivity = snapshot.participants[3];
  assert.equal(failedActivity.status, "stopped");
  assert.deepEqual(failedActivity.activeWork, []);
  assert.deepEqual(failedActivity.lastFinishedMessage, {
    messageId: "visible-failure",
    threadId: "failure-thread",
    parentMessageId: "parent",
    chatThreadRootId: "root",
    sequence: 4,
    createdAt: "2026-07-31T08:52:30.000Z",
    status: "error",
    terminalReason: "user-stopped",
    content: "Complete failure text."
  });
});

test("participant activity leaves stale request state roster-consistent during unrelated live work", () => {
  const runner = participant("runner", "runner", "codex-cli");
  const orphanedTarget = participant("orphan", "orphan", "claude-code");
  const requester = participant("requester", "requester", "gemini-cli");
  const conversation = chatConversation([runner, orphanedTarget, requester], {
    activeRunIds: ["unrelated-live-run"],
    activeRunParticipantIdsByRunId: {
      "unrelated-live-run": runner.id
    }
  });
  conversation.messages.push(
    participantMessage(runner, "live", "running", {
      createdAt: "2026-07-31T08:55:00.000Z",
      status: "pending",
      metadata: { runId: "unrelated-live-run" }
    }),
    message("orphan-request", "system", "Waiting.", "2026-07-31T08:54:00.000Z", {
      participantRequest: participantRequestBatch(requester, orphanedTarget, {
        status: "pending_approval",
        itemStatus: "pending_approval"
      })
    })
  );

  const snapshot = buildChatParticipantActivitySnapshot(conversation, SNAPSHOT_AT);
  const orphan = snapshot.participants.find((entry) => entry.participantId === orphanedTarget.id);

  assert.equal(orphan?.status, "pending");
  assert.equal(orphan?.activeWork[0]?.kind, "participant_request");
  assert.equal(orphan?.activeWork[0]?.status, "pending_approval");
});

test("participant activity preserves remote run phase, native status, timestamps, and errors", () => {
  const remote = participant("remote", "remote", "codex-cli");
  const conversation = chatConversation([remote], {
    activeRunIds: ["remote-run"],
    activeRunParticipantIdsByRunId: {
      "remote-run": remote.id
    },
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: remote.id,
        worker: { host: "worker.example" },
        status: "unknown",
        startedAt: "2026-07-31T08:40:00.000Z",
        updatedAt: "2026-07-31T08:42:00.000Z",
        lastPolledAt: "2026-07-31T08:43:00.000Z",
        error: "Worker heartbeat unavailable."
      }
    }
  });
  conversation.messages.push(participantMessage(remote, "remote-output", "Waiting", {
    createdAt: "2026-07-31T08:41:00.000Z",
    status: "pending",
    metadata: {
      runId: "remote-run",
      remoteRunStatus: {
        phase: "waiting-for-approval",
        label: "Waiting for approval",
        startedAt: "2026-07-31T08:40:30.000Z",
        updatedAt: "2026-07-31T08:42:30.000Z"
      }
    }
  }));

  const snapshot = buildChatParticipantActivitySnapshot(conversation, SNAPSHOT_AT);

  assert.equal(snapshot.participants[0].status, "running");
  assert.deepEqual(snapshot.participants[0].activeWork[0], {
    kind: "run",
    status: "unknown",
    phase: "waiting-for-approval",
    runId: "remote-run",
    messageId: "remote-output",
    startedAt: "2026-07-31T08:40:00.000Z",
    lastActivityAt: "2026-07-31T08:43:00.000Z",
    error: "Worker heartbeat unavailable."
  });
});

test("terminal and idle roster states do not make the snapshot active", () => {
  const stopped = participant("stopped", "stopped", "codex-cli");
  const idle = participant("idle", "idle", "claude-code");
  const conversation = chatConversation([stopped, idle]);
  conversation.messages.push(participantMessage(stopped, "stopped-message", "Stopped.", {
    createdAt: "2026-07-31T08:45:00.000Z",
    status: "error",
    metadata: { terminalReason: "user-stopped" }
  }));

  const snapshot = buildChatParticipantActivitySnapshot(conversation, SNAPSHOT_AT);

  assert.equal(snapshot.hasActiveParticipants, false);
  assert.deepEqual(snapshot.statusCounts, {
    idle: 1,
    running: 0,
    pending: 0,
    compacting: 0,
    stopped: 1,
    error: 0
  });
});

test("app MCP dispatches participant activity as capability-free read-only JSON", async () => {
  const appMcp = new AppMcpService();
  const expected = {
    snapshotAt: SNAPSHOT_AT,
    hasActiveParticipants: false,
    statusCounts: {
      idle: 0,
      running: 0,
      pending: 0,
      compacting: 0,
      stopped: 0,
      error: 0
    },
    participants: []
  };
  appMcp.setChatParticipantActivityHandler(async () => expected);
  const actor = {
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: "engineer",
    roleConfigVersion: 1,
    capabilities: []
  };

  const result = await (appMcp as any).callTool(actor, {
    name: APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL,
    arguments: {}
  });
  const text = result.content[0].text;
  assert.deepEqual(JSON.parse(text), expected);
});

test("detached worker relay does not advertise the live participant activity tool", () => {
  const script = detachedWorkerScript();
  const listStart = script.indexOf('if (method === "tools/list")');
  const callStart = script.indexOf('if (method !== "tools/call")', listStart);
  const listBlock = script.slice(listStart, callStart);

  assert.ok(listStart >= 0 && callStart > listStart);
  assert.match(listBlock, /app_chat_get_context/);
  assert.match(listBlock, /app_chat_get_participants/);
  assert.doesNotMatch(listBlock, new RegExp(APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL));
});

function participant(
  id: string,
  handle: string,
  kind: ChatParticipant["kind"],
  model?: string
): ChatParticipant {
  return {
    id,
    handle,
    roleConfigId: "engineer",
    kind,
    ...(model ? { model } : {})
  };
}

function chatConversation(
  participants: ChatParticipant[],
  metadata: Record<string, unknown> = {}
): Conversation {
  return {
    id: "conversation-1",
    title: "Activity",
    kind: "chat",
    createdAt: "2026-07-31T08:00:00.000Z",
    updatedAt: SNAPSHOT_AT,
    messages: [],
    findings: [],
    metadata: {
      participants,
      ...metadata
    }
  };
}

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  createdAt: string,
  metadata?: ChatMessage["metadata"]
): ChatMessage {
  return {
    id,
    role,
    content,
    createdAt,
    ...(metadata ? { metadata } : {})
  };
}

function participantMessage(
  member: ChatParticipant,
  id: string,
  content: string,
  options: {
    createdAt: string;
    status?: ChatMessage["status"];
    metadata?: ChatMessage["metadata"];
  }
): ChatMessage {
  return {
    id,
    role: "participant",
    participantId: member.id,
    participantLabel: member.handle,
    content,
    createdAt: options.createdAt,
    status: options.status ?? "done",
    ...(options.metadata ? { metadata: options.metadata } : {})
  };
}

function participantRequestBatch(
  requester: ChatParticipant,
  target: ChatParticipant,
  options: {
    status: ChatParticipantRequestBatch["status"];
    itemStatus: ChatParticipantRequestBatch["items"][number]["status"];
  }
): ChatParticipantRequestBatch {
  return {
    id: "request-1",
    requesterParticipantId: requester.id,
    requesterHandle: requester.handle,
    source: "mcp",
    resumeRequester: true,
    status: options.status,
    depth: 0,
    createdAt: "2026-07-31T08:51:00.000Z",
    updatedAt: "2026-07-31T08:51:30.000Z",
    items: [{
      targetParticipantId: target.id,
      targetHandle: target.handle,
      prompt: "Review.",
      status: options.itemStatus,
      createdAt: "2026-07-31T08:51:00.000Z",
      updatedAt: "2026-07-31T08:51:30.000Z"
    }]
  };
}

function appToolApproval(requester: ChatParticipant): ChatAppToolApproval {
  return {
    id: "approval-1",
    conversationId: "conversation-1",
    requesterParticipantId: requester.id,
    requesterHandle: requester.handle,
    requesterRoleConfigId: requester.roleConfigId,
    toolName: "app_permissions_request_change",
    capability: "permissions.request",
    status: "pending",
    request: {
      kind: "portable",
      permissions: ["webAccess"]
    },
    summary: "Allow web access.",
    createdAt: "2026-07-31T08:49:00.000Z",
    updatedAt: "2026-07-31T08:49:30.000Z",
    resumeContext: {
      runId: "approval-run",
      triggerMessageId: "choice"
    }
  };
}
