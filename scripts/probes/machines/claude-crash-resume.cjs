// Probe 3: kill -9 the CLI mid-tool, check for an orphaned tool process, then --resume the session and ask what happened.
const { spawn, execSync } = require("node:child_process");
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(2).padStart(7), ...a);
const base = ["-p", "--verbose", "--include-partial-messages", "--input-format", "stream-json", "--output-format", "stream-json",
  "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--model", "claude-haiku-4-5-20251001"];
const marker = "CRASH_PROBE_" + process.pid;
function run(extraArgs, firstMessage, onEvent, label) {
  return new Promise((resolve) => {
    const child = spawn("claude", [...base, ...extraArgs], { cwd: process.env.PROBE_CWD || "/tmp/machines-probes", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    let buf = ""; const state = { child, sessionId: undefined, resultText: "" };
    child.stdout.on("data", (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "system" && ev.subtype === "init") { state.sessionId = ev.session_id; log(label, "<- init session=" + ev.session_id); }
        if (ev.type === "assistant") log(label, "<- assistant [" + (ev.message?.content || []).map((c) => c.type + (c.name ? ":" + c.name : "")).join(",") + "]");
        if (ev.type === "user") { const c = ev.message?.content; log(label, "<- user [" + (Array.isArray(c) ? c.map((x) => x.type + (x.is_error ? "(error)" : "")).join(",") : typeof c) + "]" + (ev.tool_use_result ? " " + JSON.stringify(ev.tool_use_result).slice(0, 120) : "")); }
        if (ev.type === "result") { state.resultText = ev.result || ""; log(label, "<- result/" + ev.subtype + " is_error=" + ev.is_error + " text=" + JSON.stringify(state.resultText.slice(0, 220))); }
        onEvent(ev, state);
      }
    });
    child.stderr.on("data", (d) => log(label, "stderr:", d.toString().trim().slice(0, 160)));
    child.on("exit", (code, sig) => { log(label, "exit code=" + code + " sig=" + sig); resolve(state); });
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: firstMessage }] } }) + "\n");
    state.end = () => child.stdin.end();
  });
}
(async () => {
  const first = await run([], `Run this exact Bash command and tell me its output: python3 -c "import time; time.sleep(60); print('${marker}')"`, (ev, st) => {
    if (ev.type === "assistant" && (ev.message?.content || []).some((c) => c.type === "tool_use" && c.name === "Bash")) {
      setTimeout(() => {
        try { log("orphan check BEFORE kill:", execSync(`pgrep -fl "${marker}" || true`).toString().trim().replace(/\n/g, " | ")); } catch {}
        log("-> kill -9 claude pid=" + st.child.pid); st.child.kill("SIGKILL");
      }, 3000);
    }
  }, "[run1]");
  await new Promise((r) => setTimeout(r, 1500));
  try { log("orphan check AFTER kill:", execSync(`pgrep -fl "${marker}" || true`).toString().trim().replace(/\n/g, " | ") || "(none)"); } catch {}
  const second = await run(["--resume", first.sessionId], "Did the last Bash command finish, and what was its output? Answer from the session record only; do not run anything.", (ev, st) => {
    if (ev.type === "result") setTimeout(() => st.end(), 200);
  }, "[resume]");
  try { execSync(`pkill -9 -f "${marker}" || true`); } catch {}
  log("done; resumed session=" + second.sessionId + " same=" + (second.sessionId === first.sessionId));
})();
