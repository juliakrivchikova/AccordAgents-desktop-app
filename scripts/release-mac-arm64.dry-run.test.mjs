import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");

function dryRun(target) {
  return execFileSync(process.execPath, ["scripts/release-mac-arm64.mjs", target, "--dry-run", "--branch", "main"], {
    cwd: rootDir,
    env: { ...process.env, RELEASE_REPO: "" },
    encoding: "utf8"
  });
}

test("stable dry-run uses the stable release repo", () => {
  const output = dryRun("patch");

  assert.match(output, /Release target: patch/);
  assert.match(output, /Release channel: stable/);
  assert.match(output, /Release repo: juliakrivchikova\/AccordAgents-Releases/);
  assert.match(output, /GitHub Release state: published/);
  assert.match(output, /Update check: enabled against release repo/);
});

test("beta dry-run uses the beta release repo and a normal published release", () => {
  const output = dryRun("beta");

  assert.match(output, /Release target: beta/);
  assert.match(output, /Release channel: beta/);
  assert.match(output, /Release repo: juliakrivchikova\/AccordAgents-Beta-Releases/);
  assert.match(output, /Next version: \d+\.\d+\.\d+-beta\.1/);
  assert.match(output, /GitHub Release state: published/);
  assert.match(output, /Update check: enabled against release repo/);
});
