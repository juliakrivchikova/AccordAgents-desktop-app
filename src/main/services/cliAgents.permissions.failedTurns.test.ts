import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cliParts } from "./cliAgents/test/cliParts";
import { makeRunner } from "./cliAgents/test/runnerFixtures";

// What a failed turn says it failed with (the User, 2026-11-25: "there must be
// a meaningful message of what happened, not just a fail").
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

async function runWith(source: string, prompt = "Hello.", extra: Record<string, unknown> = {}): Promise<{ result: any; logs: any[] }> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-failed-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  await writeFile(claudePath, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(claudePath, 0o755);
  const runner = makeRunner() as any;
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const logs: any[] = [];
  cliParts(runner).cliRuns.writeDebugLog = async (event: string, payload: Record<string, unknown>) => { logs.push({ event, ...payload }); };
  try {
    const result = await runner.run({ id: "claude-failed", kind: "claude-code", label: "@gera" }, prompt, fixtureDir, undefined, "chat", undefined, {
      agentMode: "default",
      warm: { conversationId: "c", participantId: "claude-failed", contextKey: "k", idleTimeoutMs: 60_000 },
      ...extra
    });
    return { result, logs };
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

test("a Claude Code that refuses to start its session says why, even though its input closes first", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  // What Claude Code 2.1.330 does with --resume of a session it has deleted
  // (recorded 2026-11-25): the reason on stdout and stderr, its input closed,
  // exit code 1. The message still being written then fails with EPIPE.
  const { result, logs } = await runWith(`
const { closeSync, writeSync } = require("node:fs");
setTimeout(() => {
  closeSync(0);
  setTimeout(() => {
    writeSync(1, JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: "212b79a7", errors: ["No conversation found with session ID: 212b79a7"] }) + "\\n");
    writeSync(2, "No conversation found with session ID: 212b79a7\\n");
    process.exit(1);
  }, 300);
}, 150);
`, "x".repeat(400_000), { sessionId: "212b79a7" });
  assert.equal(result.ok, false);
  assert.equal(result.content, "@gera stopped before it returned a response: No conversation found with session ID: 212b79a7");
  assert.ok(logs.some((entry) => entry.event === "cli-agent-warm-failed-without-replay" && /No conversation found/.test(entry.error)), JSON.stringify(logs));
});

test("the reason is kept when only the CLI's result says it", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const { result } = await runWith(`
const { writeSync } = require("node:fs");
writeSync(1, JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, errors: ["Session file is damaged"] }) + "\\n");
process.exit(1);
`);
  assert.equal(result.content, "@gera stopped before it returned a response: Session file is damaged");
});

test("a Claude Code ended from outside says by which signal", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const { result } = await runWith(`process.stderr.write("(node:1) Warning: something at startup\\n"); setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);`);
  assert.equal(result.content, "@gera stopped before it returned a response: Claude Code was ended by SIGKILL.");
});

test("what it wrote before the step that failed is not that step's reason", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const { result } = await runWith(`
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stderr.write("Error: an MCP server did not start\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "user") return;
  setTimeout(() => {
    send({ type: "command_lifecycle", command_uuid: message.uuid, state: "started" });
    send({ type: "system", subtype: "init", session_id: "s" });
    setTimeout(() => process.exit(3), 100);
  }, 200);
});
`);
  assert.equal(result.content, "@gera stopped before it returned a response: Claude Code exited with code 3.");
});

test("a usage limit is said in Claude Code's own words", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const { result } = await runWith(`
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "user") return;
  send({ type: "command_lifecycle", command_uuid: message.uuid, state: "started" });
  send({ type: "system", subtype: "init", session_id: "s" });
  send({ type: "result", subtype: "success", is_error: true, result: "You've hit your weekly limit · resets Sep 20 at 7pm (Asia/Nicosia)", session_id: "s" });
});
`);
  assert.equal(result.content, "@gera: You've hit your weekly limit · resets Sep 20 at 7pm (Asia/Nicosia)");
});

test("a turn's error list is read, not replaced by our own words", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const { result } = await runWith(`
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "user") return;
  send({ type: "command_lifecycle", command_uuid: message.uuid, state: "started" });
  send({ type: "system", subtype: "init", session_id: "s" });
  send({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null", "The request was too large."], session_id: "s" });
});
`);
  assert.equal(result.content, "@gera: The request was too large.");
});
