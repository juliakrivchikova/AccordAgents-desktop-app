import assert from "node:assert/strict";
import test from "node:test";
import { canCompactParticipant, type ChatParticipantRosterStatus } from "../../shared/chatParticipantStatus";
import {
  clearParticipantCompactions,
  readParticipantCompactions,
  withParticipantCompactionFinished,
  withParticipantCompactionStarted,
  withParticipantCompactionsForRunRemoved
} from "../../shared/chatRunState";

test("canCompactParticipant allows only terminal or idle statuses", () => {
  const allowed: ChatParticipantRosterStatus[] = ["idle", "stopped", "error"];
  const blocked: ChatParticipantRosterStatus[] = ["running", "pending", "compacting"];

  for (const status of allowed) {
    assert.equal(canCompactParticipant(status), true, status);
  }
  for (const status of blocked) {
    assert.equal(canCompactParticipant(status), false, status);
  }
});

test("participant compaction helpers normalize malformed metadata", () => {
  const metadata = {
    participantCompactionsByParticipantId: {
      "participant-1": { runId: " run-1 ", startedAt: " 2026-01-01T00:00:00.000Z " },
      "participant-2": { runId: "", startedAt: "2026-01-01T00:00:00.000Z" },
      "participant-3": { runId: "run-3" },
      "": { runId: "run-empty", startedAt: "2026-01-01T00:00:00.000Z" },
      "participant-4": null
    }
  };

  assert.deepEqual(readParticipantCompactions(metadata), {
    "participant-1": {
      runId: "run-1",
      startedAt: "2026-01-01T00:00:00.000Z"
    }
  });
});

test("participant compaction helpers add, remove, and clear entries", () => {
  const started = withParticipantCompactionStarted({}, "participant-1", "run-1", "2026-01-01T00:00:00.000Z");
  assert.deepEqual(readParticipantCompactions(started), {
    "participant-1": {
      runId: "run-1",
      startedAt: "2026-01-01T00:00:00.000Z"
    }
  });

  const unchanged = withParticipantCompactionFinished(started, "participant-1", "other-run");
  assert.deepEqual(readParticipantCompactions(unchanged), readParticipantCompactions(started));

  const removed = withParticipantCompactionFinished(started, "participant-1", "run-1");
  assert.deepEqual(readParticipantCompactions(removed), {});
  assert.equal("participantCompactionsByParticipantId" in removed, false);

  const twoEntries = withParticipantCompactionStarted(
    withParticipantCompactionStarted({}, "participant-1", "run-1", "2026-01-01T00:00:00.000Z"),
    "participant-2",
    "run-2",
    "2026-01-01T00:00:01.000Z"
  );
  const removedByRun = withParticipantCompactionsForRunRemoved(twoEntries, "run-1");
  assert.deepEqual(Object.keys(readParticipantCompactions(removedByRun)), ["participant-2"]);

  const cleared = clearParticipantCompactions(twoEntries);
  assert.deepEqual(readParticipantCompactions(cleared), {});
  assert.equal("participantCompactionsByParticipantId" in cleared, false);
});
