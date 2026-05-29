import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export function commandEnvironment(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extraEnv,
    PATH: commandPath(process.env.PATH, extraEnv.PATH)
  };
}

export class CommandError extends Error {
  readonly result: CommandResult;

  constructor(message: string, result: CommandResult) {
    super(message);
    this.name = "CommandError";
    this.result = result;
  }
}

export function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: commandEnvironment(options.env),
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
    return readdirSync(versionsRoot)
      .map((version) => path.join(versionsRoot, version, "bin"))
      .filter((segment) => statSync(segment).isDirectory())
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
