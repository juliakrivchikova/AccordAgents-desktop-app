#!/usr/bin/env node
"use strict";
/**
 * design-diff: compare a design (a self-unpacking design HTML) against a live UI by
 * computed style.
 *
 *   node design-diff.cjs <component> --design <design.html> --live-url <url> --map <map.json>
 *
 * It renders the design HTML headless (Google Chrome) and captures the live side — a web
 * app rendered headless via --live-url, or any app already exposing the Chrome DevTools
 * Protocol on --app-port — then prints a per-property computed-style delta table AND
 * writes a screenshot of each side (design-diff.design.png / design-diff.live.png) so
 * STRUCTURAL drift the table can't see (extra/missing sections, different layout) is
 * visible at a glance.
 *
 * --app-port  : attach to an app already serving CDP on this port (e.g. Chrome launched
 *               with --remote-debugging-port). Add --app-title <regex> to pick a window
 *               by title/url when several are open.
 * --inject    : smoke-test ONLY. Mounts the map's hand-written fixtureHtml instead of the
 *               live component. The result is a SMOKE run: never a pass, exits non-zero,
 *               and must not be reported as sign-off. Use it only to check that the engine
 *               itself works, never to verify an implementation.
 *
 * IMPORTANT: the table compares the COMPUTED STYLE of ONE representative element per
 * mapped type (a chip, a row, the submit). It does not compare text or the NUMBER of
 * repeated items (rows / chips / pills) — differing content and counts are expected. It
 * DOES flag a mapped element present on one side but absent on the other (a structural
 * delta — e.g. the impl added a section the design doesn't have). For anything not in the
 * map, use the emitted screenshots. Components are defined in a map JSON (edit that, not
 * this file). See SKILL.md for how to act on deltas.
 *
 * Exit codes: 0 = real capture, 0 deltas. 1 = real capture with deltas to review (or a
 * hard error). 3 = SMOKE run (--inject) — never sign-off.
 */
const VERSION = "0.3";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const DEFAULT_MAP = path.join(__dirname, "design-diff.map.json");
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DESIGN_SHOT = path.join(process.cwd(), "design-diff.design.png");
const LIVE_SHOT = path.join(process.cwd(), "design-diff.live.png");
const REPORT = path.join(process.cwd(), "design-diff-report.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const a = { _: [], appPort: "9222", inject: false, shots: true };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--inject") a.inject = true;
    else if (t === "--no-shots") a.shots = false;
    else if (t === "--app-port") a.appPort = argv[++i];
    else if (t === "--app-title") a.appTitle = argv[++i];
    else if (t === "--live-url") a.liveUrl = argv[++i];
    else if (t === "--design") a.design = argv[++i];
    else if (t === "--map") a.map = argv[++i];
    else if (t === "--chrome") a.chrome = argv[++i];
    else a._.push(t);
  }
  return a;
}

// Friendly property names -> the computed-style longhands they expand to.
const FRIENDLY = {
  borderRadius: ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"],
  padding: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  margin: ["marginTop", "marginRight", "marginBottom", "marginLeft"],
  gap: ["rowGap", "columnGap"],
  fontSize: ["fontSize"], fontWeight: ["fontWeight"], lineHeight: ["lineHeight"],
  color: ["color"], backgroundColor: ["backgroundColor"], boxShadow: ["boxShadow"],
  borderWidth: ["borderTopWidth"], borderColor: ["borderTopColor"]
};
const expand = (props) => {
  const keys = [];
  for (const p of props) (FRIENDLY[p] || [p]).forEach((k) => keys.push(k));
  return Array.from(new Set(keys));
};
// An element may declare only `design` (design-only — expect "absent in impl") or only
// `app` (impl-only — expect "absent in design"). The missing side resolves to a
// selector that matches nothing, so presence parity flags it.
const specs = (elements, side) => elements.map((e) => ({ name: e.name, selector: e[side] || ":not(*)", keys: expand(e.props || []) }));

// Collapse longhand values back to a readable shorthand for one friendly prop.
function shorthand(prop, vals, found) {
  if (!found) return "(absent)";
  if (vals.some((v) => v == null)) return "?";
  if (prop === "borderRadius" || prop === "gap") return vals.every((v) => v === vals[0]) ? String(vals[0]) : vals.join("/");
  if (prop === "padding" || prop === "margin") return vals.join("/");
  return String(vals[0]);
}

// ---- CDP plumbing ----
const getJSON = (port) => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${port}/json`, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej);
});
async function findPage(port, match, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const pages = (await getJSON(port)).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      const p = match ? pages.find((t) => match.test((t.url || "") + (t.title || ""))) : (pages.find((t) => t.url && t.url !== "about:blank") || pages[0]);
      if (p) return p;
    } catch (e) { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`no page target on port ${port}`);
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
    ws.once("open", () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
      close: () => ws.close()
    }));
    ws.once("error", reject);
  });
}
async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result && r.result.value;
}
function captureExpr(rootSel, specList) {
  return `(() => {
    const rootSel = ${JSON.stringify(rootSel)};
    const specs = ${JSON.stringify(specList)};
    const root = document.querySelector(rootSel);
    const out = { _rootFound: !!root, elements: {} };
    if (!root) return out;
    for (const s of specs) {
      const el = (s.selector === rootSel) ? root : root.querySelector(s.selector);
      if (!el) { out.elements[s.name] = { _found: false }; continue; }
      const cs = getComputedStyle(el);
      const o = { _found: true };
      for (const k of s.keys) o[k] = cs[k];
      out.elements[s.name] = o;
    }
    return out;
  })()`;
}

// Screenshot the root element (best-effort; never fails the run). Captures the REAL
// rendered subtree so structural drift the table can't measure is still reviewable.
async function screenshotRoot(cdp, rootSel, outPath) {
  try {
    await cdp.send("Page.enable");
    const rect = await evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(rootSel)}); if (!el) return null; el.scrollIntoView(); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    if (!rect || rect.width < 1 || rect.height < 1) return false;
    const res = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height, scale: 1 }
    });
    fs.writeFileSync(outPath, Buffer.from(res.data, "base64"));
    return true;
  } catch (e) {
    return false;
  }
}

// ---- render a URL headless and capture (design side, and live web apps) ----
async function renderCapture(chromeBin, url, rootSel, specList, opts = {}) {
  const port = 9300 + Math.floor(Math.random() * 99);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "design-diff-"));
  let chrome;
  try {
    chrome = spawn(chromeBin, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, url], { stdio: "ignore" });
    const page = await findPage(port, null);
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    for (let i = 0; i < 45; i++) {
      const st = await evaluate(cdp, `(()=>{const l=document.querySelector('#__bundler_loading');const vis=l&&getComputedStyle(l).display!=='none'&&l.offsetParent!==null;return {ready:document.readyState,loadingVis:!!vis,hasRoot:!!document.querySelector(${JSON.stringify(rootSel)}),len:(document.body.innerText||'').length};})()`);
      const ready = st && st.ready === "complete" && (!opts.waitUnpack || (!st.loadingVis && st.len > 200)) && (!opts.waitForRoot || st.hasRoot);
      if (ready) break;
      await sleep(700);
    }
    const data = await evaluate(cdp, captureExpr(rootSel, specList));
    if (opts.shotPath && data && data._rootFound) data._shot = await screenshotRoot(cdp, rootSel, opts.shotPath);
    cdp.close();
    return data;
  } finally {
    if (chrome) { try { process.kill(chrome.pid); } catch (e) { /* gone */ } }
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

// ---- capture from an app already exposing CDP on a port ----
async function attachCapture(appPort, cfg, inject, titleRe, shotPath) {
  const appPage = await findPage(appPort, titleRe);
  const acdp = await connect(appPage.webSocketDebuggerUrl);
  await acdp.send("Runtime.enable");
  // wait for the renderer + stylesheets to actually be ready (cold launch can lag)
  for (let i = 0; i < 30; i++) {
    const st = await evaluate(acdp, `(()=>({ready:document.readyState,css:document.styleSheets.length}))()`);
    if (st && st.ready === "complete" && st.css > 0) break;
    await sleep(500);
  }
  let rootFound = await evaluate(acdp, `!!document.querySelector(${JSON.stringify(cfg.appRoot)})`);
  if (!rootFound && inject && cfg.fixtureHtml) {
    // SMOKE only: append a hand-written replica to <body>. This does NOT reflect the
    // real component — the caller flags the whole run as smoke and never passes it.
    await evaluate(acdp, `(() => { const wrap = document.createElement('div'); wrap.className = 'design-diff-fixture'; wrap.style.cssText = 'position:fixed;left:20px;top:20px;width:560px;z-index:99999'; wrap.innerHTML = ${JSON.stringify(cfg.fixtureHtml)}; document.body.appendChild(wrap); return true; })()`);
    rootFound = await evaluate(acdp, `!!document.querySelector(${JSON.stringify(cfg.appRoot)})`);
  }
  if (!rootFound) {
    acdp.close();
    throw new Error(`live root '${cfg.appRoot}' is not rendered on port ${appPort}. Render the real component (see SKILL.md), then re-run. (--inject mounts a fixture for a SMOKE test only — it is never sign-off.)`);
  }
  const data = await evaluate(acdp, captureExpr(cfg.appRoot, specs(cfg.elements, "app")));
  if (shotPath && data && data._rootFound) data._shot = await screenshotRoot(acdp, cfg.appRoot, shotPath);
  acdp.close();
  return data;
}

// ---- comparison ----
const normColor = (v) => String(v).replace(/\s+/g, "");
function eqVal(key, d, l) {
  if (d == null || l == null) return false;
  if (/color|shadow/i.test(key)) return normColor(d) === normColor(l);
  const dn = parseFloat(d), ln = parseFloat(l);
  if (!isNaN(dn) && !isNaN(ln)) return Math.abs(dn - ln) <= 0.6;
  return String(d) === String(l);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const component = args._[0];
  const mapPath = args.map ? path.resolve(process.cwd(), args.map) : DEFAULT_MAP;
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  if (!component) { console.error(`usage: node design-diff.cjs <component> --design <html> --live-url <url> [--map <json>] [--app-port <n> --app-title <re>] [--inject]\nknown: ${Object.keys(map.components || {}).join(", ")}`); process.exit(2); }
  const cfg = map.components && map.components[component];
  if (!cfg) { console.error(`unknown component '${component}' in ${mapPath}. known: ${Object.keys(map.components || {}).join(", ")}`); process.exit(2); }

  const mapDir = path.dirname(mapPath);
  const designDir = map.designDir ? path.resolve(mapDir, map.designDir) : mapDir;
  const designPath = args.design ? path.resolve(process.cwd(), args.design)
    : cfg.designFile ? path.resolve(designDir, cfg.designFile)
    : null;
  if (!designPath) { console.error("no design file: pass --design <html>, or set designFile (and optional top-level designDir) in the map."); process.exit(2); }
  if (!fs.existsSync(designPath)) { console.error("design file not found: " + designPath); process.exit(2); }

  const chromeBin = args.chrome || CHROME;
  const titleRe = args.appTitle ? new RegExp(args.appTitle) : (map.appTitle ? new RegExp(map.appTitle) : null);
  const liveTarget = args.liveUrl || (":" + args.appPort);
  console.log(`design-diff v${VERSION} · ${component} · map ${path.basename(mapPath)} · design ${path.basename(designPath)} (found) · live ${liveTarget}${args.inject ? " (--inject SMOKE)" : ""}`);

  // design side: always rendered headless
  const designData = await renderCapture(chromeBin, "file://" + encodeURI(designPath), cfg.designRoot, specs(cfg.elements, "design"), { waitUnpack: true, shotPath: args.shots ? DESIGN_SHOT : undefined });
  if (!designData || !designData._rootFound) { console.error(`design root '${cfg.designRoot}' not found in ${path.basename(designPath)} after unpack.`); process.exit(1); }

  // live side: web app via --live-url, else an app already serving CDP on --app-port
  let liveData, injected = false;
  if (args.liveUrl) {
    liveData = await renderCapture(chromeBin, args.liveUrl, cfg.appRoot, specs(cfg.elements, "app"), { waitForRoot: true, shotPath: args.shots ? LIVE_SHOT : undefined });
    if (!liveData || !liveData._rootFound) { console.error(`live root '${cfg.appRoot}' not found at ${args.liveUrl}.`); process.exit(1); }
  } else {
    injected = args.inject;
    liveData = await attachCapture(args.appPort, cfg, injected, titleRe, args.shots && !injected ? LIVE_SHOT : undefined);
  }

  // compare: structural presence first (one row per element), then per-prop style when
  // the element exists on BOTH sides. This accounts for both directions —
  // "absent in impl" (design has it, impl dropped it) and "absent in design" (impl
  // added something the design doesn't have).
  const rows = [];
  for (const e of cfg.elements) {
    const d = (designData.elements || {})[e.name] || { _found: false };
    const l = (liveData.elements || {})[e.name] || { _found: false };
    if (d._found !== l._found) {
      rows.push({
        element: e.name, prop: "(presence)",
        design: d._found ? "present" : "(absent)", live: l._found ? "present" : "(absent)",
        status: "delta", note: d._found ? "absent in impl" : "absent in design",
        lowConf: injected
      });
      continue;
    }
    if (!d._found && !l._found) {
      rows.push({ element: e.name, prop: "(presence)", design: "(absent)", live: "(absent)", status: "unmeasured", lowConf: false });
      continue;
    }
    for (const prop of (e.props || [])) {
      const keys = expand([prop]);
      const dvals = keys.map((k) => d[k]);
      const lvals = keys.map((k) => l[k]);
      const measured = dvals.every((v) => v != null) && lvals.every((v) => v != null);
      const status = measured ? (keys.every((k, i) => eqVal(k, dvals[i], lvals[i])) ? "match" : "delta") : "unmeasured";
      // In a smoke run (--inject) every value comes from the fixture, so no delta is
      // trustworthy. In a real capture everything is faithful — including composed-
      // component geometry, which is exactly why a real component (not --inject) is sign-off.
      const lowConf = status === "delta" && injected;
      rows.push({ element: e.name, prop, design: shorthand(prop, dvals, d._found), live: shorthand(prop, lvals, l._found), status, lowConf });
    }
  }

  const genuine = rows.filter((r) => r.status === "delta" && !r.lowConf);
  const lowc = rows.filter((r) => r.status === "delta" && r.lowConf);
  const matches = rows.filter((r) => r.status === "match");
  const presence = rows.filter((r) => r.note);

  fs.writeFileSync(REPORT, JSON.stringify({
    component, design: path.basename(designPath), live: liveTarget, injected,
    smoke: injected, designShot: designData._shot ? DESIGN_SHOT : null, liveShot: liveData._shot ? LIVE_SHOT : null,
    generatedAt: new Date().toISOString(), rows
  }, null, 2));

  console.log("");
  if (injected) {
    console.log("⚠ SMOKE RUN (--inject): measured a hand-written fixture, NOT the live component.");
    console.log("  This is never sign-off. Render the real component and re-run without --inject.");
    console.log(`VERDICT: SMOKE — not a real result (${rows.filter((r) => r.status === "delta").length} delta vs fixture, ${matches.length} fixture-match)`);
  } else {
    console.log(`VERDICT: ${genuine.length} to review · ${matches.length} ok${lowc.length ? ` · ${lowc.length} low-confidence` : ""}`);
  }
  console.log("(styling + element presence; text & item counts are ignored)\n");
  const W = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(W("ELEMENT", 15) + W("PROPERTY", 16) + W("DESIGN", 22) + W("LIVE", 22) + "STATUS");
  for (const r of rows) {
    const mark = r.status === "match" ? "ok" : r.status === "delta" ? (r.note ? r.note.toUpperCase() : r.lowConf ? "delta (low-conf)" : "DELTA") : "-";
    console.log(W(r.element, 15) + W(r.prop, 16) + W(r.design, 22) + W(r.live, 22) + mark);
  }
  if (!injected && presence.length) console.log(`\nStructural: ${presence.map((r) => `${r.element} (${r.note})`).filter((v, i, a) => a.indexOf(v) === i).join(", ")}`);
  if (!injected && genuine.length) console.log(`Review: ${genuine.map((r) => `${r.element}.${r.prop}`).join(", ")}`);
  const shotNote = [designData._shot ? "design" : null, liveData._shot ? "live" : null].filter(Boolean);
  if (shotNote.length) console.log(`Screenshots: ${designData._shot ? path.basename(DESIGN_SHOT) : ""}${designData._shot && liveData._shot ? " + " : ""}${liveData._shot ? path.basename(LIVE_SHOT) : ""} — eyeball these for structure the table can't measure.`);

  // Exit codes: SMOKE never passes; real capture passes only with zero genuine deltas.
  if (injected) process.exit(3);
  process.exit(genuine.length ? 1 : 0);
})().catch((e) => { console.error("ERR", e && e.message ? e.message : e); process.exit(1); });
