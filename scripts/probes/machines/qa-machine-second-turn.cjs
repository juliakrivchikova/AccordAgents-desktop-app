const path = require("path");
const { attach } = require(path.resolve(process.argv[2], "scripts/cdp.cjs"));
const convId = process.argv[3];
const marker = process.argv[4] || "MACHINE_OK";
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
(async () => {
  const client = await attach({ port: 9223 });
  // open the chat from the sidebar by its title
  const opened = await evalJson(client, `const items = [...document.querySelectorAll("a, button, [role=button], li")].filter((x) => (x.innerText || "").includes(${JSON.stringify(marker)})); if (items[0]) { items[0].click(); return items[0].tagName + ":" + (items[0].innerText || "").slice(0, 60); } return null;`);
  console.log(stamp(), "opened chat via sidebar:", opened);
  await sleep(1200);
  const composer = await evalJson(client, `return Boolean(document.querySelector(".chat-composer textarea"));`);
  console.log(stamp(), "composer present:", composer);
  await client.fill(".chat-composer textarea", `@${handle} Reply with exactly the word SECOND_OK and nothing else.`);
  await sleep(300);
  await client.click('[aria-label="Send message"]');
  console.log(stamp(), "sent second turn");
  let reply;
  for (let i = 0; i < 160; i += 1) {
    const r = await evalAsync(client, `(async () => { const c = await window.consensus.getConversation(${JSON.stringify(convId)}); return c.messages.filter((m) => m.role === "participant").map((m) => ({ status: m.status, text: (m.content || "").slice(0, 80), runId: m.metadata && m.metadata.runId })); })()`);
    const msgs = r.ok ? r.v : [];
    reply = msgs.find((m) => m.status === "done" && m.text.includes("SECOND_OK"));
    if (reply) break;
    await sleep(1500);
  }
  console.log(stamp(), reply ? "SECOND TURN: PASS " + JSON.stringify(reply) : "SECOND TURN: FAIL");
  process.exit(reply ? 0 : 1);
})().catch((e) => { console.error("driver error", e); process.exit(3); });
