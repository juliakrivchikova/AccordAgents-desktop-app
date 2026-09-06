const fs = require("fs");
const path = require("path");
const { attach } = require(path.resolve(process.argv[2], "scripts/cdp.cjs"));
const handle = "mia-machine-claude";
const marker = process.argv[3] || "MACHINE_OK";
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
async function latestConversation(client, knownIds) {
  const r = await evalAsync(client, `(async () => { const list = await window.consensus.listConversations(); const known = new Set(${JSON.stringify([...knownIds])}); const latest = list.find((c) => !known.has(c.id)); if (!latest) return null; const conv = await window.consensus.getConversation(latest.id); return { id: conv.id, running: conv.metadata.running, activeRunIds: conv.metadata.activeRunIds, messages: conv.messages.map((m) => ({ role: m.role, status: m.status, pid: m.participantId, text: (m.content || "").slice(0, 160), runId: m.metadata && m.metadata.runId })) }; })()`);
  return r.ok ? r.v : null;
}
(async () => {
  let client;
  for (let i = 0; i < 60; i += 1) { try { client = await attach({ port: 9223 }); break; } catch { await sleep(1000); } }
  for (let i = 0; i < 60; i += 1) {
    const text = await evalJson(client, `return (document.body && document.body.innerText || "").slice(0, 100);`).catch(() => "");
    if (text && !/Loading chat/.test(text)) break;
    await sleep(1000);
  }
  const before = await evalAsync(client, `(async () => (await window.consensus.listConversations()).map((c) => c.id))()`);
  const knownIds = new Set(before.ok ? before.v : []);
  await evalJson(client, `const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "New chat"); if (b) b.click(); return Boolean(b);`);
  await sleep(700);
  await client.click(".new-chat-participant-trigger");
  await sleep(700);
  const added = await evalJson(client, `const b = [...document.querySelectorAll("[aria-label]")].find((x) => x.getAttribute("aria-label") === "Add @${handle}"); if (b) { b.click(); return true; } return false;`);
  console.log(stamp(), "added member:", added);
  await sleep(400);
  await client.evaluate(`document.body.click()`);
  await client.fill(".new-chat-prompt", `@${handle} Reply with exactly the word ${marker} and nothing else.`);
  await sleep(300);
  await client.click(".new-chat-send");
  console.log(stamp(), "sent");
  const deadline = Date.now() + 240000;
  let conv;
  while (Date.now() < deadline) {
    conv = await latestConversation(client, knownIds);
    const reply = conv?.messages.find((m) => m.role === "participant" && m.status !== "pending");
    if (reply) { console.log(stamp(), "participant reply:", JSON.stringify(reply)); break; }
    await sleep(1500);
  }
  console.log(stamp(), "conversation:", JSON.stringify(conv, null, 1).slice(0, 1500));
  const ok = Boolean(conv?.messages.find((m) => m.role === "participant" && m.status === "done" && m.text.includes(marker)));
  await client.screenshot?.("/Users/ysvetlichnaya/IdeaProjects/AccordAgents/screenshots/qa-machine-turn.png").catch(() => undefined);
  console.log(stamp(), ok ? "MACHINE TURN: PASS" : "MACHINE TURN: FAIL");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("driver error", e); process.exit(3); });
