import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AgentAuthenticationState,
  AgentDetectionRequest,
  AgentHealth,
  AgentReadinessDiagnosticCode,
  ChatProviderKind
} from "../../shared/types";
import {
  CLI_PROVIDER_DISPLAY_ORDER,
  CLI_PROVIDER_SETUP,
  isAgentSnapshotStale,
  type CliProviderSetupMetadata
} from "../../shared/cliReadiness";
import {
  CommandError,
  commandEnvironment,
  lookupCommand,
  refreshLoginShellEnv,
  runCommand,
  spawnCommand
} from "./command";
import { terminateProcess } from "./processTermination";

const READINESS_PROBE_TIMEOUT_MS = 8_000;

interface ReadinessDebugLogger {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

interface InFlightReadiness {
  generation: number;
  promise: Promise<AgentHealth[]>;
}

export interface AuthClassification {
  authentication: AgentAuthenticationState;
  diagnosticCode?: AgentReadinessDiagnosticCode;
  exitCode?: number | null;
}

export interface CliReadinessCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface CliReadinessDependencies {
  refreshEnvironment: typeof refreshLoginShellEnv;
  manualEnvironment: () => Promise<NodeJS.ProcessEnv>;
  lookup: typeof lookupCommand;
  run: typeof runCommand;
  codexAccountReady: typeof probeCodexAccountReady;
  now: () => Date;
}

export class CliReadinessService {
  private generation = 1;
  private stableSnapshot: AgentHealth[] = [];
  private inFlight?: InFlightReadiness;

  private readonly dependencies: CliReadinessDependencies;

  constructor(
    private readonly debugLogs?: ReadinessDebugLogger,
    dependencies: Partial<CliReadinessDependencies> = {}
  ) {
    this.dependencies = {
      refreshEnvironment: dependencies.refreshEnvironment ?? refreshLoginShellEnv,
      manualEnvironment: dependencies.manualEnvironment ?? (async () => ({})),
      lookup: dependencies.lookup ?? lookupCommand,
      run: dependencies.run ?? runCommand,
      codexAccountReady: dependencies.codexAccountReady ?? probeCodexAccountReady,
      now: dependencies.now ?? (() => new Date())
    };
  }

  currentSnapshot(): AgentHealth[] {
    return this.clone(this.stableSnapshot);
  }

  invalidate(): number {
    this.generation += 1;
    this.stableSnapshot = this.stableSnapshot.map((health) => ({
      ...health,
      checking: false,
      generation: this.generation
    }));
    return this.generation;
  }

  async refresh(request: AgentDetectionRequest = {}): Promise<AgentHealth[]> {
    if (!request.force && !isAgentSnapshotStale(this.stableSnapshot)) {
      return this.currentSnapshot();
    }
    const generation = this.generation;
    if (this.inFlight?.generation === generation) {
      return this.inFlight.promise;
    }

    const promise = this.runBatch(generation, request.trigger ?? "service")
      .then(async (result) => {
        if (generation === this.generation) {
          this.stableSnapshot = result;
          return this.currentSnapshot();
        }
        const newer = this.inFlight;
        if (newer && newer.generation === this.generation) {
          return newer.promise;
        }
        return this.currentSnapshot();
      })
      .finally(() => {
        if (this.inFlight?.promise === promise) {
          this.inFlight = undefined;
        }
      });
    this.inFlight = { generation, promise };
    return promise;
  }

  private async runBatch(generation: number, trigger: NonNullable<AgentDetectionRequest["trigger"]>): Promise<AgentHealth[]> {
    const environment = await this.dependencies.refreshEnvironment();
    const checkedAt = this.dependencies.now().toISOString();
    if (!environment.ok) {
      return this.sharedFailureSnapshot(checkedAt, generation);
    }
    let manualEnvironment: NodeJS.ProcessEnv;
    try {
      manualEnvironment = await this.dependencies.manualEnvironment();
    } catch {
      return this.sharedFailureSnapshot(checkedAt, generation);
    }
    const effectiveEnvironment = {
      ...environment.env,
      ...manualEnvironment
    };
    return Promise.all(CLI_PROVIDER_DISPLAY_ORDER.map((kind) =>
      this.probeProvider(CLI_PROVIDER_SETUP[kind], effectiveEnvironment, checkedAt, generation, trigger)
    ));
  }

  private async probeProvider(
    metadata: CliProviderSetupMetadata,
    env: NodeJS.ProcessEnv,
    checkedAt: string,
    generation: number,
    trigger: NonNullable<AgentDetectionRequest["trigger"]>
  ): Promise<AgentHealth> {
    const startedAt = Date.now();
    const lookup = await this.dependencies.lookup(metadata.executable, env);
    if (lookup.status === "unknown") {
      const health = this.health(metadata.kind, checkedAt, generation, {
        detection: "unknown",
        runnable: "unknown",
        authentication: "unknown",
        installed: false,
        diagnosticCode: lookup.timedOut ? "probe-timeout" : "environment-check-failed"
      });
      this.logProbe(health, trigger, startedAt);
      return health;
    }
    if (lookup.status === "not-found") {
      const health = this.health(metadata.kind, checkedAt, generation, {
        detection: "not-detected",
        runnable: "unknown",
        authentication: "unknown",
        installed: false,
        diagnosticCode: "not-detected"
      });
      this.logProbe(health, trigger, startedAt);
      return health;
    }
    if (!lookup.path) {
      const health = this.health(metadata.kind, checkedAt, generation, {
        detection: "unknown",
        runnable: "unknown",
        authentication: "unknown",
        installed: false,
        diagnosticCode: "environment-check-failed"
      });
      this.logProbe(health, trigger, startedAt);
      return health;
    }

    const executablePath = lookup.path;

    let version: string | undefined;
    try {
      const result = await this.dependencies.run(executablePath, metadata.versionArgs, {
        env,
        killProcessGroup: true,
        primeLoginShellEnv: false,
        timeoutMs: READINESS_PROBE_TIMEOUT_MS
      });
      version = sanitizeVersion(result.stdout);
    } catch (error) {
      const health = this.health(metadata.kind, checkedAt, generation, {
        detection: "detected",
        runnable: "failed",
        authentication: "unknown",
        installed: true,
        diagnosticCode: commandTimedOut(error) ? "probe-timeout" : "failed-to-run"
      });
      this.logProbe(health, trigger, startedAt, commandExitCode(error));
      return health;
    }

    const auth = await this.probeAuthentication(metadata, executablePath, env);
    const health = this.health(metadata.kind, checkedAt, generation, {
      detection: "detected",
      runnable: "ready",
      authentication: auth.authentication,
      installed: true,
      diagnosticCode: auth.diagnosticCode,
      version
    });
    this.logProbe(health, trigger, startedAt, auth.exitCode);
    return health;
  }

  private async probeAuthentication(
    metadata: CliProviderSetupMetadata,
    executablePath: string,
    env: NodeJS.ProcessEnv
  ): Promise<AuthClassification> {
    if (metadata.probeStrategy === "claude-auth-status") {
      return classifyClaudeAuth(await this.captureCommand(executablePath, ["auth", "status"], env));
    }
    if (metadata.probeStrategy === "codex-login-status") {
      const auth = classifyCodexAuth(await this.captureCommand(executablePath, ["login", "status"], env));
      if (auth.authentication !== "required") {
        return auth;
      }
      try {
        return await this.dependencies.codexAccountReady(executablePath, env)
          ? { authentication: "ready" }
          : auth;
      } catch {
        return auth;
      }
    }
    return classifyAntigravityAuth(await this.captureCommand(executablePath, ["models"], env));
  }

  private async captureCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<CliReadinessCommandResult> {
    try {
      const result = await this.dependencies.run(command, args, {
        env,
        killProcessGroup: true,
        primeLoginShellEnv: false,
        timeoutMs: READINESS_PROBE_TIMEOUT_MS
      });
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof CommandError) {
        return { ok: false, ...error.result };
      }
      return { ok: false, stdout: "", stderr: "", exitCode: null, timedOut: false };
    }
  }

  private health(
    kind: ChatProviderKind,
    lastCheckedAt: string,
    generation: number,
    facts: Pick<AgentHealth, "detection" | "runnable" | "authentication" | "installed"> &
      Partial<Pick<AgentHealth, "diagnosticCode" | "version">>
  ): AgentHealth {
    return {
      kind,
      label: CLI_PROVIDER_SETUP[kind].label,
      installed: facts.installed,
      detection: facts.detection,
      runnable: facts.runnable,
      authentication: facts.authentication,
      diagnosticCode: facts.diagnosticCode,
      version: facts.version,
      checking: false,
      lastCheckedAt,
      generation,
      platform: normalizedPlatform(process.platform)
    };
  }

  private sharedFailureSnapshot(checkedAt: string, generation: number): AgentHealth[] {
    const previousByKind = new Map(this.stableSnapshot.map((health) => [health.kind, health]));
    if (CLI_PROVIDER_DISPLAY_ORDER.every((kind) => previousByKind.has(kind))) {
      return CLI_PROVIDER_DISPLAY_ORDER.map((kind) => ({
        ...previousByKind.get(kind)!,
        checking: false,
        generation
      }));
    }
    return CLI_PROVIDER_DISPLAY_ORDER.map((kind) => this.health(kind, checkedAt, generation, {
      detection: "unknown",
      runnable: "unknown",
      authentication: "unknown",
      installed: false,
      diagnosticCode: "environment-check-failed"
    }));
  }

  private logProbe(
    health: AgentHealth,
    trigger: NonNullable<AgentDetectionRequest["trigger"]>,
    startedAt: number,
    exitCode?: number | null
  ): void {
    void this.debugLogs?.write("cli-readiness.probe", {
      kind: health.kind,
      diagnosticCode: health.diagnosticCode ?? (health.authentication === "ready" ? "ready" : "auth-check-failed"),
      exitCode: exitCode ?? null,
      durationMs: Math.max(0, Date.now() - startedAt),
      generation: health.generation,
      trigger
    }).catch(() => undefined);
  }

  private clone(value: AgentHealth[]): AgentHealth[] {
    return value.map((health) => ({
      ...health,
      appSkillSync: health.appSkillSync ? { ...health.appSkillSync } : undefined
    }));
  }
}

export function classifyClaudeAuth(result: CliReadinessCommandResult): AuthClassification {
  if (result.timedOut) {
    return { authentication: "unknown", diagnosticCode: "probe-timeout", exitCode: result.exitCode };
  }
  const record = parseJsonObject(result.stdout);
  if (record?.loggedIn === true) {
    return { authentication: "ready", exitCode: result.exitCode };
  }
  if (record?.loggedIn === false) {
    return { authentication: "required", diagnosticCode: "auth-required", exitCode: result.exitCode };
  }
  return { authentication: "unknown", diagnosticCode: "auth-check-failed", exitCode: result.exitCode };
}

export function classifyCodexAuth(result: CliReadinessCommandResult): AuthClassification {
  if (result.timedOut) {
    return { authentication: "unknown", diagnosticCode: "probe-timeout", exitCode: result.exitCode };
  }
  const outputLines = [result.stdout, result.stderr]
    .flatMap((value) => value.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
  if (result.exitCode === 1 && outputLines.length === 1 && outputLines[0] === "Not logged in") {
    return { authentication: "required", diagnosticCode: "auth-required", exitCode: result.exitCode };
  }
  if (result.ok && outputLines.some((line) => /^Logged in(?:\s|$)/.test(line))) {
    return { authentication: "ready", exitCode: result.exitCode };
  }
  return { authentication: "unknown", diagnosticCode: "auth-check-failed", exitCode: result.exitCode };
}

/** Returns whether the active Codex provider has an account or does not require OpenAI authentication. */
export function isCodexAccountReady(value: unknown): boolean {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  return record?.requiresOpenaiAuth === false
    || Boolean(record?.account && typeof record.account === "object" && !Array.isArray(record.account));
}

/** Stores mutable state that must remain isolated to one Codex account probe. */
interface CodexAccountProbeContext {
  child: ChildProcessWithoutNullStreams;
  useProcessGroup: boolean;
  resolve: (ready: boolean) => void;
  buffer: string;
  initialized: boolean;
  settled: boolean;
  timeout?: NodeJS.Timeout;
  forceKillTimeout?: NodeJS.Timeout;
}

/**
 * Fallback probe for a Codex provider whose login status reports no ChatGPT session:
 * 1. Start the resolved Codex executable with the effective environment.
 * 2. Complete the app-server `initialize` JSON-RPC handshake.
 * 3. Request `account/read` without refreshing or changing credentials.
 * 4. Treat an account or `requiresOpenaiAuth: false` as ready.
 * 5. Resolve once and clean up the entire process tree on every exit path.
 */
async function probeCodexAccountReady(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => startCodexAccountProbe(command, env, resolve));
}

/** Spawns Codex app-server, installs every lifecycle handler, and starts the handshake. */
function startCodexAccountProbe(
  command: string,
  env: NodeJS.ProcessEnv,
  resolve: (ready: boolean) => void
): void {
  // npm-installed Codex launches a native child, so use a process group on POSIX.
  const useProcessGroup = process.platform !== "win32";
  const child = spawnCommand(command, ["app-server", "--listen", "stdio://"], {
    detached: useProcessGroup,
    env: commandEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const context: CodexAccountProbeContext = {
    child,
    useProcessGroup,
    resolve,
    buffer: "",
    initialized: false,
    settled: false
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => handleCodexAccountProbeOutput(context, chunk));
  // Drain diagnostics without making provider output part of the readiness result.
  child.stderr.resume();
  child.stdin.once("error", () => finishCodexAccountProbe(context, false));
  child.once("error", () => finishCodexAccountProbe(context, false));
  child.once("close", () => closeCodexAccountProbe(context));
  // Bound the probe even if the app-server never answers.
  context.timeout = setTimeout(finishCodexAccountProbe, READINESS_PROBE_TIMEOUT_MS, context, false);
  initializeCodexAccountProbe(context);
}

/** Terminates the launcher and its descendants, preferring the POSIX process group. */
function terminateCodexAccountProbe(context: CodexAccountProbeContext, signal: NodeJS.Signals): void {
  // Kill the launcher and its native Codex descendants together.
  if (context.useProcessGroup && context.child.pid) {
    try {
      process.kill(-context.child.pid, signal);
      return;
    } catch {
      if (context.child.exitCode !== null || context.child.signalCode !== null) {
        return;
      }
    }
  }
  terminateProcess(context.child, signal, true);
}

/** Escalates cleanup to SIGKILL when the launcher or its POSIX descendants may remain alive. */
function forceKillCodexAccountProbe(context: CodexAccountProbeContext): void {
  if (context.useProcessGroup || (context.child.exitCode === null && context.child.signalCode === null)) {
    terminateCodexAccountProbe(context, "SIGKILL");
  }
}

/** Settles the probe once, closes its streams, and schedules process-tree cleanup. */
function finishCodexAccountProbe(context: CodexAccountProbeContext, ready: boolean): void {
  // Response, error, close, and timeout paths must settle exactly once.
  if (context.settled) {
    return;
  }
  context.settled = true;
  if (context.timeout) {
    clearTimeout(context.timeout);
  }
  // Release all pipes before terminating the process to avoid hanging handles.
  context.child.stdin.destroy();
  context.child.stdout.destroy();
  context.child.stderr.destroy();
  if (context.child.exitCode === null && context.child.signalCode === null) {
    terminateCodexAccountProbe(context, "SIGTERM");
    context.forceKillTimeout = setTimeout(forceKillCodexAccountProbe, 1_500, context).unref();
  }
  context.resolve(ready);
}

/** Writes one JSONL request and fails the probe if stdin rejects the write. */
function sendCodexAccountProbeMessage(
  context: CodexAccountProbeContext,
  message: Record<string, unknown>
): void {
  // Codex app-server uses newline-delimited JSON and needs stdin left open.
  context.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
    if (error) {
      finishCodexAccountProbe(context, false);
    }
  });
}

/** Buffers stdout chunks and routes initialize and account responses in protocol order. */
function handleCodexAccountProbeOutput(context: CodexAccountProbeContext, chunk: string): void {
  // Stream chunks can split JSON messages, so parse only complete lines.
  context.buffer += chunk;
  let lineBreak = context.buffer.indexOf("\n");
  while (lineBreak >= 0) {
    const record = parseJsonObject(context.buffer.slice(0, lineBreak));
    context.buffer = context.buffer.slice(lineBreak + 1);
    // Notifications and server requests may also have ids; handle only our responses.
    if (!record?.method && record?.id === 1 && !context.initialized) {
      context.initialized = true;
      if (record.error) {
        finishCodexAccountProbe(context, false);
      } else {
        // account/read reports the authentication requirement of the resolved provider.
        sendCodexAccountProbeMessage(context, { method: "account/read", id: 2, params: { refreshToken: false } });
      }
    } else if (!record?.method && record?.id === 2) {
      finishCodexAccountProbe(context, !record.error && isCodexAccountReady(record.result));
    }
    lineBreak = context.buffer.indexOf("\n");
  }
}

/** Handles process closure without cancelling pending POSIX process-group cleanup. */
function closeCodexAccountProbe(context: CodexAccountProbeContext): void {
  if (!context.useProcessGroup && context.forceKillTimeout) {
    clearTimeout(context.forceKillTimeout);
  }
  finishCodexAccountProbe(context, false);
}

/** Sends initialize after all response, failure, close, and timeout handlers are installed. */
function initializeCodexAccountProbe(context: CodexAccountProbeContext): void {
  // Initialize the protocol before requesting the resolved account state.
  sendCodexAccountProbeMessage(context, {
    method: "initialize",
    id: 1,
    params: {
      clientInfo: { name: "accordagents", title: "AccordAgents", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] }
    }
  });
}

export function classifyAntigravityAuth(result: CliReadinessCommandResult): AuthClassification {
  if (result.timedOut) {
    return { authentication: "unknown", diagnosticCode: "probe-timeout", exitCode: result.exitCode };
  }
  if (result.ok && result.stdout.split(/\r?\n/).some((line) => line.trim())) {
    return { authentication: "ready", exitCode: result.exitCode };
  }
  return { authentication: "unknown", diagnosticCode: "auth-check-failed", exitCode: result.exitCode };
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value.trim()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeVersion(value: string): string | undefined {
  const match = value.match(/\bv?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0].slice(0, 64);
}

function commandTimedOut(error: unknown): boolean {
  return error instanceof CommandError && error.result.timedOut;
}

function commandExitCode(error: unknown): number | null | undefined {
  return error instanceof CommandError ? error.result.exitCode : undefined;
}

function normalizedPlatform(value: NodeJS.Platform): NonNullable<AgentHealth["platform"]> {
  return value === "darwin" || value === "linux" || value === "win32" ? value : "other";
}
