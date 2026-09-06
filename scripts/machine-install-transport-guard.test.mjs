/**
 * Two guards that only fail on a real machine otherwise.
 *
 * 1. SSH stays out of messaging. Rule 1 of the cutover accord keeps every
 *    message, turn, approval and Stop on the relay; SSH exists for installing
 *    and upgrading a machine and for the one-time project mirror. If a chat,
 *    link or host module ever imports the installer, that rule has been broken
 *    in code and this test says so before a machine does.
 *
 * 2. The remote scripts parse. They are written on macOS and executed by a
 *    shell on Linux, so a quoting mistake would first show up mid-install on
 *    the User's machine. `bash -n` reads every generated variant here.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const MESSAGING_MODULES = [
  "src/main/services/chat.ts",
  "src/main/services/machineLink.ts",
  "src/main/services/machineHost.ts",
  "src/main/services/machineApprovalExecutor.ts",
  "src/machine/main.ts"
];

test("no messaging module reaches the SSH installer", () => {
  for (const relative of MESSAGING_MODULES) {
    const file = path.join(repoRoot, relative);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    assert.ok(
      !/from "\.\/machineInstaller"|from "\.\/machineInstallScripts"|machineInstaller"/.test(source),
      `${relative} must not import the machine installer: ordinary messaging never uses SSH.`
    );
  }
});

test("every generated remote script is valid shell", () => {
  const scripts = require(path.join(repoRoot, "dist/main/main/services/machineInstallScripts.js"));
  const layout = scripts.machineInstallLayout({
    installRoot: "/home/ubuntu/accordagents-machine",
    userDataDir: "/home/ubuntu/.accordagents/machine",
    serviceName: "accordagents-machine",
    serviceScope: "system"
  });
  const userLayout = { ...layout, serviceScope: "user" };
  const generated = [
    ["probe (defaults)", scripts.machineProbeScript({})],
    ["probe (explicit)", scripts.machineProbeScript({ installRoot: layout.installRoot, userDataDir: layout.userDataDir, serviceName: layout.serviceName })],
    ["prepare", scripts.machinePrepareDirectoriesScript(layout)],
    ["write enrollment", scripts.writeFileFromStdinScript(layout.enrollmentPath, "600")],
    ["dependencies", scripts.machineInstallDependenciesScript(layout, "1.4.0-abc")],
    ["activate", scripts.machineActivateReleaseScript(layout, "1.4.0-abc", { version: "1.4.0", digest: "abc", installedAt: "2026-09-07T00:00:00.000Z" })],
    ["service (system)", scripts.machineInstallServiceScript(layout, "ubuntu")],
    ["service (user)", scripts.machineInstallServiceScript(userLayout, "ubuntu")],
    ["start (system)", scripts.machineStartServiceScript(layout)],
    ["start (user)", scripts.machineStartServiceScript(userLayout)],
    ["log", scripts.machineServiceLogScript(layout)],
    ["drain (system)", scripts.machineDrainScript(layout)],
    ["drain (user)", scripts.machineDrainScript(userLayout)],
    ["mirror probe", scripts.machineMirrorProbeScript("/home/ubuntu/accordagents-machine/workspace/mirrors/p-1/repo")],
    // A path with a quote in it must not break out of the script.
    ["mirror probe (hostile path)", scripts.machineMirrorProbeScript("/home/ubuntu/it's a project/repo")]
  ];
  for (const [name, script] of generated) {
    try {
      execFileSync("bash", ["-n"], { input: script });
    } catch (error) {
      assert.fail(`${name} is not valid shell: ${error.stderr?.toString() ?? error.message}\n---\n${script}`);
    }
  }
});

test("a path with a quote in it cannot escape the script", () => {
  const scripts = require(path.join(repoRoot, "dist/main/main/services/machineInstallScripts.js"));
  const script = scripts.machineMirrorProbeScript("/tmp/x'; touch /tmp/pwned; echo '");
  assert.ok(!script.includes("touch /tmp/pwned;\n"), "injected command must stay inside a quoted string");
  execFileSync("bash", ["-n"], { input: script });
});
