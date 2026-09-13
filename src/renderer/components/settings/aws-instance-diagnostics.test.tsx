import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { CloudRunWorkerSetupProgress } from "../../../shared/types";
import { AwsInstanceDiagnostics } from "./aws-instance-diagnostics";

test("diagnostics stay collapsed until requested and keep the actual result visible when closed", async () => {
  let checks = 0;
  const renderer = await renderDiagnostics({
    diagnose: async () => { checks++; return { ok: true, message: "Provider available", checks: [{ id: "provider", label: "Codex", status: "pass" }] }; }
  });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "machine-instance-check" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "machine-instance-diagnostics-status" }).length, 0);
  await click(renderer, "machine-instance-diagnostics-toggle");
  await click(renderer, "machine-instance-check");
  assert.equal(checks, 1);
  await click(renderer, "machine-instance-diagnostics-toggle");
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Instance checks" }).length, 0);
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "machine-instance-diagnostics-status" })), /Provider available/);
  await click(renderer, "machine-instance-diagnostics-toggle");
  assert.match(textOf(renderer.root.findByProps({ "aria-label": "Instance checks" })), /Codex/);
  renderer.unmount();
});

test("closing diagnostics during setup preserves sign-in, busy controls and the final error", async () => {
  let publish!: (value: CloudRunWorkerSetupProgress) => void;
  let finish!: (value: any) => void;
  const renderer = await renderDiagnostics({
    onProgress: (listener) => { publish = listener; },
    setup: () => new Promise(resolve => { finish = resolve; })
  });
  await click(renderer, "machine-instance-diagnostics-toggle");
  await click(renderer, "machine-instance-setup");
  await act(async () => {
    publish({ message: "Sign in to continue", authUrl: "https://example.invalid/sign-in", authCode: "TEST-CODE" } as CloudRunWorkerSetupProgress);
  });
  assert.equal(renderer.root.findByProps({ "data-testid": "machine-instance-check" }).props.disabled, true);
  await click(renderer, "machine-instance-diagnostics-toggle");
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "cloud-run-device-auth-code" })), "TEST-CODE");
  await act(async () => {
    finish({ ok: false, message: "Provider sign-in not completed", checks: [] });
    await flush();
  });
  const status = renderer.root.findByProps({ "data-testid": "machine-instance-diagnostics-status" });
  assert.equal(status.props.role, "alert");
  assert.match(textOf(status), /not completed/);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "cloud-run-device-auth-code" }).length, 0);
  await click(renderer, "machine-instance-diagnostics-toggle");
  assert.equal(renderer.root.findByProps({ "data-testid": "machine-instance-check" }).props.disabled, false);
  renderer.unmount();
});

async function renderDiagnostics(options: {
  diagnose?: () => Promise<any>;
  setup?: () => Promise<any>;
  onProgress?: (listener: (value: CloudRunWorkerSetupProgress) => void) => void;
}): Promise<ReactTestRenderer> {
  (globalThis as any).window = { consensus: {
    diagnoseCloudRunWorker: options.diagnose,
    setupCloudRunWorker: options.setup,
    onCloudRunSetupProgress: (listener: (value: CloudRunWorkerSetupProgress) => void) => { options.onProgress?.(listener); return () => undefined; },
    openExternal: async () => undefined
  } };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AwsInstanceDiagnostics />); await flush(); });
  return renderer;
}

async function click(renderer: ReactTestRenderer, testId: string): Promise<void> {
  await act(async () => { renderer.root.findByProps({ "data-testid": testId }).props.onClick(); await flush(); });
}

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === "string" ? child : textOf(child)).join("");
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}
