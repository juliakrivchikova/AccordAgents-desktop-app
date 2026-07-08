import assert from "node:assert/strict";
import test from "node:test";
import {
  activeRunIdsForConversation,
  activeRunSummaryForConversation,
  buildChatParticipantStatusMap
} from "../../shared/chatRosterStatus";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";

const NOW = "2026-01-01T00:00:00.000Z";
const participant: ChatParticipant = {
  id: "participant-1",
  handle: "drew",
  roleConfigId: "engineer",
  kind: "codex-cli"
};
const remoteParticipant: ChatParticipant = {
  id: "participant-2",
  handle: "taylor",
  roleConfigId: "engineer",
  kind: "claude-code",
  remoteExecution: "remote"
};

function conversation(metadata: Record<string, unknown>, messages: ChatMessage[] = [], participantList: ChatParticipant[] = [participant]): Conversation {
  return {
    id: "conversation-1",
    title: "Chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    messages,
    findings: [],
    metadata: {
      participants: participantList,
      ...metadata
    }
  };
}

function participantMessage(id: string, patch: Partial<ChatMessage>, target: ChatParticipant = participant): ChatMessage {
  return {
    id,
    role: "participant",
    participantId: target.id,
    participantLabel: `@${target.handle}`,
    content: "",
    createdAt: NOW,
    status: "done",
    ...patch
  };
}

function mapEntries(map: Map<string, string>): [string, string][] {
  return Array.from(map.entries());
}

test("active run ids preserve activeRunIds, metadata runId fallback, and pending participant-message fallback", () => {
  const runIds = activeRunIdsForConversation(conversation({
    activeRunIds: ["stored-run", "stored-run"],
    runId: "legacy-run"
  }, [
    participantMessage("pending", {
      status: "pending",
      metadata: { runId: "pending-run" }
    })
  ]));

  assert.deepEqual(runIds, ["stored-run", "legacy-run", "pending-run"]);
});

test("active run summary resolves local attributed runs", () => {
  const summary = activeRunSummaryForConversation(conversation({
    activeRunIds: ["local-run"],
    activeRunParticipantIdsByRunId: {
      "local-run": participant.id
    }
  }));

  assert.deepEqual(summary.runIds, ["local-run"]);
  assert.deepEqual(mapEntries(summary.participantIdsByRunId), [["local-run", participant.id]]);
  assert.deepEqual(Array.from(summary.runIdsByParticipantId), [[participant.id, ["local-run"]]]);
  assert.deepEqual(summary.participantIds, [participant.id]);
  assert.deepEqual(summary.unresolvedRunIds, []);
});

test("active run summary resolves only nonterminal remote handles", () => {
  const summary = activeRunSummaryForConversation(conversation({
    activeRunIds: ["remote-run", "done-run", "failed-run", "cancelled-run"],
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: remoteParticipant.id,
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      },
      "done-run": {
        runId: "done-run",
        conversationId: "conversation-1",
        participantId: remoteParticipant.id,
        worker: { host: "worker.example" },
        status: "completed",
        startedAt: NOW,
        updatedAt: NOW
      },
      "failed-run": {
        runId: "failed-run",
        conversationId: "conversation-1",
        participantId: remoteParticipant.id,
        worker: { host: "worker.example" },
        status: "failed",
        startedAt: NOW,
        updatedAt: NOW
      },
      "cancelled-run": {
        runId: "cancelled-run",
        conversationId: "conversation-1",
        participantId: remoteParticipant.id,
        worker: { host: "worker.example" },
        status: "cancelled",
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  }, [], [participant, remoteParticipant]));

  assert.deepEqual(mapEntries(summary.participantIdsByRunId), [["remote-run", remoteParticipant.id]]);
  assert.deepEqual(summary.participantIds, [remoteParticipant.id]);
  assert.deepEqual(summary.unresolvedRunIds, ["done-run", "failed-run", "cancelled-run"]);
});

test("active run summary resolves compatibility runId-only metadata", () => {
  const summary = activeRunSummaryForConversation(conversation({
    runId: "legacy-run",
    activeRunParticipantIdsByRunId: {
      "legacy-run": participant.id
    }
  }));

  assert.deepEqual(summary.runIds, ["legacy-run"]);
  assert.deepEqual(summary.participantIds, [participant.id]);
});

test("active run summary preserves pending-message fallback visibility", () => {
  const summary = activeRunSummaryForConversation(conversation({}, [
    participantMessage("pending", {
      status: "pending",
      metadata: { runId: "pending-run" }
    })
  ]));

  assert.deepEqual(summary.runIds, ["pending-run"]);
  assert.deepEqual(mapEntries(summary.participantIdsByRunId), [["pending-run", participant.id]]);
  assert.deepEqual(summary.participantIds, [participant.id]);
});

test("active run summary ignores stale attribution and unresolved participants", () => {
  const summary = activeRunSummaryForConversation(conversation({
    activeRunIds: ["live-run"],
    activeRunParticipantIdsByRunId: {
      "ended-run": participant.id,
      "live-run": "missing-participant"
    }
  }));

  assert.deepEqual(summary.runIds, ["live-run"]);
  assert.deepEqual(mapEntries(summary.participantIdsByRunId), []);
  assert.deepEqual(summary.participantIds, []);
  assert.deepEqual(summary.unresolvedRunIds, ["live-run"]);
});

test("active run summary deduplicates participants while preserving run mappings", () => {
  const summary = activeRunSummaryForConversation(conversation({
    activeRunIds: ["first-run", "second-run"],
    activeRunParticipantIdsByRunId: {
      "first-run": participant.id,
      "second-run": participant.id
    }
  }));

  assert.deepEqual(mapEntries(summary.participantIdsByRunId), [
    ["first-run", participant.id],
    ["second-run", participant.id]
  ]);
  assert.deepEqual(Array.from(summary.runIdsByParticipantId), [[participant.id, ["first-run", "second-run"]]]);
  assert.deepEqual(summary.participantIds, [participant.id]);
  assert.deepEqual(summary.unresolvedRunIds, []);
});

test("chat roster status marks locally attributed live runs as running without a pending bubble", () => {
  const statuses = buildChatParticipantStatusMap(conversation({
    running: true,
    runId: "run-1",
    activeRunIds: ["run-1"],
    activeRunParticipantIdsByRunId: {
      "run-1": participant.id
    }
  }));

  assert.equal(statuses.get(participant.id), "running");
});

test("chat roster status marks live remote runs as running from remote handles", () => {
  const statuses = buildChatParticipantStatusMap(conversation({
    running: true,
    runId: "remote-run",
    activeRunIds: ["remote-run"],
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  }));

  assert.equal(statuses.get(participant.id), "running");
});

test("chat roster status preserves compacting for compaction run ids", () => {
  const statuses = buildChatParticipantStatusMap(conversation({
    running: true,
    runId: "compact-run",
    activeRunIds: ["compact-run"],
    activeRunParticipantIdsByRunId: {
      "compact-run": participant.id
    },
    participantCompactionsByParticipantId: {
      [participant.id]: {
        runId: "compact-run",
        startedAt: NOW
      }
    }
  }));

  assert.equal(statuses.get(participant.id), "compacting");
});

test("chat roster status keeps compacting ahead of pending participant run fallback", () => {
  const statuses = buildChatParticipantStatusMap(conversation({
    running: true,
    runId: "compact-run",
    activeRunIds: ["compact-run"],
    participantCompactionsByParticipantId: {
      [participant.id]: {
        runId: "compact-run",
        startedAt: NOW
      }
    }
  }, [
    participantMessage("pending-compact-reply", {
      status: "pending",
      metadata: { runId: "compact-run" }
    })
  ]));

  assert.equal(statuses.get(participant.id), "compacting");
});

test("chat roster status trims pending run ids before preserving compacting", () => {
  const statuses = buildChatParticipantStatusMap(conversation({
    running: true,
    runId: "compact-run",
    activeRunIds: ["compact-run"],
    participantCompactionsByParticipantId: {
      [participant.id]: {
        runId: "compact-run",
        startedAt: NOW
      }
    }
  }, [
    participantMessage("pending-padded-compact-reply", {
      status: "pending",
      metadata: { runId: " compact-run " }
    })
  ]));

  assert.equal(statuses.get(participant.id), "compacting");
});

test("chat roster status ignores stale attribution without a live run id", () => {
  const statuses = buildChatParticipantStatusMap(conversation({
    activeRunParticipantIdsByRunId: {
      "ended-run": participant.id
    }
  }));

  assert.equal(statuses.get(participant.id), undefined);
});

test("chat roster status marks pending participant messages as running without active run metadata", () => {
  const statuses = buildChatParticipantStatusMap(conversation({}, [
    participantMessage("pending-reply", {
      status: "pending",
      metadata: { runId: "pending-run" }
    })
  ]));

  assert.equal(statuses.get(participant.id), "running");
});

test("chat roster status ignores pending participant messages without a concrete run id", () => {
  for (const [index, runId] of ["", "   "].entries()) {
    const statuses = buildChatParticipantStatusMap(conversation({}, [
      participantMessage(`pending-reply-${index}`, {
        status: "pending",
        metadata: { runId }
      })
    ]));

    assert.equal(statuses.get(participant.id), undefined, JSON.stringify(runId));
  }
});

test("chat roster status keeps pending bubble fallback for old run metadata", () => {
  const statuses = buildChatParticipantStatusMap(conversation({
    running: true,
    runId: "legacy-run",
    activeRunIds: ["legacy-run"]
  }, [
    participantMessage("pending-reply", {
      status: "pending",
      metadata: { runId: "legacy-run" }
    })
  ]));

  assert.equal(statuses.get(participant.id), "running");
});

test("chat roster status keeps terminal statuses when the run is no longer live", () => {
  const stopped = buildChatParticipantStatusMap(conversation({}, [
    participantMessage("stopped", {
      status: "error",
      content: "Stopped by user.",
      metadata: {
        runId: "stopped-run",
        terminalReason: "user-stopped"
      }
    })
  ]));
  const failed = buildChatParticipantStatusMap(conversation({}, [
    participantMessage("failed", {
      status: "error",
      content: "Failed.",
      metadata: {
        runId: "failed-run"
      }
    })
  ]));

  assert.equal(stopped.get(participant.id), "stopped");
  assert.equal(failed.get(participant.id), "error");
});
