import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The failure paths of the release launch check, driven by fake app bundles
// whose executable is a shell script. The passing path needs a real packaged
// app and is exercised by the release itself.

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(rootDir, "scripts", "smoke-launch-packaged-app.mjs");
const productName = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).productName;
const tempDirs = [];

test.after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeApp(body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "smoke-launch-test-"));
  tempDirs.push(dir);
  const app = path.join(dir, `${productName}.app`);
  const executable = path.join(app, "Contents", "MacOS", productName);
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, `#!/bin/sh\n${body}\n`);
  chmodSync(executable, 0o755);
  return app;
}

function smoke(args, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], {
      cwd: rootDir,
      env: { ...process.env, ...env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
  });
}

test("requires an app path", async () => {
  const result = await smoke([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL: Usage/);
});

test("rejects a flag where an option value belongs", async () => {
  const result = await smoke([fakeApp("exit 0"), "--screenshot", "--log"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing value for --screenshot/);
});

test("fails when the bundle has no executable", async () => {
  const result = await smoke([path.join(os.tmpdir(), "no-such-app.app")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No app executable at/);
});

test("fails when the app exits during launch and shows its output", async () => {
  const result = await smoke([fakeApp("echo 'Error: Cannot find module foo' >&2; exit 3")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exited during launch \(code 3/);
  assert.match(result.stderr, /Cannot find module foo/);
});

test("fails on an uncaught exception in the main process", async () => {
  const result = await smoke([fakeApp("echo 'A JavaScript error occurred in the main process' >&2; sleep 30")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /uncaught exception during launch/);
  assert.ok(result.ms < 20_000, `took ${result.ms}ms`);
});

test("does not wait for helpers that outlive a crashed app", async () => {
  const result = await smoke([fakeApp("sleep 30 & exit 3")]);
  assert.equal(result.status, 1);
  assert.ok(result.ms < 10_000, `took ${result.ms}ms`);
});

test("gives up when no window appears and stops the app", async () => {
  const marker = path.join(mkdtempSync(path.join(os.tmpdir(), "smoke-launch-marker-")), "alive");
  tempDirs.push(path.dirname(marker));
  const result = await smoke([fakeApp(`while true; do date > '${marker}'; sleep 0.2; done`)], { SMOKE_LAUNCH_TIMEOUT_MS: "1500" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`No ${productName} window appeared`));
  const before = readFileSync(marker, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(readFileSync(marker, "utf8"), before, "the app kept running after the check gave up");
});

test("does not pass this process's environment to the app", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "smoke-launch-env-"));
  tempDirs.push(dir);
  const dump = path.join(dir, "env");
  const result = await smoke([fakeApp(`env > '${dump}'; exit 3`)], { RELEASE_SECRET_PROBE: "must-not-leak" });
  assert.equal(result.status, 1);
  const env = readFileSync(dump, "utf8");
  assert.doesNotMatch(env, /RELEASE_SECRET_PROBE/);
  assert.match(env, /ACCORDAGENTS_USER_DATA_DIR=/);
  assert.match(env, /ACCORDAGENTS_CRASH_REPORTS=0/);
});
