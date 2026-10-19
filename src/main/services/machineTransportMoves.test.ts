import assert from "node:assert/strict";
import test from "node:test";
import { MachineTransportMover, type MachineMoveRecord, type MachinePresence, type MachineTransportMoveLink, type RelayAddresses } from "./machineTransportMoves";
import type { MachineRecord } from "../../shared/machineLink";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type { MachineActivity } from "./machineLink";

const SHARED: RelayAddresses = { relayUrl: "wss://relay.accordagents.com/v1/relay", outboxUrl: "https://relay.accordagents.com/v1/mailbox/events" };
const HUB: RelayAddresses = { relayUrl: "wss://52.72.175.0/v1/relay", outboxUrl: "https://52.72.175.0/v1/mailbox/events" };

function machine(): MachineRecord {
  return { id: "m1", name: "Cloud run", deviceId: "device-m1", pairingKey: "pk-1", createdAt: "" } as MachineRecord;
}

function pairing(addresses: RelayAddresses = SHARED): MobilePairingPackage {
  return { rendezvousId: "rv-1", stableRoutingId: "route-1", fingerprint: "cap", relaySealKeyBase64: "AAAA", ...addresses } as MobilePairingPackage;
}

function idle(): MachineActivity {
  return { machineId: "m1", connected: true, fresh: true, activeRunIds: [], pendingTerminalRunIds: [], dispatchedRunIds: [] };
}

/** A desktop's settings, a machine's link and a clock, as the mover sees
 *  them. `answer` decides what the machine says; `where` is where the
 *  machine really is. */
function world(overrides: {
  answer?: () => "moved" | "refused" | "unknown";
  moves?: MachineMoveRecord[];
  saveFails?: boolean;
  finishFails?: () => boolean;
  busyElsewhere?: () => boolean;
} = {}) {
  let clock = Date.parse("2026-10-19T10:00:00.000Z");
  const events: string[] = [];
  const state = {
    pairings: new Map<string, MobilePairingPackage>([["pk-1", pairing()]]),
    moves: [...(overrides.moves ?? [])],
    /** Where the machine is: at an address, and which run of it. */
    machineAt: SHARED.relayUrl as string | undefined,
    instanceId: "run-1",
    linkAt: SHARED.relayUrl,
    linkGreeted: true,
    /** A dead socket still seated at the old address looks present. */
    stickyFrom: false,
    probeFails: 0,
    holds: 0,
    released: 0,
    requests: 0
  };
  const link: MachineTransportMoveLink = {
    isMachineConnected: () => state.machineAt === state.linkAt,
    supportsTransportMove: () => true,
    hasTurnHold: () => state.holds > state.released,
    holdTurns: () => {
      state.holds += 1;
      events.push("hold");
      let done = false;
      return () => { if (!done) { done = true; state.released += 1; events.push("release"); } };
    },
    // Only a machine that is there answers.
    machineActivity: async () => (state.machineAt === state.linkAt ? idle() : { ...idle(), fresh: false }),
    machinePresence: (): MachinePresence => ({ relayUrl: state.linkAt,
      present: state.linkGreeted && (state.machineAt === state.linkAt || (state.stickyFrom && state.linkAt === SHARED.relayUrl)), instanceId: state.instanceId }),
    requestTransportMove: async (_id, addresses) => {
      state.requests += 1;
      events.push(`request:${state.moves.length ? "recorded" : "unrecorded"}`);
      const answer = overrides.answer?.() ?? "moved";
      if (answer !== "refused") {
        // It moved (an unknown answer may hide a move just as well).
        state.machineAt = addresses.relayUrl;
        state.instanceId = "run-2";
      }
      return answer === "moved" ? { status: "moved" } : answer === "refused" ? { status: "refused", error: "busy" } : { status: "unknown", error: "no answer" };
    },
    reconnectMachine: async (_id, next) => {
      state.linkAt = next?.relayUrl ?? state.pairings.get("pk-1")?.relayUrl ?? "";
      events.push(`reconnect:${hostOf(state.linkAt)}`);
    },
    waitForHello: async () => {
      await Promise.resolve();
      return state.machineAt === state.linkAt;
    },
    probeMachineAt: async (_id, at) => {
      events.push(`probe:${hostOf(at.relayUrl ?? "")}`);
      if (state.probeFails > 0) {
        state.probeFails -= 1;
        return false;
      }
      return state.machineAt === at.relayUrl;
    },
    refreshTrustRosters: async () => { events.push("rosters"); }
  };
  const mover = new MachineTransportMover({
    link: () => link,
    listMachines: async () => [machine()],
    getMachinePairing: async (key) => state.pairings.get(key),
    listMoves: async () => state.moves.map((record) => ({ ...record })),
    saveMove: async (record) => {
      if (overrides.saveFails) throw new Error("disk full");
      state.moves = [...state.moves.filter((item) => item.machineId !== record.machineId), record];
    },
    finishMove: async (machineId, adopt) => {
      if (overrides.finishFails?.()) throw new Error("disk full");
      if (adopt) state.pairings.set(adopt.pairingKey, adopt.pairing);
      state.moves = state.moves.filter((item) => item.machineId !== machineId);
    },
    target: async () => HUB,
    busyElsewhere: () => overrides.busyElsewhere?.() ?? false,
    ensureMailboxRegistered: async () => true,
    onMoved: () => { events.push("phones"); },
    log: (event) => { events.push(event); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    timing: { exitGraceMs: 120_000, settleMs: 150_000, settleEveryMs: 5_000 }
  });
  return { mover, link, state, events, advance: (ms: number) => { clock += ms; } };
}

function hostOf(url: string): string {
  return url ? new URL(url).host : "";
}

test("a machine that answers is moved: the move is written down first, then its pairing, link, other machines and phones follow", async () => {
  const w = world();
  await w.mover.run();
  assert.ok(w.events.includes("request:recorded"), "the record exists before the request goes out");
  assert.equal(w.state.pairings.get("pk-1")?.relayUrl, HUB.relayUrl);
  assert.deepEqual(w.state.moves, [], "settled");
  assert.equal(w.state.linkAt, HUB.relayUrl);
  assert.ok(w.events.includes("rosters"), "other machines learn its new address");
  assert.ok(w.events.includes("phones"));
  assert.equal(w.state.holds, w.state.released, "turns are let go");
  await w.mover.run();
  assert.equal(w.state.requests, 1, "a moved machine is not asked again");
});

test("a refusal settles at once and is not asked again before its time", async () => {
  const w = world({ answer: () => "refused" });
  await w.mover.run();
  assert.deepEqual(w.state.moves, []);
  assert.equal(w.state.pairings.get("pk-1")?.relayUrl, SHARED.relayUrl);
  await w.mover.run();
  assert.equal(w.state.requests, 1);
  w.advance(5 * 60_000 + 1);
  await w.mover.run();
  assert.equal(w.state.requests, 2, "asked again once the wait is over");
});

test("a move whose answer never came is found at the new address and adopted", async () => {
  const w = world({ answer: () => "unknown" });
  await w.mover.run();
  assert.ok(w.events.includes("probe:52.72.175.0"), "looked for with a separate connection");
  assert.equal(w.state.pairings.get("pk-1")?.relayUrl, HUB.relayUrl);
  assert.equal(w.state.linkAt, HUB.relayUrl);
  assert.deepEqual(w.state.moves, []);
  assert.equal(w.state.holds, w.state.released);
});

test("a machine that greets again at the old address from another run did not move; it is not undone by a timeout", async () => {
  const w = world({ answer: () => "unknown" });
  // The request never reached it; it restarted where it was.
  w.link.requestTransportMove = async () => {
    w.state.requests += 1;
    w.state.instanceId = "run-9";
    return { status: "unknown", error: "no answer" };
  };
  await w.mover.run();
  assert.ok(w.events.includes("machine.transport.move-stayed"));
  assert.deepEqual(w.state.moves, []);
  assert.equal(w.state.pairings.get("pk-1")?.relayUrl, SHARED.relayUrl, "the pairing never named the server");
  assert.equal(w.state.linkAt, SHARED.relayUrl, "the link never left");
  await w.mover.run();
  assert.equal(w.state.requests, 1, "a stayed machine waits before it is asked again");
});

test("the same run still greeting at the old address long after a moved one would have left did not move", async () => {
  const w = world();
  w.link.requestTransportMove = async () => { w.state.requests += 1; return { status: "unknown", error: "late" }; };
  await w.mover.run();
  assert.ok(w.events.includes("machine.transport.move-stayed"));
  assert.ok(w.state.holds === w.state.released);
});

test("a desktop that restarted mid-move finds the machine at the new address before anything else", async () => {
  // The record outlived the desktop; the machine moved meanwhile.
  const record: MachineMoveRecord = { machineId: "m1", pairingKey: "pk-1", from: SHARED, to: HUB, instanceId: "run-1", requestedAt: "2026-10-19T09:59:00.000Z" };
  const w = world({ moves: [record] });
  w.state.machineAt = HUB.relayUrl;
  w.state.instanceId = "run-2";
  await w.mover.run();
  assert.equal(w.state.requests, 0, "nothing is asked again");
  assert.equal(w.state.pairings.get("pk-1")?.relayUrl, HUB.relayUrl);
  assert.equal(w.state.linkAt, HUB.relayUrl);
  assert.deepEqual(w.state.moves, []);
  assert.ok(w.state.holds >= 1 && w.state.holds === w.state.released, "turns wait while the link follows it, and are let go");
});

test("a computer that slept through the move, with a dead seat left at the old address, still finds the machine moved", async () => {
  const w = world({ answer: () => "unknown" });
  w.state.stickyFrom = true;
  const request = w.link.requestTransportMove;
  w.link.requestTransportMove = async (id, addresses) => {
    const answer = await request(id, addresses);
    w.advance(10 * 60_000); // the clock jumped while asleep
    return answer;
  };
  await w.mover.run();
  assert.equal(w.events.includes("machine.transport.move-stayed"), false, "never concluded from time and a stale seat");
  assert.equal(w.state.pairings.get("pk-1")?.relayUrl, HUB.relayUrl);
  assert.equal(w.state.linkAt, HUB.relayUrl);
});

test("a look at the new address that fails is no reason to think the machine stayed", async () => {
  const w = world({ answer: () => "unknown" });
  w.state.stickyFrom = true;
  w.state.probeFails = 1000;
  const request = w.link.requestTransportMove;
  w.link.requestTransportMove = async (id, addresses) => {
    const answer = await request(id, addresses);
    w.advance(10 * 60_000);
    return answer;
  };
  await w.mover.run();
  assert.equal(w.events.includes("machine.transport.move-stayed"), false);
  assert.equal(w.state.moves.length, 1, "kept open");
  assert.equal(w.mover.isMoving("m1"), true, "its update waits while the move is open");
  w.state.probeFails = 0;
  await w.mover.run();
  assert.equal(w.state.pairings.get("pk-1")?.relayUrl, HUB.relayUrl);
  assert.equal(w.mover.isMoving("m1"), false);
});

test("an open move whose machine is nowhere waits for later passes and is never undone or repeated", async () => {
  const record: MachineMoveRecord = { machineId: "m1", pairingKey: "pk-1", from: SHARED, to: HUB, instanceId: "run-1", requestedAt: "2026-10-19T09:59:00.000Z" };
  const w = world({ moves: [record] });
  w.state.machineAt = undefined;
  await w.mover.run();
  await w.mover.run();
  assert.equal(w.state.requests, 0);
  assert.equal(w.state.moves.length, 1, "kept until the machine is found");
  assert.equal(w.state.pairings.get("pk-1")?.relayUrl, SHARED.relayUrl);
  // It comes up on the server.
  w.state.machineAt = HUB.relayUrl;
  await w.mover.run();
  assert.equal(w.state.pairings.get("pk-1")?.relayUrl, HUB.relayUrl);
  assert.deepEqual(w.state.moves, []);
});

test("a move that cannot be written down is not asked for", async () => {
  const w = world({ saveFails: true });
  await w.mover.run();
  assert.equal(w.state.requests, 0);
  assert.equal(w.state.holds, w.state.released);
});

test("a new pairing that cannot be written is written by a later pass, and the phones are told then", async () => {
  let fail = true;
  const w = world({ finishFails: () => fail });
  await w.mover.run();
  assert.equal(w.state.linkAt, HUB.relayUrl, "the link follows the machine anyway");
  assert.equal(w.state.moves.length, 1, "the record stays");
  assert.ok(!w.events.includes("phones"));
  fail = false;
  await w.mover.run();
  assert.equal(w.state.pairings.get("pk-1")?.relayUrl, HUB.relayUrl);
  assert.deepEqual(w.state.moves, []);
  assert.ok(w.events.includes("phones"));
  assert.equal(w.state.requests, 1);
});

test("an update that started while the machine's activity was asked keeps the machine", async () => {
  let updating = false;
  const w = world({ busyElsewhere: () => updating });
  const activity = w.link.machineActivity;
  w.link.machineActivity = async (id) => { updating = true; return activity(id); };
  await w.mover.run();
  assert.equal(w.state.requests, 0);
  assert.equal(w.state.holds, 0, "no hold is taken");
  assert.equal(w.mover.isMoving("m1"), false);
});

test("an open move of a machine that was removed is dropped", async () => {
  const record: MachineMoveRecord = { machineId: "gone", pairingKey: "pk-x", from: SHARED, to: HUB, requestedAt: "2026-10-19T09:59:00.000Z" };
  const w = world({ moves: [record] });
  await w.mover.run();
  assert.equal(w.state.moves.some((item) => item.machineId === "gone"), false);
});
