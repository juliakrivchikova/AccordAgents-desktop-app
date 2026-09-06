const fs = require("fs");
const path = require("path");
const { attach } = require(path.resolve(process.argv[2], "scripts/cdp.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now(); const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
async function evalJson(client, expr, timeoutMs = 15000) {
  const r = await client.evaluate(`JSON.stringify((() => { ${expr} })())`, {}, { timeoutMs });
  return JSON.parse(r.result.value);
}
async function evalAsync(client, expr, timeoutMs = 20000) {
  const r = await client.evaluate(`(async () => { try { const v = await (${expr}); return JSON.stringify({ ok: true, v }); } catch (e) { return JSON.stringify({ ok: false, e: String(e && e.message || e) }); } })()`, { awaitPromise: true }, { timeoutMs });
  return JSON.parse(r.result.value);
}
(async () => {
  let client;
  for (let i = 0; i < 60; i += 1) {
    try { client = await attach({ port: 9223 }); break; } catch { await sleep(1000); }
  }
  if (!client) { console.log("no CDP"); process.exit(1); }
  console.log(stamp(), "attached");
  for (let i = 0; i < 60; i += 1) {
    const text = await evalJson(client, `return (document.body && document.body.innerText || "").slice(0, 200);`).catch(() => "");
    if (text && !/Loading chat/.test(text) && text.trim().length > 0) { console.log(stamp(), "renderer text:", JSON.stringify(text.slice(0, 80))); break; }
    await sleep(1000);
  }
  const bridge = await evalJson(client, `return { hasCreate: typeof window.consensus?.createMachine, hasList: typeof window.consensus?.listMachines };`);
  console.log(stamp(), "bridge:", JSON.stringify(bridge));
  const created = await evalAsync(client, `window.consensus.createMachine({ name: "QA machine" })`);
  console.log(stamp(), "createMachine:", JSON.stringify(created).slice(0, 300));
  if (!created.ok) process.exit(2);
  fs.writeFileSync("/private/tmp/accordagents-machine-qa/enrollment.json", created.v.enrollmentJson);
  const pkg = JSON.parse(created.v.enrollmentJson);
  console.log(stamp(), "enrollment relayUrl:", pkg.relayUrl, "purpose:", pkg.purpose, "expires:", pkg.expiresAt);
  const list = await evalAsync(client, `window.consensus.listMachines()`);
  console.log(stamp(), "machines:", JSON.stringify(list).slice(0, 400));
  fs.writeFileSync("/private/tmp/accordagents-machine-qa/machine-id.txt", created.v.machine.id);
  await client.close?.();
  process.exit(0);
})().catch((e) => { console.error("driver error", e); process.exit(3); });
