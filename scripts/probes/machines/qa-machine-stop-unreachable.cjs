const path = require("path");
const { attach } = require(path.resolve(process.argv[2], "scripts/cdp.cjs"));
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
  const r = await evalAsync(client, `(async () => { const c = await window.consensus.getConversation(${JSON.stringify(id)}); return { running: c.metadata.running, activeRunIds: c.metadata.activeRunIds, messages: c.messages.slice(-3).map((m) => ({ role: m.role, status: m.status, text: (m.content || "").slice(0, 160), reason: m.metadata && m.metadata.terminalReason })) }; })()`);
  return r.ok ? r.v : null;
}
(async () => {
  const client = await attach({ port: 9223 });
  const before = await evalAsync(client, `(async () => (await window.consensus.listConversations()).map((c) => c.id))()`);
  const known = new Set(before.v);
  await evalJson(client, `const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "New chat"); if (b) b.click(); return Boolean(b);`);
  await sleep(700);
  await client.click(".new-chat-participant-trigger"); await sleep(700);
  await evalJson(client, `const b = [...document.querySelectorAll("[aria-label]")].find((x) => x.getAttribute("aria-label") === "Add @${handle}"); if (b) b.click(); return Boolean(b);`);
  await sleep(300); await client.evaluate(`document.body.click()`);
  await client.fill(".new-chat-prompt", `@${handle} Run this exact Bash command in the foreground and then report its output: python3 -c "import time; time.sleep(90); print('STOP_PROBE_DONE')"`);
  await sleep(300); await client.click(".new-chat-send"); console.log(stamp(), "sent long task");
  let id;
  for (let i = 0; i < 30 && !id; i += 1) { const l = await evalAsync(client, `(async () => (await window.consensus.listConversations()).map((c) => c.id))()`); id = (l.v || []).find((x) => !known.has(x)); if (!id) await sleep(500); }
  console.log(stamp(), "conversation", id);
  // wait until the machine has actually launched the CLI (pending bubble + a tool activity), then Stop
  let stopBtn = false;
  for (let i = 0; i < 60; i += 1) {
    stopBtn = await evalJson(client, `return Boolean(document.querySelector(".message-action-stop"));`);
    const text = await evalJson(client, `return document.body.innerText.includes("python3") || document.body.innerText.includes("Bash");`);
    if (stopBtn && i > 16) break;
    await sleep(500);
  }
  console.log(stamp(), "stop button present:", stopBtn);
  // Rule 2: the machine becomes unreachable (frozen) before Stop is pressed.
  const { execSync } = require("child_process");
  const machinePid = Number(execSync("pgrep -f accordagents-machine.cjs").toString().trim().split("\n")[0]);
  process.kill(machinePid, "SIGSTOP"); console.log(stamp(), "froze machine pid", machinePid);
  await client.click(".message-action-stop"); console.log(stamp(), "clicked Stop");
  let waiting = null;
  for (let i = 0; i < 30; i += 1) {
    const s = await conv(client, id);
    waiting = s && s.messages.find((m) => /Stop requested/i.test(m.text));
    if (waiting) break;
    await sleep(500);
  }
  console.log(stamp(), "waiting state shown:", JSON.stringify(waiting));
  process.kill(machinePid, "SIGCONT"); console.log(stamp(), "machine back");

  let state;
  for (let i = 0; i < 60; i += 1) {
    state = await conv(client, id);
    const done = state && !state.running && (state.activeRunIds || []).length === 0 && !state.messages.some((m) => m.status === "pending");
    if (done) break;
    await sleep(1000);
  }
  console.log(stamp(), "state after stop:", JSON.stringify(state, null, 1));
  const stopped = Boolean(state && state.messages.some((m) => /stopped by user/i.test(m.text) || m.reason === "user-stopped"));
  const stale = Boolean(state && state.messages.some((m) => /Stop requested/i.test(m.text)));
  const pass = Boolean(waiting) && stopped && !stale;
  console.log(stamp(), pass ? "MACHINE STOP UNREACHABLE: PASS" : `MACHINE STOP UNREACHABLE: FAIL (waiting=${Boolean(waiting)} stopped=${stopped} stale=${stale})`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("driver error", e); process.exit(3); });
