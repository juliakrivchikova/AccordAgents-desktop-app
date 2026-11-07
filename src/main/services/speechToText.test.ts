import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SPEECH_MODEL_FILE, SPEECH_SAMPLE_RATE, encodeWavPcm16 } from "../../shared/speechToText";
import type { SpeechToTextState } from "../../shared/types";
import { SpeechToTextService, resolveSpeechEngine } from "./speechToText";

const MODEL = randomBytes(256 * 1024);
const MODEL_SHA = createHash("sha256").update(MODEL).digest("hex");

type ServeMode =
  | { kind: "normal" }
  | { kind: "ignore-range" }
  | { kind: "drop-after"; bytes: number }
  | { kind: "stall-after"; bytes: number }
  | { kind: "corrupt" }
  | { kind: "shifted-range" }
  | { kind: "status"; status: number };

interface ModelServer {
  url: string;
  requests: Array<{ range?: string }>;
  mode: ServeMode;
  close: () => Promise<void>;
}

async function startModelServer(): Promise<ModelServer> {
  const server: ModelServer = { url: "", requests: [], mode: { kind: "normal" }, close: async () => undefined };
  const sockets = new Set<import("node:net").Socket>();
  const httpServer = http.createServer((request, response) => {
    const range = request.headers.range;
    server.requests.push({ range });
    const mode = server.mode;
    if (mode.kind === "status") {
      response.writeHead(mode.status).end("no");
      return;
    }
    const body = mode.kind === "corrupt" ? Buffer.from(MODEL).fill(1, 0, 10) : MODEL;
    const match = /^bytes=(\d+)-$/.exec(range ?? "");
    let start = 0;
    if (match && mode.kind !== "ignore-range") {
      start = Number(match[1]);
      // A server that answers from somewhere other than where it was asked.
      const shown = mode.kind === "shifted-range" ? start + 1 : start;
      response.writeHead(206, {
        "content-length": String(body.length - start),
        "content-range": `bytes ${shown}-${body.length - 1}/${body.length}`
      });
    } else {
      response.writeHead(200, { "content-length": String(body.length) });
    }
    const rest = body.subarray(start);
    if (mode.kind === "drop-after") {
      response.write(rest.subarray(0, mode.bytes), () => {
        setTimeout(() => request.socket.destroy(), 20);
      });
      return;
    }
    if (mode.kind === "stall-after") {
      response.write(rest.subarray(0, mode.bytes));
      return;
    }
    response.end(rest);
  });
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  server.url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/model.bin`;
  server.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  return server;
}

/** Stands in for the warm whisper.cpp server; records what the service asks. */
class FakeEngine {
  prepared = 0;
  transcribed: Uint8Array[] = [];
  stops: string[] = [];
  warm = false;
  respond: (wav: Uint8Array) => Promise<string> = async () => " [BLANK_AUDIO]\n Привет, мир.\n Hello world.\n";
  constructor(readonly input: { serverPath: string; modelPath: string; idleMs: number }) {}
  isWarm(): boolean { return this.warm; }
  async prepare(): Promise<void> { this.prepared += 1; this.warm = true; }
  async transcribe(wav: Uint8Array): Promise<string> {
    this.transcribed.push(wav);
    this.warm = true;
    return this.respond(wav);
  }
  async stop(reason: string): Promise<void> { this.stops.push(reason); this.warm = false; }
}

interface Harness {
  dir: string;
  server: ModelServer;
  engines: FakeEngine[];
  service: SpeechToTextService;
  create: (overrides?: Partial<ConstructorParameters<typeof SpeechToTextService>[0]>) => SpeechToTextService;
  cleanup: () => Promise<void>;
}

async function harness(overrides: Partial<ConstructorParameters<typeof SpeechToTextService>[0]> = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), "speech-test-"));
  const server = await startModelServer();
  const engines: FakeEngine[] = [];
  const create = (more: Partial<ConstructorParameters<typeof SpeechToTextService>[0]> = {}): SpeechToTextService =>
    new SpeechToTextService({
      dir: path.join(dir, "speech-to-text"),
      engine: () => ({ path: "/fake/whisper-server" }),
      fetch: (url, init) => fetch(url, init),
      model: { url: server.url, bytes: MODEL.length, sha256: MODEL_SHA },
      freeBytes: async () => 100 * 1024 * 1024 * 1024,
      progressIntervalMs: 0,
      stallMs: 5_000,
      createEngine: (input) => {
        const engine = new FakeEngine(input);
        engines.push(engine);
        return engine;
      },
      ...overrides,
      ...more
    });
  return {
    dir,
    server,
    engines,
    service: create(),
    create,
    cleanup: async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function settle(service: SpeechToTextService, done: (state: SpeechToTextState) => boolean): Promise<SpeechToTextState> {
  const current = await service.getState();
  if (done(current)) return current;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("speech state did not settle")), 10_000);
    const stop = service.onState((state) => {
      if (!done(state)) return;
      clearTimeout(timer);
      stop();
      resolve(state);
    });
  });
}

const notBusy = (state: SpeechToTextState): boolean => state.status !== "downloading" && state.status !== "verifying";

/** A recording with sound in it (a quiet tone), so it is sent to the engine. */
function recording(seconds: number): Uint8Array {
  return encodeWavPcm16(new Float32Array(Math.round(SPEECH_SAMPLE_RATE * seconds)).map((_, index) => 0.05 * Math.sin(index / 8)));
}

test("it starts off, and turning it on downloads and checks the model until it is ready", async () => {
  const h = await harness();
  try {
    assert.equal((await h.service.getState()).status, "off");
    const seen: string[] = [];
    h.service.onState((state) => seen.push(state.status));
    const started = await h.service.enable();
    assert.equal(started.status, "downloading");
    const done = await settle(h.service, notBusy);
    assert.equal(done.status, "ready");
    assert.equal(done.modelInstalled, true);
    assert.equal(done.downloadedBytes, MODEL.length);
    assert.ok(seen.includes("verifying"));
    assert.deepEqual(await readFile(path.join(h.dir, "speech-to-text", SPEECH_MODEL_FILE)), MODEL);
    assert.equal(existsSync(path.join(h.dir, "speech-to-text", `${SPEECH_MODEL_FILE}.partial`)), false);
    // After a restart it is still on and ready, with nothing to download.
    const restarted = h.create();
    assert.equal((await restarted.getState()).status, "ready");
    assert.equal(h.server.requests.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("a dropped connection leaves what arrived, and resuming continues from there", async () => {
  const h = await harness();
  try {
    h.server.mode = { kind: "drop-after", bytes: 100_000 };
    await h.service.enable();
    const failed = await settle(h.service, notBusy);
    assert.equal(failed.status, "interrupted");
    assert.match(failed.error ?? "", /download stopped/i);
    assert.ok(failed.downloadedBytes > 0 && failed.downloadedBytes <= 100_000);
    h.server.mode = { kind: "normal" };
    await h.service.enable();
    const done = await settle(h.service, notBusy);
    assert.equal(done.status, "ready");
    assert.equal(h.server.requests.at(-1)?.range, `bytes=${failed.downloadedBytes}-`);
    assert.deepEqual(await readFile(path.join(h.dir, "speech-to-text", SPEECH_MODEL_FILE)), MODEL);
  } finally {
    await h.cleanup();
  }
});

test("a server that ignores the resume point gets the whole file written from the start", async () => {
  const h = await harness();
  try {
    h.server.mode = { kind: "drop-after", bytes: 50_000 };
    await h.service.enable();
    await settle(h.service, notBusy);
    h.server.mode = { kind: "ignore-range" };
    await h.service.enable();
    assert.equal((await settle(h.service, notBusy)).status, "ready");
    assert.deepEqual(await readFile(path.join(h.dir, "speech-to-text", SPEECH_MODEL_FILE)), MODEL);
  } finally {
    await h.cleanup();
  }
});

test("a damaged download is removed and never used", async () => {
  const h = await harness();
  try {
    h.server.mode = { kind: "corrupt" };
    await h.service.enable();
    const failed = await settle(h.service, notBusy);
    assert.equal(failed.status, "interrupted");
    assert.match(failed.error ?? "", /damaged/);
    assert.equal(failed.modelInstalled, false);
    assert.deepEqual(await readdir(path.join(h.dir, "speech-to-text")), ["settings.json"]);
    await assert.rejects(h.service.transcribe(recording(1)), /not ready/);
  } finally {
    await h.cleanup();
  }
});

test("a server error says what the server answered", async () => {
  const h = await harness();
  try {
    h.server.mode = { kind: "status", status: 503 };
    await h.service.enable();
    const failed = await settle(h.service, notBusy);
    assert.equal(failed.status, "interrupted");
    assert.match(failed.error ?? "", /503/);
  } finally {
    await h.cleanup();
  }
});

test("a download that stops sending is stopped, and can be resumed", async () => {
  const h = await harness({ stallMs: 300 });
  try {
    h.server.mode = { kind: "stall-after", bytes: 64_000 };
    await h.service.enable();
    const failed = await settle(h.service, notBusy);
    assert.equal(failed.status, "interrupted");
    assert.match(failed.error ?? "", /no data was arriving/);
    h.server.mode = { kind: "normal" };
    await h.service.enable();
    assert.equal((await settle(h.service, notBusy)).status, "ready");
  } finally {
    await h.cleanup();
  }
});

test("not enough disk space stops before downloading anything", async () => {
  const h = await harness({ freeBytes: async () => 10 });
  try {
    await h.service.enable();
    const failed = await settle(h.service, notBusy);
    assert.equal(failed.status, "interrupted");
    assert.match(failed.error ?? "", /Not enough free disk space/);
    assert.equal(h.server.requests.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("cancelling a download removes what arrived and turns it off", async () => {
  const h = await harness({ stallMs: 60_000 });
  try {
    h.server.mode = { kind: "stall-after", bytes: 64_000 };
    await h.service.enable();
    await settle(h.service, (state) => state.downloadedBytes >= 64_000);
    const cancelled = await h.service.cancelDownload();
    assert.equal(cancelled.status, "off");
    assert.equal(cancelled.error, undefined);
    assert.equal(cancelled.downloadedBytes, 0);
    assert.equal(existsSync(path.join(h.dir, "speech-to-text", `${SPEECH_MODEL_FILE}.partial`)), false);
    assert.equal((await h.create().getState()).status, "off");
  } finally {
    await h.cleanup();
  }
});

test("quitting during a download shows it as interrupted after the restart", async () => {
  const h = await harness({ stallMs: 60_000 });
  try {
    h.server.mode = { kind: "stall-after", bytes: 64_000 };
    await h.service.enable();
    await settle(h.service, (state) => state.downloadedBytes >= 64_000);
    const restarted = h.create();
    const state = await restarted.getState();
    assert.equal(state.status, "interrupted");
    assert.equal(state.downloadedBytes, 64_000);
    assert.match(state.error ?? "", /interrupted/);
    await h.service.cancelDownload();
  } finally {
    await h.cleanup();
  }
});

test("turning it off keeps the model unless asked to delete it", async () => {
  const h = await harness();
  try {
    await h.service.enable();
    await settle(h.service, notBusy);
    const kept = await h.service.disable({ deleteModel: false });
    assert.equal(kept.status, "off");
    assert.equal(kept.modelInstalled, true);
    await assert.rejects(h.service.transcribe(recording(1)), /not ready/);
    // On again: the kept model is used, nothing is downloaded.
    assert.equal((await h.service.enable()).status, "ready");
    assert.equal(h.server.requests.length, 1);
    const deleted = await h.service.disable({ deleteModel: true });
    assert.equal(deleted.status, "off");
    assert.equal(deleted.modelInstalled, false);
    assert.equal(existsSync(path.join(h.dir, "speech-to-text", SPEECH_MODEL_FILE)), false);
  } finally {
    await h.cleanup();
  }
});

test("without the engine it is unavailable and cannot be turned on", async () => {
  const h = await harness({ engine: () => ({ unavailable: "Not in this build." }) });
  try {
    const state = await h.service.enable();
    assert.equal(state.status, "unavailable");
    assert.equal(state.error, "Not in this build.");
    assert.equal(h.server.requests.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("a recording is recognized in any language by one engine kept for the next ones", async () => {
  const h = await harness();
  try {
    await h.service.enable();
    await settle(h.service, notBusy);
    const result = await h.service.transcribe(recording(2));
    assert.equal(result.text, "Привет, мир. Hello world.");
    await h.service.transcribe(recording(1));
    assert.equal(h.engines.length, 1);
    assert.equal(h.engines[0]!.input.modelPath, path.join(h.dir, "speech-to-text", SPEECH_MODEL_FILE));
    assert.equal(h.engines[0]!.input.idleMs, 10 * 60 * 1000);
    assert.equal(h.engines[0]!.transcribed.length, 2);
    assert.deepEqual(h.engines[0]!.stops, []);
  } finally {
    await h.cleanup();
  }
});

test("pressing the microphone starts loading the model, but only when speech to text is ready", async () => {
  const h = await harness();
  try {
    await h.service.prepare();
    assert.equal(h.engines.length, 0, "off: nothing is loaded");
    await h.service.enable();
    await settle(h.service, notBusy);
    await h.service.prepare();
    assert.equal(h.engines[0]!.prepared, 1);
  } finally {
    await h.cleanup();
  }
});

test("turning it off, quitting, or losing the model takes the model out of memory", async () => {
  const h = await harness();
  try {
    await h.service.enable();
    await settle(h.service, notBusy);
    await h.service.prepare();
    await h.service.shutdown();
    await h.service.disable({ deleteModel: false });
    assert.deepEqual(h.engines[0]!.stops, ["app-quit", "turned-off"]);
    await h.service.enable();
    await h.service.prepare();
    await rm(path.join(h.dir, "speech-to-text", SPEECH_MODEL_FILE));
    await assert.rejects(h.service.transcribe(recording(1)), /model is missing/);
    assert.equal(h.engines[0]!.stops.at(-1), "model-missing");
  } finally {
    await h.cleanup();
  }
});

test("a click-length or soundless recording gives no text without running the engine; foreign data is refused", async () => {
  const h = await harness();
  try {
    await h.service.enable();
    await settle(h.service, notBusy);
    assert.deepEqual(await h.service.transcribe(recording(0.1)), { text: "" });
    // A muted microphone: Whisper would invent words for it.
    assert.deepEqual(await h.service.transcribe(encodeWavPcm16(new Float32Array(SPEECH_SAMPLE_RATE * 3))), { text: "" });
    assert.equal(h.engines.length, 0);
    await assert.rejects(h.service.transcribe(new Uint8Array([1, 2, 3])), /empty/);
    await assert.rejects(h.service.transcribe(encodeWavPcm16(new Float32Array(48_000), 48_000)), /format/);
  } finally {
    await h.cleanup();
  }
});

test("an engine failure becomes a plain message, and the next recording still works", async () => {
  let fail = true;
  const h = await harness();
  try {
    await h.service.enable();
    await settle(h.service, notBusy);
    await h.service.prepare();
    h.engines[0]!.respond = async () => {
      if (fail) throw new Error("The speech engine answered 500");
      return "ok\n";
    };
    await assert.rejects(h.service.transcribe(recording(1)), /could not be recognized/);
    fail = false;
    assert.equal((await h.service.transcribe(recording(1))).text, "ok");
  } finally {
    await h.cleanup();
  }
});

test("recordings are recognized one at a time", async () => {
  let running = 0;
  let most = 0;
  const h = await harness();
  try {
    await h.service.enable();
    await settle(h.service, notBusy);
    await h.service.prepare();
    let count = 0;
    h.engines[0]!.respond = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 30));
      running -= 1;
      count += 1;
      return `phrase ${count}\n`;
    };
    const results = await Promise.all([1, 2, 3].map(() => h.service.transcribe(recording(1))));
    assert.equal(most, 1);
    assert.equal(new Set(results.map((result) => result.text)).size, 3);
  } finally {
    await h.cleanup();
  }
});

test("the engine is looked up beside the app, and only Apple silicon Macs have one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "speech-engine-"));
  try {
    const base = { platform: "darwin" as NodeJS.Platform, arch: "arm64", packaged: true, resourcesPath: dir, appPath: "/nowhere" };
    assert.ok("unavailable" in resolveSpeechEngine(base));
    await mkdir(path.join(dir, "whisper"));
    await writeFile(path.join(dir, "whisper", "whisper-server"), "");
    assert.deepEqual(resolveSpeechEngine(base), { path: path.join(dir, "whisper", "whisper-server") });
    assert.ok("unavailable" in resolveSpeechEngine({ ...base, platform: "win32" }));
    assert.ok("unavailable" in resolveSpeechEngine({ ...base, arch: "x64" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a resume the server answers from elsewhere starts over instead of corrupting the file", async () => {
  const h = await harness();
  try {
    h.server.mode = { kind: "drop-after", bytes: 40_000 };
    await h.service.enable();
    await settle(h.service, notBusy);
    h.server.mode = { kind: "shifted-range" };
    await h.service.enable();
    const failed = await settle(h.service, notBusy);
    assert.equal(failed.status, "interrupted");
    assert.match(failed.error ?? "", /206/);
    assert.equal(failed.downloadedBytes, 0);
    h.server.mode = { kind: "normal" };
    await h.service.enable();
    assert.equal((await settle(h.service, notBusy)).status, "ready");
    assert.equal(h.server.requests.at(-1)?.range, undefined);
    assert.deepEqual(await readFile(path.join(h.dir, "speech-to-text", SPEECH_MODEL_FILE)), MODEL);
  } finally {
    await h.cleanup();
  }
});

test("a download that was complete when the app quit is checked without downloading again", async () => {
  const h = await harness();
  try {
    await mkdir(path.join(h.dir, "speech-to-text"), { recursive: true });
    await writeFile(path.join(h.dir, "speech-to-text", "settings.json"), JSON.stringify({ enabled: true }));
    await writeFile(path.join(h.dir, "speech-to-text", `${SPEECH_MODEL_FILE}.partial`), MODEL);
    assert.equal((await h.service.getState()).status, "interrupted");
    await h.service.enable();
    assert.equal((await settle(h.service, notBusy)).status, "ready");
    assert.equal(h.server.requests.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("a quick on, off, on runs in order and ends downloading", async () => {
  const h = await harness({ stallMs: 60_000 });
  try {
    h.server.mode = { kind: "stall-after", bytes: 32_000 };
    const results = await Promise.all([h.service.enable(), h.service.cancelDownload(), h.service.enable()]);
    assert.deepEqual(results.map((state) => state.status), ["downloading", "off", "downloading"]);
    assert.equal((await h.service.getState()).status, "downloading");
    await h.service.cancelDownload();
  } finally {
    await h.cleanup();
  }
});

test("a model removed behind the app's back is reported instead of failing every dictation", async () => {
  const h = await harness();
  try {
    await h.service.enable();
    await settle(h.service, notBusy);
    await rm(path.join(h.dir, "speech-to-text", SPEECH_MODEL_FILE));
    await assert.rejects(h.service.transcribe(recording(1)), /model is missing/);
    const state = await h.service.getState();
    assert.equal(state.status, "interrupted");
    assert.equal(state.modelInstalled, false);
    assert.equal(h.engines.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("a signed app ignores an engine picked by its environment", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "speech-engine-"));
  try {
    const elsewhere = path.join(dir, "other-program");
    await writeFile(elsewhere, "");
    const base = { platform: "darwin" as NodeJS.Platform, arch: "arm64", resourcesPath: dir, appPath: dir, override: elsewhere };
    assert.ok("unavailable" in resolveSpeechEngine({ ...base, packaged: true }));
    assert.deepEqual(resolveSpeechEngine({ ...base, packaged: false }), { path: elsewhere });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a microphone press while it is being turned off does not load the model again", async () => {
  const h = await harness();
  try {
    await h.service.enable();
    await settle(h.service, notBusy);
    await h.service.prepare();
    const engine = h.engines[0]!;
    assert.equal(engine.prepared, 1);
    // A press and a dictation that arrive while the engine is being stopped.
    let during: Promise<unknown> = Promise.resolve();
    const stop = engine.stop.bind(engine);
    engine.stop = async (reason: string) => {
      during = Promise.all([h.service.prepare(), assert.rejects(h.service.transcribe(recording(1)), /not ready/)]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return stop(reason);
    };
    await h.service.disable({ deleteModel: false });
    await during;
    assert.equal(engine.prepared, 1);
    assert.deepEqual(engine.stops, ["turned-off"]);
  } finally {
    await h.cleanup();
  }
});
