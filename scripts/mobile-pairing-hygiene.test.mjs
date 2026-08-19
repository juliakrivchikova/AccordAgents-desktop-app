// W-G(a,b): pairing credentials leave the address bar once the pairing
// persists, and the seal key is accepted from the URL fragment only.
//
// (a) A pairing URL surviving in history, screenshots or share sheets must
// not be able to pair anyone else: after bootstrap the query credentials and
// the fragment are gone, while non-credential params (the qa debug flag)
// survive. (b) A key in the query string reaches server logs and referrers,
// so the legacy query path must refuse it — the app never issued such links.
//
// Runs the real built PWA in Chrome, like the other mobile harnesses.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8181;
const CDP_PORT = 9349;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webmanifest": "application/manifest+json"
};

const originHeaders = loadMobileOriginHeaders(root);
const site = createServer(async (req, res) => {
  const rel = (req.url || "/").split("?")[0];
  const file = path.join(root, rel === "/" ? "index.html" : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      ...mobileOriginHeadersForPath(originHeaders, rel)
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const killStaleCdp = () => {
  try {
    execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
  } catch {
    // nothing listening
  }
};

test("pairing credentials leave the URL and a query-string key is refused", async () => {
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-hygiene-"));
  const KEY = "a".repeat(43);
  const bootUrl = `http://127.0.0.1:${SITE_PORT}/?rid=rv-hyg&route=route-hyg&cap=CAP-HYG&qa=1#k=${KEY}`;
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=430,860", bootUrl
  ], { stdio: "ignore" });

  let app;
  try {
    for (let i = 0; i < 40 && !app; i += 1) {
      try {
        app = await attach({ port: CDP_PORT, title: "AccordAgents" });
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.ok(app, "could not attach to Chrome");
    const evaluate = async (expr) => (await app.evaluate(expr)).result.value;
    await new Promise((r) => setTimeout(r, 3000));

    const afterBoot = JSON.parse(await evaluate(`(() => JSON.stringify({
      href: location.href,
      pairing: JSON.parse(localStorage.getItem("accordagents.mobile.pairing.v1") || "null")
    }))()`));
    assert.equal(afterBoot.pairing?.relaySealKeyBase64, KEY, "the fragment key pairs the device");
    assert.equal(afterBoot.pairing?.rendezvousId, "rv-hyg");
    assert.ok(!afterBoot.href.includes("rid="), "rendezvous id must leave the URL: " + afterBoot.href);
    assert.ok(!afterBoot.href.includes("cap="), "capability must leave the URL: " + afterBoot.href);
    assert.ok(!afterBoot.href.includes(KEY), "the seal key must leave the URL: " + afterBoot.href);
    assert.ok(afterBoot.href.includes("qa=1"), "non-credential params survive the scrub: " + afterBoot.href);

    // (b) The legacy long-form branch must refuse a key riding in the query.
    await evaluate(`(() => { localStorage.clear(); sessionStorage.clear(); return true; })()`);
    await app.send("Page.navigate", {
      url: `http://127.0.0.1:${SITE_PORT}/?rendezvousId=rv-hyg2&routingId=route-hyg2&fingerprint=CAP2&relaySealKey=${KEY}&endpoint=wss%3A%2F%2Frelay.accordagents.com%2Fv1%2Frelay`
    });
    await new Promise((r) => setTimeout(r, 3000));
    const afterQueryKey = JSON.parse(await evaluate(`(() => JSON.stringify({
      pairing: JSON.parse(localStorage.getItem("accordagents.mobile.pairing.v1") || "null")
    }))()`));
    assert.ok(afterQueryKey.pairing, "the long-form pairing still bootstraps");
    assert.ok(!afterQueryKey.pairing.relaySealKeyBase64, "a query-string seal key is refused");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    killStaleCdp();
    site.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});
