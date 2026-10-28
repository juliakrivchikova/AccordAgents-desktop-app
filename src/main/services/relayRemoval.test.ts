import assert from "node:assert/strict";
import test from "node:test";
import { removeRelayEraRecords, type RelayRemovalOptions } from "./relayRemoval";
import type { RelayRemovalFailure, RelayRemovalPending, RelayRemovalRecord } from "./settings";
import type { MachinePowerHandoffRecord } from "../../shared/machinePowerHandoff";

function harness(options: { machines?: string[]; handoffs?: MachinePowerHandoffRecord[]; failOn?: string[] } = {}) {
  let recorded: RelayRemovalRecord | undefined;
  let pending: RelayRemovalPending | undefined;
  let failures: RelayRemovalFailure[] = [];
  let clock = 0;
  let machines = (options.machines ?? []).map((name, index, all) => ({ id: all.indexOf(name) === index ? `id-${name}` : `id-${name}-${index}`, name, deviceId: "", pairingKey: `rv-${name}`, createdAt: "2026-09-01T00:00:00.000Z" }));
  const handoffs = (options.handoffs ?? []).map((record) => ({ ...record }));
  const removed: string[] = [];
  let failOn = [...(options.failOn ?? [])];
  const deps: RelayRemovalOptions = {
    settings: {
      relayRemoval: async () => recorded,
      relayEraMachines: async () => machines.map((machine) => ({ ...machine })),
      beginRelayRemoval: async (found) => {
        pending = { machines: [...(pending?.machines ?? []), ...found.machines.filter((machine) => !pending?.machines.some((known) => known.id === machine.id))], startKeyHanded: Boolean(pending?.startKeyHanded) || found.startKeyHanded };
      },
      noteRelayRemovalFailures: async (next) => {
        clock += 1;
        failures = next.map((failure) => {
          const earlier = failures.find((entry) => entry.machineId === failure.machineId);
          return { ...failure, at: earlier && earlier.message === failure.message ? earlier.at : `t${clock}` };
        });
      },
      noteRelayMachinesRemoved: async (names) => { if (recorded) recorded = { ...recorded, machines: [...recorded.machines, ...names] }; },
      finishRelayRemoval: async (notRemoved) => {
        if (recorded) return undefined;
        recorded = { removedAt: "2026-10-26T00:00:00.000Z", machines: (pending?.machines ?? []).filter((machine) => !notRemoved.includes(machine.id)).map((machine) => machine.name), phones: ["iPhone"], startKeyHanded: pending?.startKeyHanded ?? false };
        pending = undefined;
        return recorded;
      }
    },
    // The usual removal settles the machine's handoffs, as main.ts does.
    removeMachine: async (id) => {
      if (failOn.includes(id)) { failOn = failOn.filter((item) => item !== id); throw new Error(`${id}: disk full`); }
      removed.push(id);
      machines = machines.filter((machine) => machine.id !== id);
      for (const record of handoffs) if (record.machineId === id) record.revokedAt = "now";
    },
    handoffs: {
      list: async () => handoffs.map((record) => ({ ...record })),
      revoke: async (handoffId) => { const record = handoffs.find((item) => item.handoffId === handoffId); if (record) record.revokedAt = "now"; }
    }
  };
  return { deps, removed, handoffs, get recorded() { return recorded; }, get failures() { return failures; },
    failNext(ids: string[]) { failOn = [...ids]; } };
}

const handoff = (machineId: string): MachinePowerHandoffRecord => ({ handoffId: `h-${machineId}`, machineId, instanceId: "i-1", issuedTo: "route-phone", issuedAt: "2026-09-01T00:00:00.000Z" });

test("a phone handed the start key of a relay machine is recorded, though removing the machine settles its record", async () => {
  const h = harness({ machines: ["Old box"], handoffs: [handoff("id-Old box"), handoff("aws-machine")] });
  const recorded = await removeRelayEraRecords(h.deps);
  assert.deepEqual(h.removed, ["id-Old box"]);
  assert.equal(recorded?.startKeyHanded, true);
  assert.ok(h.handoffs.every((record) => record.revokedAt), "every handoff is settled");
});

test("a machine that cannot be removed keeps neither the others nor the phones; it is tried again at every start", async () => {
  const h = harness({ machines: ["One", "Two", "Three"], handoffs: [handoff("aws-machine")], failOn: ["id-One", "id-Two"] });
  const recorded = await removeRelayEraRecords(h.deps);
  assert.deepEqual(h.removed, ["id-Three"], "the one after the failures is removed all the same");
  assert.deepEqual(recorded?.machines, ["Three"], "the phones, their files and the start key go at once; only what went is named");
  assert.equal(recorded?.startKeyHanded, true);
  assert.ok(h.handoffs.every((record) => record.revokedAt));
  assert.deepEqual(h.failures.map((failure) => [failure.machine, failure.message]), [["One", "id-One: disk full"], ["Two", "id-Two: disk full"]]);
  h.failNext(["id-One", "id-Two"]);
  assert.equal(await removeRelayEraRecords(h.deps), undefined, "the phones are not taken off twice");
  // A new reason replaces the earlier one, for that machine only.
  h.deps.removeMachine = async (id) => { throw new Error(id === "id-One" ? "network is down" : `${id}: disk full`); };
  await removeRelayEraRecords(h.deps);
  assert.deepEqual(h.failures.map((failure) => [failure.machine, failure.message]), [["One", "network is down"], ["Two", "id-Two: disk full"]]);
});

test("a machine removed at a later start joins the record, and its failure goes", async () => {
  const h = harness({ machines: ["One", "Two"], failOn: ["id-One"] });
  await removeRelayEraRecords(h.deps);
  assert.deepEqual(h.recorded?.machines, ["Two"]);
  assert.equal(h.failures.length, 1);
  await removeRelayEraRecords(h.deps);
  assert.deepEqual(h.removed, ["id-Two", "id-One"]);
  assert.deepEqual(h.recorded?.machines, ["Two", "One"]);
  assert.deepEqual(h.failures, []);
});

test("a machine removed at a later start is named before its failure is dropped", async () => {
  const h = harness({ machines: ["One"], failOn: ["id-One"] });
  await removeRelayEraRecords(h.deps);
  h.deps.settings.noteRelayRemovalFailures = async () => { throw new Error("Settings could not be written"); };
  await assert.rejects(removeRelayEraRecords(h.deps), /could not be written/);
  assert.deepEqual(h.recorded?.machines, ["One"], "a stop after the removal leaves it named");
});

test("the failure is kept as one short line, whatever the error looked like", async () => {
  const h = harness({ machines: ["One"] });
  h.deps.removeMachine = async () => { throw new Error(`sqlite3 failed: database is locked.\n  at /Users/someone/app/storage.js:12\n${"x".repeat(500)}`); };
  await removeRelayEraRecords(h.deps);
  assert.equal(h.failures[0]?.message, "sqlite3 failed: database is locked");
});

test("machines that cannot be read now do not keep the phones; they are taken at a later start", async () => {
  const h = harness({ machines: ["One"], handoffs: [handoff("aws-machine")] });
  const read = h.deps.settings.relayEraMachines;
  h.deps.settings.relayEraMachines = async () => { throw new Error("Machine enrollments could not be opened"); };
  const recorded = await removeRelayEraRecords(h.deps);
  assert.deepEqual(recorded?.machines, [], "the phones and the start key go");
  assert.ok(h.handoffs.every((record) => record.revokedAt));
  assert.deepEqual(h.removed, []);
  h.deps.settings.relayEraMachines = read;
  await removeRelayEraRecords(h.deps);
  assert.deepEqual(h.removed, ["id-One"]);
  assert.deepEqual(h.recorded?.machines, ["One"]);
});

test("two relay machines of the same name are told apart", async () => {
  const h = harness({ machines: ["Box", "Box"] });
  let first = true;
  h.deps.removeMachine = async () => { if (first) { first = false; throw new Error("disk full"); } };
  const recorded = await removeRelayEraRecords(h.deps);
  assert.deepEqual(recorded?.machines, ["Box"], "the one removed is named");
});
