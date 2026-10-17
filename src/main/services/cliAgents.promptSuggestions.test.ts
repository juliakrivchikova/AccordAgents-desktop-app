import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CliAgentRunner } from "./cliAgents";

/** A Claude Code stand-in on the warm stream-json transport: `--help` lists
 *  `--prompt-suggestions` only when `withFlag`, and with the flag it sends a
 *  `prompt_suggestion` a moment after each reply's result, as 2.1.280 does. */
async function claudeFixture(withFlag: boolean): Promise<{ dir: string; claudePath: string; argvFile: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-claude-suggestions-"));
  const claudePath = path.join(dir, "claude-fixture");
  const argvFile = path.join(dir, "argv.json");
  await writeFile(claudePath, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  // Like the real help, the flag sits past the first pipe-buffer's worth of
  // text, and the CLI exits right after writing it.
  const filler = Array.from({ length: 600 }, (_, index) => "  --option-" + index + "  An option that is not the one looked for.").join("\\n");
  process.stdout.write("Options:\\n  --print\\n" + filler + "\\n" + (${JSON.stringify(withFlag)} ? "  --prompt-suggestions [value]  Enable prompt suggestions.\\n" : ""));
  process.exit(0);
}
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));
if (argv.includes("--prompt-suggestions") && !${JSON.stringify(withFlag)}) {
  process.stderr.write("error: unknown option '--prompt-suggestions'\\n");
  process.exit(1);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let replies = 0;
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "user") return;
  replies += 1;
  const uuid = message.uuid;
  const text = "Reply " + replies + ".";
  send({ type: "command_lifecycle", command_uuid: uuid, state: "queued" });
  send({ type: "command_lifecycle", command_uuid: uuid, state: "started" });
  send({ type: "system", subtype: "init", session_id: "fixture-session" });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  send({ type: "result", subtype: "success", result: text });
  send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
  if (argv.includes("--prompt-suggestions")) {
    setTimeout(() => send({ type: "prompt_suggestion", suggestion: "run the tests " + replies, uuid: "s-" + replies, session_id: "fixture-session" }), 50);
  }
});
`, "utf8");
  await chmod(claudePath, 0o755);
  return { dir, claudePath, argvFile };
}

function warmRunner(claudePath: string, dir: string): CliAgentRunner {
  const runner = new CliAgentRunner();
  const internals = runner as unknown as Record<string, unknown>;
  internals.nativeProcessDbPath = path.join(dir, "native-processes.sqlite3");
  internals.providerExecutableForRun = async () => claudePath;
  return runner;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a Claude member's CLI runs with --prompt-suggestions and each suggestion reaches the run whose reply it follows", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const { dir, claudePath, argvFile } = await claudeFixture(true);
  const runner = warmRunner(claudePath, dir);
  const participant = { id: "claude-suggest", kind: "claude-code" as const, label: "Claude" };
  const received: string[] = [];
  const warm = (runId: string) => ({
    conversationId: "conversation-suggest",
    participantId: participant.id,
    contextKey: "context-suggest",
    idleTimeoutMs: 60_000,
    origin: { runId, messageId: `reply-${runId}` },
    onPromptSuggestion: (text: string) => received.push(`${runId}: ${text}`)
  });
  try {
    const first = await runner.run(participant, "First.", dir, undefined, "chat", undefined, { agentMode: "default", warm: warm("run-1") });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(JSON.parse(await readFile(argvFile, "utf8")).includes("--prompt-suggestions"));
    await waitFor(() => received.length === 1);
    assert.deepEqual(received, ["run-1: run the tests 1"]);

    const second = await runner.run(participant, "Second.", dir, undefined, "chat", undefined, { agentMode: "default", warm: warm("run-2") });
    assert.equal(second.ok, true, JSON.stringify(second));
    await waitFor(() => received.length === 2);
    assert.deepEqual(received, ["run-1: run the tests 1", "run-2: run the tests 2"], "each suggestion goes to its own reply, once");
  } finally {
    await runner.shutdownWarmAgents();
  }
});

test("an older Claude CLI without --prompt-suggestions is started without it and its turns still work", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const { dir, claudePath, argvFile } = await claudeFixture(false);
  const runner = warmRunner(claudePath, dir);
  const participant = { id: "claude-old", kind: "claude-code" as const, label: "Claude" };
  const received: string[] = [];
  try {
    const result = await runner.run(participant, "Hello.", dir, undefined, "chat", undefined, {
      agentMode: "default",
      warm: {
        conversationId: "conversation-old",
        participantId: participant.id,
        contextKey: "context-old",
        idleTimeoutMs: 60_000,
        onPromptSuggestion: (text: string) => received.push(text)
      }
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(JSON.parse(await readFile(argvFile, "utf8")).includes("--prompt-suggestions"), false);
    assert.deepEqual(received, []);
  } finally {
    await runner.shutdownWarmAgents();
  }
});
