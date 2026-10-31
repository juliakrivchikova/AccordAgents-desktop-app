import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

import type { AwsSetupStep, AwsWorkerOperationSnapshot, AwsWorkerStartRequest, AwsWorkerStatus, CloudRunWorkerSetupProgress } from "../../../shared/types";
import { RUNNING, SETTINGS, mount, unmount } from "./aws-settings-page-harness.test";

test("the page is sections: status, program, instance, projects, disk and setup", async () => {
  const ui = await mount();
  assert.equal(ui.find("aws-worker-state")?.textContent, "Running · billable");
  const titles = [...document.querySelectorAll(".gen-section-title")].map((title) => title.textContent);
  assert.deepEqual(titles, ["Cloud program", "Instance", "Projects on the instance", "Disk", "Setup"]);
  assert.equal(document.querySelectorAll(".gen-aws-problem, .gen-aws-feedback").length, 0, "problems are red lines, not boxes");
  await unmount();
});

test("Stop asks first, then stops once", async () => {
  const ui = await mount();
  await ui.click(ui.find("aws-worker-stop"));
  assert.match(ui.find("aws-stop-dialog")?.textContent ?? "", /Stop the instance\?/);
  await ui.click(ui.button("Cancel", ui.find("aws-stop-dialog")!));
  assert.equal(ui.bridge.calls.stopAwsWorker?.length ?? 0, 0, "cancel stops nothing");
  await ui.click(ui.find("aws-worker-stop"));
  await ui.click(ui.find("aws-stop-dialog-confirm"));
  assert.equal(ui.bridge.calls.stopAwsWorker?.length, 1);
  await unmount();
});

test("Delete asks first and hands back to Settings once AWS confirms", async () => {
  const ui = await mount();
  await ui.click(ui.find("aws-instance-delete"));
  assert.match(ui.find("aws-delete-dialog")?.textContent ?? "", /Delete the instance\?/);
  await ui.click(ui.find("aws-delete-dialog-confirm"));
  assert.equal(ui.bridge.calls.deleteAwsWorker?.length, 1);
  assert.deepEqual(ui.deleted, ["deleted"]);
  await unmount();
});

test("an instance the app removed by itself is said in one line on the page that offers a new one", async () => {
  const gone = { configured: false, notices: ["Your cloud machine no longer exists in AWS, so it was removed."] } as AwsWorkerStatus;
  const ui = await mount({ status: gone });
  assert.equal(ui.find("aws-instance-gone-notice")?.textContent, "Your cloud machine no longer exists in AWS, so it was removed.");
  assert.ok(ui.find("aws-worker-connect"), "the page offers a new instance");
  assert.deepEqual(ui.deleted, [], "nothing is saved for it");
  await unmount();

  const plain = await mount({ status: { configured: false } as AwsWorkerStatus, settings: { ...SETTINGS, hasAwsCredentials: false } });
  assert.equal(plain.find("aws-instance-gone-notice"), null, "no notice without a removal");
  await unmount();
});

test("Delete that finished with something to say shows it, and the old-machine line, on the page that offers a new instance", async () => {
  const line = "Your old cloud machine could not be removed from this computer yet: disk full. The app tries again by itself.";
  const ui = await mount({ remove: async () => ({ configured: false, message: "Worker terminated with 1 cleanup warning(s).", notices: [line] } as AwsWorkerStatus) });
  await ui.click(ui.find("aws-instance-delete"));
  await ui.click(ui.find("aws-delete-dialog-confirm"));
  assert.deepEqual(ui.deleted, ["deleted"]);
  assert.equal(ui.find("aws-delete-message")?.textContent, "Worker terminated with 1 cleanup warning(s).");
  assert.equal(ui.find("aws-instance-gone-notice")?.textContent, line);
  assert.equal(document.querySelector("[role=alert]"), null, "a finished Delete is not shown as a failure");
  await unmount();
});

test("a running instance's page says when an old cloud machine is still on this computer", async () => {
  const line = "Your old cloud machine could not be removed from this computer yet: disk full. The app tries again by itself.";
  const ui = await mount({ status: { ...RUNNING, notices: [line] } as AwsWorkerStatus });
  assert.equal(ui.find("aws-instance-notice")?.textContent, line);
  assert.equal(ui.find("aws-worker-state")?.textContent, "Running · billable", "the instance itself is fine");
  await unmount();
  const plain = await mount();
  assert.equal(plain.find("aws-instance-notice"), null);
  await unmount();
});

test("both lines show, each on its own line, when the instance is gone and one of its machines is still here", async () => {
  const gone = "Your cloud machine no longer exists in AWS, so it was removed.";
  const unconfirmed = "We couldn't confirm your old cloud machine is gone, so it is still listed on this computer: AWS refused the keys its instance was made with.";
  const ui = await mount({ status: { configured: false, notices: [gone, unconfirmed] } as AwsWorkerStatus, settings: { ...SETTINGS, hasAwsCredentials: false } });
  const lines = [...(ui.find("aws-instance-gone-notice")?.children ?? [])].map((line) => line.textContent);
  assert.deepEqual(lines, [gone, unconfirmed]);
  await unmount();
});

test("growing the disk keeps the instance and refuses a smaller size", async () => {
  const ui = await mount();
  await ui.click(ui.find("aws-disk-grow"));
  const input = document.querySelector<HTMLInputElement>('[aria-label="New disk size in GiB"]');
  await ui.type(input, "30");
  assert.equal(ui.find<HTMLButtonElement>("aws-grow-apply")?.disabled, true);
  assert.match(ui.find("aws-grow-dialog")?.textContent ?? "", /AWS cannot make the disk smaller/);
  await ui.type(input, "60");
  await ui.click(ui.find("aws-grow-apply"));
  const request = ui.bridge.calls.startAwsWorker?.[0]?.[0] as AwsWorkerStartRequest;
  assert.equal(request.intent, "resize");
  assert.equal(request.resolution, "grow-disk");
  assert.equal(request.instanceType, "t3.small");
  assert.equal(request.rootVolumeSizeGb, 60);
  assert.equal(request.expectedInstanceId, "i-0943");
  await unmount();
});

test("changing the type replaces the instance at the same disk size, after saying so", async () => {
  const ui = await mount();
  await ui.click(ui.find("aws-instance-type-change"));
  assert.match(ui.find("aws-type-dialog")?.textContent ?? "", /sign-ins on it are lost/);
  assert.equal(ui.find<HTMLButtonElement>("aws-type-apply")?.disabled, true, "the current type changes nothing");
  await ui.type(document.querySelector<HTMLSelectElement>('[aria-label="Instance type"]'), "t3.medium");
  await ui.click(ui.find("aws-type-apply"));
  const request = ui.bridge.calls.startAwsWorker?.[0]?.[0] as AwsWorkerStartRequest;
  assert.equal(request.resolution, "recreate");
  assert.equal(request.instanceType, "t3.medium");
  assert.equal(request.rootVolumeSizeGb, 40);
  assert.deepEqual(request.expectedDesiredSpec, { instanceType: "t3.medium", rootVolumeSizeGb: 40 });
  await unmount();
});

test("AWS not answering is checked by itself; refused keys are fixed from the AWS access row", async () => {
  let reads = 0;
  const refused = (operationId: string): AwsWorkerOperationSnapshot => ({ operationId, intent: "check", phase: "error", message: "AuthFailure",
    updatedAt: new Date().toISOString(), remediation: "refresh-aws-authorization" });
  const ui = await mount({
    getStatus: async () => { reads += 1; return { configured: true, handle: { instanceId: "i-0943", region: "us-east-1" } } as AwsWorkerStatus; },
    start: async (request) => ({ operation: refused(request.operationId), status: { configured: true, handle: { instanceId: "i-0943", region: "us-east-1" } } as AwsWorkerStatus })
  });
  assert.ok(reads >= 1);
  assert.equal((ui.bridge.calls.startAwsWorker?.[0]?.[0] as AwsWorkerStartRequest).intent, "check", "no Check button: the page checks");
  assert.equal(ui.find("aws-worker-state")?.textContent, "Status unavailable");
  assert.match(ui.find("aws-instance-access")?.textContent ?? "", /AWS refuses this app's keys/);
  await ui.click(ui.find("aws-worker-authorization-toggle"));
  assert.match(ui.find("aws-worker-authorization-recovery")?.textContent ?? "", /Fix AWS access/);
  const checkId = (ui.bridge.calls.startAwsWorker?.[0]?.[0] as AwsWorkerStartRequest).operationId;
  assert.deepEqual(ui.bridge.calls.command?.[0], ["us-east-1", checkId], "the command is the recovery for this attempt");
  assert.equal(ui.find("aws-worker-command")?.textContent, "command-for-us-east-1");
  assert.ok(document.querySelector('[aria-label="Copy AWS access command"]'), "copy is the shared icon");
  await unmount();
});

test("a failed update says why in the version row and retries from there", async () => {
  const machine = { id: "m1", name: "Cloud", awsInstanceId: "i-0943" };
  const ui = await mount({
    machines: { machines: [machine], status: [{ machineId: "m1", connected: true, lastHello: { appVersion: "1.11.1-beta.9" } }] },
    installs: [{ machineId: "m1", installedVersion: "1.11.1-beta.9",
      lastOperation: { operationId: "auto-upgrade-1.11.2-beta.3-1", machineId: "m1", kind: "upgrade", phase: "error",
        message: "Installing…", error: "the machine's disk is full", updatedAt: new Date().toISOString() } }],
    appVersion: "1.11.2-beta.3"
  });
  const row = ui.find("aws-program-version");
  assert.match(row?.textContent ?? "", /Version 1\.11\.1-beta\.9/);
  assert.equal(row?.querySelector(".gen-row-error")?.textContent, "The update to 1.11.2-beta.3 failed: the machine's disk is full.");
  await ui.click(ui.find("aws-program-retry"));
  assert.deepEqual(ui.bridge.calls.reconnectAwsMachine?.[0], ["m1"]);
  await unmount();
});

test("the disk shows what fills it, warns when it is low, and cleans up only after asking", async () => {
  const ui = await mount();
  assert.match(ui.find("aws-disk-low")?.textContent ?? "", /Only 3\.7 GB free/);
  assert.match(ui.find("aws-disk-program-logs")?.textContent ?? "", /Program logs · 2\.3 GB/);
  assert.match(ui.find("aws-disk-program-logs")?.textContent ?? "", /Clean up removes logs older than a day: 900 MB\./);
  assert.equal(ui.find("aws-disk-swap")?.querySelector("button"), null, "the swap file has no action");
  await ui.click(ui.find("aws-disk-clean-program-logs"));
  assert.match(ui.find("aws-disk-clean-dialog")?.textContent ?? "", /cannot be undone/);
  assert.equal(ui.bridge.calls.cleanAwsInstanceDisk?.length ?? 0, 0, "nothing before the confirmation");
  await ui.click(ui.find("aws-disk-clean-confirm"));
  assert.deepEqual(ui.bridge.calls.cleanAwsInstanceDisk, [["program-logs"]]);
  assert.equal(ui.find("aws-disk-clean-dialog"), null);
  assert.deepEqual(ui.bridge.calls.getAwsInstanceDisk?.at(-1), [{ refresh: true }], "measured again after the change");
  await unmount();
});

test("setup puts problems first and signs a provider in through its own sign-in", async () => {
  const ui = await mount();
  const rows = [...document.querySelectorAll('[data-testid="aws-setup"] .gen-row[data-testid]')].map((row) => row.getAttribute("data-testid"));
  assert.equal(rows[0], "aws-setup-codex-auth", "the problem comes first");
  assert.ok(rows.includes("aws-setup-connect") && rows.includes("aws-setup-gh"));
  assert.match(ui.find("aws-setup-meta")?.textContent ?? "", /1 of \d+ need attention/);
  assert.match(ui.find("aws-setup-codex-auth")?.querySelector(".gen-row-error")?.textContent ?? "", /Not signed in/);
  await ui.click(ui.find("aws-setup-codex-auth-fix"));
  assert.equal(ui.bridge.calls.setupCloudRunWorker?.length, 1);
  assert.deepEqual(ui.bridge.calls.setupCloudRunWorker?.[0], [undefined, { signIn: "codex-cli" }], "Sign in… signs in that provider only");
  assert.match(ui.find("aws-sign-in-dialog")?.textContent ?? "", /Preparing the sign-in/);
  await act(async () => { for (const listener of ui.bridge.progress) listener({ stage: "codex-auth", message: "Approve", authUrl: "https://auth.example/device", authCode: "K7QF-2M9D" } as CloudRunWorkerSetupProgress); });
  await ui.settle();
  assert.equal(ui.find("aws-sign-in-code")?.textContent, "K7QF-2M9D");
  await ui.click(ui.find("aws-sign-in-open"));
  assert.deepEqual(ui.bridge.calls.openExternal, [["https://auth.example/device"]]);
  await unmount();
});

test("no instance yet: one switch, and connecting needs the pasted result", async () => {
  const ui = await mount({ status: { configured: false } as AwsWorkerStatus, settings: { ...SETTINGS, hasAwsCredentials: false } });
  assert.equal(ui.find<HTMLInputElement>("aws-instance-switch")?.checked, false);
  await ui.click(ui.find("aws-instance-switch"));
  assert.match(ui.find("aws-connect-dialog")?.textContent ?? "", /Connect AWS/);
  assert.equal(ui.find("aws-worker-command")?.textContent, "command-for-us-east-1");
  assert.equal(ui.find<HTMLButtonElement>("aws-worker-connect-start")?.disabled, true);
  await ui.type(document.querySelector<HTMLTextAreaElement>('[aria-label="AWS setup result"]'), "accord-aws-v1:blob");
  assert.equal(ui.find<HTMLButtonElement>("aws-worker-connect-start")?.disabled, false);
  await unmount();
});

test("connecting without the User's server says so before anything is created", async () => {
  const ui = await mount({ status: { configured: false } as AwsWorkerStatus, settings: { ...SETTINGS, hasAwsCredentials: false }, hubUrl: null });
  await ui.click(ui.find("aws-instance-switch"));
  assert.match(ui.find("aws-connect-no-server")?.textContent ?? "", /Set up your server first/);
  await unmount();
  const withServer = await mount({ status: { configured: false } as AwsWorkerStatus, settings: { ...SETTINGS, hasAwsCredentials: false } });
  await withServer.click(withServer.find("aws-instance-switch"));
  assert.equal(withServer.find("aws-connect-no-server"), null);
  await unmount();
});

/** A setup snapshot as the main process sends it. */
function setupSnapshot(operationId: string, steps: AwsSetupStep[], extra: Partial<AwsWorkerOperationSnapshot> = {}): AwsWorkerOperationSnapshot {
  return { operationId, intent: "setup", phase: "setting-up", message: steps.find((step) => step.state === "current")?.detail ?? "", updatedAt: new Date().toISOString(), setupSteps: steps, ...extra };
}

test("setting up shows every step as it runs, a sign-in in its own row with Skip, and can be hidden and shown again", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now });
  let finish!: (value: { operation: AwsWorkerOperationSnapshot; status: AwsWorkerStatus }) => void;
  const ui = await mount({
    status: { configured: false } as AwsWorkerStatus,
    start: () => new Promise((resolve) => { finish = resolve; })
  });
  await ui.click(ui.find("aws-instance-switch"));
  await ui.click(ui.find("aws-worker-connect-start"));
  const operationId = (ui.bridge.calls.startAwsWorker?.[0]?.[0] as AwsWorkerStartRequest).operationId;
  const send = async (operation: AwsWorkerOperationSnapshot): Promise<void> => {
    await act(async () => { for (const listener of ui.bridge.operations) listener(operation); });
    await ui.settle();
  };
  const startedAt = new Date(now - 75_000).toISOString();
  await send(setupSnapshot(operationId, [
    { id: "instance", state: "done", detail: "t3.small · 40 GiB disk · us-east-1" },
    { id: "tools", state: "current", detail: "Installing openjdk-21-jdk…", startedAt },
    { id: "sign-in-codex", state: "pending" },
    { id: "program", state: "pending" }
  ]));
  assert.equal(ui.find("aws-connect-dialog"), null, "the connect window gives way to the steps");
  const steps = ui.find("aws-setup-steps");
  assert.deepEqual([...(steps?.querySelectorAll("li") ?? [])].map((item) => item.getAttribute("data-state")), ["done", "current", "pending", "pending"]);
  assert.match(ui.find("aws-setup-step-tools")?.textContent ?? "", /Installing openjdk-21-jdk…/);
  assert.match(ui.find("aws-setup-step-tools")?.textContent ?? "", /1m 15s/, "the running step shows its time");
  await act(async () => { t.mock.timers.tick(5_000); });
  assert.match(ui.find("aws-setup-step-tools")?.textContent ?? "", /1m 20s/, "and the time keeps moving");

  await send(setupSnapshot(operationId, [
    { id: "instance", state: "done" }, { id: "tools", state: "done", detail: "Installed." },
    { id: "sign-in-codex", state: "current", detail: "Approve the Codex sign-in with the device code." },
    { id: "program", state: "pending" }
  ], { authProvider: "codex-cli", authRequestId: "req-1", authUrl: "https://auth.example/device", authCode: "K7QF-2M9D" }));
  assert.equal(ui.find("aws-setup-sign-in-code")?.textContent, "K7QF-2M9D");
  await ui.click(ui.find("aws-setup-sign-in-open"));
  assert.deepEqual(ui.bridge.calls.openExternal, [["https://auth.example/device"]]);
  await ui.click(ui.find("aws-setup-sign-in-skip"));
  assert.deepEqual(ui.bridge.calls.cancelCloudRunAuth, [["req-1"]]);

  await send(setupSnapshot(operationId, [
    { id: "instance", state: "done" }, { id: "tools", state: "done" },
    { id: "sign-in-codex", state: "skipped", detail: "Codex sign-in skipped." },
    { id: "program", state: "current", detail: "Copying chats to the machine…", startedAt: new Date().toISOString() }
  ]));
  assert.match(ui.find("aws-setup-step-sign-in-codex")?.textContent ?? "", /Codex sign-in skipped\. Sign in later from Setup/);
  await ui.click(ui.find("aws-setup-progress-hide"));
  assert.equal(ui.find("aws-setup-progress"), null);
  assert.match(ui.find("aws-setup-progress-line")?.textContent ?? "", /Cloud program: Copying chats to the machine…/);
  // A new sign-in brings the window back: the setup waits on the User.
  await send(setupSnapshot(operationId, [
    { id: "instance", state: "done" }, { id: "tools", state: "done" }, { id: "sign-in-codex", state: "current" }, { id: "program", state: "pending" }
  ], { authProvider: "codex-cli", authRequestId: "req-2", authUrl: "https://auth.example/device", authCode: "AAAA-BBBB" }));
  assert.equal(ui.find("aws-setup-sign-in-code")?.textContent, "AAAA-BBBB");
  await ui.click(ui.find("aws-setup-progress-hide"));
  await ui.click(ui.find("aws-setup-progress-show"));
  assert.ok(ui.find("aws-setup-progress"));

  const done = setupSnapshot(operationId, [
    { id: "instance", state: "done" }, { id: "tools", state: "done" },
    { id: "sign-in-codex", state: "skipped", detail: "Codex sign-in skipped." }, { id: "program", state: "done", detail: "Installed and connected." }
  ], { phase: "ready", message: "Ready. Codex is not signed in; sign in from Setup on this page when you need it." });
  await act(async () => { finish({ operation: done, status: RUNNING }); });
  await ui.settle();
  assert.match(ui.find("aws-setup-progress-message")?.textContent ?? "", /Ready\. Codex is not signed in/);
  await ui.click(ui.find("aws-setup-progress-done"));
  assert.equal(ui.find("aws-setup-progress"), null);
  await unmount();
});

test("a setup that stopped says where and why, and Try again continues the same setup", async () => {
  const failed = (operationId: string): AwsWorkerOperationSnapshot => setupSnapshot(operationId, [
    { id: "instance", state: "done" }, { id: "tools", state: "done" },
    { id: "program", state: "failed", detail: "Set up your server first (Settings → Your server): cloud machines connect through it." }
  ], { phase: "error", message: "The cloud program could not be installed: Set up your server first." });
  const ui = await mount({ status: { configured: false } as AwsWorkerStatus,
    start: async (request) => ({ operation: failed(request.operationId), status: RUNNING }) });
  await ui.click(ui.find("aws-instance-switch"));
  await ui.click(ui.find("aws-worker-connect-start"));
  assert.match(ui.find("aws-setup-step-program")?.textContent ?? "", /Set up your server first/);
  await ui.click(ui.find("aws-setup-progress-retry"));
  const requests = (ui.bridge.calls.startAwsWorker ?? []).map((call) => call[0] as AwsWorkerStartRequest);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].operationId, requests[0].operationId, "the retry continues the setup that stopped");
  await unmount();
});

test("a setup closed after it stopped shows again when the same setup runs again", async () => {
  const ui = await mount({ status: { configured: false } as AwsWorkerStatus, start: () => new Promise(() => undefined) });
  await ui.click(ui.find("aws-instance-switch"));
  await ui.click(ui.find("aws-worker-connect-start"));
  const operationId = (ui.bridge.calls.startAwsWorker?.[0]?.[0] as AwsWorkerStartRequest).operationId;
  const send = async (operation: AwsWorkerOperationSnapshot): Promise<void> => {
    await act(async () => { for (const listener of ui.bridge.operations) listener(operation); });
    await ui.settle();
  };
  await send(setupSnapshot(operationId, [{ id: "instance", state: "failed", detail: "AWS refused." }], { phase: "error", message: "AWS refused." }));
  await ui.click(ui.button("Close"));
  assert.equal(ui.find("aws-setup-progress"), null);
  await send(setupSnapshot(operationId, [{ id: "instance", state: "current", detail: "Looking for your AWS instance…" }]));
  assert.ok(ui.find("aws-setup-progress"), "the retried setup shows its steps again");
  await unmount();
});

test("a setup hidden while it ran shows again when it is tried again after it stopped", async () => {
  const ui = await mount({ status: { configured: false } as AwsWorkerStatus, start: () => new Promise(() => undefined) });
  await ui.click(ui.find("aws-instance-switch"));
  await ui.click(ui.find("aws-worker-connect-start"));
  const operationId = (ui.bridge.calls.startAwsWorker?.[0]?.[0] as AwsWorkerStartRequest).operationId;
  const send = async (operation: AwsWorkerOperationSnapshot): Promise<void> => {
    await act(async () => { for (const listener of ui.bridge.operations) listener(operation); });
    await ui.settle();
  };
  await send(setupSnapshot(operationId, [{ id: "instance", state: "current", detail: "Looking…" }]));
  await ui.click(ui.find("aws-setup-progress-hide"));
  await send(setupSnapshot(operationId, [{ id: "instance", state: "failed", detail: "AWS refused." }], { phase: "error", message: "AWS refused." }));
  assert.equal(ui.find("aws-setup-progress"), null, "hidden stays hidden while nothing runs");
  await send(setupSnapshot(operationId, [{ id: "instance", state: "current", detail: "Looking…" }]));
  assert.ok(ui.find("aws-setup-progress"), "the retried setup shows its steps again");
  await unmount();
});

test("Install or Fix in Setup signs in nobody", async () => {
  const ui = await mount({ checks: { ok: false, message: "1 problem", checks: [
    { id: "connect", label: "SSH connection", status: "pass" },
    { id: "gh", label: "GitHub CLI", status: "fail", fixable: true }
  ] } });
  await ui.click(ui.find("aws-setup-gh-fix"));
  assert.deepEqual(ui.bridge.calls.setupCloudRunWorker?.[0], [undefined, { signIn: "none" }]);
  await unmount();
});

test("a cloud program that is not installed is installed from its own section", async () => {
  const ui = await mount({ machines: { machines: [], status: [] } as never });
  await ui.click(ui.find("aws-program-install"));
  assert.deepEqual(ui.bridge.calls.reconnectAwsMachine, [[undefined]]);
  await unmount();
});
