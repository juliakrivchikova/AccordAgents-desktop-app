import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WhisperServerEngine } from "./whisperServer";

/** Stands in for whisper.cpp's server: same flags, same routes, a load delay. */
const FAKE_SERVER = `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const port = Number(flag("--port"));
const base = flag("--request-path");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, port, base, model: flag("-m"), language: flag("-l") }) + "\\n");
if (process.env.FAKE_FAIL) { console.error("error: failed to load model"); process.exit(3); }
setTimeout(() => {
  http.createServer((req, res) => {
    if (req.url === base + "/health") { res.end('{"status":"ok"}'); return; }
    if (req.method === "POST" && req.url === base + "/inference") {
      let bytes = 0;
      req.on("data", (chunk) => { bytes += chunk.length; });
      req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: " heard " + bytes + "\\n" })); });
      return;
    }
    res.statusCode = 404;
    res.end("not here");
  }).listen(port, "127.0.0.1");
}, Number(process.env.FAKE_LOAD_MS || 0));
`;

interface Started { pid: number; port: number; base: string; model: string; language: string }

async function setup(env: Record<string, string> = {}): Promise<{ dir: string; server: string; log: string; started: () => Promise<Started[]> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "whisper-server-test-"));
  const server = path.join(dir, "whisper-server");
  const log = path.join(dir, "started.jsonl");
  await writeFile(server, FAKE_SERVER);
  await chmod(server, 0o755);
  await writeFile(log, "");
  process.env.FAKE_LOG = log;
  delete process.env.FAKE_FAIL;
  process.env.FAKE_LOAD_MS = "0";
  Object.assign(process.env, env);
  const started = async (): Promise<Started[]> => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Started);
  return { dir, server, log, started };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const WAV = new Uint8Array(1_000);

test("the model is loaded once while she speaks, and later phrases reuse it", async () => {
  const t = await setup({ FAKE_LOAD_MS: "300" });
  const engine = new WhisperServerEngine({ serverPath: t.server, modelPath: "/models/m.bin", idleMs: 60_000 });
  try {
    await Promise.all([engine.prepare(), engine.prepare()]);
    assert.equal(engine.isWarm(), true);
    assert.match(await engine.transcribe(WAV, 5_000), /heard \d+/);
    assert.match(await engine.transcribe(WAV, 5_000), /heard \d+/);
    const started = await t.started();
    assert.equal(started.length, 1);
    assert.equal(started[0]!.model, "/models/m.bin");
    assert.equal(started[0]!.language, "auto");
  } finally {
    await engine.stop("test");
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("only the app knows the engine's address: without its secret path nothing answers", async () => {
  const t = await setup();
  const engine = new WhisperServerEngine({ serverPath: t.server, modelPath: "/m.bin", idleMs: 60_000 });
  try {
    await engine.prepare();
    const [started] = await t.started();
    assert.ok(started!.base.length > 40, "a long random path");
    const guessed = await fetch(`http://127.0.0.1:${started!.port}/health`);
    assert.equal(guessed.status, 404);
    const other = await fetch(`http://127.0.0.1:${started!.port}/inference`, { method: "POST", body: "x" });
    assert.equal(other.status, 404);
  } finally {
    await engine.stop("test");
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("ten idle minutes (here, a moment) free the memory, and the next phrase loads it again", async () => {
  const t = await setup();
  const engine = new WhisperServerEngine({ serverPath: t.server, modelPath: "/m.bin", idleMs: 300 });
  try {
    await engine.transcribe(WAV, 5_000);
    const [first] = await t.started();
    await until(() => !alive(first!.pid));
    assert.equal(engine.isWarm(), false);
    await engine.transcribe(WAV, 5_000);
    const started = await t.started();
    assert.equal(started.length, 2);
    assert.ok(alive(started[1]!.pid));
  } finally {
    await engine.stop("test");
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("turning it off stops the engine at once", async () => {
  const t = await setup();
  const engine = new WhisperServerEngine({ serverPath: t.server, modelPath: "/m.bin", idleMs: 60_000 });
  try {
    await engine.prepare();
    const [started] = await t.started();
    await engine.stop("turned-off");
    await until(() => !alive(started!.pid), 1_000);
  } finally {
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("an engine that dies is started again for the next phrase", async () => {
  const t = await setup();
  const engine = new WhisperServerEngine({ serverPath: t.server, modelPath: "/m.bin", idleMs: 60_000 });
  try {
    await engine.prepare();
    const [first] = await t.started();
    process.kill(first!.pid, "SIGKILL");
    await until(() => !engine.isWarm());
    assert.match(await engine.transcribe(WAV, 5_000), /heard/);
    assert.equal((await t.started()).length, 2);
  } finally {
    await engine.stop("test");
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("a model that cannot load is reported instead of waited on", async () => {
  const t = await setup({ FAKE_FAIL: "1" });
  const engine = new WhisperServerEngine({ serverPath: t.server, modelPath: "/m.bin", idleMs: 60_000 });
  try {
    await assert.rejects(engine.prepare(), /stopped while loading/);
    assert.equal(engine.isWarm(), false);
  } finally {
    await engine.stop("test");
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("when the app dies without stopping it, the engine does not stay in memory", async () => {
  const t = await setup();
  // A stand-in for the app: it loads the model, then is killed outright.
  const app = spawn(process.execPath, ["-e", `
    const { WhisperServerEngine } = require(${JSON.stringify(path.join(__dirname, "whisperServer.js"))});
    const engine = new WhisperServerEngine({ serverPath: ${JSON.stringify(t.server)}, modelPath: "/m.bin", idleMs: 600000 });
    engine.prepare().then(() => { process.stdout.write("ready\\n"); setInterval(() => {}, 1000); });
  `], { stdio: ["ignore", "pipe", "inherit"], env: process.env });
  try {
    await new Promise<void>((resolve) => app.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("ready")) resolve(); }));
    const [started] = await t.started();
    assert.ok(alive(started!.pid));
    app.kill("SIGKILL");
    await until(() => !alive(started!.pid), 3_000);
  } finally {
    app.kill("SIGKILL");
    await rm(t.dir, { recursive: true, force: true });
  }
});
