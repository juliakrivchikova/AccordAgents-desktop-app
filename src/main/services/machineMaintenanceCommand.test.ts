import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { machineMaintenanceCommand } from "./machineMaintenanceCommand";
import { shellQuotePosix } from "./cloudRunWorkers";

test("guarded setup keeps payload on stdin and preserves rsync server arguments", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maintenance-command-"));
  try {
    const runtime = path.join(dir, "runtime.cjs");
    await writeFile(runtime, "let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),input})))");
    const target = { runtimePath: runtime, userDataDir: path.join(dir, "profile with space") };
    const command = machineMaintenanceCommand(target, `rsync --server ${shellQuotePosix("destination with space")}`);
    const secret = "QA_ONLY_ENROLLMENT_BODY";
    const result = JSON.parse(await run(command, secret));
    assert.deepEqual(result.args, ["--maintenance", "--user-data", path.join(dir, "profile with space"), "--", "rsync", "--server", "destination with space"]);
    assert.equal(result.input, secret);
    assert.equal(command.includes(secret), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("only an unconfigured first install can proceed without a runtime", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maintenance-first-install-"));
  try {
    const data = path.join(dir, "profile"); await mkdir(data);
    const target = { runtimePath: path.join(dir, "missing.cjs"), userDataDir: data };
    const command = machineMaintenanceCommand(target, "printf FIRST_INSTALL");
    assert.equal(await run(command), "FIRST_INSTALL");
    await run(`sqlite3 ${shellQuotePosix(path.join(data, "accordagents.sqlite3"))} 'create table machine_power_state(singleton);insert into machine_power_state values(1);'`);
    await assert.rejects(run(command), /installed runtime is unavailable/);
    await writeFile(path.join(data, "accordagents.sqlite3"), "broken sqlite bytes");
    await assert.rejects(run(command), /Command failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function run(command: string, input = "", env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("/bin/sh", ["-c", command], { env }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end(input);
  });
}
