const { execSync } = require("node:child_process");
const { start, INIT } = require("./codex-rpc.cjs");
const t0 = Date.now(); const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(2).padStart(7), ...a);
const mark = "CODEX_INTR_" + process.pid;
const pg = () => { try { return execSync(`pgrep -f "${mark}" | wc -l`).toString().trim(); } catch { return "?"; } };
const skip = new Set(["item/agentMessage/delta", "item/commandExecution/outputDelta", "thread/tokenUsage/updated", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/reasoning/summaryPartAdded", "account/rateLimits/updated", "thread/status/changed", "mcpServer/startupStatus/updated", "warning"]);
(async () => {
  const s = start("[I]", log); let waiters = [];
  s.on((msg) => { if (msg.method && !skip.has(msg.method)) { const p = msg.params || {}; log("[I] <-", msg.method, msg.method.startsWith("item/") ? (p.item?.type + " " + (p.item?.status || "")) : JSON.stringify(p.turn?.status ?? p).slice(0, 80)); } waiters = waiters.filter((w) => !w(msg)); });
  const waitFor = (pred) => new Promise((res) => waiters.push((m) => { if (pred(m)) { res(m); return true; } return false; }));
  await s.request("initialize", INIT);
  const th = await s.request("thread/start", { cwd: process.env.PROBE_CWD || "/tmp/machines-probes", approvalPolicy: "never", sandbox: "workspace-write", ephemeral: true, model: null });
  const threadId = th.thread?.id;
  const t = await s.request("turn/start", { threadId, input: [{ type: "text", text: `Run exactly this command and report its output: python3 -c "import time; time.sleep(90); print('${mark}')"`, text_elements: [] }] });
  const turnId = t.turn?.id;
  await waitFor((m) => m.method === "item/started" && m.params?.item?.type === "commandExecution");
  await new Promise((r) => setTimeout(r, 3000));
  log("[I] children before interrupt:", pg());
  await s.request("turn/interrupt", { threadId, turnId });
  const c = await waitFor((m) => m.method === "turn/completed"); log("[I] turn/completed", JSON.stringify(c.params?.turn?.status));
  for (const d of [1, 3, 6, 10, 15]) { await new Promise((r) => setTimeout(r, d === 1 ? 1000 : (d - [0, 1, 3, 6, 10][[1, 3, 6, 10, 15].indexOf(d)]) * 1000)); log(`[I] children ${d}s after interrupt:`, pg()); }
  log("[I] SIGTERM app-server"); s.child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 3000)); log("[I] children 3s after app-server SIGTERM:", pg());
  try { execSync(`pkill -9 -f "${mark}" || true`); } catch {}
  log("[I] done"); process.exit(0);
})().catch((e) => { log("[I] FAILED", e.message); process.exit(1); });
setTimeout(() => { log("[I] timeout"); process.exit(2); }, 150000);
