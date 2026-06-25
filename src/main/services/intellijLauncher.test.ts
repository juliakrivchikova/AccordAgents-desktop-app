import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  buildIntellijLauncherArgs,
  IntellijLauncherService,
  isWindowsCommandShim
} from "./intellijLauncher";

test("buildIntellijLauncherArgs includes only positive integer line and column values", () => {
  assert.deepEqual(buildIntellijLauncherArgs({ filePath: "/repo/src/main.ts", line: 12, column: 4 }), [
    "--line",
    "12",
    "--column",
    "4",
    "/repo/src/main.ts"
  ]);
  assert.deepEqual(buildIntellijLauncherArgs({ filePath: "/repo/README.md" }), [
    "--line",
    "1",
    "/repo/README.md"
  ]);
  assert.deepEqual(buildIntellijLauncherArgs({ filePath: "/repo/src/main.ts", line: -1, column: 4 }), [
    "--line",
    "1",
    "/repo/src/main.ts"
  ]);
  assert.deepEqual(buildIntellijLauncherArgs({ filePath: "/repo/src/main.ts", line: 12, column: 0 }), [
    "--line",
    "12",
    "/repo/src/main.ts"
  ]);
});

test("IntelliJ launcher spawns a PATH launcher detached and waits for spawn", async () => {
  let unrefCalled = false;
  let spawnCall: { command: string; args: string[]; options: SpawnOptions } | undefined;
  const launcher = new IntellijLauncherService({
    platform: "linux",
    env: { PATH: "/tools" },
    homeDir: "/home/test",
    primeLoginShellEnv: async () => ({}),
    stat: async (filePath) => ({
      isFile: () => filePath === "/tools/idea"
    }) as any,
    access: async () => undefined,
    readdir: async () => [] as any,
    spawn: (command, args, options) => {
      spawnCall = { command, args, options };
      const child = new EventEmitter() as ChildProcess;
      child.unref = () => {
        unrefCalled = true;
        return child;
      };
      process.nextTick(() => child.emit("spawn"));
      return child;
    }
  });

  const result = await launcher.openFile({ filePath: "/repo/src/main.ts", line: 12, column: 4 });

  assert.deepEqual(result, { opened: true, lineNavigationSupported: true });
  assert.deepEqual(spawnCall?.command, "/tools/idea");
  assert.deepEqual(spawnCall?.args, ["--line", "12", "--column", "4", "/repo/src/main.ts"]);
  assert.equal(spawnCall?.options.detached, true);
  assert.equal(spawnCall?.options.stdio, "ignore");
  assert.equal(spawnCall?.options.shell, false);
  assert.equal(unrefCalled, true);
});

test("IntelliJ launcher reports spawn errors before success", async () => {
  const launcher = new IntellijLauncherService({
    platform: "linux",
    env: { PATH: "/tools" },
    homeDir: "/home/test",
    primeLoginShellEnv: async () => ({}),
    stat: async (filePath) => ({
      isFile: () => filePath === "/tools/idea"
    }) as any,
    access: async () => undefined,
    readdir: async () => [] as any,
    spawn: () => {
      const child = new EventEmitter() as ChildProcess;
      child.unref = () => child;
      process.nextTick(() => child.emit("error", new Error("ENOENT")));
      return child;
    }
  });

  const result = await launcher.openFile({ filePath: "/repo/src/main.ts", line: 12 });

  assert.equal(result.opened, false);
  assert.match(result.opened === false ? result.message : "", /ENOENT/);
});

test("macOS uses the app bundle launcher binary and ignores PATH Toolbox scripts", async () => {
  const appPath = "/Users/test/Applications/IntelliJ IDEA 2025.3.2.app";
  let spawnCall: { command: string; args: string[]; options: SpawnOptions } | undefined;
  const launcher = new IntellijLauncherService({
    platform: "darwin",
    env: { PATH: "/Users/test/Applications/IntelliJ IDEA 2025.3.2.app/Contents/MacOS:/usr/local/bin:/usr/bin" },
    homeDir: "/Users/test",
    primeLoginShellEnv: async () => ({}),
    stat: async (filePath) => ({
      isFile: () => filePath === `${appPath}/Contents/MacOS/idea`
    }) as any,
    access: async () => undefined,
    readdir: async (root) => {
      if (root === "/Users/test/Applications") {
        return [{
          name: "IntelliJ IDEA 2025.3.2.app",
          isDirectory: () => true
        }] as any;
      }
      return [] as any;
    },
    spawn: (command, args, options) => {
      spawnCall = { command, args, options };
      const child = new EventEmitter() as ChildProcess;
      child.unref = () => child;
      process.nextTick(() => child.emit("spawn"));
      return child;
    }
  });

  const result = await launcher.openFile({ filePath: "/repo/src/main.ts", line: 12, column: 4 });

  assert.deepEqual(result, { opened: true, lineNavigationSupported: true });
  assert.deepEqual(spawnCall?.command, `${appPath}/Contents/MacOS/idea`);
  assert.deepEqual(spawnCall?.args, ["--line", "12", "--column", "4", "/repo/src/main.ts"]);
  assert.equal(spawnCall?.options.shell, false);
});

test("Windows command shims are recognized and not treated as direct spawn targets", async () => {
  assert.equal(isWindowsCommandShim("C:\\Tools\\idea.cmd"), true);
  assert.equal(isWindowsCommandShim("C:\\Tools\\idea.bat"), true);
  assert.equal(isWindowsCommandShim("C:\\Tools\\idea64.exe"), false);

  let spawnCalled = false;
  const launcher = new IntellijLauncherService({
    platform: "win32",
    env: { PATH: "C:\\Tools" },
    homeDir: "C:\\Users\\test",
    primeLoginShellEnv: async () => ({}),
    stat: async () => ({
      isFile: () => false
    }) as any,
    access: async () => undefined,
    readdir: async () => [] as any,
    spawn: () => {
      spawnCalled = true;
      return new EventEmitter() as ChildProcess;
    }
  });

  const result = await launcher.openFile({ filePath: "C:\\repo\\src\\main.ts" });

  assert.equal(result.opened, false);
  assert.equal(spawnCalled, false);
});
