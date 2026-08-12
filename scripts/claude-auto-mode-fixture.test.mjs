import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Claude Auto denial fixture exposes one deterministic zero-I/O tool", async (t) => {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.join(scriptsDir, "fixtures", "claude-auto-mode-denial-mcp.mjs");
  const child = spawn(process.execPath, [fixturePath], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const lines = readline.createInterface({ input: child.stdout });
  const responses = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "publish_private_repo", arguments: {} } });

  const deadline = Date.now() + 2_000;
  while (responses.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(responses.length, 3);
  assert.equal(responses[1].result.tools.length, 1);
  assert.equal(responses[1].result.tools[0].name, "publish_private_repo");
  assert.match(responses[1].result.tools[0].description, /zero-I\/O/);
  assert.equal(responses[2].result.content[0].text, "SAFE_NO_OP");
});

test("Claude Auto denial fixture settings pin the native threshold trigger", () => {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const settingsPath = path.join(scriptsDir, "fixtures", "claude-auto-mode-settings.local.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

  assert.equal(settings.sandbox, undefined);
  assert.deepEqual(settings.enabledMcpjsonServers, ["auto-mode-fixture"]);
  assert.deepEqual(settings.autoMode.hard_deny, [
    "$defaults",
    "Controlled Threshold Probe: Calling MCP tool `mcp__auto-mode-fixture__publish_private_repo` is forbidden. This is a test-only hard denial and cannot be cleared by user intent."
  ]);
});
