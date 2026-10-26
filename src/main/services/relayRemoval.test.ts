import assert from "node:assert/strict";
import test from "node:test";
import { relayRemovalNotice, removeRelayEraRecords, type RelayRemovalOptions } from "./relayRemoval";
import type { RelayRemovalPending, RelayRemovalRecord } from "./settings";
import type { MachinePowerHandoffRecord } from "../../shared/machinePowerHandoff";

function harness(options: { machines?: string[]; handoffs?: MachinePowerHandoffRecord[]; failOn?: string[] } = {}) {
  let recorded: RelayRemovalRecord | undefined;
  let pending: RelayRemovalPending | undefined;
  let machines = (options.machines ?? []).map((name) => ({ id: `id-${name}`, name, deviceId: "", pairingKey: `rv-${name}`, createdAt: "2026-09-01T00:00:00.000Z" }));
  const handoffs = (options.handoffs ?? []).map((record) => ({ ...record }));
  const removed: string[] = [];
  let failOn = [...(options.failOn ?? [])];
  const deps: RelayRemovalOptions = {
    settings: {
      relayRemoval: async () => recorded,
      relayEraMachines: async () => (recorded ? [] : machines.map((machine) => ({ ...machine }))),
      beginRelayRemoval: async (found) => {
        pending = { ...pending, machines: [...new Set([...(pending?.machines ?? []), ...found.machines])], startKeyHanded: Boolean(pending?.startKeyHanded) || found.startKeyHanded };
      },
      noteRelayRemovalFailure: async (failure) => { if (pending) pending = { ...pending, failed: { ...failure, at: "2026-10-26T00:00:00.000Z" } }; },
      finishRelayRemoval: async () => {
        if (recorded) return undefined;
        recorded = { removedAt: "2026-10-26T00:00:00.000Z", machines: pending?.machines ?? [], phones: ["iPhone"], startKeyHanded: pending?.startKeyHanded ?? false };
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
  return { deps, removed, handoffs, get recorded() { return recorded; }, get pending() { return pending; } };
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

test("a machine that cannot be removed now does not keep the others: the first failure is named, and the rest is tried at the next start", async () => {
  const h = harness({ machines: ["One", "Two", "Three"], failOn: ["id-One", "id-Two"] });
  assert.equal(await removeRelayEraRecords(h.deps), undefined, "not recorded while something is left");
  assert.deepEqual(h.removed, ["id-Three"], "the one after the failures is removed all the same");
  assert.deepEqual(h.pending?.failed && { machine: h.pending.failed.machine, message: h.pending.failed.message }, { machine: "One", message: "id-One: disk full" });
  const notice = relayRemovalNotice(undefined, { hasServer: true, serverPhones: 0, pending: h.pending });
  assert.match(notice?.text ?? "", /The machine One, set up through it, could not be removed from this computer yet \(id-One: disk full\); it is tried again at the next start\./);
  assert.equal(relayRemovalNotice(undefined, { hasServer: true, serverPhones: 0, pending: { ...h.pending!, failedDismissedAt: "t" } }), undefined, "dismissed, it is not shown");
  assert.equal(relayRemovalNotice(undefined, { hasServer: true, serverPhones: 0, pending: h.pending, leftToRemove: ["Two"] }), undefined,
    "removed since (in Settings), it is not said to be tried again");
  const recorded = await removeRelayEraRecords(h.deps);
  assert.deepEqual(h.removed, ["id-Three", "id-One", "id-Two"]);
  assert.deepEqual(recorded?.machines, ["One", "Two", "Three"], "the notice names everything found");
  assert.equal(await removeRelayEraRecords(h.deps), undefined, "and only once");
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
  assert.equal(h.pending?.failed?.message, "sqlite3 failed: database is locked");
});
