import { execFile } from "node:child_process";

/**
 * The foreground process group of the terminal a shell controls, read with
 * ps. It equals the shell's pid while the shell waits at its prompt, and is a
 * command's group while one runs. The process name cannot tell these apart:
 * macOS /bin/sh is bash and reports itself as "bash". Undefined when ps
 * cannot say.
 */
export function readForegroundGroup(shellPid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "tpgid=", "-p", String(shellPid)], { timeout: 1_000 }, (error, stdout) => {
      const group = Number.parseInt(String(stdout).trim(), 10);
      resolve(error || !Number.isFinite(group) || group <= 0 ? undefined : group);
    });
  });
}
