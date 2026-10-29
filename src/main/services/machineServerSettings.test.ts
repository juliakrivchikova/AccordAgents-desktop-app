import assert from "node:assert/strict";
import test from "node:test";
import type { HubMachineSettings } from "../../shared/hubOps";
import type { MachineSettingsDocument } from "../../shared/machineLink";
import { MachineServerSettings } from "./machineServerSettings";

function document(marker: string): MachineSettingsDocument {
  return { version: 1, settings: { version: 1, exportedAt: marker, settingsJson: JSON.stringify({ marker }), agentEnvironment: [] }, projects: {} };
}

test("a machine applies what the computer published once, asks only for what is newer, and keeps what it has when a read or an import fails", async () => {
  const answers: Array<HubMachineSettings | Error> = [];
  const asked: Array<string | undefined> = [];
  const applied: string[] = [];
  const logs: string[] = [];
  let failOpen = false;
  let failAfterImport = false;
  const settings = new MachineServerSettings({
    read: async (since) => {
      asked.push(since);
      const next = answers.shift() ?? { unchanged: true, updatedAt: since };
      if (next instanceof Error) throw next;
      return next;
    },
    open: async (sealed) => {
      if (failOpen) throw new Error("not readable");
      return document(sealed);
    },
    apply: async (value) => { applied.push(value.settings.exportedAt); },
    onImported: () => { if (failAfterImport) throw new Error("timeout knob"); },
    log: (event) => logs.push(event)
  });

  answers.push({ sealed: "first", updatedAt: "2026-10-28T10:00:00.000Z" });
  assert.equal(await settings.refresh("start"), true);
  assert.deepEqual(applied, ["first"]);
  assert.equal(settings.applied(), "2026-10-28T10:00:00.000Z");
  assert.deepEqual(asked, [undefined], "nothing applied yet: the whole document is asked for");

  assert.equal(await settings.refresh("recheck"), false, "nothing newer");
  assert.equal(asked.at(-1), "2026-10-28T10:00:00.000Z", "asked only for what is newer than what it applied");

  // An answer not newer than what it has (a slower server copy) is not applied.
  answers.push({ sealed: "older", updatedAt: "2026-10-28T09:00:00.000Z" });
  assert.equal(await settings.refresh("recheck"), false);
  assert.deepEqual(applied, ["first"]);

  // The server cannot be read: kept as it was.
  answers.push(new Error("The server did not answer."));
  assert.equal(await settings.refresh("turn"), false);
  assert.ok(logs.includes("machine.settings.read-failed"));

  // Sealed for another key, or not readable by this runtime: kept as it was,
  // and read again next time.
  failOpen = true;
  answers.push({ sealed: "second", updatedAt: "2026-10-28T11:00:00.000Z" });
  assert.equal(await settings.refresh("published"), false);
  assert.ok(logs.includes("machine.settings.apply-failed"));
  assert.equal(settings.applied(), "2026-10-28T10:00:00.000Z");
  failOpen = false;
  failAfterImport = true;
  answers.push({ sealed: "second", updatedAt: "2026-10-28T11:00:00.000Z" });
  assert.equal(await settings.refresh("recheck"), true, "applied on the next read");
  assert.deepEqual(applied, ["first", "second"]);
  assert.ok(logs.includes("machine.settings.after-import-failed"), "a knob read after the import failing does not undo it");
});

test("reads run one at a time, each after it was asked: a turn waits for the settings read that started before it", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const settings = new MachineServerSettings({
    read: async () => {
      reads += 1;
      const n = reads;
      order.push(`read ${n}`);
      if (n === 1) await gate;
      return { sealed: `s${n}`, updatedAt: `2026-10-28T1${n}:00:00.000Z` };
    },
    open: async (sealed) => document(sealed),
    apply: async (value) => { order.push(`apply ${value.settings.exportedAt}`); },
    log: () => undefined
  });
  const first = settings.refresh("published");
  const second = settings.refresh("turn");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ["read 1"], "the second read waits for the first");
  release();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(order, ["read 1", "apply s1", "read 2", "apply s2"]);
});
