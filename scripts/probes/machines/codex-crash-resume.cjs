const { execSync } = require("node:child_process");
const { start, INIT } = require("./codex-rpc.cjs");
const t0 = Date.now(); const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(2).padStart(7), ...a);
const mark = "CODEX_CRASH_" + process.pid;
const pg = () => { try { return execSync(`pgrep -fl "${mark}" | grep -v pgrep | cut -c1-90 | tr '\\n' '|'`).toString().trim() || "(none)"; } catch { return "?"; } };
const skip = new Set(["item/agentMessage/delta", "item/commandExecution/outputDelta", "thread/tokenUsage/updated", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/reasoning/summaryPartAdded", "account/rateLimits/updated", "thread/status/changed"]);
function wire(s, label) {
  let waiters = [];
  s.on((msg) => {
    if (msg.method && !skip.has(msg.method)) { const p = msg.params || {}; log(label, "<-", msg.method, msg.method.startsWith("item/") ? (p.item?.type + " " + (p.item?.status || "")) : JSON.stringify(p).slice(0, 100)); }
    waiters = waiters.filter((w) => !w(msg));
  });
  return (pred) => new Promise((res) => waiters.push((m) => { if (pred(m)) { res(m); return true; } return false; }));
}
(async () => {
  const a = start("[R1]", log); const waitA = wire(a, "[R1]");
  await a.request("initialize", INIT);
  const th = await a.request("thread/start", { cwd: process.env.PROBE_CWD || "/tmp/machines-probes", approvalPolicy: "never", sandbox: "workspace-write", ephemeral: false, model: null, developerInstructions: null, experimentalRawEvents: false, persistExtendedHistory: false });
  const threadId = th.thread?.id; log("[R1] thread", threadId);
  const t1 = await a.request("turn/start", { threadId, input: [{ type: "text", text: `Run exactly this command and report its output: python3 -c "import time; time.sleep(60); print('${mark}')"`, text_elements: [] }] });
  log("[R1] turn", t1.turn?.id);
  await waitA((m) => m.method === "item/started" && m.params?.item?.type === "commandExecution");
  await new Promise((r) => setTimeout(r, 3000));
  log("[R1] tool children before kill:", pg());
  a.child.kill("SIGKILL"); log("[R1] app-server killed -9");
  await new Promise((r) => setTimeout(r, 2000));
  log("[R1] tool children after kill:", pg());
  const b = start("[R2]", log); const waitB = wire(b, "[R2]");
  await b.request("initialize", INIT);
  const rs = await b.request("thread/resume", { threadId, cwd: process.env.PROBE_CWD || "/tmp/machines-probes", approvalPolicy: "never", sandbox: "workspace-write", excludeTurns: false, persistExtendedHistory: false }).catch((e) => ({ error: e.message }));
  log("[R2] resume ->", JSON.stringify(rs).slice(0, 300));
  const items = await b.request("thread/items/list", { threadId, limit: 20 }).catch((e) => ({ error: e.message }));
  log("[R2] items after resume:", JSON.stringify(items).slice(0, 700));
  const t2 = await b.request("turn/start", { threadId, input: [{ type: "text", text: "Did your last command finish and what was its output? Answer from the thread record only; do not run anything.", text_elements: [] }] });
  log("[R2] turn", t2.turn?.id);
  const done = await waitB((m) => m.method === "turn/completed");
  const items2 = await b.request("thread/items/list", { threadId, limit: 30 }).catch((e) => ({ error: e.message }));
  const texts = (items2.data || []).map((d) => d.item || d).filter((i) => i.type === "agentMessage").map((i) => (i.text || "").slice(0, 300));
  log("[R2] agent messages:", JSON.stringify(texts).slice(0, 500));
  b.child.kill("SIGTERM"); try { execSync(`pkill -9 -f "${mark}" || true`); } catch {}
  log("[R2] done");
})().catch((e) => { log("FAILED", e.message); process.exit(1); });
setTimeout(() => { log("timeout"); process.exit(2); }, 200000);
