import assert from "node:assert/strict";
import test from "node:test";
import { decideChatEventRetention } from "./chatEventRetention";

const entry = (id: string, bytes = 100, createdAt = "2026-09-07T00:00:00.000Z") =>
  ({ eventId: id, bytes, logicalTs: `hlc:${id}`, createdAt });

test("an event is forgotten only when every roster machine has it", () => {
  const decision = decideChatEventRetention({
    entries: [entry("e1"), entry("e2")],
    roster: ["mac", "cloud-box"],
    acknowledgements: [
      { peerId: "mac", eventIds: ["e1", "e2"] },
      { peerId: "cloud-box", eventIds: ["e1"] }
    ]
  });
  assert.deepEqual(decision.releasable, ["e1"]);
  assert.deepEqual(decision.retained, [{ eventId: "e2", awaiting: ["cloud-box"] }]);
  assert.equal(decision.heldBytes, 100);
});

test("the relay forgetting is not the emitter forgetting", () => {
  // No acknowledgement at all: the relay may well have dropped these after its
  // buffer expired, and that is exactly when the emitter must still hold them.
  const decision = decideChatEventRetention({
    entries: [entry("e1"), entry("e2"), entry("e3")],
    roster: ["cloud-box"],
    acknowledgements: []
  });
  assert.deepEqual(decision.releasable, []);
  assert.equal(decision.retained.length, 3);
  assert.match(decision.warning ?? "", /cloud-box has not caught up/);
});

test("a machine that left the roster cannot hold history back", () => {
  const decision = decideChatEventRetention({
    entries: [entry("e1")],
    roster: ["mac"],
    acknowledgements: [
      { peerId: "mac", eventIds: ["e1"] },
      { peerId: "removed-machine", eventIds: [] }
    ]
  });
  assert.deepEqual(decision.releasable, ["e1"]);
  assert.deepEqual(decision.pressure, []);
  assert.equal(decision.warning, undefined);
});

test("pressure names the machine that is behind, its size and its oldest item", () => {
  const decision = decideChatEventRetention({
    entries: [
      entry("e1", 2_000_000, "2026-09-01T00:00:00.000Z"),
      entry("e2", 1_000_000, "2026-09-05T00:00:00.000Z")
    ],
    roster: ["mac", "cloud-box", "phone"],
    acknowledgements: [
      { peerId: "mac", eventIds: ["e1", "e2"] },
      { peerId: "phone", eventIds: ["e1"] }
    ],
    pressureBytes: 1_000_000
  });
  assert.equal(decision.heldBytes, 3_000_000);
  assert.equal(decision.overBudget, true);
  assert.deepEqual(decision.pressure.map((peer) => peer.peerId), ["cloud-box", "phone"]);
  assert.equal(decision.pressure[0].pendingEvents, 2);
  assert.equal(decision.pressure[0].oldestCreatedAt, "2026-09-01T00:00:00.000Z");
  assert.match(decision.warning ?? "", /cloud-box and 1 other have not caught up/);
  assert.match(decision.warning ?? "", /2\.9 MB is being kept/);
  assert.match(decision.warning ?? "", /Nothing is discarded/);
});

test("exceeding the budget is reported, never paid for by discarding an unacknowledged event", () => {
  const decision = decideChatEventRetention({
    entries: [entry("e1", 10_000_000)],
    roster: ["cloud-box"],
    acknowledgements: [],
    pressureBytes: 1
  });
  assert.equal(decision.overBudget, true);
  assert.deepEqual(decision.releasable, [], "an over-budget outbox still forgets nothing a peer has not got");
  assert.equal(decision.retained.length, 1);
});

test("an empty roster releases everything, and duplicate acknowledgements are harmless", () => {
  const released = decideChatEventRetention({ entries: [entry("e1")], roster: [], acknowledgements: [] });
  assert.deepEqual(released.releasable, ["e1"]);
  const deduped = decideChatEventRetention({
    entries: [entry("e1")],
    roster: ["mac", "mac"],
    acknowledgements: [{ peerId: "mac", eventIds: ["e1"] }, { peerId: "mac", eventIds: ["e1"] }]
  });
  assert.deepEqual(deduped.releasable, ["e1"]);
});
