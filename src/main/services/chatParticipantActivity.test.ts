import assert from "node:assert/strict";
import test from "node:test";
import { buildChatParticipantActivitySnapshot } from "../../shared/chatParticipantActivity";
import { remoteAppMcpToolContracts } from "../../shared/appMcpToolContracts";
import type {
  ChatAppToolApproval,
  ChatMessage,
  ChatParticipant,
  ChatParticipantRequestBatch,
  ChatParticipantRequestStatus,
  ChatParticipantSession,
  Conversation
} from "../../shared/types";
import {
  APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL,
  AppMcpService
} from "./appMcp";
import { ChatService } from "./chat";

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
    activeRunOwnersByRunId: {
      "compact-run": {
        processId: 42,
        startedAt: "2026-07-31T08:49:50.000Z",
        updatedAt: "2026-07-31T08:50:45.000Z"
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
    lastActivityAt: "2026-07-31T08:50:45.000Z"
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
  const mentionWork = awaitingActivity.activeWork.find((work) =>
    work.kind === "approval" && work.approvalType === "pending_mention"
  );
  assert.deepEqual(mentionWork?.approvalDependency, {
    type: "user",
    summary: "Approval required to notify @reviewer."
  });

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

test("participant activity reports all six roster statuses with zero-free counts", () => {
  const idle = participant("idle", "idle", "codex-cli");
  const running = participant("running", "running", "codex-cli");
  const pending = participant("pending", "pending", "claude-code");
  const compacting = participant("compacting", "compacting", "claude-code");
  const stopped = participant("stopped", "stopped", "gemini-cli");
  const failed = participant("error", "error", "gemini-cli");
  const conversation = chatConversation([idle, running, pending, compacting, stopped, failed], {
    activeRunIds: ["run-active", "compact-active"],
    activeRunParticipantIdsByRunId: {
      "run-active": running.id,
      "compact-active": compacting.id
    },
    participantCompactionsByParticipantId: {
      [compacting.id]: {
        runId: "compact-active",
        startedAt: "2026-07-31T08:40:00.000Z"
      }
    }
  });
  conversation.messages.push(
    participantMessage(pending, "choice-pending", "Choose.", {
      createdAt: "2026-07-31T08:41:00.000Z",
      metadata: {
        pendingChoice: {
          id: "choice-pending",
          title: "Choice",
          question: "Continue?",
          options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
          status: "pending"
        }
      }
    }),
    participantMessage(stopped, "stopped-output", "Stopped.", {
      createdAt: "2026-07-31T08:42:00.000Z",
      status: "error",
      metadata: { terminalReason: "user-stopped" }
    }),
    participantMessage(failed, "failed-output", "Failed.", {
      createdAt: "2026-07-31T08:43:00.000Z",
      status: "error"
    })
  );

  const snapshot = buildChatParticipantActivitySnapshot(conversation, SNAPSHOT_AT);

  assert.deepEqual(snapshot.participants.map((entry) => entry.status), [
    "idle",
    "running",
    "pending",
    "compacting",
    "stopped",
    "error"
  ]);
  assert.deepEqual(snapshot.statusCounts, {
    idle: 1,
    running: 1,
    pending: 1,
    compacting: 1,
    stopped: 1,
    error: 1
  });
  assert.equal(snapshot.hasActiveParticipants, true);
});

test("participant activity keeps multiple runs ordered and ignores unresolved run IDs", () => {
  const runner = participant("runner", "runner", "codex-cli");
  const idle = participant("idle", "idle", "claude-code");
  const conversation = chatConversation([runner, idle], {
    activeRunIds: ["run-b", "unresolved-run", "run-a"],
    activeRunParticipantIdsByRunId: {
      "run-b": runner.id,
      "run-a": runner.id
    },
    activeRunOwnersByRunId: {
      "run-a": {
        processId: 41,
        startedAt: "2026-07-31T08:40:00.000Z",
        updatedAt: "2026-07-31T08:41:00.000Z"
      },
      "run-b": {
        processId: 42,
        startedAt: "2026-07-31T08:40:00.000Z",
        updatedAt: "2026-07-31T08:42:00.000Z"
      }
    }
  });

  const snapshot = buildChatParticipantActivitySnapshot(conversation, SNAPSHOT_AT);

  assert.equal(snapshot.participants[0].status, "running");
  assert.deepEqual(snapshot.participants[0].activeWork.map((work) =>
    work.kind === "run" ? work.runId : work.kind
  ), ["run-a", "run-b"]);
  assert.deepEqual(snapshot.participants[1].activeWork, []);
  assert.equal(snapshot.participants.some((entry) => entry.activeWork.some((work) =>
    work.kind === "run" && work.runId === "unresolved-run"
  )), false);
});

test("participant activity preserves terminal request details only beside the target's own active work", () => {
  const terminalStatuses: ChatParticipantRequestStatus[] = [
    "answered",
    "completed",
    "failed",
    "denied",
    "interrupted"
  ];
  for (const terminalStatus of terminalStatuses) {
    const activeTarget = participant(`active-${terminalStatus}`, `active-${terminalStatus}`, "codex-cli");
    const idleTarget = participant(`idle-${terminalStatus}`, `idle-${terminalStatus}`, "claude-code");
    const runningTarget = participant(`running-${terminalStatus}`, `running-${terminalStatus}`, "gemini-cli");
    const requester = participant(`requester-${terminalStatus}`, `requester-${terminalStatus}`, "codex-cli");
    const activeRunId = `active-run-${terminalStatus}`;
    const runningRunId = `running-run-${terminalStatus}`;
    const conversation = chatConversation([activeTarget, idleTarget, runningTarget, requester], {
      activeRunIds: [activeRunId, runningRunId],
      activeRunParticipantIdsByRunId: {
        [activeRunId]: activeTarget.id,
        [runningRunId]: runningTarget.id
      }
    });
    const batch = participantRequestBatch(requester, runningTarget, {
      status: "running",
      itemStatus: "running"
    });
    batch.id = `request-${terminalStatus}`;
    batch.items = [
      {
        targetParticipantId: activeTarget.id,
        targetHandle: activeTarget.handle,
        prompt: "Already answered while a target remains active.",
        status: terminalStatus,
        createdAt: "2026-07-31T08:45:00.000Z",
        updatedAt: "2026-07-31T08:46:00.000Z",
        ...(terminalStatus === "failed" ? { error: "Target failed." } : {})
      },
      {
        targetParticipantId: idleTarget.id,
        targetHandle: idleTarget.handle,
        prompt: "Terminal and otherwise idle.",
        status: terminalStatus,
        createdAt: "2026-07-31T08:45:00.000Z",
        updatedAt: "2026-07-31T08:46:00.000Z"
      },
      {
        targetParticipantId: runningTarget.id,
        targetHandle: runningTarget.handle,
        prompt: "Still running.",
        status: "running",
        createdAt: "2026-07-31T08:45:00.000Z",
        updatedAt: "2026-07-31T08:47:00.000Z"
      }
    ];
    conversation.messages.push(
      participantMessage(activeTarget, `output-${terminalStatus}`, "Still finalizing.", {
        createdAt: "2026-07-31T08:44:00.000Z",
        status: "pending",
        metadata: { runId: activeRunId }
      }),
      participantMessage(runningTarget, `running-output-${terminalStatus}`, "Working.", {
        createdAt: "2026-07-31T08:44:00.000Z",
        status: "pending",
        metadata: { runId: runningRunId }
      }),
      message(`batch-${terminalStatus}`, "system", "Member request.", "2026-07-31T08:45:00.000Z", {
        participantRequest: batch
      })
    );

    const snapshot = buildChatParticipantActivitySnapshot(conversation, SNAPSHOT_AT);
    const active = snapshot.participants.find((entry) => entry.participantId === activeTarget.id);
    const idle = snapshot.participants.find((entry) => entry.participantId === idleTarget.id);
    const running = snapshot.participants.find((entry) => entry.participantId === runningTarget.id);
    const terminalWork = active?.activeWork.find((work) =>
      work.kind === "participant_request" && work.status === terminalStatus
    );

    assert.equal(active?.status, "running", terminalStatus);
    assert.equal(terminalWork?.status, terminalStatus, terminalStatus);
    assert.equal(terminalWork?.error, terminalStatus === "failed" ? "Target failed." : undefined, terminalStatus);
    assert.equal(idle?.status, "idle", terminalStatus);
    assert.deepEqual(idle?.activeWork, [], terminalStatus);
    assert.equal(running?.activeWork.some((work) =>
      work.kind === "participant_request" && work.status === "running"
    ), true, terminalStatus);
  }
});

test("participant activity returns the older complete message when newer messages are hidden or pending", () => {
  const member = participant("member", "member", "claude-code");
  const content = "complete-result:" + "x".repeat(12_000);
  const conversation = chatConversation([member]);
  conversation.messages.push(
    {
      id: "legacy-finished",
      role: "participant",
      participantId: member.id,
      participantLabel: member.handle,
      content,
      createdAt: "2026-07-31T08:40:00.000Z",
      metadata: {
        threadId: "thread-1",
        parentMessageId: "parent-1",
        chatThreadRootId: "root-1"
      }
    },
    participantMessage(member, "hidden-newer", "Hidden.", {
      createdAt: "2026-07-31T08:41:00.000Z",
      metadata: { hiddenFromTimeline: true }
    }),
    participantMessage(member, "pending-newest", "Pending.", {
      createdAt: "2026-07-31T08:42:00.000Z",
      status: "pending"
    })
  );

  const result = buildChatParticipantActivitySnapshot(conversation, SNAPSHOT_AT).participants[0];

  assert.equal(result.status, "idle");
  assert.deepEqual(result.lastFinishedMessage, {
    messageId: "legacy-finished",
    threadId: "thread-1",
    parentMessageId: "parent-1",
    chatThreadRootId: "root-1",
    sequence: 0,
    createdAt: "2026-07-31T08:40:00.000Z",
    status: "done",
    content
  });
});

test("participant activity deterministically orders message-backed approvals and mention targets", () => {
  const owner = participant("owner", "owner", "codex-cli");
  const alpha = participant("alpha", "alpha", "claude-code");
  const charlie = participant("charlie", "charlie", "gemini-cli");
  const zulu = participant("zulu", "zulu", "claude-code");
  const conversation = chatConversation([owner, alpha, charlie, zulu]);
  const createdAt = "2026-07-31T08:40:00.000Z";
  conversation.messages.push(
    participantMessage(owner, "message-b", "Notify two.", {
      createdAt,
      metadata: {
        pendingMentions: [
          { targetParticipantId: zulu.id, targetHandle: zulu.handle, status: "pending" },
          { targetParticipantId: alpha.id, targetHandle: alpha.handle, status: "pending" }
        ]
      }
    }),
    participantMessage(owner, "message-a", "Notify one.", {
      createdAt,
      metadata: {
        pendingMentions: [
          { targetParticipantId: charlie.id, targetHandle: charlie.handle, status: "pending" }
        ]
      }
    })
  );

  const work = buildChatParticipantActivitySnapshot(conversation, SNAPSHOT_AT).participants[0].activeWork;

  assert.deepEqual(work.map((item) => item.messageId), ["message-a", "message-b", "message-b"]);
  assert.deepEqual(work.map((item) => item.approvalDependency?.summary), [
    "Approval required to notify @charlie.",
    "Approval required to notify @alpha.",
    "Approval required to notify @zulu."
  ]);
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
  const tool = ((appMcp as any).toolsForActor(actor) as Array<Record<string, any>>)
    .find((item) => item.name === APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL);
  assert.deepEqual(tool?.inputSchema, {
    type: "object",
    additionalProperties: false,
    properties: {}
  });
  assert.deepEqual(tool?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
});

test("ChatService activity handler is actor-scoped, live past snapshotMaxSequence, and provider-detection free", async () => {
  const requester = participant("requester", "requester", "codex-cli");
  const conversation = chatConversation([requester]);
  conversation.messages.push(
    message("trigger", "user", "Start.", "2026-07-31T08:40:00.000Z"),
    participantMessage(requester, "newer-result", "Newer complete result.", {
      createdAt: "2026-07-31T08:41:00.000Z"
    })
  );
  const decoy = { ...chatConversation([requester]), id: "decoy" };
  const harness = chatServiceHarness([conversation, decoy]);
  const appMcp = new AppMcpService();
  appMcp.setChatParticipantActivityHandler((actor) =>
    harness.service.describeChatParticipantActivityForTool(actor)
  );
  const actor = {
    conversationId: conversation.id,
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0
  };

  const result = await (appMcp as any).callTool(actor, {
    name: APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL,
    arguments: {}
  });
  const snapshot = JSON.parse(result.content[0].text);

  assert.equal(snapshot.participants[0].lastFinishedMessage.messageId, "newer-result");
  assert.equal(snapshot.participants[0].lastFinishedMessage.sequence, 1);
  assert.deepEqual(harness.readConversationIds, [conversation.id]);
  assert.equal(harness.detectAgentsCalls(), 0);
});

test("ChatService activity handler rejects an actor removed from the current roster", async () => {
  const remaining = participant("remaining", "remaining", "codex-cli");
  const conversation = chatConversation([remaining]);
  const harness = chatServiceHarness([conversation]);

  await assert.rejects(
    () => harness.service.describeChatParticipantActivityForTool({
      conversationId: conversation.id,
      participantId: "removed",
      roleConfigId: "engineer",
      roleConfigVersion: 1,
      capabilities: []
    }),
    /requesting member is no longer in this chat/
  );
});

test("activity snapshot stays roster-consistent while request-status explicitly reconciles an orphan", async () => {
  const runner = participant("runner", "runner", "codex-cli");
  const target = participant("target", "target", "claude-code");
  const requester = participant("requester", "requester", "gemini-cli");
  const conversation = chatConversation([runner, target, requester], {
    activeRunIds: ["unrelated-live-run"],
    activeRunParticipantIdsByRunId: { "unrelated-live-run": runner.id }
  });
  conversation.messages.push(message("request-message", "system", "Waiting.", "2026-07-31T08:40:00.000Z", {
    participantRequest: participantRequestBatch(requester, target, {
      status: "pending_approval",
      itemStatus: "pending_approval"
    })
  }));
  const harness = chatServiceHarness([conversation]);
  (harness.service as any).activeRunIds.add("unrelated-live-run");
  const actor = {
    conversationId: conversation.id,
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    roleConfigVersion: 1,
    capabilities: []
  };

  const activity = await harness.service.describeChatParticipantActivityForTool(actor);
  const before = activity.participants.find((entry) => entry.participantId === target.id);
  const explicit = await harness.service.participantRequestStatusForTool(actor, { requestId: "request-1" });
  const requests = explicit.requests as Array<{ items: Array<{ status: string }> }>;

  assert.equal(before?.status, "pending");
  assert.equal(before?.activeWork[0]?.status, "pending_approval");
  assert.equal(requests[0].items[0].status, "interrupted");
});

test("participant activity guidance is local-only and absent from detached remote role prompts", () => {
  const local = participant("local", "local", "codex-cli");
  const remote = { ...participant("remote", "remote", "claude-code"), remoteExecution: "remote" as const };
  const session = participantSession(local);
  const harness = chatServiceHarness([chatConversation([local, remote])]);

  const localInstructions = (harness.service as any).nativeRoleInstructions(local, session) as string;
  const remoteInstructions = (harness.service as any).nativeRoleInstructions(remote, {
    ...session,
    participantId: remote.id,
    participantKind: remote.kind
  }) as string;
  const remoteFallback = (harness.service as any).promptFallbackStaticInstructions(remote, {
    ...session,
    participantId: remote.id,
    participantKind: remote.kind
  }) as string;

  assert.match(localInstructions, /app_chat_get_participant_activity/);
  assert.doesNotMatch(remoteInstructions, /app_chat_get_participant_activity/);
  assert.doesNotMatch(remoteFallback, /app_chat_get_participant_activity/);
  assert.match(remoteInstructions, /app_chat_get_context/);
  assert.match(remoteInstructions, /app_chat_get_participants/);
});

test("detached worker relay does not advertise the live participant activity tool", () => {
  const names = remoteAppMcpToolContracts().map((contract) => contract.definition.name);

  assert.ok(names.includes("app_chat_get_context"));
  assert.ok(names.includes("app_chat_get_participants"));
  assert.equal(names.includes(APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL), false);
});

function chatServiceHarness(conversations: Conversation[]): {
  service: ChatService;
  readConversationIds: string[];
  detectAgentsCalls: () => number;
} {
  const stored = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const readConversationIds: string[] = [];
  let detectionCalls = 0;
  const storage = {
    getConversation: async (conversationId: string) => {
      readConversationIds.push(conversationId);
      return stored.get(conversationId);
    },
    saveConversation: async (conversation: Conversation) => {
      stored.set(conversation.id, conversation);
    }
  };
  const cliRunner = {
    detectAgents: async () => {
      detectionCalls += 1;
      return [];
    }
  };
  const debugLogs = { write: async () => undefined };
  return {
    service: new ChatService(
      storage as never,
      {} as never,
      cliRunner as never,
      debugLogs as never
    ),
    readConversationIds,
    detectAgentsCalls: () => detectionCalls
  };
}

function participantSession(member: ChatParticipant): ChatParticipantSession {
  return {
    participantId: member.id,
    sessionId: "session-1",
    roleConfigId: member.roleConfigId,
    roleConfigVersion: 1,
    participantKind: member.kind,
    roleLabel: "Engineer",
    roleInstructions: "Review and implement.",
    updatedAt: SNAPSHOT_AT
  };
}

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
