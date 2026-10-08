import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

import type { AwsWorkerOperationSnapshot, AwsWorkerStartRequest, AwsWorkerStatus, CloudRunWorkerSetupProgress } from "../../../shared/types";
import { DISK, RUNNING, mount, unmount } from "./aws-settings-page-harness.test";
import { AWS_TRANSITION_POLL_MS } from "./use-aws-worker-status";

// What the page does to the instance, and what it does when AWS or the
// instance says no: the scenarios the old AWS panel's tests pinned down.
const STOPPED = { ...RUNNING, state: "stopped" } as AwsWorkerStatus;
const operation = (request: AwsWorkerStartRequest, extra: Partial<AwsWorkerOperationSnapshot>): AwsWorkerOperationSnapshot => ({
  operationId: request.operationId, clientToken: request.clientToken, intent: request.intent, phase: "ready", message: "Done",
  updatedAt: new Date().toISOString(), ...extra
});

test("Stop shows it is waiting, refuses a second Stop, and watches until AWS says stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  let accept!: (status: AwsWorkerStatus) => void;
  const ui = await mount({ stop: () => new Promise((resolve) => { accept = resolve; }) });
  await ui.click(ui.find("aws-worker-stop"));
  await ui.click(ui.find("aws-stop-dialog-confirm"));
  assert.equal(ui.find<HTMLButtonElement>("aws-worker-stop")?.disabled, true, "no second Stop while one is on its way");
  assert.equal(ui.find("aws-worker-start"), null);
  ui.setStatus({ ...RUNNING, state: "stopping" });
  await act(async () => { accept({ ...RUNNING, state: "stopping" }); });
  await ui.settle();
  assert.match(ui.find("aws-worker-transition")?.textContent ?? "", /Waiting for AWS to confirm the stop/);
  ui.setStatus(STOPPED);
  await ui.tick(t, AWS_TRANSITION_POLL_MS);
  assert.equal(ui.find("aws-worker-state")?.textContent, "Stopped");
  assert.equal(ui.find("aws-worker-transition"), null);
  assert.equal(ui.find("aws-worker-start")?.textContent, "Start");
  assert.equal(ui.find("aws-worker-stop"), null, "a stopped instance has nothing to stop");
  assert.equal(ui.bridge.calls.stopAwsWorker?.length, 1);
  await unmount();
});

test("an accepted Stop is still watched after leaving Settings and coming back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  // AWS took the Stop but still says running.
  const ui = await mount({ stop: async () => RUNNING });
  await ui.click(ui.find("aws-worker-stop"));
  await ui.click(ui.find("aws-stop-dialog-confirm"));
  await ui.remount();
  assert.equal(ui.find("aws-worker-transition") !== null, true, "the page keeps waiting for the stop");
  assert.equal(ui.find("aws-worker-stop"), null);
  ui.setStatus(STOPPED);
  await ui.tick(t, AWS_TRANSITION_POLL_MS);
  assert.equal(ui.find("aws-worker-state")?.textContent, "Stopped");
  assert.equal(ui.bridge.calls.stopAwsWorker?.length, 1, "Stop is never sent again");
  await unmount();
});

test("a status read from before Stop cannot replace what Stop returned", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  let hold = false;
  let stale: ((status: AwsWorkerStatus) => void) | undefined;
  const ui = await mount({
    getStatus: () => hold ? new Promise((resolve) => { stale = resolve; }) : Promise.resolve(RUNNING),
    stop: async () => ({ ...RUNNING, state: "stopping" })
  });
  hold = true;
  await ui.tick(t, 30_000);
  assert.ok(stale, "a poll is on its way");
  hold = false;
  await ui.click(ui.find("aws-worker-stop"));
  await ui.click(ui.find("aws-stop-dialog-confirm"));
  await act(async () => { stale?.(RUNNING); });
  await ui.settle();
  assert.equal(ui.find("aws-worker-state")?.textContent, "Stopping");
  await unmount();
});

test("a Stop AWS refused says so, and Stop stays available", async () => {
  const ui = await mount({ stop: async () => ({ ...RUNNING, actionError: "UnauthorizedOperation", message: "The worker was not stopped: UnauthorizedOperation" }) });
  await ui.click(ui.find("aws-worker-stop"));
  await ui.click(ui.find("aws-stop-dialog-confirm"));
  const message = ui.find("aws-worker-message");
  assert.match(message?.textContent ?? "", /Stop failed: .*not stopped/);
  assert.equal(message?.getAttribute("role"), "alert");
  assert.equal(ui.find<HTMLButtonElement>("aws-worker-stop")?.disabled, false);
  await unmount();
});

test("a Delete AWS has not confirmed keeps the instance on the page and says so", async () => {
  const ui = await mount({ remove: async () => ({ ...RUNNING, actionError: "Termination was not confirmed.",
    message: "The instance was not deleted: Termination was not confirmed." }) });
  await ui.click(ui.find("aws-instance-delete"));
  await ui.click(ui.find("aws-delete-dialog-confirm"));
  assert.deepEqual(ui.deleted, [], "Settings is not told the instance is gone");
  assert.match(ui.find("aws-delete-error")?.textContent ?? "", /Delete failed: The instance was not deleted/);
  await unmount();
});

test("a start that fails on a running instance keeps Stop beside Try again", async () => {
  const ui = await mount({ status: STOPPED, start: async (request) => {
    const failed = operation(request, { phase: "error", message: "Setting up the instance timed out" });
    return { operation: failed, status: { ...RUNNING, operation: failed } };
  } });
  await ui.click(ui.find("aws-worker-start"));
  assert.match(ui.find("aws-worker-message")?.textContent ?? "", /Start failed: Setting up the instance timed out/);
  assert.equal(ui.find("aws-worker-start")?.textContent, "Try again");
  assert.equal(ui.find("aws-worker-stop")?.textContent, "Stop", "a running instance bills: Stop stays");
  await unmount();
});

test("a size decision answers the attempt that raised it; Not now leaves everything as it is", async () => {
  let calls = 0;
  const ui = await mount({ status: STOPPED, start: async (request) => {
    calls += 1;
    if (calls < 3) {
      const decision = operation(request, { phase: "needs-decision", message: "Choose", updatedAt: new Date(Date.now() + calls).toISOString(),
        specMismatch: { instanceId: "i-0943", actual: RUNNING.actualSpec!, desired: { instanceType: "t3.medium", rootVolumeSizeGb: 40 }, diskTooSmall: false, computeTooSmall: true } });
      return { operation: decision, status: { ...STOPPED, operation: decision } };
    }
    return { operation: operation(request, {}), status: RUNNING };
  } });
  await ui.click(ui.find("aws-worker-start"));
  assert.match(ui.find("aws-worker-spec-decision")?.textContent ?? "", /Review the size change/);
  await ui.click(ui.button("Not now", ui.find("aws-worker-spec-decision")!));
  assert.equal(ui.find("aws-worker-spec-decision"), null);
  assert.equal(ui.bridge.calls.startAwsWorker?.length, 1, "closing it sends nothing");
  await ui.click(ui.find("aws-worker-start"));
  assert.ok(ui.find("aws-worker-spec-decision"), "Start asks again");
  await ui.click(ui.button("Keep current size", ui.find("aws-worker-spec-decision")!));
  const [first, second, third] = (ui.bridge.calls.startAwsWorker ?? []).map((args) => args[0] as AwsWorkerStartRequest);
  for (const request of [second, third]) {
    assert.equal(request.operationId, first.operationId);
    assert.equal(request.clientToken, first.clientToken);
    assert.equal(request.intent, "setup");
  }
  assert.equal(third.resolution, "keep");
  await unmount();
});

test("AWS not answering is checked once, shown in its row, never as a start", async () => {
  let finish!: (result: { operation: AwsWorkerOperationSnapshot; status: AwsWorkerStatus }) => void;
  // A message with a known state: still unavailable after every check.
  const unavailable = { ...RUNNING, message: "The root volume is not backed by EBS." } as AwsWorkerStatus;
  const ui = await mount({ status: unavailable, start: () => new Promise((resolve) => { finish = resolve; }) });
  assert.equal((ui.bridge.calls.startAwsWorker?.[0]?.[0] as AwsWorkerStartRequest).intent, "check");
  assert.match(ui.find("aws-instance-access")?.textContent ?? "", /Checking AWS access/);
  assert.doesNotMatch(ui.find("aws-worker-actions")?.textContent ?? "", /Starting/, "a check is not a start");
  const request = ui.bridge.calls.startAwsWorker![0][0] as AwsWorkerStartRequest;
  await act(async () => { finish({ operation: operation(request, { phase: "error", message: "Network unreachable" }), status: unavailable }); });
  await ui.settle();
  await ui.settle();
  assert.equal(ui.bridge.calls.startAwsWorker?.length, 1, "one check per outage");
  await unmount();
});

test("Fix access with the app's AWS user waits for the policy, checks every 15 s, and closes once AWS accepts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  const unavailable = { configured: true, handle: { instanceId: "i-0943", region: "us-east-1" } } as AwsWorkerStatus;
  let checks = 0;
  const ui = await mount({ status: unavailable, start: async (request) => {
    checks += 1;
    if (checks < 3) {
      const refused = operation(request, { phase: "error", message: "UnauthorizedOperation", remediation: "refresh-aws-authorization",
        awsPrincipalUserName: "accordagents-worker", missingAwsActions: ["ec2:DescribeInstances"] });
      return { operation: refused, status: { ...unavailable, operation: refused } };
    }
    return { operation: operation(request, {}), status: RUNNING };
  } });
  await ui.click(ui.find("aws-worker-authorization-toggle"));
  const dialog = (): HTMLElement | null => ui.find("aws-worker-authorization-recovery");
  assert.match(dialog()?.textContent ?? "", /accordagents-worker/);
  assert.equal(dialog()?.querySelector('[aria-label="AWS setup result"]'), null, "no new key: nothing to paste");
  await ui.tick(t, 15_000);
  assert.equal(checks, 2);
  assert.match(dialog()?.textContent ?? "", /accordagents-worker/, "still the same dialog while AWS refuses");
  await ui.tick(t, 15_000);
  assert.equal(checks, 3);
  assert.equal(dialog(), null, "access is back: nothing left to fix");
  await ui.tick(t, 45_000);
  assert.equal(checks, 3, "no checks after it closed");
  await unmount();
});

test("a sign-in closes only through Cancel, which ends it on the instance", async () => {
  const ui = await mount();
  await ui.click(ui.find("aws-setup-codex-auth-fix"));
  await act(async () => { for (const listener of ui.bridge.progress) listener({ stage: "codex-auth", message: "Approve", authUrl: "https://auth.example/device", authCode: "K7QF-2M9D", authRequestId: "auth-1" } as CloudRunWorkerSetupProgress); });
  await ui.settle();
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await ui.settle();
  assert.ok(ui.find("aws-sign-in-dialog"), "Escape does not end a sign-in");
  assert.equal(ui.bridge.calls.cancelCloudRunAuth, undefined);
  await ui.click(ui.button("Cancel", ui.find("aws-sign-in-dialog")!));
  assert.deepEqual(ui.bridge.calls.cancelCloudRunAuth, [["auth-1"]]);
  assert.equal(ui.find("aws-sign-in-dialog"), null);
  await unmount();
});

test("the sidebar's AWS mark follows what the page found and clears when the instance is gone", async () => {
  const ui = await mount();
  assert.equal(ui.find("attention-probe")?.getAttribute("data-attention"), "true", "little free space");
  await ui.click(ui.find("aws-instance-delete"));
  await ui.click(ui.find("aws-delete-dialog-confirm"));
  assert.ok(ui.find("aws-worker-connect"));
  assert.equal(ui.find("attention-probe")?.getAttribute("data-attention"), "false");
  await unmount();
});

test("the setup checks shown are the instance's own", async () => {
  await mount();
  await unmount();
  const replaced = { ...RUNNING, handle: { instanceId: "i-new", region: "us-east-1" }, actualSpec: { ...RUNNING.actualSpec!, instanceId: "i-new" } } as AwsWorkerStatus;
  const ui = await mount({ status: replaced, keepSetupChecks: true, checks: { ok: true, message: "ok", checks: [{ id: "connect", label: "SSH connection", status: "pass" }] } });
  assert.equal(ui.bridge.calls.diagnoseCloudRunWorker?.length, 1, "another instance is checked anew");
  assert.match(ui.find("aws-setup-meta")?.textContent ?? "", /All 1 ready/);
  await unmount();
});

test("choosing a folder replaces what was chosen inside it, and what stayed is said by its reason", async () => {
  const folder = (path: string, entries: Array<{ name: string; bytes: number; dir: boolean; lock: string | null }>) => ({
    path, home: "/home/ubuntu", own: "/home/ubuntu/own", truncated: 0,
    entries: entries.map((entry) => ({ ...entry, path: `${path}/${entry.name}` }))
  });
  const ui = await mount({
    list: async (path) => path === "/home/ubuntu/.cache/pip"
      ? folder("/home/ubuntu/.cache/pip", [{ name: "wheels", bytes: 100_000_000, dir: true, lock: null }])
      : folder("/home/ubuntu/.cache", [{ name: "pip", bytes: 400_000_000, dir: true, lock: null }]),
    del: async () => ({ freedBytes: 0, removed: 0, failed: [{ path: "/home/ubuntu/.cache/pip", reason: "error", message: "Permission denied" }],
      space: { totalBytes: DISK.totalBytes, usedBytes: DISK.usedBytes, availableBytes: DISK.availableBytes } })
  });
  await ui.click(ui.find("aws-disk-browse-all"));
  const tree = (): HTMLElement => ui.find("aws-disk-tree")!;
  await ui.click(tree().querySelector('[aria-label="Expand pip"]'));
  await ui.click(tree().querySelector('input[aria-label="Select wheels"]'));
  await ui.click(tree().querySelector('input[aria-label="Select pip"]'));
  assert.equal(tree().querySelector<HTMLInputElement>('input[aria-label="Select wheels"]')?.disabled, true, "inside a chosen folder");
  assert.match(ui.find("aws-disk-delete")?.textContent ?? "", /Delete 400 MB/, "counted once");
  await ui.click(ui.find("aws-disk-delete"));
  assert.deepEqual(ui.bridge.calls.deleteAwsInstanceFiles, [[["/home/ubuntu/.cache/pip"]]]);
  assert.equal(ui.find("aws-disk-kept")?.textContent, "1 item could not be removed: Permission denied.");
  await unmount();
});

test("a clean-up that could not remove something says why, not that it is in use", async () => {
  const ui = await mount({ clean: async () => ({ freedBytes: 0, failed: [{ path: "/var/x", reason: "error", message: "Permission denied" }],
    space: { totalBytes: DISK.totalBytes, usedBytes: DISK.usedBytes, availableBytes: DISK.availableBytes } }) });
  await ui.click(ui.find("aws-disk-clean-program-logs"));
  await ui.click(ui.find("aws-disk-clean-confirm"));
  assert.match(ui.find("aws-disk-clean-dialog")?.textContent ?? "", /1 item could not be removed: Permission denied\./);
  await unmount();
});
