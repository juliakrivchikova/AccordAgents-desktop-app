import { chmodSync, statSync } from "node:fs";
import path from "node:path";

/**
 * node-pty starts every shell through its `spawn-helper` binary, and the npm
 * package ships it without the execute bit (its install script would set it,
 * and install scripts of dependencies do not run here). Without the bit every
 * terminal fails with "posix_spawnp failed". The release build sets it when
 * packaging; this makes a development run (and any copy that lost the bit)
 * work too. Returns the helper's path when one was found.
 */
export function ensureSpawnHelperExecutable(resolveRoot: () => string = defaultNodePtyRoot): string | undefined {
  if (process.platform === "win32") return undefined;
  let root: string;
  try {
    root = resolveRoot();
  } catch {
    return undefined;
  }
  const dirs = ["build/Release", "build/Debug", `prebuilds/${process.platform}-${process.arch}`];
  for (const dir of dirs) {
    const helper = path.join(root, dir, "spawn-helper").replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");
    let mode: number;
    try {
      mode = statSync(helper).mode;
    } catch {
      continue;
    }
    if ((mode & 0o111) !== 0o111) {
      try {
        chmodSync(helper, mode | 0o755);
      } catch {
        // A read-only install: the shell start reports the failure.
      }
    }
    return helper;
  }
  return undefined;
}

function defaultNodePtyRoot(): string {
  return path.dirname(require.resolve("node-pty/package.json"));
}
