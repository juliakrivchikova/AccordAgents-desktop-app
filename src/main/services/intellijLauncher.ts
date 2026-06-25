import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir, platform as currentPlatform } from "node:os";
import path from "node:path";
import { commandEnvironment, ensureLoginShellEnvPrimed } from "./command";

export interface IntellijOpenRequest {
  filePath: string;
  line?: number;
  column?: number;
}

export type IntellijOpenResult =
  | { opened: true; lineNavigationSupported: boolean }
  | { opened: false; message: string };

export interface IntellijLauncher {
  openFile(request: IntellijOpenRequest): Promise<IntellijOpenResult>;
  clearCache(): void;
}

interface ResolvedLauncher {
  command: string;
  argsPrefix: string[];
  lineNavigationSupported: boolean;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type StatFn = typeof stat;
type AccessFn = typeof access;
type ReaddirFn = typeof readdir;
type PrimeLoginShellEnvFn = typeof ensureLoginShellEnvPrimed;

export interface IntellijLauncherDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  spawn?: SpawnFn;
  stat?: StatFn;
  access?: AccessFn;
  readdir?: ReaddirFn;
  primeLoginShellEnv?: PrimeLoginShellEnvFn;
}

export class IntellijLauncherService implements IntellijLauncher {
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly spawnProcess: SpawnFn;
  private readonly statPath: StatFn;
  private readonly accessPath: AccessFn;
  private readonly readDir: ReaddirFn;
  private readonly primeLoginShellEnv: PrimeLoginShellEnvFn;
  private cachedLauncher?: ResolvedLauncher | null;

  constructor(private readonly deps: IntellijLauncherDependencies = {}) {
    this.platform = deps.platform ?? currentPlatform();
    this.homeDir = deps.homeDir ?? homedir();
    this.spawnProcess = deps.spawn ?? spawn;
    this.statPath = deps.stat ?? stat;
    this.accessPath = deps.access ?? access;
    this.readDir = deps.readdir ?? readdir;
    this.primeLoginShellEnv = deps.primeLoginShellEnv ?? ensureLoginShellEnvPrimed;
  }

  async openFile(request: IntellijOpenRequest): Promise<IntellijOpenResult> {
    const launcher = await this.resolveLauncher();
    if (!launcher) {
      return {
        opened: false,
        message: "IntelliJ IDEA launcher was not found. Install the JetBrains command-line launcher or set IntelliJ IDEA as the default app."
      };
    }

    const args = [...launcher.argsPrefix, ...buildIntellijLauncherArgs(request)];
    try {
      await this.launchDetached(launcher.command, args);
      return {
        opened: true,
        lineNavigationSupported: launcher.lineNavigationSupported && isPositiveInteger(request.line)
      };
    } catch (error) {
      return {
        opened: false,
        message: `Could not open the file in IntelliJ IDEA: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  clearCache(): void {
    this.cachedLauncher = undefined;
  }

  private async resolveLauncher(): Promise<ResolvedLauncher | undefined> {
    if (this.cachedLauncher !== undefined) {
      return this.cachedLauncher ?? undefined;
    }

    await this.primeLoginShellEnv().catch(() => undefined);
    const env = { ...commandEnvironment(), ...this.deps.env };
    const candidates = await this.launcherCandidates(env);

    for (const candidate of candidates) {
      if (await this.isUsableFile(candidate.command)) {
        this.cachedLauncher = candidate;
        return candidate;
      }
    }

    this.cachedLauncher = null;
    return undefined;
  }

  private async launcherCandidates(env: NodeJS.ProcessEnv): Promise<ResolvedLauncher[]> {
    const candidates: ResolvedLauncher[] = [];
    if (this.platform === "darwin") {
      candidates.push(...await this.macCandidates());
    } else {
      for (const command of this.pathCommandNames()) {
        const match = await this.findOnPath(command, env.PATH);
        if (match) {
          candidates.push({ command: match, argsPrefix: [], lineNavigationSupported: true });
        }
      }

      if (this.platform === "win32") {
        candidates.push(...await this.windowsCandidates(env));
      } else {
        candidates.push(...await this.linuxCandidates());
      }
    }

    return candidates;
  }

  private pathCommandNames(): string[] {
    if (this.platform === "win32") {
      // Do not include .bat/.cmd shims here. Node cannot spawn them directly with shell:false.
      return ["idea64.exe", "idea.exe"];
    }
    return ["idea", "idea.sh", "intellij-idea", "intellij-idea-ultimate", "intellij-idea-community"];
  }

  private async macCandidates(): Promise<ResolvedLauncher[]> {
    const candidates: ResolvedLauncher[] = [];
    for (const root of ["/Applications", path.join(this.homeDir, "Applications"), path.join(this.homeDir, "Applications", "JetBrains Toolbox")]) {
      for (const appPath of await this.matchDirectoryEntries(root, /^IntelliJ IDEA.*\.app$/)) {
        candidates.push({
          command: path.join(appPath, "Contents", "MacOS", "idea"),
          argsPrefix: [],
          lineNavigationSupported: true
        });
      }
    }
    return candidates;
  }

  private async windowsCandidates(env: NodeJS.ProcessEnv): Promise<ResolvedLauncher[]> {
    const roots = [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : undefined
    ].filter((item): item is string => Boolean(item));

    const candidates: ResolvedLauncher[] = [];
    for (const root of roots) {
      for (const installDir of await this.matchDirectoryEntries(path.join(root, "JetBrains"), /^IntelliJ IDEA/i)) {
        candidates.push({
          command: path.join(installDir, "bin", "idea64.exe"),
          argsPrefix: [],
          lineNavigationSupported: true
        });
      }
    }
    return candidates;
  }

  private async linuxCandidates(): Promise<ResolvedLauncher[]> {
    const candidates: ResolvedLauncher[] = [];
    for (const scriptPath of [
      path.join(this.homeDir, ".local", "share", "JetBrains", "Toolbox", "scripts", "idea"),
      "/snap/bin/intellij-idea"
    ]) {
      candidates.push({ command: scriptPath, argsPrefix: [], lineNavigationSupported: true });
    }

    for (const installDir of await this.matchDirectoryEntries("/opt", /^idea/i)) {
      candidates.push({
        command: path.join(installDir, "bin", "idea.sh"),
        argsPrefix: [],
        lineNavigationSupported: true
      });
    }
    return candidates;
  }

  private async findOnPath(command: string, rawPath: string | undefined): Promise<string | undefined> {
    const delimiter = this.platform === "win32" ? ";" : path.delimiter;
    for (const segment of (rawPath ?? "").split(delimiter)) {
      const trimmed = segment.trim();
      if (!trimmed) {
        continue;
      }
      const candidate = path.join(trimmed, command);
      if (await this.isUsableFile(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  private async matchDirectoryEntries(root: string, pattern: RegExp): Promise<string[]> {
    try {
      const entries = await this.readDir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
        .map((entry) => path.join(root, entry.name))
        .sort((left, right) => right.localeCompare(left));
    } catch {
      return [];
    }
  }

  private async isUsableFile(filePath: string): Promise<boolean> {
    if (this.platform === "win32" && isWindowsCommandShim(filePath)) {
      return false;
    }
    try {
      const info = await this.statPath(filePath);
      if (!info.isFile()) {
        return false;
      }
      if (this.platform !== "win32") {
        await this.accessPath(filePath, constants.X_OK);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async launchDetached(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnProcess(command, args, {
        detached: true,
        stdio: "ignore",
        shell: false,
        env: commandEnvironment(this.deps.env)
      });
      let settled = false;

      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      });
      child.once("spawn", () => {
        if (settled) {
          return;
        }
        settled = true;
        child.unref();
        resolve();
      });
    });
  }
}

export function buildIntellijLauncherArgs(request: IntellijOpenRequest): string[] {
  const args: string[] = [];
  // IntelliJ can focus/select bare file opens without showing an editor tab; --line 1 forces the editor open.
  const line = isPositiveInteger(request.line) ? request.line : 1;
  args.push("--line", String(line));
  if (isPositiveInteger(request.line)) {
    if (isPositiveInteger(request.column)) {
      args.push("--column", String(request.column));
    }
  }
  args.push(request.filePath);
  return args;
}

export function isWindowsCommandShim(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".bat" || extension === ".cmd";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
