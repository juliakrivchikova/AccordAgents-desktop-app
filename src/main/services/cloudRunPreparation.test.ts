import assert from "node:assert/strict";
import test from "node:test";
import { CloudRunPreparationService } from "./cloudRunPreparation";
import { conversationOnMachine } from "../../shared/machineRepository";
import type { Conversation, AwsWorkerStatus } from "../../shared/types";
import type { MachineRecord } from "../../shared/machineLink";
import type { MachineInstallRecord, MachineInstallRequest } from "../../shared/machineInstall";

function harness() {
  const machines: MachineRecord[] = [];
  const installs: MachineInstallRecord[] = [];
  const calls: string[] = [];
  const installRequests: MachineInstallRequest[] = [];
  let phase: "ready" | "error" = "ready";
  let failSave = false;
  let state: AwsWorkerStatus["state"] = "running";
  const options: ConstructorParameters<typeof CloudRunPreparationService>[0] = {
    appVersion: "test",
    configuredInstanceId: async () => "i-abc",
    environmentId: async () => "home-desktop",
    aws: {
      status: async () => ({ configured: true, state, handle: { instanceId: "i-abc", region: "eu-west-1" } } as AwsWorkerStatus),
      ensureExistingWorkerForRun: async id => { calls.push(`access:${id}`); return { host: "198.51.100.8", user: "ubuntu" }; }
    },
    listMachines: async () => machines,
    listInstalls: async () => installs,
    createMachine: async (name, awsInstanceId) => {
      calls.push("enroll");
      const machine = { id: "machine-1", name, awsInstanceId, deviceId: "", pairingKey: "test-pairing", createdAt: "2026-09-10" };
      machines.push(machine);
      return machine;
    },
    install: async (request, progress) => {
      installRequests.push(request);
      calls.push(`install:${request.machineId}:${request.requiredProvider}`);
      const snapshot = { machineId: request.machineId, phase, operationId: request.operationId, kind: "install" as const,
        message: phase === "ready" ? "Connected" : "Sign-in failed", updatedAt: "now", completed: [] };
      progress(snapshot);
      const root = request.installRoot?.replace("~", "/home/ubuntu") || "/home/ubuntu/accordagents-machine";
      const record = { machineId: request.machineId, target: request.target, installRoot: root,
        userDataDir: request.userDataDir || `${root}/data`, serviceName: request.serviceName || root.split("/").pop()!,
        profileHome: request.isolatedProfile ? `${root}/home` : undefined, serviceScope: "user" as const };
      if (!installs.length) installs.push(record);
      return { record, snapshot };
    },
    isConnected: () => false,
    prepareMachine: async () => { calls.push("profile"); },
    prepareProvider: async (_worker, provider) => { calls.push(`provider:${provider}`); },
    bootstrapProject: async () => {
      calls.push("project");
      return { inspection: { path: "/home/ubuntu/project/repo", state: "dirty", worktrees: ["../feature"], dirtyPaths: ["work.ts"] }, action: "refused", message: "Existing changes kept" };
    },
    saveInstall: async record => {
      if (failSave) throw new Error("disk unavailable");
      installs.splice(installs.findIndex(item => item.machineId === record.machineId), 1, record);
    }
  };
  return { options, machines, installs, calls, installRequests, service: new CloudRunPreparationService(options),
    failInstall: () => { phase = "error"; }, allowInstall: () => { phase = "ready"; },
    failSave: () => { failSave = true; }, allowSave: () => { failSave = false; },
    stop: () => { state = "stopped"; } };
}
const request = { operationId: "one", provider: "codex-cli" as const };

test("Cloud run returns the restored home identity so a new participant targets the existing runtime", async () => {
  const h = harness();
  const install = h.options.install;
  h.options.install = async (request, progress) => {
    const result = await install(request, progress);
    h.machines[0] = { ...h.machines[0], id: "original-home" };
    return { ...result, record: { ...result.record, machineId: "original-home" } };
  };
  const result = await h.service.prepare(request, () => {});
  assert.equal(result.machine.id, "original-home");
});

test("two desktops sharing one AWS instance install into separate persistent environments", async () => {
  const home = harness();
  const work = harness(); work.options.environmentId = async () => "work-desktop";
  await Promise.all([home.service.prepare(request, () => {}), work.service.prepare(request, () => {})]);
  assert.notEqual(home.installRequests[0].installRoot, work.installRequests[0].installRoot);
  assert.equal(home.installRequests[0].target.host, work.installRequests[0].target.host);
  assert.equal(home.installRequests[0].isolatedProfile, true);
  await new CloudRunPreparationService(home.options).prepare(request, () => {});
  assert.equal(home.installRequests[1].installRoot, home.installs[0].installRoot);
  assert.equal(home.installRequests[1].isolatedProfile, true);
});

test("a legacy environment keeps its CLI sessions, data directory and worktrees", async () => {
  const h = harness();
  h.machines.push({ id: "legacy", name: "Cloud run", awsInstanceId: "i-abc", deviceId: "cloud", pairingKey: "legacy", createdAt: "now" });
  h.installs.push({ machineId: "legacy", target: { host: "198.51.100.8" }, installRoot: "/home/ubuntu/accordagents-machine",
    userDataDir: "/home/ubuntu/.accordagents/machine", serviceName: "accordagents-machine", serviceScope: "system" });
  await h.service.prepare(request, () => {});
  assert.equal(h.installRequests[0].installRoot, h.installs[0].installRoot);
  assert.equal(h.installRequests[0].userDataDir, h.installs[0].userDataDir);
  assert.equal(h.installRequests[0].isolatedProfile, false);
  assert.equal(h.calls.includes("enroll"), false);
});

test("a failed legacy attempt with no installed paths starts in this desktop's own environment", async () => {
  const h = harness();
  h.machines.push({ id: "partial", name: "Cloud run", awsInstanceId: "i-abc", deviceId: "", pairingKey: "partial", createdAt: "now" });
  h.installs.push({ machineId: "partial", target: { host: "198.51.100.8" }, installRoot: "", userDataDir: "",
    serviceName: "accordagents-machine", serviceScope: "system" });
  await h.service.prepare(request, () => {});
  assert.equal(h.installRequests[0].isolatedProfile, true);
  assert.equal(h.installRequests[0].serviceName, undefined);
  assert.notEqual(h.installRequests[0].installRoot, "~/accordagents-machine");
});

test("two Cloud selections prepare one existing instance and both receive progress", async () => {
  const h = harness();
  const progress: string[] = [];
  const [a, b] = await Promise.all([h.service.prepare(request, p => progress.push(p.operationId)),
    h.service.prepare({ ...request, operationId: "two" }, p => progress.push(p.operationId))]);
  assert.equal(a.machine.id, b.machine.id);
  assert.deepEqual(h.calls, ["access:i-abc", "enroll", "install:machine-1:codex-cli"]);
  assert.ok(progress.includes("one") && progress.includes("two"));
});

test("failed setup and desktop restart reuse the enrolled instance", async () => {
  const h = harness(); h.failInstall();
  await assert.rejects(h.service.prepare(request, () => {}), /Sign-in failed/);
  h.allowInstall();
  await new CloudRunPreparationService(h.options).prepare(request, () => {});
  assert.equal(h.calls.filter(call => call === "enroll").length, 1);
});

test("selecting Cloud never provisions an absent or stopped server", async () => {
  const h = harness(); h.stop();
  await assert.rejects(h.service.prepare(request, () => {}), /Start your AWS instance/);
  assert.deepEqual(h.calls, []);
});

test("choosing an existing AWS machine never silently switches to a different instance", async () => {
  const h = harness();
  await assert.rejects(h.service.prepare({ ...request, instanceId: "i-def" }, () => {}), /different AWS instance/);
  assert.deepEqual(h.calls, []);
});

test("different providers each get their own setup check on the same machine", async () => {
  const h = harness();
  const install = h.options.install;
  h.options.install = async (request, progress) => {
    const result = await install(request, progress);
    h.options.isConnected = () => true;
    h.machines[0].lastHello = { deviceId: "cloud", machineName: "cloud", platform: "linux", appVersion: "test", providers: [] };
    return result;
  };
  await Promise.all([h.service.prepare(request, () => {}), h.service.prepare({ ...request, provider: "claude-code" }, () => {})]);
  assert.deepEqual(h.calls, ["access:i-abc", "enroll", "install:machine-1:codex-cli", "provider:claude-code"]);
  assert.equal(h.machines.length, 1);
});

test("selecting a member on a connected machine checks its provider without restarting the runtime", async () => {
  const h = harness(); await h.service.prepare(request, () => {});
  h.options.isConnected = () => true;
  h.machines[0].lastHello = { deviceId: "cloud", machineName: "cloud", platform: "linux", appVersion: "test", providers: [] };
  await h.service.prepare({ ...request, provider: "claude-code" }, () => {});
  assert.equal(h.calls.filter(call => call.startsWith("install:")).length, 1);
  assert.ok(h.calls.includes("provider:claude-code"));
});

test("project setup keeps a dirty remote checkout and persists its actual path once", async () => {
  const h = harness(); await h.service.prepare(request, () => {});
  await Promise.all([h.service.prepareProject("machine-1", "/Users/user/project"), h.service.prepareProject("machine-1", "/Users/user/project")]);
  assert.equal(h.calls.filter(call => call === "project").length, 1);
  const restarted = new CloudRunPreparationService(h.options);
  await restarted.prepareProject("machine-1", "/Users/user/project");
  assert.equal(h.calls.filter(call => call === "project").length, 1);
  assert.deepEqual(await restarted.repositoryPaths("/Users/user/project"), { "machine-1": "/home/ubuntu/project/repo" });
});

test("a refused project record is not treated as prepared and can be retried", async () => {
  const h = harness(); await h.service.prepare(request, () => {}); h.failSave();
  await assert.rejects(h.service.prepareProject("machine-1", "/Users/user/project"), /disk unavailable/);
  assert.deepEqual(await h.service.repositoryPaths("/Users/user/project"), {});
  h.allowSave(); await h.service.prepareProject("machine-1", "/Users/user/project");
  assert.equal(h.calls.filter(call => call === "project").length, 2);
});

test("a non-git project folder uses the machine's copy and persists its path", async () => {
  const h = harness();
  await h.service.prepare(request, () => undefined);
  h.options.bootstrapProject = async () => ({ inspection: { path: "/home/ubuntu/notes", state: "directory", dirtyPaths: [], worktrees: [] },
    action: "created", message: "Copied" });
  await h.service.prepareProject("machine-1", "/Users/user/notes");
  assert.deepEqual(await h.service.repositoryPaths("/Users/user/notes"), { "machine-1": "/home/ubuntu/notes" });
});

test("replication selects each machine's native project path without changing the desktop", () => {
  const desktop = { repoPath: "/Users/user/project", metadata: { machineRepository: {
    sourcePath: "/Users/user/project", paths: { one: "/home/one/project", two: "/home/two/project" }
  } } } as unknown as Conversation;
  const one = conversationOnMachine(desktop, "one");
  assert.equal(desktop.repoPath, "/Users/user/project");
  assert.equal(one.repoPath, "/home/one/project");
  assert.equal(conversationOnMachine(one, "two").repoPath, "/home/two/project");
});


test("cancelling a queued project preserves the active copy and a later retry", async () => {
  const h = harness(); await h.service.prepare(request, () => {});
  let release!: () => void;
  let reached!: () => void;
  const copying = new Promise<void>(resolve => { reached = resolve; });
  const base = h.options.bootstrapProject;
  h.options.bootstrapProject = async (...args) => { reached(); await new Promise<void>(resolve => { release = resolve; }); return base(...args); };
  const first = h.service.prepareProject("machine-1", "/first");
  await copying;
  const controller = new AbortController();
  const second = h.service.prepareProject("machine-1", "/second", controller.signal);
  const cancelled = assert.rejects(second, /cancelled/);
  controller.abort(new Error("cancelled"));
  await cancelled;
  assert.equal(h.calls.filter(call => call === "project").length, 0);
  h.options.bootstrapProject = base;
  const third = h.service.prepareProject("machine-1", "/third");
  release();
  await Promise.all([first, third]);
  assert.deepEqual(await h.service.repositoryPaths("/second"), {});
  assert.ok((await h.service.repositoryPaths("/third"))["machine-1"]);
  assert.equal(h.calls.filter(call => call === "project").length, 2);
});

test("a cancelled copy which resolves late cannot publish a prepared project mapping", async () => {
  const h = harness(); await h.service.prepare(request, () => {});
  const controller = new AbortController();
  const base = h.options.bootstrapProject;
  h.options.bootstrapProject = async (...args) => { controller.abort(new Error("cancelled")); return base(...args); };
  await assert.rejects(h.service.prepareProject("machine-1", "/project", controller.signal), /cancelled/);
  assert.deepEqual(await h.service.repositoryPaths("/project"), {});
  assert.deepEqual(await new CloudRunPreparationService(h.options).repositoryPaths("/project"), {});
});


test("background preparation keeps a queryable result and reuses a connected prepared provider", async () => {
  const h = harness();
  const install = h.options.install;
  h.options.install = async (request, progress) => {
    const result = await install(request, progress);
    h.options.isConnected = () => true;
    h.machines[0].lastHello = { deviceId: "cloud", machineName: "cloud", platform: "linux", appVersion: "test", providers: [] };
    return result;
  };
  const snapshots: any[] = [];
  h.options.onProgress = snapshot => snapshots.push(snapshot);
  await h.service.prepare(request, () => {});
  assert.equal(h.service.snapshot(request)?.phase, "ready");
  assert.equal(h.service.snapshot(request)?.machine?.id, "machine-1");
  h.options.isConnected = () => true;
  h.machines[0].lastHello = { deviceId: "cloud", machineName: "cloud", platform: "linux", appVersion: "test", providers: [] };
  const before = h.calls.length;
  await h.service.prepare({ ...request, operationId: "reopen" }, () => {});
  assert.equal(h.calls.length, before);
  assert.ok(snapshots.some(snapshot => snapshot.phase === "preparing"));
  h.options.isConnected = () => false;
  h.failInstall();
  await assert.rejects(h.service.prepare({ ...request, operationId: "retry" }, () => {}), /Sign-in failed/);
  assert.equal(h.service.snapshot(request)?.phase, "error");
  assert.match(h.service.snapshot(request)?.message ?? "", /Sign-in failed/);
});


test("a cached Cloud result is not reused after the configured AWS instance changes", async () => {
  const h = harness();
  h.options.configuredInstanceId = async () => "i-abc";
  await h.service.prepare(request, () => {});
  h.options.isConnected = () => true;
  h.machines[0].lastHello = { deviceId: "cloud", machineName: "cloud", platform: "linux", appVersion: "test", providers: [] };
  h.options.configuredInstanceId = async () => "i-new";
  h.options.aws.status = async () => { throw new Error("new AWS instance unavailable"); };
  await assert.rejects(h.service.prepare(request, () => {}), /new AWS instance unavailable/);
  assert.equal(h.service.snapshot(request)?.phase, "error");
});

async function connectedHarness() {
  const h = harness();
  await h.service.prepare(request, () => {});
  h.options.isConnected = () => true;
  h.machines[0].lastHello = { deviceId: "cloud", machineName: "cloud", platform: "linux", appVersion: "test",
    instanceId: "process-1", providers: [] };
  h.calls.length = 0;
  return { ...h, service: new CloudRunPreparationService(h.options) };
}

test("many members and configured/explicit aliases share AWS and profile work, with one check per provider", async () => {
  const h = await connectedHarness();
  const progress = new Set<string>();
  let statusChecks = 0;
  const status = h.options.aws.status;
  h.options.aws.status = async () => { statusChecks++; return status(); };
  const requests = Array.from({ length: 12 }, (_, i) => ({ operationId: `member-${i}`,
    provider: i % 2 ? "claude-code" as const : "codex-cli" as const, instanceId: i % 3 ? "i-abc" : undefined }));
  const results = await Promise.all(requests.map(item => h.service.prepare(item, p => progress.add(p.operationId))));
  assert.equal(new Set(results.map(item => item.machine.id)).size, 1);
  assert.equal(progress.size, requests.length);
  assert.equal(statusChecks, 1);
  assert.deepEqual(h.calls, ["access:i-abc", "profile", "provider:codex-cli", "provider:claude-code"]);
  for (const item of requests) assert.equal(h.service.snapshot(item)?.phase, "ready");
  await Promise.all(requests.map(item => h.service.prepare(item, () => {})));
  assert.equal(statusChecks, 1);
  assert.equal(h.calls.length, 4);
});

test("provider failure reaches every same-provider waiter and a retry refreshes shared access once", async () => {
  const h = await connectedHarness();
  let fail = true;
  h.options.prepareProvider = async (_worker, provider) => {
    h.calls.push(`provider:${provider}`);
    if (fail) throw new Error("sign-in expired");
  };
  const failures = await Promise.allSettled([h.service.prepare(request, () => {}),
    h.service.prepare({ ...request, operationId: "alias", instanceId: "i-abc" }, () => {})]);
  assert.ok(failures.every(result => result.status === "rejected" && /sign-in expired/.test(result.reason.message)));
  assert.deepEqual(h.calls, ["access:i-abc", "profile", "provider:codex-cli"]);
  assert.equal(h.service.snapshot(request)?.phase, "error");
  fail = false;
  await Promise.all([h.service.prepare(request, () => {}), h.service.prepare({ ...request, operationId: "retry" }, () => {})]);
  assert.deepEqual(h.calls.slice(3), ["access:i-abc", "profile", "provider:codex-cli"]);
});

test("a cancelled provider login preserves other ready members, including after its retry", async () => {
  const h = await connectedHarness();
  await h.service.prepare(request, () => {});
  const prepare = h.options.prepareProvider;
  h.options.prepareProvider = async () => { throw new Error("sign-in cancelled"); };
  const claude = { ...request, provider: "claude-code" as const };
  await assert.rejects(h.service.prepare(claude, () => {}), /sign-in cancelled/);
  await h.service.prepare({ ...request, instanceId: "i-abc" }, () => {});
  assert.deepEqual(h.calls, ["access:i-abc", "profile", "provider:codex-cli"]);
  h.options.prepareProvider = prepare;
  await h.service.prepare(claude, () => {});
  const before = h.calls.length;
  await h.service.prepare(request, () => {});
  assert.equal(h.calls.length, before);
  assert.deepEqual(h.calls.slice(3), ["access:i-abc", "profile", "provider:claude-code"]);
});

test("a failed profile save is not marked prepared and provider checks wait for the retry", async () => {
  const h = await connectedHarness();
  const prepare = h.options.prepareMachine;
  h.options.prepareMachine = async () => { throw new Error("profile not saved"); };
  await assert.rejects(h.service.prepare(request, () => {}), /profile not saved/);
  assert.deepEqual(h.calls, ["access:i-abc"]);
  h.options.prepareMachine = prepare;
  await h.service.prepare(request, () => {});
  assert.deepEqual(h.calls.slice(1), ["access:i-abc", "profile", "provider:codex-cli"]);
});

test("runtime restart, changed installation, disconnect and desktop restart invalidate prepared work", async () => {
  for (const change of ["runtime", "installation", "disconnect", "desktop"]) {
    const h = await connectedHarness();
    await h.service.prepare(request, () => {});
    h.calls.length = 0;
    if (change === "runtime") h.machines[0].lastHello!.instanceId = "process-2";
    if (change === "installation") h.installs[0].profileHome = "/home/ubuntu/changed/home";
    if (change === "disconnect") h.options.isConnected = () => false;
    const service = change === "desktop" ? new CloudRunPreparationService(h.options) : h.service;
    await service.prepare(request, () => {});
    assert.equal(h.calls.filter(call => call === "access:i-abc").length, 1, change);
    assert.ok(h.calls.some(call => call.startsWith(change === "disconnect" ? "install:" : "provider:")), change);
  }
});

test("queued configured selections resolve a changed instance again instead of reusing the old one", async () => {
  const h = await connectedHarness();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  h.options.prepareProvider = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
  const first = h.service.prepare(request, () => {});
  await started;
  const queued = h.service.prepare({ ...request, provider: "claude-code" }, () => {});
  h.options.configuredInstanceId = async () => "i-new";
  const rejected = assert.rejects(queued, /different AWS instance/);
  release();
  await first;
  await rejected;
  await assert.rejects(h.service.prepare({ ...request, instanceId: "i-abc" }, () => {}), /different AWS instance/);
  assert.equal(h.calls.filter(call => call === "access:i-abc").length, 1);
});
