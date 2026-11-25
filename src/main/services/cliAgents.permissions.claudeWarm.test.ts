import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cliParts } from "./cliAgents/test/cliParts";
import { makeClaudeWarmHarness } from "./cliAgents/test/claudeWarmHarness";
import { makeRunner } from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

test("claude warm stream and final content preserve the shipped fence boundary", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const resolved: unknown[] = [];
  const harness = makeClaudeWarmHarness(runner);
  harness.addReply({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event),
    resolve: (result: unknown) => resolved.push(result)
  });
  const send = harness.send;
  const fencedBlock = "Here is the helper:\n```ts\nconst value = 1;\n```";
  const continuation = "Done — tests pass.";
  const expected = `${fencedBlock} ${continuation}`;

  send({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: fencedBlock } } });
  send({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: continuation } } });
  // This intentionally pins shipped Claude behavior until a dedicated CLI-parity
  // change establishes the correct fence composition with current CLI evidence.
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: fencedBlock }] } });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: continuation }] } });
  send({ type: "result" });

  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, expected);
  assert.equal((resolved[0] as { content: string }).content, expected);
});

test("claude warm stream rejoins mid-sentence text blocks", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const harness = makeClaudeWarmHarness(runner);
  harness.addReply({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event)
  });
  const send = harness.send;

  send({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Current EUR/RUB is" } } });
  send({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "about 1 EUR = 89.88 RUB." } } });

  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "Current EUR/RUB is about 1 EUR = 89.88 RUB.");
});

test("claude warm fallback excludes paragraph-separated preamble from final content", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const harness = makeClaudeWarmHarness(runner);
  harness.addReply({
    resolve: (result: unknown) => resolved.push(result)
  });
  const send = harness.send;

  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I’ll check the existing settings first." }] } });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Final answer." }] } });
  send({ type: "result" });

  assert.equal((resolved[0] as { content: string }).content, "Final answer.");
});

test("claude warm fallback rejoins mid-sentence assistant text items", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const harness = makeClaudeWarmHarness(runner);
  harness.addReply({
    resolve: (result: unknown) => resolved.push(result)
  });
  const send = harness.send;

  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Current EUR/RUB is" }] } });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "about 1 EUR = 89.88 RUB." }] } });
  send({ type: "result" });

  assert.equal((resolved[0] as { content: string }).content, "Current EUR/RUB is about 1 EUR = 89.88 RUB.");
});

test("claude warm rejects result events without response content", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const rejected: Error[] = [];
  const harness = makeClaudeWarmHarness(runner);
  harness.addReply({
    resolve: (result: unknown) => resolved.push(result),
    reject: (error: Error) => rejected.push(error)
  });

  harness.send({ type: "system", subtype: "init" });
  harness.send({ type: "result" });

  assert.equal(resolved.length, 0);
  assert.equal(rejected[0]?.message, "Claude warm process completed without response content.");
});

test("claude warm permits empty result only when explicitly allowed", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const rejected: Error[] = [];
  const harness = makeClaudeWarmHarness(runner);
  harness.addReply({
    allowEmptyContent: true,
    resolve: (result: unknown) => resolved.push(result),
    reject: (error: Error) => rejected.push(error)
  });

  harness.send({ type: "system", subtype: "init" });
  harness.send({ type: "result" });

  assert.equal(rejected.length, 0);
  assert.equal((resolved[0] as { ok: boolean; content: string; sessionId: string }).ok, true);
  assert.equal((resolved[0] as { content: string }).content, "");
  assert.equal((resolved[0] as { sessionId?: string }).sessionId, undefined);
});

// Parity with the dedicated CLI in bidirectional stream-json mode (verified on
// Claude Code 2.1.257): a `result` while a background task is live is not the
// end of the turn — the CLI keeps the process alive, resumes the model with the
// task notification and streams the continuation on the same session.
test("claude warm reply ends at its result while its background task keeps running, and says so", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { outputs, resolved } = harness.addReply({ origin: { runId: "run-1", messageId: "reply-1" } });
  const { send, state } = harness;

  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "sleep 8; echo done", run_in_background: true } }] } });
  send({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "local_bash", description: "Run the soak" }] });
  send({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_1", description: "Run the soak", is_backgrounded: true, task_type: "local_bash" });
  send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Command running in background with ID: t1" }] } });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Started the soak" }] } });
  send({ type: "result", subtype: "success", result: "Started the soak", num_turns: 2 });
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "completed" });

  assert.equal(resolved.length, 1, "the reply is finished at its result, as in the dedicated CLI");
  assert.equal(resolved[0].content, "Started the soak");
  assert.equal(state.replies.length, 0);
  assert.equal(state.stepActive, false);
  assert.deepEqual(Array.from(state.backgroundTasks.keys()), ["t1"], "the task belongs to the process and is still live");
  const running = outputs.find((event) => /Running in the background: Run the soak/.test(event.text));
  assert.equal(running?.activityKind, "status");
  assert.equal(outputs.some((event) => /Waiting for background work/.test(event.text)), false);
});

test("claude warm: a background task finishing while idle produces a self-started reply that is attached, replayed and settled", async () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state } = harness;
  harness.addReply({ origin: { runId: "run-1", messageId: "reply-1" } });
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  send({ type: "system", subtype: "task_started", task_id: "t1", description: "Run the soak", is_backgrounded: true });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Started." }] } });
  send({ type: "result", subtype: "success", result: "Started." });

  const turns: any[] = [];
  state.onSelfResumedTurn = (turn: any) => turns.push(turn);
  send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  send({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" });
  assert.equal(turns.length, 0, "the notification alone does not start a reply");
  send({ type: "system", subtype: "init" });
  send({ type: "system", subtype: "status", status: "requesting" });
  assert.equal(turns.length, 1, "the CLI's own step becomes a new reply");
  assert.deepEqual(turns[0].origin, { runId: "run-1", messageId: "reply-1" }, "the reply that started the work is named");
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "The soak finished." } } });

  const outputs: any[] = [];
  const settled = turns[0].attach({ onOutput: (event: any) => outputs.push(event) });
  assert.ok(outputs.some((event) => /Background task finished: Run the soak/.test(event.text)), "the notification row is replayed into the new reply");
  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "The soak finished.");
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The soak finished." }] } });
  send({ type: "result", subtype: "success", result: "The soak finished." });
  const result = await settled;
  assert.equal(result.ok, true);
  assert.equal(result.content, "The soak finished.");
  assert.equal(state.replies.length, 0);
  assert.equal(harness.flags.unusable, false);
});

test("claude warm: each tool call of a step is its own row in the CLI's words, named by the session's folder and MCP servers", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { outputs } = harness.addReply({ origin: { runId: "run-1", messageId: "reply-1" } });
  const { send } = harness;
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init", cwd: "/repo", mcp_servers: [{ name: "claude.ai Context7", status: "connected" }, { name: "accord_agents", status: "connected" }] });
  send({ type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "/repo/src/a.ts" } },
    { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "npm test", description: "Run unit tests" } },
    { type: "tool_use", id: "toolu_c", name: "mcp__claude_ai_Context7__resolve-library-id", input: { libraryName: "react" } },
    { type: "tool_use", id: "toolu_d", name: "EnterPlanMode", input: {} },
    { type: "tool_use", id: "toolu_e", name: "ExitPlanMode", input: { plan: "# Plan\n\n1. Fix the login." } }
  ] } });
  const rows = outputs.filter((event) => event.kind === "tool").map((event: any) => [event.activityItemId, event.text.trim(), event.activityKind]);
  assert.deepEqual(rows, [
    ["toolu_a", "Reading src/a.ts", "tool"],
    ["toolu_b", "Running unit tests", "command"],
    ["toolu_c", "claude.ai Context7 - resolve-library-id (MCP)", "tool"]
  ], "no row for the plan tools: the plan card is ExitPlanMode's dialog");
  assert.equal((outputs.find((event: any) => event.activityItemId === "toolu_b") as any)?.activityDetail, "npm test");
});

test("claude warm: a message that joins the running step says which step it joined, and a step the CLI started itself by its own start", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state } = harness;
  const starts: unknown[] = [];
  const first = harness.addReply({ origin: { runId: "run-1", messageId: "reply-1" } });
  harness.addReply({ origin: { runId: "run-2", messageId: "reply-2" }, onStarted: (start: unknown) => starts.push(start) });
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "started" });
  assert.equal(first.resolved[0]?.turnContinues, true, "the reply the next message joined says its turn goes on");
  assert.equal(starts.length, 1);
  assert.deepEqual((starts[0] as any).joinedReply, { runId: "run-1", messageId: "reply-1" }, "it continues the step reply-1's message started");
  assert.ok(Number.isFinite((starts[0] as any).joinedStepStartedAt), "with when that step began");
  send({ type: "result", subtype: "success", result: "done" });

  // Background work finishes while idle: the CLI starts a step itself, then a
  // message joins it. Its origin is the older reply's: the step's own start counts.
  state.onSelfResumedTurn = (turn: any) => turn.attach({ onOutput: () => undefined });
  send({ type: "system", subtype: "init" });
  const selfStarted = state.active;
  assert.equal(selfStarted?.commandUuid, undefined);
  const joinedStarts: any[] = [];
  harness.addReply({ origin: { runId: "run-3", messageId: "reply-3" }, onStarted: (start: unknown) => joinedStarts.push(start) });
  send({ type: "command_lifecycle", command_uuid: "cmd-3", state: "started" });
  assert.equal(joinedStarts.length, 1);
  assert.equal(joinedStarts[0].joinedReply, undefined);
  assert.equal(joinedStarts[0].joinedStepStartedAt, selfStarted.stepStartedAt ?? selfStarted.startedAt);
});

test("claude warm: a self-started step with no handler is dropped without retiring the process", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state } = harness;
  send({ type: "system", subtype: "init" });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Nobody asked." }] } });
  send({ type: "result", subtype: "success", result: "Nobody asked." });
  assert.equal(state.replies.length, 0);
  assert.equal(state.stepActive, false);
  assert.equal(harness.flags.unusable, false);
  // The next message is still routed to its own reply.
  const { resolved } = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  send({ type: "result", subtype: "success", result: "Mine." });
  assert.equal(resolved[0].content, "Mine.");
});

test("claude warm: a message the CLI hands to the running step ends the reply so far and answers the new message", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send } = harness;
  const first = harness.addReply();
  const second = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "queued" });
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Running the check." } } });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Running the check." }] } });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "sleep 10" } }] } });
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "queued" });
  assert.equal(first.resolved.length, 0, "queued is not taken yet");
  send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "started" });
  assert.equal(first.resolved.length, 1, "the first reply ends where the new message joined the step");
  assert.equal(first.resolved[0].content, "Running the check.");
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "TWO" } } });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "TWO" }] } });
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "completed" });
  send({ type: "result", subtype: "success", result: "TWO" });
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "completed" });
  assert.equal(second.resolved.length, 1);
  assert.equal(second.resolved[0].content, "TWO");
  assert.equal(second.outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "TWO", "nothing of the first reply leaks into the second");
  assert.equal(first.resolved.length, 1);
});

test("claude warm: a message sent while the model is idle starts its own step even with background work live", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state } = harness;
  harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  send({ type: "system", subtype: "task_started", task_id: "t1", description: "agent", is_backgrounded: true });
  send({ type: "result", subtype: "success", result: "Started." });
  const second = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "queued" });
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "started" });
  send({ type: "system", subtype: "init" });
  send({ type: "result", subtype: "success", result: "4" });
  assert.equal(second.resolved[0].content, "4");
  assert.equal(state.backgroundTasks.size, 1);
});

test("claude warm: Stop interrupts only the running step and keeps the process and its background work", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state, written, hooks, participant } = harness;
  const { reply, rejected, resolved } = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  send({ type: "system", subtype: "task_started", task_id: "t1", description: "agent", is_backgrounded: true });
  cliParts(runner).claudeReplyFlow.stopClaudeWarmReply(state, reply, hooks, participant);
  const interrupt = written.find((message) => message.type === "control_request");
  assert.deepEqual((interrupt as any)?.request, { subtype: "interrupt" });
  send({ type: "control_response", response: { subtype: "success", request_id: (interrupt as any).request_id, response: { still_queued: [] } } });
  send({ type: "result", subtype: "error_during_execution", is_error: true });
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "cancelled" });
  assert.equal(resolved.length, 0);
  assert.equal(rejected[0]?.message, "claude warm process was cancelled");
  assert.equal(harness.flags.unusable, false, "an acknowledged Stop does not retire the process");
  assert.equal(state.backgroundTasks.size, 1, "background work survives the Stop");
  clearTimeout(reply.stopTimer);
});

test("claude warm: Stop on a message still queued in the CLI removes it from the queue", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state, written, hooks, participant } = harness;
  harness.addReply();
  const queued = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "queued" });
  cliParts(runner).claudeReplyFlow.stopClaudeWarmReply(state, queued.reply, hooks, participant);
  const cancel = written.find((message) => (message as any).request?.subtype === "cancel_async_message") as any;
  assert.equal(cancel?.request.message_uuid, "cmd-2");
  assert.equal(written.some((message) => (message as any).request?.subtype === "interrupt"), false, "the running step is left alone");
  send({ type: "control_response", response: { subtype: "success", request_id: cancel.request_id, response: { cancelled: true } } });
  assert.equal(queued.rejected[0]?.message, "claude warm process was cancelled");
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "cancelled" });
  assert.equal(queued.rejected.length, 1);
});

test("claude warm: a queued message the CLI took before the removal arrived is interrupted when it starts", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state, written, hooks, participant } = harness;
  const queued = harness.addReply();
  cliParts(runner).claudeReplyFlow.stopClaudeWarmReply(state, queued.reply, hooks, participant);
  const cancel = written.find((message) => (message as any).request?.subtype === "cancel_async_message") as any;
  send({ type: "control_response", response: { subtype: "success", request_id: cancel.request_id, response: { cancelled: false } } });
  assert.equal(queued.rejected.length, 0);
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  assert.equal(written.some((message) => (message as any).request?.subtype === "interrupt"), true);
  send({ type: "system", subtype: "init" });
  send({ type: "result", subtype: "error_during_execution", is_error: true });
  assert.equal(queued.rejected[0]?.message, "claude warm process was cancelled");
  clearTimeout(queued.reply.stopTimer);
});

test("claude warm: a Stop the CLI never acknowledges settles the reply and retires the process", async () => {
  const runner = makeRunner() as any;
  cliParts(runner).claudeReplyFlow.claudeWarmStopAckTimeoutMs = 20;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state, hooks, participant } = harness;
  const { reply, rejected } = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  cliParts(runner).claudeReplyFlow.stopClaudeWarmReply(state, reply, hooks, participant);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(rejected[0]?.message, "claude warm process was cancelled");
  assert.equal(harness.flags.unusable, true);
  // The step's remaining output drains into the settled reply until its
  // result, instead of turning into a reply of its own.
  assert.equal(state.active, reply);
  assert.equal(state.stepActive, true);
  const turns: unknown[] = [];
  state.onSelfResumedTurn = (turn: unknown) => turns.push(turn);
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "tail" }] } });
  assert.equal(turns.length, 0);
});

test("claude warm: a reply that finishes as Stop lands keeps its content", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state, hooks, participant } = harness;
  const { reply, resolved } = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  cliParts(runner).claudeReplyFlow.stopClaudeWarmReply(state, reply, hooks, participant);
  send({ type: "result", subtype: "success", result: "Already done." });
  assert.equal(resolved[0]?.content, "Already done.");
});

test("claude warm: an error result fails only that reply; the process is retired only when nothing else is live", () => {
  const runner = makeRunner() as any;
  const busy = makeClaudeWarmHarness(runner, { lifecycle: true });
  const failed = busy.addReply();
  busy.send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  busy.send({ type: "system", subtype: "init" });
  busy.send({ type: "system", subtype: "task_started", task_id: "t1", description: "agent", is_backgrounded: true });
  busy.send({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: overloaded" });
  assert.equal(failed.resolved[0]?.ok, false);
  assert.match(String(failed.resolved[0]?.error), /overloaded/);
  assert.equal(busy.flags.unusable, false, "live background work keeps the process");

  const idle = makeClaudeWarmHarness(runner, { lifecycle: true });
  idle.addReply();
  idle.send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  idle.send({ type: "system", subtype: "init" });
  idle.send({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error" });
  assert.equal(idle.flags.unusable, true);
});

test("claude warm: a background task finishing during a running step is shown in that step's reply", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state } = harness;
  const { outputs } = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  send({ type: "system", subtype: "task_started", task_id: "t1", description: "Explore", is_backgrounded: true });
  send({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" });
  assert.ok(outputs.some((event) => /Background task finished: Explore/.test(event.text)));
  assert.equal(state.pendingNotices.length, 0);
  // A foreground command reported as a task gets no background row.
  send({ type: "system", subtype: "task_started", task_id: "fg", description: "sleep 10", is_backgrounded: false });
  send({ type: "system", subtype: "task_notification", task_id: "fg", status: "completed" });
  assert.equal(outputs.filter((event) => /Background task finished/.test(event.text)).length, 1);
});

test("claude warm: a Stop that reaches the CLI after the next message started stops that message too, reported as such", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state, hooks, participant, written } = harness;
  const first = harness.addReply();
  const second = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  cliParts(runner).claudeReplyFlow.stopClaudeWarmReply(state, first.reply, hooks, participant);
  // The step had already finished: its result was on its way.
  send({ type: "result", subtype: "success", result: "One." });
  assert.equal(first.resolved[0]?.content, "One.");
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "started" });
  send({ type: "system", subtype: "init" });
  const interrupt = written.find((message) => (message as any).request?.subtype === "interrupt") as any;
  send({ type: "control_response", response: { subtype: "success", request_id: interrupt.request_id, response: { still_queued: [] } } });
  send({ type: "result", subtype: "error_during_execution", is_error: true });
  assert.equal(second.resolved[0]?.ok, false);
  assert.match(String(second.resolved[0]?.error), /Stopped together with the previous reply/);
  assert.equal(harness.flags.unusable, false);
  clearTimeout(first.reply.stopTimer);
});

test("claude warm: an interrupt the CLI took while nothing ran is not blamed for a later failure", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state, hooks, participant, written } = harness;
  const first = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  cliParts(runner).claudeReplyFlow.stopClaudeWarmReply(state, first.reply, hooks, participant);
  send({ type: "result", subtype: "success", result: "One." });
  const interrupt = written.find((message) => (message as any).request?.subtype === "interrupt") as any;
  send({ type: "control_response", response: { subtype: "success", request_id: interrupt.request_id, response: { still_queued: [] } } });
  const later = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "started" });
  send({ type: "system", subtype: "init" });
  send({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error" });
  assert.match(String(later.resolved[0]?.error), /API Error/);
  clearTimeout(first.reply.stopTimer);
});

test("claude warm: a reply stopped as the next message joins its step ends stopped", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state, hooks, participant } = harness;
  const first = harness.addReply();
  const second = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  cliParts(runner).claudeReplyFlow.stopClaudeWarmReply(state, first.reply, hooks, participant);
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "started" });
  assert.equal(first.rejected[0]?.message, "claude warm process was cancelled");
  assert.equal(first.resolved.length, 0);
  assert.equal(state.active, second.reply);
});

test("claude warm: once the CLI refuses to drop a queued message, Stop waits for it to start without a deadline", async () => {
  const runner = makeRunner() as any;
  cliParts(runner).claudeReplyFlow.claudeWarmStopAckTimeoutMs = 20;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state, hooks, participant, written } = harness;
  harness.addReply();
  const queued = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  cliParts(runner).claudeReplyFlow.stopClaudeWarmReply(state, queued.reply, hooks, participant);
  const cancel = written.find((message) => (message as any).request?.subtype === "cancel_async_message") as any;
  send({ type: "control_response", response: { subtype: "success", request_id: cancel.request_id, response: { cancelled: false } } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(harness.flags.unusable, false, "a long step ahead of it does not retire the process");
  assert.equal(queued.rejected.length, 0);
});

test("claude warm: a task finishing while idle keeps the process busy until the CLI's own step starts", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  (harness.state as any).selfResumeExpectedUntil = 0;
  harness.send({ type: "system", subtype: "task_started", task_id: "t1", description: "agent", is_backgrounded: true });
  harness.send({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" });
  assert.ok((harness.state as any).selfResumeExpectedUntil > Date.now(), "the CLI is about to start a step");
  harness.state.onSelfResumedTurn = (turn: any) => { void turn.attach({}); };
  harness.send({ type: "system", subtype: "init" });
  assert.equal((harness.state as any).selfResumeExpectedUntil, 0);
});

test("claude warm: Stop while a message waits for the member's busy process to apply changed settings leaves that process alone", async () => {
  const runner = makeRunner() as any;
  const closed: unknown[] = [];
  cliParts(runner).warmAgentClose.closeWarmAgent = async (entry: unknown) => { closed.push(entry); };
  let providerStarted = false;
  cliParts(runner).cliRuns.providerExecutableForRun = async () => { providerStarted = true; return "/nonexistent/claude"; };
  const busy = {
    key: "old-settings",
    scopeKey: "conversation-settings:claude-settings",
    closed: false,
    process: { exitCode: null },
    isIdle: () => false,
    whenIdle: (signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  };
  cliParts(runner).warmAgents.entries.set(busy.key, busy);
  const outputs: Array<{ text: string; activityStatus?: string }> = [];
  const controller = new AbortController();
  const participant = { id: "claude-settings", kind: "claude-code", label: "Claude" };
  const running = cliParts(runner).claudeRuns.runClaudeWarmOrOneShot(participant, "Hello", undefined, "chat", controller.signal, {
    warm: { conversationId: "conversation-settings", participantId: participant.id, contextKey: "new-settings", idleTimeoutMs: 60_000 },
    onOutput: (event: { text: string; activityStatus?: string }) => outputs.push(event)
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(outputs.some((event) => /before applying the changed settings/.test(event.text) && event.activityStatus === "started"));
  controller.abort(new Error("Stopped by user."));
  const result = await running;
  assert.equal(result.ok, false);
  assert.deepEqual(closed, [], "the busy process and its background work survive the Stop");
  assert.equal(providerStarted, false);
  assert.ok(cliParts(runner).warmAgents.entries.has("old-settings"));
  cliParts(runner).warmAgents.entries.clear();
});

test("claude warm: a reply is told when the CLI hands its message to a step", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  let started = 0;
  harness.addReply();
  harness.addReply({ onStarted: () => { started += 1; } });
  harness.send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  harness.send({ type: "system", subtype: "init" });
  harness.send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "queued" });
  assert.equal(started, 0, "queued is not started");
  harness.send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "started" });
  assert.equal(started, 1);
});

test("claude warm: a message the CLI drops without a Stop fails only that reply", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  harness.addReply();
  const dropped = harness.addReply();
  harness.send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  harness.send({ type: "system", subtype: "init" });
  harness.send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "discarded" });
  assert.equal(dropped.rejected[0]?.message, "Claude Code dropped this message before working on it.");
  assert.equal(harness.flags.unusable, false);
  assert.equal(harness.state.replies.length, 1);
});

test("claude warm: invalid output fails the running reply and retires the process; idle, it is only logged", () => {
  const runner = makeRunner() as any;
  const idle = makeClaudeWarmHarness(runner, { lifecycle: true });
  cliParts(runner).claudeProcess.handleClaudeWarmLine("not json", idle.participant, undefined, idle.state, idle.hooks);
  assert.equal(idle.flags.unusable, false);

  const busy = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { rejected } = busy.addReply();
  busy.send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  busy.send({ type: "system", subtype: "init" });
  cliParts(runner).claudeProcess.handleClaudeWarmLine("not json", busy.participant, undefined, busy.state, busy.hooks);
  assert.match(rejected[0]?.message ?? "", /invalid JSON/);
  assert.equal(busy.flags.unusable, true);
});

test("claude warm: an error event fails the reply but keeps a process that still carries background work", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { resolved, rejected } = harness.addReply();
  harness.send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  harness.send({ type: "system", subtype: "init" });
  harness.send({ type: "system", subtype: "task_started", task_id: "t1", description: "agent", is_backgrounded: true });
  harness.send({ type: "error", error: { message: "Overloaded" } });
  assert.equal(rejected.length, 0);
  assert.equal(resolved[0]?.ok, false);
  assert.match(String(resolved[0]?.error), /Overloaded/);
  assert.equal(harness.flags.unusable, false);
  // The rest of that step is dropped with the settled reply, not given to another.
  harness.send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "late" }] } });
  harness.send({ type: "result", subtype: "success", result: "late" });
  assert.equal(resolved.length, 1);
});

test("claude warm: an error outside any reply retires the process before the next message", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  harness.send({ type: "error", error: "provider failed" });
  assert.equal(harness.flags.unusable, true);
});

test("claude warm: without the CLI's command lifecycle, the oldest written message takes the next step", () => {
  const runner = makeRunner() as any;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: false });
  const { send } = harness;
  const first = harness.addReply();
  send({ type: "system", subtype: "init" });
  send({ type: "result", subtype: "success", result: "One." });
  assert.equal(first.resolved[0]?.content, "One.");
  const turns: any[] = [];
  harness.state.onSelfResumedTurn = (turn: any) => turns.push(turn);
  send({ type: "system", subtype: "init" });
  send({ type: "stream_event", event: { type: "message_start" } });
  assert.equal(turns.length, 1, "with nothing written, a step the CLI starts is its own");
});
