import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { nativeHostIdentity, verifiedNativeHostReboot } from "./nativeHostIdentity";
import { confirmNativeProcessClosed, spawnNativeProcess } from "./nativeProcess";
import { NativeProcessRegistry } from "./nativeProcessRegistry";
import { hasLiveCapturedPosixProcesses, readPosixProcessTableAsync, terminateCapturedPosixProcesses } from "./processTermination";

test("resident execution owns one process generation, preserves stdio, and records verified closure", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const child = await spawnNativeProcess(f.options);
    let output = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    child.on("error", () => undefined);
    const receipt = (await f.registry.get("chat:member"))!;
    assert.equal(receipt.phase, "running");
    assert.equal(receipt.provider?.pid, child.pid);
    assert.notEqual(receipt.supervisor.pid, child.pid);
    child.stdin.write("HELLO_NATIVE\n");
    await eventually(() => output.includes("HELLO_NATIVE"));
    await assert.rejects(spawnNativeProcess(f.options), /already has|owned by another/);
    await confirmNativeProcessClosed(child);
    assert.equal((await f.registry.get("chat:member"))?.phase, "closed");
    const next = await spawnNativeProcess(f.options);
    assert.equal((await f.registry.get("chat:member"))?.generation, receipt.generation + 1);
    await confirmNativeProcessClosed(next);
  } finally { await f.close(); }
});

test("an app crash leaves the guardian alive to close detached provider work before a replacement starts", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const f = await fixture();
  const modulePath = path.join(__dirname, "nativeProcess.js");
  const pidPath = path.join(f.directory, "background.pid");
  const provider = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    writeFileSync(${JSON.stringify(pidPath)},String(child.pid)); process.stdin.resume(); setInterval(()=>{},1000);`;
  const script = path.join(f.directory, "controller.cjs");
  await writeFile(script, `require(${JSON.stringify(modulePath)}).spawnNativeProcess(${JSON.stringify({ ...f.options, args: ["-e", provider] })}).then(()=>process.send('ready'),e=>{process.send({error:e.message});process.exit(1)});`);
  const parent = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    await new Promise<void>((resolve, reject) => {
      parent.once("message", (message) => { if (message === "ready") resolve(); else reject(new Error(JSON.stringify(message))); });
      parent.once("exit", (code) => reject(new Error(`Controller exited: ${code}`)));
    });
    const receipt = (await f.registry.get("chat:member"))!;
    await eventually(async () => Boolean((await f.registry.get("chat:member"))?.descendants.length));
    const childPid = Number(await readFile(pidPath, "utf8"));
    parent.kill("SIGKILL");
    // A replacement may arrive while its predecessor's guardian is still
    // terminating descendants. It must wait for that receipt, not a TTL.
    const replacement = await spawnNativeProcess(f.options);
    const rows = await readPosixProcessTableAsync();
    assert.ok(rows);
    assert.equal(rows.get(childPid)?.state?.startsWith("Z") ?? !rows.has(childPid), true);
    assert.equal(hasLiveCapturedPosixProcesses([receipt.provider!], () => rows), false);
    assert.equal((await f.registry.get("chat:member"))?.generation, receipt.generation + 1);
    await confirmNativeProcessClosed(replacement);
  } finally { parent.kill("SIGKILL"); await f.close(); }
});

test("failed ownership writes admit no provider input and a later recovery cannot steal a newer generation", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    await sql(f.options.dbPath, "create trigger disk_full before insert on native_provider_processes begin select raise(abort,'SQLITE_FULL'); end;");
    await assert.rejects(spawnNativeProcess(f.options), /SQLITE_FULL/);
    assert.equal(await f.registry.get("chat:member"), undefined);
    await sql(f.options.dbPath, "drop trigger disk_full;");
    const child = await spawnNativeProcess(f.options);
    const original = (await f.registry.get("chat:member"))!;
    await confirmNativeProcessClosed(child);
    const next = await spawnNativeProcess(f.options);
    await assert.rejects(f.registry.update({ ...original, phase: "closed" }), /lease changed/);
    assert.equal((await f.registry.get("chat:member"))?.phase, "running");
    await confirmNativeProcessClosed(next);
  } finally { await f.close(); }
});

test("a lost guardian cannot be mistaken for confirmed termination or silently replaced", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const child = await spawnNativeProcess(f.options);
    child.on("error", () => undefined);
    const receipt = (await f.registry.get("chat:member"))!;
    process.kill(receipt.supervisor.pid, "SIGKILL");
    await assert.rejects(confirmNativeProcessClosed(child), /without a stored shutdown receipt/);
    await assert.rejects(spawnNativeProcess(f.options), /owned by another|before confirming shutdown/);
    assert.equal((await f.registry.get("chat:member"))?.generation, receipt.generation);
  } finally { await f.close(); }
});

test("a large final provider record drains before close and disk failure retains process ownership", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const bytes = 5 * 1024 * 1024;
    const child = await spawnNativeProcess({ ...f.options, args: ["-e", `process.stdin.once('data',()=>process.stdout.write('x'.repeat(${bytes}),()=>process.exit(0)))`] });
    let seen = 0;
    child.stdout.on("data", (data) => { seen += data.length; });
    child.stdin.write("go");
    await new Promise((resolve) => child.once("close", resolve));
    assert.equal(seen, bytes);
    const next = await spawnNativeProcess(f.options);
    next.on("error", () => undefined);
    await sql(f.options.dbPath, "create trigger close_full before update on native_provider_processes when new.phase='closed' begin select raise(abort,'SQLITE_FULL'); end;");
    let confirmed = false;
    const closing = confirmNativeProcessClosed(next).then(() => { confirmed = true; });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(confirmed, false);
    assert.notEqual((await f.registry.get("chat:member"))?.phase, "closed");
    await assert.rejects(spawnNativeProcess(f.options), /owned by another/);
    await sql(f.options.dbPath, "drop trigger close_full;");
    await closing;
    assert.equal((await f.registry.get("chat:member"))?.phase, "closed");
  } finally { await f.close(); }
});

test("several sessions share a guardian while output backpressure and Stop stay scoped to one provider", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  const children = [];
  try {
    const slow = await spawnNativeProcess({ ...f.options, scope: "slow", args: ["-e", "process.stdin.once('data',()=>process.stdout.write('x'.repeat(5*1024*1024)));process.stdin.resume()"] });
    children.push(slow);
    const live = await spawnNativeProcess({ ...f.options, scope: "live" });
    children.push(live);
    assert.equal((await f.registry.get("slow"))?.supervisor.pid, (await f.registry.get("live"))?.supervisor.pid);
    slow.stdin.write("go"); // Intentionally do not consume its large output yet.
    let received = "";
    live.stdout.on("data", (data) => { received += data.toString(); });
    live.stdin.write("INDEPENDENT_SESSION\n");
    await eventually(() => received.includes("INDEPENDENT_SESSION"));
    slow.stdout.resume();
    await confirmNativeProcessClosed(slow);
    live.stdin.write("STILL_ALIVE\n");
    await eventually(() => received.includes("STILL_ALIVE"));
    assert.equal((await f.registry.get("live"))?.phase, "running");
  } finally { await Promise.all(children.map(confirmNativeProcessClosed)); await f.close(); }
});

test("a 41 MB native input crosses bounded stdin chunks without entering the process registry", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  let child;
  try {
    child = await spawnNativeProcess({ ...f.options, args: ["-e", "const h=require('node:crypto').createHash('sha256');process.stdin.on('data',d=>h.update(d));process.stdin.on('end',()=>process.stdout.write(h.digest('hex')))"] });
    const input = Buffer.alloc(42_047_781, 120);
    let output = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    const exited = new Promise((resolve) => child!.once("close", resolve));
    child.stdin.end(input);
    await exited;
    assert.equal(output, createHash("sha256").update(input).digest("hex"));
    assert.ok(Buffer.byteLength(JSON.stringify(await f.registry.get("chat:member"))) < 2048);
  } finally { if (child) await confirmNativeProcessClosed(child); await f.close(); }
});

test("only a different kernel boot on the same OS host proves a previous process cannot survive", async () => {
  const current = await nativeHostIdentity();
  if (process.platform === "darwin" || process.platform === "linux") assert.ok(current, "the supported native host exposes a stable OS identity");
  const previous = { machine: "a".repeat(64), boot: "11111111-1111-1111-1111-111111111111" };
  assert.equal(verifiedNativeHostReboot(previous, { ...previous }), false);
  assert.equal(verifiedNativeHostReboot(previous, { ...previous, boot: "22222222-2222-2222-2222-222222222222" }), true);
  assert.equal(verifiedNativeHostReboot(previous, { machine: "b".repeat(64), boot: "22222222-2222-2222-2222-222222222222" }), false);
  assert.equal(verifiedNativeHostReboot(previous, undefined), false);
});

test("the provider cannot start before its receipt commits, and a fast startup failure releases its session", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const marker = path.join(f.directory, "provider-started");
    await sql(f.options.dbPath, "create trigger admission_full before update on native_provider_processes when new.phase='running' begin select raise(abort,'SQLITE_FULL'); end;");
    await assert.rejects(spawnNativeProcess({ ...f.options, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`] }), /SQLITE_FULL/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    await sql(f.options.dbPath, "drop trigger admission_full;");
    await eventually(async () => (await f.registry.get("chat:member"))?.phase === "closed");
    const failed = await spawnNativeProcess({ ...f.options, command: "/bin/false", args: [] });
    await confirmNativeProcessClosed(failed);
    const next = await spawnNativeProcess(f.options);
    await confirmNativeProcessClosed(next);
    assert.equal((await f.registry.get("chat:member"))?.phase, "closed");
  } finally { await f.close(); }
});

test("synchronous and asynchronous spawn rejections close the acquired lease before another attempt", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    for (const cwd of ["invalid\u0000directory", path.join(f.directory, "missing-directory")]) {
      await assert.rejects(spawnNativeProcess({ ...f.options, cwd }), /null bytes|ENOENT/);
      await eventually(async () => (await f.registry.get("chat:member"))?.phase === "closed");
      const next = await spawnNativeProcess(f.options);
      await confirmNativeProcessClosed(next);
    }
    assert.equal((await f.registry.get("chat:member"))?.generation, 4);
  } finally { await f.close(); }
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-native-process-"));
  const dbPath = path.join(directory, "native-processes.sqlite3");
  const registry = new NativeProcessRegistry(dbPath);
  await registry.init();
  return {
    directory, registry,
    options: { scope: "chat:member", dbPath, command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], env: { PATH: process.env.PATH } },
    close: async () => {
      const receipt = await registry.get("chat:member");
      if (receipt && receipt.phase !== "closed") {
        const rows = await readPosixProcessTableAsync();
        if (rows) terminateCapturedPosixProcesses([...(receipt.provider ? [receipt.provider] : []), ...receipt.descendants, receipt.supervisor], "SIGKILL", () => rows);
      }
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  assert.fail("Condition did not become true before timeout.");
}

function sql(dbPath: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("sqlite3", ["-cmd", ".timeout 5000", dbPath], (error) => error ? reject(error) : resolve());
    child.stdin!.end(input);
  });
}
