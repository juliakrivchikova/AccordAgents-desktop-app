import assert from "node:assert/strict";
import test from "node:test";
import { buildChatParticipantStatusMap } from "../../shared/chatRosterStatus";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";

const NOW = "2026-01-01T00:00:00.000Z";
const participant: ChatParticipant = {
  id: "participant-1",
  handle: "drew",
  roleConfigId: "engineer",
  kind: "codex-cli"
};

function conversation(metadata: Record<string, unknown>, messages: ChatMessage[] = []): Conversation {
  return {
    id: "conversation-1",
    title: "Chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    messages,
    findings: [],
    metadata: {
      participants: [participant],
      ...metadata
    }
  };
}

function participantMessage(id: string, patch: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "",
    createdAt: NOW,
    status: "done",
    ...patch
  };
}

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

test("chat roster status ignores stale attribution without a live run id", () => {
  const statuses = buildChatParticipantStatusMap(conversation({
    activeRunParticipantIdsByRunId: {
      "ended-run": participant.id
    }
  }));

  assert.equal(statuses.get(participant.id), undefined);
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
