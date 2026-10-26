import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { NativeProcessRegistry } from "./nativeProcessRegistry";
import {
  claudeModelProbeEnv,
  CliAgentRunner,
  CodexAppServerRunError,
  parseClaudeModelPickerOutput,
  resolveClaudeModelProbeCwd,
  resolveCodexCompactTimeoutMs,
  runClaudeModelProbeInPty,
  runClaudeModelProbeWithExpect
} from "./cliAgents";
import { CommandError, ensureLoginShellEnvPrimed } from "./command";
import type { CodexServerRequestDelivery } from "./codexApprovals";
import { buildCodexExecInvocation, CODEX_APP_SERVER_MCP_TOKEN_ENV } from "./codexExec";
import type { ParticipantRunResult } from "./providers";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";

function makeRunner(): CliAgentRunner {
  return new CliAgentRunner();
}

for (const kind of ["claude-code", "codex-cli"] as const) {
  test(`${kind}: context usage for a session whose log is gone is read once when asked not to wait`, async () => {
    const runner = makeRunner();
    const participant = { id: `${kind}-missing-log`, kind, label: kind };
    const reads: string[] = [];
    const lookups = runner as unknown as Record<"findClaudeSessionLogPath" | "findCodexSessionLogPath", (sessionId: string) => Promise<string | undefined>>;
    lookups[kind === "claude-code" ? "findClaudeSessionLogPath" : "findCodexSessionLogPath"] = async (sessionId) => {
      reads.push(sessionId);
      return undefined;
    };

    assert.equal(await runner.contextUsageForSession(participant, "gone-session", { waitForLog: false }), undefined);
    assert.deepEqual(reads, ["gone-session"]);

    // The default still waits for a log that may not be written yet (after a turn or a compaction).
    reads.length = 0;
    assert.equal(await runner.contextUsageForSession(participant, "fresh-session"), undefined);
    assert.ok(reads.length > 1, `the default retries a missing log (read ${reads.length} times)`);
  });
}

test("Claude context usage read from the end of the log matches reading the whole log", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accordagents-claude-log-"));
  try {
    const runner = makeRunner();
    const claude = { id: "claude-log", kind: "claude-code" as const, label: "Claude", model: "claude-opus-5-5" };
    const usage = (input: number): string => JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } } });
    const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary" });
    const filler = JSON.stringify({ type: "user", message: { content: "п".repeat(300_000) } });
    const internals = runner as unknown as {
      findClaudeSessionLogPath(sessionId: string): Promise<string | undefined>;
      agentContextUsageFromEvent(event: unknown, participant: unknown, source: string): unknown;
      isClaudeCompactBoundary(event: unknown): boolean;
    };
    // The whole-log reading this replaced: the last usage after the last compaction boundary.
    const wholeLog = (content: string): unknown => {
      let latest: unknown;
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as unknown;
          if (internals.isClaudeCompactBoundary(event)) {
            latest = undefined;
            continue;
          }
          latest = internals.agentContextUsageFromEvent(event, claude, "claude-code") ?? latest;
        } catch {
          // partial line
        }
      }
      return latest;
    };
    const cases: Record<string, string[]> = {
      "usage then filler": [usage(1000), filler, usage(52_000), filler, "{\"type\":\"last-prompt\"}"],
      "usage before a boundary only": [usage(90_000), boundary, filler],
      "usage after a boundary": [usage(90_000), boundary, usage(12_000), "{partial"],
      "no usage at all": [filler, "not json"]
    };
    const results: Record<string, number | undefined> = {};
    for (const [name, lines] of Object.entries(cases)) {
      const content = `${lines.join("\n")}\n`;
      const file = path.join(dir, `${name.replace(/ /g, "-")}.jsonl`);
      await writeFile(file, content);
      internals.findClaudeSessionLogPath = async () => file;
      const fromEnd = await runner.contextUsageForSession(claude, "session", { waitForLog: false });
      const strip = (value: unknown): unknown => value && typeof value === "object" ? { ...(value as Record<string, unknown>), updatedAt: undefined } : value;
      assert.deepEqual(strip(fromEnd), strip(wholeLog(content)), name);
      results[name] = (fromEnd as { usedTokens?: number } | undefined)?.usedTokens;
    }
    assert.deepEqual(results, {
      "usage then filler": 52_000,
      "usage before a boundary only": undefined,
      "usage after a boundary": 12_000,
      "no usage at all": undefined
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idle accounts for native operations before a warm session exists and releases failed operations", async () => {
  const runner = makeRunner();
  const participant = { id: "idle-native", kind: "codex-cli" as const, label: "Codex" };
  let finish!: (value: Awaited<ReturnType<CliAgentRunner["run"]>>) => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<Awaited<ReturnType<CliAgentRunner["run"]>>>((resolve, reject) => { finish = resolve; fail = reject; });
  let calls = 0;
  const native = runner as unknown as { runCodex(): ReturnType<CliAgentRunner["run"]>; compactCodexSession(): ReturnType<CliAgentRunner["compactSession"]> };
  native.runCodex = () => { calls++; return pending; };
  const running = runner.run(participant, "native goal", undefined, undefined, "chat");
  assert.equal(runner.hasActiveNativeWork(), true);
  assert.equal(runner.fenceIdleNativeAdmissions(), undefined);
  finish({ participant, ok: true, content: "complete" }); await running;
  assert.equal(runner.hasActiveNativeWork(), false);
  const release = runner.fenceIdleNativeAdmissions()!;
  assert.equal((await runner.run(participant, "held", undefined, undefined, "chat")).ok, false);
  assert.equal((await runner.compactSession(participant, undefined, undefined, "chat", undefined, { sessionId: "s" })).ok, false);
  assert.equal(calls, 1);
  release();
  native.runCodex = () => new Promise((_resolve, reject) => { fail = reject; });
  const failed = runner.run(participant, "fails", undefined, undefined, "chat");
  await Promise.resolve();
  fail(new Error("native setup failed")); await assert.rejects(failed, /native setup failed/);
  assert.equal(runner.hasActiveNativeWork(), false);
});

async function writeCodexAppServerFixture(fixtureDir: string, source: string): Promise<string> {
  await writeFile(path.join(fixtureDir, "app-server"), source, "utf8");
  return process.execPath;
}

function makeCodexPendingTurn(overrides: Partial<Record<string, unknown>> = {}): Record<string, any> {
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

/** Drives the warm Claude line router directly: one process state, replies
 *  added as if written to the CLI, and every line the fixture "prints". */
function makeClaudeWarmHarness(runner: any, options: { lifecycle?: boolean } = {}) {
  const written: Array<Record<string, unknown>> = [];
  const state = {
    replies: [] as any[],
    active: undefined as any,
    stepActive: false,
    lifecycleSupported: options.lifecycle ?? false,
    backgroundTasks: new Map<string, string>(),
    backgroundTaskLabels: new Map<string, string>(),
    backgroundTaskOrigins: new Map<string, unknown>(),
    finishedTaskIds: new Set<string>(),
    pendingNotices: [] as unknown[],
    cancelRequests: new Map<string, unknown>(),
    controlWaiters: new Map<string, (response: unknown) => void>(),
    lastTaskEventAt: 0,
    selfResumeExpectedUntil: 0,
    interruptTarget: undefined as unknown,
    interruptRequestId: undefined as string | undefined,
    onSelfResumedTurn: undefined as ((turn: any) => void) | undefined
  };
  const flags = { unusable: false, settled: 0 };
  const hooks = {
    write: (message: Record<string, unknown>) => written.push(message),
    settled: () => { flags.settled += 1; },
    flush: () => undefined,
    markUnusable: () => { flags.unusable = true; },
    markUnusableIfIdle: () => {
      if (state.replies.length === 0 && state.backgroundTasks.size === 0) {
        flags.unusable = true;
      }
    }
  };
  const participant = { id: "p1", label: "Agent", kind: "claude-code" };
  let commands = 0;
  const addReply = (overrides: Record<string, unknown> = {}) => {
    const outputs: Array<{ kind: string; text: string; cumulative?: string; activityKind?: string; activityStatus?: string; activityItemId?: string }> = [];
    const resolved: any[] = [];
    const rejected: Error[] = [];
    commands += 1;
    const reply = runner.newClaudeWarmReply({
      commandUuid: `cmd-${commands}`,
      written: true,
      onOutput: (event: any) => outputs.push(event),
      resolve: (result: unknown) => resolved.push(result),
      reject: (error: Error) => rejected.push(error),
      ...overrides
    });
    state.replies.push(reply);
    return { reply, outputs, resolved, rejected };
  };
  const send = (event: Record<string, unknown>): void => runner.handleClaudeWarmLine(
    JSON.stringify(event),
    participant,
    undefined,
    state,
    hooks
  );
  return { state, hooks, written, flags, participant, addReply, send };
}

test("agentRunEnv filters blocked manual keys and preserves app MCP token precedence", () => {
  const runner = makeRunner() as unknown as {
    agentRunEnv(options: Record<string, unknown>): NodeJS.ProcessEnv | undefined;
  };

  const env = runner.agentRunEnv({
    agentEnv: {
      AA_MANUAL_AGENT_ENV_TEST: "manual",
      PATH: "/manual/bin",
      ACCORD_AGENTS_INTERNAL: "blocked",
      [CODEX_APP_SERVER_MCP_TOKEN_ENV]: "manual-token"
    },
    appMcp: {
      token: "per-run-token"
    }
  });

  assert.equal(env?.AA_MANUAL_AGENT_ENV_TEST, "manual");
  assert.equal(env?.PATH, undefined);
  assert.equal(env?.ACCORD_AGENTS_INTERNAL, undefined);
  assert.equal(env?.[CODEX_APP_SERVER_MCP_TOKEN_ENV], "per-run-token");
});

test("warmAgentKey changes when the manual agent environment version changes", () => {
  const runner = makeRunner() as unknown as {
    warmAgentKey(
      participant: Record<string, unknown>,
      repoPath: string | undefined,
      kind: string,
      options: Record<string, unknown>
    ): string;
  };
  const participant = {
    id: "participant-1",
    kind: "codex",
    model: "gpt-5",
    reasoningEffort: "medium"
  };
  const baseOptions = {
    extraReadableDirs: ["/tmp/workspace"],
    warm: {
      conversationId: "conversation-1",
      participantId: "participant-1",
      contextKey: "prompt-context-v1"
    }
  };

  const firstKey = runner.warmAgentKey(participant, "/tmp/repo", "chat", {
    ...baseOptions,
    agentEnvKey: "agent-env-v1"
  });
  const secondKey = runner.warmAgentKey(participant, "/tmp/repo", "chat", {
    ...baseOptions,
    agentEnvKey: "agent-env-v2"
  });
  const repeatedFirstKey = runner.warmAgentKey(participant, "/tmp/repo", "chat", {
    ...baseOptions,
    agentEnvKey: "agent-env-v1"
  });

  assert.notEqual(firstKey, secondKey);
  assert.equal(firstKey, repeatedFirstKey);
  assert.equal(JSON.parse(firstKey).agentEnvKey, "agent-env-v1");
  assert.equal(JSON.parse(secondKey).agentEnvKey, "agent-env-v2");
});

test("parseClaudeModelPickerOutput extracts aliases and default model from picker text", () => {
  const output = [
    "\u001b[?25lSelect m\u001b[12Gdel",
    "\u001b[3G❯\u001b[5G1.\u001b[8GDefault\u001b[16G(recommended)\u001b[30G✔\u001b[33GUse\u001b[37Gthe\u001b[41Gdefault\u001b[49Gmodel\u001b[55G(currently\u001b[66GOpus\u001b[71G4.8\u001b[75G(1M",
    "\u001b[33Gcontext))\u001b[43G·\u001b[45G$5/$25\u001b[52Gper\u001b[56GMtok",
    "\u001b[5G2.\u001b[8GOpus\u001b[33GOpus\u001b[38G4.8\u001b[42Gwith\u001b[47G1M\u001b[50Gcontext",
    "\u001b[5G3.\u001b[8GFable\u001b[33GFable\u001b[39G5",
    "\u001b[5G4.\u001b[8GSonnet\u001b[33GSonnet\u001b[40G4.6",
    "\u001b[5G5.\u001b[8GSonnet\u001b[15G(1M\u001b[19Gcontext)\u001b[33GSonnet\u001b[40G4.6\u001b[44Gfor\u001b[48Glong\u001b[53Gsessions",
    "\u001b[5G6.\u001b[8GHaiku\u001b[33GHaiku\u001b[39G4.5",
    "● Enter to set · Esctocancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => ({
    id: model.id,
    recommended: model.recommended === true
  })), [
    { id: "opus", recommended: true },
    { id: "fable", recommended: false },
    { id: "sonnet", recommended: false },
    { id: "claude-sonnet-4-6[1m]", recommended: false },
    { id: "haiku", recommended: false }
  ]);
});

test("parseClaudeModelPickerOutput handles ConPTY rows without whitespace between items", () => {
  const output = "Select model> 1. Default (recommended) √ Opus 5 with 1M context · Best for tasks2. Opus (1M context) Opus 5 with 1M context · Best for tasks3. Fable Fable 5 · Hard tasks4. Sonnet Sonnet 5 · Routine tasks5. Sonnet5(1Mcontext)Sonnet5forlongsessions6. Haiku Haiku 4.5 · Fast● High effort Enter to s t as defaul · Esctocancel";
  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), [
    "opus",
    "fable",
    "sonnet",
    "claude-sonnet-5[1m]",
    "haiku"
  ]);
});

test("parseClaudeModelPickerOutput uses the final ConPTY redraw", () => {
  const output = [
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 Enter to set · Esc to cancel",
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 3. Fable Fable 5 4. Sonnet Sonnet 5 5. Sonnet5(1Mcontext) Sonnet 5 for long sessions 6. Haiku Haiku 4.5 Enter to set · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), [
    "opus",
    "fable",
    "sonnet",
    "claude-sonnet-5[1m]",
    "haiku"
  ]);
});

test("parseClaudeModelPickerOutput drops models removed by the final ConPTY redraw", () => {
  const output = [
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 3. Fable Fable 5 Enter to set · Esc to cancel",
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 Enter to set · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["opus"]);
});

test("parseClaudeModelPickerOutput uses a final heading when its footer is fragmented", () => {
  const output = [
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 3. Fable Fable 5 Enter to set · Esc to cancel",
    "Select model 1. Default (recommended) ✔ Opus 5 2. Sonnet Sonnet 5 Enter to s et · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["sonnet"]);
});

test("parseClaudeModelPickerOutput uses the preceding footer when the final heading is fragmented", () => {
  const output = [
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 3. Fable Fable 5 Enter to set · Esc to cancel",
    "Sel ect model 1. Default (recommended) ✔ Opus 5 2. Haiku Haiku 4.5 Enter to set · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["haiku"]);
});

test("parseClaudeModelPickerOutput uses final rows when both redraw boundaries are fragmented", () => {
  const output = [
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 3. Fable Fable 5 Enter to set · Esc to cancel",
    "Sel ect model 1. Default (recommended) ✔ Opus 5 2. Sonnet Sonnet 5 Enter to s et · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["sonnet"]);
});

test("parseClaudeModelPickerOutput recognizes a single picker with fragmented boundaries", () => {
  const output = "Sel ect model 1. Default (recommended) ✔ Opus 5 2. Haiku Haiku 4.5 Enter to s et · Esc to cancel";

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["haiku"]);
});

test("parseClaudeModelPickerOutput ignores numbered settings warning actions", () => {
  const output = [
    "Settings Warning",
    "1. Continue",
    "2. Fix with Claude",
    "3. Exit and fix manually",
    "Enter to confirm · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output), []);
});

test("macOS Claude model discovery uses a full-height, system-expect-compatible PTY", () => {
  const script = (makeRunner() as any).claudeModelProbeExpectScript() as string;

  assert.match(script, /set stty_init "rows 40 columns 120"/);
  assert.match(script, /spawn \$env\(ACCORD_AGENTS_CLAUDE_EXECUTABLE\) --safe-mode --no-chrome/);
  assert.doesNotMatch(script, /spawn --/);
  assert.ok(script.indexOf("set stty_init") < script.indexOf("spawn $env"));
  assert.match(script, /Settings\.\*Warning/);
  assert.match(script, /Enter\.\*to\.\*confirm/);
  assert.match(script, /Transcript\.\*saving\.\*is\.\*off/);
  assert.match(script, /Enter\.\*to\.\*set\.\*Esc\.\*to\.\*cancel/);
  assert.match(script, /send "\\033"\nafter 250\nsend "\/exit\\r"\nset timeout 2/);
});

test("Claude model probe environment suppresses prompt history and session persistence", () => {
  const env = claudeModelProbeEnv({
    PATH: "/usr/bin",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "0",
    CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1"
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1"
  });
});

test("Claude model discovery falls back when the saved repository directory no longer exists", async () => {
  const deletedDirectory = await mkdtemp(path.join(tmpdir(), "accord-claude-deleted-cwd-"));
  await rm(deletedDirectory, { recursive: true, force: true });

  assert.equal(await resolveClaudeModelProbeCwd(deletedDirectory), process.cwd());
});

test("macOS Claude model discovery passes cwd, safe env, and ignored stdin through its spawn boundary", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    killed: false,
    exitCode: null as number | null,
    kill() {
      this.killed = true;
      return true;
    }
  });
  let launch: { command: string; args: readonly string[]; options: Record<string, any> } | undefined;
  const picker = "Select model 1. Default (recommended) ✔ Opus 4.8 2. Fable Fable 5 Enter to set · Esc to cancel";

  const probe = runClaudeModelProbeWithExpect({
    executable: "/tmp/claude-stub",
    env: {
      PATH: "/usr/bin",
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1"
    },
    cwd: "/tmp/trusted-repo",
    expectScript: "exit 0",
    timeoutMs: 1_000,
    spawnExpect: ((command: string, args: readonly string[], options: Record<string, any>) => {
      launch = { command, args, options };
      queueMicrotask(() => {
        stdout.write(picker);
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return child;
    }) as any
  });

  assert.deepEqual(parseClaudeModelPickerOutput(await probe).map((model) => model.id), ["fable"]);
  assert.equal(launch?.command, "expect");
  assert.deepEqual(launch?.args, ["-c", "exit 0"]);
  assert.equal(launch?.options.cwd, "/tmp/trusted-repo");
  assert.deepEqual(launch?.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(launch?.options.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, "1");
  assert.equal("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE" in launch!.options.env, false);
  assert.equal(launch?.options.env.ACCORD_AGENTS_CLAUDE_EXECUTABLE, "/tmp/claude-stub");
});

test("macOS Claude model discovery keeps a captured picker when process exit is late", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    killed: false,
    exitCode: null as number | null,
    kill() {
      killed = true;
      this.killed = true;
      return true;
    }
  });
  const picker = "Select model 1. Default (recommended) ✔ Opus 4.8 2. Fable Fable 5 Enter to set · Esc to cancel";

  const output = await runClaudeModelProbeWithExpect({
    executable: "/tmp/claude-stub",
    env: {},
    cwd: "/tmp/trusted-repo",
    expectScript: "set timeout -1",
    timeoutMs: 20,
    spawnExpect: (() => {
      queueMicrotask(() => stdout.write(picker));
      return child;
    }) as any
  });

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["fable"]);
  assert.equal(killed, true);
});

test("macOS Claude model discovery bounds captured output", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    killed: false,
    exitCode: null as number | null,
    kill() {
      killed = true;
      this.killed = true;
      return true;
    }
  });

  const probe = runClaudeModelProbeWithExpect({
    executable: "/tmp/claude-stub",
    env: {},
    cwd: "/tmp/trusted-repo",
    expectScript: "set timeout -1",
    timeoutMs: 1_000,
    maxOutputBytes: 16,
    spawnExpect: (() => {
      queueMicrotask(() => stdout.write("x".repeat(17)));
      return child;
    }) as any
  });

  await assert.rejects(probe, /exceeded 16 bytes/);
  assert.equal(killed, true);
});

test("macOS Claude model discovery executes the generated program through system Expect", { timeout: 10_000 }, async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS system Expect integration");
    return;
  }
  try {
    await access("/usr/bin/expect");
  } catch {
    t.skip("/usr/bin/expect is unavailable");
    return;
  }

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-model-probe-"));
  try {
    const stubProgram = `
printf 'STUB_CWD=%s\\r\\n' "$PWD"
printf 'STUB_SKIP=%s\\r\\n' "\${CLAUDE_CODE_SKIP_PROMPT_HISTORY-unset}"
printf 'STUB_FORCE=%s\\r\\n' "\${CLAUDE_CODE_FORCE_SESSION_PERSISTENCE-unset}"
if test -t 0; then printf 'STUB_TTY=yes\\r\\n'; else printf 'STUB_TTY=no\\r\\n'; fi
printf 'STUB_SIZE=%s\\r\\n' "$(stty size 2>/dev/null)"
printf 'Claude ready\\r\\n'
while IFS= read -r line; do
  case "$line" in
    *"/model"*) printf 'Select model\\r\\n1. Default (recommended) Opus 4.8\\r\\n2. Fable Fable 5\\r\\nEnter to set - Esc to cancel\\r\\n' ;;
    *"/exit"*) exit 0 ;;
  esac
done
`;

    const output = await runClaudeModelProbeWithExpect({
      executable: "/bin/sh",
      env: {
        ...process.env,
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
        ACCORD_AGENTS_CLAUDE_STUB_PROGRAM: stubProgram
      },
      cwd: fixtureDir,
      expectCommand: "/usr/bin/expect",
      expectScript: (makeRunner() as any).claudeModelProbeExpectScript(
        "-c $env(ACCORD_AGENTS_CLAUDE_STUB_PROGRAM)"
      ) as string,
      timeoutMs: 5_000
    });

    const expectedCwd = await realpath(fixtureDir);
    assert.match(output, new RegExp(`STUB_CWD=${expectedCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(output, /STUB_SKIP=1/);
    assert.match(output, /STUB_FORCE=unset/);
    assert.match(output, /STUB_TTY=yes/);
    assert.match(output, /STUB_SIZE=40 120/);
    assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["fable"]);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("macOS Claude model discovery continues past settings warnings before opening the picker", { timeout: 10_000 }, async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS system Expect integration");
    return;
  }
  try {
    await access("/usr/bin/expect");
  } catch {
    t.skip("/usr/bin/expect is unavailable");
    return;
  }

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-model-warning-"));
  try {
    const stubProgram = `
printf 'Settings Warning\\r\\n'
printf 'permissions.allow: Invalid permission rule "WebFetch*" was skipped\\r\\n'
printf '1. Continue\\r\\n2. Fix with Claude\\r\\n3. Exit and fix manually\\r\\n'
printf 'Enter to confirm - Esc to cancel\\r\\n'
warning_pending=1
while IFS= read -r line; do
  if test "$warning_pending" = 1; then
    warning_pending=0
    printf 'Safe mode: all customizations are disabled\\r\\n'
    printf 'Transcript saving is off\\r\\n'
    continue
  fi
  case "$line" in
    *"/model"*) printf 'Select model\\r\\n1. Default (recommended) Opus 5\\r\\n2. Fable Fable 5.1\\r\\nEnter to set - Esc to cancel\\r\\n' ;;
    *"/exit"*) exit 0 ;;
  esac
done
`;

    const output = await runClaudeModelProbeWithExpect({
      executable: "/bin/sh",
      env: {
        ...process.env,
        ACCORD_AGENTS_CLAUDE_STUB_PROGRAM: stubProgram
      },
      cwd: fixtureDir,
      expectCommand: "/usr/bin/expect",
      expectScript: (makeRunner() as any).claudeModelProbeExpectScript(
        "-c $env(ACCORD_AGENTS_CLAUDE_STUB_PROGRAM)"
      ) as string,
      timeoutMs: 5_000
    });

    assert.match(output, /Settings Warning/);
    assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["fable"]);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Windows Claude model discovery drives only the non-persistent interactive model picker", async () => {
  const writes: string[] = [];
  let launch: { executable: string; args: string[]; cwd: string; env: Record<string, string> } | undefined;
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  const output = [
    "Select model",
    "1. Default (recommended) ✔ Sonnet 4.6",
    "2. Opus Opus 4.8",
    "3. Sonnet Sonnet 4.6",
    "● Enter to set · Esc to cancel"
  ].join("\r\n");

  const probe = runClaudeModelProbeInPty({
    executable: "C:\\Program Files\\Claude\\claude.exe",
    env: { PATH: "C:\\Windows\\System32", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" },
    cwd: "C:\\trusted\\repo",
    timeoutMs: 1_000,
    initialDelayMs: 0,
    pickerSettleDelayMs: 0,
    exitDelayMs: 0,
    spawnPty: (executable, args, options) => {
      launch = { executable, args, cwd: options.cwd, env: options.env };
      queueMicrotask(() => onData?.("Safe mode: customizations disabled\r\nTranscript saving is off"));
      return {
        write: (data) => {
          writes.push(data);
          if (data === "/model\r") {
            queueMicrotask(() => onData?.(output));
          } else if (data === "/exit\r") {
            queueMicrotask(() => onExit?.({ exitCode: 0 }));
          }
        },
        kill: () => undefined,
        onData: (listener) => {
          onData = listener;
          return { dispose: () => undefined };
        },
        onExit: (listener) => {
          onExit = listener;
          return { dispose: () => undefined };
        }
      };
    }
  });

  const transcript = await probe;
  assert.deepEqual(launch, {
    executable: "C:\\Program Files\\Claude\\claude.exe",
    args: ["--safe-mode", "--no-chrome"],
    cwd: "C:\\trusted\\repo",
    env: {
      PATH: "C:\\Windows\\System32",
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1"
    }
  });
  assert.deepEqual(writes, ["/model\r", "\u001b", "/exit\r"]);
  assert.deepEqual(parseClaudeModelPickerOutput(transcript).map((model) => model.id), ["opus", "sonnet"]);
  assert.equal(writes.some((value) => !["/model\r", "\u001b", "/exit\r"].includes(value)), false);
});

test("Windows Claude model discovery never accepts a folder trust prompt", async () => {
  const writes: string[] = [];
  let killed = false;
  let onData: ((data: string) => void) | undefined;

  const probe = runClaudeModelProbeInPty({
    executable: "C:\\Program Files\\Claude\\claude.exe",
    env: { PATH: "C:\\Windows\\System32" },
    cwd: "C:\\untrusted\\repo",
    timeoutMs: 1_000,
    initialDelayMs: 0,
    pickerSettleDelayMs: 0,
    exitDelayMs: 0,
    spawnPty: () => {
      queueMicrotask(() => onData?.("Quick safety check: Is this a project you trust? 1. Yes, I trust this folder"));
      return {
        write: (data) => writes.push(data),
        kill: () => { killed = true; },
        onData: (listener) => {
          onData = listener;
          return { dispose: () => undefined };
        },
        onExit: () => ({ dispose: () => undefined })
      };
    }
  });

  await assert.rejects(probe, /requires this folder to be trusted/);
  assert.deepEqual(writes, []);
  assert.equal(killed, true);
});

test("Windows Claude model discovery bounds captured output", async () => {
  let killed = false;
  let onData: ((data: string) => void) | undefined;

  const probe = runClaudeModelProbeInPty({
    executable: "C:\\Program Files\\Claude\\claude.exe",
    env: { PATH: "C:\\Windows\\System32" },
    cwd: "C:\\trusted\\repo",
    timeoutMs: 1_000,
    initialDelayMs: 0,
    pickerSettleDelayMs: 0,
    exitDelayMs: 0,
    maxOutputBytes: 16,
    spawnPty: () => {
      queueMicrotask(() => onData?.("x".repeat(17)));
      return {
        write: () => undefined,
        kill: () => { killed = true; },
        onData: (listener) => {
          onData = listener;
          return { dispose: () => undefined };
        },
        onExit: () => ({ dispose: () => undefined })
      };
    }
  });

  await assert.rejects(probe, /exceeded 16 bytes/);
  assert.equal(killed, true);
});

test("Windows Claude catalogs never add configured or hard-coded fallback models", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific exact catalog behavior");
    return;
  }
  const runner = makeRunner() as any;
  runner.listClaudeModelCatalog = async (fetchedAt: string) => ({
    kind: "claude-code",
    models: [{ id: "account-offered", label: "Account offered", source: "cli" }],
    authoritative: true,
    fetchedAt
  });
  const catalog = await runner.listModelCatalog("claude-code", "configured-but-not-offered");
  assert.deepEqual(catalog.models.map((model: { id: string }) => model.id), ["account-offered"]);
  const cachedCatalog = await runner.listModelCatalog("claude-code", "configured-but-not-offered");
  assert.deepEqual(cachedCatalog.models.map((model: { id: string }) => model.id), ["account-offered"]);

  runner.modelCatalogs.clear();
  runner.listClaudeModelCatalog = async () => { throw new Error("picker unavailable"); };
  const failed = await runner.listModelCatalog("claude-code", "configured-but-not-offered");
  assert.deepEqual(failed.models, []);
  assert.equal(failed.authoritative, false);
});

test("codex app-server stream keeps token deltas joined inside one agent message", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event)
  });
  const participant = { id: "p1", label: "Agent" };

  runner.handleCodexAppServerNotification(
    { method: "item/started", params: { item: { type: "agentMessage" } } },
    participant,
    pending,
    () => pending,
    (error: Error) => { throw error; }
  );
  runner.handleCodexAppServerNotification(
    { method: "item/agentMessage/delta", params: { delta: "hel" } },
    participant,
    pending,
    () => pending,
    (error: Error) => { throw error; }
  );
  runner.handleCodexAppServerNotification(
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
  runner.handleCodexAppServerNotification(
    { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
    participant,
    started,
    () => started,
    fail
  );
  assert.equal(started.acceptedByProvider, true);

  const itemEvidence = makeCodexPendingTurn();
  runner.handleCodexAppServerNotification(
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
    runner.handleCodexAppServerNotification(
      { method: "item/started", params: { item: { type: "agentMessage" } } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/agentMessage/delta", params: { delta: text } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/completed", params: { item: { type: "agentMessage", text } } },
      participant,
      pending,
      () => pending,
      fail
    );
  }
  runner.handleCodexAppServerNotification(
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
  const send = (record: Record<string, unknown>): void => runner.handleCodexAppServerNotification(
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

  assert.equal(outputs.find((event) => event.kind === "tool")?.text, "Using web search\n");
  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "Current EUR/RUB is about 1 EUR = 89.88 RUB.");
  assert.equal((resolved[0] as { content: string }).content, "Current EUR/RUB is about 1 EUR = 89.88 RUB.");
});

test("codex app-server stream emits completed native subagent activity", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; text: string; cumulative?: string; activityKind?: string; activityStatus?: string; activityItemId?: string }> = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; text: string; cumulative?: string; activityKind?: string; activityStatus?: string; activityItemId?: string }) => outputs.push(event)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };

  runner.handleCodexAppServerNotification(
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
  const send = (record: Record<string, unknown>): void => runner.handleCodexAppServerNotification(
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
  const send = (record: Record<string, unknown>): void => runner.handleCodexAppServerNotification(
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
  const send = (record: Record<string, unknown>): void => runner.handleCodexAppServerNotification(
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
  const send = (record: Record<string, unknown>): void => runner.handleCodexAppServerNotification(
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
  assert.equal(mcpEvents[1]?.text, mcpEvents[0]?.text);
  assert.match(mcpEvents.at(-1)?.activityDetail ?? "", /"role": "engineer"/);
  assert.match(mcpEvents.at(-1)?.activityDetail ?? "", /MCP_RESULT_LAST/);

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

  runner.handleCodexAppServerNotification(
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
  const send = (record: Record<string, unknown>): void => runner.handleCodexAppServerNotification(
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
  assert.match(startedDetail, /"path": "src\/large\.ts"/);
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
  const send = (kind: string): void => runner.handleCodexAppServerNotification(
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

  runner.handleCodexAppServerNotification(
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "other-turn", status: "completed" } } },
    participant,
    pending,
    cleanup,
    fail
  );
  runner.handleCodexAppServerNotification(
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
  const send = (record: Record<string, unknown>): void => runner.handleCodexAppServerNotification(
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
    runner.handleCodexAppServerNotification(
      { method: "item/started", params: { item: { type: "agentMessage" } } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/agentMessage/delta", params: { delta: text } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/completed", params: { item: { type: "agentMessage", text } } },
      participant,
      pending,
      () => pending,
      fail
    );
  };

  sendAgentMessage("Current EUR/RUB is about 1 EUR = 89.88 RUB. (exchange-rates.org)");
  sendAgentMessage("For comparison, the Bank of Russia official rate is 87.4027 RUB per EUR. (cbr.ru)");
  runner.handleCodexAppServerNotification(
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
    runner.handleCodexAppServerNotification(
      { method: "item/started", params: { item: { type: "agentMessage" } } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/agentMessage/delta", params: { delta: text } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/completed", params: { item: { type: "agentMessage", text } } },
      participant,
      pending,
      () => pending,
      fail
    );
  }
  runner.handleCodexAppServerNotification(
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
    runner.handleCodexAppServerNotification(
      { method: "item/started", params: { item: { id, type: "agentMessage", phase } } },
      participant,
      pending,
      () => pending,
      fail
    );
    const splitAt = Math.floor(text.length / 2);
    for (const delta of [text.slice(0, splitAt), text.slice(splitAt)]) {
      runner.handleCodexAppServerNotification(
        { method: "item/agentMessage/delta", params: { itemId: id, delta } },
        participant,
        pending,
        () => pending,
        fail
      );
    }
    runner.handleCodexAppServerNotification(
      { method: "item/completed", params: { item: { id, type: "agentMessage", phase, text } } },
      participant,
      pending,
      () => pending,
      fail
    );
  };

  sendAgentItem("commentary-1", "commentary", commentary);
  sendAgentItem("final-1", "final_answer", final);
  runner.handleCodexAppServerNotification(
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

  runner.handleCodexAppServerNotification(
    { method: "item/started", params: { item: { id: "message-1", type: "agentMessage" } } },
    participant,
    pending,
    () => pending,
    fail
  );
  for (const delta of ["First line\r", "\nSecond line\r"]) {
    runner.handleCodexAppServerNotification(
      { method: "item/agentMessage/delta", params: { itemId: "message-1", delta } },
      participant,
      pending,
      () => pending,
      fail
    );
  }
  runner.handleCodexAppServerNotification(
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
  runner.handleCodexAppServerNotification(
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

  runner.handleCodexAppServerNotification(
    { method: "item/started", params: { item: { type: "agentMessage" } } },
    participant,
    pending,
    () => pending,
    fail
  );
  runner.handleCodexAppServerNotification(
    { method: "item/agentMessage/delta", params: { delta: "I’ll check the sources first.\n\nFinal answer." } },
    participant,
    pending,
    () => pending,
    fail
  );
  runner.handleCodexAppServerNotification(
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

  assert.equal(runner.agentMessageBoundarySeparator(previous, next), " ");
  assert.equal(
    runner.agentMessageBoundarySeparator(previous, next, { fencedBlockEndsBlock: true }),
    "\n\n"
  );
});

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

function chatOptions(overrides: {
  agentMode: "default" | "plan" | "auto";
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

function claudeAllowedToolsFromArgs(args: string[]): string[] {
  const index = args.indexOf("--allowedTools");
  return index >= 0 ? (args[index + 1] ?? "").split(",").filter(Boolean) : [];
}

test("claude launch diagnostics redact MCP tokens, inline settings, and role instructions", () => {
  const runner = makeRunner() as any;
  const args = [
    "-p",
    "--mcp-config",
    "{\"headers\":{\"Authorization\":\"Bearer secret-token\"}}",
    "--settings",
    "{\"permissions\":{\"ask\":[\"Bash(secret-path)\"]}}",
    "--agents",
    "{\"role\":{\"prompt\":\"private instructions\"}}",
    "--add-dir",
    "/repo/history"
  ];

  const redacted = runner.redactedClaudeArgs(args) as string[];
  assert.equal(redacted.join(" ").includes("secret-token"), false);
  assert.equal(redacted.join(" ").includes("secret-path"), false);
  assert.equal(redacted.join(" ").includes("private instructions"), false);
  assert.ok(redacted.includes("/repo/history"));
  assert.equal(redacted.filter((value) => value === "<redacted>").length, 3);
});

test("claude denial diagnostics retain only categorical layer evidence", () => {
  const runner = makeRunner() as any;
  const secretCanary = "CANARY_SECRET /private/target $(cat ~/.ssh/id_ed25519)";
  const denials = runner.claudePermissionDenials(JSON.stringify({
    permission_denials: [
      { tool_name: "Write", reason: secretCanary, input: { file_path: "/secret/file" } },
      { tool_name: "Bash", stage: "sandbox", decision_code: "sandbox_denied", message: secretCanary },
      { tool_name: "Read", stage: "novel-runtime-stage", decision_reason: secretCanary }
    ]
  }));

  assert.deepEqual(denials, [
    {
      toolName: "Write",
      layer: "provider-native-permission-or-classifier",
      decisionCode: "permission_denied"
    },
    {
      toolName: "Bash",
      layer: "provider-sandbox-settings-or-os",
      decisionCode: "sandbox_denied"
    },
    {
      toolName: "Read",
      layer: "unknown-provider-runtime",
      decisionCode: "permission_denied",
      missingEvidence: ["recognized denial stage/category"]
    }
  ]);
  assert.equal(JSON.stringify(denials).includes("/secret/file"), false);
  assert.equal(JSON.stringify(denials).includes(secretCanary), false);
});

test("claude denial diagnostics do not warn for a successful Auto classifier decision", () => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const runner = new CliAgentRunner({
    async write(event, payload) {
      events.push({ event, payload });
    }
  }) as any;
  const participant = { id: "claude-1", kind: "claude-code", label: "@claude" };
  const raw = {
    permission_denials: [{ tool_name: "Write", reason: "private target path" }]
  };
  const success = runner.withClaudePermissionDenialWarning({
    participant,
    ok: true,
    content: "Handled safely.",
    durationMs: 1
  }, raw, participant, "one-shot");
  const failure = runner.withClaudePermissionDenialWarning({
    participant,
    ok: false,
    content: "Failed.",
    error: "failed",
    durationMs: 1
  }, raw, participant, "one-shot");

  assert.equal(success.warnings, undefined);
  assert.equal(failure.warnings.length, 1);
  assert.match(failure.warnings[0], /native permission\/classifier layer/);
  assert.equal(JSON.stringify(events).includes("private target path"), false);
});

test("claudeToolConfig maps default + workspaceWrite=true to acceptEdits", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: true
  }));
  assert.equal(config.permissionMode, "acceptEdits");
  assert.ok(config.tools.includes("Write"));
  assert.ok(config.tools.includes("Edit"));
  assert.equal(config.disallowedTools.includes("Write"), false);
  assert.equal(config.disallowedTools.includes("Edit"), false);
});

test("claudeToolConfig maps default + workspaceWrite=false to default and disallows editors", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false
  }));
  assert.equal(config.permissionMode, "default");
  assert.equal(config.tools.includes("Write"), false);
  assert.equal(config.tools.includes("Edit"), false);
  assert.ok(config.disallowedTools.includes("Write"));
  assert.ok(config.disallowedTools.includes("Edit"));
  assert.equal(config.disallowedTools.includes("MultiEdit"), false);
  assert.ok(config.disallowedTools.includes("NotebookEdit"));
});

test("claudeToolConfig auto-allows web tools when webAccess is true", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: true
  }));
  assert.ok(config.tools.includes("WebSearch"));
  assert.ok(config.tools.includes("WebFetch"));
  assert.ok(config.allowedTools.includes("WebSearch"));
  assert.ok(config.allowedTools.includes("WebFetch"));
  assert.equal(config.disallowedTools.includes("WebSearch"), false);
  assert.equal(config.disallowedTools.includes("WebFetch"), false);
});

test("claudeToolConfig disallows web tools when webAccess is false", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: false
  }));
  assert.equal(config.tools.includes("WebSearch"), false);
  assert.equal(config.tools.includes("WebFetch"), false);
  assert.equal(config.allowedTools.includes("WebSearch"), false);
  assert.equal(config.allowedTools.includes("WebFetch"), false);
  assert.ok(config.disallowedTools.includes("WebSearch"));
  assert.ok(config.disallowedTools.includes("WebFetch"));
});

test("claudeToolConfig auto mode uses native auto permission mode with Bash available", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    webAccess: false
  }));
  assert.equal(config.permissionMode, "auto");
  assert.ok(config.tools.includes("Write"));
  assert.ok(config.tools.includes("Edit"));
  assert.ok(config.tools.includes("WebSearch"));
  assert.ok(config.tools.includes("WebFetch"));
  assert.ok(config.allowedTools.includes("WebSearch"));
  assert.ok(config.allowedTools.includes("WebFetch"));
  // Bash is available so the native auto classifier can decide each command; it is
  // neither broadly allowlisted (that would bypass the classifier) nor disallowed.
  assert.ok(config.tools.includes("Bash"));
  assert.equal(config.allowedTools.includes("Bash"), false);
  assert.equal(config.disallowedTools.includes("Bash"), false);
});

test("claudeToolConfig auto mode ignores all stored shell rules", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    webAccess: false,
    shell: {
      enabled: true,
      rules: [
        { action: "deny", match: "prefix", pattern: "rm -rf" },
        { action: "allow", match: "prefix", pattern: "curl" },
        { action: "ask", match: "exact", pattern: "git push" }
      ]
    }
  }));
  assert.equal(config.permissionMode, "auto");
  assert.ok(config.tools.includes("Bash"));
  assert.equal(config.disallowedTools.some((tool: string) => tool.includes("rm -rf")), false);
  assert.equal(config.allowedTools.some((tool: string) => tool.includes("curl")), false);
  assert.equal(config.askTools.some((tool: string) => tool.includes("git push")), false);
  assert.equal(config.allowedTools.includes("Bash"), false);
});

test("claudeToolConfig leaves plan agent mode untouched regardless of workspaceWrite", () => {
  const runner = makeRunner() as any;
  const planNoWrite = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "plan",
    workspaceWrite: false
  }));
  const planWithWrite = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "plan",
    workspaceWrite: true
  }));
  assert.equal(planNoWrite.permissionMode, "plan");
  assert.equal(planWithWrite.permissionMode, "plan");
  // plan mode disables workspaceWrite via effective permissions, so editors stay disallowed
  assert.ok(planWithWrite.disallowedTools.includes("Write"));
});

test("claudeToolConfig enables native Skill tool without selected skills", () => {
  const runner = makeRunner() as any;
  const chatConfig = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false
  }));
  const reviewConfig = runner.claudeToolConfig("code-review", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false
  }));

  assert.ok(chatConfig.tools.includes("Skill"));
  assert.ok(chatConfig.allowedTools.includes("Skill"));
  assert.ok(reviewConfig.tools.includes("Skill"));
  assert.ok(reviewConfig.allowedTools.includes("Skill"));
});

test("claudeToolConfig enables subagent spawning (Agent/Task) across kinds", () => {
  const runner = makeRunner() as any;
  const configs = [
    runner.claudeToolConfig("chat", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false })),
    runner.claudeToolConfig("chat", "/repo", [], chatOptions({ agentMode: "auto", workspaceWrite: false })),
    runner.claudeToolConfig("general", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false })),
    runner.claudeToolConfig("code-review", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false })),
    runner.claudeToolConfig("implementation-plan", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false }))
  ];

  for (const config of configs) {
    for (const tool of ["Agent", "Task"]) {
      assert.ok(config.tools.includes(tool), `tools should include ${tool}`);
      assert.ok(config.allowedTools.includes(tool), `allowedTools should include ${tool}`);
      assert.equal(config.disallowedTools.includes(tool), false, `disallowedTools should not include ${tool}`);
    }
  }
});

test("claude chat MCP config is additive and does not pass strict or closed tools", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    canRequestPermissions: true,
    appToolNames: ["app_permissions_request_change", "app_tool_permission"]
  });
  const config = runner.claudeToolConfig("chat", "/repo", [], options);
  const mcpArgs = runner.claudeMcpArgs("chat", options);
  const toolsArgs = runner.claudeToolsArgs("chat", config, options);

  assert.deepEqual(mcpArgs.slice(0, 1), ["--mcp-config"]);
  assert.equal(mcpArgs.includes("--strict-mcp-config"), false);
  assert.deepEqual(toolsArgs, []);
  const parsed = JSON.parse(mcpArgs[1]);
  assert.equal(parsed.mcpServers.accord_agents.type, "http");
  assert.equal(parsed.mcpServers.accord_agents.url, "http://127.0.0.1:1/mcp");
});

test("claude default chat delegates unmatched tool approvals to app_tool_permission", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    canRequestPermissions: true,
    appToolNames: ["app_permissions_request_change", "app_tool_permission"]
  });

  assert.deepEqual(runner.claudePermissionPromptArgs("chat", options), [
    "--permission-prompt-tool",
    "mcp__accord_agents__app_tool_permission"
  ]);
});

test("claude auto chat preauthorizes the eligible exposed app MCP inventory only", () => {
  const runner = makeRunner() as any;
  const eligibleAppTools = [
    "mcp__accord_agents__app_chat_get_context",
    "mcp__accord_agents__app_chat_get_participants",
    "mcp__accord_agents__app_chat_get_participant_activity",
    "mcp__accord_agents__app_chat_get_participant_request_status",
    "mcp__accord_agents__app_chat_read_messages",
    "mcp__accord_agents__app_chat_list_attachments",
    "mcp__accord_agents__app_chat_read_attachment",
    "mcp__accord_agents__app_chat_react",
    "mcp__accord_agents__app_chat_send_message",
    "mcp__accord_agents__app_chat_set_title",
    "mcp__accord_agents__app_permissions_request_change"
  ];
  const options = chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    webAccess: true,
    canRequestPermissions: true,
    appToolNames: [
      "app_chat_get_context",
      "app_chat_get_participants",
      "app_chat_get_participant_activity",
      "app_chat_get_participant_request_status",
      "app_chat_read_messages",
      "app_chat_list_attachments",
      "app_chat_read_attachment",
      "app_chat_export_attachment",
      "app_chat_react",
      "app_chat_send_message",
      "app_chat_set_title",
      "app_permissions_request_change",
      "app_tool_permission"
    ]
  });
  const config = runner.claudeToolConfig("chat", "/repo", [], options);
  const args = runner.claudeAllowedToolsArgs("chat", options, config);
  const allowedTools = claudeAllowedToolsFromArgs(args);

  assert.equal(config.allowedTools.length > 0, true);
  assert.deepEqual(args.slice(0, 1), ["--allowedTools"]);
  assert.deepEqual(allowedTools, eligibleAppTools);
  for (const tool of [
    "mcp__accord_agents__app_chat_export_attachment",
    "mcp__accord_agents__app_tool_permission",
    "Bash",
    "Edit",
    "Write",
    "NotebookEdit",
    "WebSearch",
    "WebFetch"
  ]) {
    assert.equal(allowedTools.includes(tool), false, `${tool} should not be auto-allowed`);
  }
  assert.deepEqual(runner.claudePermissionPromptArgs("chat", options), [
    "--permission-prompt-tool",
    "mcp__accord_agents__app_tool_permission"
  ]);
});

test("claude Plan and non-chat runs do not receive the chat permission prompt bridge", () => {
  const runner = makeRunner() as any;
  const plan = chatOptions({
    agentMode: "plan",
    workspaceWrite: false,
    appToolNames: ["app_tool_permission"]
  });
  const auto = chatOptions({
    agentMode: "auto",
    workspaceWrite: true,
    appToolNames: ["app_tool_permission"]
  });

  assert.deepEqual(runner.claudePermissionPromptArgs("chat", plan), []);
  assert.deepEqual(runner.claudePermissionPromptArgs("single", auto), []);
});

test("claude auto app MCP preauthorization is deny-by-default and intersects exposed tools", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    canRequestPermissions: true,
    appToolNames: ["app_artifact_create", "app_chat_export_attachment", "app_tool_permission"],
    autoPreauthorizedToolNames: ["app_artifact_create", "app_unexposed", "app_chat_export_attachment", "app_tool_permission"]
  });
  const config = runner.claudeToolConfig("chat", "/repo", [], options);
  const allowedTools = claudeAllowedToolsFromArgs(runner.claudeAllowedToolsArgs("chat", options, config));

  assert.deepEqual(allowedTools, [
    "mcp__accord_agents__app_artifact_create",
    "mcp__accord_agents__app_chat_export_attachment"
  ]);
  assert.equal(allowedTools.includes("mcp__accord_agents__app_tool_permission"), false);

  const noClassification = {
    ...options,
    appMcp: { ...options.appMcp, autoPreauthorizedToolNames: undefined }
  };
  assert.deepEqual(runner.claudeAllowedToolsArgs(
    "chat",
    noClassification,
    runner.claudeToolConfig("chat", "/repo", [], noClassification)
  ), []);
});

test("claude production launch-argv matrix preserves Auto authority across session paths", () => {
  const runner = makeRunner() as any;
  const participant = {
    id: "claude-1",
    kind: "claude-code",
    label: "@claude",
    model: undefined,
    reasoningEffort: undefined
  };
  const base = chatOptions({
    agentMode: "auto",
    workspaceWrite: true,
    webAccess: true,
    canRequestPermissions: true,
    appToolNames: ["app_artifact_create", "app_chat_export_attachment", "app_tool_permission"]
  });
  const scenarios: Array<{
    name: string;
    transport: "one-shot" | "warm";
    options: any;
    newSessionId?: string;
  }> = [
    { name: "cold", transport: "one-shot", options: base, newSessionId: "new-session" },
    { name: "warm", transport: "warm", options: base, newSessionId: "warm-session" },
    { name: "idle-respawn", transport: "warm", options: base, newSessionId: "idle-respawn-session" },
    { name: "resume", transport: "one-shot", options: { ...base, sessionId: "resume-session" } },
    { name: "retry-fallback", transport: "one-shot", options: { ...base, warm: undefined }, newSessionId: "retry-session" },
    { name: "participant-request", transport: "warm", options: base, newSessionId: "request-session" },
    { name: "restored-session", transport: "one-shot", options: { ...base, sessionId: "restored-session" } }
  ];

  for (const scenario of scenarios) {
    const config = runner.claudeToolConfig("chat", "/selected/repo", ["/chat-history"], scenario.options);
    const args = runner.claudeLaunchArgs(
      participant,
      "chat",
      scenario.options,
      config,
      ["/chat-history"],
      scenario.transport,
      scenario.newSessionId
    ) as string[];
    const allowedTools = claudeAllowedToolsFromArgs(args);

    assert.deepEqual(allowedTools, ["mcp__accord_agents__app_artifact_create"], scenario.name);
    assert.equal(args.includes("--tools"), false, scenario.name);
    assert.equal(args.includes("--disallowedTools"), false, scenario.name);
    assert.equal(args.includes("/outside/explicit-target.txt"), false, scenario.name);
    assert.equal(args.includes("--add-dir"), true, scenario.name);
    assert.equal(args.includes("/chat-history"), true, scenario.name);
    assert.equal(
      args.filter((arg) => arg === "--permission-mode").length,
      1,
      `${scenario.name}: permission mode flag count`
    );
    assert.equal(args[args.indexOf("--permission-mode") + 1], "auto", scenario.name);
    assert.equal(
      args.filter((arg) => arg === "--permission-prompt-tool").length,
      1,
      `${scenario.name}: permission prompt flag count`
    );
    assert.equal(
      args[args.indexOf("--permission-prompt-tool") + 1],
      "mcp__accord_agents__app_tool_permission",
      scenario.name
    );
    for (const nativeTool of ["Bash", "Edit", "Write", "Read", "WebSearch", "Skill", "Agent", "Task"]) {
      assert.equal(allowedTools.includes(nativeTool), false, `${scenario.name}:${nativeTool}`);
    }
    if (scenario.options.sessionId) {
      assert.equal(args.includes("--resume"), true, scenario.name);
    }
  }
});

test("claude outside-directory parity fixture adds no app path denial or writable root", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "auto",
    workspaceWrite: true,
    webAccess: true,
    canRequestPermissions: true,
    appToolNames: ["app_artifact_create"]
  });
  const config = runner.claudeToolConfig("chat", "/selected/repo", ["/chat-history"], options);
  const args = runner.claudeLaunchArgs(
    { id: "claude-1", kind: "claude-code", label: "@claude" },
    "chat",
    options,
    config,
    ["/chat-history"],
    "one-shot",
    "session-1"
  ) as string[];
  const serialized = JSON.stringify(args);

  assert.equal(config.permissionMode, "auto");
  assert.deepEqual(config.disallowedTools, []);
  assert.deepEqual(config.askTools, []);
  assert.equal(serialized.includes("/outside/explicit-target.txt"), false);
  assert.equal(serialized.includes("sandbox.filesystem.allowWrite"), false);
  assert.equal(serialized.includes("writable_roots"), false);
});

test("claude native goal uses one streaming print invocation", () => {
  const runner = makeRunner() as any;
  const options = {
    ...chatOptions({
      agentMode: "auto",
      workspaceWrite: true,
      webAccess: true
    }),
    nativeGoal: { name: "goal", objective: "finish the task" }
  };
  const config = runner.claudeToolConfig("chat", "/repo", [], options);
  const args = runner.claudeLaunchArgs(
    { id: "claude-1", kind: "claude-code", label: "@claude" },
    "chat",
    options,
    config,
    [],
    "one-shot-stream",
    "session-1"
  ) as string[];

  assert.equal(args.filter((value) => value === "-p").length, 1);
  assert.equal(args.includes("--include-partial-messages"), true);
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args.includes("--input-format"), false);
});

test("native goal idle detector warns once per idle episode and rearms on activity", async () => {
  const runner = makeRunner() as any;
  const outputs: unknown[] = [];
  const monitor = runner.createNativeGoalIdleMonitor(
    { id: "p1", kind: "claude-code", label: "Claude" },
    (event: unknown) => outputs.push(event),
    15
  );
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(outputs.length, 1);
  assert.equal((outputs[0] as { activityDetail?: string }).activityDetail, undefined);
  monitor.touch();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(outputs.length, 2);
  monitor.close();
});

test("claude auto chat without app MCP still omits allowedTools", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    webAccess: true
  });
  const config = runner.claudeToolConfig("chat", "/repo", [], options);

  assert.equal(config.allowedTools.length > 0, true);
  assert.deepEqual(runner.claudeAllowedToolsArgs("chat", options, config), []);
});

test("claude default and plan chats keep full app MCP allowedTools", () => {
  const runner = makeRunner() as any;
  for (const agentMode of ["default", "plan"] as const) {
    const options = chatOptions({
      agentMode,
      workspaceWrite: false,
      canRequestPermissions: true,
      appToolNames: [
        "app_chat_list_attachments",
        "app_chat_read_attachment",
        "app_chat_export_attachment",
        "app_permissions_request_change"
      ]
    });
    const config = runner.claudeToolConfig("chat", "/repo", [], options);
    const allowedTools = claudeAllowedToolsFromArgs(runner.claudeAllowedToolsArgs("chat", options, config));

    for (const tool of [
      "mcp__accord_agents__app_chat_list_attachments",
      "mcp__accord_agents__app_chat_read_attachment",
      "mcp__accord_agents__app_chat_export_attachment",
      "mcp__accord_agents__app_permissions_request_change"
    ]) {
      assert.equal(allowedTools.includes(tool), true, `${agentMode} should keep ${tool}`);
    }
  }
});

test("claude default chat still hard-denies off-toggle capabilities via disallowedTools", () => {
  const runner = makeRunner() as any;
  // Dropping the closed --tools whitelist must not weaken off-toggle enforcement:
  // workspaceWrite/webAccess/shell all OFF (the defaultChatAgentPermissions baseline)
  // still has to emit hard denies so escalation only ever applies to unknown tools.
  const options = chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: false,
    canRequestPermissions: true,
    appToolNames: ["app_permissions_request_change", "app_tool_permission"]
  });
  const config = runner.claudeToolConfig("chat", "/repo", [], options);
  const disallowed = new Set(config.disallowedTools as string[]);

  for (const tool of ["Edit", "Write", "NotebookEdit", "WebSearch", "WebFetch", "Bash"]) {
    assert.equal(disallowed.has(tool), true, `expected ${tool} to be hard-denied`);
  }
  assert.equal(disallowed.has("MultiEdit"), false);
});

test("claude non-chat keeps strict app MCP config and explicit tools", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    canRequestPermissions: true,
    appToolNames: ["app_permissions_request_change", "app_tool_permission"]
  });
  const config = runner.claudeToolConfig("code-review", "/repo", [], options);

  assert.ok(runner.claudeMcpArgs("code-review", options).includes("--strict-mcp-config"));
  assert.deepEqual(runner.claudePermissionPromptArgs("code-review", options), []);
  assert.deepEqual(runner.claudeToolsArgs("code-review", config, options).slice(0, 1), ["--tools"]);
});

test("codex app-server auto mode applies workspace-write web preset and native auto reviewer", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined,
    reasoningEffort: "xhigh"
  };
  const params = runner.codexAppServerThreadStartParams(
    participant,
    "/repo",
    "chat",
    chatOptions({
      agentMode: "auto",
      workspaceWrite: false,
      webAccess: false
    })
  );

  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.approvalsReviewer, "auto_review");
  assert.equal(params.sandbox, "workspace-write");
  assert.equal(params.config.web_search, "live");
  assert.equal(params.config.model_reasoning_effort, "xhigh");
});

test("Codex model catalog handles server requests and rejects external-token refresh contract drift", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-model-catalog-"));
  const originalCwd = process.cwd();
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let initializeId;
let modelListId;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.params?.capabilities?.requestAttestation !== false) process.exit(61);
    initializeId = message.id;
    send({ id: "current-time", method: "currentTime/read", params: {} });
  } else if (message.id === "current-time") {
    if (typeof message.result?.currentTimeAt !== "number") process.exit(62);
    send({ id: initializeId, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "model/list") {
    modelListId = message.id;
    send({ id: "token-refresh", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: null } });
  } else if (message.id === "token-refresh") {
    if (message.error?.code !== -32601 || !String(message.error?.message).includes("never supplies external ChatGPT tokens")) process.exit(63);
    send({ id: modelListId, result: { data: [{ id: "gpt-fixture", displayName: "Fixture", isDefault: true }], nextCursor: null } });
  } else if (message.method === "account/login/start") {
    process.exit(64);
  }
});
`);
  process.chdir(fixtureDir);
  const runner = new CliAgentRunner(undefined, undefined, codexPath);
  try {
    const catalog = await runner.listModelCatalog("codex-cli");
    assert.equal(catalog.authoritative, true, catalog.error);
    assert.equal(catalog.models[0]?.id, "gpt-fixture");
  } finally {
    await runner.shutdownWarmAgents();
    process.chdir(originalCwd);
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("every non-interactive Codex exec path explicitly disables approvals", () => {
  for (const options of [
    { agentMode: "default" as const },
    { agentMode: "plan" as const, sessionId: "session-1" },
    { agentMode: "auto" as const, remoteSandbox: { networkAccess: true, gitWritableRoot: "/tmp/repo" } }
  ]) {
    const invocation = buildCodexExecInvocation({
      participant: { id: "participant", kind: "codex-cli", label: "Codex" },
      prompt: "Prompt",
      outputPath: "/tmp/output",
      repoPath: "/tmp/repo",
      kind: "chat",
      options
    });
    assert.equal(invocation.args.includes('approval_policy="never"'), true, invocation.args.join(" "));
  }
});

test("codex exec carries a member's provider -c overrides on fresh and resumed sessions, never the key", () => {
  const participant = {
    id: "participant",
    kind: "codex-cli" as const,
    label: "Codex",
    model: "glm-5.3",
    codexConfigOverrides: [
      'model_provider="accordagents_host"',
      'model_providers.accordagents_host.base_url="https://api.z.ai/api/v1"',
      'model_providers.accordagents_host.wire_api="responses"',
      'model_providers.accordagents_host.env_key="CODEX_PROVIDER_HOST_API_KEY"'
    ]
  };
  const fresh = buildCodexExecInvocation({ participant, prompt: "Prompt", outputPath: "/tmp/output", repoPath: "/tmp/repo", kind: "chat", options: { agentMode: "default" } });
  const resumed = buildCodexExecInvocation({ participant, prompt: "Prompt", outputPath: "/tmp/output", repoPath: "/tmp/repo", kind: "chat", options: { agentMode: "default", sessionId: "session-1" } });
  for (const [label, invocation] of [["fresh", fresh], ["resumed", resumed]] as const) {
    const args = invocation.args;
    for (const override of participant.codexConfigOverrides) {
      const index = args.indexOf(override);
      assert.ok(index > 0, `${label}: ${override} missing in ${args.join(" ")}`);
      assert.equal(args[index - 1], "-c", label);
      // Options precede the prompt placeholder / session id, as codex requires.
      assert.ok(index < args.lastIndexOf("-"), `${label}: override after prompt in ${args.join(" ")}`);
    }
    assert.equal(args.some((arg) => /CODEX_PROVIDER_HOST_API_KEY=/.test(arg) || /zai-secret/.test(arg)), false, label);
  }
  assert.equal(resumed.args.indexOf("session-1") > resumed.args.lastIndexOf("-c"), true, "resume: session id stays after -c options");
});

test("codex app-server is launched with a member's provider overrides before --listen, sees the key only in env, and closeWarmAgents retires it", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-app-server-host-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-fixture" }, model: "glm-5.3" } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-fixture" } } });
    const report = JSON.stringify({ argv: process.argv.slice(1), keyPresent: process.env.CODEX_PROVIDER_HOST_API_KEY === "zai-secret" });
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-fixture", turnId: "turn-fixture", itemId: "agent-fixture", delta: report } });
    send({ method: "item/completed", params: { threadId: "thread-fixture", turnId: "turn-fixture", item: { id: "agent-fixture", type: "agentMessage", text: report } } });
    send({ method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "completed" } } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  const overrides = ['model_provider="accordagents_host"', 'model_providers.accordagents_host.env_key="CODEX_PROVIDER_HOST_API_KEY"'];
  try {
    const result = await runner.runCodexAppServerWarmOrOneShot(
      { id: "participant-fixture", kind: "codex-cli", label: "Codex", codexConfigOverrides: overrides },
      "Report your launch.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "default",
        agentEnv: { CODEX_PROVIDER_HOST_API_KEY: "zai-secret" },
        agentEnvKey: "host:h1",
        warm: { conversationId: "conversation-fixture", participantId: "participant-fixture", contextKey: "context-fixture", idleTimeoutMs: 60_000 }
      }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const report = JSON.parse(result.content) as { argv: string[]; keyPresent: boolean };
    const listenIndex = report.argv.indexOf("--listen");
    for (const override of overrides) {
      const index = report.argv.indexOf(override);
      assert.ok(index > 0 && report.argv[index - 1] === "-c", report.argv.join(" "));
      assert.ok(index < listenIndex, "overrides precede --listen");
    }
    assert.equal(report.argv.some((arg) => arg.includes("zai-secret")), false, "key never in argv");
    assert.equal(report.keyPresent, true, "key reaches the process env");
    assert.equal(runner.warmAgents.size, 1);
    await runner.closeWarmAgents("conversation-fixture", "participant-fixture", "provider-binding-changed");
    assert.equal(runner.warmAgents.size, 0);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server production transport round-trips an approval and acknowledges delivery", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-app-server-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.params?.capabilities?.requestAttestation !== false) process.exit(21);
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-fixture" }, model: "gpt-5" } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-fixture" } } });
    send({ method: "turn/started", params: { threadId: "thread-fixture", turn: { id: "turn-fixture" } } });
    send({
      id: "approval-fixture",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-fixture",
        turnId: "turn-fixture",
        itemId: "item-fixture",
        startedAtMs: 1,
        environmentId: null,
        command: "git push origin scratch",
        cwd: process.cwd(),
        availableDecisions: ["accept", "decline"]
      }
    });
    return;
  }
  if (message.id === "approval-fixture") {
    if (message.result?.decision !== "accept") process.exit(22);
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-fixture", turnId: "turn-fixture", itemId: "agent-fixture", delta: "Approval delivered." } });
    send({ method: "item/completed", params: { threadId: "thread-fixture", turnId: "turn-fixture", item: { id: "agent-fixture", type: "agentMessage", text: "Approval delivered." } } });
    send({ method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "completed" } } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let delivered = false;
  try {
    const result = await runner.runCodexAppServerWarmOrOneShot(
      { id: "participant-fixture", kind: "codex-cli", label: "Codex" },
      "Run the protected command.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-fixture",
          participantId: "participant-fixture",
          contextKey: "context-fixture",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: async (request: { method: string; responseDelivered: Promise<void> }) => {
          assert.equal(request.method, "item/commandExecution/requestApproval");
          void request.responseDelivered.then(() => { delivered = true; });
          return { decision: "accept" };
        }
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.content, /Approval delivered/);
    assert.equal(delivered, true);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server production transport returns method-specific results for every direct approval method", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-direct-methods-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const permissions = { network: { enabled: true }, fileSystem: null };
const approvals = [
  { id: "direct-command", method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-methods", turnId: "turn-methods", itemId: "item-command", startedAtMs: 1,
    approvalId: "callback-a", environmentId: null, command: "git status", cwd: process.cwd(), availableDecisions: ["acceptForSession"]
  }, expected: { decision: "acceptForSession" } },
  { id: "direct-command-b", method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-methods", turnId: "turn-methods", itemId: "item-command", startedAtMs: 1,
    approvalId: "callback-b", environmentId: null, command: "git status", cwd: process.cwd(), availableDecisions: ["decline"]
  }, expected: { decision: "decline" } },
  { id: "direct-file", method: "item/fileChange/requestApproval", params: {
    threadId: "thread-methods", turnId: "turn-methods", itemId: "item-file", startedAtMs: 2,
    reason: null, grantRoot: null
  }, expected: { decision: "accept" } },
  { id: "direct-permissions", method: "item/permissions/requestApproval", params: {
    threadId: "thread-methods", turnId: "turn-methods", itemId: "item-permissions", environmentId: null,
    startedAtMs: 3, cwd: process.cwd(), reason: "Need network", permissions
  }, expected: { permissions, scope: "turn" } },
  { id: "legacy-command", method: "execCommandApproval", params: {
    conversationId: "thread-methods", callId: "call-command", approvalId: "subcommand-1",
    command: ["printf", "two words"], cwd: process.cwd(), reason: null, parsedCmd: []
  }, expected: { decision: "approved_for_session" } },
  { id: "legacy-file", method: "applyPatchApproval", params: {
    conversationId: "thread-methods", callId: "call-file",
    fileChanges: { "scratch.txt": { type: "add", content: "safe" } }, reason: null, grantRoot: null
  }, expected: { decision: "approved" } }
];
let next = 0;
const sendNext = () => {
  if (approvals[next].id === "direct-file") {
    send({ method: "item/fileChange/patchUpdated", params: {
      threadId: "thread-methods", turnId: "turn-methods", itemId: "item-file",
      changes: [{ path: "scratch.txt", kind: { type: "update" } }]
    } });
  }
  send(approvals[next]);
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.params?.capabilities?.requestAttestation !== false) process.exit(31);
    if (message.method === "account/login/start") process.exit(32);
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-methods" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-methods" } } });
    send({ method: "turn/started", params: { threadId: "thread-methods", turn: { id: "turn-methods" } } });
    sendNext();
  } else if (next < approvals.length && message.id === approvals[next].id) {
    if (JSON.stringify(message.result) !== JSON.stringify(approvals[next].expected)) process.exit(33 + next);
    next += 1;
    if (next < approvals.length) {
      sendNext();
    } else {
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-methods", turnId: "turn-methods", itemId: "agent-methods", delta: "All method-specific results delivered." } });
      send({ method: "item/completed", params: { threadId: "thread-methods", turnId: "turn-methods", item: { id: "agent-methods", type: "agentMessage", text: "All method-specific results delivered." } } });
      send({ method: "turn/completed", params: { threadId: "thread-methods", turn: { id: "turn-methods", status: "completed" } } });
    }
  } else if (message.method === "account/login/start") {
    process.exit(38);
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  const seen: string[] = [];
  try {
    const result = await runner.runCodexAppServerWarmOrOneShot(
      { id: "participant-methods", kind: "codex-cli", label: "Codex" },
      "Exercise direct approvals.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-methods",
          participantId: "participant-methods",
          contextKey: "context-methods",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: async (request: { method: string; params?: Record<string, unknown> }) => {
          seen.push(request.method);
          if (request.method === "item/commandExecution/requestApproval") {
            return seen.filter((method) => method === request.method).length === 1
              ? { decision: "acceptForSession" }
              : { decision: "decline" };
          }
          if (request.method === "item/fileChange/requestApproval") {
            assert.deepEqual(request.params?.fileChanges, [{ path: "scratch.txt", kind: { type: "update" } }]);
            return { decision: "accept" };
          }
          if (request.method === "item/permissions/requestApproval") return { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" };
          if (request.method === "execCommandApproval") return { decision: "approved_for_session" };
          return { decision: "approved" };
        }
      }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(seen, [
      "item/commandExecution/requestApproval",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "execCommandApproval",
      "applyPatchApproval"
    ]);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server production transport sends the exact same-session Guardian override", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-guardian-override-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-guardian" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-guardian" } } });
    send({ method: "turn/started", params: { threadId: "thread-guardian", turn: { id: "turn-guardian" } } });
    send({ method: "item/autoApprovalReview/completed", params: {
      threadId: "thread-guardian", turnId: "turn-guardian", startedAtMs: 10, completedAtMs: 20,
      reviewId: "review-guardian", targetItemId: "item-guardian", decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Protected action" },
      action: { type: "command", source: "unifiedExec", command: "git push origin scratch", cwd: process.cwd() }
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian", turnId: "turn-guardian", item: {
      id: "item-guardian", type: "commandExecution", status: "failed", command: "git push origin scratch"
    } } });
    send({ method: "item/agentMessage/delta", params: {
      threadId: "thread-guardian", turnId: "turn-guardian", itemId: "agent-guardian", delta: "Guardian denial recorded."
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian", turnId: "turn-guardian", item: {
      id: "agent-guardian", type: "agentMessage", text: "Guardian denial recorded."
    } } });
    send({ method: "turn/completed", params: {
      threadId: "thread-guardian", turn: { id: "turn-guardian", status: "completed" }
    } });
  } else if (message.method === "thread/approveGuardianDeniedAction") {
    const event = message.params?.event;
    if (message.params?.threadId !== "thread-guardian" || event?.type !== "guardian_assessment" ||
      event?.id !== "review-guardian" || event?.target_item_id !== "item-guardian" || event?.turn_id !== "turn-guardian" ||
      event?.action?.type !== "command" || event?.action?.source !== "unified_exec") process.exit(51);
    send({ id: message.id, result: {} });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let deliveryAcknowledged = false;
  let guardianSignal: AbortSignal | undefined;
  let resolveDecision!: () => void;
  let resolveDelivery!: (receipt: CodexServerRequestDelivery) => void;
  let rejectDelivery!: (error: unknown) => void;
  const delivery = new Promise<CodexServerRequestDelivery>((resolve, reject) => {
    resolveDelivery = resolve;
    rejectDelivery = reject;
  });
  void delivery.catch(() => undefined);
  try {
    const result = await runner.runCodexAppServerWarmOrOneShot(
      { id: "participant-guardian", kind: "codex-cli", label: "Codex" },
      "Retry the protected command.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-guardian",
          participantId: "participant-guardian",
          contextKey: "context-guardian",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: (request: { method: string; signal: AbortSignal; responseDelivered: Promise<CodexServerRequestDelivery> }) => {
          assert.equal(request.method, "item/autoApprovalReview/denied");
          guardianSignal = request.signal;
          void request.responseDelivered.then((receipt) => {
            deliveryAcknowledged = true;
            resolveDelivery(receipt);
          }, rejectDelivery);
          return new Promise((resolve, reject) => {
            resolveDecision = () => resolve({ decision: "approveRetry" });
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
      }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.content, /Guardian denial recorded/);
    assert.equal(guardianSignal?.aborted, false);
    assert.equal(deliveryAcknowledged, false);
    resolveDecision();
    const receipt = await Promise.race([
      delivery,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Guardian override was not acknowledged")), 1_500))
    ]);
    assert.equal(deliveryAcknowledged, true);
    // The turn had completed before the decision: Codex only records it, so
    // the chat must continue the participant with it.
    assert.deepEqual(receipt, { turnActive: false });
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server reports a Guardian override delivered into the still-running turn", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-guardian-live-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-guardian-live" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-guardian-live" } } });
    send({ method: "turn/started", params: { threadId: "thread-guardian-live", turn: { id: "turn-guardian-live" } } });
    send({ method: "item/autoApprovalReview/completed", params: {
      threadId: "thread-guardian-live", turnId: "turn-guardian-live", startedAtMs: 10, completedAtMs: 20,
      reviewId: "review-guardian-live", targetItemId: "item-guardian-live", decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Protected action" },
      action: { type: "command", source: "unifiedExec", command: "git push origin scratch", cwd: process.cwd() }
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-live", turnId: "turn-guardian-live", item: {
      id: "item-guardian-live", type: "commandExecution", status: "failed", command: "git push origin scratch"
    } } });
    // The turn keeps working: it ends only after the User's decision arrives.
  } else if (message.method === "thread/approveGuardianDeniedAction") {
    if (message.params?.threadId !== "thread-guardian-live" || message.params?.event?.id !== "review-guardian-live") process.exit(52);
    send({ id: message.id, result: {} });
    send({ method: "item/agentMessage/delta", params: {
      threadId: "thread-guardian-live", turnId: "turn-guardian-live", itemId: "agent-guardian-live", delta: "Retried inside the running turn."
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-live", turnId: "turn-guardian-live", item: {
      id: "agent-guardian-live", type: "agentMessage", text: "Retried inside the running turn."
    } } });
    send({ method: "turn/completed", params: {
      threadId: "thread-guardian-live", turn: { id: "turn-guardian-live", status: "completed" }
    } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let resolveDecision!: () => void;
  let resolveRequested!: () => void;
  const requested = new Promise<void>((resolve) => { resolveRequested = resolve; });
  let resolveDelivery!: (receipt: CodexServerRequestDelivery) => void;
  let rejectDelivery!: (error: unknown) => void;
  const delivery = new Promise<CodexServerRequestDelivery>((resolve, reject) => {
    resolveDelivery = resolve;
    rejectDelivery = reject;
  });
  void delivery.catch(() => undefined);
  try {
    const resultPromise: Promise<ParticipantRunResult> = runner.runCodexAppServerWarmOrOneShot(
      { id: "participant-guardian-live", kind: "codex-cli", label: "Codex" },
      "Push the scratch branch.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-guardian-live",
          participantId: "participant-guardian-live",
          contextKey: "context-guardian-live",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: (request: { method: string; signal: AbortSignal; responseDelivered: Promise<CodexServerRequestDelivery> }) => {
          assert.equal(request.method, "item/autoApprovalReview/denied");
          void request.responseDelivered.then(resolveDelivery, rejectDelivery);
          resolveRequested();
          return new Promise((resolve, reject) => {
            resolveDecision = () => resolve({ decision: "approveRetry" });
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
      }
    );
    await Promise.race([
      requested,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Guardian denial was not offered")), 1_500))
    ]);
    resolveDecision();
    const receipt = await Promise.race([
      delivery,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Guardian override was not acknowledged")), 1_500))
    ]);
    // Codex applies the decision inside the running turn: no continuation.
    assert.deepEqual(receipt, { turnActive: true });
    const result = await resultPromise;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.content, /Retried inside the running turn/);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server reports turnActive when the approval ack and turn/completed arrive in one stdout chunk", async () => {
  // Regression: sampling turnActive AFTER `await sendRequest` let a coalesced
  // ack+turn/completed clear pendingTurn first, yielding turnActive:false for a
  // retry Codex already ran in-turn — which restarted it a second time. The fake
  // writes the ack and the turn/completed in a single write to force coalescing.
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-guardian-coalesced-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-guardian-coalesced" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-guardian-coalesced" } } });
    send({ method: "turn/started", params: { threadId: "thread-guardian-coalesced", turn: { id: "turn-guardian-coalesced" } } });
    send({ method: "item/autoApprovalReview/completed", params: {
      threadId: "thread-guardian-coalesced", turnId: "turn-guardian-coalesced", startedAtMs: 10, completedAtMs: 20,
      reviewId: "review-guardian-coalesced", targetItemId: "item-guardian-coalesced", decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Protected action" },
      action: { type: "command", source: "unifiedExec", command: "git push origin scratch", cwd: process.cwd() }
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-coalesced", turnId: "turn-guardian-coalesced", item: {
      id: "item-guardian-coalesced", type: "commandExecution", status: "failed", command: "git push origin scratch"
    } } });
  } else if (message.method === "thread/approveGuardianDeniedAction") {
    if (message.params?.threadId !== "thread-guardian-coalesced" || message.params?.event?.id !== "review-guardian-coalesced") process.exit(53);
    // One write: the approve ack AND the item/agentMessage + turn/completed for
    // the in-turn retry, so the runner parses them in a single data event.
    const lines = [
      { id: message.id, result: {} },
      { method: "item/agentMessage/delta", params: { threadId: "thread-guardian-coalesced", turnId: "turn-guardian-coalesced", itemId: "agent-guardian-coalesced", delta: "Retried inside the running turn." } },
      { method: "item/completed", params: { threadId: "thread-guardian-coalesced", turnId: "turn-guardian-coalesced", item: { id: "agent-guardian-coalesced", type: "agentMessage", text: "Retried inside the running turn." } } },
      { method: "turn/completed", params: { threadId: "thread-guardian-coalesced", turn: { id: "turn-guardian-coalesced", status: "completed" } } }
    ];
    process.stdout.write(lines.map((value) => JSON.stringify(value)).join("\\n") + "\\n");
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let resolveDecision!: () => void;
  let resolveRequested!: () => void;
  const requested = new Promise<void>((resolve) => { resolveRequested = resolve; });
  let resolveDelivery!: (receipt: CodexServerRequestDelivery) => void;
  let rejectDelivery!: (error: unknown) => void;
  const delivery = new Promise<CodexServerRequestDelivery>((resolve, reject) => {
    resolveDelivery = resolve;
    rejectDelivery = reject;
  });
  void delivery.catch(() => undefined);
  try {
    const resultPromise: Promise<ParticipantRunResult> = runner.runCodexAppServerWarmOrOneShot(
      { id: "participant-guardian-coalesced", kind: "codex-cli", label: "Codex" },
      "Push the scratch branch.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-guardian-coalesced",
          participantId: "participant-guardian-coalesced",
          contextKey: "context-guardian-coalesced",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: (request: { method: string; signal: AbortSignal; responseDelivered: Promise<CodexServerRequestDelivery> }) => {
          assert.equal(request.method, "item/autoApprovalReview/denied");
          void request.responseDelivered.then(resolveDelivery, rejectDelivery);
          resolveRequested();
          return new Promise((resolve, reject) => {
            resolveDecision = () => resolve({ decision: "approveRetry" });
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
      }
    );
    await Promise.race([
      requested,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Guardian denial was not offered")), 1_500))
    ]);
    resolveDecision();
    const receipt = await Promise.race([
      delivery,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Guardian override was not acknowledged")), 1_500))
    ]);
    // The retry ran inside the turn; the receipt must say so even though
    // turn/completed was coalesced with the ack. Otherwise chat starts a
    // second continuation and the approved command runs twice.
    assert.deepEqual(receipt, { turnActive: true });
    const result = await resultPromise;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.content, /Retried inside the running turn/);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server expires a completed-turn Guardian denial before the next turn starts", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-guardian-next-turn-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let turn = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-guardian-next" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    turn += 1;
    const turnId = "turn-guardian-" + turn;
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId: "thread-guardian-next", turn: { id: turnId } } });
    if (turn === 1) {
      send({ method: "item/autoApprovalReview/completed", params: {
        threadId: "thread-guardian-next", turnId, startedAtMs: 10, completedAtMs: 20,
        reviewId: "review-guardian-next", targetItemId: "item-guardian-next", decisionSource: "agent",
        review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Protected action" },
        action: { type: "command", source: "unifiedExec", command: "git push origin scratch", cwd: process.cwd() }
      } });
      send({ method: "item/completed", params: { threadId: "thread-guardian-next", turnId, item: {
        id: "item-guardian-next", type: "commandExecution", status: "failed", command: "git push origin scratch"
      } } });
    }
    const text = turn === 1 ? "First turn completed." : "Second turn completed.";
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-guardian-next", turnId, itemId: "agent-" + turn, delta: text } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-next", turnId, item: { id: "agent-" + turn, type: "agentMessage", text } } });
    send({ method: "turn/completed", params: { threadId: "thread-guardian-next", turn: { id: turnId, status: "completed" } } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  const participant = { id: "participant-guardian-next", kind: "codex-cli", label: "Codex" } as const;
  const warm = {
    conversationId: "conversation-guardian-next",
    participantId: "participant-guardian-next",
    contextKey: "context-guardian-next",
    idleTimeoutMs: 60_000
  };
  let approvalAborted = false;
  let guardianSignal: AbortSignal | undefined;
  try {
    const first = await runner.runCodexAppServerWarmOrOneShot(
      participant,
      "Attempt the protected command.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm,
        onCodexServerRequest: (request: { signal: AbortSignal; responseDelivered: Promise<void> }) => {
          guardianSignal = request.signal;
          void request.responseDelivered.catch(() => undefined);
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              approvalAborted = true;
              reject(request.signal.reason);
            }, { once: true });
          });
        }
      }
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.match(first.content, /First turn completed/);
    assert.equal(guardianSignal?.aborted, false);

    const second = await runner.runCodexAppServerWarmOrOneShot(
      participant,
      "Start a fresh turn.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      { agentMode: "auto", warm }
    );
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.match(second.content, /Second turn completed/);
    assert.equal(approvalAborted, true);
    assert.equal(guardianSignal?.aborted, true);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server expires a completed-turn Guardian denial before compaction", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-guardian-compact-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-guardian-compact" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-guardian-compact" } } });
    send({ method: "turn/started", params: { threadId: "thread-guardian-compact", turn: { id: "turn-guardian-compact" } } });
    send({ method: "item/autoApprovalReview/completed", params: {
      threadId: "thread-guardian-compact", turnId: "turn-guardian-compact", startedAtMs: 10, completedAtMs: 20,
      reviewId: "review-guardian-compact", targetItemId: "item-guardian-compact", decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Protected action" },
      action: { type: "command", source: "unifiedExec", command: "git push origin scratch", cwd: process.cwd() }
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-compact", turnId: "turn-guardian-compact", item: {
      id: "item-guardian-compact", type: "commandExecution", status: "failed", command: "git push origin scratch"
    } } });
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-guardian-compact", turnId: "turn-guardian-compact", itemId: "agent-guardian-compact", delta: "Guardian denial recorded." } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-compact", turnId: "turn-guardian-compact", item: { id: "agent-guardian-compact", type: "agentMessage", text: "Guardian denial recorded." } } });
    send({ method: "turn/completed", params: { threadId: "thread-guardian-compact", turn: { id: "turn-guardian-compact", status: "completed" } } });
  } else if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId: "thread-guardian-compact", turn: { id: "compact-turn" } } });
    send({ method: "turn/completed", params: { threadId: "thread-guardian-compact", turn: { id: "compact-turn", status: "completed" } } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  const participant = { id: "participant-guardian-compact", kind: "codex-cli", label: "Codex" } as const;
  const warm = {
    conversationId: "conversation-guardian-compact",
    participantId: "participant-guardian-compact",
    contextKey: "context-guardian-compact",
    idleTimeoutMs: 60_000
  };
  let approvalAborted = false;
  try {
    const first = await runner.runCodexAppServerWarmOrOneShot(
      participant,
      "Attempt the protected command.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm,
        onCodexServerRequest: (request: { signal: AbortSignal; responseDelivered: Promise<void> }) => {
          void request.responseDelivered.catch(() => undefined);
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              approvalAborted = true;
              reject(request.signal.reason);
            }, { once: true });
          });
        }
      }
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(approvalAborted, false);

    const compact = await runner.compactSession(
      participant,
      fixtureDir,
      undefined,
      "chat",
      undefined,
      { agentMode: "auto", sessionId: first.sessionId, warm }
    );
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(approvalAborted, true);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Codex Stop still terminates the turn when the approval refusal pipe is dead", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-dead-pipe-"));
  const helperPidFile = path.join(fixtureDir, "dead-pipe-helper.pid");
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
if (process.platform === "win32") {
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-dead-pipe" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-dead-pipe" } } });
    send({ method: "turn/started", params: { threadId: "thread-dead-pipe", turn: { id: "turn-dead-pipe" } } });
    send({ id: "approval-dead-pipe", method: "item/fileChange/requestApproval", params: {
      threadId: "thread-dead-pipe", turnId: "turn-dead-pipe", itemId: "item-dead-pipe", startedAtMs: 1, reason: null, grantRoot: null
    } });
    require("node:fs").closeSync(0);
    setInterval(() => {}, 1000);
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, { codexExecutable: codexPath, nativeProcessDbPath: path.join(fixtureDir, "native-processes.sqlite3") }) as any;
  const controller = new AbortController();
  let requestSeen!: () => void;
  let approvalAborted = false;
  let helperPid: number | undefined;
  const seen = new Promise<void>((resolve) => { requestSeen = resolve; });
  try {
    const run = runner.runCodexAppServerWarmOrOneShot(
      { id: "participant-dead-pipe", kind: "codex-cli", label: "Codex" },
      "Apply the protected change.",
      fixtureDir,
      undefined,
      "chat",
      controller.signal,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-dead-pipe",
          participantId: "participant-dead-pipe",
          contextKey: "context-dead-pipe",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: (request: { signal: AbortSignal }) => {
          requestSeen();
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              approvalAborted = true;
              reject(request.signal.reason);
            }, { once: true });
          });
        }
      }
    );
    await seen;
    controller.abort(new Error("Stopped by user."));
    const result = await Promise.race([
      run,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Stop hung after dead approval pipe")), 1_500))
    ]);
    assert.equal(result.ok, false);
    assert.equal(approvalAborted, true);
    assert.match(result.error ?? "", /cancelled|Stopped by user|EPIPE/i);
    if (process.platform === "win32") {
      helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
      await assertFixtureProcessStops(helperPid);
    }
  } finally {
    await runner.shutdownWarmAgents();
    if (helperPid && testProcessExists(helperPid)) {
      process.kill(helperPid, "SIGKILL");
    }
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Codex Stop waits for a detached command even after the provider exits", { timeout: 10_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX detached process identity test");
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-stop-detached-"));
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-detached" } } });
  if (message.method === "turn/interrupt") process.exit(0);
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-detached" } } });
    const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready')"], {
      detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    helper.on("message", () => {
      writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
      send({ id: "ready", method: "item/commandExecution/requestApproval", params: {
        threadId: "thread-detached", turnId: "turn-detached", itemId: "detached-command", startedAtMs: 1,
        environmentId: null, command: "fixture", cwd: process.cwd(), availableDecisions: ["accept", "decline"]
      } });
    });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, { codexExecutable: codexPath, nativeProcessDbPath: path.join(fixtureDir, "native-processes.sqlite3") }) as any;
  const controller = new AbortController();
  let ready!: () => void;
  const seen = new Promise<void>((resolve) => { ready = resolve; });
  let helperPid: number | undefined;
  try {
    const run = runner.runCodexAppServerWarmOrOneShot(
      { id: "codex-detached", kind: "codex-cli", label: "Codex" }, "Wait.", fixtureDir,
      undefined, "chat", controller.signal, {
        agentMode: "auto",
        warm: { conversationId: "detached", participantId: "codex-detached", contextKey: "detached" },
        onCodexServerRequest: (request: { signal: AbortSignal }) => {
          ready();
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
      }
    );
    await seen;
    helperPid = Number((await readFile(helperPidFile, "utf8")).trim());
    assert.equal(testProcessExists(helperPid), true);
    controller.abort(new Error("Stopped by user."));
    const result = await run;
    assert.equal(result.ok, false);
    assert.equal(testProcessExists(helperPid), false, "Stop must not finish while a captured command survives");
  } finally {
    await runner.shutdownWarmAgents();
    if (helperPid && testProcessExists(helperPid)) process.kill(helperPid, "SIGKILL");
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Windows warm-agent shutdown terminates provider descendants", async (t) => {
  if (process.platform !== "win32") {
    t.skip("taskkill process-tree behavior is only available on Windows");
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-warm-tree-"));
  const helperPidFile = path.join(fixtureDir, "warm-helper.pid");
  const gracefulShutdownMarker = path.join(fixtureDir, "graceful-shutdown.marker");
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => writeFileSync(${JSON.stringify(gracefulShutdownMarker)}, "stdin closed"));
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "windows", platformOsName: "windows", platformArch: "x64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-warm-tree" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-warm-tree" } } });
    send({ method: "turn/started", params: { threadId: "thread-warm-tree", turn: { id: "turn-warm-tree" } } });
    send({ method: "item/completed", params: { threadId: "thread-warm-tree", turnId: "turn-warm-tree", item: {
      id: "message-warm-tree", type: "agentMessage", text: "done"
    } } });
    send({ method: "turn/completed", params: { threadId: "thread-warm-tree", turn: { id: "turn-warm-tree", status: "completed" } } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let helperPid: number | undefined;
  t.after(async () => {
    await runner.shutdownWarmAgents();
    if (helperPid && testProcessExists(helperPid)) {
      process.kill(helperPid, "SIGKILL");
    }
    await rm(fixtureDir, { recursive: true, force: true });
  });

  const result = await runner.runCodexAppServerWarmOrOneShot(
    { id: "participant-warm-tree", kind: "codex-cli", label: "Codex" },
    "Reply with done.",
    fixtureDir,
    undefined,
    "chat",
    undefined,
    {
      agentMode: "default",
      warm: {
        conversationId: "conversation-warm-tree",
        participantId: "participant-warm-tree",
        contextKey: "context-warm-tree",
        idleTimeoutMs: 60_000
      }
    }
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
  assert.equal(testProcessExists(helperPid), true);

  await runner.shutdownWarmAgents();
  assert.equal(await readFile(gracefulShutdownMarker, "utf8"), "stdin closed");
  await assertFixtureProcessStops(helperPid);
});

test("closing AccordAgents terminates every warm agent process while responses are active", async (t) => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-close-active-agents-"));
  const pidFile = path.join(fixtureDir, "active-agent-pids.txt");
  const startedFile = path.join(fixtureDir, "active-agent-started.txt");
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: process.platform, platformOsName: process.platform, platformArch: process.arch } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-" + process.pid }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-" + process.pid } } });
    send({ method: "turn/started", params: { threadId: "thread-" + process.pid, turn: { id: "turn-" + process.pid } } });
    appendFileSync(${JSON.stringify(startedFile)}, String(process.pid) + "\\n");
  }
});
`);
  const diagnostics: unknown[] = [];
  const runner = new CliAgentRunner({ write: async (event, payload) => { diagnostics.push({ event, payload }); } }, undefined, { codexExecutable: codexPath, nativeProcessDbPath: path.join(fixtureDir, "native-processes.sqlite3") }) as any;
  const participants = ["one", "two"].map((id) => ({ id: `participant-${id}`, kind: "codex-cli" as const, label: `Codex ${id}` }));
  t.after(async () => {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  // Shell readiness can take up to its own eight-second timeout; it is a
  // fixture prerequisite, not part of this four-second provider-start check.
  await ensureLoginShellEnvPrimed();
  const runs = participants.map((participant) => runner.runCodexAppServerWarmOrOneShot(
    participant,
    "Keep responding until the app closes.",
    fixtureDir,
    undefined,
    "chat",
    undefined,
    {
      agentMode: "default",
      warm: {
        conversationId: `conversation-${participant.id}`,
        participantId: participant.id,
        contextKey: `context-${participant.id}`,
        idleTimeoutMs: 60_000
      }
    }
  ));

  const earlyResults: unknown[] = [];
  for (const run of runs) void run.then((result: unknown) => earlyResults.push(result), (error: unknown) => earlyResults.push(String(error)));
  let startedPids: number[] = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    startedPids = await readFile(startedFile, "utf8")
      .then((value) => value.trim().split(/\r?\n/).filter(Boolean).map(Number))
      .catch(() => []);
    if (startedPids.length === participants.length) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (startedPids.length !== participants.length) {
    const native = new NativeProcessRegistry(path.join(fixtureDir, "native-processes.sqlite3"));
    const diagnostic = { earlyResults, diagnostics, providers: await readFile(pidFile, "utf8").catch(() => "none"),
      preparing: [...runner.warmPreparations].map((value: { key: string }) => value.key), creating: [...runner.warmAgentCreations.keys()], warm: [...runner.warmAgents.keys()],
      receipts: await native.openLeases().catch(error => String(error)) };
    console.error("native-close-startup-diagnostic", JSON.stringify(diagnostic));
  }
  assert.equal(startedPids.length, participants.length, `both agent responses should be active before app shutdown; early outcomes: ${JSON.stringify(earlyResults)}`);
  assert.equal(runner.hasActiveNativeWork(), true);
  assert.equal(runner.fenceIdleNativeAdmissions(), undefined, "idle stop cannot fence active provider responses");

  await runner.shutdownWarmAgents();
  const results = await Promise.all(runs);
  assert.equal(results.every((result: { ok: boolean }) => result.ok === false), true);
  for (const pid of startedPids) {
    await assertFixtureProcessStops(pid);
  }
  assert.equal(runner.hasActiveNativeWork(), false);
  const releaseIdle = runner.fenceIdleNativeAdmissions();
  assert.equal(typeof releaseIdle, "function");
  const refused = await runner.runCodexAppServerWarmOrOneShot(participants[0], "Must stay queued.", fixtureDir, undefined,
    "chat", undefined, { agentMode: "default", warm: { conversationId: "idle-fenced", participantId: participants[0].id, contextKey: "idle-fenced", idleTimeoutMs: 60_000 } });
  assert.equal(refused.ok, false);
  assert.equal((await readFile(pidFile, "utf8")).trim().split(/\r?\n/).length, participants.length, "a fenced command never spawns a replacement provider");
  releaseIdle();
});

function testProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForCondition(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) assert.fail("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function assertFixtureProcessStops(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40 && testProcessExists(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(testProcessExists(pid), false, `provider descendant ${pid} survived warm-agent shutdown`);
}

test("Claude public warm-run path: background work outlives the reply, the next message and a Stop, and its result arrives as a new reply", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-background-warm-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const processPidsFile = path.join(fixtureDir, "process-pids.txt");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const stdinLog = path.join(fixtureDir, "stdin.jsonl");
  // Mirrors Claude Code 2.1.280 on stream-json: uuid-stamped messages get a
  // command lifecycle, an interrupt ends only the running step with
  // error_during_execution, and a finished background task makes the CLI
  // start a step on its own.
  await writeFile(claudePath, `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
appendFileSync(${JSON.stringify(processPidsFile)}, String(process.pid) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let helper;
let messages = 0;
let running;
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => {
  if (helper) helper.kill("SIGTERM");
  process.exit(0);
});
input.on("line", (line) => {
  appendFileSync(${JSON.stringify(stdinLog)}, line + "\\n");
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { still_queued: [] } } });
    if (message.request.subtype === "interrupt" && running) {
      send({ type: "result", subtype: "error_during_execution", is_error: true });
      send({ type: "command_lifecycle", command_uuid: running, state: "cancelled" });
      running = undefined;
    }
    return;
  }
  messages += 1;
  const uuid = message.uuid;
  send({ type: "command_lifecycle", command_uuid: uuid, state: "queued" });
  send({ type: "command_lifecycle", command_uuid: uuid, state: "started" });
  send({ type: "system", subtype: "init", session_id: "fixture-session" });
  if (messages === 1) {
    helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
    send({ type: "system", subtype: "task_started", task_id: "task-1", description: "fixture background task", is_backgrounded: true });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Started." }] } });
    send({ type: "result", subtype: "success", result: "Started." });
    send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
    return;
  }
  if (messages === 2) {
    running = uuid;
    send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working on it" } } });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] } });
    return;
  }
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Third." }] } });
  send({ type: "result", subtype: "success", result: "Third." });
  send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
  setTimeout(() => {
    helper.kill("SIGTERM");
    helper = undefined;
    send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    send({ type: "system", subtype: "task_notification", task_id: "task-1", status: "completed" });
    send({ type: "system", subtype: "init", session_id: "fixture-session" });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Background done." }] } });
    send({ type: "result", subtype: "success", result: "Background done." });
  }, 100);
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-background", kind: "claude-code", label: "Claude" };
  const selfResumed: any[] = [];
  let markSelfResumed!: () => void;
  const selfResumedSeen = new Promise<void>((resolve) => { markSelfResumed = resolve; });
  let repliesStarted = 0;
  const backgroundReports: string[][] = [];
  const warm = {
    conversationId: "conversation-background",
    participantId: participant.id,
    contextKey: "context-background",
    idleTimeoutMs: 60_000,
    onReplyStarted: () => { repliesStarted += 1; },
    onBackgroundTasksChanged: (tasks: any[]) => { backgroundReports.push(tasks.map((task) => `${task.label}@${task.origin?.messageId}`)); },
    origin: { runId: "run-1", messageId: "reply-1" },
    onSelfResumedTurn: (turn: any) => {
      selfResumed.push(turn);
      markSelfResumed();
    }
  };
  let helperPid: number | undefined;
  try {
    const firstOutputs: Array<{ text: string }> = [];
    const first = await runner.run(participant, "Start work.", fixtureDir, undefined, "chat", undefined, {
      agentMode: "default",
      warm,
      onOutput: (event: { text: string }) => firstOutputs.push(event)
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.content, "Started.", "the reply ends at its result");
    assert.equal(repliesStarted, 1, "a fresh process is announced once, before it starts");
    assert.ok(firstOutputs.some((event) => /Running in the background: fixture background task/.test(event.text)));
    helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
    assert.equal(testProcessExists(helperPid), true);
    assert.equal(runner.hasActiveNativeWork(), true, "native background work keeps the machine busy");
    assert.equal(runner.fenceIdleNativeAdmissions(), undefined);

    const controller = new AbortController();
    let markWorking!: () => void;
    const working = new Promise<void>((resolve) => { markWorking = resolve; });
    const secondRun = runner.run(participant, "Do a long step.", fixtureDir, undefined, "chat", controller.signal, {
      agentMode: "default",
      warm: { ...warm, origin: { runId: "run-2", messageId: "reply-2" } },
      onOutput: (event: { kind: string; text: string }) => {
        if (event.kind === "tool" || /Working on it/.test(event.text)) markWorking();
      }
    });
    // Stop only once the step is visibly running, as a user would.
    await working;
    controller.abort(new Error("Stopped by user."));
    const second = await secondRun;
    assert.equal(second.ok, false, "a stopped reply does not succeed");
    const control = (await readFile(stdinLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line))
      .find((message) => message.type === "control_request");
    assert.equal(control?.request?.subtype, "interrupt", "Stop interrupts the step instead of closing the process");
    assert.equal(testProcessExists(helperPid), true, "Stop keeps the background work");

    const third = await runner.run(participant, "Anything else?", fixtureDir, undefined, "chat", undefined, {
      agentMode: "default",
      warm: { ...warm, origin: { runId: "run-3", messageId: "reply-3" } }
    });
    assert.equal(third.content, "Third.");
    assert.equal(repliesStarted, 3, "on a live process each message is announced when the CLI takes it");
    const processPids = (await readFile(processPidsFile, "utf8")).trim().split(/\r?\n/).map(Number);
    assert.equal(processPids.length, 1, "every message went to the same live process");

    await selfResumedSeen;
    assert.deepEqual(selfResumed[0].origin, { runId: "run-1", messageId: "reply-1" }, "the finished work names the reply that started it");
    const outputs: Array<{ text: string }> = [];
    const continuation = await selfResumed[0].attach({ onOutput: (event: { text: string }) => outputs.push(event) });
    assert.equal(continuation.ok, true);
    assert.equal(continuation.content, "Background done.");
    assert.ok(outputs.some((event) => /Background task finished: fixture background task/.test(event.text)));
    assert.deepEqual(backgroundReports, [["fixture background task@reply-1"], []],
      "the member's background work is reported once when it starts, with the reply that started it, and once when it ends");
    await assertFixtureProcessStops(helperPid);
  } finally {
    await runner.shutdownWarmAgents();
    if (helperPid && testProcessExists(helperPid)) {
      process.kill(helperPid, "SIGKILL");
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

/** A Claude Code 2.1.280 stand-in for compaction: keeps its conversation in
 *  memory (what its next reply's context counts), compacts it on `/compact`
 *  with the boundary the real CLI emits, and answers `get_context_usage` as
 *  the real CLI does (verified against 2.1.280 on 2026-10-22). */
async function writeClaudeCompactionFixture(fixtureDir: string, options: { contextUsageAnswer?: "success" | "error" } = {}): Promise<{ claudePath: string; log: string; finishBackground: () => Promise<void> }> {
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

async function readFixtureLog(log: string): Promise<Array<{ pid: number; started?: string[]; message?: string; control?: string; background?: string; replied?: string; compacted?: string; compacting?: string }>> {
  return (await readFile(log, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("Claude /compact runs in the member's live process, so its next reply continues from the compacted context", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-live-"));
  const { claudePath, log } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact", participantId: participant.id, contextKey: "context-compact", idleTimeoutMs: 60_000 };
  try {
    const first = await runner.run(participant, "Write a lot.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    const second = await runner.run(participant, "Write more.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(first.ok && second.ok, true);
    assert.equal(second.contextUsage?.usedTokens, 109000, "two long replies on the resumed session: 109k in context");

    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", warm, sessionId: "fixture-session", compactInstructions: "keep the plan" });
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(compact.contextUsage?.usedTokens, 29000, "the CLI's own count of the compacted context, system prompt included");
    assert.equal(compact.contextUsage?.contextWindowTokens, 1000000);

    const next = await runner.run(participant, "Continue.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(next.contextUsage?.usedTokens, 69000, "the next reply continues from the compacted 29k, not from 109k");

    const entries = await readFixtureLog(log);
    const pids = new Set(entries.map((entry) => entry.pid));
    assert.equal(pids.size, 1, "the compaction and every reply ran in the one live process");
    assert.deepEqual(entries.filter((entry) => entry.message).map((entry) => entry.message),
      ["Write a lot.", "Write more.", "/compact keep the plan", "Continue."]);
    assert.ok(entries.some((entry) => entry.control === "get_context_usage"));
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact runs while the member's background work keeps running, as in the dedicated CLI, and the work survives it", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-busy-"));
  const { claudePath, log, finishBackground } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-busy", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const backgroundReports: string[][] = [];
  let selfResumed: Promise<any> | undefined;
  const warm = { conversationId: "conversation-compact-busy", participantId: participant.id, contextKey: "context-busy", idleTimeoutMs: 60_000,
    onSelfResumedTurn: (turn: any) => { selfResumed = turn.attach({}); },
    onBackgroundTasksChanged: (tasks: any[]) => { backgroundReports.push(tasks.map((task) => task.label)); } };
  try {
    const started = await runner.run(participant, "Start background.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(started.ok, true);
    const live = Array.from(runner.warmAgents.values())[0] as any;
    assert.equal(live.hasLiveBackgroundWork(), true);
    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(live.hasLiveBackgroundWork(), true, "the background task is still running after the compaction");
    assert.deepEqual(backgroundReports, [["fixture background task"]], "its status was never cleared");
    let entries = await readFixtureLog(log);
    assert.equal(entries.some((entry) => entry.background === "finished"), false, "compacted while the work ran, without waiting for it");

    await finishBackground();
    await waitForCondition(() => Boolean(selfResumed));
    const finished = await selfResumed!;
    assert.equal(finished.content, "Background done.", "the work finished in the same process and its answer still arrives");
    assert.deepEqual(backgroundReports, [["fixture background task"], []]);
    entries = await readFixtureLog(log);
    assert.ok(entries.findIndex((entry) => entry.message === "/compact") < entries.findIndex((entry) => entry.background === "finished"));
    assert.equal(new Set(entries.map((entry) => entry.pid)).size, 1, "in the same process, which was not ended");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact: background work that finishes during the compaction is answered after it, as a reply of its own", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-meanwhile-"));
  const { claudePath, log, finishBackground } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-meanwhile", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const backgroundReports: string[][] = [];
  let selfResumed: Promise<any> | undefined;
  const warm = { conversationId: "conversation-compact-meanwhile", participantId: participant.id, contextKey: "context-meanwhile", idleTimeoutMs: 60_000,
    onSelfResumedTurn: (turn: any) => { selfResumed = turn.attach({}); },
    onBackgroundTasksChanged: (tasks: any[]) => { backgroundReports.push(tasks.map((task) => task.label)); } };
  try {
    await runner.run(participant, "Start background.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    const compacting = runner.compactSession(participant, fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", warm, sessionId: "fixture-session", compactInstructions: "meanwhile" });
    await waitForCondition(async () => (await readFixtureLog(log)).some((entry) => entry.compacting));
    await finishBackground();
    const compact = await compacting;
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(compact.content, "", "the compaction's reply is not the task's answer");
    assert.equal(compact.contextUsage?.usedTokens, 29000, "the compaction's own figure, not the task answer's 100k");
    await waitForCondition(() => Boolean(selfResumed));
    assert.equal((await selfResumed!).content, "Background done.", "the task's answer is a reply of its own");
    assert.deepEqual(backgroundReports, [["fixture background task"], []]);
    const entries = await readFixtureLog(log);
    const finishedAt = entries.findIndex((entry) => entry.background === "finished");
    assert.ok(finishedAt > entries.findIndex((entry) => entry.message === "/compact meanwhile")
      && finishedAt < entries.findIndex((entry) => entry.compacted), "the task ended while the compaction ran");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact: the answer to background work that ends during it gets the task's row and the thread that started the task", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-meanwhile-step-"));
  const { claudePath, log, finishBackground } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-meanwhile-step", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  let resumed: { origin: unknown; outputs: string[]; done: Promise<any> } | undefined;
  const warm = { conversationId: "conversation-compact-meanwhile-step", participantId: participant.id, contextKey: "context-meanwhile-step", idleTimeoutMs: 60_000,
    onSelfResumedTurn: (turn: any) => {
      const outputs: string[] = [];
      resumed = { origin: turn.origin, outputs, done: turn.attach({ onOutput: (event: { text: string }) => outputs.push(event.text) }) };
    } };
  try {
    await runner.run(participant, "Start background.", fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", sessionId: "fixture-session", warm: { ...warm, origin: { runId: "run-started-task", messageId: "reply-started-task" } } });
    await runner.run(participant, "Write a lot.", fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", sessionId: "fixture-session", warm: { ...warm, origin: { runId: "run-later", messageId: "reply-later" } } });
    const compacting = runner.compactSession(participant, fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", warm, sessionId: "fixture-session", compactInstructions: "meanwhile-step" });
    await waitForCondition(async () => (await readFixtureLog(log)).some((entry) => entry.compacting));
    await finishBackground();
    assert.equal((await compacting).ok, true);
    await waitForCondition(() => Boolean(resumed));
    assert.equal((await resumed!.done).content, "Background done.");
    assert.deepEqual(resumed!.origin, { runId: "run-started-task", messageId: "reply-started-task" }, "in the thread of the turn that started the task");
    assert.ok(resumed!.outputs.some((text) => /Background task finished: fixture background task/.test(text)), "with the task's row");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact runs in a process started with other settings while it carries background work, instead of waiting for that work", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-other-settings-"));
  const { claudePath, log, finishBackground } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-other-settings", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-other-settings", participantId: participant.id, contextKey: "context-once", idleTimeoutMs: 60_000,
    onSelfResumedTurn: (turn: any) => { void turn.attach({}); } };
  try {
    // A turn with a one-time approval: its process has other settings.
    await runner.run(participant, "Start background.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", warm: { ...warm, contextKey: "context-usual" }, sessionId: "fixture-session" });
    assert.equal(compact.ok, true, JSON.stringify(compact));
    const entries = await readFixtureLog(log);
    assert.equal(entries.filter((entry) => entry.started).length, 1, "no process was started or replaced");
    assert.equal(entries.some((entry) => entry.background === "finished"), false, "compacted without waiting for the background work");
    assert.equal((Array.from(runner.warmAgents.values())[0] as any).hasLiveBackgroundWork(), true, "which keeps running");
    await finishBackground();
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact waits for a reply in progress before it is sent", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-reply-"));
  const { claudePath, log } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-reply", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-reply", participantId: participant.id, contextKey: "context-reply", idleTimeoutMs: 60_000 };
  try {
    const replying = runner.run(participant, "Reply slowly.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    await waitForCondition(async () => (await readFixtureLog(log).catch(() => [])).some((entry) => entry.message === "Reply slowly."));
    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal((await replying).content, "Slow reply.");
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(compact.contextUsage?.usedTokens, 29000);
    const entries = await readFixtureLog(log);
    const repliedAt = entries.findIndex((entry) => entry.replied === "Reply slowly.");
    const compactAt = entries.findIndex((entry) => entry.message === "/compact");
    assert.ok(repliedAt >= 0 && compactAt > repliedAt, "the compaction was sent only once the reply had ended");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact queued behind a reply is sent when that reply ends, while background work keeps running", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-queued-"));
  const { claudePath, log, finishBackground } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-queued", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-queued", participantId: participant.id, contextKey: "context-queued", idleTimeoutMs: 60_000,
    onSelfResumedTurn: (turn: any) => { void turn.attach({}); } };
  try {
    await runner.run(participant, "Start background.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    const live = Array.from(runner.warmAgents.values())[0] as any;
    const replying = runner.run(participant, "Reply slowly.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    await waitForCondition(async () => (await readFixtureLog(log)).some((entry) => entry.message === "Reply slowly."));
    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal((await replying).content, "Slow reply.");
    assert.equal(compact.ok, true, JSON.stringify(compact));
    const entries = await readFixtureLog(log);
    assert.ok(entries.findIndex((entry) => entry.message === "/compact") > entries.findIndex((entry) => entry.replied === "Reply slowly."),
      "sent once the reply ended");
    assert.equal(entries.some((entry) => entry.background === "finished"), false, "without waiting for the background work");
    assert.equal(live.hasLiveBackgroundWork(), true);
    await finishBackground();
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact: Stop while it waits for a reply in progress cancels it before it is sent, and the process keeps serving", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-stop-waiting-"));
  const { claudePath, log } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-stop-waiting", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-stop-waiting", participantId: participant.id, contextKey: "context-stop-waiting", idleTimeoutMs: 60_000 };
  try {
    const replying = runner.run(participant, "Reply slowly.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    await waitForCondition(async () => (await readFixtureLog(log).catch(() => [])).some((entry) => entry.message === "Reply slowly."));
    const stop = new AbortController();
    const compacting = runner.compactSession(participant, fixtureDir, undefined, "chat", stop.signal, { agentMode: "default", warm, sessionId: "fixture-session" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort(new Error("Stopped by user."));
    const stopped = await compacting;
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error, "Compaction was cancelled.");
    assert.equal((await replying).content, "Slow reply.", "the reply in progress is not touched");
    const live = Array.from(runner.warmAgents.values())[0] as any;
    assert.ok(live.idleTimer, "the member's idle timer is re-armed");
    const next = await runner.run(participant, "Still there?", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(next.ok, true);
    const entries = await readFixtureLog(log);
    assert.equal(entries.some((entry) => entry.message?.startsWith("/compact")), false, "never sent");
    assert.equal(new Set(entries.map((entry) => entry.pid)).size, 1);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact: Stop interrupts it in the live process, which keeps serving the member", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-stop-"));
  const { claudePath, log } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-stop", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-stop", participantId: participant.id, contextKey: "context-stop", idleTimeoutMs: 60_000 };
  try {
    await runner.run(participant, "Hello.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm });
    const fresh = await runner.run(participant, "Hello again.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm });
    assert.equal(fresh.ok, true);
    const stop = new AbortController();
    const stopping = runner.compactSession(participant, fixtureDir, undefined, "chat", stop.signal,
      { agentMode: "default", warm, sessionId: "fixture-session", compactInstructions: "slowly" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop.abort(new Error("Stopped by user."));
    const stopped = await stopping;
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error, "Compaction was cancelled.");
    const after = await runner.run(participant, "Still there?", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(after.ok, true, "the member's process survived the Stop and serves the next reply");
    const entries = await readFixtureLog(log);
    assert.equal(new Set(entries.map((entry) => entry.pid)).size, 1);
    assert.ok(entries.some((entry) => entry.control === "interrupt"), "Stop interrupted the step instead of ending the process");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact the CLI declines is reported with the CLI's own words, not as compacted", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-refused-"));
  const { claudePath } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-refused", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-refused", participantId: participant.id, contextKey: "context-refused", idleTimeoutMs: 60_000 };
  try {
    // A live process of a brand-new session (nothing said yet in it).
    runner.warmAgents.clear();
    const entry = await runner.createClaudeWarmAgent(runner.warmAgentKey(participant, fixtureDir, "chat", { agentMode: "default", warm }),
      `${warm.conversationId}:${warm.participantId}`, participant, fixtureDir, "chat", { agentMode: "default", warm, persistSession: true }, claudePath);
    runner.warmAgents.set(entry.key, entry);
    const refused = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "No messages to compact");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact with no live process starts the member's live process as its turn would, and the next turn continues in it", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-own-"));
  const { claudePath, log } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-own", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-own", participantId: participant.id, contextKey: "context-a", idleTimeoutMs: 60_000 };
  const appMcp = { url: "http://127.0.0.1:9/mcp", token: "member-token", toolNames: ["app_chat_send_message"] };
  try {
    // A live process started with other settings: its next turn replaces it.
    await runner.run(participant, "Write a lot.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, appMcp, sessionId: "fixture-session" });
    const member = { agentMode: "default", warm: { ...warm, contextKey: "context-b" }, appMcp, sessionId: "fixture-session", persistSession: true };
    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined, member);
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(compact.contextUsage?.usedTokens, 29000, "the figure of the process that holds the compacted session");

    let entries = await readFixtureLog(log);
    const starts = entries.filter((entry) => entry.started);
    assert.equal(starts.length, 2, "the stale process was replaced by the member's process");
    const started = starts[1].started!;
    assert.ok(started.includes("--resume") && started.includes("fixture-session"), "resumed on the member's session");
    assert.ok(started.includes("--mcp-config"), "with the member's app tools, as its turns start it");
    assert.equal(entries.find((entry) => entry.message?.startsWith("/compact"))?.pid, starts[1].pid);
    assert.equal(runner.warmAgents.size, 1, "kept as the member's live process");
    await assertFixtureProcessStops(starts[0].pid);

    const next = await runner.run(participant, "Continue.", fixtureDir, undefined, "chat", undefined, member);
    assert.equal(next.ok, true);
    assert.equal(next.contextUsage?.usedTokens, 69000, "the next turn continues from the 29k shown after compacting");
    entries = await readFixtureLog(log);
    assert.equal(entries.filter((entry) => entry.started).length, 2, "no further process was started");
    assert.equal(entries.find((entry) => entry.message === "Continue.")?.pid, starts[1].pid, "the next turn ran in the process the compaction started");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude public warm-run path: the idle timer never closes a process with live background work, and closes it once that work and its reply are done", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-idle-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const providerPidFile = path.join(fixtureDir, "provider.pid");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  await writeFile(claudePath, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let helper;
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => { if (helper) helper.kill("SIGTERM"); process.exit(0); });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "user") return;
  send({ type: "command_lifecycle", command_uuid: message.uuid, state: "started" });
  send({ type: "system", subtype: "init", session_id: "idle-session" });
  helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
  send({ type: "system", subtype: "task_started", task_id: "task-1", description: "long task", is_backgrounded: true });
  send({ type: "result", subtype: "success", result: "Started." });
  setTimeout(() => {
    helper.kill("SIGTERM");
    helper = undefined;
    send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    send({ type: "system", subtype: "task_notification", task_id: "task-1", status: "completed" });
    send({ type: "system", subtype: "init", session_id: "idle-session" });
    send({ type: "result", subtype: "success", result: "Done." });
  }, 900);
});
`, "utf8");
  await chmod(claudePath, 0o755);
  const runner = makeRunner() as any;
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-idle", kind: "claude-code", label: "Claude" };
  let attachResult: Promise<any> | undefined;
  const warm = {
    conversationId: "conversation-idle",
    participantId: participant.id,
    contextKey: "context-idle",
    idleTimeoutMs: 150,
    onSelfResumedTurn: (turn: any) => { attachResult = turn.attach({}); }
  };
  let providerPid: number | undefined;
  try {
    const first = await runner.run(participant, "Start.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm });
    assert.equal(first.content, "Started.");
    providerPid = Number.parseInt((await readFile(providerPidFile, "utf8")).trim(), 10);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(testProcessExists(providerPid), true, "the idle timer fired while background work was live and left the process alone");
    assert.equal(runner.warmAgents.size, 1);
    for (let attempt = 0; attempt < 100 && !attachResult; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(attachResult, "the CLI's own reply was offered");
    assert.equal((await attachResult).content, "Done.");
    await assertFixtureProcessStops(providerPid);
    assert.equal(runner.warmAgents.size, 0, "once idle, the process is retired by the re-armed timer");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude public warm-run path: without the CLI's command lifecycle, a second message waits for the first reply, and Stop drops it before it is sent", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-nolifecycle-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const stdinLog = path.join(fixtureDir, "stdin.jsonl");
  await writeFile(claudePath, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let results = 0;
let messages = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(stdinLog)}, JSON.stringify({ type: message.type, results }) + "\\n");
  if (message.type !== "user") return;
  messages += 1;
  const reply = "Reply " + messages + ".";
  setTimeout(() => {
    send({ type: "system", subtype: "init", session_id: "old-cli" });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
    send({ type: "result", subtype: "success", result: reply });
    results += 1;
  }, messages === 1 ? 300 : 10);
});
`, "utf8");
  await chmod(claudePath, 0o755);
  const runner = makeRunner() as any;
  runner.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-old", kind: "claude-code", label: "Claude" };
  const warm = { conversationId: "conversation-old", participantId: participant.id, contextKey: "context-old", idleTimeoutMs: 60_000 };
  try {
    const firstRun = runner.run(participant, "One.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondRun = runner.run(participant, "Two.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm });
    const controller = new AbortController();
    const thirdRun = runner.run(participant, "Three.", fixtureDir, undefined, "chat", controller.signal, { agentMode: "default", warm });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error("Stopped by user."));
    const third = await thirdRun;
    assert.equal(third.ok, false, "a message never sent is dropped at once");
    const [first, second] = await Promise.all([firstRun, secondRun]);
    assert.equal(first.content, "Reply 1.");
    assert.equal(second.content, "Reply 2.");
    const log = (await readFile(stdinLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(log.map((entry) => entry.type), ["user", "user"], "the stopped message was never written and no control request was needed");
    assert.equal(log[1].results, 1, "the second message was written only after the first reply ended");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude public warm-run path: a provider that dies with background work kills that work and the next message starts fresh without replaying", { timeout: 10_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-background-failure-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const countFile = path.join(fixtureDir, "count.txt");
  const pidsFile = path.join(fixtureDir, "pids.txt");
  const taskPidFile = path.join(fixtureDir, "task.pid");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const backgroundTaskScript = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
setTimeout(() => {
  const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
}, 150);
setInterval(() => {}, 1000);
`;
  await writeFile(claudePath, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const readline = require("node:readline");
const countFile = ${JSON.stringify(countFile)};
const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) + 1 : 1;
writeFileSync(countFile, String(count));
appendFileSync(${JSON.stringify(pidsFile)}, String(process.pid) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", () => {
  send({ type: "system", subtype: "init", session_id: "failure-session-" + count });
  if (count === 1) {
    const task = spawn(process.execPath, ["-e", ${JSON.stringify(backgroundTaskScript)}], { stdio: "ignore", detached: true });
    writeFileSync(${JSON.stringify(taskPidFile)}, String(task.pid));
    send({ type: "system", subtype: "task_started", task_id: "task-1", description: "failing background task", is_backgrounded: true });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Work started." }] } });
    send({ type: "result", subtype: "success", result: "Work started." });
    const failWhenHelperStarts = () => {
      if (!existsSync(${JSON.stringify(helperPidFile)})) {
        setTimeout(failWhenHelperStarts, 5);
        return;
      }
      process.stdout.write(JSON.stringify({ type: "error", error: "fixture provider failed" }) + "\\n", () => process.exit(1));
    };
    failWhenHelperStarts();
    return;
  }
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fresh after failure." }] } });
  send({ type: "result", subtype: "success", result: "Fresh after failure." });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  let oneShotFallbacks = 0;
  runner.runClaudeOneShot = async (): Promise<never> => {
    oneShotFallbacks += 1;
    throw new Error("prompt replayed through one-shot fallback");
  };
  const participant = { id: "claude-failure", kind: "claude-code", label: "Claude" };
  const warm = {
    conversationId: "conversation-failure",
    participantId: participant.id,
    contextKey: "context-failure",
    idleTimeoutMs: 60_000
  };
  let taskPid: number | undefined;
  let helperPid: number | undefined;
  try {
    const first = await runner.run(participant, "Start work.", fixtureDir, undefined, "chat", undefined, {
      agentMode: "default",
      warm
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.content, "Work started.");
    assert.equal(first.warnings, undefined, "the reply itself finished cleanly");
    assert.equal(oneShotFallbacks, 0);
    taskPid = Number.parseInt((await readFile(taskPidFile, "utf8")).trim(), 10);
    // The provider dies only after its background task has started a helper.
    for (let attempt = 0; attempt < 200 && helperPid === undefined; attempt += 1) {
      const text = await readFile(helperPidFile, "utf8").catch(() => "");
      helperPid = text.trim() ? Number.parseInt(text.trim(), 10) : undefined;
      if (helperPid === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(helperPid, "the background task started its helper");
    await assertFixtureProcessStops(taskPid);
    await assertFixtureProcessStops(helperPid);

    const second = await runner.run(participant, "Continue safely.", fixtureDir, undefined, "chat", undefined, {
      agentMode: "default",
      warm
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.content, "Fresh after failure.");
    const pids = (await readFile(pidsFile, "utf8")).trim().split(/\r?\n/).map(Number);
    assert.equal(pids.length, 2);
    assert.notEqual(pids[0], pids[1]);
    assert.equal(oneShotFallbacks, 0);
  } finally {
    await runner.shutdownWarmAgents();
    for (const pid of [taskPid, helperPid]) {
      if (pid && testProcessExists(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude live background shutdown escalates when the provider ignores stdin EOF", { timeout: 10_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-background-escalation-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const providerPidFile = path.join(fixtureDir, "provider.pid");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const stdinClosedMarker = path.join(fixtureDir, "stdin-closed.marker");
  await writeFile(claudePath, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));
// It ignores SIGTERM as well, so only the final SIGKILL ends it, and a slow
// machine still gets to record the EOF before then.
process.on("SIGTERM", () => {});
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => {
  writeFileSync(${JSON.stringify(stdinClosedMarker)}, "closed");
  setInterval(() => {}, 1000);
});
input.on("line", () => {
  send({ type: "system", subtype: "init", session_id: "escalation-session" });
  send({ type: "system", subtype: "task_started", task_id: "task-1", description: "stuck background task", is_backgrounded: true });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Still running." }] } });
  send({ type: "result", subtype: "success", result: "Still running." });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  runner.claudeBackgroundCloseGraceMs = 20;
  const participant = { id: "claude-escalation", kind: "claude-code", label: "Claude" };
  const controller = new AbortController();
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let providerPid: number | undefined;
  let helperPid: number | undefined;
  try {
    const run = runner.run(participant, "Start work.", fixtureDir, undefined, "chat", controller.signal, {
      agentMode: "default",
      warm: {
        conversationId: "conversation-escalation",
        participantId: participant.id,
        contextKey: "context-escalation",
        idleTimeoutMs: 60_000
      },
      onOutput: (event: { activityStatus?: string; text: string }) => {
        if (/Running in the background/.test(event.text)) {
          markHeld();
        }
      }
    });
    await held;
    providerPid = Number.parseInt((await readFile(providerPidFile, "utf8")).trim(), 10);
    helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
    const result = await run;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.content, "Still running.");
    assert.equal(controller.signal.aborted, false);
    // Removing the member (or closing the chat) retires its process with the
    // background work it still carries.
    await runner.closeWarmAgents("conversation-escalation", participant.id, "member-removed");
    assert.equal(await readFile(stdinClosedMarker, "utf8"), "closed");
    await assertFixtureProcessStops(providerPid);
    await assertFixtureProcessStops(helperPid);
  } finally {
    await runner.shutdownWarmAgents();
    for (const pid of [providerPid, helperPid]) {
      if (pid && testProcessExists(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude live background shutdown kills descendants after the provider exits on stdin EOF", { timeout: 10_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-background-eof-exit-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const stdinClosedMarker = path.join(fixtureDir, "stdin-closed.marker");
  await writeFile(claudePath, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
// SIGTERM (sent 300 ms after EOF) must not end it before it handles the
// EOF itself on a slow machine; it exits on EOF as the scenario says.
process.on("SIGTERM", () => {});
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => {
  writeFileSync(${JSON.stringify(stdinClosedMarker)}, "closed");
  process.exit(0);
});
input.on("line", () => {
  send({ type: "system", subtype: "init", session_id: "eof-exit-session" });
  send({ type: "system", subtype: "task_started", task_id: "task-1", description: "orphan-prone background task", is_backgrounded: true });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Still running." }] } });
  send({ type: "result", subtype: "success", result: "Still running." });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  runner.nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  runner.providerExecutableForRun = async () => claudePath;
  runner.claudeBackgroundCloseGraceMs = 200;
  const participant = { id: "claude-eof-exit", kind: "claude-code", label: "Claude" };
  const controller = new AbortController();
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let helperPid: number | undefined;
  try {
    const run = runner.run(participant, "Start work.", fixtureDir, undefined, "chat", controller.signal, {
      agentMode: "default",
      warm: {
        conversationId: "conversation-eof-exit",
        participantId: participant.id,
        contextKey: "context-eof-exit",
        idleTimeoutMs: 60_000
      },
      onOutput: (event: { activityStatus?: string; text: string }) => {
        if (/Running in the background/.test(event.text)) {
          markHeld();
        }
      }
    });
    await held;
    helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
    const result = await run;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.content, "Still running.");
    assert.equal(controller.signal.aborted, false);
    await runner.closeWarmAgents("conversation-eof-exit", participant.id, "member-removed");
    assert.equal(await readFile(stdinClosedMarker, "utf8"), "closed");
    await assertFixtureProcessStops(helperPid);
  } finally {
    await runner.shutdownWarmAgents();
    if (helperPid && testProcessExists(helperPid)) {
      process.kill(helperPid, "SIGKILL");
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("update quit immediately terminates a warm Claude provider and its detached background task", { timeout: 10_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-update-quit-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const providerPidFile = path.join(fixtureDir, "provider.pid");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  await writeFile(claudePath, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", () => {
  send({ type: "system", subtype: "init", session_id: "update-quit-session" });
  send({ type: "system", subtype: "task_started", task_id: "task-1", description: "update-sensitive task", is_backgrounded: true });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Still running." }] } });
  send({ type: "result", subtype: "success", result: "Still running." });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  runner.providerExecutableForRun = async () => claudePath;
  let captureCount = 0;
  runner.readClaudeBackgroundProcessTable = async () => {
    captureCount += 1;
    const { readPosixProcessTableAsync } = await import("./processTermination");
    return readPosixProcessTableAsync();
  };
  const participant = { id: "claude-update-quit", kind: "claude-code", label: "Claude" };
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let providerPid: number | undefined;
  let helperPid: number | undefined;
  try {
    const run = runner.run(participant, "Start work.", fixtureDir, undefined, "chat", undefined, {
      agentMode: "default",
      warm: {
        conversationId: "conversation-update-quit",
        participantId: participant.id,
        contextKey: "context-update-quit",
        idleTimeoutMs: 60_000
      },
      onOutput: (event: { activityStatus?: string; text: string }) => {
        if (/Running in the background/.test(event.text)) {
          markHeld();
        }
      }
    });
    await held;
    providerPid = Number.parseInt((await readFile(providerPidFile, "utf8")).trim(), 10);
    helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
    await run;
    assert.ok(captureCount > 0, "the shared descendant sampler ran while background work was live");
    runner.terminateWarmAgentsImmediately("update installation");
    await assertFixtureProcessStops(providerPid);
    await assertFixtureProcessStops(helperPid);
    const capturesAfterShutdown = captureCount;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(captureCount, capturesAfterShutdown, "update shutdown stopped the shared descendant sampler");
  } finally {
    runner.terminateWarmAgentsImmediately("test cleanup");
    for (const pid of [providerPid, helperPid]) {
      if (pid && testProcessExists(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("update quit also terminates a Claude provider already in graceful close", { timeout: 10_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-update-during-close-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const providerPidFile = path.join(fixtureDir, "provider.pid");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const stdinClosedMarker = path.join(fixtureDir, "stdin-closed.marker");
  await writeFile(claudePath, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => {
  writeFileSync(${JSON.stringify(stdinClosedMarker)}, "closed");
  setInterval(() => {}, 1000);
});
input.on("line", () => {
  send({ type: "system", subtype: "init", session_id: "update-during-close-session" });
  send({ type: "system", subtype: "task_started", task_id: "task-1", description: "update-sensitive task", is_backgrounded: true });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Still running." }] } });
  send({ type: "result", subtype: "success", result: "Still running." });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  runner.providerExecutableForRun = async () => claudePath;
  runner.claudeBackgroundCloseGraceMs = 5_000;
  const participant = { id: "claude-update-during-close", kind: "claude-code", label: "Claude" };
  const controller = new AbortController();
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let providerPid: number | undefined;
  let helperPid: number | undefined;
  try {
    const run = runner.run(participant, "Start work.", fixtureDir, undefined, "chat", controller.signal, {
      agentMode: "default",
      warm: {
        conversationId: "conversation-update-during-close",
        participantId: participant.id,
        contextKey: "context-update-during-close",
        idleTimeoutMs: 60_000
      },
      onOutput: (event: { activityStatus?: string; text: string }) => {
        if (/Running in the background/.test(event.text)) {
          markHeld();
        }
      }
    });
    await held;
    providerPid = Number.parseInt((await readFile(providerPidFile, "utf8")).trim(), 10);
    helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
    const result = await run;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(controller.signal.aborted, false);
    const closing = runner.closeWarmAgents("conversation-update-during-close", participant.id, "member-removed");
    let stdinClosed = false;
    for (let attempt = 0; attempt < 100 && !stdinClosed; attempt += 1) {
      stdinClosed = await readFile(stdinClosedMarker, "utf8")
        .then((value) => value === "closed")
        .catch(() => false);
      if (!stdinClosed) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(stdinClosed, true, "ordinary close entered its graceful stdin-EOF wait");
    assert.equal(runner.warmAgents.size, 0, "the closing provider already left the active map");
    assert.equal(runner.closingWarmAgents.size, 1, "the closing provider remains visible to update shutdown");

    runner.terminateWarmAgentsImmediately("update installation");
    await closing;
    await assertFixtureProcessStops(providerPid);
    await assertFixtureProcessStops(helperPid);
  } finally {
    runner.terminateWarmAgentsImmediately("test cleanup");
    for (const pid of [providerPid, helperPid]) {
      if (pid && testProcessExists(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude background-process sampling is shared, non-overlapping, and lives until the last agent stops", async () => {
  const runner = makeRunner() as any;
  const rows = new Map<number, never>();
  let reads = 0;
  let resolveFirstRead!: (value: Map<number, never>) => void;
  const firstRead = new Promise<Map<number, never>>((resolve) => { resolveFirstRead = resolve; });
  runner.readClaudeBackgroundProcessTable = () => {
    reads += 1;
    return reads === 1 ? firstRead : Promise.resolve(new Map<number, never>());
  };
  let firstLive = true;
  let secondLive = true;
  const firstTables: unknown[] = [];
  const secondTables: unknown[] = [];
  let markSharedDelivery!: () => void;
  const sharedDelivery = new Promise<void>((resolve) => { markSharedDelivery = resolve; });
  let markSoloDelivery!: () => void;
  const soloDelivery = new Promise<void>((resolve) => { markSoloDelivery = resolve; });
  const noteDelivery = (): void => {
    if (firstTables.length === 1 && secondTables.length === 1) {
      markSharedDelivery();
    }
    if (secondTables.length === 2) {
      markSoloDelivery();
    }
  };
  runner.warmAgents.set("first", {
    closed: false,
    hasLiveBackgroundWork: () => firstLive,
    refreshCapturedBackgroundProcesses: (table: unknown) => {
      firstTables.push(table);
      noteDelivery();
    }
  });
  runner.warmAgents.set("second", {
    closed: false,
    hasLiveBackgroundWork: () => secondLive,
    refreshCapturedBackgroundProcesses: (table: unknown) => {
      secondTables.push(table);
      noteDelivery();
    }
  });

  try {
    runner.ensureClaudeBackgroundProcessCapture();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(reads, 1, "timer ticks do not overlap an in-flight process-table read");

    resolveFirstRead(rows);
    await sharedDelivery;
    assert.equal(reads, 1, "one completed sample used one process-table read");
    assert.deepEqual(firstTables, [rows]);
    assert.deepEqual(secondTables, [rows]);

    firstLive = false;
    await soloDelivery;
    assert.equal(reads, 2, "the remaining agent kept the sampler alive for one shared tick");
    assert.deepEqual(firstTables, [rows]);
    assert.equal(secondTables.length, 2);
    assert.notEqual(secondTables[1], rows, "the second tick used its own table snapshot");

    secondLive = false;
    runner.maybeStopClaudeBackgroundProcessCapture();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(reads, 2, "the shared sampler stopped after the last agent retired");
  } finally {
    firstLive = false;
    secondLive = false;
    runner.stopClaudeBackgroundProcessCapture();
    runner.warmAgents.clear();
  }
});

test("immediate shutdown ignores a recycled warm-agent root PID and its unrelated children", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process identity checks are unavailable on Windows");
    return;
  }
  const runner = makeRunner() as any;
  const oldIdentity = { pid: 42, startedAt: "Fri Sep  5 12:00:00 2026" };
  runner.readPosixProcessTableForTermination = () => new Map([
    [42, { pid: 42, ppid: 1, pgid: 42, startedAt: "Fri Sep  5 12:01:00 2026" }],
    [43, { pid: 43, ppid: 42, pgid: 42, startedAt: "Fri Sep  5 12:01:01 2026" }]
  ]);
  const childSignals: NodeJS.Signals[] = [];
  const processSignals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
  const originalKill = process.kill;
  process.kill = ((pid: number, signal: NodeJS.Signals | number) => {
    processSignals.push({ pid, signal });
    return true;
  }) as typeof process.kill;
  runner.warmAgents.set("stale", {
    closed: false,
    providerKind: "claude-code",
    process: {
      pid: 42,
      exitCode: 0,
      signalCode: null,
      killed: false,
      kill: (signal: NodeJS.Signals) => {
        childSignals.push(signal);
        return true;
      }
    },
    processIdentity: () => oldIdentity,
    capturedBackgroundProcesses: () => []
  });
  try {
    runner.terminateWarmAgentsImmediately("update installation");
    assert.deepEqual(processSignals, []);
    assert.deepEqual(childSignals, []);
  } finally {
    process.kill = originalKill;
    runner.warmAgents.clear();
  }
});

test("Codex ignores cross-thread resolution and retires approval when its item completes", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-retire-approval-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-retire" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-retire" } } });
    send({ method: "turn/started", params: { threadId: "thread-retire", turn: { id: "turn-retire" } } });
    send({ id: "approval-retire", method: "item/commandExecution/requestApproval", params: {
      threadId: "thread-retire", turnId: "turn-retire", itemId: "item-retire", startedAtMs: 1,
      environmentId: null, command: "git status", cwd: process.cwd(), availableDecisions: ["accept", "decline"]
    } });
    send({ method: "serverRequest/resolved", params: { threadId: "thread-other", requestId: "approval-retire" } });
    setTimeout(() => {
      send({ method: "item/completed", params: { threadId: "thread-retire", turnId: "turn-retire", item: {
        id: "item-retire", type: "commandExecution", status: "completed", command: "git status"
      } } });
      send({ method: "turn/completed", params: { threadId: "thread-retire", turn: { id: "turn-retire", status: "completed" } } });
    }, 75);
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let aborted = false;
  const output: string[] = [];
  try {
    const result = await runner.runCodexAppServerWarmOrOneShot(
      { id: "participant-retire", kind: "codex-cli", label: "Codex" },
      "Run the protected command.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-retire",
          participantId: "participant-retire",
          contextKey: "context-retire",
          idleTimeoutMs: 60_000
        },
        onOutput: (event: { text?: string }) => { if (event.text) output.push(event.text); },
        onCodexServerRequest: (request: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            aborted = true;
            reject(request.signal.reason);
          }, { once: true });
        })
      }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(aborted, true);
    assert.match(output.join(""), /Ignored serverRequest\/resolved for thread thread-other/);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server never replays a prompt after the provider accepted the turn", async () => {
  const runner = makeRunner() as any;
  let oneShotRuns = 0;
  runner.createCodexAppServerWarmAgent = () => ({
    key: "warm-key",
    scopeKey: "conversation-1:participant-1",
    providerKind: "codex-cli",
    process: { exitCode: null },
    queue: Promise.resolve(),
    closed: false,
    run: async () => {
      throw new CodexAppServerRunError(new Error("app-server disconnected"), true);
    }
  });
  runner.closeWarmAgent = async () => undefined;
  runner.runCodexOneShot = async () => {
    oneShotRuns += 1;
    return { ok: true, content: "REPLAYED" };
  };

  const result = await runner.runCodexAppServerWarmOrOneShot(
    { id: "participant-1", kind: "codex-cli", label: "Codex" },
    "ONE_SHOT_PROMPT",
    "/tmp/repo",
    undefined,
    "chat",
    undefined,
    {
      warm: {
        conversationId: "conversation-1",
        participantId: "participant-1",
        contextKey: "context-1",
        idleTimeoutMs: 60_000
      }
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /app-server disconnected/);
  assert.equal(oneShotRuns, 0);
});

test("shutdown waits for a session still being constructed and duplicate construction shares its owner", async () => {
  const runner = makeRunner() as any;
  let create!: (entry: any) => void;
  const ready = new Promise<any>((resolve) => { create = resolve; });
  let constructions = 0;
  let started!: () => void;
  const constructing = new Promise<void>(resolve => { started = resolve; });
  const closed: string[] = [];
  runner.closeWarmAgent = async (entry: any) => { closed.push(entry.key); entry.closed = true; };
  const first = runner.createTrackedWarmAgent("starting", () => { constructions += 1; started(); return ready; });
  const duplicate = runner.createTrackedWarmAgent("starting", () => { constructions += 1; return ready; });
  assert.equal(first, duplicate);
  await constructing;
  const shuttingDown = runner.shutdownWarmAgents();
  await assert.rejects(runner.createTrackedWarmAgent("new", async () => ({})), /shutting down/);
  create({ key: "starting", closed: false });
  await assert.rejects(first, /before this command started/);
  await shuttingDown;
  assert.deepEqual(closed, ["starting"]);
  assert.equal(constructions, 1);
  assert.equal(runner.warmAgents.size, 0);
});

test("conversation shutdown keeps other chats running and retries failed native closure", async () => {
  const runner = makeRunner() as any;
  const entry = (conversationId: string) => ({ key: JSON.stringify({ conversationId, participantId: "member" }), scopeKey: `${conversationId}:member`, closed: false });
  const archived = entry("chat");
  const other = entry("chat:other");
  runner.warmAgents.set(archived.key, archived);
  runner.warmAgents.set(other.key, other);
  runner.clearWarmIdleTimer = () => {};
  runner.maybeStopClaudeBackgroundProcessCapture = () => {};
  let attempts = 0;
  runner.closeWarmAgentProcess = async (value: unknown) => {
    assert.equal(value, archived);
    if (++attempts === 1) throw new Error("closure receipt could not be stored");
  };
  await assert.rejects(runner.closeConversationSessions("chat"), /receipt could not be stored/);
  assert.equal(runner.hasActiveNativeWork(), true, "a closed flag is not a proof that descendants are gone");
  await assert.rejects(runner.createTrackedWarmAgent(archived.key, async () => archived), /sessions are closing/);
  assert.equal(runner.warmAgents.get(other.key), other);
  assert.equal(other.closed, false);
  await runner.closeConversationSessions("chat");
  assert.equal(attempts, 2);
  assert.equal(runner.hasActiveNativeWork(), false);
  assert.equal(runner.warmAgents.get(other.key), other);
});

test("conversation shutdown fences concurrent construction and preserves another chat's startup", async () => {
  const runner = makeRunner() as any;
  const key = JSON.stringify({ conversationId: "closing", participantId: "member" });
  let finish!: (entry: unknown) => void;
  let started!: () => void;
  const constructing = new Promise<void>(resolve => { started = resolve; });
  const creating = runner.createTrackedWarmAgent(key, () => new Promise(resolve => { finish = resolve; started(); }));
  await constructing;
  const closed: string[] = [];
  runner.closeWarmAgent = async (entry: { key: string }) => { closed.push(entry.key); };
  const closing = runner.closeConversationSessions("closing");
  assert.equal(runner.closeConversationSessions("closing"), closing);
  await assert.rejects(runner.createTrackedWarmAgent(key, async () => ({})), /sessions are closing/);
  const unrelated = JSON.stringify({ conversationId: "another", participantId: "member" });
  await runner.createTrackedWarmAgent(unrelated, async () => ({ key: unrelated }));
  finish({ key });
  await assert.rejects(creating, /before this command started/);
  await closing;
  assert.deepEqual(closed, [key]);
  assert.ok(runner.warmAgents.has(unrelated));
});

test("codex app-server initialization failure never replays a command through one-shot execution", async () => {
  const runner = makeRunner() as any;
  let oneShotRuns = 0;
  runner.createCodexAppServerWarmAgent = () => ({
    key: "warm-key",
    scopeKey: "conversation-1:participant-1",
    providerKind: "codex-cli",
    process: { exitCode: null },
    queue: Promise.resolve(),
    closed: false,
    run: async () => {
      throw new CodexAppServerRunError(new Error("initialize failed"), false);
    }
  });
  runner.closeWarmAgent = async () => undefined;
  runner.runCodexOneShot = async () => {
    oneShotRuns += 1;
    return { ok: true, content: "FALLBACK" };
  };

  const result = await runner.runCodexAppServerWarmOrOneShot(
    { id: "participant-1", kind: "codex-cli", label: "Codex" },
    "PROMPT",
    "/tmp/repo",
    undefined,
    "chat",
    undefined,
    {
      warm: {
        conversationId: "conversation-1",
        participantId: "participant-1",
        contextKey: "context-1",
        idleTimeoutMs: 60_000
      }
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /initialize failed/);
  assert.equal(oneShotRuns, 0);
});

test("reasoning effort mapping is provider-specific", () => {
  const runner = makeRunner() as any;

  assert.equal(runner.codexReasoningEffort("minimal"), "minimal");
  assert.equal(runner.codexReasoningEffort("max"), "max");
  assert.equal(runner.codexReasoningEffort("ultra"), "ultra");
  assert.equal(runner.codexReasoningEffort("invalid"), undefined);
  assert.equal(runner.claudeReasoningEffort("xhigh"), "xhigh");
  assert.equal(runner.claudeReasoningEffort("max"), "max");
  assert.equal(runner.claudeReasoningEffort("ultra"), undefined);
  assert.equal(runner.claudeReasoningEffort("minimal"), undefined);
});

test("Codex catalog preserves max and ultra and their default recommendation", () => {
  const runner = makeRunner() as any;
  const options = runner.codexModelReasoningEfforts({
    defaultReasoningEffort: "max",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra", "invalid", "ultra"].map(
      (reasoningEffort) => ({ reasoningEffort, description: `Use ${reasoningEffort}` })
    )
  });
  assert.deepEqual(options.map((option: any) => option.id), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(options.slice(-2), [
    { id: "max", label: "Max", description: "Use max", recommended: true },
    { id: "ultra", label: "Ultra", description: "Use ultra", recommended: false }
  ]);
  assert.deepEqual(runner.codexModelReasoningEfforts(undefined), []);
});

test("Codex max and ultra reach fresh and resumed local and remote invocations", () => {
  const runner = makeRunner() as any;
  for (const reasoningEffort of ["max", "ultra"] as const) {
    const participant = { id: "participant", kind: "codex-cli" as const, label: "Codex", model: "gpt-6-astra", reasoningEffort };
    const options = chatOptions({ agentMode: "auto", workspaceWrite: true });
    const start = runner.codexAppServerThreadStartParams(participant, "/repo", "chat", options);
    const resume = runner.codexAppServerThreadResumeParams("session-1", participant, "/repo", "chat", options);
    assert.equal(start.config.model_reasoning_effort, reasoningEffort);
    assert.equal(resume.config.model_reasoning_effort, reasoningEffort);
    for (const sessionId of [undefined, "session-1"]) {
      const invocation = buildCodexExecInvocation({
        participant,
        prompt: "Prompt",
        outputPath: "/tmp/output",
        repoPath: "/repo",
        kind: "chat",
        options: { ...options, sessionId, remoteSandbox: { networkAccess: true, gitWritableRoot: "/repo" } }
      });
      assert.ok(invocation.args.includes(`model_reasoning_effort="${reasoningEffort}"`));
    }
  }
});

test("codex app-server resume re-asserts the auto preset so a mode switch applies without a fresh session", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const params = runner.codexAppServerThreadResumeParams(
    "session-1",
    participant,
    "/repo",
    "chat",
    chatOptions({
      agentMode: "auto",
      workspaceWrite: false,
      webAccess: false
    })
  );

  // Resuming the existing session still launches under the new Auto-review profile,
  // so switching to auto mid-chat takes effect without dropping the session.
  assert.equal(params.threadId, "session-1");
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.approvalsReviewer, "auto_review");
  assert.equal(params.sandbox, "workspace-write");
  assert.equal(params.config.web_search, "live");
});

test("withAppMcpClientStatus warns and flags unestablished app MCP generations", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const result = runner.withAppMcpClientStatus({
    participant,
    ok: true,
    content: "done"
  }, participant, {
    appMcp: {
      url: "http://127.0.0.1:1/mcp",
      token: "token",
      toolNames: ["app_chat_request_participants"],
      clientGenerationId: "generation-1",
      clientStatus: () => ({
        initialized: false,
        listedTools: false,
        requiredToolsPresent: false,
        missingToolNames: ["app_chat_request_participants"],
        errored: false
      })
    }
  });

  assert.equal(result.appMcpClientFailed, true);
  assert.equal(result.warnings.some((warning: string) => warning.includes("app tools did not finish MCP setup")), true);
});

test("withAppMcpClientStatus does not warn for healthy warm reuse after setup", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const options = {
    appMcp: {
      url: "http://127.0.0.1:1/mcp",
      token: "token",
      toolNames: ["app_chat_request_participants"],
      clientGenerationId: "generation-healthy",
      clientStatus: () => ({
        initialized: true,
        listedTools: true,
        requiredToolsPresent: true,
        missingToolNames: [],
        errored: false
      })
    }
  };

  for (let turn = 0; turn < 3; turn += 1) {
    const result = runner.withAppMcpClientStatus({
      participant,
      ok: true,
      content: `turn ${turn}`
    }, participant, options);

    assert.equal(result.appMcpClientFailed, undefined);
    assert.equal(result.warnings, undefined);
  }
});

test("codex app-server compact instructions become a scoped compact_prompt override", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const params = runner.codexAppServerThreadResumeParams(
    "session-1",
    participant,
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
  assert.match(params.config.compact_prompt, /Compact the conversation context/);
  assert.match(params.config.compact_prompt, /keep focus on parser and CLI protocol details/);
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
  const params = runner.codexAppServerThreadResumeParams(
    "session-1",
    participant,
    "/repo",
    "chat",
    chatOptions({
      agentMode: "default",
      workspaceWrite: false,
      webAccess: false
    })
  );

  assert.equal("compact_prompt" in params.config, false);
});

test("codex app-server compact prompt can be explicitly cleared after an instructed compact", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const params = runner.codexAppServerThreadResumeParams(
    "session-1",
    participant,
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

  assert.equal(params.config.compact_prompt, null);
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

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "session-1",
      usage: {
        input_tokens: 120
      },
      contextWindowTokens: 1000
    }
  }, participant, pending, cleanupPending, rejectPending), true);

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "thread/compacted",
    params: {
      threadId: "session-1"
    }
  }, participant, pending, cleanupPending, rejectPending), true);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 120);
  assert.equal(resolved.contextUsage.contextWindowTokens, 1000);
  assert.equal(resolved.contextUsage.percentage, 12);
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

  assert.equal(runner.handleCodexAppServerCompactNotification({
    type: "event",
    msg: {
      type: "context_compacted",
      thread_id: "session-1",
      usage: {
        input_tokens: 80
      },
      context_window_tokens: 1000
    }
  }, participant, pending, cleanupPending, rejectPending), true);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 80);
  assert.equal(resolved.contextUsage.contextWindowTokens, 1000);
  assert.equal(resolved.contextUsage.percentage, 8);
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

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "thread/compact/completed",
    params: {
      threadId: "session-1",
      usage: {
        input_tokens: 70
      },
      contextWindowTokens: 1000
    }
  }, participant, pending, cleanupPending, rejectPending), true);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 70);
  assert.equal(resolved.contextUsage.percentage, 7);
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

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "turn/started",
    params: { threadId: "session-1", turn: { id: "compact-turn" } }
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  assert.equal(runner.handleCodexAppServerCompactNotification({
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
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "turn/completed",
    params: { threadId: "session-1", turn: { id: "compact-turn", status: "completed" } }
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  const resolved = ctx.getResolved();
  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 5519);
  assert.equal(resolved.contextUsage.contextWindowTokens, 258400);
  assert.equal(resolved.contextUsage.percentage, 2);
});

test("codex app-server compact ignores a stray turn/completed before the compaction turn", () => {
  const runner = makeRunner() as any;
  const participant = { kind: "codex-cli", label: "@codex", model: "gpt-5.5" };
  const ctx = makeCompactPending("session-1");

  // A completion that arrives before we ever saw the compaction turn start must
  // be ignored so we do not resolve on a prior turn and report stale usage.
  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "turn/completed",
    params: { threadId: "session-1", turn: { id: "earlier-turn", status: "completed" } }
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);
  assert.equal(ctx.getResolved(), undefined);
  assert.equal(ctx.pending !== undefined, true);
});

test("codex app-server compact rejects when the compaction turn fails", () => {
  const runner = makeRunner() as any;
  const participant = { kind: "codex-cli", label: "@codex", model: "gpt-5.5" };
  const ctx = makeCompactPending("session-1");

  runner.handleCodexAppServerCompactNotification({
    method: "turn/started",
    params: { threadId: "session-1", turn: { id: "compact-turn" } }
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending);

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "turn/completed",
    params: { threadId: "session-1", turn: { id: "compact-turn", status: "failed", error: { message: "model overloaded" } } }
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  assert.equal(ctx.getResolved(), undefined);
  assert.match(String(ctx.getRejected()?.message), /model overloaded/);
});

test("findContextUsedTokens reads the last turn total tokens from both codex shapes", () => {
  const runner = makeRunner() as any;
  // Rollout log shape (post-compact: input_tokens 0 but total_tokens carries the summary size).
  assert.equal(runner.findContextUsedTokens({
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 0, total_tokens: 0 },
        last_token_usage: { input_tokens: 0, total_tokens: 5519 },
        model_context_window: 258400
      }
    }
  }), 5519);
  // App-server event shape.
  assert.equal(runner.findContextUsedTokens({
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { total: { totalTokens: 0 }, last: { totalTokens: 6093 }, modelContextWindow: 258400 } }
  }), 6093);
  // A populated session prefers the most recent turn over the cumulative total.
  assert.equal(runner.findContextUsedTokens({
    payload: {
      info: {
        total_token_usage: { input_tokens: 65128346, total_tokens: 65320914 },
        last_token_usage: { input_tokens: 150556, total_tokens: 151216 }
      }
    }
  }), 151216);
});

test("agentContextUsageFromEvent resolves a window for current model ids", () => {
  const runner = makeRunner() as any;
  const claude = runner.agentContextUsageFromEvent(
    { message: { model: "claude-opus-4-8", usage: { input_tokens: 4042, cache_creation_input_tokens: 13829, cache_read_input_tokens: 0 } } },
    { kind: "claude-code", label: "@claude" },
    "claude-code"
  );
  assert.equal(claude.usedTokens, 17871);
  assert.equal(claude.contextWindowTokens, 1_000_000);
});

/** A stand-in for the process a compaction runs in: records what it was
 *  asked and answers like the CLI. */
function fakeCompactionProcess(answer: { ok?: boolean; contextUsage?: unknown; postTokens?: number } = {}) {
  const calls: Array<{ prompt: string; timeoutMs?: number; allowEmptyContent?: boolean; observers?: string[] }> = [];
  let compactions = 0;
  const entry: any = {
    key: "compact-entry", scopeKey: "compact-scope", providerKind: "claude-code", closed: false, queue: Promise.resolve(),
    process: { exitCode: null },
    isIdle: () => true,
    run: async (prompt: string, _signal: unknown, _onOutput: unknown, _onSessionId: unknown, timeoutMs?: number, _goal?: unknown, _codex?: unknown, claude?: Record<string, unknown>) => {
      calls.push({
        prompt,
        timeoutMs,
        allowEmptyContent: claude?.allowEmptyContent as boolean | undefined,
        observers: ["onSelfResumedTurn", "onBackgroundTasksChanged"].filter((name) => typeof claude?.[name] === "function")
      });
      if (answer.ok === false) return { ok: false, sessionId: "session-1", error: "compaction failed" };
      compactions += 1;
      return { ok: true, sessionId: "session-1", content: "" };
    },
    contextUsage: async () => answer.contextUsage,
    lastCompactBoundary: () => (compactions ? { count: compactions, ...(answer.postTokens ? { postTokens: answer.postTokens } : {}) } : undefined)
  };
  return { entry, calls };
}

const COMPACT_WARM = { conversationId: "c1", participantId: "p1", contextKey: "k", idleTimeoutMs: 60_000, onSelfResumedTurn: () => undefined, onBackgroundTasksChanged: () => undefined };

function startsFakeMemberProcess(runner: any, entry: any): { created?: { key: string; scopeKey: string; options: any } } {
  const record: { created?: { key: string; scopeKey: string; options: any } } = {};
  runner.providerExecutableForRun = async () => "claude";
  runner.createClaudeWarmAgent = async (key: string, scopeKey: string, _participant: unknown, _repoPath: unknown, _kind: unknown, options: any) => {
    record.created = { key, scopeKey, options };
    entry.key = key;
    entry.scopeKey = scopeKey;
    runner.warmAgents.set(key, entry);
    return entry;
  };
  return record;
}

test("claude compact with no live process starts the member's process as its turn would and keeps it: its key, role and app tools, its turns' timeout, the CLI's count reported", async () => {
  const runner = makeRunner() as any;
  runner.setRunTimeoutMs(2 * 60 * 60_000);
  const usage = { usedTokens: 1995, contextWindowTokens: 1_000_000, percentage: 0, source: "claude-code", updatedAt: "2026-06-17T00:00:00.000Z" };
  const { entry, calls } = fakeCompactionProcess({ contextUsage: usage });
  const record = startsFakeMemberProcess(runner, entry);
  const closed: string[] = [];
  runner.closeWarmAgent = async (_entry: unknown, reason: string) => { closed.push(reason); };
  const participant = { kind: "claude-code", label: "@claude" };
  const options = {
    sessionId: "session-1",
    role: { name: "role", description: "d", instructions: "i", promptFallbackPrompt: "" },
    appMcp: { url: "http://127.0.0.1:1", token: "t", toolNames: [] },
    warm: COMPACT_WARM
  };

  const result = await runner.compactClaudeSession(participant, "/repo", "chat", undefined, options);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ prompt: "/compact", timeoutMs: 2 * 60 * 60_000, allowEmptyContent: true, observers: ["onSelfResumedTurn", "onBackgroundTasksChanged"] }]);
  assert.equal(record.created!.key, runner.warmAgentKey(participant, "/repo", "chat", options), "under the key the member's next turn looks up");
  assert.equal(record.created!.scopeKey, "c1:p1");
  assert.equal(record.created!.options.sessionId, "session-1", "resumed on the member's session");
  assert.equal(record.created!.options.role, options.role);
  assert.equal(record.created!.options.appMcp, options.appMcp);
  assert.equal(record.created!.options.warm, options.warm);
  assert.deepEqual(closed, [], "not closed afterwards");
  assert.equal(runner.warmAgents.get(record.created!.key), entry, "kept as the member's live process");
  assert.ok(entry.idleTimer, "with the member's idle timer re-armed");
  clearTimeout(entry.idleTimer);
  assert.equal(result.contextUsage.usedTokens, 1995);
});

test("claude compact instructions are sent as part of the native compact command", async () => {
  const runner = makeRunner() as any;
  const { entry, calls } = fakeCompactionProcess({ postTokens: 9000 });
  startsFakeMemberProcess(runner, entry);

  const result = await runner.compactClaudeSession(
    { kind: "claude-code", label: "@claude", model: "claude-opus-5-5[1m]" },
    "/repo",
    "chat",
    undefined,
    {
      sessionId: "session-1",
      compactInstructions: "keep focus on user approval and test output",
      warm: COMPACT_WARM
    }
  );

  assert.equal(result.ok, true);
  assert.equal(calls[0].prompt, "/compact keep focus on user approval and test output");
  assert.equal(result.contextUsage?.usedTokens, 9000, "without get_context_usage, the CLI's own compaction figure");
  clearTimeout(entry.idleTimer);
});

test("claude compact reports the CLI's failure as the compaction's and keeps the member's process; one left unusable is closed", async () => {
  const runner = makeRunner() as any;
  const { entry } = fakeCompactionProcess({ ok: false });
  startsFakeMemberProcess(runner, entry);
  const closed: string[] = [];
  runner.closeWarmAgent = async (_entry: unknown, reason: string) => { closed.push(reason); };
  const options = { sessionId: "session-1", warm: COMPACT_WARM };
  const result = await runner.compactClaudeSession({ kind: "claude-code", label: "@claude" }, "/repo", "chat", undefined, options);
  assert.equal(result.ok, false);
  assert.equal(result.error, "compaction failed");
  assert.equal(runner.warmAgents.get(entry.key), entry, "still the member's process");
  assert.ok(entry.idleTimer, "with its idle timer");
  entry.run = async () => { entry.unusable = true; throw new Error("claude warm process exited with code 1"); };
  const crashed = await runner.compactClaudeSession({ kind: "claude-code", label: "@claude" }, "/repo", "chat", undefined, options);
  assert.equal(crashed.ok, false);
  assert.match(crashed.error, /exited with code 1/);
  assert.deepEqual(closed, ["unusable"]);
  assert.equal(runner.warmAgents.has(entry.key), false);
  clearTimeout(entry.idleTimer);
});

test("claude compact that waited for a process with other settings does not start one once native sessions shut down", async () => {
  const runner = makeRunner() as any;
  let created = false;
  runner.createClaudeWarmAgent = async () => { created = true; throw new Error("must not start"); };
  const busy: any = {
    key: "other-settings", scopeKey: "c1:p1", providerKind: "claude-code", closed: false, queue: Promise.resolve(), process: { exitCode: null },
    isIdle: () => false,
    whenIdle: async () => { runner.warmShutdown = true; }
  };
  runner.warmAgents.set(busy.key, busy);
  const result = await runner.compactClaudeSession({ kind: "claude-code", label: "@claude" }, "/repo", "chat", undefined, { sessionId: "session-1", warm: COMPACT_WARM });
  assert.equal(result.ok, false);
  assert.match(result.error, /shutting down/);
  assert.equal(created, false);
  runner.warmShutdown = false;
});

test("claude compact without a member session has nothing to compact", async () => {
  const runner = makeRunner() as any;
  runner.createClaudeWarmAgent = async () => assert.fail("no process is started without a member session");
  const result = await runner.compactClaudeSession({ kind: "claude-code", label: "@claude" }, "/repo", "chat", undefined, { sessionId: "session-1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "@claude has no chat session to compact.");
});

test("codexPrompt chat envelope passes the inner prompt through and does not duplicate permission text", () => {
  const runner = makeRunner() as any;
  const innerPrompt = "INNER_PROMPT_MARKER";
  const wrapped = runner.codexPrompt(innerPrompt, "/repo", undefined, "chat", chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: false,
    canRequestPermissions: true
  }));

  assert.match(wrapped, /You are running for AccordAgents Chat in default mode/);
  assert.match(wrapped, /Read-only file inspection/);
  assert.ok(wrapped.includes(innerPrompt));
  assert.doesNotMatch(wrapped, /Shell commands are blocked for this turn/);
  assert.doesNotMatch(wrapped, /Workspace file edits are blocked for this turn/);
  assert.doesNotMatch(wrapped, /Web access is blocked for this turn/);
  assert.doesNotMatch(wrapped, /app_permissions_request_change/);
});

test("codexPrompt chat envelope reflects plan agent mode in its header", () => {
  const runner = makeRunner() as any;
  const wrapped = runner.codexPrompt("INNER", "/repo", undefined, "chat", chatOptions({
    agentMode: "plan",
    workspaceWrite: true,
    webAccess: false,
    canRequestPermissions: true
  }));

  assert.match(wrapped, /You are running for AccordAgents Chat in plan mode/);
});

test("codexPrompt chat envelope marks runs without readable context", () => {
  const runner = makeRunner() as any;
  const wrapped = runner.codexPrompt("INNER", undefined, undefined, "chat", chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    canRequestPermissions: false
  }));

  assert.match(wrapped, /No repository or app-managed readable directory is available/);
});

test("commandErrorText surfaces structured result errors", () => {
  const runner = makeRunner() as any;
  const error = new CommandError("claude exited with code 1", {
    command: "claude",
    args: [],
    stdout: JSON.stringify({
      type: "result",
      is_error: true,
      result: "You've hit your session limit; resets 4:10pm"
    }),
    stderr: "",
    exitCode: 1,
    timedOut: false
  });

  const message = runner.commandErrorText(error);

  assert.match(message, /You've hit your session limit/);
  assert.doesNotMatch(message, /Last events: result\./);
});

test("failed keeps raw CLI diagnostics out of visible chat content", () => {
  const runner = makeRunner() as any;
  const error = new CommandError("codex timed out after 1800000ms", {
    command: "codex",
    args: [],
    stdout: "",
    stderr: [
      "2026-06-16T09:48:01.929525Z ERROR rmcp::transport::worker: worker quit with fatal:",
      "Transport channel closed, when AuthRequired(AuthRequiredError {",
      "www_authenticate_header: \"Bearer resource_metadata=\\\"https://mcp.slack.com/.well-known/oauth-protected-resource\\\"\" })"
    ].join("\n"),
    exitCode: null,
    timedOut: true
  });

  const result = runner.failed({ label: "@sam-codex-qa-lead" } as any, error);

  assert.equal(result.content, "@sam-codex-qa-lead could not finish because the Slack MCP server needs authorization.");
  assert.match(result.error, /AuthRequired/);
  assert.doesNotMatch(result.content, /AuthRequired|Transport channel closed|1800000ms/);
});

test("failed formats CLI timeout content in human-readable time", () => {
  const runner = makeRunner() as any;

  const result = runner.failed(
    { label: "@sam-codex-qa-lead" } as any,
    new Error("codex app-server timed out after 86400000ms")
  );

  assert.equal(result.content, "@sam-codex-qa-lead timed out after 24 hours.");
  assert.match(result.error, /86400000ms/);
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
  runner.stopClaudeWarmReply(state, reply, hooks, participant);
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
  runner.stopClaudeWarmReply(state, queued.reply, hooks, participant);
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
  runner.stopClaudeWarmReply(state, queued.reply, hooks, participant);
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
  runner.claudeWarmStopAckTimeoutMs = 20;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state, hooks, participant } = harness;
  const { reply, rejected } = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  runner.stopClaudeWarmReply(state, reply, hooks, participant);
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
  runner.stopClaudeWarmReply(state, reply, hooks, participant);
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
  runner.stopClaudeWarmReply(state, first.reply, hooks, participant);
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
  runner.stopClaudeWarmReply(state, first.reply, hooks, participant);
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
  runner.stopClaudeWarmReply(state, first.reply, hooks, participant);
  send({ type: "command_lifecycle", command_uuid: "cmd-2", state: "started" });
  assert.equal(first.rejected[0]?.message, "claude warm process was cancelled");
  assert.equal(first.resolved.length, 0);
  assert.equal(state.active, second.reply);
});

test("claude warm: once the CLI refuses to drop a queued message, Stop waits for it to start without a deadline", async () => {
  const runner = makeRunner() as any;
  runner.claudeWarmStopAckTimeoutMs = 20;
  const harness = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { send, state, hooks, participant, written } = harness;
  harness.addReply();
  const queued = harness.addReply();
  send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  send({ type: "system", subtype: "init" });
  runner.stopClaudeWarmReply(state, queued.reply, hooks, participant);
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
  runner.closeWarmAgent = async (entry: unknown) => { closed.push(entry); };
  let providerStarted = false;
  runner.providerExecutableForRun = async () => { providerStarted = true; return "/nonexistent/claude"; };
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
  runner.warmAgents.set(busy.key, busy);
  const outputs: Array<{ text: string; activityStatus?: string }> = [];
  const controller = new AbortController();
  const participant = { id: "claude-settings", kind: "claude-code", label: "Claude" };
  const running = runner.runClaudeWarmOrOneShot(participant, "Hello", undefined, "chat", controller.signal, {
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
  assert.ok(runner.warmAgents.has("old-settings"));
  runner.warmAgents.clear();
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
  runner.handleClaudeWarmLine("not json", idle.participant, undefined, idle.state, idle.hooks);
  assert.equal(idle.flags.unusable, false);

  const busy = makeClaudeWarmHarness(runner, { lifecycle: true });
  const { rejected } = busy.addReply();
  busy.send({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started" });
  busy.send({ type: "system", subtype: "init" });
  runner.handleClaudeWarmLine("not json", busy.participant, undefined, busy.state, busy.hooks);
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
  assert.equal(turns.length, 1, "with nothing written, a step the CLI starts is its own");
});

test("host admission waits count as busy and a Stop during the wait never starts the provider", async () => {
  const runner = makeRunner();
  const participant = { id: "host-admission", kind: "codex-cli" as const, label: "Codex" };
  let admit!: (value: { admitted: true }) => void;
  runner.setHostAdmission(() => new Promise(resolve => { admit = resolve; }));
  let executions = 0;
  (runner as unknown as { runCodex(): Promise<unknown> }).runCodex = async () => { executions++; throw new Error("must not execute"); };
  const abort = new AbortController();
  const running = runner.run(participant, "held", undefined, undefined, "chat", abort.signal);
  assert.equal(runner.hasActiveNativeWork(), true);
  assert.equal(runner.fenceIdleNativeAdmissions(), undefined);
  abort.abort();
  admit({ admitted: true });
  const result = await running;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /cancelled before native execution/);
  assert.equal(executions, 0);
  assert.equal(runner.hasActiveNativeWork(), false);
  runner.setHostAdmission(async () => { throw new Error("coordination disk unavailable"); });
  assert.match((await runner.run(participant, "refused", undefined, undefined, "chat")).error ?? "", /coordination disk unavailable/);
  assert.equal(executions, 0);
});


test("shutdown waits for pre-spawn preparation and refuses its late provider creation", async () => {
  for (const kind of ["codex-cli", "claude-code"] as const) {
    const runner = makeRunner() as any;
    let release!: () => void;
    const preparing = new Promise<void>(resolve => { release = resolve; });
    runner.closeStaleWarmAgents = () => preparing;
    runner.codexExecutableForRun = async () => process.execPath;
    runner.providerExecutableForRun = async () => process.execPath;
    let constructed = 0;
    runner.constructCodexAppServerWarmAgent = async () => { constructed++; throw new Error("must not spawn"); };
    runner.constructClaudeWarmAgent = async () => { constructed++; throw new Error("must not spawn"); };
    const method = kind === "codex-cli" ? "runCodexAppServerWarmOrOneShot" : "runClaudeWarmOrOneShot";
    const args = [{ id: "held", label: "Held", kind }, "message", undefined,
      ...(kind === "codex-cli" ? [undefined] : []), "chat", undefined,
      { warm: { conversationId: "preparing", participantId: "held", contextKey: "test", idleTimeoutMs: 1000 } }];
    const running = runner[method](...args);
    assert.equal(runner.hasActiveNativeWork(), true);
    let closed = false;
    const closing = runner.shutdownWarmAgents().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false, "shutdown waits even though no provider creation has begun");
    release();
    const result = await running;
    await closing;
    assert.equal(result.ok, false);
    assert.equal(constructed, 0);
    assert.equal(runner.hasActiveNativeWork(), false);
  }
});

test("a host admission completing after shutdown cannot start its earlier command or compaction", async () => {
  for (const compact of [false, true]) {
    const runner = makeRunner() as any;
    let admit!: (value: { admitted: true }) => void;
    runner.setHostAdmission(() => new Promise(resolve => { admit = resolve; }));
    let executions = 0;
    runner.runCodex = runner.compactCodexSession = async () => { executions++; throw new Error("must not execute"); };
    const method = compact ? "compactSession" : "run";
    const participant = { id: "late", label: "Codex", kind: "codex-cli" };
    const pending = compact
      ? runner[method](participant, undefined, undefined, "chat", undefined, { sessionId: "session" })
      : runner[method](participant, "held", undefined, undefined, "chat");
    await runner.shutdownWarmAgents();
    admit({ admitted: true });
    const result = await pending;
    assert.equal(result.ok, false); assert.match(result.error, /shut down while/);
    assert.equal(executions, 0); assert.equal(runner.hasActiveNativeWork(), false);
  }
});
