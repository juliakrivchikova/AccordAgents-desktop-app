import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { AwsWorkerOperationSnapshot, AwsWorkerStatus, CloudRunsSettings } from "../../../shared/types";
import { AwsWorkerPanel } from "./aws-worker-panel";

const SETTINGS: CloudRunsSettings = {
  enabled: true,
  mode: "aws",
  worker: {},
  hasAwsCredentials: true,
  awsInstanceType: "t3.small",
  awsRootVolumeSizeGb: 8,
  maxRuntimeMs: 86_400_000,
  pollIntervalMs: 2_500
};

test("Retry reuses the persisted operation and client token", async () => {
  const operation: AwsWorkerOperationSnapshot = {
    operationId: "op-existing",
    clientToken: "token-existing",
    phase: "error",
    message: "Retry safely",
    updatedAt: "2026-07-10T00:00:00.000Z",
    retryable: true
  };
  const requests: any[] = [];
  const renderer = await renderPanel({
    status: { configured: true, state: "stopped", operation },
    start: async (request) => {
      requests.push(request);
      return {
        operation: { ...operation, phase: "ready", message: "Ready" },
        status: { configured: true, state: "running" }
      };
    }
  });
  const retry = renderer.root.findByProps({ "data-testid": "aws-worker-start" });
  assert.equal(textOf(retry), "Retry");
  await click(retry);
  assert.equal(requests[0].operationId, "op-existing");
  assert.equal(requests[0].clientToken, "token-existing");
  renderer.unmount();
});

test("authorization recovery exposes the setup command and sends the refreshed blob on Retry", async () => {
  const operation: AwsWorkerOperationSnapshot = {
    operationId: "op-auth",
    clientToken: "token-auth",
    phase: "error",
    message: "Update AWS permissions below",
    updatedAt: "2026-07-10T00:00:00.000Z",
    retryable: true,
    remediation: "refresh-aws-authorization"
  };
  const requests: any[] = [];
  const renderer = await renderPanel({
    status: { configured: true, state: "running", operation },
    start: async (request) => {
      requests.push(request);
      return {
        operation: { ...operation, phase: "ready", message: "Ready", remediation: undefined },
        status: { configured: true, state: "running" }
      };
    }
  });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-recovery" })).includes("Update AWS permissions"), true);
  await click(findButton(renderer, "Show setup command"));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-command" })), "command");
  await change(renderer.root.findByProps({ "aria-label": "AWS setup result" }), "accord-aws-v1:updated");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-start" }));
  assert.equal(requests[0].blob, "accord-aws-v1:updated");
  assert.equal(requests[0].operationId, "op-auth");
  assert.equal(requests[0].clientToken, "token-auth");
  renderer.unmount();
});

test("failed Stop remains visible with the observed worker state", async () => {
  const renderer = await renderPanel({
    status: { configured: true, state: "running" },
    stop: async () => ({
      configured: true,
      state: "running",
      message: "The shared worker was not stopped; settings were retained. Observed state: running. UnauthorizedOperation"
    })
  });
  await click(findButton(renderer, "Stop"));
  await click(findButton(renderer, "Confirm stop"));
  assert.equal(textOf(renderer.root).includes("The shared worker was not stopped"), true);
  assert.equal(textOf(renderer.root).includes("running"), true);
  renderer.unmount();
});

test("successful Delete refreshes enclosing settings while failed Delete does not", async () => {
  let deleted = 0;
  const renderer = await renderPanel({
    status: { configured: true, state: "stopped" },
    remove: async () => ({ configured: false }),
    onDeleted: async () => { deleted += 1; }
  });
  await click(findButton(renderer, "Delete"));
  await click(findButton(renderer, "Confirm delete"));
  assert.equal(deleted, 1);
  renderer.unmount();

  const failed = await renderPanel({
    status: { configured: true, state: "stopped" },
    remove: async () => ({ configured: true, state: "stopped", message: "Termination was not confirmed" }),
    onDeleted: async () => { deleted += 1; }
  });
  await click(findButton(failed, "Delete"));
  await click(findButton(failed, "Confirm delete"));
  assert.equal(deleted, 1);
  failed.unmount();
});

test("a pending mismatch freezes size controls and submits the displayed desired spec", async () => {
  const mismatch = {
    instanceId: "i-shared",
    actual: { instanceId: "i-shared", region: "us-east-1", instanceType: "t3.small", rootVolumeSizeGb: 8 },
    desired: { instanceType: "t3.medium", rootVolumeSizeGb: 16 },
    diskTooSmall: true,
    computeTooSmall: true
  };
  const operation: AwsWorkerOperationSnapshot = {
    operationId: "op-decision",
    clientToken: "token-decision",
    phase: "needs-decision",
    message: "Choose",
    updatedAt: "2026-07-10T00:00:00.000Z",
    specMismatch: mismatch
  };
  const requests: any[] = [];
  const renderer = await renderPanel({
    settings: { ...SETTINGS, awsInstanceType: "t3.medium", awsRootVolumeSizeGb: 16 },
    status: { configured: true, state: "stopped", operation },
    start: async (request) => {
      requests.push(request);
      return { operation: { ...operation, phase: "ready" }, status: { configured: true, state: "running" } };
    }
  });
  assert.equal(renderer.root.findByProps({ "aria-label": "AWS worker instance type" }).props.disabled, true);
  assert.equal(renderer.root.findByProps({ "aria-label": "AWS worker disk size" }).props.disabled, true);
  await click(findButton(renderer, "Keep using"));
  assert.deepEqual(requests[0].expectedDesiredSpec, mismatch.desired);
  assert.equal(requests[0].expectedInstanceId, "i-shared");
  renderer.unmount();
});

async function renderPanel(options: {
  settings?: CloudRunsSettings;
  status: AwsWorkerStatus;
  start?: (request: any) => Promise<any>;
  stop?: () => Promise<AwsWorkerStatus>;
  remove?: () => Promise<AwsWorkerStatus>;
  onDeleted?: () => Promise<void>;
}): Promise<ReactTestRenderer> {
  const bridge = {
    getAwsWorkerStatus: async () => options.status,
    onAwsWorkerProgress: () => () => undefined,
    startAwsWorker: options.start ?? (async () => ({ operation: options.status.operation, status: options.status })),
    deleteAwsWorker: options.remove ?? (async () => options.status),
    stopAwsWorker: options.stop ?? (async () => options.status),
    getAwsWorkerBootstrapCommand: async () => "command",
    openExternal: async () => undefined
  };
  (globalThis as any).window = { consensus: bridge, setTimeout };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => undefined } }
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AwsWorkerPanel
        settings={options.settings ?? SETTINGS}
        onInstanceTypeChange={() => undefined}
        onDiskSizeChange={() => undefined}
        onDeleted={options.onDeleted ?? (async () => undefined)}
      />
    );
    await flush();
  });
  return renderer;
}

function findButton(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.find((node) => node.type === "button" && textOf(node) === label);
}

async function click(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    node.props.onClick();
    await flush();
  });
}

async function change(node: ReactTestInstance, value: string): Promise<void> {
  await act(async () => {
    node.props.onChange({ target: { value } });
    await flush();
  });
}

function textOf(node: ReactTestInstance): string {
  const visit = (value: ReactTestInstance | string): string => typeof value === "string"
    ? value
    : value.children.map((child) => visit(child as ReactTestInstance | string)).join("");
  return visit(node);
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
