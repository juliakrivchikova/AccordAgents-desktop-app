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
  const running = await renderPanel({ status: { ...RUNNING, autoStop: { state: "off" } } });
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

test("the running instance says whether it stops by itself, and offers to set that up only when it does not", async () => {
  const cases: Array<[AwsWorkerStatus["autoStop"], RegExp, string | undefined, boolean]> = [
    [{ state: "on" }, /stops by itself after three hours without work/, undefined, false],
    [{ state: "on", detail: "Automatic idle stop is suspended: metadata unavailable" }, /set up, but the machine reports: Automatic idle stop is suspended/, undefined, true],
    [{ state: "pending" }, /starts once the machine has its new key, which it takes the next time it is idle/, undefined, false],
    [{ state: "pending", detail: "No machine runs on this instance yet." }, /^Billed while running\. Automatic stop starts once a machine is set up on this instance\.$/, undefined, false],
    [{ state: "pending", detail: "The last update of this machine did not finish. Select Update in Settings → Machines to hand the key over." },
      /starts once the machine has its new key\. The last update of this machine did not finish/, undefined, true],
    [undefined, /^Billed while running\.$/, undefined, false],
    [{ state: "failed", detail: "names a different AWS machine" }, /^Billed until you stop it; the machine could not set up automatic stop: names a different AWS machine$/, "Set up automatic stop again", true],
    [{ state: "failed", detail: "AWS refused the automatic-stop key.", previousKeyActive: true },
      /^Billed while running; it still stops by itself after three hours without work, with its previous key\. The new key was not taken: AWS refused/, "Set up automatic stop again", true],
    [{ state: "off" }, /does not stop by itself/, "Set up automatic stop", false]
  ];
  for (const [autoStop, note, toggle, warning] of cases) {
    const renderer = await renderPanel({ status: { ...RUNNING, autoStop } });
    const billing = renderer.root.findByProps({ "data-testid": "aws-worker-billing-note" });
    assert.match(textOf(billing), note);
    assert.equal(String(billing.props.className).includes("is-warning"), warning, `${autoStop?.state} reads as a warning only when the User has to act`);
    const toggles = renderer.root.findAllByProps({ "data-testid": "aws-worker-auto-stop-toggle" });
    assert.equal(toggles.length, toggle ? 1 : 0, autoStop?.state);
    if (toggle) assert.equal(textOf(toggles[0]), toggle);
    unmount(renderer);
  }
  const stopped = await renderPanel({ status: { ...RUNNING, state: "stopped", autoStop: { state: "failed", detail: "names a different AWS machine" } } });
  assert.equal(stopped.root.findAllByProps({ "data-testid": "aws-worker-billing-note" }).length, 0, "nothing is billed while stopped");
  assert.match(textOf(stopped.root.findByProps({ "data-testid": "aws-worker-auto-stop" })), /could not set up automatic stop: names a different AWS machine/,
    "the reason stays visible next to the action while stopped");
  unmount(stopped);
});

test("setting up automatic stop asks for a fresh setup command for the instance's region and says what the paste did", async () => {
  const commands: Array<string | undefined> = [];
  const regions: string[] = [];
  const requests: AwsWorkerStartRequest[] = [];
  const renderer = await renderPanel({
    status: { ...RUNNING, autoStop: { state: "off" } },
    settings: { ...SETTINGS, awsRegion: "eu-west-1" },
    command: async (region, recoveryOperationId) => { regions.push(region); commands.push(recoveryOperationId); return "setup-command"; },
    start: async request => { requests.push(request); return ready(request, { ...RUNNING, autoStop: { state: "pending" } }); }
  });
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-auto-stop-toggle" }));
  const form = () => renderer.root.findByProps({ "data-testid": "aws-worker-auto-stop-form" });
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-auto-stop-steps" })), /three hours without work, even when this app is closed/);
  assert.equal(form().findAll(node => node.type === "div" && node.props.className === "gen-row-title").length, 0, "the toggle already names the task");
  const named = renderer.root.findAll(node => node.type === "button" && textOf(node) === "Turn on automatic stop");
  assert.equal(named.length, 1, "step 3 points to exactly one control");
  assert.equal(form().find(node => node.props["aria-label"] === "AWS region").props.disabled, true, "the stop key only works in the instance's region");
  await click(form().find(node => node.type === "button" && textOf(node) === "Show setup command"));
  assert.deepEqual(commands, [undefined]);
  assert.equal(regions[0], "us-east-1", "the command is built for the instance's region, not the last one typed");
  assert.match(textOf(form()), /setup-command/);
  await change(form().find(node => node.props["aria-label"] === "AWS setup result"), "accord-aws-v1:pasted");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-auto-stop-apply" }));
  assert.equal(requests.at(-1)?.intent, "check", "nothing is started, created or set up");
  assert.equal(requests.at(-1)?.blob, "accord-aws-v1:pasted");
  assert.equal(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-message" })), "Automatic stop: The new key is saved.",
    "the line under the panel confirms; the billing note says what it means");
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-billing-note" })), /starts once the machine has its new key/);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-auto-stop-toggle" }).length, 0);
  unmount(renderer);
});

test("only one command-and-paste form is open: a permission failure replaces the automatic-stop form", async () => {
  const commands: Array<string | undefined> = [];
  const renderer = await renderPanel({
    status: { ...RUNNING, autoStop: { state: "off" } },
    command: async (_region, recoveryOperationId) => { commands.push(recoveryOperationId); return recoveryOperationId ? "update-command" : "setup-command"; },
    start: async request => {
      const operation = { ...OLD_ERROR, operationId: request.operationId, updatedAt: new Date().toISOString() };
      return { operation, status: { ...RUNNING, autoStop: { state: "off" }, operation } };
    }
  });
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-auto-stop-toggle" }));
  await change(renderer.root.findByProps({ "aria-label": "AWS setup result" }), "accord-aws-v1:refused");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-auto-stop-apply" }));
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-auto-stop" }).length, 0, "the automatic-stop form steps aside");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-toggle" }));
  const recovery = renderer.root.findByProps({ "data-testid": "aws-worker-authorization-recovery" });
  await click(recovery.find(node => node.type === "button" && textOf(node) === "Show setup command"));
  assert.equal(commands.length, 1);
  assert.ok(commands[0], "the permission recovery asks for its own command");
  unmount(renderer);
});
