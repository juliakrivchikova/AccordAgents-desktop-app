import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WhisperServerEngine } from "./whisperServer";

interface FakeOptions {
  /** How long "loading the model" takes before it listens. */
  loadMs?: number;
  /** How long each recognition takes. */
  inferMs?: number;
  /** Exits instead of loading. */
  fail?: boolean;
  /** Answers recognition with this status instead of text. */
  inferStatus?: number;
  /** Ignores the polite stop. */
  ignoreTerm?: boolean;
}

/** Stands in for whisper.cpp's server: same flags, same routes, on the socket it is given. */
function fakeServer(log: string, options: FakeOptions): string {
  return `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
const o = ${JSON.stringify(options)};
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const socket = flag("--host").replace(/^unix:/, "");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, socket, model: flag("-m"), language: flag("-l"), beam: flag("-bs"), bestOf: flag("-bo") }) + "\\n");
if (o.ignoreTerm) process.on("SIGTERM", () => {});
if (o.fail) { console.error("error: failed to load model"); process.exit(3); }
setTimeout(() => {
  http.createServer((req, res) => {
    if (req.url === "/health") { res.end('{"status":"ok"}'); return; }
    if (req.method === "POST" && req.url === "/inference") {
      const chunks = [];
      req.on("data", (chunk) => { chunks.push(chunk); });
      req.on("end", () => setTimeout(() => {
        if (o.inferStatus) { res.statusCode = o.inferStatus; res.end('{"error":"no"}'); return; }
        const body = Buffer.concat(chunks).toString("latin1");
        const field = (name) => { const m = new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)').exec(body); return m ? Buffer.from(m[1], "latin1").toString("utf8") : undefined; };
        const prompt = field("prompt");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          text: " heard " + body.length + (prompt ? " after " + prompt : "")
            + " as " + field("response_format") + (field("no_language_probabilities") === "true" ? " without odds" : "") + "\\n",
          format: field("response_format"),
          language: field("language") || "russian"
        }));
      }, o.inferMs || 0));
      return;
    }
    res.statusCode = 404;
    res.end("not here");
  }).listen(socket);
}, o.loadMs || 0);
`;
}

interface Started { pid: number; socket: string; model: string; language: string; beam: string; bestOf: string }

async function setup(options: FakeOptions = {}): Promise<{ dir: string; server: string; started: () => Promise<Started[]>; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "whisper-server-test-"));
  const server = path.join(dir, "whisper-server");
  const log = path.join(dir, "started.jsonl");
  await writeFile(server, fakeServer(log, options));
  await chmod(server, 0o755);
  await writeFile(log, "");
  const started = async (): Promise<Started[]> =>
    (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Started);
  return {
    dir,
    server,
    started,
    cleanup: async () => {
      for (const entry of await started()) {
        if (alive(entry.pid)) process.kill(entry.pid, "SIGKILL");
        // An app killed outright leaves its socket folder for the next start.
        await rm(path.dirname(entry.socket), { recursive: true, force: true });
      }
      await rm(dir, { recursive: true, force: true });
    }
  };
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
  const t = await setup({ loadMs: 300 });
  const engine = new WhisperServerEngine({ serverPath: t.server, modelPath: "/models/m.bin", idleMs: 60_000 });
  try {
    const loading = Promise.all([engine.prepare(), engine.prepare()]);
    assert.equal(engine.isWarm(), false, "not warm while loading");
    await loading;
    assert.equal(engine.isWarm(), true);
    assert.match((await engine.transcribe(WAV, 5_000)).text, /heard \d+/);
    assert.match((await engine.transcribe(WAV, 5_000)).text, /heard \d+/);
    const started = await t.started();
    assert.equal(started.length, 1);
    assert.equal(started[0]!.model, "/models/m.bin");
    assert.equal(started[0]!.language, "auto");
    // The same decoding whisper-cli used before.
    assert.equal(started[0]!.beam, "5");
    assert.equal(started[0]!.bestOf, "5");
  } finally {
    await engine.stop("test");
    await t.cleanup();
  }
});

test("the engine listens only in a folder her user alone can open, and it is removed after", async () => {
  const t = await setup();
  const engine = new WhisperServerEngine({ serverPath: t.server, modelPath: "/m.bin", idleMs: 60_000 });
  try {
    await engine.prepare();
    const [started] = await t.started();
    const folder = path.dirname(started!.socket);
    assert.equal((await stat(folder)).mode & 0o777, 0o700);
    await engine.stop("test");
    await assert.rejects(stat(folder));
  } finally {
    await engine.stop("test");
    await t.cleanup();
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
    await t.cleanup();
  }
});

test("the idle countdown never ends a load or a recognition in progress", async () => {
  const slowLoad = await setup({ loadMs: 700 });
  const loading = new WhisperServerEngine({ serverPath: slowLoad.server, modelPath: "/m.bin", idleMs: 200 });
  const slowInfer = await setup({ inferMs: 700 });
  const recognizing = new WhisperServerEngine({ serverPath: slowInfer.server, modelPath: "/m.bin", idleMs: 200 });
  try {
    assert.match((await loading.transcribe(WAV, 5_000)).text, /heard/);
    assert.equal((await slowLoad.started()).length, 1);
    assert.match((await recognizing.transcribe(WAV, 5_000)).text, /heard/);
    assert.equal((await slowInfer.started()).length, 1);
  } finally {
    await loading.stop("test");
    await recognizing.stop("test");
    await slowLoad.cleanup();
    await slowInfer.cleanup();
  }
});

test("turning it off stops the engine at once, even while it is still loading", async () => {
  const t = await setup({ loadMs: 2_000 });
  const engine = new WhisperServerEngine({ serverPath: t.server, modelPath: "/m.bin", idleMs: 60_000 });
  try {
    const early = assert.rejects(engine.prepare());
    await engine.stop("turned-off");
    await early;
    const later = assert.rejects(engine.prepare());
    await until(async () => (await t.started()).length > 0);
    await engine.stop("turned-off");
    await later;
    for (const entry of await t.started()) await until(() => !alive(entry.pid), 2_000);
    assert.equal(engine.isWarm(), false);
  } finally {
    await engine.stop("test");
    await t.cleanup();
  }
});

test("an engine that ignores the request to stop is killed", async () => {
  const t = await setup({ ignoreTerm: true });
  const engine = new WhisperServerEngine({ serverPath: t.server, modelPath: "/m.bin", idleMs: 60_000, stopGraceMs: 300 });
  try {
    await engine.prepare();
    const [started] = await t.started();
    const before = Date.now();
    await engine.stop("turned-off");
    await until(() => !alive(started!.pid), 2_000);
    assert.ok(Date.now() - before < 2_000);
  } finally {
    await t.cleanup();
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
    assert.match((await engine.transcribe(WAV, 5_000)).text, /heard/);
    assert.equal((await t.started()).length, 2);
  } finally {
    await engine.stop("test");
    await t.cleanup();
  }
});

test("a broken or hung engine is replaced; a refused recording keeps the loaded model", async () => {
  const broken = await setup({ inferStatus: 500 });
  const brokenEngine = new WhisperServerEngine({ serverPath: broken.server, modelPath: "/m.bin", idleMs: 60_000 });
  const hung = await setup({ inferMs: 5_000 });
  const hungEngine = new WhisperServerEngine({ serverPath: hung.server, modelPath: "/m.bin", idleMs: 60_000 });
  const refusing = await setup({ inferStatus: 400 });
  const refusingEngine = new WhisperServerEngine({ serverPath: refusing.server, modelPath: "/m.bin", idleMs: 60_000 });
  try {
    await assert.rejects(brokenEngine.transcribe(WAV, 5_000), /answered 500/);
    const [brokenPid] = await broken.started();
    await until(() => !alive(brokenPid!.pid));
    await assert.rejects(hungEngine.transcribe(WAV, 300), /did not answer/);
    const [hungPid] = await hung.started();
    await until(() => !alive(hungPid!.pid));
    await assert.rejects(refusingEngine.transcribe(WAV, 5_000), /answered 400/);
    assert.equal(refusingEngine.isWarm(), true);
  } finally {
    await brokenEngine.stop("test");
    await hungEngine.stop("test");
    await refusingEngine.stop("test");
    await broken.cleanup();
    await hung.cleanup();
    await refusing.cleanup();
  }
});

test("a model that cannot load, or loads too slowly, is reported instead of waited on", async () => {
  const failing = await setup({ fail: true });
  const failingEngine = new WhisperServerEngine({ serverPath: failing.server, modelPath: "/m.bin", idleMs: 60_000 });
  const slow = await setup({ loadMs: 5_000 });
  const slowEngine = new WhisperServerEngine({ serverPath: slow.server, modelPath: "/m.bin", idleMs: 60_000, readyTimeoutMs: 400 });
  try {
    await assert.rejects(failingEngine.prepare(), /stopped while loading/);
    assert.equal(failingEngine.isWarm(), false);
    await assert.rejects(slowEngine.prepare(), /too long/);
    const [started] = await slow.started();
    await until(() => !alive(started!.pid));
  } finally {
    await failingEngine.stop("test");
    await slowEngine.stop("test");
    await failing.cleanup();
    await slow.cleanup();
  }
});

/** A stand-in for the app: it loads the model, says so, then is killed outright. */
async function appThatDies(serverPath: string): Promise<void> {
  const app = spawn(process.execPath, ["-e", `
    const { WhisperServerEngine } = require(${JSON.stringify(path.join(__dirname, "whisperServer.js"))});
    const engine = new WhisperServerEngine({ serverPath: ${JSON.stringify(serverPath)}, modelPath: "/m.bin", idleMs: 600000 });
    engine.prepare().then(() => { process.stdout.write("ready\\n"); setInterval(() => {}, 1000); }, (error) => { console.error(error); process.exit(1); });
  `], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the stand-in app never got ready")), 10_000);
      app.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      app.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the stand-in app exited (${code})`));
      });
    });
  } finally {
    app.kill("SIGKILL");
  }
}

test("when the app dies without stopping it, the engine does not stay in memory", async () => {
  const polite = await setup();
  const stubborn = await setup({ ignoreTerm: true });
  try {
    await appThatDies(polite.server);
    const [politePid] = await polite.started();
    await until(() => !alive(politePid!.pid), 3_000);
    // One that ignores the request to stop is killed a few seconds later.
    await appThatDies(stubborn.server);
    const [stubbornPid] = await stubborn.started();
    await until(() => !alive(stubbornPid!.pid), 6_000);
  } finally {
    await polite.cleanup();
    await stubborn.cleanup();
  }
});

test("a piece of a long recording is sent with the text and the language before it", async () => {
  const t = await setup();
  const engine = new WhisperServerEngine({ serverPath: t.server, modelPath: "/m.bin", idleMs: 60_000 });
  try {
    const first = await engine.transcribe(WAV, 5_000);
    assert.doesNotMatch(first.text, /after/);
    assert.match(first.text, /as verbose_json without odds/, "the language comes back without the cost of every language's odds");
    const piece = await engine.transcribe(WAV, 5_000, { prompt: "Привет, мир.", language: "english" });
    assert.match(piece.text, /after Привет, мир\./);
    assert.equal(piece.language, "english", "the first piece's language is kept for the rest");
    assert.equal((await engine.transcribe(WAV, 5_000)).language, "russian", "the language heard comes back");
  } finally {
    await engine.stop("test");
    await t.cleanup();
  }
});
