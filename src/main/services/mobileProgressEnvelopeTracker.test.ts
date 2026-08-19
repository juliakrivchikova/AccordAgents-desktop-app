import assert from "node:assert/strict";
import test from "node:test";

import { MobileProgressEnvelopeTracker } from "./mobileProgressEnvelopeTracker";

const PAIRING = "pairing-1";

// W-A: the previous rule filed an envelope under every pending run it carried,
// ignoring the terminal snapshots in the same envelope. A batch carrying run A's
// progress and run B's result was filed under A, so A finishing deleted it —
// and B's terminal snapshot with it. This is the case that must survive.
test("an envelope carrying a terminal snapshot is never deleted early", () => {
  const tracker = new MobileProgressEnvelopeTracker();

  assert.deepEqual(
    tracker.recordAppend(PAIRING, { eventId: "e1", pendingRunIds: ["A"], terminalRunIds: ["B"] }),
    [],
    "an append carrying a terminal deletes nothing on its own"
  );
  assert.deepEqual(
    tracker.recordAppend(PAIRING, { eventId: "e2", pendingRunIds: [], terminalRunIds: ["A"] }),
    [],
    "A terminating must not delete the envelope holding B's result"
  );
  assert.equal(tracker.trackedCount(PAIRING), 0, "an envelope holding a terminal is not tracked");
});

test("an envelope waiting on two runs is deleted only after both terminate", () => {
  const tracker = new MobileProgressEnvelopeTracker();

  tracker.recordAppend(PAIRING, { eventId: "e1", pendingRunIds: ["A", "B"], terminalRunIds: [] });

  assert.deepEqual(
    tracker.recordAppend(PAIRING, { eventId: "e2", pendingRunIds: [], terminalRunIds: ["A"] }),
    [],
    "one of the two runs finishing is not enough"
  );
  assert.equal(tracker.trackedCount(PAIRING), 1, "the envelope is still waiting on B");

  assert.deepEqual(
    tracker.recordAppend(PAIRING, { eventId: "e3", pendingRunIds: [], terminalRunIds: ["B"] }),
    ["e1"],
    "once both runs have terminated the envelope is superseded"
  );
  assert.equal(tracker.trackedCount(PAIRING), 0);
});

test("a terminal for an unknown run deletes nothing", () => {
  const tracker = new MobileProgressEnvelopeTracker();

  tracker.recordAppend(PAIRING, { eventId: "e1", pendingRunIds: ["A"], terminalRunIds: [] });
  assert.deepEqual(
    tracker.recordAppend(PAIRING, { eventId: "e2", pendingRunIds: [], terminalRunIds: ["Z"] }),
    [],
    "an unrelated run finishing is a no-op"
  );
  assert.equal(tracker.trackedCount(PAIRING), 1, "the envelope still waits on its own run");
});

test("progress envelopes are superseded by their run's terminal snapshot", () => {
  const tracker = new MobileProgressEnvelopeTracker();

  tracker.recordAppend(PAIRING, { eventId: "e1", pendingRunIds: ["A"], terminalRunIds: [] });
  tracker.recordAppend(PAIRING, { eventId: "e2", pendingRunIds: ["A"], terminalRunIds: [] });
  assert.deepEqual(
    tracker.recordAppend(PAIRING, { eventId: "e3", pendingRunIds: [], terminalRunIds: ["A"] }),
    ["e1", "e2"],
    "both progress envelopes are deleted when the run finishes"
  );
});

test("an append never supersedes itself", () => {
  const tracker = new MobileProgressEnvelopeTracker();

  // Same batch carries a run's last progress and its terminal snapshot.
  assert.deepEqual(
    tracker.recordAppend(PAIRING, { eventId: "e1", pendingRunIds: ["A"], terminalRunIds: ["A"] }),
    [],
    "the envelope just appended is never in its own deletion list"
  );
  assert.equal(tracker.trackedCount(PAIRING), 0);
});

test("tracking is per pairing and drops on unpair", () => {
  const tracker = new MobileProgressEnvelopeTracker();

  tracker.recordAppend("pairing-a", { eventId: "e1", pendingRunIds: ["A"], terminalRunIds: [] });
  tracker.recordAppend("pairing-b", { eventId: "e2", pendingRunIds: ["A"], terminalRunIds: [] });

  assert.deepEqual(
    tracker.recordAppend("pairing-a", { eventId: "e3", pendingRunIds: [], terminalRunIds: ["A"] }),
    ["e1"],
    "one pairing's terminal never deletes another pairing's envelope"
  );
  assert.equal(tracker.trackedCount("pairing-b"), 1);

  tracker.forgetPairing("pairing-b");
  assert.equal(tracker.trackedCount("pairing-b"), 0, "unpairing drops the pairing's tracking state");
});

test("blank run ids are ignored", () => {
  const tracker = new MobileProgressEnvelopeTracker();

  assert.deepEqual(
    tracker.recordAppend(PAIRING, { eventId: "e1", pendingRunIds: ["", "  "], terminalRunIds: [] }),
    []
  );
  assert.equal(tracker.trackedCount(PAIRING), 0, "an envelope with no identified run is not tracked");
});
