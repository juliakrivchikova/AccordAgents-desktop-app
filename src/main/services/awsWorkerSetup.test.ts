import assert from "node:assert/strict";
import test from "node:test";
import type { AwsWorkerOperationSnapshot, AwsWorkerStartRequest, AwsWorkerStatus } from "../../shared/types";
import { AwsWorkerSetupService } from "./awsWorkerSetup";
import type { PreparedAwsWorker } from "./cloudRunAws";
import { CloudRunDoctorService } from "./cloudRunDoctor";

const PROVIDER_SETTINGS = { getPublicSettings: async () => ({ providers: [
  { kind: "codex-cli", enabled: true, label: "Codex" }
] }) };

const PREPARED: PreparedAwsWorker = {
  credentials: { accessKeyId: "AKIAEXAMPLE0001XYZ", secretAccessKey: "secret", region: "us-east-1" },
  handle: {
    instanceId: "i-shared", securityGroupId: "sg-1", keyName: "key", region: "us-east-1",
    instanceType: "t3.small", rootVolumeSizeGb: 8, createdAt: "2026-01-01T00:00:00.000Z"
  },
  info: { instanceId: "i-shared", state: "running", publicIp: "198.51.100.10" },
  actualSpec: { instanceId: "i-shared", region: "us-east-1", instanceType: "t3.small", rootVolumeSizeGb: 8 },
  desiredSpec: { instanceType: "t3.small", rootVolumeSizeGb: 8 },
  created: false
};

/** A Claude login that waits until the User skips it, on a worker where
 *  Codex is signed in and Claude is not. */
function claudeSkippableWorker(onCommand: (command: string) => void = () => undefined): CloudRunDoctorService {
  return new CloudRunDoctorService({ sshExec: async request => {
    onCommand(request.command);
    if (request.command.includes('["auth", "login"]')) return new Promise((_resolve, reject) => {
      if (request.signal?.aborted) { reject(new Error("cancelled")); return; }
      request.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
      request.onStdout?.("https://claude.com/cai/oauth/authorize?state=aws-test\n");
    });
    if (!request.command.includes("have rsync")) return "";
    return ["rsync=ok", "git=ok", "gh=ok", "java=ok", "node=ok", "codex=ok", "claude=ok", "build-essential=ok",
      "sudo=ok", "userns=0", "git-name=Test", "git-email=test@example.com", "codex-auth=ok", "claude-auth=missing"].join("\n");
  } });
}

const ALL_PROVIDERS = { getPublicSettings: async () => ({ providers: [
  { kind: "codex-cli", enabled: true, label: "Codex" }, { kind: "claude-code", enabled: true, label: "Claude" },
  { kind: "gemini-cli", enabled: true, label: "Gemini" }
] }) };
const RUNNING_AWS = {
  prepareWorker: async () => ({ ...PREPARED }), resumePendingVolumeExpansion: async (value: PreparedAwsWorker) => value,
  hasAcceptedMismatch: async () => false, ensurePreparedRunning: async () => ({ host: "test-worker" }),
  status: async () => ({ configured: true, state: "running" })
};

test("the first setup offers each sign-in, goes on when the User skips one, and installs the cloud program", async () => {
  const saved: AwsWorkerOperationSnapshot[] = [];
  const settings = { ...ALL_PROVIDERS, getAwsWorkerOperation: async () => undefined,
    saveAwsWorkerOperation: async (value: AwsWorkerOperationSnapshot) => { saved.push(value); } };
  const doctor = claudeSkippableWorker();
  const installed: string[] = [];
  const program = {
    installed: async (instanceId: string) => { installed.push(`asked:${instanceId}`); return false; },
    install: async (progress: (message: string) => void) => { progress("Copying runtime to the machine…"); installed.push("installed"); }
  };
  let skipped = false;
  const service = new AwsWorkerSetupService(RUNNING_AWS as any, doctor, settings as any, program);
  const result = await service.start({ operationId: "aws-first" }, value => {
    if (value.authRequestId && !skipped) {
      assert.equal(saved.at(-1), value, "the challenge is persisted before the UI can act on it");
      assert.equal(value.authProvider, "claude-code");
      assert.equal(value.setupSteps?.find((step) => step.state === "current")?.id, "sign-in-claude");
      skipped = true;
      doctor.cancelAuth(value.authRequestId);
    }
  });
  assert.equal(skipped, true, "the Claude sign-in was offered");
  assert.equal(result.operation.phase, "ready");
  assert.deepEqual(installed, ["asked:i-shared", "installed"]);
  assert.deepEqual(result.operation.setupSteps?.map((step) => [step.id, step.state]), [
    ["instance", "done"], ["tools", "done"], ["sign-in-codex", "done"], ["sign-in-claude", "skipped"], ["program", "done"]
  ]);
  assert.match(result.operation.message, /Claude Code is not signed in/);
  // The program's own steps were shown while it installed.
  assert.ok(saved.some((value) => value.message === "Copying runtime to the machine…"
    && value.setupSteps?.find((step) => step.id === "program")?.state === "current"));
  assert.equal(saved.at(-1)?.authRequestId, undefined, "a finished setup waits on no sign-in");
});

test("a later start of the instance asks for no sign-in and leaves the installed program alone", async () => {
  const commands: string[] = [];
  const settings = { ...ALL_PROVIDERS, getAwsWorkerOperation: async () => undefined, saveAwsWorkerOperation: async () => undefined };
  let installs = 0;
  const program = { installed: async () => true, install: async () => { installs++; } };
  const service = new AwsWorkerSetupService(RUNNING_AWS as any, claudeSkippableWorker((command) => commands.push(command)), settings as any, program);
  const offered: string[] = [];
  const result = await service.start({ operationId: "aws-restart" }, value => { if (value.authRequestId) offered.push(value.authRequestId); });
  assert.equal(result.operation.phase, "ready");
  assert.deepEqual(offered, []);
  assert.equal(commands.some((command) => command.includes('["auth", "login"]')), false);
  assert.equal(installs, 0);
  assert.deepEqual(result.operation.setupSteps?.map((step) => step.id), ["instance", "tools"]);
});

test("a cloud program that cannot install stops the setup with its reason, and a retry does not ask again for a skipped sign-in", async () => {
  let stored: AwsWorkerOperationSnapshot | undefined;
  const settings = { ...ALL_PROVIDERS, getAwsWorkerOperation: async () => stored,
    saveAwsWorkerOperation: async (value: AwsWorkerOperationSnapshot) => { stored = value; } };
  const doctor = claudeSkippableWorker();
  let fail = true;
  const program = {
    installed: async () => false,
    install: async () => { if (fail) throw new Error("Set up your server first (Settings → Your server): cloud machines connect through it."); }
  };
  const service = new AwsWorkerSetupService(RUNNING_AWS as any, doctor, settings as any, program);
  const offered: string[] = [];
  const onProgress = (value: AwsWorkerOperationSnapshot): void => {
    if (value.authRequestId && !offered.includes(value.authRequestId)) { offered.push(value.authRequestId); doctor.cancelAuth(value.authRequestId); }
  };
  const failed = await service.start({ operationId: "aws-retry" }, onProgress);
  assert.equal(failed.operation.phase, "error");
  assert.match(failed.operation.message, /^The cloud program could not be installed: Set up your server first/);
  assert.deepEqual(failed.operation.setupSteps?.find((step) => step.id === "program"), {
    ...failed.operation.setupSteps?.find((step) => step.id === "program"), state: "failed"
  });
  assert.equal(offered.length, 1);
  fail = false;
  const retried = await service.start({ operationId: "aws-retry" }, onProgress);
  assert.equal(retried.operation.phase, "ready");
  assert.equal(offered.length, 1, "the skipped Claude sign-in is not asked again in the same setup");
  assert.equal(retried.operation.setupSteps?.find((step) => step.id === "sign-in-claude")?.state, "skipped");
});

test("tools that could not be installed are named on the tools step, not on a sign-in", async () => {
  const settings = { ...ALL_PROVIDERS, getAwsWorkerOperation: async () => undefined, saveAwsWorkerOperation: async () => undefined };
  const doctor = {
    waitForCloudInit: async () => undefined,
    setup: async (_worker: unknown, progress: (value: any) => void) => {
      progress({ stage: "codex-auth", message: "Codex sign-in skipped." });
      return { ok: false, message: "1 check failing.", checks: [{ id: "rsync", label: "rsync", status: "fail" }] };
    }
  };
  const service = new AwsWorkerSetupService(RUNNING_AWS as any, doctor as any, settings as any, { installed: async () => false, install: async () => undefined });
  const result = await service.start({ operationId: "aws-tools-fail" });
  assert.equal(result.operation.phase, "error");
  const steps = Object.fromEntries((result.operation.setupSteps ?? []).map((step) => [step.id, step]));
  assert.equal(steps.tools.state, "failed");
  assert.equal(steps.tools.detail, "Not ready: rsync.");
  assert.equal(steps["sign-in-codex"].state, "skipped");
  assert.equal(steps.program.state, "pending", "the program is not installed on tools that are not ready");
});

test("without the User's server the setup says so before anything is created or anyone is asked to sign in", async () => {
  let prepared = 0;
  const aws = { ...RUNNING_AWS, prepareWorker: async () => { prepared++; return { ...PREPARED }; } };
  const settings = { ...ALL_PROVIDERS, getAwsWorkerOperation: async () => undefined, saveAwsWorkerOperation: async () => undefined };
  const program = { installed: async () => false, install: async () => undefined,
    ready: async () => { throw new Error("Set up your server first (Settings → Your server): cloud machines connect through it."); } };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any, program);
  const result = await service.start({ operationId: "no-server" });
  assert.equal(result.operation.phase, "error");
  assert.equal(prepared, 0, "no instance is created");
  assert.deepEqual(result.operation.setupSteps?.map((step) => [step.id, step.state]), [["instance", "failed"]]);
  assert.match(result.operation.message, /Set up your server first/);
  // An instance whose program is set up starts without a server check.
  const started = new AwsWorkerSetupService(aws as any, { waitForCloudInit: async () => undefined, setup: async () => ({ ok: true, message: "", checks: [] }) } as any,
    { ...settings, getPublicSettings: async () => ({ ...(await ALL_PROVIDERS.getPublicSettings()), cloudRuns: { awsHandle: { instanceId: "i-shared" } } }) } as any,
    { ...program, installed: async () => true });
  assert.equal((await started.start({ operationId: "start-only" })).operation.phase, "ready");
});

test("an interrupted setup marks its running step as not finished", async () => {
  let stored: AwsWorkerOperationSnapshot | undefined = {
    operationId: "op-cut", intent: "setup", phase: "setting-up", message: "Installing…", updatedAt: "2026-01-01T00:00:00.000Z",
    authRequestId: "req", authUrl: "https://example.com", setupSteps: [{ id: "instance", state: "done" }, { id: "tools", state: "current", detail: "Installing…" }]
  };
  const settings = { getAwsWorkerOperation: async () => stored, saveAwsWorkerOperation: async (value: AwsWorkerOperationSnapshot) => { stored = value; } };
  await new AwsWorkerSetupService({} as any, {} as any, settings as any).recoverInterruptedOperation();
  assert.equal(stored?.phase, "error");
  assert.equal(stored?.authRequestId, undefined);
  assert.deepEqual(stored?.setupSteps?.map((step) => step.state), ["done", "failed"]);
});

test("explicit type downsizing asks for a decision even if larger capacity was previously accepted", async () => {
  let runs = 0;
  const aws = {
    prepareWorker: async () => ({ ...PREPARED, actualSpec: { ...PREPARED.actualSpec, instanceType: "t3.large" } }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => true,
    ensurePreparedRunning: async () => { runs++; return { host: "x" }; },
    status: async () => ({ configured: true })
  };
  const settings = { ...PROVIDER_SETTINGS, saveAwsWorkerOperation: async () => undefined, getAwsWorkerOperation: async () => undefined };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);
  const result = await service.start({ operationId: "downsize", intent: "resize", expectedInstanceId: "i-shared", instanceType: "t3.small", rootVolumeSizeGb: 8 });
  assert.equal(result.operation.phase, "needs-decision");
  assert.equal(result.operation.specMismatch?.actual.instanceType, "t3.large");
  assert.equal(result.operation.specMismatch?.desired.instanceType, "t3.small");
  assert.match(result.operation.message, /instance type.*differs/);
  assert.equal(runs, 0);
});

test("keeping the current size during a resize starts nothing and restores the saved size", async () => {
  let runs = 0;
  let kept: string | undefined;
  const aws = {
    prepareWorker: async () => ({ ...PREPARED, desiredSpec: { ...PREPARED.desiredSpec, instanceType: "t3.medium" } }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    keepCurrentSize: async (instanceId: string) => { kept = instanceId; return PREPARED.actualSpec; },
    acceptMismatch: async () => { throw new Error("keeping the current size must not record a mismatch acceptance"); },
    ensurePreparedRunning: async () => { runs++; return { host: "x" }; },
    status: async () => ({ configured: true, state: "stopped" })
  };
  const settings = { ...PROVIDER_SETTINGS, saveAwsWorkerOperation: async () => undefined, getAwsWorkerOperation: async () => undefined };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);
  const result = await service.start({
    operationId: "keep", intent: "resize", resolution: "keep", expectedInstanceId: PREPARED.info.instanceId,
    expectedDesiredSpec: { instanceType: "t3.medium", rootVolumeSizeGb: PREPARED.desiredSpec.rootVolumeSizeGb },
    instanceType: "t3.medium", rootVolumeSizeGb: PREPARED.desiredSpec.rootVolumeSizeGb
  });
  assert.equal(result.operation.phase, "ready");
  assert.match(result.operation.message, /Kept the current instance/);
  assert.equal(kept, PREPARED.info.instanceId);
  assert.equal(runs, 0, "keeping the current size must not start the instance");
});

test("an access check is read-only: a refusal becomes permission recovery and nothing is prepared or started", async () => {
  let prepares = 0;
  const refusal = Object.assign(new Error("User: arn:aws:iam::123456789012:user/accordagents-worker-abc is not authorized to perform: ec2:DescribeInstances"), { name: "UnauthorizedOperation" });
  const aws = {
    probeAccess: async () => { throw refusal; },
    prepareWorker: async () => { prepares++; return PREPARED; },
    ensurePreparedRunning: async () => { throw new Error("a check must not start the instance"); },
    status: async () => ({ configured: true, message: refusal.message })
  };
  const settings = { ...PROVIDER_SETTINGS, saveAwsWorkerOperation: async () => undefined, getAwsWorkerOperation: async () => undefined };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);
  const result = await service.start({ operationId: "check", intent: "check" });
  assert.equal(result.operation.phase, "error");
  assert.equal(result.operation.intent, "check");
  assert.equal(result.operation.remediation, "refresh-aws-authorization");
  assert.equal(result.operation.awsPrincipalUserName, "accordagents-worker-abc");
  assert.deepEqual(result.operation.missingAwsActions, ["ec2:DescribeInstances"]);
  assert.equal(prepares, 0);
});

test("a confirmed access check reports the instance state and starts nothing; pasted credentials are adopted first", async () => {
  const calls: string[] = [];
  const aws = {
    adoptCredentials: async (blob: string) => { calls.push(`adopt:${blob}`); },
    probeAccess: async () => { calls.push("probe"); return { configured: true, state: "stopped" }; },
    prepareWorker: async () => { throw new Error("a check must not prepare"); },
    ensurePreparedRunning: async () => { throw new Error("a check must not start"); }
  };
  const settings = { ...PROVIDER_SETTINGS, saveAwsWorkerOperation: async () => undefined, getAwsWorkerOperation: async () => undefined };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);
  const result = await service.start({ operationId: "check-ok", intent: "check", blob: "accord-aws-v1:new" });
  assert.equal(result.operation.phase, "ready");
  assert.match(result.operation.message, /AWS access confirmed · instance stopped/);
  assert.deepEqual(calls, ["adopt:accord-aws-v1:new", "probe"]);
  assert.equal(result.status.state, "stopped");
});

test("a check in flight is saved as running and never handed to a different request", async () => {
  const phases: string[] = [];
  let release!: (value: { configured: boolean; state: string }) => void;
  const aws = {
    probeAccess: () => new Promise<{ configured: boolean; state: string }>(resolve => { release = resolve; }),
    prepareWorker: async () => { throw new Error("must not prepare"); },
    ensurePreparedRunning: async () => { throw new Error("must not start"); }
  };
  const settings = { ...PROVIDER_SETTINGS, saveAwsWorkerOperation: async (operation: AwsWorkerOperationSnapshot | undefined) => { phases.push(operation?.phase ?? "cleared"); }, getAwsWorkerOperation: async () => undefined };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);
  const check = service.start({ operationId: "check-live", intent: "check" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(phases, ["starting"], "the running check is persisted before AWS answers");
  await assert.rejects(service.start({ operationId: "start-now", intent: "setup" }), /still running/);
  await assert.rejects(service.start({ operationId: "check-live", intent: "setup" }), /still running/);
  await assert.rejects(service.start({ operationId: "check-live", intent: "check", blob: "different-credentials" }), /still running/);
  assert.equal(service.start({ operationId: "check-live", intent: "check" }), check, "a retry of the same request joins it");
  release({ configured: true, state: "stopped" });
  const result = await check;
  assert.equal(result.operation.phase, "ready");
  assert.deepEqual(phases, ["starting", "ready"]);
});

test("what each intent may touch: a check reads only, keep changes only the saved size, a start is the only start", async () => {
  const run = async (request: Partial<AwsWorkerStartRequest> & { operationId: string }, actual = PREPARED.actualSpec) => {
    const touched: string[] = [];
    const aws = new Proxy({}, { get: (_target, method: string) => async (...args: unknown[]) => {
      touched.push(method);
      switch (method) {
        case "probeAccess": return { configured: true, state: "stopped" };
        case "status": return { configured: true, state: "stopped", actualSpec: actual };
        case "prepareWorker": return { ...PREPARED, actualSpec: actual, desiredSpec: { instanceType: request.instanceType ?? actual.instanceType, rootVolumeSizeGb: request.rootVolumeSizeGb ?? actual.rootVolumeSizeGb } };
        case "resumePendingVolumeExpansion": return args[0];
        case "hasAcceptedMismatch": return false;
        case "ensurePreparedRunning": return { host: "x" };
        case "keepCurrentSize": return actual;
        case "adoptCredentials": case "acceptMismatch": return undefined;
        default: throw new Error(`unexpected AWS call ${method}`);
      }
    } });
    const doctor = { waitForCloudInit: async () => undefined, setup: async () => ({ ok: true, message: "Worker ready.", checks: [] }) };
    const settings = { ...PROVIDER_SETTINGS, saveAwsWorkerOperation: async () => undefined, getAwsWorkerOperation: async () => undefined };
    const service = new AwsWorkerSetupService(aws as any, doctor as any, settings as any);
    const result = await service.start({ ...request } as AwsWorkerStartRequest);
    return { touched, phase: result.operation.phase, message: result.operation.message };
  };
  const check = await run({ operationId: "c", intent: "check" });
  assert.deepEqual(check.touched, ["probeAccess"], "a check reads the instance and nothing else");
  const checkWithBlob = await run({ operationId: "cb", intent: "check", blob: "accord-aws-v1:new" });
  assert.deepEqual(checkWithBlob.touched, ["adoptCredentials", "probeAccess"]);
  const keep = await run({ operationId: "k", intent: "resize", resolution: "keep", expectedInstanceId: PREPARED.info.instanceId, instanceType: "t3.medium", rootVolumeSizeGb: PREPARED.actualSpec.rootVolumeSizeGb, expectedDesiredSpec: { instanceType: "t3.medium", rootVolumeSizeGb: PREPARED.actualSpec.rootVolumeSizeGb } });
  assert.deepEqual(keep.touched, ["keepCurrentSize", "status"]);
  assert.equal(keep.phase, "ready");
  const start = await run({ operationId: "s", intent: "setup" });
  assert.deepEqual(start.touched, ["prepareWorker", "resumePendingVolumeExpansion", "hasAcceptedMismatch", "ensurePreparedRunning", "status"]);
  assert.equal(start.phase, "ready");
  for (const intent of ["check", "resize"] as const) {
    const touched = intent === "check" ? check.touched : keep.touched;
    assert.equal(touched.includes("ensurePreparedRunning"), false, `${intent} must never start the instance`);
  }
});

test("restarting after an interrupted check keeps its intent and never resumes a launch", async () => {
  let saved: AwsWorkerOperationSnapshot = { operationId: "check-restart", intent: "check", phase: "starting", message: "Checking AWS access…", updatedAt: "2026-09-13T00:00:00Z" };
  const settings = { ...PROVIDER_SETTINGS, getAwsWorkerOperation: async () => saved, saveAwsWorkerOperation: async (next: AwsWorkerOperationSnapshot) => { saved = next; } };
  const service = new AwsWorkerSetupService({} as any, {} as any, settings as any);
  await service.recoverInterruptedOperation();
  assert.equal(saved.intent, "check");
  assert.equal(saved.phase, "error");
  assert.match(saved.message, /access check was interrupted/);
  assert.doesNotMatch(saved.message, /Worker start/);
});

test("start orchestrates the exact visible phases and reaches ready", async () => {
  const saved: AwsWorkerOperationSnapshot[] = [];
  const phases: string[] = [];
  const status: AwsWorkerStatus = { configured: true, state: "running", handle: PREPARED.handle };
  const aws = {
    prepareWorker: async () => ({ ...PREPARED }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => ({ host: "198.51.100.10" }),
    status: async () => status
  };
  const doctor = {
    waitForCloudInit: async () => undefined,
    setup: async () => ({ ok: true, message: "Worker ready.", checks: [] })
  };
  const settings = { ...PROVIDER_SETTINGS,
    saveAwsWorkerOperation: async (operation: AwsWorkerOperationSnapshot) => { saved.push(operation); },
    getAwsWorkerOperation: async () => undefined
  };
  const service = new AwsWorkerSetupService(aws as any, doctor as any, settings as any);
  const result = await service.start({ operationId: "op-1" }, (operation) => phases.push(operation.phase));
  assert.deepEqual(phases, ["starting", "waiting-running", "setting-up", "ready"]);
  assert.equal(result.operation.phase, "ready");
  assert.equal(saved.at(-1)?.phase, "ready");
});

test("undersized adopted worker stops before running until the user decides", async () => {
  let ensureCalls = 0;
  const mismatch = {
    instanceId: "i-shared",
    actual: PREPARED.actualSpec,
    desired: { instanceType: "t3.medium", rootVolumeSizeGb: 16 },
    diskTooSmall: true,
    computeTooSmall: true
  };
  const aws = {
    prepareWorker: async () => ({ ...PREPARED, mismatch }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => { ensureCalls += 1; return { host: "x" }; },
    status: async () => ({ configured: true })
  };
  const settings = { ...PROVIDER_SETTINGS, saveAwsWorkerOperation: async () => undefined, getAwsWorkerOperation: async () => undefined };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);
  const result = await service.start({ operationId: "op-2" });
  assert.equal(result.operation.phase, "needs-decision");
  assert.equal(result.operation.specMismatch?.diskTooSmall, true);
  assert.equal(ensureCalls, 0);
});

test("retry reuses the persisted provisioning token", async () => {
  let snapshot: AwsWorkerOperationSnapshot | undefined;
  let attempts = 0;
  const tokens: string[] = [];
  const aws = {
    prepareWorker: async (request: { clientToken: string }) => {
      attempts += 1;
      tokens.push(request.clientToken);
      if (attempts === 1) throw new Error("ambiguous launch response");
      return { ...PREPARED };
    },
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => ({ host: "198.51.100.10" }),
    status: async () => ({ configured: attempts > 1 })
  };
  const doctor = {
    waitForCloudInit: async () => undefined,
    setup: async () => ({ ok: true, message: "Worker ready.", checks: [] })
  };
  const settings = { ...PROVIDER_SETTINGS,
    saveAwsWorkerOperation: async (operation: AwsWorkerOperationSnapshot) => { snapshot = operation; },
    getAwsWorkerOperation: async () => snapshot
  };
  const service = new AwsWorkerSetupService(aws as any, doctor as any, settings as any);
  const first = await service.start({ operationId: "op-stable", clientToken: "token-stable" });
  assert.equal(first.operation.phase, "error");
  const second = await service.start({ operationId: "op-stable" });
  assert.equal(second.operation.phase, "ready");
  assert.deepEqual(tokens, ["token-stable", "token-stable"]);
});

test("DescribeRegions authorization denial requests an AWS authorization refresh", async () => {
  let snapshot: AwsWorkerOperationSnapshot | undefined;
  let attempts = 0;
  const tokens: string[] = [];
  const aws = {
    prepareWorker: async (request: { clientToken: string }) => {
      attempts += 1;
      tokens.push(request.clientToken);
      if (attempts === 1) {
        throw new Error("User is not authorized to perform: ec2:DescribeRegions because no identity-based policy allows the ec2:DescribeRegions action");
      }
      return { ...PREPARED };
    },
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => ({ host: "198.51.100.10" }),
    status: async () => ({ configured: true, state: "running" })
  };
  const doctor = {
    waitForCloudInit: async () => undefined,
    setup: async () => ({ ok: true, message: "Worker ready.", checks: [] })
  };
  const settings = { ...PROVIDER_SETTINGS,
    saveAwsWorkerOperation: async (operation: AwsWorkerOperationSnapshot) => { snapshot = operation; },
    getAwsWorkerOperation: async () => snapshot
  };
  const service = new AwsWorkerSetupService(aws as any, doctor as any, settings as any);
  const failed = await service.start({ operationId: "op-auth", clientToken: "token-auth" });
  assert.equal(failed.operation.phase, "error");
  assert.equal(failed.operation.remediation, "refresh-aws-authorization");
  assert.match(failed.operation.message, /ec2:DescribeRegions/);
  assert.deepEqual(failed.operation.missingAwsActions, ["ec2:DescribeRegions"]);
  const recovered = await service.start({ operationId: "op-auth" });
  assert.equal(recovered.operation.phase, "ready");
  assert.deepEqual(tokens, ["token-auth", "token-auth"]);
});

test("authorization denial records the active scoped worker IAM user", async () => {
  const aws = {
    prepareWorker: async () => {
      throw new Error("You are not authorized to perform this operation. User: arn:aws:iam::018089055817:user/accordagents-worker-pna6gbah is not authorized to perform: ec2:DescribeInstanceTypes because no identity-based policy allows the ec2:DescribeInstanceTypes action");
    },
    status: async () => ({ configured: true, state: "running" })
  };
  const settings = { ...PROVIDER_SETTINGS,
    saveAwsWorkerOperation: async () => undefined,
    getAwsWorkerOperation: async () => undefined
  };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);

  const failed = await service.start({ operationId: "op-active-auth" });

  assert.equal(failed.operation.remediation, "refresh-aws-authorization");
  assert.equal(failed.operation.awsPrincipalArn, "arn:aws:iam::018089055817:user/accordagents-worker-pna6gbah");
  assert.equal(failed.operation.awsPrincipalUserName, "accordagents-worker-pna6gbah");
  assert.deepEqual(failed.operation.missingAwsActions, ["ec2:DescribeInstanceTypes"]);
});

test("non-authorization setup failures do not request an AWS authorization refresh", async () => {
  const aws = {
    prepareWorker: async () => { throw new Error("EC2 capacity is unavailable"); },
    status: async () => ({ configured: false })
  };
  const settings = { ...PROVIDER_SETTINGS,
    saveAwsWorkerOperation: async () => undefined,
    getAwsWorkerOperation: async () => undefined
  };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);
  const failed = await service.start({ operationId: "op-capacity" });
  assert.equal(failed.operation.remediation, undefined);
  assert.match(failed.operation.message, /capacity/);
});

test("doctor access failures do not request an AWS authorization refresh", async () => {
  const aws = {
    prepareWorker: async () => ({ ...PREPARED }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => ({ host: "198.51.100.10" }),
    status: async () => ({ configured: true, state: "running" })
  };
  const doctor = {
    waitForCloudInit: async () => undefined,
    setup: async () => { throw new Error("GitHub API returned 403 access denied"); }
  };
  const settings = { ...PROVIDER_SETTINGS,
    saveAwsWorkerOperation: async () => undefined,
    getAwsWorkerOperation: async () => undefined
  };
  const service = new AwsWorkerSetupService(aws as any, doctor as any, settings as any);
  const failed = await service.start({ operationId: "op-doctor-access" });
  assert.equal(failed.operation.phase, "error");
  assert.equal(failed.operation.remediation, undefined);
  assert.match(failed.operation.message, /403 access denied/);
});

test("mismatch resolution rejects a desired spec that differs from the displayed decision", async () => {
  const mismatch = {
    instanceId: "i-shared",
    actual: PREPARED.actualSpec,
    desired: { instanceType: "t3.medium", rootVolumeSizeGb: 16 },
    diskTooSmall: true,
    computeTooSmall: true
  };
  const aws = {
    prepareWorker: async () => ({ ...PREPARED, desiredSpec: mismatch.desired, mismatch }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    status: async () => ({ configured: true })
  };
  const settings = { ...PROVIDER_SETTINGS, saveAwsWorkerOperation: async () => undefined, getAwsWorkerOperation: async () => undefined };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);
  const result = await service.start({
    operationId: "op-stale",
    resolution: "recreate",
    expectedInstanceId: "i-shared",
    expectedDesiredSpec: { instanceType: "t3.large", rootVolumeSizeGb: 32 }
  });
  assert.equal(result.operation.phase, "error");
  assert.match(result.operation.message, /required worker size changed/);
});

test("queued doctor progress cannot overwrite the terminal ready snapshot", async () => {
  const saved: AwsWorkerOperationSnapshot[] = [];
  const aws = {
    prepareWorker: async () => ({ ...PREPARED }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => ({ host: "198.51.100.10" }),
    status: async () => ({ configured: true })
  };
  const doctor = {
    waitForCloudInit: async (_worker: unknown, progress: (value: any) => void) => {
      progress({ stage: "cloud-init", message: "slow-progress" });
    },
    setup: async (_worker: unknown, progress: (value: any) => void) => {
      progress({ stage: "diagnose", message: "final-progress" });
      return { ok: true, message: "Worker ready.", checks: [] };
    }
  };
  const settings = { ...PROVIDER_SETTINGS,
    saveAwsWorkerOperation: async (operation: AwsWorkerOperationSnapshot) => {
      if (operation.message === "slow-progress") await new Promise((resolve) => setTimeout(resolve, 5));
      saved.push(operation);
    },
    getAwsWorkerOperation: async () => undefined
  };
  const service = new AwsWorkerSetupService(aws as any, doctor as any, settings as any);
  await service.start({ operationId: "op-ordered" });
  assert.equal(saved.at(-1)?.phase, "ready");
  assert.deepEqual(saved.filter((item) => item.phase === "setting-up").map((item) => item.message), [
    "Setting up the tools the agents use…",
    "slow-progress",
    "final-progress"
  ]);
});

test("size Apply rejects a changed instance before provisioning or modifying anything", async () => {
  let prepares = 0;
  const aws = {
    status: async () => ({ configured: true, state: "running", actualSpec: { ...PREPARED.actualSpec, rootVolumeSizeGb: 64 } }),
    prepareWorker: async () => { prepares++; return PREPARED; }
  };
  const service = new AwsWorkerSetupService(aws as any, {} as any, { getAwsWorkerOperation: async () => undefined, saveAwsWorkerOperation: async () => undefined } as any);
  const result = await service.start({ operationId: "stale-size", intent: "resize", rootVolumeSizeGb: 41, expectedInstanceId: "i-shared", expectedActualSpec: { instanceType: "t3.small", rootVolumeSizeGb: 40 } });
  assert.equal(result.operation.phase, "error");
  assert.match(result.operation.message, /instance changed/);
  assert.equal(prepares, 0);
});

test("size Apply cannot shrink the current disk even through direct IPC", async () => {
  let prepares = 0;
  const actualSpec = { ...PREPARED.actualSpec, rootVolumeSizeGb: 40 };
  const aws = {
    status: async () => ({ configured: true, state: "running", actualSpec }),
    prepareWorker: async () => { prepares++; return PREPARED; }
  };
  const service = new AwsWorkerSetupService(aws as any, {} as any, { getAwsWorkerOperation: async () => undefined, saveAwsWorkerOperation: async () => undefined } as any);
  const result = await service.start({ operationId: "smaller-size", intent: "resize", rootVolumeSizeGb: 8, expectedInstanceId: "i-shared", expectedActualSpec: actualSpec });
  assert.equal(result.operation.phase, "error");
  assert.match(result.operation.message, /cannot shrink/);
  assert.equal(prepares, 0);
});
