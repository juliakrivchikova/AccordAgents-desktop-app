import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  machineDrainScript, machineMirrorProbeScript, machineProbeScript, machineServiceUnit, parseMachineDrainReport,
  parseMachineMirrorProbe, parseMachineProbe
} from "./machineInstallScripts";
import { harness, LAYOUT, probeOutput, TARGET } from "./machineInstaller/test/installerFixtures";

// ---- parsers --------------------------------------------------------------

test("the probe reports tools, releases and the processes this install owns", () => {
  const probe = parseMachineProbe(probeOutput({
    state: JSON.stringify({ version: "1.3.0", digest: "abc123", installedAt: "2026-09-01T00:00:00.000Z" }),
    "active-release": "1.3.0-abc123",
    enrollment: "present",
    "service-scope": "system",
    "service-state": "active",
    "runtime-pids": " 4210 ",
    "supervisor-pids": "4300 4301",
    "provider-pids": "4400"
  }, ["1.2.0-old", "1.3.0-abc123"]));
  assert.equal(probe.installedVersion, "1.3.0");
  assert.equal(probe.installedDigest, "abc123");
  assert.deepEqual(probe.releases, ["1.2.0-old", "1.3.0-abc123"]);
  assert.deepEqual(probe.runtimePids, [4210]);
  assert.deepEqual(probe.supervisorPids, [4300, 4301]);
  assert.deepEqual(probe.providerPids, [4400]);
  assert.equal(probe.enrollmentPresent, true);
  assert.equal(probe.serviceScope, "system");
  assert.equal(probe.loginPath, "/home/ubuntu/.npm-global/bin:/usr/bin:/bin");
});

test("the probe says how long the unit's own process has run", () => {
  assert.equal(parseMachineProbe(probeOutput({ "runtime-pids": " 41 52", "service-age": "3605" })).serviceAgeSeconds, 3605);
  assert.equal(parseMachineProbe(probeOutput({ "service-age": "" })).serviceAgeSeconds, undefined, "no process, no age");
  assert.equal(parseMachineProbe(probeOutput({ "service-age": "12:04" })).serviceAgeSeconds, undefined, "only whole seconds are read");
  const script = machineProbeScript({});
  assert.match(script, /show -p MainPID --value "\$SVC\.service"/);
  assert.match(script, /service-age=%s/);
});

test("the drain report is only positive when nothing of this install is left", () => {
  assert.equal(parseMachineDrainReport("drained=yes\nruntime-pids=\n").drained, true);
  const blocked = parseMachineDrainReport("service-state=active\nruntime-pids=99\nsupervisor-pids=100\nprovider-pids=101\ndrained=no\n");
  assert.equal(blocked.drained, false);
  assert.deepEqual(blocked.runtimePids, [99]);
  assert.deepEqual(blocked.supervisorPids, [100]);
  assert.deepEqual(blocked.providerPids, [101]);
});

test("the drain never escalates past SIGTERM", () => {
  const script = machineDrainScript(LAYOUT);
  assert.ok(script.includes("kill -TERM"));
  assert.ok(!/kill\s+-9|SIGKILL|-KILL/.test(script));
});

test("the mirror probe separates uncommitted work from participant worktrees", () => {
  const clean = parseMachineMirrorProbe([
    "path=/root/mirrors/p/repo", "branch=main", "head=abc",
    "worktree=/root/mirrors/p/repo", "sibling=/root/mirrors/p/feature-x", "state=present"
  ].join("\n"));
  assert.equal(clean.state, "clean");
  assert.deepEqual(clean.worktrees, ["/root/mirrors/p/feature-x"]);

  const dirty = parseMachineMirrorProbe([
    "path=/root/mirrors/p/repo", "dirty= M src/a.ts", "dirty=?? new.ts", "state=present"
  ].join("\n"));
  assert.equal(dirty.state, "dirty");
  assert.equal(dirty.dirtyPaths.length, 2);

  assert.equal(parseMachineMirrorProbe("path=/x\nstate=absent\n").state, "absent");
});

test("a deployment outside the default directory gets its own data directory and unit", () => {
  const script = machineProbeScript({ installRoot: "~/accordagents-installer-qa" });
  assert.ok(script.includes('ROOT="$HOME/accordagents-installer-qa"'));
  assert.ok(script.includes('UD_DEFAULT="$HOME/.accordagents/$NAME"'));
  assert.ok(script.includes('SVC_DEFAULT="$NAME"'));
  // Two deployments sharing one user-data directory would be two executors.
  assert.ok(script.includes("accordagents-machine) UD_DEFAULT=\"$HOME/.accordagents/machine\""));
  assert.throws(() => machineProbeScript({ installRoot: "/tmp/x; rm -rf /" }), /may only contain/);
});

test("the systemd unit carries HOME, the login PATH and a graceful stop", () => {
  const unit = machineServiceUnit({
    layout: LAYOUT, machineName: "cloud-box", home: "/home/ubuntu", user: "ubuntu",
    nodePath: "/usr/bin/node", path: "/home/ubuntu/.npm-global/bin:/usr/bin"
  });
  assert.ok(unit.includes("Environment=HOME=/home/ubuntu"));
  assert.ok(unit.includes("Environment=PATH=/home/ubuntu/.npm-global/bin:/usr/bin"));
  assert.ok(unit.includes("Environment=ACCORDAGENTS_USER_DATA_DIR=/home/ubuntu/.accordagents/machine"));
  assert.ok(unit.includes("ExecStart=/usr/bin/node /home/ubuntu/accordagents-machine/current/accordagents-machine.cjs"));
  assert.ok(unit.includes("KillSignal=SIGTERM"));
  assert.ok(unit.includes("TimeoutStopSec=120"));
  assert.ok(unit.includes("User=ubuntu"));

  const userUnit = machineServiceUnit({
    layout: { ...LAYOUT, serviceScope: "user" }, machineName: "box", home: "/home/u", user: "u", nodePath: "/usr/bin/node"
  });
  assert.ok(userUnit.includes("WantedBy=default.target"));
  assert.ok(!userUnit.includes("User=u\n"));
});

test("a deployment in its own directory gets its own unit, not the default one", async () => {
  // Regression: passing the default service name into the probe overrode the
  // name the machine derives, so a second deployment on one box installed
  // itself over the first deployment's unit.
  const h = harness();
  await h.service.install({
    machineId: "m1", operationId: "op-root", target: TARGET, installRoot: "~/accordagents-installer-qa"
  });
  const probeCall = h.calls.find((call) => call.script.includes("printf 'home=%s"));
  assert.ok(probeCall);
  assert.ok(!probeCall.script.includes("SVC='accordagents-machine'"), "the probe must not force the default unit name");
  assert.ok(probeCall.script.includes("SVC='accordagents-installer-qa'"));
  assert.ok(probeCall.script.includes('ROOT="$HOME/accordagents-installer-qa"'));
});

// ---- project mirror -------------------------------------------------------

test("a dirty mirror is refused and left untouched", async () => {
  const h = harness({ mirror: "path=/root/repo\ndirty= M src/a.ts\nstate=present\n" });
  h.records.set("m1", {
    machineId: "m1", target: TARGET, installRoot: "/home/ubuntu/accordagents-machine",
    userDataDir: "/home/ubuntu/.accordagents/machine", serviceName: "accordagents-machine", serviceScope: "system"
  });
  const result = await h.service.bootstrapProjectMirror({ machineId: "m1", localPath: process.cwd() });
  assert.equal(result.action, "refused");
  assert.match(result.message, /uncommitted change/);
  assert.deepEqual(h.syncedUp, []);
});

test("an existing clean mirror is reused, never copied over", async () => {
  const h = harness({ mirror: "path=/root/repo\nsibling=/root/feature-x\nstate=present\n" });
  h.records.set("m1", {
    machineId: "m1", target: TARGET, installRoot: "/home/ubuntu/accordagents-machine",
    userDataDir: "/home/ubuntu/.accordagents/machine", serviceName: "accordagents-machine", serviceScope: "system"
  });
  const result = await h.service.bootstrapProjectMirror({ machineId: "m1", localPath: process.cwd() });
  assert.equal(result.action, "reused");
  assert.match(result.message, /1 worktree/);
  assert.deepEqual(h.syncedUp, []);
});

test("a project the machine does not have is bootstrapped once", async () => {
  const h = harness({ mirror: "path=/root/repo\nstate=absent\n" });
  h.records.set("m1", {
    machineId: "m1", target: TARGET, installRoot: "/home/ubuntu/accordagents-machine",
    userDataDir: "/home/ubuntu/.accordagents/machine", serviceName: "accordagents-machine", serviceScope: "system"
  });
  const result = await h.service.bootstrapProjectMirror({ machineId: "m1", localPath: process.cwd() });
  assert.equal(result.action, "created");
  assert.equal(h.syncedUp.length, 1);
  assert.match(h.syncedUp[0], /\/workspace\/mirrors\/.+\/repo\.bootstrap-[a-f0-9-]+$/);
  assert.ok(h.calls.some(call => call.script.includes("mv -Tn --") && call.maintenance));
});

test("ordinary folders are present projects and must never be copied over", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-folder-"));
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "notes.txt"), "machine edits");
    const output = execFileSync("sh", ["-s"], { input: machineMirrorProbeScript(repo), encoding: "utf8" });
    assert.equal(parseMachineMirrorProbe(output).state, "directory");
    const h = harness({ mirror: output });
    h.records.set("m1", { machineId: "m1", target: TARGET, ...LAYOUT });
    const result = await h.service.bootstrapProjectMirror({ machineId: "m1", localPath: root });
    assert.equal(result.action, "reused");
    assert.deepEqual(h.syncedUp, []);
    assert.equal(fs.readFileSync(path.join(repo, "notes.txt"), "utf8"), "machine edits");
    fs.writeFileSync(path.join(repo, ".git"), "gitdir: /missing/checkout\n");
    assert.equal(parseMachineMirrorProbe(execFileSync("sh", ["-s"], {
      input: machineMirrorProbeScript(repo), encoding: "utf8"
    })).state, "unknown");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a failed first copy never publishes a partial project and retry stages a fresh copy", async () => {
  const options = { mirrorCopyError: "connection lost" as string | undefined };
  const h = harness(options);
  h.records.set("m1", { machineId: "m1", target: TARGET, ...LAYOUT });
  await assert.rejects(h.service.bootstrapProjectMirror({ machineId: "m1", localPath: process.cwd() }), /connection lost/);
  assert.ok(!h.calls.some(call => call.script.includes("mv -Tn --")));
  const cleanup = h.calls.find(call => call.script.startsWith(`rm -rf -- '${h.syncedUp[0]}';`));
  assert.ok(cleanup);
  // The project's folder goes too when the failed copy left it empty.
  const container = h.syncedUp[0].replace(/\/repo\.bootstrap-[^/]*$/, "");
  assert.ok(cleanup.script.endsWith(`rmdir -- '${container}' 2>/dev/null || true`), cleanup.script);
  options.mirrorCopyError = undefined;
  await h.service.bootstrapProjectMirror({ machineId: "m1", localPath: process.cwd() });
  assert.notEqual(h.syncedUp[0], h.syncedUp[1]);
  assert.ok(h.calls.some(call => call.script.includes("mv -Tn --")));
});

test("Stop during project copy reaches the transfer and never publishes its staged files", async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  const h = harness({ mirror: "path=/root/repo\nstate=absent\n", onMirrorCopy: async request => {
    assert.equal(request.signal, controller.signal);
    await request.onProgress?.({ percent: 42 });
    controller.abort(new Error("cancelled"));
  } });
  h.records.set("m1", { machineId: "m1", target: TARGET, ...LAYOUT });
  await assert.rejects(h.service.bootstrapProjectMirror({ machineId: "m1", localPath: process.cwd() }, controller.signal,
    message => messages.push(message)), /cancelled/);
  assert.ok(messages.some(message => message.includes("42%")));
  assert.ok(!h.calls.some(call => call.script.includes("mv -Tn --")));
  const cleanup = h.calls.find(call => call.script.startsWith(`rm -rf -- '${h.syncedUp[0]}';`));
  assert.ok(cleanup);
  assert.equal(cleanup.signal, undefined, "cleanup must run even with an aborted request");
  assert.ok(h.calls.filter(call => call !== cleanup).every(call => call.signal === controller.signal));
});
