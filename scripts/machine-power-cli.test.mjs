// The machine CLI's setup-only power commands, run from the built bundle the
// installer copies to the machine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const bundle = new URL("../dist/machine/accordagents-machine.cjs", import.meta.url).pathname;
const run = (args, input = "") => spawnSync(process.execPath, [bundle, ...args], { input, encoding: "utf8" });

test("configure and revert cannot be combined", () => {
  const result = run(["--configure-power", "--revert-power", "--user-data", "/nonexistent"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined/);
});

test("reverting with nothing to put back leaves the machine as it is", () => {
  const dir = mkdtempSync(join(tmpdir(), "accord-machine-revert-"));
  try {
    const result = run(["--revert-power", "--user-data", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Machine power reverted\./);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the help names both setup-only power commands", () => {
  const result = run(["--help"]);
  assert.match(result.stdout, /--configure-power/);
  assert.match(result.stdout, /--revert-power/);
});
