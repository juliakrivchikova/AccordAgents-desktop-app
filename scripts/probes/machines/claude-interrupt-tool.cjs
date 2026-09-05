// Probe B: interrupt while a Bash tool is actually running; check the tool child is killed and the process serves the next turn.
const { spawn, execSync } = require("node:child_process");
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(2).padStart(7), ...a);
const marker = "INT_PROBE_" + process.pid;
const args = ["-p", "--verbose", "--include-partial-messages", "--input-format", "stream-json", "--output-format", "stream-json",
  "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--model", "claude-haiku-4-5-20251001"];
const child = spawn("claude", args, { cwd: process.env.PROBE_CWD || "/tmp/machines-probes", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
let buf = ""; let phase = "B"; let results = 0;
const pg = () => { try { return execSync(`pgrep -f "${marker}" | wc -l`).toString().trim(); } catch { return "?"; } };
const send = (obj) => { const s = JSON.stringify(obj); log("-> " + s.slice(0, 120)); child.stdin.write(s + "\n"); };
const user = (text) => send({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
child.stdout.on("data", (d) => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "stream_event" || ev.type === "rate_limit_event" || (ev.type === "system" && ev.subtype !== "init")) continue;
    if (ev.type === "system") { log("<- system/init"); continue; }
    if (ev.type === "assistant") {
      const kinds = (ev.message?.content || []).map((c) => c.type + (c.name ? ":" + c.name : "")).join(",");
      log("<- assistant [" + kinds + "]");
      if (kinds.includes("tool_use:Bash") && phase === "B") {
        phase = "B-int";
        setTimeout(() => { log("tool child processes before interrupt: " + pg()); send({ type: "control_request", request_id: "int-B", request: { subtype: "interrupt" } }); }, 3000);
      }
      continue;
    }
    if (ev.type === "user") { const c = ev.message?.content; log("<- user [" + (Array.isArray(c) ? c.map((x) => x.type + (x.is_error ? "(error)" : "")).join(",") : typeof c) + "]" + (ev.tool_use_result ? " " + JSON.stringify(ev.tool_use_result).slice(0, 110) : "")); continue; }
    if (ev.type === "control_response") { log("<- control_response " + JSON.stringify(ev.response).slice(0, 160)); setTimeout(() => log("tool child processes 1.5s after interrupt: " + pg()), 1500); continue; }
    if (ev.type === "result") {
      results += 1;
      log("<- result/" + ev.subtype + " is_error=" + ev.is_error + " turns=" + ev.num_turns + " text=" + JSON.stringify((ev.result || "").slice(0, 100)));
      if (phase === "B-int") { phase = "C"; setTimeout(() => user("Reply with exactly the word PING and nothing else."), 2500); continue; }
      if (phase === "C") { setTimeout(() => child.stdin.end(), 200); continue; }
      continue;
    }
  }
});
child.stderr.on("data", (d) => log("stderr:", d.toString().trim().slice(0, 160)));
child.on("exit", (code, sig) => { log("exit code=" + code + " sig=" + sig + " results=" + results + " phase=" + phase + " tool children at exit: " + pg()); try { execSync(`pkill -9 -f "${marker}" || true`); } catch {} });
user(`Run this exact Bash command and tell me its output: python3 -c "import time; time.sleep(50); print('${marker}')"`);
setTimeout(() => { log("timeout; killing"); child.kill("SIGKILL"); }, 120000);
