import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { AwsWorkerStatus, CloudRunsSettings, SetAwsAutoStopRequest } from "../../../shared/types";
import { AwsWorkerPanel } from "./aws-worker-panel";

declare global {
  var ACCORD_RENDERER_JSDOM: boolean | undefined;
}

const SETTINGS: CloudRunsSettings = { enabled: true, mode: "aws", worker: {}, hasAwsCredentials: true, awsInstanceType: "t3.small",
  awsRootVolumeSizeGb: 8, maxRuntimeMs: 86_400_000, pollIntervalMs: 2_500, awsRegion: "us-east-1" } as CloudRunsSettings;
const OFF: AwsWorkerStatus = { configured: true, state: "running",
  handle: { instanceId: "i-0943b28f7231ab93c", region: "eu-west-1" },
  actualSpec: { instanceId: "i-0943b28f7231ab93c", region: "eu-west-1", instanceType: "t3.small", rootVolumeSizeGb: 16 },
  autoStop: { enabled: false, needsSetup: true } } as AwsWorkerStatus;

let mounted: ReturnType<typeof createRoot> | undefined;

async function mount(setAutoStop: (request: SetAwsAutoStopRequest) => Promise<AwsWorkerStatus>) {
  assert.equal(globalThis.ACCORD_RENDERER_JSDOM, true, "run this test with scripts/renderer-jsdom-setup.mjs");
  if (mounted) { const previous = mounted; mounted = undefined; await act(async () => { previous.unmount(); }); }
  const regions: string[] = [];
  let status = OFF;
  (window as unknown as { consensus: unknown }).consensus = {
    getAwsWorkerStatus: async () => status,
    onAwsWorkerProgress: () => () => undefined,
    listMachines: async () => ({ machines: [], status: [] }), onMachinesUpdated: () => () => undefined,
    listMachineInstalls: async () => [], getAppVersion: async () => "1.0.0", onMachineInstallProgress: () => () => undefined,
    onCloudRunSetupProgress: () => () => undefined, getCloudRunSetupProgress: async () => undefined,
    getAwsWorkerBootstrapCommand: async (region: string) => { regions.push(region); return `setup-command-for-${region}`; },
    setAwsAutoStop: async (request: SetAwsAutoStopRequest) => { status = await setAutoStop(request); return status; },
    reconnectAwsMachine: async () => status
  };
  document.body.replaceChildren();
  const container = document.createElement("div");
  container.className = "settings-view";
  document.body.append(container);
  const root = createRoot(container);
  mounted = root;
  await act(async () => { root.render(<AwsWorkerPanel settings={SETTINGS} onDeleted={async () => undefined} />); });
  await act(async () => {});
  const find = <T extends HTMLElement>(testId: string): T | null => document.querySelector<T>(`[data-testid="${testId}"]`);
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await act(async () => {}); };
  const click = async (element: Element | null): Promise<void> => {
    assert.ok(element, "missing element to click");
    await act(async () => { (element as HTMLElement).click(); });
    await settle();
  };
  const paste = async (value: string): Promise<void> => {
    const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="AWS setup result"]');
    assert.ok(textarea);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => { setter?.call(textarea, value); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  return { regions, find, click, paste, settle };
}

test("turning automatic stop on opens everything it needs; the switch reads on only after the result is applied", async () => {
  const requests: SetAwsAutoStopRequest[] = [];
  const ui = await mount(async (request) => { requests.push(request); return { ...OFF, autoStop: { enabled: true, needsSetup: false } }; });
  const toggle = () => ui.find<HTMLInputElement>("aws-worker-auto-stop-toggle");
  assert.equal(toggle()?.checked, false);
  await ui.click(toggle());
  assert.ok(ui.find("aws-worker-auto-stop-dialog"), "the dialog opens");
  assert.equal(toggle()?.checked, false, "nothing is on before the setup is applied");
  assert.deepEqual(ui.regions, ["eu-west-1"], "the command is for the instance's own region, shown without another click");
  assert.equal(ui.find("aws-worker-auto-stop-command")?.textContent, "setup-command-for-eu-west-1");
  const apply = () => ui.find<HTMLButtonElement>("aws-worker-auto-stop-apply");
  assert.equal(apply()?.disabled, true, "nothing to apply before a result is pasted");
  await ui.paste("  accord-aws-v1:pasted  ");
  await ui.click(apply());
  assert.deepEqual(requests, [{ enabled: true, blob: "accord-aws-v1:pasted" }]);
  assert.equal(ui.find("aws-worker-auto-stop-dialog"), null, "the dialog closes");
  assert.equal(toggle()?.checked, true);
  await act(async () => { mounted?.unmount(); });
  mounted = undefined;
});

test("a result that cannot be applied keeps the dialog open with the reason and the switch off", async () => {
  const ui = await mount(async () => {
    throw new Error("Error invoking remote method 'cloud-runs:aws-auto-stop': Error: This result has no automatic-stop key. Copy the command shown here again and run it; it makes one.");
  });
  await ui.click(ui.find("aws-worker-auto-stop-toggle"));
  await ui.paste("accord-aws-v1:old");
  await ui.click(ui.find("aws-worker-auto-stop-apply"));
  assert.ok(ui.find("aws-worker-auto-stop-dialog"));
  assert.equal(ui.find("aws-worker-auto-stop-error")?.textContent,
    "This result has no automatic-stop key. Copy the command shown here again and run it; it makes one.");
  assert.equal(ui.find<HTMLInputElement>("aws-worker-auto-stop-toggle")?.checked, false);
  const cancel = [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
  await ui.click(cancel ?? null);
  assert.equal(ui.find("aws-worker-auto-stop-dialog"), null);
  assert.equal(ui.find<HTMLInputElement>("aws-worker-auto-stop-toggle")?.checked, false, "cancelled, the switch stays off");
  await act(async () => { mounted?.unmount(); });
  mounted = undefined;
});
