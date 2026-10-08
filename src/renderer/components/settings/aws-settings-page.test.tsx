import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

import type { AwsWorkerOperationSnapshot, AwsWorkerStartRequest, AwsWorkerStatus, CloudRunWorkerSetupProgress } from "../../../shared/types";
import { SETTINGS, mount, unmount } from "./aws-settings-page-harness.test";

test("the page is sections: status, program, instance, disk and setup", async () => {
  const ui = await mount();
  assert.equal(ui.find("aws-worker-state")?.textContent, "Running · billable");
  const titles = [...document.querySelectorAll(".gen-section-title")].map((title) => title.textContent);
  assert.deepEqual(titles, ["Cloud program", "Instance", "Disk", "Setup"]);
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

test("the file browser locks a member's work and deletes only what was chosen", async () => {
  const ui = await mount();
  await ui.click(ui.find("aws-disk-browse-project-copies"));
  assert.deepEqual(ui.bridge.calls.listAwsInstanceFiles?.[0], ["@mirrors"]);
  const tree = ui.find("aws-disk-tree");
  assert.match(tree?.textContent ?? "", /has a member's worktree/);
  assert.equal(tree?.querySelector('input[aria-label="Select AccordAgents-0a6205133d"]'), null, "locked: no checkbox");
  await ui.click(tree?.querySelector('input[aria-label="Select old-project-1234567890"]') ?? null);
  assert.match(ui.find("aws-disk-delete")?.textContent ?? "", /Delete 300 MB/);
  await ui.click(ui.find("aws-disk-delete"));
  assert.deepEqual(ui.bridge.calls.deleteAwsInstanceFiles, [[["/home/ubuntu/own/workspace/mirrors/old-project-1234567890"]]]);
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
