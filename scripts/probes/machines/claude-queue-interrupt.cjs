// Probe 2: (A) user message sent while a tool runs -> queued? (B) interrupt while a tool is actually running -> process survives, next turn works.
const { spawn } = require("node:child_process");
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(2).padStart(7), ...a);
const args = ["-p", "--verbose", "--include-partial-messages", "--input-format", "stream-json", "--output-format", "stream-json", "--replay-user-messages",
  "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--model", "claude-haiku-4-5-20251001"];
const child = spawn("claude", args, { cwd: process.env.PROBE_CWD || "/tmp/machines-probes", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
let buf = ""; let phase = "A1"; let results = 0;
const send = (obj) => { const s = JSON.stringify(obj); log("-> " + s.slice(0, 140)); child.stdin.write(s + "\n"); };
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
      if (kinds.includes("tool_use:Bash")) {
        if (phase === "A1") { phase = "A2"; setTimeout(() => user("QUEUED: reply with exactly the word PONG."), 2000); }
        else if (phase === "B1") { phase = "B2"; setTimeout(() => send({ type: "control_request", request_id: "int-B", request: { subtype: "interrupt" } }), 3000); }
      }
      continue;
    }
    if (ev.type === "user") {
      const c = ev.message?.content; const s = Array.isArray(c) ? c.map((x) => x.type + (x.is_error ? "(error)" : "")).join(",") : typeof c;
      log("<- user [" + s + "]" + (ev.tool_use_result ? " " + JSON.stringify(ev.tool_use_result).slice(0, 90) : "") + (typeof c === "string" ? " " + JSON.stringify(c.slice(0, 60)) : ""));
      continue;
    }
    if (ev.type === "control_response") { log("<- control_response " + JSON.stringify(ev.response).slice(0, 160)); continue; }
    if (ev.type === "result") {
      results += 1;
      log("<- result/" + ev.subtype + " is_error=" + ev.is_error + " turns=" + ev.num_turns + " text=" + JSON.stringify((ev.result || "").slice(0, 100)));
      if (phase === "A2" && results === 1) { log("   (A) first result after queued message; waiting for the queued turn"); continue; }
      if (phase === "A2" && results === 2) { phase = "B1"; setTimeout(() => user("Run this exact Bash command and tell me its output: python3 -c \"import time; time.sleep(40); print('B_DONE')\""), 500); continue; }
      if (phase === "B2") { phase = "C"; setTimeout(() => user("Reply with exactly the word PING and nothing else."), 500); continue; }
      if (phase === "C") { child.stdin.end(); continue; }
      continue;
    }
    log("<- " + ev.type + "/" + (ev.subtype || "") + " " + JSON.stringify(ev).slice(0, 120));
  }
});
child.stderr.on("data", (d) => log("stderr:", d.toString().trim().slice(0, 160)));
child.on("exit", (code, sig) => log("exit code=" + code + " sig=" + sig + " results=" + results + " phase=" + phase));
user("Run this exact Bash command and tell me its output: python3 -c \"import time; time.sleep(20); print('A_DONE')\"");
setTimeout(() => { log("timeout; killing"); child.kill("SIGKILL"); }, 170000);
