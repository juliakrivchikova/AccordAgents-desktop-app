import assert from "node:assert/strict";
import test from "node:test";
import {
  BETA_UPDATE_REPO,
  STABLE_UPDATE_REPO,
  resolveUpdateRepo,
  supportsAutoUpdates
} from "./appUpdater";

test("resolveUpdateRepo returns the stable repo unless beta updates are enabled", () => {
  assert.equal(resolveUpdateRepo(false), STABLE_UPDATE_REPO);
  assert.equal(resolveUpdateRepo(true), BETA_UPDATE_REPO);
});

test("supports the packaged macOS and Squirrel.Windows update paths only", () => {
  assert.equal(supportsAutoUpdates(true, "darwin"), true);
  assert.equal(supportsAutoUpdates(true, "win32"), true);
  assert.equal(supportsAutoUpdates(true, "linux"), false);
  assert.equal(supportsAutoUpdates(false, "darwin"), false);
  assert.equal(supportsAutoUpdates(false, "win32"), false);
});

import { createUpdateRestartGate, type UpdateRestartInfo } from "./appUpdater";

function makeGate(overrides: { busy?: () => boolean; choice?: "restart" | "later" } = {}) {
  const log: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const listeners = new Set<() => void>();
  let busy = overrides.busy ?? (() => false);
  const prompts: UpdateRestartInfo[] = [];
  let quits = 0;
  let choice: "restart" | "later" = overrides.choice ?? "restart";
  let unsubscribed = 0;
  const gate = createUpdateRestartGate({
    isBusy: async () => busy(),
    onActivitySettled: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); unsubscribed += 1; }; },
    prompt: async (info) => { prompts.push(info); return choice; },
    quitAndInstall: () => { quits += 1; },
    log: (event, payload) => { log.push({ event, payload }); },
    recheckIntervalMs: 20
  });
  const settle = async (): Promise<void> => { for (const listener of [...listeners]) listener(); await new Promise((resolve) => setTimeout(resolve, 5)); };
  const quitCount = { count: 0 };
  return {
    gate, log, prompts, settle, listenersRef: listeners, quitCount,
    setBusy: (next: () => boolean) => { busy = next; },
    setChoice: (next: "restart" | "later") => { choice = next; },
    quits: () => quits,
    listeners: () => listeners.size,
    unsubscribed: () => unsubscribed,
    events: () => log.map((entry) => entry.event)
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

test("a downloaded update prompts at once when nothing is running, and restarts on Restart", async () => {
  const harness = makeGate();
  harness.gate.onDownloaded({ releaseName: "AccordAgents v9.9.9" });
  await tick();
  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.quits(), 1);
  assert.equal(harness.gate.pending(), undefined);
  assert.deepEqual(harness.events(), ["app-update-downloaded", "app-update-restarting"]);
});

test("a downloaded update waits while a member is working anywhere and prompts when the work settles", async () => {
  // The defect this prevents: the library's default dialog appeared the moment
  // the update finished downloading, and Restart killed the local members'
  // CLI processes mid-turn -- and, now that the new desktop upgrades the
  // machines, the members there too.
  let running = true;
  const harness = makeGate({ busy: () => running });
  harness.gate.onDownloaded({ releaseName: "AccordAgents v9.9.9" });
  await tick();
  assert.equal(harness.prompts.length, 0, "no prompt while a member is working");
  assert.equal(harness.listeners(), 1, "waits for work to settle");
  await harness.settle();
  assert.equal(harness.prompts.length, 0, "still working: still no prompt");
  running = false;
  await harness.settle();
  assert.equal(harness.prompts.length, 1, "prompted once the work settled");
  assert.equal(harness.quits(), 1);
  assert.equal(harness.unsubscribed(), 1, "stops watching once it has prompted");
  assert.deepEqual(harness.events(), ["app-update-downloaded", "app-update-deferred", "app-update-restarting"]);
});

test("the periodic re-check catches work that ends without an event", async () => {
  let running = true;
  const harness = makeGate({ busy: () => running });
  harness.gate.onDownloaded({ releaseName: "v1" });
  await tick();
  running = false;
  const deadline = Date.now() + 2_000;
  while (harness.prompts.length === 0 && Date.now() < deadline) await tick();
  assert.equal(harness.prompts.length, 1, "the interval re-check prompted");
  assert.equal(harness.quits(), 1);
  harness.gate.dispose();
});

test("a busy check that throws after Restart was chosen keeps the app running", async () => {
  let checks = 0;
  const harness = makeGate({ busy: () => { checks += 1; if (checks === 2) throw new Error("relay down"); return false; } });
  harness.gate.onDownloaded({ releaseName: "v1" });
  await tick();
  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.quits(), 0, "an unknown answer is never taken as idle");
  assert.ok(harness.gate.pending());
  await harness.settle();
  assert.equal(harness.quits(), 1, "restarted once the answer is idle");
});

test("a prompt that cannot be shown keeps the update pending instead of postponing it", async () => {
  let fail = true;
  const harness = makeGate();
  const gate = createUpdateRestartGate({
    isBusy: async () => false,
    onActivitySettled: (listener) => { harness.listenersRef.add(listener); return () => { harness.listenersRef.delete(listener); }; },
    prompt: async (info) => { harness.prompts.push(info); if (fail) throw new Error("no window"); return "restart"; },
    quitAndInstall: () => { harness.quitCount.count += 1; },
    log: (event, payload) => { harness.log.push({ event, payload }); },
    recheckIntervalMs: 20
  });
  gate.onDownloaded({ releaseName: "v1" });
  await tick();
  assert.equal(harness.prompts.length, 1);
  assert.ok(gate.pending(), "still pending");
  assert.ok(harness.events().includes("app-update-prompt-error"));
  fail = false;
  for (const listener of [...harness.listenersRef]) listener();
  await tick();
  assert.equal(harness.prompts.length, 2, "asked again at the next quiet moment");
  assert.equal(harness.quitCount.count, 1);
  gate.dispose();
});

test("Later keeps the library's meaning: no further prompt for this download", async () => {
  const harness = makeGate({ choice: "later" });
  harness.gate.onDownloaded({ releaseName: "v1" });
  await tick();
  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.quits(), 0);
  assert.equal(harness.gate.pending(), undefined);
  await harness.settle();
  assert.equal(harness.prompts.length, 1, "nothing re-prompts after Later");
});

test("Restart chosen while a member has just started defers again instead of killing it", async () => {
  let checks = 0;
  // Idle when the prompt opens, busy by the time Restart is clicked.
  const harness = makeGate({ busy: () => { checks += 1; return checks === 2; } });
  harness.gate.onDownloaded({ releaseName: "v1" });
  await tick();
  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.quits(), 0, "not restarted underneath the member");
  assert.ok(harness.gate.pending(), "the update is still pending");
  assert.equal(harness.listeners(), 1, "watching for the member to finish");
  await harness.settle();
  assert.equal(harness.prompts.length, 2, "prompted again once idle");
  assert.equal(harness.quits(), 1);
});

test("a busy check that throws counts as busy and is retried, never as idle", async () => {
  let fail = true;
  const harness = makeGate({ busy: () => { if (fail) throw new Error("relay down"); return false; } });
  harness.gate.onDownloaded({ releaseName: "v1" });
  await tick();
  assert.equal(harness.prompts.length, 0);
  assert.ok(harness.events().includes("app-update-busy-check-error"));
  fail = false;
  await harness.settle();
  assert.equal(harness.prompts.length, 1);
});
