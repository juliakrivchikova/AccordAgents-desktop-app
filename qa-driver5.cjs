const { attach } = require("./scripts/cdp.cjs");
const CONV = "c483a170-08d5-4888-adb3-2b27686e4471";

async function snap(app) {
  const res = await app.evaluate(`(async () => {
    const c = await window.consensus.getConversation(${JSON.stringify(CONV)});
    const page = await window.consensus.listConversationMessages({ conversationId: ${JSON.stringify(CONV)}, limit: 80 });
    return {
      running: c?.metadata?.activeRunIds?.length || 0,
      msgs: (page.messages||[]).map(m => ({ role: m.role, content: (m.content||"").slice(0,200) }))
    };
  })()`, { awaitPromise: true });
  return res.result.value;
}
async function waitIdle(app, wantP, timeoutMs) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeoutMs) {
    last = await snap(app);
    if (last.running === 0 && last.msgs.filter(m=>m.role==="participant").length >= wantP) return last;
    await new Promise(r => setTimeout(r, 2500));
  }
  return last;
}
(async () => {
  const app = await attach({ port: 9224 });
  const base = (await snap(app)).msgs.filter(m=>m.role==="participant").length;
  console.log("base participant msgs:", base);
  await app.evaluate(`window.consensus.sendChatMessage({ conversationId: ${JSON.stringify(CONV)}, content: "@gemini Reply with exactly the word ALPHA and nothing else." })`, { awaitPromise: true });
  const s = await waitIdle(app, base+1, 150000);
  const p = s.msgs.filter(m=>m.role==="participant").pop();
  console.log("reply:", JSON.stringify(p?.content?.slice(0,160)));
  app.close();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
