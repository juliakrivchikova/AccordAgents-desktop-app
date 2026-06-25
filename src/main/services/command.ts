import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LOGIN_SHELL_ENV_TIMEOUT_MS = 4000;
const LOGIN_SHELL_ENV_KILL_GRACE_MS = 1500;
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
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface CommandEnvironmentOptions {
  dropProcessEnvKeysAbsentFromLoginShell?: readonly string[];
}

let loginShellEnv: NodeJS.ProcessEnv | undefined;
let loginShellEnvPrime: Promise<NodeJS.ProcessEnv> | undefined;
let debugLogger: CommandDebugLogger | undefined;

export function setCommandDebugLogger(logger: CommandDebugLogger | undefined): void {
  debugLogger = logger;
}

export async function ensureLoginShellEnvPrimed(): Promise<NodeJS.ProcessEnv> {
  if (loginShellEnv) {
    return loginShellEnv;
  }
  loginShellEnvPrime ??= primeLoginShellEnv().then((env) => {
    loginShellEnv = env;
    return env;
  });
  return loginShellEnvPrime;
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: commandEnvironment(options.env, options.envOptions),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let stdinError: Error | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 1500).unref();
    }, timeoutMs);
    timer.unref();

    const abort = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 1500).unref();
    };

    if (options.signal?.aborted) {
      abort();
    }
    options.signal?.addEventListener("abort", abort, { once: true });

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

export async function commandExists(command: string): Promise<{ path?: string; version?: string; error?: string }> {
  try {
    const which = await runCommand("which", [command], { timeoutMs: 5000 });
    return { path: which.stdout.trim() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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

async function primeLoginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== "darwin") {
    return {};
  }

  const shell = process.env.SHELL?.trim() || "/bin/zsh";
  const startSentinel = `__ACCORD_AGENTS_ENV_START_${randomUUID()}__`;
  const endSentinel = `__ACCORD_AGENTS_ENV_END_${randomUUID()}__`;
  const script = [
    `printf '%s\\n' ${shellQuote(startSentinel)}`,
    "/usr/bin/env",
    `printf '%s\\n' ${shellQuote(endSentinel)}`
  ].join("; ");

  try {
    const stdout = await runLoginShellEnvCapture(shell, script);
    return parseLoginShellEnvOutput(stdout, startSentinel, endSentinel);
  } catch (error) {
    void writeCommandDebugLog("command.login-shell-env-prime-failed", {
      reason: error instanceof Error ? error.message : String(error)
    });
    return {};
  }
}

function runLoginShellEnvCapture(shell: string, script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-ilc", script], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, LOGIN_SHELL_ENV_KILL_GRACE_MS);
      killTimer.unref();
    }, LOGIN_SHELL_ENV_TIMEOUT_MS);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();

    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      settled = true;
      reject(new Error(`login shell env capture failed to start: ${error.message}`));
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      settled = true;
      if (timedOut) {
        reject(new Error(`login shell env capture timed out after ${LOGIN_SHELL_ENV_TIMEOUT_MS}ms`));
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(`login shell env capture exited with code ${exitCode ?? "unknown"}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.end();
  });
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
