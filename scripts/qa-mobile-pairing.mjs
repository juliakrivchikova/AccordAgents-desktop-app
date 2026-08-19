// Verify an unpaired install can pair itself from a pasted link.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const root = path.resolve(import.meta.dirname, "../dist/mobile");
const PORT = 8155, CDP = 9345;
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".png":"image/png", ".webmanifest":"application/manifest+json" };
const site = createServer(async (req,res)=>{
  const rel=(req.url||"/").split("?")[0];
  const file = path.join(root, rel==="/"?"index.html":rel);
  try { const b=await readFile(file);
    res.writeHead(200,{"content-type":TYPES[path.extname(file)]||"application/octet-stream"}); res.end(b); }
  catch { res.writeHead(404).end("nf"); }
});
await new Promise(r=>site.listen(PORT,"127.0.0.1",r));
// A leaked Chrome from a previous run would be reattached to, carrying its
// already-paired storage and inverting every result.
try {
  const stale = await fetch(`http://127.0.0.1:${CDP}/json/version`).then(r=>r.ok).catch(()=>false);
  if (stale) {
    const { execSync } = await import("node:child_process");
    execSync(`lsof -ti tcp:${CDP} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
    await new Promise(r=>setTimeout(r,1000));
  }
} catch { /* nothing listening */ }

const profile = await mkdtemp(path.join(tmpdir(),"aa-pair-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--headless=new","--no-first-run",
   // Camera calls resolve instantly instead of blocking on a permission prompt.
   "--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",`--remote-debugging-port=${CDP}`,`--user-data-dir=${profile}`,
   "--window-size=430,860",`http://127.0.0.1:${PORT}/`],{stdio:"ignore"});
let app;
await new Promise(r=>setTimeout(r,3000));
for (let i=0;i<60;i++){ try{ app=await attach({port:CDP,title:"AccordAgents"}); break;}catch{ await new Promise(r=>setTimeout(r,500)); } }
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS " : "FAIL "} ${name}${detail ? "  — " + detail : ""}`);
};
try {
  if(!app) throw new Error("could not attach");
  const ev = async e => (await app.evaluate(e)).result.value;
  await new Promise(r=>setTimeout(r,2500));
  const before = await ev(`(() => ({ hasForm: Boolean(document.querySelector(".pairing-form")), paired: Boolean(localStorage.getItem("accordagents.mobile.pairing.v1")) }))()`);
  check("unpaired install shows a pairing form", before.hasForm);
  check("starts genuinely unpaired", before.paired === false);

  const link = "https://mobile.accordagents.com/?v=1&rid=rv-test&route=route-test&cap=CAP-TEST&mailbox=https%3A%2F%2Frelay.example%2F&outbox=https%3A%2F%2Frelay.example%2Fv1%2Fmailbox%2Fevents#k=dGVzdGtleQ";
  const after = await ev(`(() => {
    const i = document.querySelector(".pairing-input");
    i.value = ${JSON.stringify(link)};
    document.querySelector(".pairing-form").dispatchEvent(new Event("submit", { cancelable: true }));
    const p = JSON.parse(localStorage.getItem("accordagents.mobile.pairing.v1") || "null");
    return { routingId: p?.routingId, key: p?.relaySealKeyBase64, outbox: p?.outboxUrl };
  })()`);
  check("pasted link pairs the device", after.routingId === "route-test" && after.key === "dGVzdGtleQ", JSON.stringify(after));
  check("mailbox details carried over", Boolean(after.outbox?.includes("relay.example")));
  app?.close();
} catch (error) {
  check("harness completed", false, error?.message || String(error));
} finally {
  // Without this the script never exited: Chrome and the static server both
  // held the event loop open, so the run hung and leaked a browser.
  chrome.kill("SIGKILL");
  site.close();
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
