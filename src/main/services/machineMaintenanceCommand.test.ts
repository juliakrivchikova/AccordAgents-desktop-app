import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { machineMaintenanceCommand } from "./machineMaintenanceCommand";
import { withMachineRsyncPath } from "./machineMaintenanceRsync";
import { shellQuotePosix } from "./cloudRunWorkers";

test("the actual rsync client transfers through the maintenance wrapper", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maintenance-rsync-"));
  try {
    const source = path.join(dir, "source");
    const destination = path.join(dir, "destination");
    await mkdir(source); await mkdir(destination);
    await writeFile(path.join(source, "payload.txt"), "runtime payload\n");
    // SSH's transport is replaced with a local shell; rsync itself still builds
    // and tokenizes --rsync-path. Passing a command straight to sh misses
    // macOS rsync stripping the quotes before SSH joins its arguments.
    const ssh = path.join(dir, "ssh.sh");
    await writeFile(ssh, 'shift\nexec /bin/sh -c "$*"\n');
    let wrapperPath = "";
    await withMachineRsyncPath({ runtimePath: path.join(dir, "missing.cjs"), userDataDir: path.join(dir, "profile") }, run,
      async wrapper => {
        wrapperPath = wrapper!;
        await new Promise<void>((resolve, reject) => execFile("rsync", ["-a", "--rsync-path", wrapper!,
          "-e", `/bin/sh ${shellQuotePosix(ssh)}`, `${source}/`, `qa-host:${destination}/`],
          { timeout: 10_000 }, error => error ? reject(error) : resolve()));
      });
    assert.equal(await readFile(path.join(destination, "payload.txt"), "utf8"), "runtime payload\n");
    await assert.rejects(readFile(wrapperPath), /ENOENT/);
    await assert.rejects(withMachineRsyncPath({ runtimePath: path.join(dir, "missing.cjs"), userDataDir: path.join(dir, "profile") }, run,
      async wrapper => { wrapperPath = wrapper!; throw new Error("cancelled transfer"); }), /cancelled transfer/);
    await assert.rejects(readFile(wrapperPath), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("guarded setup keeps payload on stdin and preserves rsync server arguments", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maintenance-command-"));
  try {
    const runtime = path.join(dir, "runtime.cjs");
    await writeFile(runtime, "let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),input})))");
    await writeFile(path.join(dir, "maintenance-v1"), "1\n");
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
    await assert.rejects(run(command), /cannot protect its idle stop during maintenance/);
    await writeFile(path.join(data, "accordagents.sqlite3"), "broken sqlite bytes");
    await assert.rejects(run(command), /Command failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a release older than maintenance is refused, never started with the flag", async () => {
  // The old argument parser ignores unknown flags, so exec'ing it here would
  // start a SECOND runtime on this user-data directory instead of running the
  // wrapped command. The marker the payload ships is what distinguishes them.
  const dir = await mkdtemp(path.join(tmpdir(), "maintenance-old-release-"));
  try {
    const data = path.join(dir, "profile"); await mkdir(data);
    const runtime = path.join(dir, "runtime.cjs");
    await writeFile(runtime, "console.log('OLD RUNTIME STARTED')");
    const target = { runtimePath: runtime, userDataDir: data };
    await run(`sqlite3 ${shellQuotePosix(path.join(data, "accordagents.sqlite3"))} 'create table machine_power_state(singleton);insert into machine_power_state values(1);'`);
    const command = machineMaintenanceCommand(target, "printf SHOULD_NOT_RUN");
    await assert.rejects(run(command), /cannot protect its idle stop during maintenance/);

    // The same release with the marker is used normally.
    await writeFile(path.join(dir, "maintenance-v1"), "1\n");
    await writeFile(runtime, "process.stdout.write('WRAPPED ' + process.argv.slice(2).join(' '))");
    assert.match(await run(machineMaintenanceCommand(target, "printf ignored")), /^WRAPPED --maintenance --user-data /);

    // A newly staged release wraps the upgrade even while the installed one is
    // still the old, unmarked release.
    const staged = path.join(dir, "staged"); await mkdir(staged);
    await writeFile(path.join(staged, "accordagents-machine.cjs"), "process.stdout.write('STAGED ' + process.argv.slice(2).join(' '))");
    await writeFile(path.join(staged, "maintenance-v1"), "1\n");
    const stagedCommand = machineMaintenanceCommand(
      { runtimePath: path.join(staged, "accordagents-machine.cjs"), userDataDir: data, capabilityPath: path.join(staged, "maintenance-v1") },
      "printf ignored"
    );
    assert.match(await run(stagedCommand), /^STAGED --maintenance --user-data /);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function run(command: string, input = "", env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("/bin/sh", ["-c", command], { env }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end(input);
  });
}
