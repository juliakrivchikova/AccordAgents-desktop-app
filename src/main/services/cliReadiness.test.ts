import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentHealth, ChatProviderKind, ProviderSettings } from "../../shared/types";
import {
  CLI_PROVIDER_SETUP,
  deriveAgentReadiness,
  isAgentSnapshotStale,
  readyProviderKinds,
  resolveAssistantProviderKind
} from "../../shared/cliReadiness";
import { CommandError, type CommandResult } from "./command";
import {
  classifyAntigravityAuth,
  classifyClaudeAuth,
  classifyCodexAuth,
  CliReadinessService,
  isCodexAccountReady,
  type CliReadinessDependencies
} from "./cliReadiness";

const PROVIDERS: ProviderSettings[] = [
  { kind: "gemini-cli", label: "Antigravity", enabled: true },
  { kind: "claude-code", label: "Claude Code", enabled: true },
  { kind: "codex-cli", label: "Codex", enabled: true }
];

test("readiness derivation follows the full normalized precedence table", () => {
  const base: AgentHealth = {
    kind: "codex-cli",
    label: "Codex",
    installed: true,
    detection: "detected",
    runnable: "ready",
    authentication: "ready"
  };
  const cases: Array<[string, AgentHealth | undefined, boolean, ReturnType<typeof deriveAgentReadiness>]> = [
    ["disabled wins", base, false, "disabled"],
    ["missing snapshot", undefined, true, "checking"],
    ["checking without facts", { kind: "codex-cli", label: "Codex", installed: false, checking: true }, true, "checking"],
    ["unknown detection", { ...base, detection: "unknown" }, true, "could-not-verify"],
    ["not detected", { ...base, detection: "not-detected" }, true, "not-detected"],
    ["failed version", { ...base, runnable: "failed" }, true, "failed-to-run"],
    ["unknown runnable", { ...base, runnable: "unknown" }, true, "could-not-verify"],
    ["auth required", { ...base, authentication: "required" }, true, "sign-in-required"],
    ["ready", base, true, "ready"],
    ["unknown auth", { ...base, authentication: "unknown" }, true, "could-not-verify"],
    ["legacy installed", { kind: "codex-cli", label: "Codex", installed: true }, true, "ready"],
    ["legacy missing", { kind: "codex-cli", label: "Codex", installed: false }, true, "not-detected"]
  ];
  for (const [label, health, enabled, expected] of cases) {
    assert.equal(deriveAgentReadiness(health, enabled), expected, label);
  }
});

test("readiness snapshot staleness uses the exact 30-second boundary", () => {
  const checkedAt = "2026-07-13T12:00:00.000Z";
  const snapshot = readyAgents(["codex-cli"]).map((health) => ({ ...health, lastCheckedAt: checkedAt }));
  assert.equal(isAgentSnapshotStale(snapshot, Date.parse(checkedAt) + 29_999), false);
  assert.equal(isAgentSnapshotStale(snapshot, Date.parse(checkedAt) + 30_000), true);
  assert.equal(isAgentSnapshotStale([]), true);
  assert.equal(isAgentSnapshotStale([{ ...snapshot[0], lastCheckedAt: undefined }]), true);
});

test("assistant resolution uses Codex, Claude, then Antigravity without using display order", () => {
  const agents = readyAgents(["gemini-cli", "claude-code", "codex-cli"]);
  assert.equal(resolveAssistantProviderKind({ agents, providers: PROVIDERS }), "codex-cli");
  assert.equal(resolveAssistantProviderKind({ agents, providers: PROVIDERS, explicitKind: "claude-code" }), "claude-code");
  assert.equal(resolveAssistantProviderKind({ agents: readyAgents(["codex-cli"]), providers: PROVIDERS, explicitKind: "claude-code" }), undefined);
  assert.equal(resolveAssistantProviderKind({ agents: readyAgents(["claude-code"]), providers: PROVIDERS }), "claude-code");
  assert.equal(resolveAssistantProviderKind({
    agents,
    providers: PROVIDERS.map((provider) => provider.kind === "codex-cli" ? { ...provider, enabled: false } : provider)
  }), "claude-code");
  assert.equal(resolveAssistantProviderKind({
    agents: readyAgents(["gemini-cli", "codex-cli"]),
    providers: PROVIDERS
  }), "codex-cli");
  assert.deepEqual(readyProviderKinds(agents, PROVIDERS), ["gemini-cli", "claude-code", "codex-cli"]);
});

test("provider auth fixtures classify ready, signed-out, malformed, offline, and timeout conservatively", () => {
  assert.deepEqual(classifyClaudeAuth(captured(true, JSON.stringify({
    loggedIn: true,
    email: "private@example.com",
    orgName: "Private Org"
  }))), { authentication: "ready", exitCode: 0 });
  assert.equal(classifyClaudeAuth(captured(false, JSON.stringify({ loggedIn: false }))).authentication, "required");
  assert.equal(classifyClaudeAuth(captured(false, "offline private@example.com")).authentication, "unknown");
  assert.equal(classifyClaudeAuth({ ...captured(false, ""), timedOut: true }).diagnosticCode, "probe-timeout");
  assert.equal(classifyCodexAuth(captured(true, "Logged in using ChatGPT")).authentication, "ready");
  assert.equal(classifyCodexAuth(captured(false, "Not logged in")).authentication, "required");
  assert.equal(classifyCodexAuth(captured(true, "Not logged in")).authentication, "unknown");
  assert.equal(classifyCodexAuth(captured(false, "Network error: unauthenticated upstream")).authentication, "unknown");
  assert.equal(classifyCodexAuth(captured(false, "Not logged in\nNetwork unavailable")).authentication, "unknown");
  assert.equal(classifyCodexAuth(captured(false, "Network unavailable")).authentication, "unknown");
  assert.equal(classifyCodexAuth({ ...captured(false, ""), timedOut: true }).diagnosticCode, "probe-timeout");
  assert.equal(classifyAntigravityAuth(captured(true, "gemini-2.5-pro")).authentication, "ready");
  assert.equal(classifyAntigravityAuth(captured(false, "Sign in as private@example.com")).authentication, "unknown");
  assert.equal(classifyAntigravityAuth({ ...captured(false, ""), timedOut: true }).diagnosticCode, "probe-timeout");
  assert.deepEqual(Object.keys(classifyClaudeAuth(captured(true, JSON.stringify({ loggedIn: true, email: "private@example.com" })))).sort(), ["authentication", "exitCode"]);
});

test("Codex account readiness follows the active provider contract", () => {
  assert.equal(isCodexAccountReady({ account: null, requiresOpenaiAuth: false }), true);
  assert.equal(isCodexAccountReady({ account: { email: "private@example.com" }, requiresOpenaiAuth: true }), true);
  assert.equal(isCodexAccountReady({ account: null, requiresOpenaiAuth: true }), false);
  assert.equal(isCodexAccountReady({ account: null }), false);
});

test("provider setup commands and official guides have one shared source", () => {
  assert.equal(CLI_PROVIDER_SETUP["claude-code"].loginCommand, "claude auth login");
  assert.match(CLI_PROVIDER_SETUP["codex-cli"].guideUrl, /^https:\/\//);
  assert.match(CLI_PROVIDER_SETUP["gemini-cli"].installCommandByPlatform.darwin ?? "", /^curl /);
  assert.equal(Object.hasOwn(CLI_PROVIDER_SETUP["codex-cli"].installCommandByPlatform, "linux"), false);
});

test("environment, lookup, and version failures produce distinct normalized facts", async () => {
  const environmentFailure = new CliReadinessService(undefined, fakeDependencies({
    refreshEnvironment: async () => ({ ok: false, env: {} })
  }));
  const environmentSnapshot = await environmentFailure.refresh({ force: true });
  assert.ok(environmentSnapshot.every((health) => health.detection === "unknown" && health.diagnosticCode === "environment-check-failed"));

  const lookupFailure = new CliReadinessService(undefined, fakeDependencies({
    lookup: async () => ({ status: "unknown", timedOut: true })
  }));
  const lookupSnapshot = await lookupFailure.refresh({ force: true });
  assert.ok(lookupSnapshot.every((health) => health.detection === "unknown" && health.diagnosticCode === "probe-timeout"));

  let authCalls = 0;
  const versionFailure = new CliReadinessService(undefined, fakeDependencies({
    lookup: async (command) => command === "codex"
      ? { status: "found", path: "/private/bin/codex" }
      : { status: "not-found" },
    run: async (command, args) => {
      if (args.includes("--version")) {
        throw failedCommand(command, args, false);
      }
      authCalls += 1;
      return successfulCommand(command, args);
    }
  }));
  const versionSnapshot = await versionFailure.refresh({ force: true });
  const codex = versionSnapshot.find((health) => health.kind === "codex-cli");
  assert.equal(codex?.runnable, "failed");
  assert.equal(codex?.diagnosticCode, "failed-to-run");
  assert.equal(authCalls, 0, "authentication must not run after a version failure");
});

test("readiness runs version and authentication probes through each resolved executable", async () => {
  const resolvedPaths: Record<string, string> = {
    claude: "C:\\Program Files\\Anthropic\\claude.exe",
    codex: "C:\\Program Files\\OpenAI\\codex.exe",
    agy: "C:\\Program Files\\Google\\agy.exe"
  };
  const runs: Array<{ command: string; args: string[] }> = [];
  const service = new CliReadinessService(undefined, fakeDependencies({
    lookup: async (command) => ({ status: "found", path: resolvedPaths[command] }),
    run: async (command, args) => {
      runs.push({ command, args });
      if (args.includes("--version")) {
        return successfulCommand(command, args);
      }
      if (args.join(" ") === "auth status") {
        return { ...successfulCommand(command, args), stdout: JSON.stringify({ loggedIn: true }) };
      }
      if (args.join(" ") === "login status") {
        return { ...successfulCommand(command, args), stdout: "Logged in using ChatGPT" };
      }
      return { ...successfulCommand(command, args), stdout: "gemini-2.5-pro" };
    }
  }));

  const snapshot = await service.refresh({ force: true });

  assert.ok(snapshot.every((health) => health.runnable === "ready" && health.authentication === "ready"));
  assert.deepEqual(runs, [
    { command: resolvedPaths.agy, args: ["--version"] },
    { command: resolvedPaths.claude, args: ["--version"] },
    { command: resolvedPaths.codex, args: ["--version"] },
    { command: resolvedPaths.agy, args: ["models"] },
    { command: resolvedPaths.claude, args: ["auth", "status"] },
    { command: resolvedPaths.codex, args: ["login", "status"] }
  ]);
});

test("Codex readiness falls back to app-server when login status reports not logged in", async () => {
  const accountProbes: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
  const service = new CliReadinessService(undefined, fakeDependencies({
    refreshEnvironment: async () => ({ ok: true, env: { PATH: "/login/bin" } }),
    manualEnvironment: async () => ({ CODEX_HOME: "/private/codex-home" }),
    lookup: async (command) => ({ status: "found", path: `/private/bin/${command}` }),
    run: async (command, args) => {
      if (command === "/private/bin/codex" && args.join(" ") === "login status") {
        throw new CommandError("Not logged in", {
          command,
          args,
          stdout: "",
          stderr: "Not logged in",
          exitCode: 1,
          timedOut: false
        });
      }
      return successfulCommand(command, args);
    },
    codexAccountReady: async (command, env) => {
      accountProbes.push({ command, env: { ...env } });
      return isCodexAccountReady({ account: null, requiresOpenaiAuth: false });
    }
  }));

  const snapshot = await service.refresh({ force: true, trigger: "manual" });
  const codex = snapshot.find((health) => health.kind === "codex-cli");

  assert.equal(codex?.authentication, "ready");
  assert.equal(accountProbes.length, 1);
  assert.equal(accountProbes[0]?.command, "/private/bin/codex");
  assert.equal(accountProbes[0]?.env.PATH, "/login/bin");
  assert.equal(accountProbes[0]?.env.CODEX_HOME, "/private/codex-home");
});

test("the real Codex account probe accepts a provider that does not require OpenAI sign-in", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake app-server launcher is a POSIX shell script");
    return;
  }
  const fake = await fakeCodexAppServer(t, "ready");
  const snapshot = await codexSignedOutService(fake).refresh({ force: true, trigger: "manual" });
  const codex = snapshot.find((health) => health.kind === "codex-cli");

  assert.equal(codex?.authentication, "ready");
  assert.equal(codex?.diagnosticCode, undefined);
  const requests = await fake.requests();
  assert.deepEqual(requests.map((request) => [request.method, request.id]), [["initialize", 1], ["account/read", 2]]);
  const initialize = requests[0]?.params as { clientInfo?: { name?: string }; capabilities?: { experimentalApi?: boolean } };
  assert.equal(initialize.clientInfo?.name, "accordagents");
  assert.equal(initialize.capabilities?.experimentalApi, true);
  assert.deepEqual(requests[1]?.params, { refreshToken: false });
  await fake.assertTerminated();
});

test("the real Codex account probe keeps sign-in required when the provider needs OpenAI auth", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake app-server launcher is a POSIX shell script");
    return;
  }
  const fake = await fakeCodexAppServer(t, "signed-out");
  const snapshot = await codexSignedOutService(fake).refresh({ force: true, trigger: "manual" });
  const codex = snapshot.find((health) => health.kind === "codex-cli");

  assert.equal(codex?.authentication, "required");
  assert.equal(codex?.diagnosticCode, "auth-required");
  assert.equal((await fake.requests()).length, 2);
  await fake.assertTerminated();
});

test("the real Codex account probe keeps sign-in required when app-server exits before answering", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake app-server launcher is a POSIX shell script");
    return;
  }
  const fake = await fakeCodexAppServer(t, "exit");
  const startedAt = Date.now();
  const snapshot = await codexSignedOutService(fake).refresh({ force: true, trigger: "manual" });
  const codex = snapshot.find((health) => health.kind === "codex-cli");

  assert.equal(codex?.authentication, "required");
  assert.equal(codex?.diagnosticCode, "auth-required");
  assert.ok(Date.now() - startedAt < 5_000, "an exited app-server must settle the probe without waiting for the timeout");
  await fake.assertTerminated();
});

test("the real Codex account probe times out, keeps sign-in required, and kills the app-server process tree", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake app-server launcher is a POSIX shell script");
    return;
  }
  const fake = await fakeCodexAppServer(t, "timeout");
  const startedAt = Date.now();
  const snapshot = await codexSignedOutService(fake).refresh({ force: true, trigger: "manual" });
  const codex = snapshot.find((health) => health.kind === "codex-cli");

  assert.equal(codex?.authentication, "required");
  assert.equal(codex?.diagnosticCode, "auth-required");
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 7_500 && elapsedMs < 12_000, `expected the 8s probe timeout, took ${elapsedMs}ms`);
  assert.equal((await fake.pids()).length, 2, "the fake app-server must have started its helper child");
  await fake.assertTerminated();
});

test("a shared environment failure preserves the last complete readiness snapshot", async () => {
  let refreshCalls = 0;
  const checkedAt = [
    new Date("2026-07-16T20:00:00.000Z"),
    new Date("2026-07-16T20:01:00.000Z")
  ];
  const service = new CliReadinessService(undefined, fakeDependencies({
    refreshEnvironment: async () => {
      refreshCalls += 1;
      return refreshCalls === 1
        ? { ok: true, env: { PATH: "/fixture/bin" } }
        : { ok: false, env: {} };
    },
    now: () => checkedAt.shift() ?? new Date("2026-07-16T20:02:00.000Z")
  }));

  const healthy = await service.refresh({ force: true, trigger: "manual" });
  const afterFailure = await service.refresh({ force: true, trigger: "submit" });

  assert.ok(healthy.every((health) => health.detection === "detected" && health.authentication === "ready"));
  assert.deepEqual(afterFailure, healthy, "a failed shared prerequisite must not demote runnable providers");
  assert.ok(afterFailure.every((health) => health.lastCheckedAt === "2026-07-16T20:00:00.000Z"));
});

test("readiness probes use the same filtered manual environment as local agent runs", async () => {
  const observed: NodeJS.ProcessEnv[] = [];
  const service = new CliReadinessService(undefined, fakeDependencies({
    refreshEnvironment: async () => ({ ok: true, env: { PATH: "/login/bin", SHARED: "login" } }),
    manualEnvironment: async () => ({ OPENAI_API_KEY: "manual-secret", SHARED: "manual" }),
    lookup: async (command, env) => {
      observed.push({ ...env });
      return { status: "found", path: `/fixture/bin/${command}` };
    },
    run: async (command, args, options) => {
      observed.push({ ...options?.env });
      return successfulCommand(command, args);
    }
  }));

  const snapshot = await service.refresh({ force: true, trigger: "manual" });

  assert.ok(snapshot.every((health) => health.authentication === "ready"));
  assert.ok(observed.every((env) => env.PATH === "/login/bin"));
  assert.ok(observed.every((env) => env.OPENAI_API_KEY === "manual-secret"));
  assert.ok(observed.every((env) => env.SHARED === "manual"));
  assert.equal(JSON.stringify(snapshot).includes("manual-secret"), false);
});

test("renderer snapshots and logs exclude raw output, account fields, arbitrary versions, and executable paths", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const privateValues = ["private@example.com", "Private Org", "/Users/private/bin/claude", "arbitrary-secret-version-text"];
  const service = new CliReadinessService({
    write: async (_event, payload) => { logs.push(payload); }
  }, fakeDependencies({
    lookup: async (command) => ({ status: "found", path: `/Users/private/bin/${command}` }),
    run: async (command, args) => {
      if (args.includes("--version")) {
        return {
          ...successfulCommand(command, args),
          stdout: `arbitrary-secret-version-text private@example.com ${command} 12.34.56 /Users/private/bin/${command}`
        };
      }
      if (command === "claude") {
        return { ...successfulCommand(command, args), stdout: JSON.stringify({ loggedIn: true, email: "private@example.com", orgName: "Private Org" }) };
      }
      return successfulCommand(command, args);
    }
  }));

  const snapshot = await service.refresh({ force: true, trigger: "manual" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(snapshot.every((health) => health.version === "12.34.56"));
  const serialized = JSON.stringify({ snapshot, logs });
  for (const value of privateValues) {
    assert.equal(serialized.includes(value), false, value);
  }
  assert.ok(logs.every((payload) => Object.keys(payload).every((key) => ["kind", "diagnosticCode", "exitCode", "durationMs", "generation", "trigger"].includes(key))));
});

test("concurrent refreshes coalesce into one probe batch", async () => {
  let environmentCalls = 0;
  let commandCalls = 0;
  const service = new CliReadinessService(undefined, fakeDependencies({
    refreshEnvironment: async () => {
      environmentCalls += 1;
      return { ok: true, env: { PATH: "/fixture/bin" } };
    },
    run: async (command, args) => {
      commandCalls += 1;
      return successfulCommand(command, args);
    }
  }));

  const [first, second] = await Promise.all([
    service.refresh({ force: true, trigger: "focus" }),
    service.refresh({ force: true, trigger: "manual" })
  ]);
  assert.equal(environmentCalls, 1);
  assert.equal(commandCalls, 6);
  assert.deepEqual(first, second);
  assert.ok(first.every((health) => health.authentication === "ready" && health.generation === 1));

  await service.refresh();
  assert.equal(environmentCalls, 1, "fresh snapshots should be cached");
  await service.refresh({ force: true, trigger: "manual" });
  assert.equal(environmentCalls, 2, "forced refresh must bypass the fresh cache");
});

test("invalidated in-flight generation cannot overwrite a newer refresh", async () => {
  const firstEnvironment = deferred<{ ok: true; env: NodeJS.ProcessEnv }>();
  const secondEnvironment = deferred<{ ok: true; env: NodeJS.ProcessEnv }>();
  const environments = [firstEnvironment, secondEnvironment];
  const service = new CliReadinessService(undefined, fakeDependencies({
    refreshEnvironment: () => {
      const next = environments.shift();
      assert.ok(next);
      return next.promise;
    }
  }));

  const older = service.refresh({ force: true, trigger: "focus" });
  service.invalidate();
  const newer = service.refresh({ force: true, trigger: "provider-enabled" });
  firstEnvironment.resolve({ ok: true, env: { PATH: "/old" } });
  await new Promise((resolve) => setImmediate(resolve));
  secondEnvironment.resolve({ ok: true, env: { PATH: "/new" } });

  const [olderResult, newerResult] = await Promise.all([older, newer]);
  assert.ok(olderResult.every((health) => health.generation === 2));
  assert.ok(newerResult.every((health) => health.generation === 2));
  assert.ok(service.currentSnapshot().every((health) => health.generation === 2));
});

function fakeDependencies(overrides: Partial<CliReadinessDependencies> = {}): Partial<CliReadinessDependencies> {
  return {
    refreshEnvironment: async () => ({ ok: true, env: { PATH: "/fixture/bin" } }),
    manualEnvironment: async () => ({}),
    lookup: async (command) => ({ status: "found", path: `/fixture/bin/${command}` }),
    run: async (command, args) => successfulCommand(command, args),
    now: () => new Date(),
    ...overrides
  };
}

function successfulCommand(command: string, args: string[]): CommandResult {
  const executable = command.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  const authOutput = executable === "claude"
    ? JSON.stringify({ loggedIn: true })
    : executable === "codex"
      ? "Logged in using ChatGPT"
      : executable === "agy"
        ? "gemini-2.5-pro"
        : "";
  return {
    command,
    args,
    stdout: args.includes("--version") ? `${command} 1.0.0` : authOutput,
    stderr: "",
    exitCode: 0,
    timedOut: false
  };
}

function failedCommand(command: string, args: string[], timedOut: boolean): CommandError {
  const result: CommandResult = {
    command,
    args,
    stdout: "private@example.com",
    stderr: "/Users/private/provider-error",
    exitCode: timedOut ? null : 1,
    timedOut
  };
  return new CommandError("provider command failed", result);
}

function captured(ok: boolean, stdout: string) {
  return { ok, stdout, stderr: "", exitCode: ok ? 0 : 1, timedOut: false };
}

function readyAgents(kinds: ChatProviderKind[]): AgentHealth[] {
  return kinds.map((kind) => ({
    kind,
    label: kind,
    installed: true,
    detection: "detected",
    runnable: "ready",
    authentication: "ready"
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type FakeCodexAppServerMode = "ready" | "signed-out" | "exit" | "timeout";

interface FakeCodexAppServer {
  executablePath: string;
  environment: NodeJS.ProcessEnv;
  requests: () => Promise<Array<{ method?: string; id?: number; params?: unknown }>>;
  pids: () => Promise<number[]>;
  assertTerminated: () => Promise<void>;
}

/**
 * Speaks just enough of the Codex app-server stdio protocol to drive the real
 * account probe: it answers `initialize` (after a notification and a server
 * request that reuse id 1) and then `account/read` according to the mode. Like
 * the real server it stays alive after stdin closes, so a finished probe must
 * terminate it; the `timeout` mode also starts a helper child to prove the whole
 * process tree goes away.
 */
const fakeCodexAppServerScript = [
  "const fs = require('node:fs');",
  "const { spawn } = require('node:child_process');",
  "const mode = process.env.FAKE_CODEX_APP_SERVER_MODE;",
  "const pids = [process.pid];",
  "if (mode === 'timeout') {",
  "  pids.push(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid);",
  "}",
  "fs.writeFileSync(process.env.FAKE_CODEX_APP_SERVER_PIDS, pids.join('\\n'));",
  "process.stdout.on('error', () => {});",
  "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  let lineBreak = buffer.indexOf('\\n');",
  "  while (lineBreak >= 0) {",
  "    const line = buffer.slice(0, lineBreak);",
  "    buffer = buffer.slice(lineBreak + 1);",
  "    lineBreak = buffer.indexOf('\\n');",
  "    if (!line) continue;",
  "    fs.appendFileSync(process.env.FAKE_CODEX_APP_SERVER_LOG, line + '\\n');",
  "    const request = JSON.parse(line);",
  "    if (request.method === 'initialize') {",
  "      send({ method: 'remoteControl/status/changed', params: { status: 'disabled' } });",
  "      send({ method: 'currentTime/read', id: 1, params: {} });",
  "      send({ id: request.id, result: { userAgent: 'fake-codex' } });",
  "    } else if (request.method === 'account/read') {",
  "      if (mode === 'ready') send({ id: request.id, result: { account: null, requiresOpenaiAuth: false } });",
  "      else if (mode === 'signed-out') send({ id: request.id, result: { account: null, requiresOpenaiAuth: true } });",
  "      else if (mode === 'exit') process.exit(0);",
  "    }",
  "  }",
  "});",
  "process.stdin.on('end', () => {});",
  "setInterval(() => {}, 1000);"
].join("\n");

async function fakeCodexAppServer(t: TestContext, mode: FakeCodexAppServerMode): Promise<FakeCodexAppServer> {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-fake-codex-"));
  const scriptPath = path.join(root, "app-server.js");
  const executablePath = path.join(root, "codex");
  const logPath = path.join(root, "requests.jsonl");
  const pidsPath = path.join(root, "pids.txt");
  await writeFile(scriptPath, fakeCodexAppServerScript);
  await writeFile(executablePath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`);
  await chmod(executablePath, 0o755);
  const pids = async (): Promise<number[]> => (await readFile(pidsPath, "utf8").catch(() => ""))
    .split("\n")
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  t.after(async () => {
    // A probe regression that leaks the server would otherwise keep the test
    // process alive forever instead of reporting the failed assertion.
    for (const pid of (await pids()).filter(processExists)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    executablePath,
    environment: {
      FAKE_CODEX_APP_SERVER_MODE: mode,
      FAKE_CODEX_APP_SERVER_LOG: logPath,
      FAKE_CODEX_APP_SERVER_PIDS: pidsPath
    },
    requests: async () => (await readFile(logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; id?: number; params?: unknown }),
    pids,
    assertTerminated: async () => {
      const started = await pids();
      assert.ok(started.length > 0, "the fake app-server must have recorded its pid");
      for (let attempt = 0; attempt < 60 && started.some(processExists); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.deepEqual(started.filter(processExists), [], "the finished probe must leave no app-server process behind");
    }
  };
}

/** Readiness service whose `codex login status` reports "Not logged in", so the real app-server probe runs. */
function codexSignedOutService(fake: FakeCodexAppServer): CliReadinessService {
  return new CliReadinessService(undefined, fakeDependencies({
    manualEnvironment: async () => fake.environment,
    lookup: async (command) => command === "codex"
      ? { status: "found", path: fake.executablePath }
      : { status: "not-found" },
    run: async (command, args) => {
      if (command === fake.executablePath && args.join(" ") === "login status") {
        throw new CommandError("Not logged in", {
          command,
          args,
          stdout: "",
          stderr: "Not logged in",
          exitCode: 1,
          timedOut: false
        });
      }
      return successfulCommand(command, args);
    }
  }));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
