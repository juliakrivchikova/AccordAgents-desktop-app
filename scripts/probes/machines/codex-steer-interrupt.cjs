const { execSync } = require("node:child_process");
const { start, INIT } = require("./codex-rpc.cjs");
const t0 = Date.now(); const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(2).padStart(7), ...a);
const mark = "CODEX_STEER_" + process.pid;
const pg = () => { try { return execSync(`pgrep -f "${mark}" | wc -l`).toString().trim(); } catch { return "?"; } };
(async () => {
  const s = start("[A]", log);
  const skip = new Set(["item/agentMessage/delta", "item/commandExecution/outputDelta", "thread/tokenUsage/updated", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/reasoning/summaryPartAdded", "account/rateLimits/updated"]);
  let threadId, turnId, phase = "T1"; let waiters = [];
  s.on((msg) => {
    if (msg.method && !skip.has(msg.method)) {
      const p = msg.params || {};
      const brief = msg.method === "item/started" || msg.method === "item/completed" ? (p.item?.type + " " + (p.item?.command ? JSON.stringify(p.item.command).slice(0, 60) : "") + " " + (p.item?.status || "")) : msg.method === "turn/completed" ? JSON.stringify(p.turn?.status ?? p).slice(0, 120) : JSON.stringify(p).slice(0, 120);
      log("[A] <-", msg.method, brief);
    }
    waiters = waiters.filter((w) => !w(msg));
  });
  const waitFor = (pred) => new Promise((res) => waiters.push((m) => { if (pred(m)) { res(m); return true; } return false; }));
  const init = await s.request("initialize", INIT); log("[A] initialized", JSON.stringify(init).slice(0, 80));
  const th = await s.request("thread/start", { cwd: process.env.PROBE_CWD || "/tmp/machines-probes", approvalPolicy: "never", sandbox: "workspace-write", ephemeral: false, model: null, developerInstructions: null, experimentalRawEvents: false, persistExtendedHistory: false });
  threadId = th.thread?.id; log("[A] thread", threadId, "model", th.model);
  // T1: steer while a command runs
  const t1 = await s.request("turn/start", { threadId, input: [{ type: "text", text: `Run exactly this command and report its output: python3 -c "import time; time.sleep(30); print('${mark}_A')"`, text_elements: [] }] });
  turnId = t1.turn?.id; log("[A] T1 turn", turnId);
  await waitFor((m) => m.method === "item/started" && m.params?.item?.type === "commandExecution");
  await new Promise((r) => setTimeout(r, 2000));
  try { const st = await s.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: "After that command finishes, also write the word PONG on its own line.", text_elements: [] }] }); log("[A] steer ->", JSON.stringify(st)); } catch (e) { log("[A] steer error", e.message); }
  const c1 = await waitFor((m) => m.method === "turn/completed"); log("[A] T1 completed", JSON.stringify(c1.params?.turn?.status));
  // T2: interrupt while a command runs
  const t2 = await s.request("turn/start", { threadId, input: [{ type: "text", text: `Run exactly this command and report its output: python3 -c "import time; time.sleep(40); print('${mark}_B')"`, text_elements: [] }] });
  turnId = t2.turn?.id; log("[A] T2 turn", turnId);
  await waitFor((m) => m.method === "item/started" && m.params?.item?.type === "commandExecution");
  await new Promise((r) => setTimeout(r, 3000));
  log("[A] tool children before interrupt:", pg());
  try { const ir = await s.request("turn/interrupt", { threadId, turnId }); log("[A] interrupt ->", JSON.stringify(ir)); } catch (e) { log("[A] interrupt error", e.message); }
  const c2 = await waitFor((m) => m.method === "turn/completed"); log("[A] T2 completed", JSON.stringify(c2.params?.turn?.status));
  await new Promise((r) => setTimeout(r, 1500)); log("[A] tool children 1.5s after interrupt:", pg());
  // T3: same process, next turn
  const t3 = await s.request("turn/start", { threadId, input: [{ type: "text", text: "Reply with exactly the word PING and nothing else.", text_elements: [] }] });
  const c3 = await waitFor((m) => m.method === "turn/completed"); log("[A] T3 completed", JSON.stringify(c3.params?.turn?.status));
  const items = await s.request("thread/items/list", { threadId, limit: 20 }).catch((e) => ({ error: e.message }));
  log("[A] items:", JSON.stringify(items).slice(0, 600));
  s.child.kill("SIGTERM"); try { execSync(`pkill -9 -f "${mark}" || true`); } catch {}
  log("[A] done");
})().catch((e) => { log("[A] FAILED", e.message); process.exit(1); });
setTimeout(() => { log("[A] timeout"); process.exit(2); }, 240000);
