const { attach } = require("./scripts/cdp.cjs");
const CONV = "c483a170-08d5-4888-adb3-2b27686e4471";
const REPO = "/Users/ysvetlichnaya/IdeaProjects/AccordAgents-gemini";

async function snap(app, conv) {
  const res = await app.evaluate(`(async () => {
    const c = await window.consensus.getConversation(${JSON.stringify(conv)});
    const page = await window.consensus.listConversationMessages({ conversationId: ${JSON.stringify(conv)}, limit: 60 });
    const parts = c?.metadata?.participants || [];
    const gem = parts.find(p => p.handle === "gemini");
    return {
      running: c?.metadata?.activeRunIds?.length || 0,
      gemKeys: gem ? Object.keys(gem) : [],
      sessionRaw: gem ? JSON.stringify(gem).slice(0, 600) : null,
      msgs: (page.messages||[]).map(m => ({ role: m.role, content: (m.content||"").slice(0,260), err: m.metadata?.error||null, warn: m.metadata?.warnings||[] }))
    };
  })()`, { awaitPromise: true });
  return res.result.value;
}
async function waitIdle(app, conv, wantP, timeoutMs) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeoutMs) {
    last = await snap(app, conv);
    if (last.running === 0 && last.msgs.filter(m=>m.role==="participant").length >= wantP) return last;
    await new Promise(r => setTimeout(r, 2500));
  }
  return last;
}
(async () => {
  const app = await attach({ port: 9224 });
  // Inspect turn-1 failure detail on existing conv
  const cur = await snap(app, CONV);
  console.log("=== gem participant keys:", JSON.stringify(cur.gemKeys));
  console.log("=== gem raw:", cur.sessionRaw);
  const failed = cur.msgs.find(m => m.role==="participant" && /failed before/.test(m.content));
  console.log("=== turn1 failed msg err:", JSON.stringify(failed?.err), "warn:", JSON.stringify(failed?.warn));

  // Fresh conversation, first-turn reliability test
  const perms = { repoRead: true, workspaceWrite: false, webAccess: false, shell: { enabled: false, rules: [] } };
  const create = await app.evaluate(`(async () => {
    const r = await window.consensus.createChatConversation({
      title: "Gemini QA First-Turn", repoPath: ${JSON.stringify(REPO)}, skipDefaultParticipants: true,
      participants: [{ handle: "gemini", roleConfigId: "generic-participant", kind: "gemini-cli", model: "Gemini 3.5 Flash (Low)", agentMode: "default", permissions: ${JSON.stringify(perms)} }]
    });
    return r.conversationId || r.conversation?.id;
  })()`, { awaitPromise: true });
  const conv2 = create.result.value;
  console.log("\n=== FRESH CONV:", conv2);
  await app.evaluate(`window.consensus.sendChatMessage({ conversationId: ${JSON.stringify(conv2)}, content: "@gemini Reply with exactly the word READY and nothing else." })`, { awaitPromise: true });
  const fr = await waitIdle(app, conv2, 1, 150000);
  const p = fr.msgs.filter(m=>m.role==="participant").pop();
  console.log("first-turn reply:", JSON.stringify(p?.content?.slice(0,180)), "err:", JSON.stringify(p?.err));
  require("fs").writeFileSync("/tmp/qa-firstturn.json", JSON.stringify({cur, fr}, null, 2));
  app.close();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
