import assert from "node:assert/strict";
import test from "node:test";
import { relayRemovalNotice, relayRemovalNotices, removeRelayEraRecords, type RelayRemovalOptions } from "./relayRemoval";
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
      // As settings does: a machine keeps the reasons it was dismissed for.
      noteRelayRemovalFailures: async (next) => {
        clock += 1;
        failures = next.map((failure) => {
          const earlier = failures.find((entry) => entry.machineId === failure.machineId);
          return { ...failure, at: earlier && earlier.message === failure.message ? earlier.at : `t${clock}`,
            ...(earlier?.dismissedMessages ? { dismissedMessages: earlier.dismissedMessages } : {}) };
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
  const dismissFailures = () => {
    failures = failures.map((failure) => ({ ...failure, dismissedMessages: [...(failure.dismissedMessages ?? []), failure.message] }));
  };
  const lines = () => relayRemovalNotices(recorded, { hasServer: true, serverPhones: 0, failures, leftToRemove: machines.map((machine) => machine.id) });
  return { deps, removed, handoffs, dismissFailures, lines, get recorded() { return recorded; }, get failures() { return failures; },
    failNext(ids: string[]) { failOn = [...ids]; } };
}

const handoff = (machineId: string): MachinePowerHandoffRecord => ({ handoffId: `h-${machineId}`, machineId, instanceId: "i-1", issuedTo: "route-phone", issuedAt: "2026-09-01T00:00:00.000Z" });

test("a phone handed the start key of a relay machine is still warned about, though removing the machine settles its record", async () => {
  const h = harness({ machines: ["Old box"], handoffs: [handoff("id-Old box"), handoff("aws-machine")] });
  const recorded = await removeRelayEraRecords(h.deps);
  assert.deepEqual(h.removed, ["id-Old box"]);
  assert.equal(recorded?.startKeyHanded, true);
  assert.ok(h.handoffs.every((record) => record.revokedAt), "every handoff is settled");
  const notice = relayRemovalNotice(recorded, { hasServer: true, serverPhones: 0 });
  assert.match(notice?.text ?? "", /the machine Old box and a phone pairing\. Pair your phone again from Device Pairing and choose Cloud run/);
  assert.match(notice?.text ?? "", /accordagents-wake user in AWS IAM/);
});

test("a machine that cannot be removed keeps neither the others nor the phones; it is tried again at every start", async () => {
  const h = harness({ machines: ["One", "Two", "Three"], handoffs: [handoff("aws-machine")], failOn: ["id-One", "id-Two"] });
  const recorded = await removeRelayEraRecords(h.deps);
  assert.deepEqual(h.removed, ["id-Three"], "the one after the failures is removed all the same");
  assert.deepEqual(recorded?.machines, ["Three"], "the phones, their files and the start key go at once; only what went is named");
  assert.equal(recorded?.startKeyHanded, true);
  assert.ok(h.handoffs.every((record) => record.revokedAt));
  assert.deepEqual(h.failures.map((failure) => [failure.machine, failure.message]), [["One", "id-One: disk full"], ["Two", "id-Two: disk full"]]);
  const [, failing] = h.lines();
  assert.equal(failing.text, "AccordAgents no longer uses its shared relay. The machines One (id-One: disk full) and Two (id-Two: disk full), set up through it, could not be removed from this computer yet; they are tried again at each start.");
  // Dismissed, it does not come back while they fail for the same reasons.
  h.dismissFailures();
  h.failNext(["id-One", "id-Two"]);
  assert.equal(await removeRelayEraRecords(h.deps), undefined, "the phones are not taken off twice");
  assert.equal(h.lines().length, 1, "only the record's line");
  // A new reason is said again, for that machine only.
  h.deps.removeMachine = async (id) => { throw new Error(id === "id-One" ? "network is down" : `${id}: disk full`); };
  await removeRelayEraRecords(h.deps);
  assert.match(h.lines()[1]?.text ?? "", /^AccordAgents no longer uses its shared relay\. The machine One \(network is down\), set up through it/);
  assert.notEqual(h.lines()[1]?.id, failing.id, "a new line, not the dismissed one");
});

test("a machine removed at a later start joins the record, and its line goes", async () => {
  const h = harness({ machines: ["One", "Two"], failOn: ["id-One"] });
  await removeRelayEraRecords(h.deps);
  assert.deepEqual(h.recorded?.machines, ["Two"]);
  assert.equal(h.lines().length, 2);
  await removeRelayEraRecords(h.deps);
  assert.deepEqual(h.removed, ["id-Two", "id-One"]);
  assert.deepEqual(h.recorded?.machines, ["Two", "One"]);
  assert.deepEqual(h.failures, []);
  assert.equal(h.lines().length, 1);
  assert.match(h.lines()[0].text, /the machine Two, the machine One and a phone pairing/);
});

test("a machine removed at a later start is named before its failure is dropped", async () => {
  const h = harness({ machines: ["One"], failOn: ["id-One"] });
  await removeRelayEraRecords(h.deps);
  h.deps.settings.noteRelayRemovalFailures = async () => { throw new Error("Settings could not be written"); };
  await assert.rejects(removeRelayEraRecords(h.deps), /could not be written/);
  assert.deepEqual(h.recorded?.machines, ["One"], "a stop after the removal leaves it named");
});

test("a failing machine removed in Settings meanwhile is not said to be tried again", () => {
  const failures: RelayRemovalFailure[] = [{ machineId: "id-One", machine: "One", message: "disk full", at: "t1" }];
  assert.equal(relayRemovalNotices(undefined, { hasServer: true, serverPhones: 0, failures, leftToRemove: ["id-One"] }).length, 1);
  assert.deepEqual(relayRemovalNotices(undefined, { hasServer: true, serverPhones: 0, failures, leftToRemove: [] }), []);
});

test("the notice says only what applies, and nothing once dismissed", () => {
  const base: RelayRemovalRecord = { removedAt: "t", machines: [], phones: ["iPhone"], startKeyHanded: false };
  assert.equal(relayRemovalNotice(base, { hasServer: false, serverPhones: 0 })?.text,
    "AccordAgents no longer uses its shared relay, so what was set up through it was removed from this computer: a phone pairing. Set up your server, then pair your phone again from Device Pairing.");
  assert.equal(relayRemovalNotice(base, { hasServer: true, serverPhones: 1 })?.text,
    "AccordAgents no longer uses its shared relay, so what was set up through it was removed from this computer: a phone pairing.", "a phone paired with the server since is not told to pair again");
  assert.equal(relayRemovalNotice({ ...base, phones: ["a", "b"], machines: ["X"] }, { hasServer: true, serverPhones: 0 })?.text.includes("the machine X and 2 phone pairings"), true);
  assert.equal(relayRemovalNotice({ ...base, phones: [] }, { hasServer: true, serverPhones: 0 }), undefined, "nothing removed, nothing said");
  assert.match(relayRemovalNotice({ ...base, phones: [], startKeyHanded: true }, { hasServer: true, serverPhones: 0 })?.text ?? "", /^AccordAgents no longer uses its shared relay\. Phones paired through it keep a copy/);
  assert.equal(relayRemovalNotice({ ...base, dismissedAt: "t2" }, { hasServer: true, serverPhones: 0 }), undefined);
});

test("the failure is told in one short line, whatever the error looked like", async () => {
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
