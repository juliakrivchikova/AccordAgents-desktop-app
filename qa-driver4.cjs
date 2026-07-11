const { attach } = require("./scripts/cdp.cjs");
const CONV = "c483a170-08d5-4888-adb3-2b27686e4471";
const fs = require("fs");

async function snap(app) {
  const res = await app.evaluate(`(async () => {
    const c = await window.consensus.getConversation(${JSON.stringify(CONV)});
    const page = await window.consensus.listConversationMessages({ conversationId: ${JSON.stringify(CONV)}, limit: 80 });
    return {
      title: c?.title,
      running: c?.metadata?.activeRunIds?.length || 0,
      sessions: JSON.stringify(c?.metadata?.participantSessions||{}).slice(0,400),
      msgs: (page.messages||[]).map(m => ({ role: m.role, content: (m.content||"").slice(0,260), warn: (m.metadata?.warnings||[]) }))
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
async function send(app, content) {
  await app.evaluate(`window.consensus.sendChatMessage({ conversationId: ${JSON.stringify(CONV)}, content: ${JSON.stringify(content)} })`, { awaitPromise: true });
}
function lastP(s){ return s.msgs.filter(m=>m.role==="participant").pop(); }

(async () => {
  const app = await attach({ port: 9224 });
  let base = (await snap(app)).msgs.filter(m=>m.role==="participant").length;
  console.log("base participant msgs:", base, "| sessions:", (await snap(app)).sessions);

  // T6: write a file into the repo
  const marker = "qa-gemini-write-proof.txt";
  try { fs.unlinkSync(marker); } catch {}
  console.log("\n=== T6 (repo write) ===");
  await send(app, `@gemini Create a file named ${marker} in the repository root containing exactly the text GEMINI_WROTE_THIS. Then reply DONE.`);
  const w = await waitIdle(app, base+1, 150000); base++;
  console.log("reply:", JSON.stringify(lastP(w)?.content?.slice(0,140)));
  await new Promise(r=>setTimeout(r,500));
  console.log("file exists:", fs.existsSync(marker), "content:", fs.existsSync(marker)?JSON.stringify(fs.readFileSync(marker,"utf8").trim()):"-");

  // T9: app MCP tool round-trip (read chat context)
  console.log("\n=== T9 (app MCP tool: app_chat_get_participants) ===");
  await send(app, "@gemini Use your available AccordAgents app tools to look up this chat's participants, then reply with exactly: PARTICIPANTS=<comma-separated handles>. Do not guess; call the tool.");
  const t9 = await waitIdle(app, base+1, 150000); base++;
  console.log("reply:", JSON.stringify(lastP(t9)?.content?.slice(0,200)), "warns:", JSON.stringify(lastP(t9)?.warn));

  // Missing-file read (rule out parser bug from turn 1)
  console.log("\n=== missing-file read (parser robustness) ===");
  await send(app, "@gemini Read the file DOES-NOT-EXIST-QA.txt in the repo root and tell me what happened. Reply in one sentence.");
  const mf = await waitIdle(app, base+1, 150000); base++;
  console.log("reply:", JSON.stringify(lastP(mf)?.content?.slice(0,200)), "warns:", JSON.stringify(lastP(mf)?.warn));

  console.log("\nFINAL sessions:", (await snap(app)).sessions);
  try { fs.unlinkSync(marker); } catch {}
  app.close();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
