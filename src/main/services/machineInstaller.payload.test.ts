import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { MachineInstallerService, compareVersions, readMachineBundle, releaseName, versionFence } from "./machineInstaller";
import { machineInstallDependenciesScript } from "./machineInstallScripts";
import { bundleFixture, harness, LAYOUT, writePayloadManifest } from "./machineInstaller/test/installerFixtures";

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

test("a machine installs exactly the packages its release names, checked by their integrity hashes", () => {
  const script = machineInstallDependenciesScript(LAYOUT, "1.4.0-abc");
  assert.match(script, /if \[ -f npm-shrinkwrap\.json \]; then npm ci --omit=dev/, "a release with a lockfile is installed with npm ci");
  assert.match(script, /else npm install --omit=dev/, "a release from before still installs");
});
