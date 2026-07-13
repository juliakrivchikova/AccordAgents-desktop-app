import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LOGIN_SHELL_ENV_TIMEOUT_MS = 8000;
const LOGIN_SHELL_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VOLATILE_LOGIN_SHELL_ENV_KEYS = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM"]);

interface CommandDebugLogger {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

export interface CommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface CommandOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  envOptions?: CommandEnvironmentOptions;
  primeLoginShellEnv?: boolean;
  killProcessGroup?: boolean;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface CommandEnvironmentOptions {
  dropProcessEnvKeysAbsentFromLoginShell?: readonly string[];
}

let loginShellEnv: NodeJS.ProcessEnv | undefined;
let loginShellEnvRefresh: Promise<LoginShellEnvironmentRefresh> | undefined;
let debugLogger: CommandDebugLogger | undefined;

export function setCommandDebugLogger(logger: CommandDebugLogger | undefined): void {
  debugLogger = logger;
}

export async function ensureLoginShellEnvPrimed(): Promise<NodeJS.ProcessEnv> {
  if (loginShellEnv) {
    return loginShellEnv;
  }
  return (await refreshLoginShellEnv()).env;
}

export interface LoginShellEnvironmentRefresh {
  ok: boolean;
  env: NodeJS.ProcessEnv;
}

export function refreshLoginShellEnv(): Promise<LoginShellEnvironmentRefresh> {
  if (loginShellEnvRefresh) {
    return loginShellEnvRefresh;
  }
  const refresh = captureFreshLoginShellEnv().finally(() => {
    if (loginShellEnvRefresh === refresh) {
      loginShellEnvRefresh = undefined;
    }
  });
  loginShellEnvRefresh = refresh;
  return refresh;
}

async function captureFreshLoginShellEnv(): Promise<LoginShellEnvironmentRefresh> {
  if (process.platform !== "darwin") {
    loginShellEnv = {};
    return { ok: true, env: {} };
  }
  try {
    const env = await captureLoginShellEnv();
    loginShellEnv = env;
    return { ok: true, env };
  } catch (error) {
    void writeCommandDebugLog("command.login-shell-env-prime-failed", {
      reason: error instanceof CommandError && error.result.timedOut ? "timeout" : "failed"
    });
    return { ok: false, env: {} };
  }
}

export function commandEnvironment(extraEnv: NodeJS.ProcessEnv = {}, options: CommandEnvironmentOptions = {}): NodeJS.ProcessEnv {
  const shellEnv = loginShellEnv ?? {};
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...shellEnv,
    ...extraEnv,
    PATH: commandPath(shellEnv.PATH ?? process.env.PATH, extraEnv.PATH)
  };
  for (const key of options.dropProcessEnvKeysAbsentFromLoginShell ?? []) {
    if (hasOwn(extraEnv, key) || hasOwn(shellEnv, key)) {
      continue;
    }
    delete env[key];
  }
  return env;
}

export class CommandError extends Error {
  readonly result: CommandResult;

  constructor(message: string, result: CommandResult) {
    super(message);
    this.name = "CommandError";
    this.result = result;
  }
}

export async function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  if (options.primeLoginShellEnv !== false) {
    await ensureLoginShellEnvPrimed();
  }
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    const useProcessGroup = options.killProcessGroup === true && process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: commandEnvironment(options.env, options.envOptions),
      detached: useProcessGroup,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let stdinError: Error | undefined;

    // Descendants of the child can inherit its stdio pipes and keep them open
    // past the child's death; `close` (and this promise) would then wait on
    // them indefinitely. A cancelled or timed-out run must not, so release our
    // ends once the child itself is gone.
    const releaseStdio = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const terminate = (signal: NodeJS.Signals): void => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child when the process group is already gone
          // or the current platform cannot signal it.
        }
      }
      child.kill(signal);
    };

    const scheduleForceKill = (): void => {
      setTimeout(() => {
        // A shell can exit after SIGTERM while a descendant in its process
        // group ignores the signal. Escalate the whole group even after the
        // direct child has settled so readiness probes cannot leak helpers.
        if (useProcessGroup || !settled) {
          terminate("SIGKILL");
        }
        if (!settled) {
          releaseStdio();
        }
      }, 1500).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      scheduleForceKill();
    }, timeoutMs);
    timer.unref();

    const abort = () => {
      terminate("SIGTERM");
      scheduleForceKill();
    };

    if (options.signal?.aborted) {
      abort();
    }
    options.signal?.addEventListener("abort", abort, { once: true });

    child.on("exit", () => {
      if (!settled && (options.signal?.aborted || timedOut)) {
        releaseStdio();
      }
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.stdin.on("error", (error) => {
      stdinError = error;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      settled = true;
      const result: CommandResult = { command, args, stdout, stderr: stderr || error.message, exitCode: null, timedOut };
      reject(new CommandError(error.message, result));
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      settled = true;
      const result: CommandResult = { command, args, stdout, stderr: stderr || stdinError?.message || "", exitCode, timedOut };

      if (options.signal?.aborted) {
        reject(new CommandError(`${command} was cancelled`, result));
        return;
      }

      if (timedOut) {
        reject(new CommandError(`${command} timed out after ${timeoutMs}ms`, result));
        return;
      }

      if (exitCode !== 0) {
        reject(new CommandError(`${command} exited with code ${exitCode}`, result));
        return;
      }

      if (stdinError) {
        reject(new CommandError(stdinError.message, result));
        return;
      }

      resolve(result);
    });

    if (options.input) {
      child.stdin.write(options.input, (error) => {
        if (error) {
          stdinError = error;
        }
      });
    }
    child.stdin.end();
  });
}

function hasOwn(object: NodeJS.ProcessEnv, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function parseLoginShellEnvOutput(stdout: string, startSentinel: string, endSentinel: string): NodeJS.ProcessEnv {
  const lines = stdout.split(/\r?\n/).map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  const startIndex = lines.findIndex((line) => line === startSentinel);
  if (startIndex < 0) {
    throw new Error("login shell env capture did not include a start sentinel");
  }
  const endIndex = lines.findIndex((line, index) => index > startIndex && line === endSentinel);
  if (endIndex < 0) {
    throw new Error("login shell env capture did not include an end sentinel");
  }

  const env: NodeJS.ProcessEnv = {};
  for (const line of lines.slice(startIndex + 1, endIndex)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex);
    if (!LOGIN_SHELL_ENV_KEY_PATTERN.test(key) || VOLATILE_LOGIN_SHELL_ENV_KEYS.has(key)) {
      continue;
    }
    env[key] = line.slice(separatorIndex + 1);
  }
  return env;
}

export interface CommandLookupResult {
  status: "found" | "not-found" | "unknown";
  path?: string;
  timedOut?: boolean;
}

export async function lookupCommand(command: string, env?: NodeJS.ProcessEnv): Promise<CommandLookupResult> {
  try {
    const which = await runCommand("which", [command], {
      env,
      killProcessGroup: true,
      primeLoginShellEnv: env ? false : undefined,
      timeoutMs: 5000
    });
    const commandPath = which.stdout.trim();
    return commandPath ? { status: "found", path: commandPath } : { status: "not-found" };
  } catch (error) {
    if (error instanceof CommandError && error.result.exitCode === 1 && !error.result.timedOut) {
      return { status: "not-found" };
    }
    return {
      status: "unknown",
      timedOut: error instanceof CommandError ? error.result.timedOut : false
    };
  }
}

export async function commandExists(command: string): Promise<{ path?: string; version?: string; error?: string }> {
  const result = await lookupCommand(command);
  if (result.status === "found") {
    return { path: result.path };
  }
  return result.status === "not-found" ? {} : { error: "Command lookup failed." };
}

function commandPath(basePath?: string, extraPath?: string): string {
  return uniquePathSegments([
    ...(basePath ?? "").split(path.delimiter),
    ...(extraPath ?? "").split(path.delimiter),
    ...macOSUserPathSegments()
  ]).join(path.delimiter);
}

function uniquePathSegments(segments: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const segment of segments) {
    const normalized = segment.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function macOSUserPathSegments(): string[] {
  if (process.platform !== "darwin") {
    return [];
  }

  const home = homedir();
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".cargo", "bin"),
    ...nvmNodeBinSegments(home),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].filter((segment) => existsSync(segment));
}

function nvmNodeBinSegments(home: string): string[] {
  const versionsRoot = path.join(home, ".nvm", "versions", "node");
  if (!existsSync(versionsRoot)) {
    return [];
  }

  try {
    return readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(versionsRoot, entry.name, "bin"))
      .filter((segment) => {
        try {
          return statSync(segment).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

async function captureLoginShellEnv(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SHELL?.trim() || "/bin/zsh";
  const startSentinel = `__ACCORD_AGENTS_ENV_START_${randomUUID()}__`;
  const endSentinel = `__ACCORD_AGENTS_ENV_END_${randomUUID()}__`;
  const script = [
    `printf '%s\\n' ${shellQuote(startSentinel)}`,
    "/usr/bin/env",
    `printf '%s\\n' ${shellQuote(endSentinel)}`
  ].join("; ");

  const result = await runCommand(shell, ["-ilc", script], {
    env: process.env,
    primeLoginShellEnv: false,
    killProcessGroup: true,
    timeoutMs: LOGIN_SHELL_ENV_TIMEOUT_MS
  });
  return parseLoginShellEnvOutput(result.stdout, startSentinel, endSentinel);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function writeCommandDebugLog(event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await debugLogger?.write(event, payload);
  } catch {
    // Debug logging must not affect command execution.
  }
}
