import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react-test-renderer";
import { CloudRunAwsService } from "../../../main/services/cloudRunAws";
import { AwsWorkerSetupService } from "../../../main/services/awsWorkerSetup";
import type { AwsWorkerOperationSnapshot, AwsWorkerStartRequest } from "../../../shared/types";
import { OLD_ERROR, RUNNING, SETTINGS, change, click, findButton, flush, ready, renderPanel, textOf, unmount } from "./aws-worker-panel-harness.test";

test("a healthy running instance offers Stop only; a stopped one offers Start only", async () => {
  const running = await renderPanel({ status: RUNNING });
  assert.equal(running.root.findAllByProps({ "data-testid": "aws-worker-start" }).length, 0);
  assert.equal(running.root.findAllByProps({ "data-testid": "aws-worker-stop" }).length, 1);
  assert.match(textOf(running.root.findByProps({ "data-testid": "aws-worker-billing-note" })), /does not stop by itself/);
  assert.match(textOf(running.root.findByProps({ "data-testid": "aws-cloud-run-readiness" })), /select it in a member/);
  unmount(running);
  const stopped = await renderPanel({ status: { ...RUNNING, state: "stopped" } });
  assert.equal(textOf(stopped.root.findByProps({ "data-testid": "aws-worker-start" })), "Start instance");
  assert.equal(stopped.root.findAllByProps({ "data-testid": "aws-worker-stop" }).length, 0);
  assert.equal(stopped.root.findAllByProps({ "data-testid": "aws-worker-billing-note" }).length, 0);
  assert.match(textOf(stopped.root.findByProps({ "data-testid": "aws-cloud-run-readiness" })), /Start the instance to use Cloud run/);
  assert.equal(textOf(stopped.root).includes("unavailable while the instance is stopped"), false);
  unmount(stopped);
});

test("a current permission failure shows one retry and its recovery, never two retries", async () => {
  const renderer = await renderPanel({ status: { ...RUNNING, state: "stopped" }, start: async request => {
    const operation = { ...OLD_ERROR, operationId: request.operationId, updatedAt: new Date().toISOString() };
    return { operation, status: { ...RUNNING, state: "stopped", operation } };
  } });
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-start" }));
  const retries = renderer.root.findAll(node => node.type === "button" && /try again|retry/i.test(textOf(node)));
  assert.equal(retries.length, 1);
  assert.equal(textOf(retries[0]), "Try again");
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-history" }).length, 0, "the attempt shown live is not also history");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-toggle" }));
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-steps" })), /Apply update and try again/);
  unmount(renderer);
});

test("a completed previous attempt is not shown as history", async () => {
  const renderer = await renderPanel({ status: { ...RUNNING, operation: ready({ operationId: "done" }).operation } });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-history" }).length, 0);
  unmount(renderer);
});

test("a first connection keeps its action beside the pasted result and offers nothing else", async () => {
  const requests: AwsWorkerStartRequest[] = [];
  const renderer = await renderPanel({ status: { configured: false }, settings: { ...SETTINGS, hasAwsCredentials: false }, start: async request => { requests.push(request); return ready(request); } });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-start" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-stop" }).length, 0);
  assert.equal(renderer.root.findAll(node => node.type === "button" && textOf(node) === "Refresh status").length, 0);
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-connect-start" }).props.disabled, true);
  await change(renderer.root.findByProps({ "aria-label": "AWS setup result" }), "accord-aws-v1:new");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-connect-start" }));
  assert.equal(requests[0].blob, "accord-aws-v1:new");
  assert.equal(requests[0].intent, "setup");
  unmount(renderer);
});

test("diagnostics appear as soon as an instance exists, without re-reading settings", async () => {
  const renderer = await renderPanel({ status: { configured: false }, settings: { ...SETTINGS, hasAwsCredentials: false } });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "machine-instance-diagnostics-toggle" }).length, 0);
  await change(renderer.root.findByProps({ "aria-label": "AWS setup result" }), "accord-aws-v1:new");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-connect-start" }));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Running · billable");
  assert.equal(renderer.root.findAllByProps({ "data-testid": "machine-instance-diagnostics-toggle" }).length, 1);
  unmount(renderer);
});

test("a refresh that AWS refuses offers a read-only access check that leads to recovery, never a start", async () => {
  let reads = 0;
  const requests: AwsWorkerStartRequest[] = [];
  const renderer = await renderPanel({ status: RUNNING, getStatus: async () => ++reads === 1 ? RUNNING : { configured: true, message: "AccessDenied: not authorized to perform ec2:DescribeInstances" }, start: async request => {
    requests.push(request);
    const operation = { ...OLD_ERROR, operationId: request.operationId, clientToken: request.clientToken, intent: request.intent, updatedAt: new Date().toISOString(), awsPrincipalUserName: "worker-user" };
    return { operation, status: { configured: true, operation, message: "AccessDenied" } };
  } });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-start" }).length, 0);
  await click(renderer.root.find(node => node.type === "button" && textOf(node) === "Refresh status"));
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-message" })), /AccessDenied/);
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Running · billable");
  assert.equal(renderer.root.findAll(node => node.type === "button" && textOf(node) === "Refresh status").length, 0, "the check is the one read action");
  const check = renderer.root.findByProps({ "data-testid": "aws-worker-start" });
  assert.equal(textOf(check), "Check AWS access");
  await click(check);
  assert.equal(requests[0].intent, "check");
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-authorization-toggle" }).length, 1);
  await click(findButton(renderer, "Try again"));
  assert.equal(requests[1].intent, "check", "retrying a check is still a check");
  assert.equal(requests[1].operationId, requests[0].operationId);
  unmount(renderer);
});

test("a confirmed access check brings the normal actions back", async () => {
  let reads = 0;
  const renderer = await renderPanel({ status: { ...RUNNING, state: "stopped" }, getStatus: async () => ++reads === 1 ? { ...RUNNING, state: "stopped" } : { configured: true, message: "getaddrinfo ENOTFOUND ec2.us-east-1.amazonaws.com" }, start: async request => {
    assert.equal(request.intent, "check");
    return ready(request, { ...RUNNING, state: "stopped" });
  } });
  await click(renderer.root.find(node => node.type === "button" && textOf(node) === "Refresh status"));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-start" })), "Check AWS access");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-start" }));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-start" })), "Start instance");
  assert.equal(renderer.root.findAll(node => node.type === "button" && textOf(node) === "Refresh status").length, 1);
  unmount(renderer);
});

test("a failed read for a replacement instance cannot inherit the previous instance's Running state", async () => {
  let reads = 0;
  const renderer = await renderPanel({ status: RUNNING, getStatus: async () => ++reads === 1 ? RUNNING : {
    configured: true, handle: { instanceId: "i-replacement", region: "eu-west-1", securityGroupId: "sg-2", keyName: "key-2", instanceType: "t3.small", createdAt: "2026-09-13" },
    message: "AccessDenied"
  } });
  await click(findButton(renderer, "Refresh status"));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-state" })), "Status unavailable");
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-stop" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-actual-specs" }).length, 0);
  unmount(renderer);
});

test("a check still running when Settings reopen keeps Start out of reach until it finishes", async () => {
  let progress!: (value: AwsWorkerOperationSnapshot) => void;
  const live: AwsWorkerOperationSnapshot = { operationId: "check-live", intent: "check", phase: "starting", message: "Checking AWS access…", updatedAt: "2026-09-13T12:00:00.000Z" };
  const renderer = await renderPanel({ status: { ...RUNNING, state: "stopped", operation: live }, onProgress: listener => { progress = listener; }, start: async () => { throw new Error("nothing may start while a check runs"); } });
  const busyButton = renderer.root.findByProps({ "data-testid": "aws-worker-start" });
  assert.equal(textOf(busyButton), "Checking AWS access…");
  assert.equal(busyButton.props.disabled, true);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-progress" }).length, 0, "a check has no start phases to show");
  await act(async () => { progress({ ...live, phase: "ready", message: "AWS access confirmed · instance stopped.", updatedAt: "2026-09-13T12:00:05.000Z" }); await flush(); });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-start" })), "Start instance");
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-start" }).props.disabled, false);
  unmount(renderer);
});

test("a missed completion after reopening Settings is recovered even when AWS keeps refusing status reads", async () => {
  const refusal = Object.assign(new Error("Not authorized to perform: ec2:DescribeInstances"), { name: "UnauthorizedOperation" });
  const realSetTimeout = globalThis.setTimeout;
  let poll!: () => void;
  globalThis.setTimeout = ((callback, delay, ...args) => {
    if (delay === 30_000) { poll = () => callback(...args); return realSetTimeout(() => undefined, 1_000_000); }
    return realSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  let saved: AwsWorkerOperationSnapshot | undefined;
  let calls = 0;
  let releaseProbe!: () => void;
  let releaseMount!: () => void;
  let listener: ((operation: AwsWorkerOperationSnapshot) => void) | undefined;
  const settings = {
    getAwsWorkerCredentials: async () => ({ accessKeyId: "synthetic", secretAccessKey: "synthetic", region: "us-east-1" }),
    getPublicSettings: async () => ({ cloudRuns: { awsHandle: { instanceId: "i-shared", region: "us-east-1" } } }),
    getAwsWorkerOperation: async () => saved,
    saveAwsWorkerOperation: async (value: AwsWorkerOperationSnapshot) => { saved = value; }
  };
  const aws = new CloudRunAwsService(settings as any, { createEc2Client: () => ({ describeInstance: async () => {
    const call = ++calls;
    if (call === 2) await new Promise<void>(resolve => { releaseProbe = resolve; });
    if (call === 3) await new Promise<void>(resolve => { releaseMount = resolve; });
    throw refusal;
  } }) as any });
  const service = new AwsWorkerSetupService(aws, {} as any, settings as any);
  let pending!: ReturnType<typeof service.start>;
  const options = { status: RUNNING, getStatus: () => aws.status(), onProgress: (next: typeof listener) => { listener = next; },
    start: (request: AwsWorkerStartRequest) => pending = service.start(request, operation => listener?.(operation)) };
  let renderer: Awaited<ReturnType<typeof renderPanel>> | undefined;
  try {
    renderer = await renderPanel(options);
    await click(findButton(renderer, "Check AWS access"));
    assert.equal(saved?.phase, "starting");
    unmount(renderer);
    renderer = await renderPanel(options);
    assert.equal(calls, 3);
    await act(async () => { releaseProbe(); await pending; await flush(); });
    assert.equal(saved?.phase, "error", "completion is persisted before the first reopened status read returns");
    await act(async () => { releaseMount(); await flush(); });
    assert.equal(findButton(renderer, "Checking AWS access…").props.disabled, true);
    await act(async () => { poll(); await flush(); });
    assert.equal(findButton(renderer, "Try again").props.disabled, false);
    assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-authorization-toggle" }).length, 1);
    await act(async () => { poll(); await flush(); });
    assert.equal(findButton(renderer, "Try again").props.disabled, false, "further failures do not revive the busy state");
  } finally {
    if (renderer) unmount(renderer);
    globalThis.setTimeout = realSetTimeout;
  }
});
