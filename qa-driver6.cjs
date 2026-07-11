const { attach } = require("./scripts/cdp.cjs");
const REPO = "/Users/ysvetlichnaya/IdeaProjects/AccordAgents-gemini";

async function snap(app, conv) {
  const res = await app.evaluate(`(async () => {
    const c = await window.consensus.getConversation(${JSON.stringify(conv)});
    const page = await window.consensus.listConversationMessages({ conversationId: ${JSON.stringify(conv)}, limit: 60 });
    const gem = (c?.metadata?.participants||[]).find(p=>p.handle==="gemini");
    const sess = (c?.metadata?.participantSessions||[]).find(s=>s.participantKind==="gemini-cli");
    return {
      running: c?.metadata?.activeRunIds?.length || 0,
      session: sess?.sessionId || null,
      ctx: sess?.contextUsage ? (sess.contextUsage.percentage+"% src="+sess.contextUsage.source) : null,
      caps: sess?.roleAppToolCapabilities || gem?.roleAppToolCapabilities || [],
      msgs: (page.messages||[]).map(m => ({ role: m.role, content: (m.content||"").slice(0,240), warn: (m.metadata?.warnings||[]) }))
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
async function send(app, conv, content) {
  await app.evaluate(`window.consensus.sendChatMessage({ conversationId: ${JSON.stringify(conv)}, content: ${JSON.stringify(content)} })`, { awaitPromise: true });
}
function lastP(s){ return s.msgs.filter(m=>m.role==="participant").pop(); }

(async () => {
  const app = await attach({ port: 9224 });
  const perms = { repoRead: true, workspaceWrite: false, webAccess: false, shell: { enabled: false, rules: [] } };
  const create = await app.evaluate(`(async () => {
    const r = await window.consensus.createChatConversation({
      title: "Gemini QA Medium", repoPath: ${JSON.stringify(REPO)}, skipDefaultParticipants: true,
      participants: [{ handle: "gemini", roleConfigId: "generic-participant", kind: "gemini-cli", model: "Gemini 3.5 Flash (Medium)", agentMode: "default", permissions: ${JSON.stringify(perms)} }]
    });
    return r.conversationId || r.conversation?.id;
  })()`, { awaitPromise: true });
  const conv = create.result.value;
  console.log("CONV:", conv);

  console.log("\n=== T3 fresh: repo read ===");
  await send(app, conv, "@gemini Read Makefile in the repo root and reply with exactly the first target name, nothing else.");
  const s1 = await waitIdle(app, conv, 1, 240000);
  console.log("session:", s1.session, "| ctx:", s1.ctx, "| caps:", JSON.stringify(s1.caps));
  console.log("reply:", JSON.stringify(lastP(s1)?.content?.slice(0,120)), "warn:", JSON.stringify(lastP(s1)?.warn));

  console.log("\n=== T9: app MCP tool round-trip (read participants) ===");
  await send(app, conv, "@gemini Call your AccordAgents app tool to get this chat's participants, then reply PARTICIPANTS=<handles>. You must call the tool, do not guess.");
  const s2 = await waitIdle(app, conv, 2, 300000);
  console.log("session(same=" + (s2.session===s1.session) + ")");
  console.log("reply:", JSON.stringify(lastP(s2)?.content?.slice(0,220)), "warn:", JSON.stringify(lastP(s2)?.warn));
  app.close();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
