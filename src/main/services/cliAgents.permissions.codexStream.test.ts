import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cliParts } from "./cliAgents/test/cliParts";
import { agentMessageBoundarySeparator } from "./cliAgents/codex/appServerText";
import { makeCodexPendingTurn, makeRunner } from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

test("codex app-server stream keeps token deltas joined inside one agent message", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event)
  });
  const participant = { id: "p1", label: "Agent" };

  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "item/started", params: { item: { type: "agentMessage" } } },
    participant,
    pending,
    () => pending,
    (error: Error) => { throw error; }
  );
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "item/agentMessage/delta", params: { delta: "hel" } },
    participant,
    pending,
    () => pending,
    (error: Error) => { throw error; }
  );
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "item/agentMessage/delta", params: { delta: "lo" } },
    participant,
    pending,
    () => pending,
    (error: Error) => { throw error; }
  );

  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "hello");
});

test("codex app-server records provider acceptance from turn and item evidence", () => {
  const runner = makeRunner() as any;
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };
  const started = makeCodexPendingTurn();
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
    participant,
    started,
    () => started,
    fail
  );
  assert.equal(started.acceptedByProvider, true);

  const itemEvidence = makeCodexPendingTurn();
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "item/started", params: { threadId: "thread-1", turnId: "turn-2", item: { id: "item-1", type: "commandExecution" } } },
    participant,
    itemEvidence,
    () => itemEvidence,
    fail
  );
  assert.equal(itemEvidence.acceptedByProvider, true);
});

test("codex app-server stream excludes paragraph-separated preamble from final content", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event),
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };

  for (const text of ["first.", "second."]) {
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/started", params: { item: { type: "agentMessage" } } },
      participant,
      pending,
      () => pending,
      fail
    );
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/agentMessage/delta", params: { delta: text } },
      participant,
      pending,
      () => pending,
      fail
    );
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/completed", params: { item: { type: "agentMessage", text } } },
      participant,
      pending,
      () => pending,
      fail
    );
  }
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "turn/completed", params: { turn: { status: "completed" } } },
    participant,
    pending,
    () => pending,
    fail
  );

  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "first.\n\nsecond.");
  assert.equal((resolved[0] as { content: string }).content, "second.");
});

test("codex app-server stream rejoins mid-sentence agent messages around tool usage", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; text: string; cumulative?: string }> = [];
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; text: string; cumulative?: string }) => outputs.push(event),
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

  send({ method: "item/started", params: { item: { type: "agentMessage" } } });
  send({ method: "item/agentMessage/delta", params: { delta: "Current EUR/RUB is" } });
  send({ method: "item/completed", params: { item: { type: "agentMessage", text: "Current EUR/RUB is" } } });
  send({ method: "item/started", params: { item: { type: "webSearch" } } });
  send({ method: "item/started", params: { item: { type: "agentMessage" } } });
  send({ method: "item/agentMessage/delta", params: { delta: "about 1 EUR" } });
  send({ method: "item/agentMessage/delta", params: { delta: " = 89.88 RUB." } });
  send({ method: "item/completed", params: { item: { type: "agentMessage", text: "about 1 EUR = 89.88 RUB." } } });
  send({ method: "turn/completed", params: { turn: { status: "completed" } } });

  assert.equal(outputs.find((event) => event.kind === "tool")?.text, "Searching the web\n", "Codex's TUI words for a web search that runs");
  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "Current EUR/RUB is about 1 EUR = 89.88 RUB.");
  assert.equal((resolved[0] as { content: string }).content, "Current EUR/RUB is about 1 EUR = 89.88 RUB.");
});

test("codex app-server stream ignores child thread completion while parent turn continues", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    turnId: "parent-turn",
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event),
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

  send({ method: "item/started", params: { threadId: "child-thread", turnId: "child-turn", item: { type: "agentMessage" } } });
  send({ method: "item/agentMessage/delta", params: { threadId: "child-thread", turnId: "child-turn", delta: "CHILD_RESULT" } });
  send({ method: "item/completed", params: { threadId: "child-thread", turnId: "child-turn", item: { type: "agentMessage", text: "CHILD_RESULT" } } });
  send({ method: "turn/completed", params: { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } } });

  assert.equal(resolved.length, 0);
  assert.equal(outputs.length, 0);

  send({ method: "item/started", params: { threadId: "thread-1", turnId: "parent-turn", item: { type: "agentMessage" } } });
  send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "parent-turn", delta: "PARENT_FINAL" } });
  send({ method: "item/completed", params: { threadId: "thread-1", turnId: "parent-turn", item: { type: "agentMessage", text: "PARENT_FINAL" } } });
  send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "parent-turn", status: "completed" } } });

  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "PARENT_FINAL");
  assert.equal((resolved[0] as { content: string }).content, "PARENT_FINAL");
});

test("codex app-server stream accepts goal continuation root turn ids in the same thread", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    turnId: "requested-turn",
    nativeGoal: { status: "active", turnCompleted: false },
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event),
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

  send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "requested-turn", status: "completed" } } });
  assert.equal(resolved.length, 0);

  send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "goal-continuation-turn" } } });
  send({ method: "item/started", params: { threadId: "thread-1", turnId: "goal-continuation-turn", item: { type: "agentMessage" } } });
  send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "goal-continuation-turn", delta: "Status: tests are running." } });
  send({ method: "item/completed", params: { threadId: "thread-1", turnId: "goal-continuation-turn", item: { type: "agentMessage", text: "Status: tests are running." } } });
  send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "goal-continuation-turn", status: "completed" } } });
  assert.equal(resolved.length, 0);
  send({
    method: "thread/goal/updated",
    params: {
      threadId: "thread-1",
      turnId: "goal-continuation-turn",
      goal: { status: "complete", objective: "finish the task" }
    }
  });

  assert.equal(pending.turnId, "goal-continuation-turn");
  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "Status: tests are running.");
  assert.equal((resolved[0] as { content: string }).content, "Status: tests are running.");
});

test("codex app-server surfaces non-success native goal terminal states", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    nativeGoal: { status: "active", turnCompleted: false },
    resolve: (result: unknown) => resolved.push(result)
  });
  const send = (record: Record<string, unknown>): void => cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    record,
    { id: "p1", label: "Agent" },
    pending,
    () => pending,
    (error: Error) => { throw error; }
  );

  send({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } });
  send({ method: "thread/goal/updated", params: { threadId: "thread-1", goal: { status: "usageLimited" } } });

  assert.equal((resolved[0] as { ok: boolean }).ok, false);
  assert.match((resolved[0] as { error: string }).error, /usage limited/);
});

test("codex app-server stream ignores same-thread completion for a different tracked turn", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  let cleanupCount = 0;
  const pending = makeCodexPendingTurn({
    turnId: "root-turn",
    streamedText: "final",
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };
  const cleanup = (): typeof pending => {
    cleanupCount += 1;
    return pending;
  };

  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "other-turn", status: "completed" } } },
    participant,
    pending,
    cleanup,
    fail
  );
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "root-turn", status: "completed" } } },
    participant,
    pending,
    cleanup,
    fail
  );

  assert.equal(cleanupCount, 1);
  assert.equal((resolved[0] as { content: string }).content, "final");
});

test("codex app-server stream keeps command output out of agent text when a turn is interrupted", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{
    kind: string;
    cumulative?: string;
    activityStatus?: string;
    activityDetail?: string;
  }> = [];
  const rejected: Error[] = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: typeof outputs[number]) => outputs.push(event),
    reject: (error: Error) => rejected.push(error)
  });
  const participant = { id: "p1", label: "Agent" };
  const send = (record: Record<string, unknown>): void => cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    record,
    participant,
    pending,
    () => pending,
    (error: Error) => rejected.push(error)
  );

  send({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", command: "printf READY; sleep 30" }
    }
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", aggregatedOutput: "READY\n" }
    }
  });
  send({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } }
  });

  assert.equal(outputs.filter((event) => event.kind === "text").length, 0);
  assert.match(
    outputs.find((event) => event.activityStatus === "completed")?.activityDetail ?? "",
    /^printf READY; sleep 30\n\nOutput tail:\nREADY$/
  );
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]?.message ?? "", /interrupted/);
});

test("codex app-server stream keeps parenthetical citation boundaries as paragraph breaks outside final content", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event),
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };
  const sendAgentMessage = (text: string): void => {
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/started", params: { item: { type: "agentMessage" } } },
      participant,
      pending,
      () => pending,
      fail
    );
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/agentMessage/delta", params: { delta: text } },
      participant,
      pending,
      () => pending,
      fail
    );
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/completed", params: { item: { type: "agentMessage", text } } },
      participant,
      pending,
      () => pending,
      fail
    );
  };

  sendAgentMessage("Current EUR/RUB is about 1 EUR = 89.88 RUB. (exchange-rates.org)");
  sendAgentMessage("For comparison, the Bank of Russia official rate is 87.4027 RUB per EUR. (cbr.ru)");
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "turn/completed", params: { turn: { status: "completed" } } },
    participant,
    pending,
    () => pending,
    fail
  );

  const expected = [
    "Current EUR/RUB is about 1 EUR = 89.88 RUB. (exchange-rates.org)",
    "For comparison, the Bank of Russia official rate is 87.4027 RUB per EUR. (cbr.ru)"
  ].join("\n\n");
  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, expected);
  assert.equal((resolved[0] as { content: string }).content, "For comparison, the Bank of Russia official rate is 87.4027 RUB per EUR. (cbr.ru)");
});

test("codex app-server keeps internal multi-paragraph final item complete", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };
  const final = [
    "Current EUR/RUB is about 1 EUR = 89.88 RUB. (exchange-rates.org)",
    "For comparison, the Bank of Russia official rate is 87.4027 RUB per EUR. (cbr.ru)"
  ].join("\n\n");

  for (const text of ["I’ll check the exchange sources first.", final]) {
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/started", params: { item: { type: "agentMessage" } } },
      participant,
      pending,
      () => pending,
      fail
    );
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/agentMessage/delta", params: { delta: text } },
      participant,
      pending,
      () => pending,
      fail
    );
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/completed", params: { item: { type: "agentMessage", text } } },
      participant,
      pending,
      () => pending,
      fail
    );
  }
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "turn/completed", params: { turn: { status: "completed" } } },
    participant,
    pending,
    () => pending,
    fail
  );

  assert.equal((resolved[0] as { content: string }).content, final);
});

test("codex app-server keeps a fenced commentary block separate from a multi-paragraph final answer", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event),
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };
  const commentary = [
    "I’ll preserve the exact block.",
    "```ts",
    "const first = 1;",
    "",
    "const second = 2;",
    "```"
  ].join("\n");
  const final = [
    "The code block remains intact.",
    "",
    "The final answer keeps both paragraphs."
  ].join("\n");
  const sendAgentItem = (id: string, phase: string, text: string): void => {
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/started", params: { item: { id, type: "agentMessage", phase } } },
      participant,
      pending,
      () => pending,
      fail
    );
    const splitAt = Math.floor(text.length / 2);
    for (const delta of [text.slice(0, splitAt), text.slice(splitAt)]) {
      cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
        { method: "item/agentMessage/delta", params: { itemId: id, delta } },
        participant,
        pending,
        () => pending,
        fail
      );
    }
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/completed", params: { item: { id, type: "agentMessage", phase, text } } },
      participant,
      pending,
      () => pending,
      fail
    );
  };

  sendAgentItem("commentary-1", "commentary", commentary);
  sendAgentItem("final-1", "final_answer", final);
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "turn/completed", params: { turn: { status: "completed" } } },
    participant,
    pending,
    () => pending,
    fail
  );

  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, `${commentary}\n\n${final}`);
  assert.equal((resolved[0] as { content: string }).content, final);
});

test("codex app-server normalizes agent CRLF split across deltas and flushes a final carriage return", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event),
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };

  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "item/started", params: { item: { id: "message-1", type: "agentMessage" } } },
    participant,
    pending,
    () => pending,
    fail
  );
  for (const delta of ["First line\r", "\nSecond line\r"]) {
    cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
      { method: "item/agentMessage/delta", params: { itemId: "message-1", delta } },
      participant,
      pending,
      () => pending,
      fail
    );
  }
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    {
      method: "item/completed",
      params: {
        item: {
          id: "message-1",
          type: "agentMessage",
          text: "First line\r\nSecond line\r"
        }
      }
    },
    participant,
    pending,
    () => pending,
    fail
  );
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "turn/completed", params: { turn: { status: "completed" } } },
    participant,
    pending,
    () => pending,
    fail
  );

  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "First line\nSecond line\r");
  assert.equal((resolved[0] as { content: string }).content, "First line\nSecond line");
});

test("codex app-server falls back to trailing paragraph when completions are missing", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };

  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "item/started", params: { item: { type: "agentMessage" } } },
    participant,
    pending,
    () => pending,
    fail
  );
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "item/agentMessage/delta", params: { delta: "I’ll check the sources first.\n\nFinal answer." } },
    participant,
    pending,
    () => pending,
    fail
  );
  cliParts(runner).codexAppServerNotifications.handleCodexAppServerNotification(
    { method: "turn/completed", params: { turn: { status: "completed" } } },
    participant,
    pending,
    () => pending,
    fail
  );

  assert.equal((resolved[0] as { content: string }).content, "Final answer.");
});

test("agent message fence boundaries remain opt-in for Codex", () => {
  const runner = makeRunner() as any;
  const previous = "Here is the helper:\n```ts\nconst value = 1;\n```";
  const next = "Done — tests pass.";

  assert.equal(agentMessageBoundarySeparator(previous, next), " ");
  assert.equal(
    agentMessageBoundarySeparator(previous, next, { fencedBlockEndsBlock: true }),
    "\n\n"
  );
});
