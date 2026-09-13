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

test("authorization recovery exposes the setup command and applies the refreshed blob", async () => {
  const operation: AwsWorkerOperationSnapshot = {
    operationId: "op-auth",
    clientToken: "token-auth",
    phase: "error",
    message: "Cloud Run cannot access required AWS APIs",
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
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-message" })), /cannot access required AWS APIs/);
  await click(findButton(renderer, "Refresh status"));
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-message" })), /cannot access required AWS APIs/);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-authorization-recovery" }).length, 0);
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-toggle" }));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-recovery" })).includes("AWS administrator update required"), true);
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-steps" })), /cannot update their own permissions/);
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-steps" })), /send the copied command to your AWS administrator/);
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-start" })), "Retry existing permissions");
  await click(findButton(renderer, "Show setup command"));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-command" })), "command");
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-apply-authorization" }).props.disabled, true);
  await change(renderer.root.findByProps({ "aria-label": "AWS setup result" }), "accord-aws-v1:updated");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-toggle" }));
  assert.equal(renderer.root.findAllByProps({ "aria-label": "AWS setup result" }).length, 0);
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-toggle" }));
  assert.equal(renderer.root.findByProps({ "aria-label": "AWS setup result" }).props.value, "accord-aws-v1:updated");
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-apply-authorization" }).props.disabled, false);
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-apply-authorization" }));
  assert.equal(requests[0].blob, "accord-aws-v1:updated");
  assert.equal(requests[0].operationId, "op-auth");
  assert.equal(requests[0].clientToken, "token-auth");
  renderer.unmount();
});

test("authorization recovery for the active IAM user updates policy in place without paste", async () => {
  const operation: AwsWorkerOperationSnapshot = {
    operationId: "op-auth",
    clientToken: "token-auth",
    phase: "error",
    message: "Cloud Run cannot access required AWS APIs",
    updatedAt: "2026-08-13T00:00:00.000Z",
    retryable: true,
    remediation: "refresh-aws-authorization",
    missingAwsActions: ["ec2:DescribeInstanceTypes"],
    awsPrincipalUserName: "accordagents-worker-pna6gbah"
  };
  const renderer = await renderPanel({
    status: { configured: true, state: "running", operation }
  });

  await click(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-toggle" }));
  const steps = textOf(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-steps" }));
  assert.match(steps, /accordagents-worker-pna6gbah/);
  assert.match(steps, /ec2:DescribeInstanceTypes/);
  assert.match(steps, /updates that user's policy in place/);
  await click(findButton(renderer, "Show update command"));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-command" })), "command");
  assert.equal(renderer.root.findAllByProps({ "aria-label": "AWS setup result" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-apply-authorization" }).length, 0);
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-start" })), "Retry existing permissions");
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

test("larger desired disk shows an unapplied change and submits grow-disk directly", async () => {
  const requests: any[] = [];
  const renderer = await renderPanel({
    settings: { ...SETTINGS, awsRootVolumeSizeGb: 20 },
    status: {
      configured: true,
      state: "running",
      actualSpec: {
        instanceId: "i-shared",
        region: "us-east-1",
        instanceType: "t3.small",
        rootVolumeSizeGb: 8
      }
    },
    start: async (request) => {
      requests.push(request);
      return {
        operation: { operationId: request.operationId, phase: "ready", message: "Ready", updatedAt: "2026-08-14T00:00:00.000Z" },
        status: { configured: true, state: "running" }
      };
    }
  });

  assert.equal(renderer.root.findAllByProps({ "aria-label": "AWS worker disk size" }).length, 0);
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-actual-specs" })), /t3\.small8 GB disk/);
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-config-toggle" }));
  assert.equal(renderer.root.findByProps({ "aria-label": "AWS worker disk size" }).props.value, 20);
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-unapplied-size" })), /Size change not applied/);
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-start" })), "Apply disk resize to 20 GB");
  assert.equal(textOf(findButton(renderer, "Refresh status")), "Refresh status");

  await click(renderer.root.findByProps({ "data-testid": "aws-worker-start" }));
  assert.equal(requests[0].resolution, "grow-disk");
  assert.equal(requests[0].expectedInstanceId, "i-shared");
  assert.deepEqual(requests[0].expectedDesiredSpec, { instanceType: "t3.small", rootVolumeSizeGb: 20 });
  renderer.unmount();
});

test("successful Delete refreshes enclosing settings while failed Delete does not", async () => {
  let deleted = 0;
  const renderer = await renderPanel({
    status: { configured: true, state: "stopped" },
    remove: async () => ({ configured: false }),
    onDeleted: async () => { deleted += 1; }
  });
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-config-toggle" }));
  await click(findButton(renderer, "Delete"));
  await click(findButton(renderer, "Confirm delete"));
  assert.equal(deleted, 1);
  renderer.unmount();

  const failed = await renderPanel({
    status: { configured: true, state: "stopped" },
    remove: async () => ({ configured: true, state: "stopped", message: "Termination was not confirmed" }),
    onDeleted: async () => { deleted += 1; }
  });
  await click(failed.root.findByProps({ "data-testid": "aws-worker-config-toggle" }));
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
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-config-toggle" }));
  assert.equal(renderer.root.findByProps({ "aria-label": "AWS worker instance type" }).props.disabled, true);
  assert.equal(renderer.root.findByProps({ "aria-label": "AWS worker disk size" }).props.disabled, true);
  await click(findButton(renderer, "Keep using"));
  assert.deepEqual(requests[0].expectedDesiredSpec, mismatch.desired);
  assert.equal(requests[0].expectedInstanceId, "i-shared");
  renderer.unmount();
});

test("active progress survives disclosure changes and disappears after completion", async () => {
  let progress!: (operation: AwsWorkerOperationSnapshot) => void;
  let finish!: (value: any) => void;
  const operation: AwsWorkerOperationSnapshot = {
    operationId: "active", phase: "setting-up", message: "Preparing provider", updatedAt: "2026-09-12T00:00:00Z"
  };
  const renderer = await renderPanel({
    status: { configured: true, state: "stopped" },
    onProgress: (listener) => { progress = listener; },
    start: (request) => { operation.operationId = request.operationId; return new Promise(resolve => { finish = resolve; }); }
  });
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-config-toggle" }).props["aria-expanded"], false);
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-start" }));
  await act(async () => { progress(operation); await flush(); });
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-message" })), /Preparing provider/);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-progress" }).length, 1);
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-config-toggle" }));
  assert.equal(renderer.root.findByProps({ "aria-label": "AWS worker disk size" }).props.disabled, true);
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-config-toggle" }));
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-progress" }).length, 1);
  await act(async () => {
    finish({ status: { configured: true, state: "running" }, operation: { ...operation, phase: "ready", message: "Ready" } });
    await flush();
  });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-progress" }).length, 0);
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Running · billable");
  renderer.unmount();
});

test("failed status lookup stays visible and can be refreshed without starting an instance", async () => {
  let reads = 0;
  let starts = 0;
  const renderer = await renderPanel({
    status: { configured: true, state: "running" },
    getStatus: async () => {
      if (++reads === 1) throw new Error("AWS is unreachable");
      return { configured: true, state: "running" };
    },
    start: async () => { starts++; throw new Error("Unexpected start"); }
  });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Status unavailable");
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-message" }).props.role, "alert");
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-start" }).props.disabled, true);
  await click(findButton(renderer, "Refresh status"));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Running · billable");
  assert.equal(starts, 0);
  renderer.unmount();
});

test("a rejected action displays its error and leaves Retry available", async () => {
  const renderer = await renderPanel({
    status: { configured: true, state: "stopped" },
    start: async () => { throw new Error("Connection lost while starting"); }
  });
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-start" }));
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-message" })), /Connection lost/);
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-message" }).props.role, "alert");
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-start" }).props.disabled, false);
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-start" })), "Retry");
  renderer.unmount();
});

test("a current AWS lookup error takes precedence over an old successful operation", async () => {
  const renderer = await renderPanel({ status: {
    configured: true, message: "AWS credentials expired",
    operation: { operationId: "old", phase: "ready", message: "Ready", updatedAt: "2026-09-11T00:00:00Z" }
  } });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Status unavailable");
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-message" })), "AWS credentials expired");
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-message" }).props.role, "alert");
  renderer.unmount();
});

async function renderPanel(options: {
  settings?: CloudRunsSettings;
  status: AwsWorkerStatus;
  getStatus?: () => Promise<AwsWorkerStatus>;
  onProgress?: (listener: (operation: AwsWorkerOperationSnapshot) => void) => void;
  start?: (request: any) => Promise<any>;
  stop?: () => Promise<AwsWorkerStatus>;
  remove?: () => Promise<AwsWorkerStatus>;
  onDeleted?: () => Promise<void>;
}): Promise<ReactTestRenderer> {
  const bridge = {
    getAwsWorkerStatus: options.getStatus ?? (async () => options.status),
    onAwsWorkerProgress: (listener: (operation: AwsWorkerOperationSnapshot) => void) => { options.onProgress?.(listener); return () => undefined; },
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
