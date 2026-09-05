import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function dryRun(target, env = {}, args = []) {
  return execFileSync(process.execPath, ["scripts/release-mac-arm64.mjs", target, "--dry-run", ...args], {
    cwd: rootDir,
    env: { ...process.env, RELEASE_REPO: "", ...env },
    encoding: "utf8"
  });
}

function failedDryRun(target, env = {}, args = []) {
  try {
    dryRun(target, env, args);
  } catch (error) {
    assert.equal(error.status, 1);
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.fail("Expected dry-run to fail.");
}

test("stable dry-run uses the stable release repo", () => {
  const output = dryRun("patch");

  assert.match(output, /Release target: patch/);
  assert.match(output, /Release channel: stable/);
  assert.match(output, /Source branch: main/);
  assert.match(output, /Release repo: juliakrivchikova\/AccordAgents-Releases/);
  assert.match(output, /GitHub Release state: published/);
  assert.match(output, /Update check: enabled against release repo/);
});

test("beta dry-run rejects the stable release repo override", () => {
  const output = failedDryRun("beta", {
    RELEASE_REPO: "juliakrivchikova/AccordAgents-Releases"
  });

  assert.match(output, /Beta releases must not target the stable release repo juliakrivchikova\/AccordAgents-Releases/);
});

test("beta dry-run uses the beta release repo and a normal published release", () => {
  const output = dryRun("beta", { RELEASE_BRANCH: "main" });

  assert.match(output, /Release target: beta/);
  assert.match(output, /Release channel: beta/);
  assert.match(output, /Source branch: beta/);
  assert.match(output, /Release repo: juliakrivchikova\/AccordAgents-Beta-Releases/);
  assert.match(output, /Next version: \d+\.\d+\.\d+-beta\.\d+/);
  assert.match(output, /GitHub Release state: published/);
  assert.match(output, /Update check: enabled against release repo/);
});

test("release branch cannot be overridden from the command line", () => {
  assert.match(failedDryRun("beta", {}, ["--branch", "main"]), /Unknown option: --branch/);
  assert.match(failedDryRun("beta", {}, ["--branch=main"]), /Unknown option: --branch=main/);
});
