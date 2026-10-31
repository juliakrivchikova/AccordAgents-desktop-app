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

import { showUpdateRestartPrompt } from "./appUpdater";
import type { BrowserWindow } from "electron";

test("the update question is never asked without a shown window: it waits instead of stopping the app", async () => {
  const window = (overrides: Record<string, () => boolean>) => ({
    isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, ...overrides
  }) as unknown as BrowserWindow;
  assert.equal(await showUpdateRestartPrompt({ releaseName: "v" }, undefined), "unanswered");
  assert.equal(await showUpdateRestartPrompt({ releaseName: "v" }, window({ isDestroyed: () => true })), "unanswered");
  assert.equal(await showUpdateRestartPrompt({ releaseName: "v" }, window({ isVisible: () => false })), "unanswered");
  assert.equal(await showUpdateRestartPrompt({ releaseName: "v" }, window({ isMinimized: () => true })), "unanswered");
});

test("an update waiting for a window says so once and is asked again when one comes up", async () => {
  let shown = false;
  const log: string[] = [];
  const listeners = new Set<() => void>();
  const windowListeners = new Set<() => void>();
  const gate = createUpdateRestartGate({
    isBusy: async () => false,
    onActivitySettled: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onWindowAvailable: (listener) => { windowListeners.add(listener); return () => { windowListeners.delete(listener); }; },
    prompt: async () => (shown ? "restart" : "unanswered"),
    quitAndInstall: () => { log.push("quit"); },
    log: (event) => { log.push(event); },
    recheckIntervalMs: 60_000
  });
  gate.onDownloaded({ releaseName: "AccordAgents v9.9.9" });
  await tick();
  for (const listener of [...listeners]) listener();
  await tick();
  assert.deepEqual(log, ["app-update-downloaded", "app-update-prompt-waiting"], "waiting is said once, not on every check");
  assert.ok(gate.pending(), "the update stays pending");
  assert.equal(windowListeners.size, 1, "one window listener, however many checks found no window");
  shown = true;
  for (const listener of [...windowListeners]) listener();
  await tick();
  assert.deepEqual(log.slice(2), ["app-update-restarting", "quit"]);
  assert.equal(windowListeners.size, 0, "the window listener goes once the question is asked");
  gate.dispose();
});

test("with no window to ask on, an update waits without checking who is busy (that greets every machine)", async () => {
  let windowUp = false;
  let busyChecks = 0;
  const log: string[] = [];
  const listeners = new Set<() => void>();
  const windowListeners = new Set<() => void>();
  const gate = createUpdateRestartGate({
    isBusy: async () => { busyChecks += 1; return false; },
    onActivitySettled: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onWindowAvailable: (listener) => { windowListeners.add(listener); return () => { windowListeners.delete(listener); }; },
    canPrompt: () => windowUp,
    prompt: async () => "restart",
    quitAndInstall: () => { log.push("quit"); },
    log: (event) => { log.push(event); },
    recheckIntervalMs: 10
  });
  gate.onDownloaded({ releaseName: "AccordAgents v9.9.9" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (const listener of [...listeners]) listener();
  await tick();
  assert.equal(busyChecks, 0, "no busy check, so no machine is greeted, while no window is up");
  assert.deepEqual(log, ["app-update-downloaded", "app-update-prompt-waiting"]);
  windowUp = true;
  for (const listener of [...windowListeners]) listener();
  await tick();
  assert.equal(busyChecks, 2, "asked once the window is up: checked before the question and after the answer");
  assert.deepEqual(log.slice(2), ["app-update-restarting", "quit"]);
  gate.dispose();
});

import { createUpdateCheckLoop, updateCheckIntervalMs, updateFeedUrl, UPDATE_CHECK_INTERVAL_MS } from "./appUpdater";

test("update checks stop once an update is downloaded, so Restart still finds it ready", async () => {
  // The User's desktop, 2026-10-29: beta.8 downloaded at 12:58, the hourly
  // check at 13:58 found nothing new and cleared the native "ready" note, and
  // Restart at 22:18 failed with "No update available, can't quit and install".
  const log: string[] = [];
  let checks = 0;
  const loop = createUpdateCheckLoop({ check: () => { checks += 1; }, intervalMs: 15, log: (event) => { log.push(event); } });
  try {
    assert.equal(checks, 1, "asked at once");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(checks >= 2, "and again every interval while nothing is downloaded");
    loop.downloaded();
    const atDownload = checks;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(checks, atDownload, "no check after the download");
    assert.deepEqual(log, ["app-update-check-skipped"], "said once, not on every interval");
  } finally {
    loop.dispose();
  }
});

test("the update check interval is the hour unless a test run shortens it, never under ten seconds", () => {
  assert.equal(updateCheckIntervalMs({}), UPDATE_CHECK_INTERVAL_MS);
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 60 * 60_000);
  assert.equal(updateCheckIntervalMs({ ACCORDAGENTS_UPDATE_CHECK_INTERVAL_MS: "20000" }), 20_000);
  assert.equal(updateCheckIntervalMs({ ACCORDAGENTS_UPDATE_CHECK_INTERVAL_MS: "500" }), UPDATE_CHECK_INTERVAL_MS);
  assert.equal(updateCheckIntervalMs({ ACCORDAGENTS_UPDATE_CHECK_INTERVAL_MS: "soon" }), UPDATE_CHECK_INTERVAL_MS);
});

test("the feed is the one update-electron-app asked", () => {
  assert.equal(updateFeedUrl(BETA_UPDATE_REPO, "1.11.3-beta.8", "darwin", "arm64"),
    "https://update.electronjs.org/juliakrivchikova/AccordAgents-Beta-Releases/darwin-arm64/1.11.3-beta.8");
  assert.equal(updateFeedUrl(STABLE_UPDATE_REPO, "1.11.1", "win32", "x64", true),
    "https://update.electronjs.org/juliakrivchikova/AccordAgents-Releases/win32-x64/msix/1.11.1");
});

function makeConfirmGate(confirm: () => Promise<boolean | undefined>, busy: () => boolean = () => false) {
  const log: string[] = [];
  let quits = 0;
  let prompts = 0;
  const asked: number[] = [];
  const gate = createUpdateRestartGate({
    isBusy: async () => busy(),
    onActivitySettled: () => () => undefined,
    prompt: async () => { prompts += 1; return "restart"; },
    confirmRestart: async () => { asked.push(prompts); return confirm(); },
    quitAndInstall: () => { quits += 1; },
    log: (event) => { log.push(event); },
    recheckIntervalMs: 20
  });
  return { gate, log, asked, quits: () => quits, prompts: () => prompts };
}

test("Restart asks about the terminal's commands after the update prompt, and restarts on Quit", async () => {
  const harness = makeConfirmGate(async () => true);
  harness.gate.onDownloaded({ releaseName: "v1" });
  await tick();
  assert.deepEqual(harness.asked, [1], "asked once, after the User chose Restart");
  assert.equal(harness.quits(), 1);
  assert.equal(harness.gate.pending(), undefined);
});

test("Cancel at that question works as Later: no restart, no further prompt for this download", async () => {
  const harness = makeConfirmGate(async () => false);
  harness.gate.onDownloaded({ releaseName: "v1" });
  await tick();
  assert.equal(harness.quits(), 0);
  assert.equal(harness.gate.pending(), undefined);
  assert.ok(harness.log.includes("app-update-postponed"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(harness.prompts(), 1, "not asked again until the next download");
});

test("a question that cannot be asked does not hold the User's Restart", async () => {
  const harness = makeConfirmGate(async () => { throw new Error("no window"); });
  harness.gate.onDownloaded({ releaseName: "v1" });
  await tick();
  assert.equal(harness.quits(), 1);
  assert.ok(harness.log.includes("app-update-confirm-error"));
});

test("a member who starts while the terminal question is open holds the restart back", async () => {
  let memberWorking = false;
  const harness = makeConfirmGate(async () => { memberWorking = true; return true; }, () => memberWorking);
  harness.gate.onDownloaded({ releaseName: "v1" });
  await tick();
  assert.equal(harness.quits(), 0, "never restarted underneath the member");
  assert.ok(harness.log.includes("app-update-restart-deferred"));
  assert.ok(harness.gate.pending(), "still waiting for a quiet moment");
  harness.gate.dispose();
});

test("a terminal question whose window went away keeps the update pending", async () => {
  const harness = makeConfirmGate(async () => undefined);
  harness.gate.onDownloaded({ releaseName: "v1" });
  await tick();
  assert.equal(harness.quits(), 0);
  assert.ok(harness.gate.pending());
  assert.ok(!harness.log.includes("app-update-postponed"));
  harness.gate.dispose();
});

test("an update downloaded again while the terminal question is open asks nothing more", async () => {
  let answer!: (restart: boolean) => void;
  let questions = 0;
  const harness = makeConfirmGate(() => { questions += 1; return new Promise<boolean>((resolve) => { answer = resolve; }); });
  harness.gate.onDownloaded({ releaseName: "v1" });
  await tick();
  assert.equal(questions, 1);
  harness.gate.onDownloaded({ releaseName: "v2" });
  await tick();
  assert.equal(harness.prompts(), 1, "no second update prompt under the open question");
  assert.equal(questions, 1, "no second terminal question");
  answer(true);
  await tick();
  assert.equal(harness.quits(), 1, "restarted once");
});
