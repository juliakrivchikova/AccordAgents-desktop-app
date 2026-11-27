import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openAlertCallContact } from "./alertCallContact";
import type { HubAlertResult, UrgentAlertSettingsView } from "../../shared/urgentAlerts";

const withPhone = (from: string): HubAlertResult<UrgentAlertSettingsView> => ({
  ok: true,
  value: { phone: { from, to: "+35799123456", trial: false }, waitMinutes: 5, callMode: "keypad" } as UrgentAlertSettingsView
});

test("Add to contacts writes the card for the server's Call-from number and opens it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "alert-contact-test-"));
  try {
    const opened: string[] = [];
    const result = await openAlertCallContact({ settings: async () => withPhone("+14155550134"), openPath: async (file) => { opened.push(file); return ""; }, directory });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(opened, [path.join(directory, "AccordAgents.vcf")]);
    const card = await readFile(opened[0], "utf8");
    assert.match(card, /\r\nTEL;TYPE=VOICE:\+14155550134\r\n/);
    assert.doesNotMatch(card, /35799123456/, "her own number stays out of the card");
    // A second press after the number changed writes the new number over it.
    await openAlertCallContact({ settings: async () => withPhone("+14155550199"), openPath: async () => "", directory });
    assert.match(await readFile(opened[0], "utf8"), /TEL;TYPE=VOICE:\+14155550199/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Add to contacts says why when there is nothing to save or the system can't open it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "alert-contact-test-"));
  try {
    const opened: string[] = [];
    const openPath = async (file: string) => { opened.push(file); return ""; };
    const down = await openAlertCallContact({ settings: async () => ({ ok: false, error: { code: "server_unavailable", message: "Your server is not reachable." } }), openPath, directory });
    assert.deepEqual(down, { ok: false, message: "Your server is not reachable." });
    const none = await openAlertCallContact({ settings: async () => ({ ok: true, value: { waitMinutes: 5, callMode: "keypad" } as UrgentAlertSettingsView }), openPath, directory });
    assert.equal(none.ok, false);
    assert.deepEqual(opened, []);
    const refused = await openAlertCallContact({ settings: async () => withPhone("+14155550134"), openPath: async () => "No application knows how to open it.", directory });
    assert.deepEqual(refused, { ok: false, message: "Couldn't open the contact card: No application knows how to open it." });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
