import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

type KillableProcess = Pick<ChildProcess, "pid" | "kill">;

export function terminateProcess(
  child: KillableProcess,
  signal: NodeJS.Signals,
  killDescendants = false
): void {
  if (!killDescendants || process.platform !== "win32" || !child.pid) {
    child.kill(signal);
    return;
  }

  let fellBack = false;
  const fallback = (): void => {
    if (fellBack) {
      return;
    }
    fellBack = true;
    child.kill(signal);
  };

  try {
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const taskkillPath = windowsRoot ? path.join(windowsRoot, "System32", "taskkill.exe") : "taskkill.exe";
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const taskkill = spawn(taskkillPath, args, {
      stdio: "ignore",
      windowsHide: true
    });
    taskkill.once("error", fallback);
    taskkill.once("close", (exitCode) => {
      if (exitCode !== 0) {
        fallback();
      }
    });
    taskkill.unref();
  } catch {
    fallback();
  }
}
