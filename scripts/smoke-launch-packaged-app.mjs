#!/usr/bin/env node
// Launches a packaged AccordAgents.app with a throwaway profile and proves it
// starts: the main process stays up, the renderer loads with its preload bridge,
// and the app reports the version in package.json. Used before a release is
// published and again on the published download.
//
// Usage: node scripts/smoke-launch-packaged-app.mjs <path/to/AccordAgents.app> [--screenshot file.png] [--log file.log]

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const { attach, getJson } = require("./cdp.cjs");

const launchTimeoutMs = 120_000;
const settleMs = 5_000;
const mainProcessErrorPattern = /A JavaScript error occurred in the main process|Uncaught Exception/;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { appPath: "", screenshot: "", log: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--screenshot" || arg === "--log") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}.`);
      }
      options[arg.slice(2)] = path.resolve(value);
      index += 1;
    } else if (!options.appPath) {
      options.appPath = path.resolve(arg);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!options.appPath) {
    throw new Error("Usage: smoke-launch-packaged-app.mjs <path/to/AccordAgents.app> [--screenshot file.png] [--log file.log]");
  }
  return options;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPage(port, child, output) {
  const deadline = Date.now() + launchTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The app exited during launch (code ${child.exitCode}, signal ${child.signalCode}).`);
    }
    if (mainProcessErrorPattern.test(output())) {
      throw new Error("The main process reported an uncaught exception during launch.");
    }
    try {
      const targets = await getJson("/json", { port, timeoutMs: 2_000 });
      if (targets.some((target) => target.type === "page" && target.title === "AccordAgents")) {
        return;
      }
    } catch {
      // DevTools is not listening yet.
    }
    await delay(500);
  }
  throw new Error(`No AccordAgents window appeared within ${launchTimeoutMs / 1000}s.`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  // The app ignores SIGTERM while it shuts its services down, so give it a
  // moment and then kill its whole process group (renderer and helpers too).
  const exited = once(child, "exit");
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  const result = await Promise.race([exited.then(() => "exited"), delay(10_000).then(() => "timeout")]);
  if (result === "timeout") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await exited;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const executable = path.join(options.appPath, "Contents", "MacOS", "AccordAgents");
  if (!existsSync(executable)) {
    throw new Error(`No app executable at ${executable}`);
  }
  const expectedVersion = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version;
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "accordagents-smoke-"));
  const port = await freePort();

  for (const file of [options.screenshot, options.log].filter(Boolean)) {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  let output = "";
  const logStream = options.log ? createWriteStream(options.log) : null;
  const record = (source) => (chunk) => {
    const text = chunk.toString();
    output += text;
    if (logStream) {
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        logStream.write(`${new Date().toISOString()} [${source}] ${line}\n`);
      }
    }
  };

  console.log(`Launching ${options.appPath} (expect ${expectedVersion}, DevTools port ${port})`);
  // A fresh profile must never touch the real one: ACCORDAGENTS_USER_DATA_DIR
  // moves userData, and the mock keychain keeps safeStorage from blocking on a
  // Keychain prompt nobody can answer.
  const child = spawn(executable, [`--remote-debugging-port=${port}`, "--use-mock-keychain"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ACCORDAGENTS_USER_DATA_DIR: path.join(profileDir, "profile"),
      ACCORDAGENTS_CRASH_REPORTS: "0"
    }
  });
  child.stdout.on("data", record("stdout"));
  child.stderr.on("data", record("stderr"));

  let app = null;
  try {
    await waitForPage(port, child, () => output);
    app = await attach({ port, timeoutMs: 30_000 });
    const probe = await app.evaluate(`(async () => {
      const bridge = typeof window.consensus;
      const version = bridge === "object" ? await window.consensus.getAppVersion() : null;
      return { bridge, version, readyState: document.readyState };
    })()`);
    const { bridge, version, readyState } = probe.result.value;
    console.log(`Renderer: bridge=${bridge} version=${version} readyState=${readyState}`);
    if (bridge !== "object") {
      throw new Error("The renderer loaded without the preload bridge.");
    }
    if (version !== expectedVersion) {
      throw new Error(`The app reports version ${version}, expected ${expectedVersion}.`);
    }

    await delay(settleMs);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("The main process exited after the window loaded.");
    }
    if (mainProcessErrorPattern.test(output)) {
      throw new Error("The main process reported an uncaught exception.");
    }

    if (options.screenshot) {
      const shot = await app.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(options.screenshot, Buffer.from(shot.data, "base64"));
      console.log(`Screenshot: ${options.screenshot}`);
    }
    console.log(`PASS: ${options.appPath} launched as ${version}`);
  } finally {
    app?.close();
    await stop(child);
    logStream?.end();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
