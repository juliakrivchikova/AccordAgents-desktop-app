#!/usr/bin/env node
// Launches a packaged app bundle with a throwaway profile and proves it starts:
// the main process stays up, the renderer loads with its preload bridge, and
// the app reports the version in this checkout's package.json. Used before a
// release is published and again on the published download.
//
// Usage: node scripts/smoke-launch-packaged-app.mjs <path/to/App.app> [--screenshot file.png] [--log file.log]

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { attach, getJson } = require("./cdp.cjs");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const productName = packageJson.productName || packageJson.name;
const expectedVersion = packageJson.version;

const launchTimeoutMs = Number(process.env.SMOKE_LAUNCH_TIMEOUT_MS) || 120_000;
const settleMs = 5_000;
const outputTailLines = 50;
const mainProcessErrorPattern = /A JavaScript error occurred in the main process|Uncaught Exception/;
const devToolsPattern = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//;

function parseArgs(argv) {
  const options = { appPath: "", screenshot: "", log: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--screenshot" || arg === "--log") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}.`);
      }
      options[arg.slice(2)] = path.resolve(value);
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.appPath) {
      options.appPath = path.resolve(arg);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!options.appPath) {
    throw new Error("Usage: smoke-launch-packaged-app.mjs <path/to/App.app> [--screenshot file.png] [--log file.log]");
  }
  return options;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pickEnv(names) {
  return Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

// The DevTools port comes from the app's own stderr: a port picked in advance
// could be taken by another browser before the app binds it.
async function waitForPage(child, launchOutput, launchError) {
  const deadline = Date.now() + launchTimeoutMs;
  while (Date.now() < deadline) {
    if (launchError()) {
      throw new Error(`Could not start the app: ${launchError().message}`);
    }
    if (exited(child)) {
      throw new Error(`The app exited during launch (code ${child.exitCode}, signal ${child.signalCode}).`);
    }
    const output = launchOutput();
    if (mainProcessErrorPattern.test(output)) {
      throw new Error("The main process reported an uncaught exception during launch.");
    }
    const port = Number(output.match(devToolsPattern)?.[1]);
    if (port) {
      try {
        const targets = await getJson("/json", { port, timeoutMs: 2_000 });
        if (targets.some((target) => target.type === "page" && target.title === productName)) {
          return port;
        }
      } catch {
        // DevTools is not answering yet.
      }
    }
    await delay(500);
  }
  throw new Error(`No ${productName} window appeared within ${launchTimeoutMs / 1000}s.`);
}

async function stop(child) {
  if (!child.pid) {
    return;
  }
  if (!exited(child)) {
    // The app may ignore SIGTERM while it shuts its services down, so give it
    // a moment before killing the group.
    const exit = once(child, "exit");
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    await Promise.race([exit, delay(10_000)]);
  }
  // Even after the app itself exited, helpers in its process group (renderer,
  // GPU) may still be running and holding the pipes open.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The whole group is gone.
  }
  if (!exited(child)) {
    await once(child, "exit");
  }
  child.stdout.destroy();
  child.stderr.destroy();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const executable = path.join(options.appPath, "Contents", "MacOS", productName);
  if (!existsSync(executable)) {
    throw new Error(`No app executable at ${executable}`);
  }
  for (const file of [options.screenshot, options.log].filter(Boolean)) {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "accordagents-smoke-"));

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

  console.log(`Launching ${options.appPath} (expect ${expectedVersion})`);
  // A fresh profile must never touch the real one: ACCORDAGENTS_USER_DATA_DIR
  // moves userData, and the mock keychain keeps safeStorage from blocking on a
  // Keychain prompt nobody can answer.
  // A window behind other windows stops painting, and a screenshot of it never
  // arrives; these switches keep it painting.
  const child = spawn(executable, [
    "--remote-debugging-port=0",
    "--use-mock-keychain",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding"
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // Only what a login session provides: release credentials in this
    // process's environment must not reach the app.
    env: {
      ...pickEnv(["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG"]),
      ACCORDAGENTS_USER_DATA_DIR: path.join(profileDir, "profile"),
      ACCORDAGENTS_CRASH_REPORTS: "0"
    }
  });
  child.stdout.on("data", record("stdout"));
  child.stderr.on("data", record("stderr"));
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = error;
  });

  let app = null;
  try {
    const port = await waitForPage(child, () => output, () => spawnError);
    app = await attach({ port, title: productName, timeoutMs: 30_000 });
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
    if (exited(child)) {
      throw new Error("The main process exited after the window loaded.");
    }
    if (mainProcessErrorPattern.test(output)) {
      throw new Error("The main process reported an uncaught exception.");
    }

    // The screenshot is evidence, not part of the verdict.
    if (options.screenshot) {
      try {
        await app.send("Page.bringToFront");
        const shot = await app.send("Page.captureScreenshot", { format: "png" }, { timeoutMs: 15_000 });
        writeFileSync(options.screenshot, Buffer.from(shot.data, "base64"));
        console.log(`Screenshot: ${options.screenshot}`);
      } catch (error) {
        console.warn(`No screenshot: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`PASS: ${options.appPath} launched as ${version}`);
  } catch (error) {
    const tail = output.split(/\r?\n/).filter(Boolean).slice(-outputTailLines);
    if (tail.length > 0) {
      console.error(`Last ${tail.length} lines of app output:\n${tail.join("\n")}`);
    }
    throw error;
  } finally {
    app?.close();
    await stop(child);
    logStream?.end();
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      console.warn(`Could not remove the throwaway profile ${profileDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
