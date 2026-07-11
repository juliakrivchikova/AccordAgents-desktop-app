const { attach } = require("./scripts/cdp.cjs");
const CONV = "c483a170-08d5-4888-adb3-2b27686e4471";

async function snapshot(app) {
  const res = await app.evaluate(`(async () => {
    const conv = await window.consensus.getConversation(${JSON.stringify(CONV)});
    const page = await window.consensus.listConversationMessages({ conversationId: ${JSON.stringify(CONV)}, limit: 50 });
    const parts = conv?.metadata?.participants || [];
    const gem = parts.find(p => p.handle === "gemini");
    const msgs = (page.messages||[]).map(m => ({ role: m.role, handle: m.participantHandle||m.metadata?.participantHandle, content: (m.content||""), warn: (m.metadata?.warnings||[]) }));
    return {
      running: conv?.metadata?.activeRunIds?.length || 0,
      session: gem?.session?.sessionId || null,
      ctxPct: gem?.session?.contextUsage?.percentage ?? null,
      ctxSrc: gem?.session?.contextUsage?.source ?? null,
      msgs
    };
  })()`, { awaitPromise: true });
  return res.result.value;
}
async function waitIdle(app, wantParticipantMsgs, timeoutMs) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await snapshot(app);
    const pm = last.msgs.filter(m => m.role === "participant").length;
    if (last.running === 0 && pm >= wantParticipantMsgs) return last;
    await new Promise(r => setTimeout(r, 2500));
  }
  return last;
}
async function send(app, content) {
  await app.evaluate(`window.consensus.sendChatMessage({ conversationId: ${JSON.stringify(CONV)}, content: ${JSON.stringify(content)} })`, { awaitPromise: true });
}
function lastPart(s) { return s.msgs.filter(m=>m.role==="participant").pop(); }

(async () => {
  const app = await attach({ port: 9224 });
  // Turn 1 (already sent, asked for non-existent VERSION). Drain it.
  const s1 = await waitIdle(app, 1, 150000);
  console.log("=== TURN1 (repo read attempt) ===");
  console.log("session:", s1.session, "| ctx:", s1.ctxPct + "% src=" + s1.ctxSrc);
  console.log("reply:", JSON.stringify((lastPart(s1)?.content||"").slice(0,220)), "warns:", JSON.stringify(lastPart(s1)?.warn));

  // Turn 2: real repo read
  console.log("\n=== TURN2 (repo read: package.json version) ===");
  await send(app, "@gemini Read package.json in the repository root and reply with exactly: NAME=<name> VERSION=<version> using the values from that file, nothing else.");
  const s2 = await waitIdle(app, 2, 150000);
  console.log("session(same=" + (s2.session===s1.session) + "):", s2.session, "| ctx:", s2.ctxPct + "%");
  console.log("reply:", JSON.stringify((lastPart(s2)?.content||"").slice(0,220)));

  // Turn 3: resume recall (no re-read)
  console.log("\n=== TURN3 (resume recall) ===");
  await send(app, "@gemini Without reading any file again, what exact VERSION value did you just report? Reply with only that value.");
  const s3 = await waitIdle(app, 3, 150000);
  console.log("session(same=" + (s3.session===s2.session) + "):", s3.session);
  console.log("reply:", JSON.stringify((lastPart(s3)?.content||"").slice(0,160)));

  require("fs").writeFileSync("/tmp/qa-results.json", JSON.stringify({s1,s2,s3}, null, 2));
  app.close();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
