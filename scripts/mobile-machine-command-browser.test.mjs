/**
 * The phone's signing key, in a real browser.
 *
 * Node has Ed25519 in WebCrypto; a phone browser is the thing that decides
 * whether this works on the User's device. This loads the shipped module in
 * real Chrome, mints an identity and a command there, and verifies both with
 * the desktop's own code — so a browser that cannot do it fails here rather
 * than on the phone.
 */
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRequire } from "node:module";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { verifySignedChatEvent } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));

const SITE_PORT = 8171;
const CDP_PORT = 9361;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const TYPES = { ".html": "text/html", ".js": "text/javascript" };

function killStaleCdp() {
  try { execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); } catch { /* nothing listening */ }
}

async function attach(port) {
  let seen = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      seen = targets.map((target) => `${target.type} ${target.url}`);
      const page = targets.find((target) => target.type === "page" && target.url.includes("/machine-command"));
      if (page) return page;
    } catch (error) {
      seen = [`fetch failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error("targets seen:", seen.join(" | "));
  return undefined;
}

test("a real browser mints this phone's identity and signs a command the desktop accepts", async (t) => {
  const site = createServer(async (request, response) => {
    const relative = (request.url ?? "/").split("?")[0];
    const file = relative === "/" || relative === "/machine-command"
      ? path.join(repoRoot, "scripts/fixtures/machine-command-page.html")
      : path.join(repoRoot, "src/mobile", relative.replace(/^\//, ""));
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404); response.end("not found");
    }
  });
  await new Promise((resolve) => site.listen(SITE_PORT, "127.0.0.1", resolve));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-machine-command-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    `http://127.0.0.1:${SITE_PORT}/machine-command`
  ], { stdio: "ignore" });
  t.after(async () => {
    chrome.kill("SIGKILL");
    await new Promise((resolve) => site.close(resolve));
    await rm(profile, { recursive: true, force: true });
  });

  const page = await attach(CDP_PORT);
  assert.ok(page, "could not attach to Chrome");
  const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  });
  await new Promise((resolve) => socket.on("open", resolve));
  const evaluate = async (expression) => {
    const messageId = ++id;
    const result = await new Promise((resolve, reject) => {
      pending.set(messageId, { resolve, reject });
      socket.send(JSON.stringify({
        id: messageId,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
    return result.result.value;
  };

  // The page is attached as soon as it exists; its scripts may not have run.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate("typeof window.mintInBrowser === 'function'")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const minted = await evaluate("window.mintInBrowser()");
  socket.close();
  assert.ok(minted && !minted.error, `the browser could not mint a command: ${minted && minted.error}`);
  assert.match(minted.identity.deviceId, /^device-[0-9a-f]{32}$/);
  assert.equal(
    verifySignedChatEvent(minted.event, minted.identity.publicKeyDerBase64),
    true,
    "what the browser signed must verify with the same code every machine uses"
  );
  assert.equal(minted.event.kind, "machine.turn.request");
  assert.equal(minted.event.payload.runId, "run-browser");
});
