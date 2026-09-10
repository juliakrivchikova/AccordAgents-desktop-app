import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { MachineMaintenance } from "./machineMaintenance";
import { StorageService } from "./storage";
import { nativeHostIdentity } from "./nativeHostIdentity";
import { NativeProcessRegistry } from "./nativeProcessRegistry";
import { hasLiveCapturedPosixProcesses, readPosixProcessTableAsync } from "./processTermination";

test("a completed maintenance command does not wait for its SSH peer to close stdin", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const f = await fixture();
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const chunks: Buffer[] = []; stdout.on("data", chunk => chunks.push(chunk)); stderr.resume();
  try {
    const result = f.maintenance.run({ command: process.execPath,
      args: ["-e", "process.stdin.once('data',data=>{process.stdout.write(data,()=>process.exit(0))})"],
      env: process.env, stdin, stdout, stderr });
    const payload = Buffer.from([0, 255, 254, 10, 128, 97]);
    stdin.write(payload); // A duplex protocol waits for the server to finish first.
    assert.equal(await Promise.race([result, new Promise((_, reject) => setTimeout(() => reject(new Error("maintenance waited for peer EOF")), 6000).unref())]), 0);
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.equal(await f.store.hasMaintenance(f.host.boot, 1000), false);
  } finally { stdin.end(); await f.close(); }
});

test("maintenance stdin EOF lets its command finish and idle waits for the guardian receipt", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    let text = "";
    const stdout = new PassThrough(); stdout.on("data", chunk => { text += chunk.toString(); });
    const stderr = new PassThrough(); stderr.resume();
    const result = f.maintenance.run({ command: process.execPath,
      args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>{console.log('INPUT_END');setTimeout(()=>console.log('DONE'),900)})"],
      env: process.env, stdin: Readable.from(["small setup script"]), stdout, stderr });
    await eventually(() => text.includes("INPUT_END"));
    assert.equal(await f.store.hasMaintenance(f.host.boot, 1000), true);
    assert.equal(await f.store.tryFence(f.host.boot, 1000, "unsafe-stop", 1), false);
    assert.equal(await result, 0);
    assert.equal(text, "INPUT_END\nDONE\n", "EOF did not apply the resident provider's 300 ms Stop deadline");
    assert.deepEqual(await f.registry.openLeases(), []);
    assert.equal(await f.store.hasMaintenance(f.host.boot, 1000), false);
    assert.equal((await f.store.read())?.idleSinceMs, null);
    assert.deepEqual(await f.store.maintenanceReceipts(), []);
  } finally { await f.close(); }
});

test("an SSH controller crash keeps the power hold until native descendant closure is proven", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const f = await fixture();
  let controller: ReturnType<typeof spawn> | undefined;
  try {
    const script = path.join(f.dir, "controller.cjs");
    await writeFile(script, `
      const {StorageService}=require(${JSON.stringify(path.join(__dirname, "storage.js"))});
      const {MachineMaintenance}=require(${JSON.stringify(path.join(__dirname, "machineMaintenance.js"))});
      const {Readable,PassThrough}=require('node:stream');
      const stdout=new PassThrough();stdout.on('data',d=>process.send({output:d.toString()}));
      const stderr=new PassThrough();stderr.resume();
      new MachineMaintenance(new StorageService({dbPath:${JSON.stringify(f.db)}}).machinePower(),${JSON.stringify(f.registry.dbPath)},${JSON.stringify(f.db)})
        .run({command:process.execPath,args:['-e',${JSON.stringify("const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log('READY');process.stdin.resume();setInterval(()=>{},1000)")}],
          env:process.env,stdin:Readable.from([]),stdout,stderr})
        .then(code=>process.exit(code),e=>{process.send({error:e.message});process.exit(1)});
    `);
    controller = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    await new Promise<void>((resolve, reject) => {
      controller!.on("message", (message: { output?: string; error?: string }) => {
        if (message.error) reject(new Error(message.error));
        if (message.output?.includes("READY")) resolve();
      });
      controller!.once("exit", code => reject(new Error(`Controller exited before readiness: ${code}`)));
    });
    const [receipt] = await f.store.maintenanceReceipts();
    assert.ok(receipt);
    await eventually(async () => Boolean((await f.registry.get(receipt.scope))?.descendants.length));
    const native = (await f.registry.get(receipt.scope))!;
    assert.equal(await f.store.hasMaintenance(f.host.boot, Number.MAX_SAFE_INTEGER), true, "time cannot expire live work");
    controller.kill("SIGKILL");
    await eventually(async () => (await f.registry.get(receipt.scope))?.phase === "closed");
    const rows = await readPosixProcessTableAsync(); assert.ok(rows);
    assert.equal(hasLiveCapturedPosixProcesses([native.provider!, ...native.descendants], () => rows), false);
    await eventually(async () => !await f.store.hasMaintenance(f.host.boot, 1000));
    await f.maintenance.recover(f.host);
    assert.equal(await f.store.hasMaintenance(f.host.boot, 1000), false);
  } finally { controller?.kill("SIGKILL"); await f.close(); }
});

test("a committed stop or failed admission write runs no maintenance command", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const marker = path.join(f.dir, "must-not-run");
    const run = () => {
      const stdout = new PassThrough(); stdout.resume(); const stderr = new PassThrough(); stderr.resume();
      return f.maintenance.run({ command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`], env: process.env,
        stdin: Readable.from([]), stdout, stderr });
    };
    await sql(f.db, "create trigger no_maintenance before insert on machine_maintenance_leases begin select raise(abort,'SQLITE_FULL'); end;");
    await assert.rejects(run(), /SQLITE_FULL/);
    await eventually(async () => !(await f.registry.openLeases()).length);
    assert.equal(existsSync(marker), false);
    await sql(f.db, "drop trigger no_maintenance;");
    assert.equal(await f.store.tryFence(f.host.boot, 1000, "stopping", 1), true);
    await assert.rejects(run(), /already stopping/);
    await eventually(async () => !(await f.registry.openLeases()).length);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(await f.store.maintenanceReceipts(), []);
  } finally { await f.close(); }
});

test("failed power-hold cleanup retains the stored native closure and retries only cleanup", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    await sql(f.db, "create trigger no_release before delete on machine_maintenance_leases begin select raise(abort,'SQLITE_FULL'); end;");
    const stdout = new PassThrough(); let output = ""; stdout.on("data", data => { output += data.toString(); });
    const stderr = new PassThrough(); stderr.resume();
    // Catch immediately: a guardian error may arrive before the polling below.
    const result = f.maintenance.run({ command: process.execPath, args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log('ONCE'))"],
      env: process.env, stdin: Readable.from([]), stdout, stderr }).then(() => undefined, error => error);
    await eventually(async () => (await f.store.maintenanceReceipts()).length === 1);
    const [receipt] = await f.store.maintenanceReceipts();
    await eventually(async () => (await f.registry.get(receipt.scope))?.phase === "closed");
    assert.equal(await f.store.hasMaintenance(f.host.boot, 1000), true);
    assert.equal(await f.store.tryFence(f.host.boot, 1000, "unsafe-stop", 1), false);
    await sql(f.db, "drop trigger no_release;");
    await f.maintenance.recover(f.host);
    await result;
    assert.equal(output, "ONCE\n");
    assert.equal(await f.store.hasMaintenance(f.host.boot, 1000), false);
  } finally { await f.close(); }
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "machine-maintenance-"));
  const host = await nativeHostIdentity(); assert.ok(host);
  const db = path.join(dir, "state.sqlite3");
  const store = new StorageService({ dbPath: db }).machinePower();
  await store.write({ version: 1, bootId: host.boot, idleSinceMs: 1 });
  const registry = new NativeProcessRegistry(path.join(dir, "native.sqlite3")); await registry.init();
  return { dir, db, store, host, registry, maintenance: new MachineMaintenance(store, registry.dbPath, db),
    close: () => rm(dir, { recursive: true, force: true }) };
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Maintenance lifecycle observation timed out.");
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

async function sql(dbPath: string, statement: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile("sqlite3", ["-batch", "-cmd", ".timeout 5000", dbPath], error => error ? reject(error) : resolve());
    child.stdin?.end(statement);
  });
}
