import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeClaudeWarmHarness } from "./cliAgents/test/claudeWarmHarness";
import { makeRunner } from "./cliAgents/test/runnerFixtures";

// Replies Claude Code starts itself (the User, 2026-11-25: "unclear what
// 'Worked for 0s' without any text means").
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

/** What Claude Code 2.1.330 sends when a background subagent ends in auto
 *  mode (recorded 2026-11-25): its report starts one step, the notification of
 *  its end a second one that ends at once, without a model request. */
const report = [
  { type: "system", subtype: "task_notification", task_id: "t1", status: "completed" },
  { type: "system", subtype: "background_tasks_changed", tasks: [] },
  { type: "system", subtype: "init" },
  { type: "system", subtype: "status", status: "requesting" },
  { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "GOT IT." }] } },
  { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "GOT IT.", origin: { kind: "peer", from: "t1" } }
];
const emptyStep = [
  { type: "system", subtype: "init" },
  { type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0, result: "", origin: { kind: "task-notification" } }
];

function harnessWithSubagent(handled: any[]) {
  const harness = makeClaudeWarmHarness(makeRunner() as any, { lifecycle: true });
  harness.addReply({ origin: { runId: "run-1", messageId: "reply-1" } });
  harness.send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  harness.send({ type: "system", subtype: "init" });
  harness.send({ type: "system", subtype: "task_started", task_id: "t1", description: "Write pear facts", is_backgrounded: true });
  harness.send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "STARTED" }] } });
  harness.send({ type: "result", subtype: "success", result: "STARTED" });
  harness.state.onSelfResumedTurn = (turn: any) => {
    const outputs: any[] = [];
    handled.push({ outputs, settled: turn.attach({ onOutput: (event: any) => outputs.push(event) }) });
  };
  return harness;
}

test("a step Claude Code starts and ends with nothing leaves no reply", async () => {
  const handled: any[] = [];
  const harness = harnessWithSubagent(handled);
  for (const event of [...report, ...emptyStep]) harness.send(event);
  assert.equal(handled.length, 1, "only the step that answered is a reply");
  assert.equal((await handled[0].settled).content, "GOT IT.");
  assert.ok(handled[0].outputs.some((event: any) => /Background task finished: Write pear facts/.test(event.text)));
  assert.equal(harness.state.replies.length, 0);
  assert.equal(harness.state.active, undefined);
  assert.equal(harness.state.stepActive, false);
  assert.equal(harness.flags.unusable, false);
});

test("the app is told of a step as soon as the model is asked, before it says anything", () => {
  const handled: any[] = [];
  const harness = harnessWithSubagent(handled);
  for (const event of report.slice(0, 3)) harness.send(event);
  assert.equal(handled.length, 0);
  harness.send(report[3]!);
  assert.equal(handled.length, 1);
});

test("a step of a CLI that does not report its request is told of anyway, by its output or after a moment", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handled: any[] = [];
  const harness = harnessWithSubagent(handled);
  for (const event of report.slice(0, 3)) harness.send(event);
  t.mock.timers.tick(1_400);
  assert.equal(handled.length, 0);
  t.mock.timers.tick(200);
  assert.equal(handled.length, 1, "silent for a moment: shown as working");
  harness.send(report[4]!);
  harness.send(report[5]!);
  assert.equal((await handled[0].settled).content, "GOT IT.");
  const quick: any[] = [];
  const other = harnessWithSubagent(quick);
  for (const event of [report[0]!, report[1]!, report[2]!, { type: "stream_event", event: { type: "message_start" } }]) other.send(event);
  assert.equal(quick.length, 1);
});

test("the row of a finished background task goes to the reply that comes after an empty step", async () => {
  const handled: any[] = [];
  const harness = harnessWithSubagent(handled);
  for (const event of [report[0]!, report[1]!, ...emptyStep]) harness.send(event);
  assert.equal(handled.length, 0);
  const next = harness.addReply();
  harness.send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "started" });
  harness.send({ type: "system", subtype: "init" });
  harness.send({ type: "result", subtype: "success", result: "Here." });
  assert.equal(next.resolved[0].content, "Here.");
  assert.equal(next.outputs.filter((event) => /Background task finished: Write pear facts/.test(event.text)).length, 1);
});

test("a step that fails before it says anything is still a reply: it says why", async () => {
  const handled: any[] = [];
  const harness = harnessWithSubagent(handled);
  for (const event of [report[0]!, report[1]!, report[2]!]) harness.send(event);
  harness.send({ type: "result", subtype: "success", is_error: true, result: "You've hit your weekly limit · resets 7pm" });
  assert.equal(handled.length, 1);
  const result = await handled[0].settled;
  assert.equal(result.ok, false);
  assert.match(result.content, /You've hit your weekly limit · resets 7pm/);
});

test("a subagent working in the background is no reply of the member's, and an empty step after its messages is none either", async () => {
  const handled: any[] = [];
  const harness = harnessWithSubagent(handled);
  const subagent = { type: "assistant", parent_tool_use_id: "toolu_1", agent_id: "t1", message: { role: "assistant", content: [{ type: "text", text: "1. Pears belong to the rose family." }] } };
  harness.send(subagent);
  assert.equal(harness.state.stepActive, false);
  assert.equal(handled.length, 0);
  for (const event of report) harness.send(event);
  harness.send(subagent);
  for (const event of emptyStep) harness.send(event);
  assert.equal(handled.length, 1);
  assert.equal((await handled[0].settled).content, "GOT IT.", "the subagent's words are not the member's");
});

test("a message that joins a step which had nothing to do yet takes it over without an empty reply", async () => {
  const handled: any[] = [];
  const harness = harnessWithSubagent(handled);
  for (const event of report.slice(0, 3)) harness.send(event);
  const next = harness.addReply();
  harness.send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "started" });
  harness.send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Yours." }] } });
  harness.send({ type: "result", subtype: "success", result: "Yours." });
  assert.equal(handled.length, 0);
  assert.equal(next.resolved[0].content, "Yours.");
});
