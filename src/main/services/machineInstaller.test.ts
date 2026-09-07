import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CloudRunWorkerDoctorReport } from "../../shared/types";
import type { MachineInstallRecord, MachineInstallSnapshot, MachineSshTarget } from "../../shared/machineInstall";
import {
  MachineInstallerService,
  compareVersions,
  readMachineBundle,
  releaseName,
  versionFence,
  redactKeyLikeText,
  type MachineSshExecRequest
} from "./machineInstaller";
import {
  machineDrainScript,
  machineInstallLayout,
  machineMirrorProbeScript,
  machineProbeScript,
  machineServiceUnit,
  parseMachineDrainReport,
  parseMachineMirrorProbe,
  parseMachineProbe,
  writeFileFromStdinScript
} from "./machineInstallScripts";

const TARGET: MachineSshTarget = { host: "198.51.100.10", user: "ubuntu", identityFile: "/tmp/key.pem" };
const ENROLLMENT = JSON.stringify({ purpose: "machine-host", relayUrl: "wss://relay.example", key: "SUPER-SECRET-RELAY-KEY" });

const LAYOUT = machineInstallLayout({
  installRoot: "/home/ubuntu/accordagents-machine",
  userDataDir: "/home/ubuntu/.accordagents/machine",
  serviceName: "accordagents-machine",
  serviceScope: "system"
});

function probeOutput(overrides: Record<string, string | undefined> = {}, releases: string[] = []): string {
  const base: Record<string, string | undefined> = {
    home: "/home/ubuntu",
    "install-root": "/home/ubuntu/accordagents-machine",
    "user-data": "/home/ubuntu/.accordagents/machine",
    "service-name": "accordagents-machine",
    node: "v22.11.0",
    sqlite3: "ok",
    git: "ok",
    rsync: "ok",
    npm: "ok",
    systemd: "ok",
    sudo: "ok",
    "login-path": "/home/ubuntu/.npm-global/bin:/usr/bin:/bin",
    "node-path": "/usr/bin/node",
    enrollment: "absent",
    "service-state": "absent",
    "runtime-pids": "",
    "supervisor-pids": "",
    "provider-pids": "",
    ...overrides
  };
  const lines = Object.entries(base)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  for (const release of releases) lines.push(`release=${release}`);
  return `${lines.join("\n")}\n`;
}

function bundleFixture(version = "1.4.0"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "machine-bundle-"));
  fs.writeFileSync(path.join(dir, "accordagents-machine.cjs"), "#!/usr/bin/env node\n// runtime\n");
  fs.writeFileSync(path.join(dir, "nativeProcessSupervisor.cjs"), "// supervisor\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "accordagents-machine", version }));
  fs.mkdirSync(path.join(dir, "appSkills", "accord"), { recursive: true });
  fs.writeFileSync(path.join(dir, "appSkills", "accord", "SKILL.md"), "# accord\n");
  writePayloadManifest(dir, version);
  return dir;
}

/** The same manifest `scripts/build-machine-bundle.mjs` writes. */
function writePayloadManifest(dir: string, version: string): void {
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === "node_modules" || (!prefix && entry.name === "payload.json")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) {
        const contents = fs.readFileSync(full);
        files.push({ path: relative, bytes: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") });
      }
    }
  };
  walk(dir, "");
  fs.writeFileSync(path.join(dir, "payload.json"), JSON.stringify({ manifestVersion: 1, version, files }, null, 2));
}

interface Harness {
  service: MachineInstallerService;
  calls: MachineSshExecRequest[];
  uploads: Array<{ remoteDir: string }>;
  records: Map<string, MachineInstallRecord>;
  progress: MachineInstallSnapshot[];
  logged: Array<Record<string, unknown>>;
  syncedUp: string[];
  doctorCalls: Array<{ call: string; options?: { requiredProviderKind?: string } }>;
  waitedVersion: () => string | undefined;
}

function harness(options: {
  probe?: string;
  probeAfter?: string;
  dependenciesFail?: string;
  drain?: string;
  connected?: boolean;
  mirror?: string;
  bundleDir?: string;
  doctor?: CloudRunWorkerDoctorReport;
} = {}): Harness {
  const calls: MachineSshExecRequest[] = [];
  const uploads: Array<{ remoteDir: string }> = [];
  const records = new Map<string, MachineInstallRecord>();
  const progress: MachineInstallSnapshot[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const syncedUp: string[] = [];
  let activated = false;
  const doctorCalls: Array<{ call: string; options?: { requiredProviderKind?: string } }> = [];
  let waitedForVersion: string | undefined;
  const bundleDir = options.bundleDir ?? bundleFixture();
  const activeReleaseAfter = releaseName(readMachineBundle(bundleDir));
  const report = options.doctor ?? { ok: true, message: "Machine ready.", checks: [] };
  const service = new MachineInstallerService({
    store: {
      async getMachineInstall(machineId) { return records.get(machineId); },
      async saveMachineInstall(record) { records.set(record.machineId, record); },
      async listMachineInstalls() { return [...records.values()]; }
    },
    doctor: {
      async diagnose(_settings, doctorOptions) { doctorCalls.push({ call: "diagnose", options: doctorOptions }); return report; },
      async setup(_settings, onProgress, doctorOptions) {
        doctorCalls.push({ call: "setup", options: doctorOptions });
        onProgress?.({ stage: "codex-auth", message: "Approve the Codex sign-in on the machine…", authUrl: "https://auth.example/device", authCode: "ABCD-1234" });
        return options.doctor ?? { ok: true, message: "Machine ready.", checks: [] };
      }
    },
    getEnrollmentJson: async () => ENROLLMENT,
    waitForConnected: async (_machineId, _timeoutMs, expectAppVersion) => {
      waitedForVersion = expectAppVersion;
      return options.connected !== false;
    },
    payload: { dir: bundleDir, source: "checkout" },
    machineName: async () => "cloud-box",
    now: () => new Date("2026-09-07T00:00:00.000Z"),
    logger: (event, payload) => logged.push({ event, ...payload }),
    sshExec: async (request) => {
      calls.push(request);
      if (request.script.includes("mv -Tf")) activated = true;
      if (request.script.includes("printf 'home=%s")) {
        if (activated) {
          return options.probeAfter ?? probeOutput({
            state: JSON.stringify({ version: "1.4.0", digest: "new" }),
            "active-release": activeReleaseAfter ?? "",
            enrollment: "present",
            "service-scope": "system",
            "service-state": "active"
          });
        }
        return options.probe ?? probeOutput();
      }
      if (request.script.includes("printf 'drained=")) return options.drain ?? "drained=yes\nruntime-pids=\nsupervisor-pids=\nprovider-pids=\n";
      if (options.dependenciesFail && request.script.includes("npm install")) throw new Error(options.dependenciesFail);
      if (request.script.includes("journalctl")) return "machine.service: failed to start\n";
      if (request.script.includes("git -C")) return options.mirror ?? "path=/x\nstate=absent\n";
      return "";
    },
    uploadBundle: async (request) => { uploads.push({ remoteDir: request.remoteDir }); },
    mirrorSync: {
      async syncUp(request) { syncedUp.push(request.remotePath); },
      async syncDown() { throw new Error("syncDown must never run during a machine install."); }
    }
  });
  return { service, calls, uploads, records, progress, logged, syncedUp, doctorCalls, waitedVersion: () => waitedForVersion };
}

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

test("a damaged install-state file reads as an unknown version, never as none", () => {
  const probe = parseMachineProbe(probeOutput({ state: "{not json" }));
  assert.equal(probe.installedVersion, undefined);
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

test("no script removes the machine's user data, enrollment or a worktree", () => {
  const scripts = [
    machineProbeScript({}),
    machineDrainScript(LAYOUT),
    machineMirrorProbeScript("/home/ubuntu/accordagents-machine/workspace/mirrors/p/repo"),
    writeFileFromStdinScript(LAYOUT.enrollmentPath, "600")
  ];
  for (const script of scripts) {
    assert.ok(!/\brm\b/.test(script), `a setup script must not remove anything: ${script.slice(0, 80)}`);
  }
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

test("the version fence refuses an older runtime unless the User allows it", () => {
  const bundle = { dir: "/x", version: "1.2.0", digest: "d", files: 1, bytes: 1 };
  assert.ok(versionFence("upgrade", { installedVersion: "1.3.0" }, bundle, false));
  assert.equal(versionFence("upgrade", { installedVersion: "1.3.0" }, bundle, true), undefined);
  assert.equal(versionFence("upgrade", { installedVersion: "1.1.0" }, bundle, false), undefined);
  assert.equal(versionFence("install", {}, bundle, false), undefined);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
});

test("a beta is older than its release, so upgrading off a beta is not a downgrade", () => {
  assert.equal(compareVersions("1.10.4", "1.10.4-beta.2"), 1);
  assert.equal(compareVersions("1.10.4-beta.2", "1.10.4"), -1);
  assert.equal(compareVersions("1.10.4-beta.3", "1.10.4-beta.2"), 1);
  assert.equal(compareVersions("1.10.4-beta.2", "1.10.4-beta.2"), 0);
  assert.equal(compareVersions("1.11.0-beta.1", "1.10.4"), 1);
  const bundle = { dir: "/x", version: "1.10.4", digest: "d", files: 1, bytes: 1 };
  assert.equal(versionFence("upgrade", { installedVersion: "1.10.4-beta.2" }, bundle, false), undefined);
  assert.ok(versionFence("upgrade", { installedVersion: "1.10.4" }, { ...bundle, version: "1.10.4-beta.2" }, false));
});

test("a payload without the native supervisor is refused", () => {
  const dir = bundleFixture();
  fs.rmSync(path.join(dir, "nativeProcessSupervisor.cjs"));
  assert.throws(() => readMachineBundle(dir), /nativeProcessSupervisor/);
  assert.throws(() => readMachineBundle(path.join(dir, "nope")), /payload is missing/);
});

test("a packaged app that lost its payload says to reinstall, not to run a build", () => {
  const missing = path.join(bundleFixture(), "nope");
  assert.throws(
    () => readMachineBundle(missing, { source: "packaged" }),
    /This copy of AccordAgents is incomplete; reinstall it/
  );
  assert.throws(() => readMachineBundle(missing, { source: "checkout" }), /npm run build:machine/);
});

test("a corrupt payload is refused before it can reach a machine", () => {
  const truncated = bundleFixture();
  fs.writeFileSync(path.join(truncated, "accordagents-machine.cjs"), "#!/usr/bin/env node\n");
  assert.throws(() => readMachineBundle(truncated), /damaged: accordagents-machine\.cjs does not match the build/);

  const extra = bundleFixture();
  fs.writeFileSync(path.join(extra, "sneaked-in.js"), "// not from the build\n");
  assert.throws(() => readMachineBundle(extra), /files the build did not produce \(sneaked-in\.js\)/);

  const removed = bundleFixture();
  fs.rmSync(path.join(removed, "appSkills", "accord", "SKILL.md"));
  assert.throws(() => readMachineBundle(removed), /missing appSkills\/accord\/SKILL\.md/);

  const noManifest = bundleFixture();
  fs.rmSync(path.join(noManifest, "payload.json"));
  assert.throws(() => readMachineBundle(noManifest), /has no payload\.json/);

  const badManifest = bundleFixture();
  fs.writeFileSync(path.join(badManifest, "payload.json"), "{ not json");
  assert.throws(() => readMachineBundle(badManifest), /manifest .* could not be read/);

  const oldManifest = bundleFixture();
  fs.writeFileSync(path.join(oldManifest, "payload.json"), JSON.stringify({ manifestVersion: 9, version: "1.4.0", files: [] }));
  assert.throws(() => readMachineBundle(oldManifest), /not one this version understands/);
});

test("a payload that contains a symbolic link is refused, not silently skipped", () => {
  // Reproduced on a real machine before this guard existed: both the bundler
  // and the reader skipped links, so they never reached the manifest or the
  // digest — while `rsync -a` copied them, and appSkills/escape.md resolved to
  // /etc/hosts on the machine.
  const dir = bundleFixture();
  fs.symlinkSync("accordagents-machine.cjs", path.join(dir, "alias.cjs"));
  assert.throws(
    () => readMachineBundle(dir),
    /contains alias\.cjs, which is a symbolic link[\s\S]*only contain regular files and directories/
  );

  const nested = bundleFixture();
  fs.symlinkSync("../../../../etc/hosts", path.join(nested, "appSkills", "accord", "escape.md"));
  assert.throws(() => readMachineBundle(nested), /appSkills\/accord\/escape\.md, which is a symbolic link/);

  const pipe = bundleFixture();
  execFileSync("mkfifo", [path.join(pipe, "pipe")]);
  assert.throws(() => readMachineBundle(pipe), /which is a named pipe/);

  // A link the manifest does not mention must not slip through by being added
  // after the build either: the reader refuses before it compares anything.
  const packaged = bundleFixture();
  fs.symlinkSync("/etc/hosts", path.join(packaged, "late.md"));
  assert.throws(() => readMachineBundle(packaged, { source: "packaged" }), /reinstall it from the release you downloaded/);
});

test("a payload built for another version of the desktop is refused", () => {
  const dir = bundleFixture("1.4.0");
  assert.equal(readMachineBundle(dir, { expectVersion: "1.4.0" }).version, "1.4.0");
  assert.throws(
    () => readMachineBundle(dir, { expectVersion: "1.5.0" }),
    /This desktop is 1\.5\.0 but its machine runtime payload is 1\.4\.0/
  );
  // A manifest that disagrees with the payload's own package.json is a build
  // that was assembled from two different runs.
  const mixed = bundleFixture("1.4.0");
  const manifest = JSON.parse(fs.readFileSync(path.join(mixed, "payload.json"), "utf8"));
  fs.writeFileSync(path.join(mixed, "payload.json"), JSON.stringify({ ...manifest, version: "1.3.0" }));
  assert.throws(() => readMachineBundle(mixed), /inconsistent: its manifest says 1\.3\.0 and its package\.json says 1\.4\.0/);
});

test("the payload the Machines screen shows names its size, version and source", () => {
  const h = harness();
  const info = h.service.readPayload();
  assert.equal(info.ok, true);
  if (info.ok) {
    assert.equal(info.version, "1.4.0");
    assert.equal(info.source, "checkout");
    assert.equal(info.files, 4);
    assert.ok(info.bytes > 0);
    assert.equal(info.digest.length, 64);
  }
  const broken = new MachineInstallerService({
    store: { async getMachineInstall() { return undefined; }, async saveMachineInstall() { }, async listMachineInstalls() { return []; } },
    doctor: { async diagnose() { return { ok: true, message: "", checks: [] }; }, async setup() { return { ok: true, message: "", checks: [] }; } },
    getEnrollmentJson: async () => "",
    waitForConnected: async () => true,
    payload: { dir: "/does/not/exist", source: "packaged" }
  });
  const failure = broken.readPayload();
  assert.equal(failure.ok, false);
  if (!failure.ok) {
    assert.match(failure.message, /reinstall it/);
    assert.equal(failure.source, "packaged");
  }
});

test("the release name changes when the payload content changes", () => {
  const dir = bundleFixture();
  const first = releaseName(readMachineBundle(dir));
  // A different build: new content AND the manifest that build wrote.
  fs.writeFileSync(path.join(dir, "accordagents-machine.cjs"), "// different\n");
  writePayloadManifest(dir, "1.4.0");
  const second = readMachineBundle(dir);
  assert.notEqual(first, releaseName(second));
  // The manifest is excluded from the digest, so re-writing an identical
  // manifest never renames a release on a machine.
  writePayloadManifest(dir, "1.4.0");
  assert.equal(releaseName(readMachineBundle(dir)), releaseName(second));
});

// ---- install / upgrade ----------------------------------------------------

test("install walks the visible phases and ends connected", async () => {
  const h = harness();
  const phases: string[] = [];
  const result = await h.service.install(
    { machineId: "m1", operationId: "op1", target: TARGET },
    (snapshot) => phases.push(snapshot.phase)
  );
  assert.deepEqual(phases, ["preflight", "bundle", "transfer", "dependencies", "enroll", "drain", "activate", "service", "starting", "verify", "ready"]);
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(result.record.installedVersion, "1.4.0");
  assert.equal(h.uploads.length, 1);
  assert.ok(h.uploads[0].remoteDir.includes("/releases/1.4.0-"));
  assert.deepEqual(result.snapshot.completed.includes("verify"), true);
  assert.equal(h.waitedVersion(), "1.4.0", "the hello must be required to report the new version");
});

test("even a first install proves nothing is running before it switches version", async () => {
  const h = harness();
  await h.service.install({ machineId: "m1", operationId: "op1", target: TARGET });
  const drainIndex = h.calls.findIndex((call) => call.script.includes("printf 'drained="));
  const activateIndex = h.calls.findIndex((call) => call.script.includes("mv -Tf"));
  assert.ok(drainIndex >= 0, "the drain must run even when the probe found nothing running");
  assert.ok(drainIndex < activateIndex, "the drain must come before the version switch");
});

test("a machine that connects but still runs the old release is not reported ready", async () => {
  const h = harness({
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active"
    }, ["1.3.0-old"]),
    // The unit failed to restart: the old process is still the one connected.
    probeAfter: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active"
    }, ["1.3.0-old"])
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op9", target: TARGET });
  assert.equal(result.snapshot.phase, "needs-attention");
  assert.equal(result.snapshot.recovery?.kind, "rolled-back");
  assert.notEqual(result.record.installedVersion, "1.4.0");
});

test("a machine that cannot compile node-pty fails with a message that says so", async () => {
  const h = harness({ dependenciesFail: "gyp ERR! build error" });
  const result = await h.service.install({ machineId: "m1", operationId: "op10", target: TARGET });
  assert.equal(result.snapshot.phase, "error");
  assert.match(result.snapshot.error ?? "", /build tools \(python3, make, a C\+\+ compiler\)/);
  assert.match(result.snapshot.error ?? "", /gyp ERR/);
  assert.equal(result.snapshot.recovery?.kind, "old-runtime-still-installed");
  assert.ok(!h.calls.some((call) => call.script.includes("mv -Tf")), "nothing may be switched");
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
  assert.ok(probeCall.script.includes('SVC="$SVC_DEFAULT"'));
  assert.ok(probeCall.script.includes('ROOT="$HOME/accordagents-installer-qa"'));
});

test("the chosen provider must be installed and signed in on the machine itself", async () => {
  const h = harness({ doctor: { ok: false, message: "Codex is not signed in on the machine.", checks: [] } });
  const seen: Array<{ authUrl?: string; authCode?: string }> = [];
  const result = await h.service.install(
    { machineId: "m1", operationId: "op-auth", target: TARGET, requiredProvider: "codex-cli" },
    (snapshot) => { if (snapshot.authUrl) seen.push({ authUrl: snapshot.authUrl, authCode: snapshot.authCode }); }
  );
  assert.deepEqual(h.doctorCalls.map((call) => call.options?.requiredProviderKind), ["codex-cli", "codex-cli"]);
  // The sign-in happens ON the machine: the desktop only relays the URL and
  // code, and never copies a credential of its own.
  assert.deepEqual(seen, [{ authUrl: "https://auth.example/device", authCode: "ABCD-1234" }]);
  assert.equal(result.snapshot.phase, "error");
  assert.equal(result.snapshot.recovery?.kind, "nothing-changed");
  assert.equal(h.uploads.length, 0);
});

test("the enrollment travels on stdin and never reaches a command line or a log", async () => {
  const h = harness();
  await h.service.install({ machineId: "m1", operationId: "op1", target: TARGET });
  const enrollCall = h.calls.find((call) => call.input === ENROLLMENT);
  assert.ok(enrollCall, "the enrollment must be written from stdin");
  assert.ok(enrollCall.script.includes("cat > "));
  assert.ok(enrollCall.script.includes("chmod 600"));
  for (const call of h.calls) {
    assert.ok(!call.script.includes("SUPER-SECRET-RELAY-KEY"), "no script may contain the relay key");
  }
  assert.ok(!JSON.stringify(h.logged).includes("SUPER-SECRET-RELAY-KEY"));
  assert.ok(!JSON.stringify([...h.records.values()]).includes("SUPER-SECRET-RELAY-KEY"));
});

test("an upgrade that cannot prove the old runtime is gone replaces nothing", async () => {
  const h = harness({
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old",
      enrollment: "present",
      "service-scope": "system",
      "service-state": "active",
      "runtime-pids": "4210",
      "supervisor-pids": "4300"
    }, ["1.3.0-old"]),
    // Observed on a real machine: the unit stops, and only then does the
    // drain find a process this install owns that will not exit.
    drain: "service-state=inactive\nruntime-pids=4210\nsupervisor-pids=4300\nprovider-pids=4400\ndrained=no\n"
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op2", target: TARGET });
  assert.equal(result.snapshot.phase, "needs-attention");
  assert.equal(result.snapshot.recovery?.kind, "manual-drain-required");
  assert.deepEqual(result.snapshot.recovery?.blockingPids, [4210, 4300, 4400]);
  assert.equal(result.snapshot.recovery?.activeVersion, "1.3.0");
  // The drain stopped the unit before it found the stray process. Saying "the
  // machine keeps working" there would be a lie: it is down, on purpose.
  assert.match(result.snapshot.recovery?.detail ?? "", /has deliberately NOT been started again/);
  assert.match(result.snapshot.recovery?.detail ?? "", /hosts no members until that is resolved/);
  assert.ok(!h.calls.some((call) => call.script.includes("mv -Tf")), "the release must not be switched");
  assert.ok(!h.calls.some((call) => call.script.includes("daemon-reload")), "the service must not be rewritten");
  assert.equal(result.record.installedVersion, "1.3.0");
  assert.ok(!result.snapshot.completed.includes("drain"));
});

test("a refused drain on a machine that is still running says so instead", async () => {
  const h = harness({
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active",
      "runtime-pids": "4210"
    }, ["1.3.0-old"]),
    drain: "service-state=active\nruntime-pids=4210\ndrained=no\n"
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-drain2", target: TARGET });
  assert.equal(result.snapshot.recovery?.kind, "manual-drain-required");
  assert.match(result.snapshot.recovery?.detail ?? "", /The runtime is still running\./);
});

test("an upgrade that does not connect is rolled back to the previous release", async () => {
  const h = harness({
    connected: false,
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old",
      enrollment: "present",
      "service-scope": "system",
      "service-state": "active",
      "runtime-pids": "4210"
    }, ["1.3.0-old"])
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op3", target: TARGET });
  assert.equal(result.snapshot.phase, "needs-attention");
  assert.equal(result.snapshot.recovery?.kind, "rolled-back");
  assert.equal(result.snapshot.recovery?.activeVersion, "1.3.0");
  assert.ok(result.snapshot.recovery?.serviceLog?.includes("failed to start"));
  const activations = h.calls.filter((call) => call.script.includes("mv -Tf"));
  assert.equal(activations.length, 2);
  assert.ok(activations[1].script.includes("1.3.0-old"), "the previous release must be restored");
  assert.notEqual(result.record.installedVersion, "1.4.0");
});

test("an upgrade keeps the enrollment that is already on the machine", async () => {
  const h = harness({
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active"
    }, ["1.3.0-old"])
  });
  await h.service.upgrade({ machineId: "m1", operationId: "op4", target: TARGET });
  assert.ok(!h.calls.some((call) => call.input === ENROLLMENT), "an upgrade must not re-pair the machine");
});

test("re-installing the same bundle on a running machine changes nothing", async () => {
  const dir = bundleFixture();
  const digest = readMachineBundle(dir).digest;
  const h = harness({
    bundleDir: dir,
    probe: probeOutput({
      state: JSON.stringify({ version: "1.4.0", digest }),
      "active-release": `1.4.0-${digest.slice(0, 12)}`,
      enrollment: "present", "service-scope": "system", "service-state": "active"
    })
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op5", target: TARGET });
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(h.uploads.length, 0);
  assert.ok(!h.calls.some((call) => call.script.includes("drained=")), "a no-op upgrade must not stop the machine");
});

test("a machine missing Node 20 is refused before anything is copied", async () => {
  const h = harness({ probe: probeOutput({ node: "v18.19.0" }) });
  const result = await h.service.install({ machineId: "m1", operationId: "op6", target: TARGET });
  assert.equal(result.snapshot.phase, "error");
  assert.match(result.snapshot.error ?? "", /Node 20\+/);
  assert.equal(result.snapshot.recovery?.kind, "nothing-changed");
  assert.equal(h.uploads.length, 0);
});

test("two installs of one machine share a single operation", async () => {
  const h = harness();
  const first = h.service.install({ machineId: "m1", operationId: "op7", target: TARGET });
  const second = h.service.install({ machineId: "m1", operationId: "op7", target: TARGET });
  assert.equal(await first, await second);
  assert.equal(h.uploads.length, 1);
});

test("an interrupted setup is offered for retry, never resumed silently", async () => {
  const h = harness();
  h.records.set("m1", {
    machineId: "m1", target: TARGET, installRoot: "/home/ubuntu/accordagents-machine",
    userDataDir: "/home/ubuntu/.accordagents/machine", serviceName: "accordagents-machine", serviceScope: "system",
    installedVersion: "1.3.0",
    lastOperation: {
      machineId: "m1", operationId: "op8", kind: "upgrade", phase: "transfer", message: "Copying…",
      updatedAt: "2026-09-06T00:00:00.000Z", completed: ["preflight", "bundle"]
    }
  });
  await h.service.recoverInterruptedOperation();
  const record = h.records.get("m1");
  assert.equal(record?.lastOperation?.phase, "needs-attention");
  assert.equal(record?.lastOperation?.recovery?.kind, "old-runtime-still-installed");
  assert.equal(record?.lastOperation?.retryable, true);
  assert.equal(h.calls.length, 0, "recovery must not touch the machine");
});

test("a key-shaped run in the service log is not written into settings", () => {
  const key = "k".repeat(48);
  const redacted = redactKeyLikeText(`relaySealKeyBase64=${key} and hash ${"a".repeat(64)}`);
  assert.ok(!redacted.includes(key));
  assert.ok(!redacted.includes("a".repeat(64)));
  assert.ok(redacted.includes("[redacted]"));
  assert.equal(redactKeyLikeText("machine.service: failed to start"), "machine.service: failed to start");
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
  assert.match(h.syncedUp[0], /\/workspace\/mirrors\/.+\/repo$/);
});
