import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { AwsWorkerOperationSnapshot, AwsWorkerStartRequest, AwsWorkerStatus, CloudRunsSettings } from "../../../shared/types";
import { AwsWorkerPanel } from "./aws-worker-panel";
import { AWS_TRANSITION_POLL_MS } from "./use-aws-worker-status";

const SETTINGS: CloudRunsSettings = { enabled: true, mode: "aws", worker: {}, hasAwsCredentials: true, awsInstanceType: "t3.small", awsRootVolumeSizeGb: 8, maxRuntimeMs: 86_400_000, pollIntervalMs: 2_500 };
const RUNNING: AwsWorkerStatus = { configured: true, state: "running", actualSpec: { instanceId: "i-shared", region: "us-east-1", instanceType: "t3.small", rootVolumeSizeGb: 40 } };
const OLD_ERROR: AwsWorkerOperationSnapshot = { operationId: "old", clientToken: "old-token", phase: "error", message: "Missing AWS permission", updatedAt: "2026-07-10T00:00:00Z", retryable: true, remediation: "refresh-aws-authorization" };

function ready(request: AwsWorkerStartRequest, status = RUNNING) {
  const operation: AwsWorkerOperationSnapshot = { operationId: request.operationId, intent: request.intent, phase: "ready", message: "Ready", updatedAt: new Date().toISOString() };
  return { status: { ...status, operation }, operation };
}

test("opening Settings archives old errors and does not claim the saved 8 GiB is a requested change", async () => {
  let writes = 0;
  const renderer = await renderPanel({ status: { ...RUNNING, operation: OLD_ERROR }, start: async request => { writes++; return ready(request); } });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-message" }).length, 0);
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-history" })), /Missing AWS permission/);
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-history" }).props.open, undefined);
  assert.equal(textOf(renderer.root).includes("Size change not applied"), false);
  await edit(renderer);
  assert.equal(renderer.root.findByProps({ "aria-label": "AWS worker disk size" }).props.value, "40");
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-size-apply" }).props.disabled, true);
  assert.equal(writes, 0);
  unmount(renderer);
});

test("40 to 41 GiB is an explicit draft, cancellation writes nothing, Apply sends the exact change", async () => {
  const requests: AwsWorkerStartRequest[] = [];
  const renderer = await renderPanel({ status: RUNNING, start: async request => { requests.push(request); return ready(request, { ...RUNNING, actualSpec: { ...RUNNING.actualSpec!, rootVolumeSizeGb: 41 } }); } });
  await edit(renderer);
  await change(renderer.root.findByProps({ "aria-label": "AWS worker disk size" }), "41");
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-size-preview" })), /40 → 41 GiB/);
  assert.equal(requests.length, 0);
  await click(findButton(renderer, "Cancel"));
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-size-edit" }));
  assert.equal(renderer.root.findByProps({ "aria-label": "AWS worker disk size" }).props.value, "40");
  await change(renderer.root.findByProps({ "aria-label": "AWS worker disk size" }), "41");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-size-apply" }));
  assert.equal(requests[0].rootVolumeSizeGb, 41);
  assert.equal(requests[0].resolution, "grow-disk");
  assert.equal(requests[0].expectedInstanceId, "i-shared");
  assert.equal(requests[0].expectedActualSpec?.rootVolumeSizeGb, 40);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-size-editor" }).length, 0);
  unmount(renderer);
});

test("invalid, fractional and smaller sizes explain the restriction before sending anything", async () => {
  let requests = 0;
  const renderer = await renderPanel({ status: RUNNING, start: async request => { requests++; return ready(request); } });
  await edit(renderer);
  for (const value of ["", "8", "39", "40.5", "1025"]) {
    await change(renderer.root.findByProps({ "aria-label": "AWS worker disk size" }), value);
    assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-size-apply" }).props.disabled, true, value);
    assert.ok(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-size-error" })).length);
  }
  assert.equal(requests, 0);
  unmount(renderer);
});

test("a resize failure stays beside its draft and is not confused with a historical setup failure", async () => {
  const renderer = await renderPanel({ status: { ...RUNNING, operation: OLD_ERROR }, start: async request => {
    const operation = { ...OLD_ERROR, operationId: request.operationId, intent: "resize" as const, message: "Disk expansion was denied" };
    return { status: { ...RUNNING, operation }, operation };
  } });
  await edit(renderer);
  await change(renderer.root.findByProps({ "aria-label": "AWS worker disk size" }), "41");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-size-apply" }));
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-size-error" })), /Disk expansion was denied/);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-message" }).length, 0);
  unmount(renderer);
});

test("Stop shows immediate progress, rejects duplicate clicks and polls until AWS confirms stopped", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let state: AwsWorkerStatus = { ...RUNNING, operation: OLD_ERROR };
  let stopCalls = 0;
  let resolveStop!: (value: AwsWorkerStatus) => void;
  const renderer = await renderPanel({ status: state, getStatus: async () => state, stop: () => { stopCalls++; return new Promise(resolve => { resolveStop = resolve; }); } });
  await click(findButton(renderer, "Stop"));
  await click(findButton(renderer, "Confirm stop"));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-start" })), "Sending Stop…");
  assert.equal(findButton(renderer, "Stop").props.disabled, true);
  state = { ...state, state: "stopping" };
  await act(async () => { resolveStop(state); await flush(); });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-message" }).length, 0);
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-transition" })), /updates automatically/);
  state = { ...state, state: "stopped" };
  await act(async () => { t.mock.timers.tick(AWS_TRANSITION_POLL_MS); await flush(); });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Stopped");
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-transition" }).length, 0);
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-start" })), "Start instance");
  assert.equal(stopCalls, 1);
  unmount(renderer);
});

test("accepted Stop continues polling when the first AWS response still says running", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let state = RUNNING;
  let reads = 0;
  const renderer = await renderPanel({ status: state, getStatus: async () => { reads++; return state; }, stop: async () => state });
  await click(findButton(renderer, "Stop")); await click(findButton(renderer, "Confirm stop"));
  assert.equal(findButton(renderer, "Stop").props.disabled, true);
  state = { ...state, state: "stopped" };
  await act(async () => { t.mock.timers.tick(AWS_TRANSITION_POLL_MS); await flush(); });
  assert.equal(reads, 2);
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Stopped");
  unmount(renderer);
});

test("reopening during stopping resumes observation, survives a failed poll, and never sends Stop again", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let reads = 0;
  let commands = 0;
  const renderer = await renderPanel({ status: RUNNING, getStatus: async () => {
    reads++;
    if (reads === 2) return { configured: true, message: "Network unavailable" };
    return { ...RUNNING, state: reads > 2 ? "stopped" : "stopping", operation: OLD_ERROR };
  }, stop: async () => { commands++; return RUNNING; } });
  await act(async () => { t.mock.timers.tick(AWS_TRANSITION_POLL_MS); await flush(); });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Stopping");
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-transition" })), /last confirmed state/);
  await act(async () => { t.mock.timers.tick(AWS_TRANSITION_POLL_MS); await flush(); });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Stopped");
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-message" }).length, 0);
  assert.equal(commands, 0);
  unmount(renderer);
});

test("a delayed pre-Stop lookup cannot replace the newer Stop result", async () => {
  let reads = 0;
  let stale!: (value: AwsWorkerStatus) => void;
  const renderer = await renderPanel({ status: RUNNING, getStatus: async () => ++reads === 1 ? RUNNING : new Promise(resolve => { stale = resolve; }), stop: async () => ({ ...RUNNING, state: "stopping" }) });
  await click(findButton(renderer, "Refresh status"));
  await click(findButton(renderer, "Stop")); await click(findButton(renderer, "Confirm stop"));
  await act(async () => { stale(RUNNING); await flush(); });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Stopping");
  unmount(renderer);
});

test("a failed Stop is an action failure even when a previous setup was successful", async () => {
  const renderer = await renderPanel({ status: RUNNING, stop: async () => ({ ...RUNNING, actionError: "UnauthorizedOperation", message: "The worker was not stopped: UnauthorizedOperation" }) });
  await click(findButton(renderer, "Stop")); await click(findButton(renderer, "Confirm stop"));
  const feedback = renderer.root.findByProps({ "data-testid": "aws-worker-message" });
  assert.match(textOf(feedback), /Stop: .*not stopped/);
  assert.equal(feedback.props.role, "alert");
  assert.equal(findButton(renderer, "Stop").props.disabled, false);
  unmount(renderer);
});

test("status errors stay current, can be refreshed and do not invoke setup", async () => {
  let reads = 0;
  let starts = 0;
  const renderer = await renderPanel({ status: RUNNING, getStatus: async () => { if (++reads === 1) throw new Error("AWS is unreachable"); return RUNNING; }, start: async request => { starts++; return ready(request); } });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Status unavailable");
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-start" }).props.disabled, true);
  await click(findButton(renderer, "Refresh status"));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Running · billable");
  assert.equal(starts, 0);
  unmount(renderer);
});

test("authorization recovery stays reachable in history and preserves the retry token", async () => {
  const requests: AwsWorkerStartRequest[] = [];
  const renderer = await renderPanel({ status: { ...RUNNING, operation: OLD_ERROR }, start: async request => { requests.push(request); return ready(request); } });
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-toggle" }));
  await click(findButton(renderer, "Show setup command"));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-command" })), "command");
  await change(renderer.root.findByProps({ "aria-label": "AWS setup result" }), "accord-aws-v1:updated");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-apply-authorization" }));
  assert.equal(requests[0].blob, "accord-aws-v1:updated");
  assert.equal(requests[0].operationId, "old");
  assert.equal(requests[0].clientToken, "old-token");
  assert.equal(requests[0].rootVolumeSizeGb, 40);
  unmount(renderer);
});

test("known IAM user recovery still offers its update command without generating a new credential", async () => {
  const renderer = await renderPanel({ status: { ...RUNNING, operation: { ...OLD_ERROR, awsPrincipalUserName: "worker-user", missingAwsActions: ["ec2:DescribeInstanceTypes"] } } });
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-toggle" }));
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-steps" })), /worker-user/);
  await click(findButton(renderer, "Show update command"));
  assert.equal(renderer.root.findAllByProps({ "aria-label": "AWS setup result" }).length, 0);
  unmount(renderer);
});

test("setup streams only its own progress and a failed request has a retry", async () => {
  let progress!: (value: AwsWorkerOperationSnapshot) => void;
  let reject!: (reason: Error) => void;
  let request!: AwsWorkerStartRequest;
  const renderer = await renderPanel({ status: { ...RUNNING, state: "stopped" }, onProgress: listener => { progress = listener; }, start: value => { request = value; return new Promise((_, fail) => { reject = fail; }); } });
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-start" }));
  await act(async () => { progress({ ...OLD_ERROR, operationId: "unrelated", phase: "setting-up", message: "Wrong progress" }); await flush(); });
  assert.equal(textOf(renderer.root).includes("Wrong progress"), false);
  await act(async () => { progress({ ...OLD_ERROR, operationId: request.operationId, phase: "setting-up", message: "Preparing provider" }); await flush(); });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-progress" }).length, 1);
  await act(async () => { reject(new Error("Connection lost")); await flush(); });
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-message" })), /Connection lost/);
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-start" }).props.disabled, false);
  unmount(renderer);
});

test("Delete refreshes parent only after confirmed removal", async () => {
  let deleted = 0;
  const renderer = await renderPanel({ status: { ...RUNNING, state: "stopped" }, remove: async () => ({ configured: false }), onDeleted: async () => { deleted++; } });
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-config-toggle" }));
  await click(findButton(renderer, "Delete")); await click(findButton(renderer, "Confirm delete"));
  assert.equal(deleted, 1);
  unmount(renderer);
});

test("a new authorization error can enter recovery even after a successful old setup", async () => {
  const oldReady = ready({ operationId: "old-ready" }).operation;
  const renderer = await renderPanel({ status: { configured: true, operation: oldReady, message: "UnauthorizedOperation" }, start: async request => {
    const operation = { ...OLD_ERROR, operationId: request.operationId, updatedAt: new Date().toISOString() };
    return { operation, status: { configured: true, operation, message: "UnauthorizedOperation" } };
  } });
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-start" }).props.disabled, false);
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-start" }));
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-authorization-toggle" }).length, 1);
  unmount(renderer);
});

test("polling resumes when a long action fails after the previous polling interval", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let reads = 0;
  let reject!: (reason: Error) => void;
  const renderer = await renderPanel({ status: RUNNING, getStatus: async () => { reads++; return RUNNING; }, stop: () => new Promise((_, fail) => { reject = fail; }) });
  await click(findButton(renderer, "Stop")); await click(findButton(renderer, "Confirm stop"));
  await act(async () => { t.mock.timers.tick(40_000); await flush(); });
  await act(async () => { reject(new Error("Stop connection failed")); await flush(); });
  await act(async () => { t.mock.timers.tick(30_000); await flush(); });
  assert.equal(reads, 2);
  assert.equal(findButton(renderer, "Stop").props.disabled, false);
  unmount(renderer);
});

test("accepted Stop observation survives leaving Settings before AWS exposes stopping", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let state = RUNNING;
  let calls = 0;
  let renderer = await renderPanel({ status: state, getStatus: async () => state, stop: async () => { calls++; return state; } });
  await click(findButton(renderer, "Stop")); await click(findButton(renderer, "Confirm stop"));
  unmount(renderer);
  await act(async () => { renderer = create(<AwsWorkerPanel settings={SETTINGS} onDeleted={async () => undefined} />); await flush(); });
  assert.equal(findButton(renderer, "Stop").props.disabled, true);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-transition" }).length, 1);
  state = { ...state, state: "stopped" };
  await act(async () => { t.mock.timers.tick(AWS_TRANSITION_POLL_MS); await flush(); });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Stopped");
  assert.equal(calls, 1);
  unmount(renderer);
});

test("a delayed status snapshot cannot revive an adopted operation after newer terminal progress", async () => {
  let progress!: (value: AwsWorkerOperationSnapshot) => void;
  const live: AwsWorkerOperationSnapshot = { operationId: "in-flight", intent: "resize", phase: "setting-up", message: "Still applying", updatedAt: "2026-09-13T00:00:00.000Z" };
  let reads = 0;
  let delayed!: (value: AwsWorkerStatus) => void;
  const renderer = await renderPanel({ status: RUNNING, onProgress: listener => { progress = listener; }, getStatus: async () => ++reads === 1 ? { ...RUNNING, operation: live } : new Promise(resolve => { delayed = resolve; }) });
  await click(findButton(renderer, "Refresh status"));
  const terminal = { ...live, phase: "error" as const, message: "Filesystem expansion failed", updatedAt: "2026-09-13T00:00:01.000Z" };
  await act(async () => { progress(terminal); await flush(); });
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-message" })), /Filesystem expansion failed/);
  await act(async () => { delayed({ ...RUNNING, operation: { ...live } }); await flush(); });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-progress" }).length, 0);
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-message" })), /Filesystem expansion failed/);
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-start" }).props.disabled, false);
  unmount(renderer);
});

test("Stop accepted after unmount reaches the reopened panel even when its first status read fails", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let reads = 0;
  let accepted!: (value: AwsWorkerStatus) => void;
  let renderer = await renderPanel({ status: RUNNING, getStatus: async () => {
    reads++;
    if (reads === 2) throw new Error("AWS temporarily unavailable");
    return reads > 2 ? { ...RUNNING, state: "stopped" } : RUNNING;
  }, stop: () => new Promise(resolve => { accepted = resolve; }) });
  await click(findButton(renderer, "Stop")); await click(findButton(renderer, "Confirm stop"));
  unmount(renderer);
  await act(async () => { renderer = create(<AwsWorkerPanel settings={SETTINGS} onDeleted={async () => undefined} />); await flush(); });
  await act(async () => { accepted(RUNNING); await flush(); });
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-transition" })), /last confirmed state/);
  await act(async () => { t.mock.timers.tick(AWS_TRANSITION_POLL_MS); await flush(); });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Stopped");
  assert.equal(reads, 3);
  unmount(renderer);
});

async function renderPanel(options: {
  status: AwsWorkerStatus;
  getStatus?: () => Promise<AwsWorkerStatus>;
  onProgress?: (listener: (operation: AwsWorkerOperationSnapshot) => void) => void;
  start?: (request: AwsWorkerStartRequest) => Promise<any>;
  stop?: () => Promise<AwsWorkerStatus>;
  remove?: () => Promise<AwsWorkerStatus>;
  onDeleted?: () => Promise<void>;
}): Promise<ReactTestRenderer> {
  const bridge = {
    getAwsWorkerStatus: options.getStatus ?? (async () => options.status),
    onAwsWorkerProgress: (listener: (operation: AwsWorkerOperationSnapshot) => void) => { options.onProgress?.(listener); return () => undefined; },
    startAwsWorker: options.start ?? (async request => ready(request)),
    stopAwsWorker: options.stop ?? (async () => options.status), deleteAwsWorker: options.remove ?? (async () => options.status),
    listMachines: async () => ({ machines: [], status: [] }), onMachinesUpdated: () => () => undefined,
    getAwsWorkerBootstrapCommand: async () => "command", openExternal: async () => undefined
  };
  (globalThis as any).window = { consensus: bridge, setTimeout };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => undefined } } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AwsWorkerPanel settings={SETTINGS} onDeleted={options.onDeleted ?? (async () => undefined)} />); await flush(); });
  return renderer;
}
async function edit(renderer: ReactTestRenderer): Promise<void> { await click(renderer.root.findByProps({ "data-testid": "aws-worker-config-toggle" })); await click(renderer.root.findByProps({ "data-testid": "aws-worker-size-edit" })); }
function findButton(renderer: ReactTestRenderer, label: string): ReactTestInstance { return renderer.root.find(node => node.type === "button" && textOf(node) === label); }
async function click(node: ReactTestInstance): Promise<void> { await act(async () => { node.props.onClick(); await flush(); }); }
async function change(node: ReactTestInstance, value: string): Promise<void> { await act(async () => { node.props.onChange({ target: { value } }); await flush(); }); }
function textOf(node: ReactTestInstance): string { return node.children.map(child => typeof child === "string" ? child : textOf(child as ReactTestInstance)).join(""); }
function unmount(renderer: ReactTestRenderer): void { act(() => renderer.unmount()); }
async function flush(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
