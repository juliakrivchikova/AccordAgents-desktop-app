import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface NativeHostIdentity { machine: string; boot: string; }

/** OS-issued identities, independent of wall time. Hardware identity is kept
 * hashed and local; this file is never part of a replicated chat/settings copy. */
export async function nativeHostIdentity(): Promise<NativeHostIdentity | undefined> {
  try {
    let machine: string;
    let boot: string;
    if (process.platform === "linux") {
      [machine, boot] = await Promise.all([readFile("/etc/machine-id", "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
    } else if (process.platform === "darwin") {
      const [registry, session] = await Promise.all([
        command("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]),
        command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])
      ]);
      machine = registry.match(/"IOPlatformUUID"\s*=\s*"([a-fA-F0-9-]+)"/)?.[1] ?? "";
      boot = session;
    } else return undefined;
    machine = machine.trim().toLowerCase(); boot = boot.trim().toLowerCase();
    if (!/^[a-f0-9-]{32,36}$/.test(machine) || !/^[a-f0-9-]{32,36}$/.test(boot)) return undefined;
    return { machine: createHash("sha256").update(`${process.platform}:${machine}`).digest("hex"), boot };
  } catch { return undefined; }
}

export function verifiedNativeHostReboot(previous?: NativeHostIdentity, current?: NativeHostIdentity): boolean {
  return Boolean(previous && current && previous.machine === current.machine && previous.boot !== current.boot);
}

function command(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, args, { encoding: "utf8", timeout: 2000, maxBuffer: 256 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}
