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

import { createUpdateRestart, type UpdateWindowState } from "./appUpdater";

function makeRestart(options: { throws?: Error; stallAfterMs?: number[] } = {}) {
  const log: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let windows: UpdateWindowState[] = [{ id: 1, destroyed: false, visible: true, closable: true }];
  let calls = 0;
  const restart = createUpdateRestart({
    quitAndInstall: () => {
      calls += 1;
      if (options.throws) throw options.throws;
    },
    windows: () => windows,
    log: (event, payload) => { log.push({ event, payload }); },
    stallAfterMs: options.stallAfterMs ?? [10, 30]
  });
  return {
    restart, log,
    calls: () => calls,
    setWindows: (next: UpdateWindowState[]) => { windows = next; },
    events: () => log.map((entry) => entry.event)
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("the restart for an update records every window before asking Electron to install, and again when the call returns", () => {
  const harness = makeRestart({ stallAfterMs: [] });
  harness.restart();
  assert.equal(harness.calls(), 1);
  assert.deepEqual(harness.log, [
    { event: "app-update-quit-and-install", payload: { windows: [{ id: 1, destroyed: false, visible: true, closable: true }], appHidden: undefined } },
    { event: "app-update-quit-and-install-returned", payload: { windows: [{ id: 1, destroyed: false, visible: true, closable: true }] } }
  ]);
});

test("an app still running after the restart was asked for says so, with what still holds it", async () => {
  const harness = makeRestart();
  harness.restart();
  harness.setWindows([{ id: 1, destroyed: false, visible: false, closable: true }]);
  await wait(60);
  assert.deepEqual(harness.events(), ["app-update-quit-and-install", "app-update-quit-and-install-returned", "app-update-restart-stalled", "app-update-restart-stalled"]);
  assert.deepEqual(harness.log.slice(2).map((entry) => entry.payload), [
    { afterMs: 10, windows: [{ id: 1, destroyed: false, visible: false, closable: true }], appHidden: undefined },
    { afterMs: 30, windows: [{ id: 1, destroyed: false, visible: false, closable: true }], appHidden: undefined }
  ]);
});

// Electron 31 reports a failed install as an 'error' event, not a throw; the
// catch guards the quit path against an updater that does throw.
test("a restart call that throws is recorded, and the stall records still follow", async () => {
  const harness = makeRestart({ throws: new Error("updater threw"), stallAfterMs: [10] });
  assert.doesNotThrow(() => harness.restart());
  await wait(30);
  assert.deepEqual(harness.events(), ["app-update-quit-and-install", "app-update-quit-and-install-error", "app-update-quit-and-install-returned", "app-update-restart-stalled"]);
  assert.deepEqual(harness.log[1].payload, { message: "updater threw" });
});

test("asking again starts the stall records over instead of doubling them", async () => {
  const harness = makeRestart({ stallAfterMs: [20] });
  harness.restart();
  await wait(5);
  harness.restart();
  await wait(50);
  assert.deepEqual(harness.events(), ["app-update-quit-and-install", "app-update-quit-and-install-returned", "app-update-quit-and-install", "app-update-quit-and-install-returned", "app-update-restart-stalled"]);
});

import { describeUpdateWindows, type UpdateWindowLike } from "./appUpdater";

function fakeWindow(overrides: Partial<UpdateWindowLike> = {}): UpdateWindowLike {
  return {
    id: 7,
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => false,
    isMinimized: () => false,
    isFullScreen: () => false,
    isClosable: () => true,
    isEnabled: () => true,
    getChildWindows: () => [],
    webContents: { isDestroyed: () => false, isCrashed: () => false, isLoading: () => false },
    ...overrides
  };
}

test("window state for the restart record reads each window, and never throws in the quit path", () => {
  assert.deepEqual(describeUpdateWindows([fakeWindow()]), [{
    id: 7, destroyed: false, visible: true, enabled: true, focused: false, minimized: false, fullScreen: false, closable: true, childWindows: 0, rendererCrashed: false, loading: false
  }]);
  assert.deepEqual(describeUpdateWindows([fakeWindow({ isDestroyed: () => true })]), [{ id: 7, destroyed: true }]);
  // A page already gone while its window stays open: said so, not read.
  const pageGone = describeUpdateWindows([fakeWindow({ webContents: { isDestroyed: () => true, isCrashed: () => { throw new Error("Object has been destroyed"); }, isLoading: () => false } })])[0];
  assert.equal(pageGone.contentsDestroyed, true);
  assert.equal(pageGone.rendererCrashed, undefined);
  assert.deepEqual(describeUpdateWindows([fakeWindow({ isVisible: () => { throw new Error("Object has been destroyed"); } })]), [{ id: 7, error: "Object has been destroyed" }]);
});
