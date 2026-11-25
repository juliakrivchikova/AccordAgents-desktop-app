// What the CLI runner's tests set up.
import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliAgentRunner } from "../../cliAgents";
import { defaultChatAgentPermissions } from "../../../../shared/agentPermissions";

export function makeRunner(): CliAgentRunner {
  return new CliAgentRunner();
}

export async function writeCodexAppServerFixture(fixtureDir: string, source: string): Promise<string> {
  await writeFile(path.join(fixtureDir, "app-server"), source, "utf8");
  return process.execPath;
}

export function makeCodexPendingTurn(overrides: Partial<Record<string, unknown>> = {}): Record<string, any> {
  const timer = setTimeout(() => undefined, 1);
  clearTimeout(timer);
  return {
    startedAt: Date.now(),
    threadId: "thread-1",
    messages: [],
    streamedText: "",
    visibleTranscript: "",
    activityItems: new Map(),
    completedAgentMessages: [],
    nextAgentMessageStartsBlock: false,
    timer,
    onOutput: undefined,
    resolve: undefined,
    reject: undefined,
    ...overrides
  };
}

export function chatOptions(overrides: {
  agentMode: "default" | "plan" | "auto" | "full-access";
  workspaceWrite: boolean;
  webAccess?: boolean;
  shell?: ReturnType<typeof defaultChatAgentPermissions>["shell"];
  canRequestPermissions?: boolean;
  appToolNames?: string[];
  autoPreauthorizedToolNames?: string[];
}) {
  const permissions = defaultChatAgentPermissions();
  const appToolNames = overrides.appToolNames ?? ["app_permissions_request_change"];
  return {
    agentMode: overrides.agentMode,
    permissions: {
      ...permissions,
      repoRead: true,
      workspaceWrite: overrides.workspaceWrite,
      webAccess: overrides.webAccess ?? false,
      shell: overrides.shell ?? permissions.shell
    },
    appMcp: overrides.canRequestPermissions
      ? {
          url: "http://127.0.0.1:1/mcp",
          token: "token",
          toolNames: appToolNames,
          autoPreauthorizedToolNames: overrides.autoPreauthorizedToolNames ?? appToolNames.filter((toolName) =>
            toolName !== "app_tool_permission" && toolName !== "app_chat_export_attachment"
          )
        }
      : undefined
  };
}

export function testProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function assertFixtureProcessStops(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40 && testProcessExists(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(testProcessExists(pid), false, `provider descendant ${pid} survived warm-agent shutdown`);
}

/** A Claude Code 2.1.280 stand-in for compaction: keeps its conversation in
 *  memory (what its next reply's context counts), compacts it on `/compact`
 *  with the boundary the real CLI emits, and answers `get_context_usage` as
 *  the real CLI does (verified against 2.1.280 on 2026-10-22). */
export async function writeClaudeCompactionFixture(fixtureDir: string, options: { contextUsageAnswer?: "success" | "error" } = {}): Promise<{ claudePath: string; log: string; finishBackground: () => Promise<void> }> {
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const log = path.join(fixtureDir, "fixture-log.jsonl");
  // The background task ends when the test says so, not after a delay.
  const finishFile = path.join(fixtureDir, "finish-background");
  await writeFile(claudePath, `#!/usr/bin/env node
const { appendFileSync, existsSync } = require("node:fs");
const readline = require("node:readline");
const log = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
log({ started: process.argv.slice(2) });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
// What this process holds in memory: a resumed session starts from what the
// session file holds, which a compaction elsewhere would have shrunk.
const resumed = process.argv.includes("--resume");
let messagesTokens = resumed ? 9000 : 0;
let holding;
let running = false;
let answerTaskAfter = false;
const baseline = 20000;
const compactNow = () => {
  send({ type: "system", subtype: "init", session_id: "fixture-session" });
  const pre = baseline + messagesTokens;
  messagesTokens = 9000;
  send({ type: "system", subtype: "compact_boundary", session_id: "fixture-session", compact_metadata: { trigger: "manual", pre_tokens: pre, post_tokens: messagesTokens } });
  send({ type: "user", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } });
  send({ type: "result", subtype: "success", result: "", session_id: "fixture-session", usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } });
};
const answerTask = () => {
  send({ type: "system", subtype: "init", session_id: "fixture-session" });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Background done." }] } });
  send({ type: "result", subtype: "success", result: "Background done.", session_id: "fixture-session", usage: { input_tokens: 2, cache_read_input_tokens: 99997, cache_creation_input_tokens: 0, output_tokens: 1 } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    log({ control: message.request.subtype });
    if (message.request.subtype === "interrupt" && holding) {
      // What Claude Code 2.1.280 answers when a /compact is interrupted
      // (verified 2026-10-25): its words, a successful empty result.
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
      send({ type: "system", subtype: "status", session_id: "fixture-session" });
      send({ type: "system", subtype: "init", session_id: "fixture-session" });
      send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Compaction canceled." }] } });
      send({ type: "result", subtype: "success", is_error: false, result: "", session_id: "fixture-session" });
      send({ type: "command_lifecycle", command_uuid: holding, state: "cancelled" });
      holding = undefined;
      return;
    }
    if (message.request.subtype === "get_context_usage") {
      send(${options.contextUsageAnswer === "error"
        ? `{ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "Unknown request" } }`
        : `{ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { totalTokens: baseline + messagesTokens, maxTokens: 1000000, percentage: 3 } } }`});
    } else {
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    }
    return;
  }
  const text = message.message.content[0].text;
  log({ message: text });
  const uuid = message.uuid;
  send({ type: "command_lifecycle", command_uuid: uuid, state: "queued" });
  send({ type: "command_lifecycle", command_uuid: uuid, state: "started" });
  if (text === "Start background.") {
    send({ type: "system", subtype: "init", session_id: "fixture-session" });
    send({ type: "system", subtype: "task_started", task_id: "task-1", description: "fixture background task", is_backgrounded: true });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Started." }] } });
    send({ type: "result", subtype: "success", result: "Started.", session_id: "fixture-session" });
    send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
    const poll = setInterval(() => {
      if (!existsSync(${JSON.stringify(finishFile)})) return;
      clearInterval(poll);
      log({ background: "finished" });
      send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      send({ type: "system", subtype: "task_notification", task_id: "task-1", status: "completed" });
      // As Claude Code 2.1.280 does (verified): a command running when the
      // task ends finishes first; the answer to the task is a step after it.
      if (running) answerTaskAfter = true;
      else answerTask();
    }, 20);
    return;
  }
  if (text === "/compact meanwhile" || text === "/compact meanwhile-step") {
    send({ type: "system", subtype: "status", session_id: "fixture-session" });
    // A CLI that reports its compaction as a step from the start.
    if (text.endsWith("-step")) send({ type: "system", subtype: "init", session_id: "fixture-session" });
    running = true;
    log({ compacting: text });
    setTimeout(() => {
      running = false;
      log({ compacted: text });
      compactNow();
      send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
      if (answerTaskAfter) {
        answerTaskAfter = false;
        answerTask();
      }
    }, 800);
    return;
  }
  if (text === "Reply slowly.") {
    send({ type: "system", subtype: "init", session_id: "fixture-session" });
    setTimeout(() => {
      messagesTokens += 40000;
      log({ replied: text });
      send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Slow reply." }] } });
      send({ type: "result", subtype: "success", result: "Slow reply.", session_id: "fixture-session" });
      send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
    }, 400);
    return;
  }
  if (text === "Work with tools.") {
    // A turn of three model calls and a subagent, as Claude Code 2.1.330
    // streams it (captured 2026-11-22): each main-thread call carries the
    // context it sent; the subagent's call (parent_tool_use_id) its own; the
    // result sums every call of the turn and names each model's window.
    send({ type: "system", subtype: "init", session_id: "fixture-session", model: "claude-sonnet-5-5" });
    const call = (input, parent, model) => ({ type: "assistant", parent_tool_use_id: parent, session_id: "fixture-session",
      message: { model, role: "assistant", content: [{ type: "text", text: "step" }],
        usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: input - 1002, output_tokens: 40 } } });
    send({ type: "stream_event", parent_tool_use_id: null, session_id: "fixture-session", event: { type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 28998 } } } });
    send(call(30000, null, "claude-sonnet-5-5"));
    send(call(61000, null, "claude-sonnet-5-5"));
    send(call(150000, "toolu_sub", "claude-haiku-4-5"));
    send(call(62995, null, "claude-sonnet-5-5"));
    send({ type: "assistant", parent_tool_use_id: null, session_id: "fixture-session", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } });
    send({ type: "result", subtype: "success", result: "Done.", session_id: "fixture-session",
      usage: { input_tokens: 8, cache_creation_input_tokens: 4000, cache_read_input_tokens: 299987, output_tokens: 160 },
      modelUsage: { "claude-sonnet-5-5": { contextWindow: 1000000 }, "claude-haiku-4-5": { contextWindow: 200000 } } });
    send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
    return;
  }
  if (text === "Fill the context.") {
    // Claude Code compacting on its own while it answers, its context full
    // (the boundary it emits for an automatic compaction).
    send({ type: "system", subtype: "init", session_id: "fixture-session" });
    const pre = baseline + messagesTokens + 900000;
    messagesTokens = 9000;
    send({ type: "system", subtype: "compact_boundary", session_id: "fixture-session", compact_metadata: { trigger: "auto", pre_tokens: pre, post_tokens: messagesTokens } });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Answered after compacting." }] } });
    send({ type: "result", subtype: "success", result: "Answered after compacting.", session_id: "fixture-session" });
    send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
    return;
  }
  if (text === "Fill then fail.") {
    // Compacting on its own, then failing in the same step.
    send({ type: "system", subtype: "init", session_id: "fixture-session" });
    send({ type: "system", subtype: "compact_boundary", session_id: "fixture-session", compact_metadata: { trigger: "auto", pre_tokens: 950000, post_tokens: 9000 } });
    send({ type: "result", subtype: "error_during_execution", is_error: true, result: "", session_id: "fixture-session" });
    send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
    return;
  }
  if (text === "Subagent compacts.") {
    // A subagent's own compaction (its own context): the member's is as it was.
    send({ type: "system", subtype: "init", session_id: "fixture-session" });
    send({ type: "system", subtype: "compact_boundary", session_id: "fixture-session", parent_tool_use_id: "toolu_sub", compact_metadata: { trigger: "auto", pre_tokens: 190000, post_tokens: 9000 } });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Subagent done." }] } });
    send({ type: "result", subtype: "success", result: "Subagent done.", session_id: "fixture-session" });
    send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
    return;
  }
  if (text.startsWith("/compact") && messagesTokens === 0) {
    // What Claude Code 2.1.280 answers with nothing to compact (verified).
    send({ type: "system", subtype: "init", session_id: "fixture-session" });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Error: No messages to compact" }] } });
    send({ type: "result", subtype: "success", result: "", session_id: "fixture-session" });
    send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
    return;
  }
  if (text === "/compact slowly") {
    send({ type: "system", subtype: "status", session_id: "fixture-session" });
    holding = uuid;
    return;
  }
  if (text.startsWith("/compact")) {
    send({ type: "system", subtype: "status", session_id: "fixture-session" });
    compactNow();
  } else {
    messagesTokens += 40000;
    send({ type: "system", subtype: "init", session_id: "fixture-session" });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Reply." }], usage: { input_tokens: 2, cache_read_input_tokens: baseline + messagesTokens - 2, cache_creation_input_tokens: 0, output_tokens: 10 } } });
    send({ type: "result", subtype: "success", result: "Reply.", session_id: "fixture-session", usage: { input_tokens: 2, cache_read_input_tokens: baseline + messagesTokens - 2, cache_creation_input_tokens: 0, output_tokens: 10 } });
  }
  send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
});
`, "utf8");
  await chmod(claudePath, 0o755);
  return { claudePath, log, finishBackground: () => writeFile(finishFile, "") };
}

// The sessions view's access in each CLI's own terms (src/shared/chatAccessModes.ts):
// the CLI runs in that mode and asks about what it is not granted, as in its
// own terminal, each ask an approval card.
export function ownModeOptions(agentMode: "default" | "plan" | "auto" | "full-access", workspaceWrite: boolean, shell?: ReturnType<typeof defaultChatAgentPermissions>["shell"]) {
  const options = chatOptions({ agentMode, workspaceWrite, shell, canRequestPermissions: true, appToolNames: ["app_permissions_request_change", "app_tool_permission"] });
  return { ...options, permissions: { ...options.permissions, cliApprovals: true as const } };
}
