import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentFuseWire, FuseV1Options } from "@electron/fuses";
import { FuseState } from "@electron/fuses/dist/constants.js";
import { createRequire } from "node:module";

const script = fileURLToPath(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function cleanupReceipt(dir) {
  let owned;
  try { owned = receipt(dir); } catch { return; } // Startup may not have created the DB.
  const { readPosixProcessTableSync, terminateCapturedPosixProcesses } = createRequire(import.meta.url)("../dist/main/main/services/processTermination.js");
  terminateCapturedPosixProcesses([...(owned.provider ? [owned.provider] : []), ...owned.descendants, owned.supervisor], "SIGKILL", readPosixProcessTableSync);
}

async function cleanup(child, dir) {
  if (!child.pid) return;
  if (child.connected) child.disconnect();
  await Promise.race([once(child, "exit"), delay(15000)]);
  if (child.exitCode === null && child.signalCode === null) {
    // Only our isolated receipt's still-matching identities may be killed.
    cleanupReceipt(dir);
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function launch(appPath, dir) {
  const child = spawn(path.join(appPath, "Contents/MacOS/AccordAgents"), ["--accordagents-native-supervisor"], {
    detached: true, serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      ACCORDAGENTS_USER_DATA_DIR: path.join(dir, "profile") }
  });
  child.stderr.resume();
  return child;
}

function start(child, dir) {
  child.send({ type: "start", id: "probe", scope: "packaged-launch-probe",
    dbPath: path.join(dir, "native.sqlite3"), sqliteExecutable: "/usr/bin/sqlite3",
    command: "/bin/cat", args: [], env: { PATH: process.env.PATH }, endInputWithoutStopping: true });
}

function receipt(dir) {
  const rows = JSON.parse(execFileSync("/usr/bin/sqlite3", ["-json", path.join(dir, "native.sqlite3"),
    "select receipt from native_provider_processes where scope='packaged-launch-probe'"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  return JSON.parse(rows[0].receipt);
}

async function until(check, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (check()) return; await delay(100); }
  throw new Error(`Packaged native process check timed out: ${label}`);
}

async function echoAndClose(appPath, dir) {
  const child = launch(appPath, dir);
  const input = Buffer.alloc(1024 * 1024, 0x73);
  const hash = createHash("sha256");
  let bytes = 0, offset = 0, sequence = 0;
  let timeout;
  const completion = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Packaged native supervisor did not complete within 25 seconds")), 25_000);
    const next = () => {
      if (offset === input.length) { child.send({ id: "probe", type: "inputEnd" }); return; }
      const data = input.subarray(offset, offset + 64 * 1024); offset += data.length;
      child.send({ id: "probe", type: "input", sequence: ++sequence, data });
    };
    child.on("error", reject);
    child.on("exit", code => reject(new Error(`Packaged supervisor exited before closure: ${code}`)));
    child.on("message", message => {
      if (message.type === "ready") next();
      else if (message.type === "inputAck") { if (message.error) reject(new Error(message.error)); else next(); }
      else if (message.type === "data") {
        if (!Buffer.isBuffer(message.data)) { reject(new Error("IPC did not preserve binary output")); return; }
        bytes += message.data.length; hash.update(message.data);
        child.send({ id: "probe", type: "outputAck", stream: message.stream, sequence: message.sequence });
      } else if (message.type === "closed") resolve();
      else if (message.type === "error" || message.type === "abandoned") reject(new Error(message.message || message.type));
    });
  });
  try {
    start(child, dir);
    await completion;
    assert.equal(bytes, input.length);
    assert.equal(hash.digest("hex"), createHash("sha256").update(input).digest("hex"));
    assert.equal(receipt(dir).phase, "closed");
    child.disconnect();
    await until(() => child.exitCode !== null || child.signalCode !== null, "supervisor exit after closure");
    assert.equal(child.exitCode, 0);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) await cleanup(child, dir);
  }
}

async function crashCleanup(appPath, dir) {
  // Kill the *controller*, not its guardian: this is the actual app-crash
  // contract. The detached packaged process must close its provider and receipt.
  const parent = spawn(process.execPath, [script, "--crash-controller", appPath, dir], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  let guardian;
  try {
    const timeout = setTimeout(() => parent.kill("SIGKILL"), 25_000);
    try { [guardian] = await Promise.race([once(parent, "message"), once(parent, "exit").then(() => { throw new Error("Crash controller exited before ready"); })]); }
    finally { clearTimeout(timeout); }
    assert.equal(guardian.type, "ready");
    const exited = once(parent, "exit"); parent.kill("SIGKILL"); await exited;
    await until(() => receipt(dir).phase === "closed", "durable closure after controller crash");
    await until(() => { try { process.kill(guardian.pid, 0); return false; } catch (e) { if (e.code === "ESRCH") return true; throw e; } }, "guardian exit after cleanup");
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
  }
}

export async function verifyPackagedNativeProcess(appPath) {
  const fuses = await getCurrentFuseWire(appPath);
  assert.equal(fuses[FuseV1Options.RunAsNode], FuseState.DISABLE, "RunAsNode must stay disabled");
  const dir = await mkdtemp(path.join(os.tmpdir(), "accord-packaged-native-"));
  try {
    await echoAndClose(appPath, dir);
    await crashCleanup(appPath, dir);
    await echoAndClose(appPath, dir); // same session can restart after durable closure
    console.log("Packaged native process PASS: binary IPC, durable closure, controller crash, restart; RunAsNode disabled");
  } catch (error) { cleanupReceipt(dir); throw error; }
  finally { await rm(dir, { recursive: true, force: true }); }
}

if (process.argv[1] === script) {
  if (process.argv[2] === "--crash-controller") {
    const child = launch(process.argv[3], process.argv[4]);
    child.on("message", message => { if (message.type === "ready") process.send({ type: "ready", pid: child.pid }); });
    child.on("error", () => process.exit(1));
    child.on("exit", () => process.exit(1));
    start(child, process.argv[4]);
  } else {
    if (!process.argv[2]) throw new Error("Usage: node scripts/verify-packaged-native-process.mjs /path/to/AccordAgents.app");
    await verifyPackagedNativeProcess(path.resolve(process.argv[2]));
  }
}
