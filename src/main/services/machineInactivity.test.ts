import assert from "node:assert/strict";
import test from "node:test";
import type { MachineRecord } from "../../shared/machineLink";
import { MachineInactivityCheck, MACHINE_INACTIVITY_PERIOD_MS, type InactiveMachine } from "./machineInactivity";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-01T12:00:00.000Z");

function machine(id: string, patch: Partial<MachineRecord> = {}): MachineRecord {
  return { id, name: `Machine ${id}`, deviceId: `device-${id}`, pairingKey: `room-${id}`, createdAt: new Date(NOW - 60 * DAY).toISOString(), ...patch };
}

function harness(options: { machines: MachineRecord[]; connected?: string[]; acks?: Record<string, string>; answers?: Record<string, "keep" | "remove" | "active">; lastCheckAt?: string }) {
  const state = {
    now: NOW,
    lastCheckAt: options.lastCheckAt,
    asked: [] as InactiveMachine[],
    removed: [] as string[],
    machines: [...options.machines]
  };
  const check = new MachineInactivityCheck({
    listMachines: async () => state.machines,
    isConnected: (id) => (options.connected ?? []).includes(id),
    lastActiveAt: async (record) => options.acks?.[record.id],
    lastCheckAt: async () => state.lastCheckAt,
    saveLastCheckAt: async (at) => { state.lastCheckAt = at; },
    ask: async (record) => {
      state.asked.push(record);
      const answer = options.answers?.[record.id] ?? "keep";
      if (answer === "remove") { state.removed.push(record.id); state.machines = state.machines.filter((item) => item.id !== record.id); }
      return answer;
    },
    log: () => undefined,
    now: () => state.now
  });
  return { check, state };
}

test("only machines inactive for 10 days or more are asked about, and Remove removes", async () => {
  const { check, state } = harness({
    machines: [
      machine("off", { lastSeenAt: new Date(NOW - 12 * DAY).toISOString() }),
      machine("connected", { lastSeenAt: new Date(NOW - 40 * DAY).toISOString() }),
      machine("seen", { lastSeenAt: new Date(NOW - 2 * DAY).toISOString() }),
      machine("acked", { lastSeenAt: new Date(NOW - 30 * DAY).toISOString() }),
      machine("new", { createdAt: new Date(NOW - 3 * DAY).toISOString() })
    ],
    connected: ["connected"],
    acks: { acked: new Date(NOW - DAY).toISOString() },
    answers: { off: "remove" }
  });
  const result = await check.runIfDue();
  assert.deepEqual(result, { checked: true, asked: ["off"], removed: ["off"] });
  assert.equal(state.asked[0].inactiveDays, 12);
  assert.deepEqual(state.removed, ["off"]);
  assert.equal(state.lastCheckAt, new Date(NOW).toISOString());
});

test("the check runs once every 10 days whatever restarts happen, and a kept machine is asked again", async () => {
  const records = [machine("off", { lastSeenAt: new Date(NOW - 15 * DAY).toISOString() })];
  const first = harness({ machines: records, answers: { off: "keep" } });
  assert.deepEqual(await first.check.runIfDue(), { checked: true, asked: ["off"], removed: [] });
  // A restart one day later: a new instance reading the stored time.
  const restarted = harness({ machines: records, lastCheckAt: first.state.lastCheckAt });
  restarted.state.now = NOW + DAY;
  assert.deepEqual(await restarted.check.runIfDue(), { checked: false, asked: [], removed: [] });
  // Ten days after the last check it is asked about again.
  restarted.state.now = NOW + MACHINE_INACTIVITY_PERIOD_MS;
  assert.deepEqual(await restarted.check.runIfDue(), { checked: true, asked: ["off"], removed: [] });
  assert.equal(restarted.state.asked[0].inactiveDays, 25);
});

test("a machine that came back is not asked about", async () => {
  const { check } = harness({
    machines: [machine("back", { lastSeenAt: new Date(NOW - 20 * DAY).toISOString() })],
    connected: ["back"]
  });
  assert.deepEqual(await check.runIfDue(), { checked: true, asked: [], removed: [] });
});

test("a question withdrawn because the machine came back removes nothing", async () => {
  const { check, state } = harness({
    machines: [machine("back", { lastSeenAt: new Date(NOW - 20 * DAY).toISOString() })],
    answers: { back: "active" }
  });
  assert.deepEqual(await check.runIfDue(), { checked: true, asked: ["back"], removed: [] });
  assert.deepEqual(state.machines.map((item) => item.id), ["back"]);
});
