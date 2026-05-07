import { spawn } from "node:child_process";

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
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

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
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
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
      const result: CommandResult = { command, args, stdout, stderr, exitCode, timedOut };

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

      resolve(result);
    });

    if (options.input) {
      child.stdin.write(options.input);
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
