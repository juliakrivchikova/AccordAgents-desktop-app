import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCodexCompactTimeoutMs } from "./cliAgents";
import { handleCodexAppServerCompactNotification } from "./cliAgents/codex/appServerEvents";
import { codexAppServerThreadResumeParams } from "./cliAgents/codex/appServerParams";
import { chatOptions, makeRunner } from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

test("codex app-server compact instructions become a scoped compact_prompt override", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const params = codexAppServerThreadResumeParams(
    "session-1",
    participant as never,
    "/repo",
    "chat",
    {
      ...chatOptions({
        agentMode: "default",
        workspaceWrite: false,
        webAccess: false
      }),
      compactInstructions: "keep focus on parser and CLI protocol details"
    }
  );

  assert.equal(params.threadId, "session-1");
  assert.match((params.config as any).compact_prompt, /Compact the conversation context/);
  assert.match((params.config as any).compact_prompt, /keep focus on parser and CLI protocol details/);
});

test("codex app-server compact ignores the unbounded native-goal turn timeout", () => {
  assert.equal(resolveCodexCompactTimeoutMs(0), 5 * 60_000);
  assert.equal(resolveCodexCompactTimeoutMs(undefined), 5 * 60_000);
  assert.equal(resolveCodexCompactTimeoutMs(42_000), 42_000);
});

test("codex app-server does not override compact_prompt unless compact instructions are scoped", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const params = codexAppServerThreadResumeParams(
    "session-1",
    participant as never,
    "/repo",
    "chat",
    chatOptions({
      agentMode: "default",
      workspaceWrite: false,
      webAccess: false
    })
  );

  assert.equal("compact_prompt" in (params.config as any), false);
});

test("codex app-server compact prompt can be explicitly cleared after an instructed compact", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const params = codexAppServerThreadResumeParams(
    "session-1",
    participant as never,
    "/repo",
    "chat",
    {
      ...chatOptions({
        agentMode: "default",
        workspaceWrite: false,
        webAccess: false
      }),
      clearCompactPrompt: true
    }
  );

  assert.equal((params.config as any).compact_prompt, null);
});

test("codex app-server compact returns token usage captured during compact", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: "gpt-5"
  };
  let pending: any = {
    threadId: "session-1",
    startedAt: Date.now(),
    timer: setTimeout(() => undefined, 1000),
    resolve: (result: unknown) => {
      resolved = result;
    },
    reject: (error: Error) => {
      throw error;
    }
  };
  let resolved: any;
  const cleanupPending = () => {
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    return current;
  };
  const rejectPending = (error: Error) => {
    throw error;
  };

  assert.equal(handleCodexAppServerCompactNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "session-1",
      tokenUsage: { total: { totalTokens: 900_000 }, last: { totalTokens: 120_000 }, modelContextWindow: 1_000_000 }
    }
  }, participant as never, pending, cleanupPending, rejectPending), true);

  assert.equal(handleCodexAppServerCompactNotification({
    method: "thread/compacted",
    params: {
      threadId: "session-1"
    }
  }, participant as never, pending, cleanupPending, rejectPending), true);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 120_000, "the last call's total, not the session's cumulative 900k");
  assert.equal(resolved.contextUsage.contextWindowTokens, 1_000_000);
  // Codex's own "% context left" leaves its 12k baseline out: 89% left.
  assert.equal(resolved.contextUsage.percentage, 11);
});

test("codex app-server compact resolves CLI-style context_compacted events", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: "gpt-5"
  };
  let pending: any = {
    threadId: "session-1",
    startedAt: Date.now(),
    timer: setTimeout(() => undefined, 1000),
    resolve: (result: unknown) => {
      resolved = result;
    },
    reject: (error: Error) => {
      throw error;
    }
  };
  let resolved: any;
  const cleanupPending = () => {
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    return current;
  };
  const rejectPending = (error: Error) => {
    throw error;
  };

  // Codex reports the compacted history's estimate as a token count first.
  assert.equal(handleCodexAppServerCompactNotification({
    type: "event",
    msg: {
      type: "token_count",
      thread_id: "session-1",
      info: { last_token_usage: { total_tokens: 80_000 }, model_context_window: 258_400 }
    }
  }, participant as never, pending, cleanupPending, rejectPending), true);
  assert.equal(handleCodexAppServerCompactNotification({
    type: "event",
    msg: {
      type: "context_compacted",
      thread_id: "session-1",
      usage: { input_tokens: 999_999 }
    }
  }, participant as never, pending, cleanupPending, rejectPending), true);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 80_000, "the token count, never a usage the completion carries");
  assert.equal(resolved.contextUsage.contextWindowTokens, 258_400);
  assert.equal(resolved.contextUsage.percentage, 28);
});

test("codex app-server compact resolves compact completion event variants", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: "gpt-5"
  };
  let resolved: any;
  let pending: any = {
    threadId: "session-1",
    startedAt: Date.now(),
    timer: setTimeout(() => undefined, 1000),
    resolve: (result: unknown) => {
      resolved = result;
    },
    reject: (error: Error) => {
      throw error;
    }
  };
  const cleanupPending = () => {
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    return current;
  };
  const rejectPending = (error: Error) => {
    throw error;
  };

  assert.equal(handleCodexAppServerCompactNotification({
    method: "thread/tokenUsage/updated",
    params: { threadId: "session-1", tokenUsage: { last: { totalTokens: 70_000 }, modelContextWindow: 1_000_000 } }
  }, participant as never, pending, cleanupPending, rejectPending), true);
  assert.equal(handleCodexAppServerCompactNotification({
    method: "thread/compact/completed",
    params: {
      threadId: "session-1"
    }
  }, participant as never, pending, cleanupPending, rejectPending), true);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 70_000);
  assert.equal(resolved.contextUsage.percentage, 6);
});

function makeCompactPending(threadId: string): { pending: any; cleanupPending: () => any; rejectPending: (error: Error) => void; getResolved: () => any; getRejected: () => Error | undefined } {
  let resolved: any;
  let rejected: Error | undefined;
  let pending: any = {
    threadId,
    startedAt: Date.now(),
    timer: setTimeout(() => undefined, 1000),
    resolve: (result: unknown) => {
      resolved = result;
    },
    reject: (error: Error) => {
      rejected = error;
    }
  };
  const cleanupPending = () => {
    const current = pending;
    pending = undefined;
    if (current) {
      clearTimeout(current.timer);
    }
    return current;
  };
  const rejectPending = (error: Error) => {
    const current = cleanupPending();
    current?.reject(error);
  };
  return {
    get pending() {
      return pending;
    },
    cleanupPending,
    rejectPending,
    getResolved: () => resolved,
    getRejected: () => rejected
  } as any;
}

test("codex app-server compact resolves on the compaction turn lifecycle (no thread/compacted)", () => {
  // codex >= 0.139 runs compaction as a normal turn: turn/started ->
  // thread/tokenUsage/updated (reduced) -> turn/completed, and never emits a
  // dedicated thread/compacted event. The handler must resolve on that turn.
  const runner = makeRunner() as any;
  const participant = { kind: "codex-cli", label: "@codex", model: "gpt-5.5" };
  const ctx = makeCompactPending("session-1");

  assert.equal(handleCodexAppServerCompactNotification({
    method: "turn/started",
    params: { threadId: "session-1", turn: { id: "compact-turn" } }
  }, participant as never, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  assert.equal(handleCodexAppServerCompactNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "session-1",
      turnId: "compact-turn",
      tokenUsage: {
        total: { totalTokens: 0, inputTokens: 0 },
        last: { totalTokens: 5519, inputTokens: 0 },
        modelContextWindow: 258400
      }
    }
  }, participant as never, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  assert.equal(handleCodexAppServerCompactNotification({
    method: "turn/completed",
    params: { threadId: "session-1", turn: { id: "compact-turn", status: "completed" } }
  }, participant as never, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  const resolved = ctx.getResolved();
  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 5519);
  assert.equal(resolved.contextUsage.contextWindowTokens, 258400);
  // Below Codex's 12k baseline its status reads "100% left".
  assert.equal(resolved.contextUsage.percentage, 0);
});

test("codex app-server compact ignores a stray turn/completed before the compaction turn", () => {
  const runner = makeRunner() as any;
  const participant = { kind: "codex-cli", label: "@codex", model: "gpt-5.5" };
  const ctx = makeCompactPending("session-1");

  // A completion that arrives before we ever saw the compaction turn start must
  // be ignored so we do not resolve on a prior turn and report stale usage.
  assert.equal(handleCodexAppServerCompactNotification({
    method: "turn/completed",
    params: { threadId: "session-1", turn: { id: "earlier-turn", status: "completed" } }
  }, participant as never, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);
  assert.equal(ctx.getResolved(), undefined);
  assert.equal(ctx.pending !== undefined, true);
});

test("codex app-server compact rejects when the compaction turn fails", () => {
  const runner = makeRunner() as any;
  const participant = { kind: "codex-cli", label: "@codex", model: "gpt-5.5" };
  const ctx = makeCompactPending("session-1");

  handleCodexAppServerCompactNotification({
    method: "turn/started",
    params: { threadId: "session-1", turn: { id: "compact-turn" } }
  }, participant as never, ctx.pending, ctx.cleanupPending, ctx.rejectPending);

  assert.equal(handleCodexAppServerCompactNotification({
    method: "turn/completed",
    params: { threadId: "session-1", turn: { id: "compact-turn", status: "failed", error: { message: "model overloaded" } } }
  }, participant as never, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  assert.equal(ctx.getResolved(), undefined);
  assert.match(String(ctx.getRejected()?.message), /model overloaded/);
});
