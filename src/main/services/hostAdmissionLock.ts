import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

// Node and Python share ONE open file description. Keeping Node's descriptor
// open preserves flock even if the helper dies while Node awaits SQLite.
// Parent death closes Node's descriptor and EOF makes the helper close its
// duplicate. Never explicitly LOCK_UN: that would unlock both descriptors.
const HOLDER = String.raw`
import fcntl, os, select, stat, sys, time
fd = 3
if not stat.S_ISREG(os.fstat(fd).st_mode):
    raise RuntimeError("The host admission lock is not a regular file")
deadline = time.monotonic() + 5
while True:
    if select.select([sys.stdin], [], [], 0)[0]:
        if not os.read(0, 1): sys.exit(0)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            raise RuntimeError("Another deployment is holding the power lock")
        time.sleep(0.01)
print("locked", flush=True)
sys.stdin.buffer.read()
os.close(fd)
`;

export async function withHostAdmissionLock<T>(directory: string, action: () => T | Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o777 });
  const lockPath = path.join(directory, "admission.lock");
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(lockPath, flags).catch(async error => {
    if (error.code !== "ENOENT") throw error;
    return open(lockPath, flags | constants.O_CREAT | constants.O_EXCL, 0o644).catch(error => {
      if (error.code !== "EEXIST") throw error;
      return open(lockPath, flags);
    });
  });
  try {
    if (!(await file.stat()).isFile()) throw new Error("The host admission lock is not a regular file.");
    return await holdFileLock(file.fd, action);
  } finally { await file.close(); }
}

async function holdFileLock<T>(fd: number, action: () => T | Promise<T>): Promise<T> {
  const holder = spawn("python3", ["-u", "-c", HOLDER], { stdio: ["pipe", "pipe", "pipe", fd] });
  holder.stdin!.on("error", () => undefined);
  let errorText = "";
  holder.stderr!.on("data", chunk => { errorText = (errorText + String(chunk)).slice(-2000); });
  const closed = new Promise<void>(resolve => holder.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      let ready = "";
      const timer = setTimeout(() => reject(new Error("Timed out acquiring the host admission lock; work and stop remain held.")), 7000);
      const finish = (error?: Error): void => { clearTimeout(timer); error ? reject(error) : resolve(); };
      holder.once("error", error => finish(error));
      holder.once("close", () => finish(new Error(errorText || "The host admission lock holder exited before acquiring the lock.")));
      holder.stdout!.on("data", chunk => { ready += String(chunk); if (ready.includes("locked\n")) finish(); });
    });
    // Only claim/intent files and the local SQLite fence belong here; native
    // execution, relay waits and AWS calls must happen after releasing it.
    return await action();
  } finally {
    holder.stdin!.end();
    const timer = setTimeout(() => holder.kill("SIGKILL"), 1000);
    try { await closed; } finally { clearTimeout(timer); }
  }
}
