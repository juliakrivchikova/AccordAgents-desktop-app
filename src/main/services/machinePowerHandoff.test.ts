import assert from "node:assert/strict";
import test from "node:test";
import { MachinePowerHandoffService, type MachinePowerHandoffStore } from "./machinePowerHandoff";
import { assertMachinePowerHandoff } from "../../shared/machinePowerHandoff";
import type { MachinePowerHandoffRecord } from "../../shared/machinePowerHandoff";

const config = {
  version: 1 as const,
  instanceId: "i-0943b28f7231ab93c",
  credentials: { accessKeyId: "AKIAEXAMPLEWAKEKEY001", secretAccessKey: "synthetic-power-secret", region: "us-east-1" }
};

function store(initial: MachinePowerHandoffRecord[] = [], power = config): MachinePowerHandoffStore & { records: MachinePowerHandoffRecord[] } {
  const state = { records: [...initial] };
  return {
    records: state.records,
    async getMachinePower() { return power; },
    async listMachinePowerHandoffs() { return state.records.map((record) => ({ ...record })); },
    async saveMachinePowerHandoffs(records) { state.records.length = 0; state.records.push(...records); }
  };
}

let ids = 0;
const service = (backing: MachinePowerHandoffStore): MachinePowerHandoffService =>
  new MachinePowerHandoffService(backing, () => new Date("2026-09-07T06:00:00.000Z"), () => `handoff-${++ids}`);

test("a device receives the scoped key, and the desktop keeps a record without it", async () => {
  const backing = store();
  const handoff = await service(backing).issue({ machineId: "m1", issuedTo: "phone-1" });
  assertMachinePowerHandoff(handoff);
  assert.equal(handoff.instanceId, config.instanceId);
  assert.equal(handoff.credentials.secretAccessKey, config.credentials.secretAccessKey);

  assert.equal(backing.records.length, 1);
  const stored = JSON.stringify(backing.records[0]);
  assert.ok(!stored.includes(config.credentials.secretAccessKey), "the record must never carry the secret");
  assert.ok(!stored.includes(config.credentials.accessKeyId));
  assert.equal(backing.records[0].issuedTo, "phone-1");
});

test("a machine with no power configuration cannot be handed to a device", async () => {
  const backing = { ...store(), async getMachinePower() { return undefined; } };
  await assert.rejects(service(backing).issue({ machineId: "m1", issuedTo: "phone-1" }), /no power configuration/);
  assert.deepEqual(backing.records, []);
});

test("revoking says plainly that only rotating the key ends the device's access", async () => {
  const backing = store();
  const api = service(backing);
  const first = await api.issue({ machineId: "m1", issuedTo: "phone-1" });
  await api.issue({ machineId: "m1", issuedTo: "laptop-2" });

  const outcome = await api.revoke(first.handoffId, "device lost");
  assert.equal(outcome.keyRotationRequired, true);
  assert.equal(outcome.otherLiveHandoffs, 1);
  assert.match(outcome.detail, /kept a copy of this machine's power key/);
  assert.match(outcome.detail, /Rotate that access key in AWS/);
  assert.match(outcome.detail, /1 other device will need a new handoff/);

  assert.equal(await api.isLive(first.handoffId), false, "this desktop must not offer a revoked handoff again");
  assert.equal(backing.records.find((r) => r.handoffId === first.handoffId)?.revokeReason, "device lost");
});

test("revoking twice keeps the first revocation time and stays honest about rotation", async () => {
  const backing = store();
  const api = service(backing);
  const handoff = await api.issue({ machineId: "m1", issuedTo: "phone-1" });
  const first = await api.revoke(handoff.handoffId, "rotated");
  const second = await api.revoke(handoff.handoffId, "again");
  assert.equal(second.revokedAt, first.revokedAt);
  assert.equal(second.keyRotationRequired, true);
  assert.equal(backing.records[0].revokeReason, "rotated");
});

test("removing a machine revokes every device that could still wake it", async () => {
  const backing = store();
  const api = service(backing);
  await api.issue({ machineId: "m1", issuedTo: "phone-1" });
  await api.issue({ machineId: "m1", issuedTo: "laptop-2" });
  await api.issue({ machineId: "m2", issuedTo: "phone-1" });

  const outcomes = await api.revokeForMachine("m1", "machine removed");
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((outcome) => outcome.keyRotationRequired));
  assert.equal(backing.records.filter((record) => record.machineId === "m1" && !record.revokedAt).length, 0);
  assert.equal(backing.records.filter((record) => record.machineId === "m2" && !record.revokedAt).length, 1,
    "another machine's handoff is untouched");
});

test("an unknown handoff cannot be revoked silently", async () => {
  await assert.rejects(service(store()).revoke("nope", "x"), /not on record/);
});
