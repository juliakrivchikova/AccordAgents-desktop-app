import assert from "node:assert/strict";
import test from "node:test";
import type { AwsWorkerOperationSnapshot, AwsWorkerStartRequest, AwsWorkerStatus } from "../../../shared/types";
import { OLD_ERROR, RUNNING, SETTINGS, change, click, findButton, ready, renderPanel, textOf, unmount } from "./aws-worker-panel-harness.test";

// Every visible action, in every state, mapped to the exact bridge call it
// makes. A button that reaches AWS through anything but its named call is a
// hidden start, a hidden stop or a hidden write — the class of defect the
// review rounds kept finding one instance at a time.
type Call = { method: string; intent?: string; resolution?: string; blob?: string };

async function recorded(status: AwsWorkerStatus, settings = SETTINGS, respond?: (request: AwsWorkerStartRequest) => any) {
  const calls: Call[] = [];
  const renderer = await renderPanel({
    status,
    settings,
    getStatus: async () => { calls.push({ method: "status" }); return status; },
    start: async request => { calls.push({ method: "start", intent: request.intent, resolution: request.resolution, blob: request.blob }); return respond ? respond(request) : ready(request, status); },
    stop: async () => { calls.push({ method: "stop" }); return { ...status, state: "stopping" as const }; },
    remove: async () => { calls.push({ method: "delete" }); return { configured: false }; },
    command: async (_region, recoveryOperationId) => { calls.push({ method: "command", blob: recoveryOperationId }); return "command"; }
  });
  calls.length = 0; // the mount's own status read is not an action
  return { renderer, calls };
}

const buttons = (renderer: Awaited<ReturnType<typeof recorded>>["renderer"]) =>
  renderer.root.findAll(node => node.type === "button" && !node.props.disabled).map(textOf).filter(label => label && !/^(Size & instance details|Diagnostics|Cancel)$/.test(label));

test("not connected: the only way to AWS is the connection form, and it is a setup with the pasted result", async () => {
  const { renderer, calls } = await recorded({ configured: false }, { ...SETTINGS, hasAwsCredentials: false });
  assert.deepEqual(buttons(renderer), ["Show setup command"]);
  await click(findButton(renderer, "Show setup command"));
  assert.deepEqual(calls, [{ method: "command", blob: undefined }]);
  await change(renderer.root.findByProps({ "aria-label": "AWS setup result" }), "accord-aws-v1:x");
  await click(findButton(renderer, "Connect and start instance"));
  assert.deepEqual(calls.at(-1), { method: "start", intent: "setup", resolution: undefined, blob: "accord-aws-v1:x" });
  unmount(renderer);
});

test("stopped: Start is the one start; Refresh only reads; Delete only deletes after confirmation", async () => {
  const { renderer, calls } = await recorded({ ...RUNNING, state: "stopped" });
  assert.deepEqual(buttons(renderer), ["Start instance", "Refresh status"]);
  await click(findButton(renderer, "Refresh status"));
  assert.deepEqual(calls, [{ method: "status" }]);
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-config-toggle" }));
  await click(findButton(renderer, "Delete"));
  assert.deepEqual(calls, [{ method: "status" }], "Delete asks first");
  await click(findButton(renderer, "Confirm delete"));
  assert.deepEqual(calls.at(-1), { method: "delete" });
  unmount(renderer);
  const again = await recorded({ ...RUNNING, state: "stopped" });
  await click(findButton(again.renderer, "Start instance"));
  assert.deepEqual(again.calls, [{ method: "start", intent: "setup", resolution: undefined, blob: undefined }]);
  unmount(again.renderer);
});

test("running: nothing starts; Stop stops only after confirmation; a size change is a resize", async () => {
  const { renderer, calls } = await recorded(RUNNING);
  assert.deepEqual(buttons(renderer), ["Refresh status", "Stop"]);
  await click(findButton(renderer, "Stop"));
  assert.deepEqual(calls, [], "Stop asks first");
  await click(findButton(renderer, "Confirm stop"));
  assert.deepEqual(calls, [{ method: "stop" }]);
  unmount(renderer);
  const sized = await recorded(RUNNING);
  await click(sized.renderer.root.findByProps({ "data-testid": "aws-worker-config-toggle" }));
  await click(sized.renderer.root.findByProps({ "data-testid": "aws-worker-size-edit" }));
  await change(sized.renderer.root.findByProps({ "aria-label": "AWS worker disk size" }), "41");
  await click(sized.renderer.root.findByProps({ "data-testid": "aws-worker-size-apply" }));
  assert.deepEqual(sized.calls, [{ method: "start", intent: "resize", resolution: "grow-disk", blob: undefined }]);
  unmount(sized.renderer);
});

test("status unavailable: the one action is a read-only check, and every retry after it stays a check", async () => {
  const failed = (request: AwsWorkerStartRequest): any => {
    const operation: AwsWorkerOperationSnapshot = { ...OLD_ERROR, operationId: request.operationId, clientToken: request.clientToken, intent: request.intent, updatedAt: new Date().toISOString() };
    return { operation, status: { configured: true, operation, message: "AccessDenied" } };
  };
  const { renderer, calls } = await recorded({ configured: true, message: "AccessDenied" }, SETTINGS, failed);
  assert.deepEqual(buttons(renderer), ["Check AWS access"]);
  await click(findButton(renderer, "Check AWS access"));
  assert.deepEqual(calls, [{ method: "start", intent: "check", resolution: undefined, blob: undefined }]);
  await click(findButton(renderer, "Try again"));
  assert.deepEqual(calls.at(-1), { method: "start", intent: "check", resolution: undefined, blob: undefined });
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-toggle" }));
  await click(findButton(renderer, "Show setup command"));
  assert.equal(calls.at(-1)?.method, "command");
  await change(renderer.root.findByProps({ "aria-label": "AWS setup result" }), "accord-aws-v1:new");
  await click(findButton(renderer, "Apply update and try again"));
  assert.deepEqual(calls.at(-1), { method: "start", intent: "check", resolution: undefined, blob: "accord-aws-v1:new" });
  assert.equal(calls.filter(call => call.intent === "setup").length, 0, "no path from a check ever becomes a start");
  unmount(renderer);
});

test("a failed start retries as a start, with the pasted update when there is one", async () => {
  const failed = (request: AwsWorkerStartRequest): any => {
    const operation: AwsWorkerOperationSnapshot = { ...OLD_ERROR, operationId: request.operationId, clientToken: request.clientToken, intent: request.intent, updatedAt: new Date().toISOString() };
    return { operation, status: { ...RUNNING, state: "stopped", operation } };
  };
  const { renderer, calls } = await recorded({ ...RUNNING, state: "stopped" }, SETTINGS, failed);
  await click(findButton(renderer, "Start instance"));
  await click(findButton(renderer, "Try again"));
  assert.deepEqual(calls.map(call => call.intent), ["setup", "setup"]);
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-toggle" }));
  await change(renderer.root.findByProps({ "aria-label": "AWS setup result" }), "accord-aws-v1:new");
  await click(findButton(renderer, "Apply update and try again"));
  assert.deepEqual(calls.at(-1), { method: "start", intent: "setup", resolution: undefined, blob: "accord-aws-v1:new" });
  unmount(renderer);
});
