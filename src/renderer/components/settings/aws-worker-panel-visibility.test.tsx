import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react-test-renderer";
import { CloudRunAwsService } from "../../../main/services/cloudRunAws";
import { AwsWorkerSetupService } from "../../../main/services/awsWorkerSetup";
import type { AwsWorkerOperationSnapshot, AwsWorkerStartRequest, AwsWorkerStatus } from "../../../shared/types";
import { OLD_ERROR, RUNNING, SETTINGS, change, click, findButton, flush, ready, renderPanel, textOf, unmount } from "./aws-worker-panel-harness.test";

test("reopening AWS settings restores the live sign-in card and terminal results hide its code", async () => {
  let publish!: (operation: AwsWorkerOperationSnapshot) => void;
  const operation: AwsWorkerOperationSnapshot = { operationId: "sign-in", intent: "setup", phase: "setting-up", message: "Approve sign-in", updatedAt: new Date().toISOString(), authUrl: "https://auth.openai.com/codex/device", authCode: "ABCD-12345" };
  const renderer = await renderPanel({ status: { ...RUNNING, operation }, onProgress: listener => { publish = listener; } });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "cloud-run-device-auth-code" })), operation.authCode);
  const copied: string[] = [];
  (navigator.clipboard as any).writeText = async (value: string) => { copied.push(value); };
  await click(renderer.root.findByProps({ "aria-label": "Copy sign-in code" }));
  assert.deepEqual(copied, [operation.authCode]);
  await act(async () => { publish({ ...operation, phase: "error", message: "Sign-in interrupted" }); });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "cloud-run-device-auth-code" }).length, 0, "a persisted expired code is not actionable");
  unmount(renderer);
});

test("a healthy running instance offers Stop only; a stopped one offers Start only", async () => {
  const running = await renderPanel({ status: { ...RUNNING, autoStop: { enabled: false, needsSetup: true } } });
  assert.equal(running.root.findAllByProps({ "data-testid": "aws-worker-start" }).length, 0);
  assert.equal(running.root.findAllByProps({ "data-testid": "aws-worker-stop" }).length, 1);
  assert.match(textOf(running.root.findByProps({ "data-testid": "aws-cloud-run-readiness" })), /select it in a member/);
  unmount(running);
  const stopped = await renderPanel({ status: { ...RUNNING, state: "stopped" } });
  assert.equal(textOf(stopped.root.findByProps({ "data-testid": "aws-worker-start" })), "Start instance");
  assert.equal(stopped.root.findAllByProps({ "data-testid": "aws-worker-stop" }).length, 0);
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

test("Cloud run says what the desktop is doing to the machine's runtime: owed, running, stepped back, failed, or nothing", async () => {
  const machine = { id: "m-cloud", name: "Cloud run", awsInstanceId: "i-shared", pairingKey: "rv", createdAt: "2026-09-17T00:00:00Z" };
  const connected = { machineId: "m-cloud", name: "Cloud run", connected: true, lastHello: { appVersion: "1.10.4-beta.11", machineName: "Cloud", platform: "linux-x64", providers: [], deviceId: "d" } };
  const install = { machineId: "m-cloud", target: { host: "1.2.3.4" }, installRoot: "/r", userDataDir: "/u", serviceName: "s", serviceScope: "system", installedVersion: "1.10.4-beta.11" };
  const owed = await renderPanel({ status: RUNNING, machines: { machines: [machine], status: [connected] }, installs: [install], appVersion: "1.10.4-beta.12" });
  assert.match(textOf(owed.root.findByProps({ "data-testid": "aws-cloud-run-readiness" })), /Cloud run: connected/);
  const owedLine = owed.root.findByProps({ "data-testid": "aws-cloud-run-runtime" });
  assert.equal(owedLine.props["data-state"], "pending");
  assert.match(textOf(owedLine), /Runtime update to 1\.10\.4-beta\.12 pending; it starts when the machine is connected and idle/);
  unmount(owed);

  let publish: ((snapshot: any) => void) | undefined;
  const running = await renderPanel({ status: RUNNING, machines: { machines: [machine], status: [connected] }, installs: [install], appVersion: "1.10.4-beta.12", onInstallProgress: listener => { publish = listener; } });
  await act(async () => { publish?.({ machineId: "m-cloud", operationId: "auto-upgrade-1.10.4-beta.12-1", kind: "upgrade", phase: "transfer", message: "Copying the runtime to the machine…", updatedAt: "", completed: ["preflight", "bundle"] }); await flush(); });
  const runningLine = running.root.findByProps({ "data-testid": "aws-cloud-run-runtime" });
  assert.equal(runningLine.props["data-state"], "updating");
  assert.equal(textOf(runningLine), "Copying the runtime to the machine…");
  unmount(running);

  const stepped = await renderPanel({ status: RUNNING, machines: { machines: [machine], status: [connected] }, appVersion: "1.10.4-beta.12",
    installs: [{ ...install, lastOperation: { machineId: "m-cloud", operationId: "auto-upgrade-1.10.4-beta.12-1", kind: "upgrade", phase: "needs-attention", message: "A member started work…", updatedAt: "", completed: [], recovery: { kind: "machine-busy", detail: "staged" } } }] });
  assert.match(textOf(stepped.root.findByProps({ "data-testid": "aws-cloud-run-runtime" })), /waits for the machine to be idle/);
  unmount(stepped);

  const failed = await renderPanel({ status: RUNNING, machines: { machines: [machine], status: [connected] }, appVersion: "1.10.4-beta.12",
    installs: [{ ...install, lastOperation: { machineId: "m-cloud", operationId: "auto-upgrade-1.10.4-beta.12-1", kind: "upgrade", phase: "error", message: "ssh: connect timed out", error: "ssh: connect timed out", updatedAt: "", completed: [] } }] });
  const failedLine = failed.root.findByProps({ "data-testid": "aws-cloud-run-runtime" });
  assert.equal(failedLine.props["data-state"], "failed");
  assert.match(textOf(failedLine), /Runtime update failed: ssh: connect timed out/);
  unmount(failed);

  const current = await renderPanel({ status: RUNNING, machines: { machines: [machine], status: [connected] }, installs: [install], appVersion: "1.10.4-beta.11" });
  assert.equal(current.root.findAllByProps({ "data-testid": "aws-cloud-run-runtime" }).length, 0, "a current runtime says nothing");
  unmount(current);
});

test("automatic stop is one switch; what keeps it from working is shown only in Diagnostics", async () => {
  const problem = { message: "The cloud machine could not take its automatic-stop key.", action: "reconnect" as const, actionLabel: "Try again", machineId: "cloud" };
  const cases: Array<[AwsWorkerStatus["autoStop"], boolean | undefined, boolean]> = [
    [{ enabled: true, needsSetup: false }, true, false],
    [{ enabled: false, needsSetup: true }, false, false],
    [{ enabled: false, needsSetup: false }, false, false],
    [{ enabled: true, needsSetup: false, problem }, true, true],
    [{ enabled: false, needsSetup: false, problem: { message: "The cloud machine still has automatic stop switched on, so it may stop the instance." } }, false, true],
    [undefined, undefined, false]
  ];
  for (const [autoStop, checked, flagged] of cases) {
    const renderer = await renderPanel({ status: { ...RUNNING, autoStop } });
    const toggles = renderer.root.findAllByProps({ "data-testid": "aws-worker-auto-stop-toggle" });
    assert.equal(toggles.length, checked === undefined ? 0 : 1, "a switch that could not be read is not shown as off");
    if (toggles.length) assert.equal(toggles[0].props.checked, checked);
    assert.equal(renderer.root.findAllByProps({ "data-testid": "machine-instance-diagnostics-problem-count" }).length, flagged ? 1 : 0);
    assert.equal(textOf(renderer.root).includes("Billed"), false, "no second line about billing next to the switch");
    assert.equal(textOf(renderer.root).includes(problem.message), false, "the reason waits in Diagnostics");
    unmount(renderer);
  }
  const stopped = await renderPanel({ status: { ...RUNNING, state: "stopped", autoStop: { enabled: true, needsSetup: false } } });
  assert.equal(stopped.root.findByProps({ "data-testid": "aws-worker-auto-stop-toggle" }).props.checked, true, "the switch stays while stopped");
  unmount(stopped);
});

test("the switch turns automatic stop off and on again without the command once a key is saved", async () => {
  const requests: Array<{ enabled: boolean; blob?: string }> = [];
  let status: AwsWorkerStatus = { ...RUNNING, autoStop: { enabled: true, needsSetup: false } };
  const renderer = await renderPanel({ status, getStatus: async () => status,
    setAutoStop: async (request) => { requests.push(request); status = { ...RUNNING, autoStop: { enabled: request.enabled, needsSetup: false } }; return status; } });
  const toggle = () => renderer.root.findByProps({ "data-testid": "aws-worker-auto-stop-toggle" });
  await act(async () => { toggle().props.onChange({ target: { checked: false } }); await flush(); });
  assert.deepEqual(requests, [{ enabled: false }]);
  assert.equal(toggle().props.checked, false);
  await act(async () => { toggle().props.onChange({ target: { checked: true } }); await flush(); });
  assert.deepEqual(requests.at(-1), { enabled: true }, "no setup command is asked for again");
  assert.equal(toggle().props.checked, true);
  unmount(renderer);
});

test("Diagnostics names the problem and its fix runs from there", async () => {
  const problem = { message: "The cloud machine could not take its automatic-stop key.", action: "reconnect" as const, actionLabel: "Try again", machineId: "cloud" };
  let reconnects = 0;
  const renderer = await renderPanel({ status: { ...RUNNING, autoStop: { enabled: true, needsSetup: false, problem } },
    reconnect: async () => { reconnects++; return { ...RUNNING, autoStop: { enabled: true, needsSetup: false } }; } });
  await click(renderer.root.findByProps({ "data-testid": "machine-instance-diagnostics-toggle" }));
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-auto-stop-problem" })), /^Automatic stop: The cloud machine could not take its automatic-stop key/);
  const fix = renderer.root.findByProps({ "data-testid": "aws-auto-stop-problem-action" });
  assert.equal(textOf(fix), "Try again");
  await click(fix);
  assert.equal(reconnects, 1);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-auto-stop-problem" }).length, 0, "a fixed problem is gone");
  assert.equal(renderer.root.findAllByProps({ "data-testid": "machine-instance-diagnostics-problem-count" }).length, 0);
  unmount(renderer);
});

test("a program the app could not bring back is its own problem in Diagnostics, not one of automatic stop, with nothing to press", async () => {
  const machineProblem = "The AccordAgents program on the cloud machine is not running, and the app could not start it again. "
    + "It tries again by itself. Until it is, cloud members don't run and the instance does not stop by itself.";
  const renderer = await renderPanel({ status: { ...RUNNING, machineProblem, autoStop: { enabled: true, needsSetup: false } } });
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "machine-instance-diagnostics-problem-count" })), "1 problem");
  assert.equal(textOf(renderer.root).includes(machineProblem), false, "the reason waits in Diagnostics");
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-auto-stop-toggle" }).props.checked, true, "the switch is what the User set");
  await click(renderer.root.findByProps({ "data-testid": "machine-instance-diagnostics-toggle" }));
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-machine-problem" })), machineProblem, "said as itself, without an automatic-stop label");
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-auto-stop-problem" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-auto-stop-problem-action" }).length, 0, "the app keeps trying; there is no button");
  unmount(renderer);
  const both = await renderPanel({ status: { ...RUNNING, machineProblem, autoStop: { enabled: false, needsSetup: false,
    problem: { message: "The cloud machine still has automatic stop switched on, so it may stop the instance." } } } });
  assert.equal(textOf(both.root.findByProps({ "data-testid": "machine-instance-diagnostics-problem-count" })), "2 problems");
  unmount(both);
});
