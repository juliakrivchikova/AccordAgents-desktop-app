// Probe: Claude Code bidirectional stream-json — interrupt via control_request, then queued input on the same process.
const { spawn } = require("node:child_process");
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(2).padStart(7), ...a);
const args = ["-p", "--verbose", "--include-partial-messages", "--input-format", "stream-json", "--output-format", "stream-json",
  "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--model", "claude-haiku-4-5-20251001"];
const child = spawn("claude", args, { cwd: process.env.PROBE_CWD || "/tmp/machines-probes", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
let buf = ""; let interrupted = false; let sessionId; let turn = 1; let toolUseSeen = false; let controlResponses = 0;
const send = (obj) => { const s = JSON.stringify(obj); log("-> " + s.slice(0, 160)); child.stdin.write(s + "\n"); };
const user = (text) => send({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { log("<- (non-json)", line.slice(0, 120)); continue; }
    const sub = ev.subtype ? "/" + ev.subtype : "";
    if (ev.type === "system" && ev.subtype === "init") { sessionId = ev.session_id; log("<- system/init session=" + sessionId + " model=" + ev.model); continue; }
    if (ev.type === "stream_event") { const e = ev.event; if (e?.type === "content_block_start") log("<- stream content_block_start", e.content_block?.type, e.content_block?.name || ""); continue; }
    if (ev.type === "assistant") {
      const kinds = (ev.message?.content || []).map((c) => c.type + (c.name ? ":" + c.name : "")).join(",");
      log("<- assistant [" + kinds + "]");
      if (!toolUseSeen && kinds.includes("tool_use:Bash") && turn === 1) {
        toolUseSeen = true;
        setTimeout(() => { interrupted = true; send({ type: "control_request", request_id: "int-1", request: { subtype: "interrupt" } }); }, 1500);
      }
      continue;
    }
    if (ev.type === "control_response") { controlResponses += 1; log("<- control_response " + JSON.stringify(ev).slice(0, 200)); continue; }
    if (ev.type === "control_request") { log("<- control_request " + JSON.stringify(ev).slice(0, 200)); continue; }
    if (ev.type === "user") { const c = ev.message?.content; const s = Array.isArray(c) ? c.map((x) => x.type + (x.is_error ? "(error)" : "")).join(",") : typeof c; log("<- user/tool_result [" + s + "]" + (ev.tool_use_result ? " " + JSON.stringify(ev.tool_use_result).slice(0, 100) : "")); continue; }
    if (ev.type === "result") {
      log("<- result" + sub + " is_error=" + ev.is_error + " turns=" + ev.num_turns + " text=" + JSON.stringify((ev.result || "").slice(0, 120)));
      if (turn === 1) { turn = 2; setTimeout(() => user("Reply with exactly the word PONG and nothing else."), 500); }
      else { child.stdin.end(); }
      continue;
    }
    log("<- " + ev.type + sub + " " + JSON.stringify(ev).slice(0, 140));
  }
});
child.stderr.on("data", (d) => log("stderr:", d.toString().trim().slice(0, 200)));
child.on("exit", (code, sig) => { log("exit code=" + code + " sig=" + sig + " interrupted=" + interrupted + " controlResponses=" + controlResponses); });
user("Run this exact Bash command and then tell me the output: sleep 40; echo PROBE_DONE");
setTimeout(() => { log("timeout; killing"); child.kill("SIGKILL"); }, 120000);
