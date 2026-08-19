// W-E leg 2: the CSP conformance subset, under WebKit.
//
// Every other gate we own runs Chromium while the field runs iOS Safari. That
// gap has already cost us once in this workstream — a policy omitting `wss:`
// would have passed every check we had and killed the phone's live transport —
// so the directives the app actually depends on are proved on a WebKit engine
// here, not argued about.
//
// Bound deliberately: page boot under the applied policy, service-worker
// registration, and the two connect-src forms. This is not a second behavioural
// suite; the behaviour lives in the Chromium harness, which also runs under the
// same policy.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { webkit } from "playwright";

const require = createRequire(import.meta.url);
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const PORT = 8181;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

/** Playwright's WebKit build segfaults on some macOS versions (observed on
 *  26.0.1: the engine launches and the first page dies immediately, in headless
 *  and headed, sandboxed and not, after a forced reinstall). When that happens
 *  this leg SKIPS WITH A NAMED REASON rather than passing, so an unusable
 *  engine can never be mistaken for a green WebKit run. */
async function webkitUsable() {
  let browser;
  try {
    browser = await webkit.launch();
    const page = await browser.newPage();
    await page.goto("data:text/html,<p>ok</p>");
    return { usable: true };
  } catch (error) {
    return { usable: false, reason: String(error?.message ?? error).split("\n")[0] };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

test("the shipped CSP boots the phone shell on a WebKit engine", async (t) => {
  const engine = await webkitUsable();
  if (!engine.usable) {
    t.skip(`WebKit engine unusable in this environment: ${engine.reason}. ` +
      "W-E's closing note must state that the shipped form is the Chromium " +
      "policy-applied boot plus connect probes, and that WebKit conformance " +
      "was verified on a real device instead.");
    return;
  }
  const originHeaders = loadMobileOriginHeaders(root);
  const site = createServer(async (req, res) => {
    let rel = (req.url || "/").split("?")[0];
    if (rel === "/") {
      rel = "/index.html";
    }
    try {
      const body = await readFile(path.join(root, rel));
      res.writeHead(200, {
        "content-type": TYPES[path.extname(rel)] || "application/octet-stream",
        ...mobileOriginHeadersForPath(originHeaders, rel)
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve) => site.listen(PORT, "127.0.0.1", resolve));

  const browser = await webkit.launch();
  const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const page = await context.newPage();
  const violations = [];
  // A CSP refusal surfaces as a console error in WebKit; collecting them means
  // a policy that blocks something the app needs cannot pass quietly.
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to/i.test(text)) {
      violations.push(text);
    }
  });
  page.on("pageerror", (error) => violations.push(`pageerror: ${error.message}`));

  try {
    const response = await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
    assert.equal(response?.status(), 200, "the shell must load");

    const served = response?.headers()["content-security-policy"] ?? "";
    const shipped = mobileOriginHeadersForPath(originHeaders, "/index.html")["Content-Security-Policy"] ?? "";
    assert.ok(served.length > 0, "WebKit must receive a policy, or this leg proves nothing");
    assert.equal(served, shipped, "the policy under test is the deployed one");

    // 1. The page boots: its own scripts ran under `script-src 'self'`.
    await page.waitForFunction(() => Boolean(document.getElementById("composer-input")), null, { timeout: 15_000 });
    const booted = await page.evaluate(() => ({
      composer: Boolean(document.getElementById("composer-input")),
      chatList: Boolean(document.getElementById("chat-list")),
      appApi: typeof globalThis.AccordAgentsMobile === "object"
    }));
    assert.equal(booted.composer, true, "the composer rendered");
    assert.equal(booted.chatList, true, "the chat list rendered");
    assert.equal(booted.appApi, true, "the app's own script executed under script-src 'self'");

    // 2. The service worker registers under `worker-src 'self'`. This is the
    //    directive most likely to break the phone quietly: without a worker
    //    there is no background sync and no doorbell.
    const registration = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) {
        return "unsupported";
      }
      try {
        const ready = await Promise.race([
          navigator.serviceWorker.ready.then(() => "ready"),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 15_000))
        ]);
        return ready;
      } catch (error) {
        return `error: ${error?.message ?? error}`;
      }
    });
    if (registration === "unsupported") {
      // W-E's stated fallback, reported rather than hidden.
      t.diagnostic("WebKit build has no service-worker support; shipped form is page boot plus connect probes");
    } else {
      assert.equal(registration, "ready", "the service worker registered under worker-src 'self'");
    }

    // 3. Both connect-src forms the app depends on. `https:` and `wss:` are
    //    listed separately in the policy precisely because whether one implies
    //    the other is engine-dependent — this is the check that settles it on
    //    the engine that matters.
    const probes = await page.evaluate(async () => {
      const out = { https: "", wss: "" };
      try {
        await fetch("https://fcm.googleapis.com/accord-csp-probe", { mode: "no-cors" });
        out.https = "allowed";
      } catch (error) {
        out.https = `blocked: ${error?.message ?? error}`;
      }
      out.wss = await new Promise((resolve) => {
        let socket;
        try {
          socket = new WebSocket("wss://relay.accordagents.com/v1/relay?rid=csp-probe");
        } catch (error) {
          resolve(`blocked: ${error?.message ?? error}`);
          return;
        }
        const done = (value) => {
          try {
            socket.close();
          } catch {
            // already closing
          }
          resolve(value);
        };
        socket.addEventListener("open", () => done("allowed"));
        // A refused handshake is fine: a CSP block shows up as a construction
        // or security error, not as a server-side rejection.
        socket.addEventListener("error", () => done("allowed"));
        setTimeout(() => done("timeout"), 8000);
      });
      return out;
    });
    assert.equal(probes.https, "allowed", `connect-src must permit https on WebKit: ${JSON.stringify(probes)}`);
    assert.equal(probes.wss, "allowed", `connect-src must permit wss on WebKit: ${JSON.stringify(probes)}`);

    assert.deepEqual(violations, [], "the policy must not refuse anything the app does on boot");
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => site.close(resolve));
  }
});
