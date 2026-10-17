import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A CLI's `--help` text, written to a file rather than read through a pipe.
 * Claude Code exits without draining a pipe its reader has not emptied yet,
 * so help read through a pipe arrives cut short whenever the reader is slow
 * (seen in the app: 8 KB of 21 KB, which hid the flag being looked for).
 */
export async function readCliHelpText(executable: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-cli-help-"));
  const file = path.join(dir, "help.txt");
  try {
    const output = await open(file, "w");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, ["--help"], {
          env,
          stdio: ["ignore", output.fd, "ignore"],
          windowsHide: true
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${executable} --help timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`${executable} --help exited with code ${code}`));
          }
        });
      });
    } finally {
      await output.close();
    }
    return await readFile(file, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
