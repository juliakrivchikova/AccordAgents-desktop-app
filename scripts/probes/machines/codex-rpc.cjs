// Minimal newline-delimited JSON-RPC client for `codex app-server --listen stdio://`.
const { spawn } = require("node:child_process");
function start(label, log) {
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], { cwd: process.env.PROBE_CWD || "/tmp/machines-probes", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
  let buf = ""; let nextId = 1; const pending = new Map(); const listeners = [];
  child.stdout.on("data", (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { log(label, "<- (non-json)", line.slice(0, 100)); continue; }
      if (msg.id !== undefined && msg.method === undefined) { const p = pending.get(msg.id); pending.delete(msg.id); if (p) { msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } continue; }
      if (msg.id !== undefined && msg.method) { log(label, "<- SERVER REQUEST " + msg.method + " " + JSON.stringify(msg.params).slice(0, 160)); listeners.forEach((l) => l(msg)); continue; }
      listeners.forEach((l) => l(msg));
    }
  });
  child.stderr.on("data", (d) => log(label, "stderr:", d.toString().trim().slice(0, 200)));
  const request = (method, params, timeoutMs = 120000) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout " + method)); } }, timeoutMs);
  });
  const respond = (id, result) => child.stdin.write(JSON.stringify({ id, result }) + "\n");
  const on = (fn) => listeners.push(fn);
  return { child, request, respond, on };
}
const INIT = { clientInfo: { name: "machines-probe", title: "machines-probe", version: "0.0.1" }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] } };
module.exports = { start, INIT };
