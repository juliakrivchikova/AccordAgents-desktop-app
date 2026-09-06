// Desktop restart mid-turn: a member on the machine keeps working while the desktop is
// gone; the restarted desktop must end up with the finished reply, not a bubble that
// stays pending or is marked "Interrupted before completion".
const path = require("path");
const { spawn } = require("child_process");
const repo = process.argv[2];
const { attach } = require(path.resolve(repo, "scripts/cdp.cjs"));
const handle = "mia-machine-claude";
const t0 = Date.now(); const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJson(client, expr, timeoutMs = 15000) {
  const r = await client.evaluate(`JSON.stringify((() => { ${expr} })())`, {}, { timeoutMs });
  return JSON.parse(r.result.value);
}
async function evalAsync(client, expr, timeoutMs = 30000) {
  const r = await client.evaluate(`(async () => { try { const v = await (${expr}); return JSON.stringify({ ok: true, v }); } catch (e) { return JSON.stringify({ ok: false, e: String(e && e.message || e) }); } })()`, { awaitPromise: true }, { timeoutMs });
  return JSON.parse(r.result.value);
}
async function conv(client, id) {
  const r = await evalAsync(client, `(async () => { const c = await window.consensus.getConversation(${JSON.stringify(id)}); return c.messages.filter((m) => m.role === "participant").map((m) => ({ status: m.status, text: (m.content || "").slice(0, 120), reason: m.metadata && m.metadata.terminalReason })); })()`);
  return r.ok ? r.v : null;
}
async function cdpUp() {
  try { const r = await fetch("http://127.0.0.1:9223/json/version"); return r.ok; } catch { return false; }
}
(async () => {
  let client = await attach({ port: 9223 });
  const before = await evalAsync(client, `(async () => (await window.consensus.listConversations()).map((c) => c.id))()`);
  const known = new Set(before.v);
  await evalJson(client, `const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "New chat"); if (b) b.click(); return Boolean(b);`);
  await sleep(700);
  await client.click(".new-chat-participant-trigger"); await sleep(700);
  await evalJson(client, `const b = [...document.querySelectorAll("[aria-label]")].find((x) => x.getAttribute("aria-label") === "Add @${handle}"); if (b) b.click(); return Boolean(b);`);
  await sleep(300); await client.evaluate(`document.body.click()`);
  await client.fill(".new-chat-prompt", `@${handle} Run this exact Bash command in the foreground and then report its output: python3 -c "import time; time.sleep(40); print('RESTART_PROBE_DONE')"`);
  await sleep(300); await client.click(".new-chat-send"); console.log(stamp(), "sent long task");
  let id;
  for (let i = 0; i < 30 && !id; i += 1) { const l = await evalAsync(client, `(async () => (await window.consensus.listConversations()).map((c) => c.id))()`); id = (l.v || []).find((x) => !known.has(x)); if (!id) await sleep(500); }
  console.log(stamp(), "conversation", id);
  for (let i = 0; i < 40; i += 1) { if (await evalJson(client, `return Boolean(document.querySelector(".message-action-stop"));`) && i > 12) break; await sleep(500); }
  console.log(stamp(), "member is running on the machine; closing the desktop");
  await client.evaluate(`window.__closing = true`).catch(() => undefined);
  const list = await (await fetch("http://127.0.0.1:9223/json/version")).json();
  const WebSocket = require("ws");
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  await sleep(1500);
  for (let i = 0; i < 20 && await cdpUp(); i += 1) await sleep(500);
  console.log(stamp(), "desktop closed; relaunching");
  const child = spawn("npx", ["electron", ".", "--remote-debugging-port=9223"], {
    cwd: repo, detached: true, stdio: "ignore",
    env: { ...process.env, ACCORDAGENTS_USER_DATA_DIR: "/private/tmp/accordagents-qa-machines", ACCORDAGENTS_MOBILE_RELAY_URL: "ws://127.0.0.1:18099/v1/relay", ACCORD_AGENTS_DEBUG_LOGS: "1" }
  });
  child.unref();
  for (let i = 0; i < 60 && !(await cdpUp()); i += 1) await sleep(500);
  await sleep(4000);
  client = await attach({ port: 9223 });
  console.log(stamp(), "desktop back; waiting for the machine's reply to land");
  let state;
  for (let i = 0; i < 120; i += 1) {
    state = await conv(client, id);
    if (state && state.some((m) => m.status === "done" && m.text.includes("RESTART_PROBE_DONE"))) break;
    await sleep(1500);
  }
  console.log(stamp(), "state:", JSON.stringify(state));
  const done = Boolean(state && state.some((m) => m.status === "done" && m.text.includes("RESTART_PROBE_DONE")));
  const swept = Boolean(state && state.some((m) => /Interrupted before completion/.test(m.text)));
  console.log(stamp(), done && !swept ? "DESKTOP RESTART: PASS" : `DESKTOP RESTART: FAIL (done=${done} swept=${swept})`);
  process.exit(done && !swept ? 0 : 1);
})().catch((e) => { console.error("driver error", e); process.exit(3); });
