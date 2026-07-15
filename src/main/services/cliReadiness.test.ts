import assert from "node:assert/strict";
import test from "node:test";

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

test("readiness probes use the same filtered manual environment as local agent runs", async () => {
  const observed: NodeJS.ProcessEnv[] = [];
  const service = new CliReadinessService(undefined, fakeDependencies({
    refreshEnvironment: async () => ({ ok: true, env: { PATH: "/login/bin", SHARED: "login" } }),
    manualEnvironment: async () => ({ OPENAI_API_KEY: "manual-secret", SHARED: "manual" }),
    lookup: async (_command, env) => {
      observed.push({ ...env });
      return { status: "found", path: "/fixture/bin/provider" };
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
  const authOutput = command === "claude"
    ? JSON.stringify({ loggedIn: true })
    : command === "codex"
      ? "Logged in using ChatGPT"
      : command === "agy"
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
