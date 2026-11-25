import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cliParts } from "./cliAgents/test/cliParts";
import { makeCodexPendingTurn, makeRunner } from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

test("codex app-server stream emits completed native subagent activity", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; text: string; cumulative?: string; activityKind?: string; activityStatus?: string; activityItemId?: string }> = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; text: string; cumulative?: string; activityKind?: string; activityStatus?: string; activityItemId?: string }) => outputs.push(event)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };

  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "item/completed", params: { item: { type: "subAgentActivity", id: "call-1" } } },
    participant,
    pending,
    () => pending,
    fail
  );

  assert.deepEqual(outputs, [{
    kind: "tool",
    text: "Using subagent\n",
    cumulative: undefined,
    activityKind: "tool",
    activityStatus: "completed",
    activityItemId: "call-1"
  }]);
});

test("codex app-server stream keeps raw tool output out of agent text and completes bounded activities", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{
    kind: string;
    text?: string;
    cumulative?: string;
    activityStatus?: string;
    activityItemId?: string;
    activityDetail?: string;
  }> = [];
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: typeof outputs[number]) => outputs.push(event),
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };
  const send = (record: Record<string, unknown>): void => cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    record,
    participant,
    pending,
    () => pending,
    fail
  );

  send({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-1", type: "agentMessage", phase: "commentary" }
    }
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-1", type: "agentMessage", phase: "commentary", text: "I’ll inspect it." }
    }
  });
  send({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", command: "npm test" }
    }
  });
  send({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1", delta: "RAW_COMMAND_DELTA\n" }
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "npm test",
        aggregatedOutput: "COMMAND_OUTPUT_FIRST\nCOMMAND_OUTPUT_LAST\n"
      }
    }
  });
  send({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "file-1",
        type: "fileChange",
        changes: [{ kind: "update", path: "src/example.ts", diff: "RAW_FULL_DIFF" }]
      }
    }
  });
  send({
    method: "item/fileChange/outputDelta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-1", delta: "RAW_FILE_DELTA\n" }
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "file-1",
        type: "fileChange",
        changes: [{ kind: "update", path: "src/example.ts", diff: "RAW_FULL_DIFF" }]
      }
    }
  });
  send({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "mcp-1",
        type: "mcpToolCall",
        tool: "app_roles_describe_options",
        arguments: { role: "engineer" }
      }
    }
  });
  send({
    method: "item/mcpToolCall/progress",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "mcp-1", message: "RAW_MCP_PROGRESS" }
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "mcp-1",
        type: "mcpToolCall",
        result: { content: [{ type: "text", text: "MCP_RESULT_LAST" }] }
      }
    }
  });
  send({
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "mcp-app", type: "mcpToolCall", server: "accord_agents", tool: "app_chat_read_messages", arguments: { limit: 2 } } }
  });
  send({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "mcp-app", type: "mcpToolCall", result: { content: [{ type: "text", text: JSON.stringify({ messages: [{ content: "APP_MESSAGES_TEXT ".repeat(30) }] }) }] } } }
  });
  send({
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "mcp-app-refused", type: "mcpToolCall", server: "accord_agents", tool: "app_chat_request_compaction", arguments: {} } }
  });
  send({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "mcp-app-refused", type: "mcpToolCall", result: { content: [{ type: "text",
      text: JSON.stringify({ ok: false, status: "rejected", error: `APP_TOOL_REFUSED ${"because ".repeat(40)}` }) }] } } }
  });
  send({
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "mcp-app-failed", type: "mcpToolCall", server: "accord_agents", tool: "app_chat_send_message", arguments: { content: "Hi" } } }
  });
  send({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "mcp-app-failed", type: "mcpToolCall", status: "failed", error: { message: "APP_TOOL_FAILED" } } }
  });
  send({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-2", type: "agentMessage", phase: "final_answer" }
    }
  });
  send({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", delta: "Done." }
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-2", type: "agentMessage", phase: "final_answer", text: "Done." }
    }
  });
  send({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });

  const commandEvents = outputs.filter((event) => event.activityItemId === "command-1");
  assert.deepEqual(commandEvents.map((event) => event.activityStatus), ["started", "completed"]);
  assert.match(commandEvents.at(-1)?.activityDetail ?? "", /^npm test\n\nOutput tail:/);
  assert.match(commandEvents.at(-1)?.activityDetail ?? "", /COMMAND_OUTPUT_LAST/);

  const fileEvents = outputs.filter((event) => event.activityItemId === "file-1");
  assert.deepEqual(fileEvents.map((event) => event.activityStatus), ["started", "completed"]);
  assert.equal(fileEvents.at(-1)?.activityDetail, "update: src/example.ts");
  assert.doesNotMatch(fileEvents.at(-1)?.activityDetail ?? "", /RAW_FULL_DIFF/);

  const mcpEvents = outputs.filter((event) => event.activityItemId === "mcp-1");
  assert.deepEqual(mcpEvents.map((event) => event.activityStatus), ["started", "completed"]);
  // Codex's TUI words; a completion that names nothing keeps what the start named.
  assert.deepEqual(mcpEvents.map((event) => event.text), [
    "Calling app_roles_describe_options({\"role\":\"engineer\"})\n",
    "Called app_roles_describe_options({\"role\":\"engineer\"})\n"
  ]);
  assert.match(mcpEvents.at(-1)?.activityDetail ?? "", /\{"role":"engineer"\}/, "its arguments, compact");
  assert.match(mcpEvents.at(-1)?.activityDetail ?? "", /MCP_RESULT_LAST/);
  // The app's own tool answers with chat text the chat keeps: no copy.
  assert.equal(outputs.filter((event) => event.activityItemId === "mcp-app").at(-1)?.activityDetail, '{"limit":2}');
  const failed = outputs.filter((event) => event.activityItemId === "mcp-app-failed").at(-1);
  assert.equal(failed?.activityStatus, "failed");
  assert.match(failed?.activityDetail ?? "", /Output tail:\nAPP_TOOL_FAILED/, "an app tool's failure keeps its reason");
  assert.match(outputs.filter((event) => event.activityItemId === "mcp-app-refused").at(-1)?.activityDetail ?? "", /APP_TOOL_REFUSED/,
    "and so does a refusal it answers with");

  const visibleTranscript = outputs.filter((event) => event.kind === "text").at(-1)?.cumulative ?? "";
  assert.equal(visibleTranscript, "I’ll inspect it.\n\nDone.");
  assert.doesNotMatch(
    visibleTranscript,
    /RAW_COMMAND_DELTA|COMMAND_OUTPUT_FIRST|RAW_FILE_DELTA|RAW_FULL_DIFF|RAW_MCP_PROGRESS|MCP_RESULT_LAST/
  );
  assert.equal((resolved[0] as { content: string }).content, "Done.");
});

test("codex app-server completed activity output keeps only a marked 20-line 2,000-character tail", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{
    kind: string;
    activityStatus?: string;
    activityDetail?: string;
  }> = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: typeof outputs[number]) => outputs.push(event)
  });
  const aggregatedOutput = Array.from(
    { length: 30 },
    (_, index) => `line-${index.toString().padStart(2, "0")}:${"x".repeat(150)}`
  ).join("\r\n");

  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "generate lots of output",
          aggregatedOutput
        }
      }
    },
    { id: "p1", label: "Agent" },
    pending,
    () => pending,
    (error: Error): never => { throw error; }
  );

  const detail = outputs.find((event) => event.activityStatus === "completed")?.activityDetail ?? "";
  const preview = detail.split("Output tail:\n")[1] ?? "";
  assert.match(detail, /^generate lots of output\n\nOutput tail:/);
  assert.ok(preview.length <= 2_000);
  assert.match(preview, /earlier lines/);
  assert.match(preview, /chars omitted/);
  assert.doesNotMatch(preview, /line-00:/);
  assert.match(preview, /line-29:/);
});

test("codex app-server bounds MCP and dynamic tool invocation summaries without starving output tails", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{
    kind: string;
    cumulative?: string;
    activityStatus?: string;
    activityItemId?: string;
    activityDetail?: string;
  }> = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: typeof outputs[number]) => outputs.push(event)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };
  const send = (record: Record<string, unknown>): void => cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    record,
    participant,
    pending,
    () => pending,
    fail
  );
  const argumentsPayload = {
    path: "src/large.ts",
    content: `INVOCATION_START_${"x".repeat(5_000)}_RAW_ARGUMENT_END`
  };

  send({
    method: "item/started",
    params: {
      threadId: "thread-1",
      item: {
        id: "mcp-large",
        type: "mcpToolCall",
        tool: "write_file",
        arguments: argumentsPayload
      }
    }
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      item: {
        id: "mcp-large",
        type: "mcpToolCall",
        result: { content: [{ type: "text", text: "MCP_RESULT_LAST" }] }
      }
    }
  });
  send({
    method: "item/started",
    params: {
      threadId: "thread-1",
      item: {
        id: "dynamic-large",
        type: "dynamicToolCall",
        tool: "write_file",
        arguments: argumentsPayload
      }
    }
  });

  const mcpEvents = outputs.filter((event) => event.activityItemId === "mcp-large");
  const startedDetail = mcpEvents[0]?.activityDetail ?? "";
  const completedDetail = mcpEvents[1]?.activityDetail ?? "";
  assert.ok(startedDetail.length <= 1_800);
  assert.match(startedDetail, /"path":"src\/large\.ts"/);
  assert.match(startedDetail, /INVOCATION_START/);
  assert.match(startedDetail, /chars omitted/);
  assert.doesNotMatch(startedDetail, /RAW_ARGUMENT_END/);
  assert.ok(completedDetail.length < 4_000);
  assert.match(completedDetail, /INVOCATION_START/);
  assert.match(completedDetail, /Output tail:\nMCP_RESULT_LAST$/);

  const dynamicDetail = outputs.find((event) => event.activityItemId === "dynamic-large")?.activityDetail ?? "";
  assert.ok(dynamicDetail.length <= 1_800);
  assert.match(dynamicDetail, /chars omitted/);
  assert.doesNotMatch(dynamicDetail, /RAW_ARGUMENT_END/);
  assert.equal(outputs.filter((event) => event.kind === "text").length, 0);
});

test("codex app-server keeps a stable fallback identity for no-id subagent completion", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{
    kind: string;
    activityStatus?: string;
    activityItemId?: string;
    activityDetail?: string;
  }> = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: typeof outputs[number]) => outputs.push(event)
  });
  const send = (kind: string): void => cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: { type: "subAgentActivity", kind }
      }
    },
    { id: "p1", label: "Agent" },
    pending,
    () => pending,
    (error: Error): never => { throw error; }
  );

  send("thinking");
  send("done");

  assert.deepEqual(outputs.map((event) => event.activityStatus), ["completed", "completed"]);
  assert.deepEqual(outputs.map((event) => event.activityItemId), ["subAgentActivity", "subAgentActivity"]);
  assert.deepEqual(outputs.map((event) => event.activityDetail), ["thinking", "done"]);
});
