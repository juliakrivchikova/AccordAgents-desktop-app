import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CommandError,
  commandLookupInvocation,
  commandExists,
  commandEnvironment,
  firstCommandLookupPath,
  parseLoginShellEnvOutput,
  resolveCommandPath,
  resolveCommandTimeoutMs,
  runCommand
} from "./command";

test("command lookup uses native Windows discovery and keeps the first path", () => {
  assert.deepEqual(commandLookupInvocation("codex", "win32"), {
    command: "where.exe",
    args: ["codex"]
  });
  assert.deepEqual(commandLookupInvocation("codex", "linux"), {
    command: "which",
    args: ["codex"]
  });
  assert.equal(firstCommandLookupPath("\r\nC:\\Program Files\\OpenAI\\codex.exe\r\nC:\\Users\\private\\bin\\codex.cmd\r\n"), "C:\\Program Files\\OpenAI\\codex.exe");
  assert.equal(firstCommandLookupPath(" \r\n\t\n"), undefined);
});

test("Windows command lookup prefers PATHEXT launchers over extensionless npm shims", () => {
  const output = [
    "C:\\Users\\private\\AppData\\Roaming\\npm\\codex",
    "C:\\Users\\private\\AppData\\Roaming\\npm\\codex.cmd"
  ].join("\r\n");
  assert.equal(
    firstCommandLookupPath(output, "win32", ".COM;.EXE;.BAT;.CMD"),
    "C:\\Users\\private\\AppData\\Roaming\\npm\\codex.cmd"
  );
  assert.equal(firstCommandLookupPath(output, "linux"), "C:\\Users\\private\\AppData\\Roaming\\npm\\codex");
});

test("resolveCommandPath preserves an exact absolute executable", async () => {
  assert.equal(await resolveCommandPath(process.execPath), process.execPath);
});

test("commandEnvironment preserves injected Windows PATH and PATHEXT", () => {
  const env = commandEnvironment({
    PATH: ["fixture-bin", "windows-system32"].join(path.delimiter),
    PATHEXT: ".COM;.EXE;.BAT;.CMD"
  });
  assert.ok(env.PATH?.split(path.delimiter).includes("fixture-bin"));
  assert.equal(env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
});

test("parseLoginShellEnvOutput extracts valid env lines between sentinels", () => {
  const env = parseLoginShellEnvOutput([
    "startup noise",
    "START",
    "JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-22.jdk/Contents/Home",
    "PATH=/custom/bin:/usr/bin",
    "TOKEN=value=with=equals",
    "EMPTY=",
    "BAD-KEY=ignored",
    "continuation line",
    "PWD=/capture/cwd",
    "OLDPWD=/previous",
    "SHLVL=3",
    "_=/usr/bin/env",
    "TERM=xterm-256color",
    "END",
    "shutdown noise"
  ].join("\n"), "START", "END");

  assert.equal(env.JAVA_HOME, "/Library/Java/JavaVirtualMachines/jdk-22.jdk/Contents/Home");
  assert.equal(env.PATH, "/custom/bin:/usr/bin");
  assert.equal(env.TOKEN, "value=with=equals");
  assert.equal(env.EMPTY, "");
  assert.equal(env["BAD-KEY"], undefined);
  assert.equal(env.PWD, undefined);
  assert.equal(env.OLDPWD, undefined);
  assert.equal(env.SHLVL, undefined);
  assert.equal(env._, undefined);
  assert.equal(env.TERM, undefined);
});

test("parseLoginShellEnvOutput requires sentinels", () => {
  assert.throws(
    () => parseLoginShellEnvOutput("JAVA_HOME=/jdk\nEND", "START", "END"),
    /start sentinel/
  );
  assert.throws(
    () => parseLoginShellEnvOutput("START\nJAVA_HOME=/jdk", "START", "END"),
    /end sentinel/
  );
});

test("commandEnvironment can drop GUI-only keys absent from login shell", (t) => {
  const key = "ACCORD_AGENTS_TEST_GUI_ONLY_KEY";
  const original = process.env[key];
  process.env[key] = "stale-gui-value";
  t.after(() => {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  });

  const dropped = commandEnvironment({}, { dropProcessEnvKeysAbsentFromLoginShell: [key] });
  assert.equal(dropped[key], undefined);

  const explicit = commandEnvironment({ [key]: "explicit-value" }, { dropProcessEnvKeysAbsentFromLoginShell: [key] });
  assert.equal(explicit[key], "explicit-value");
});

test("commandEnvironment discovers nvm bins when versions root contains non-directories", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS user PATH expansion is only enabled on darwin");
    return;
  }

  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const home = await mkdtemp(path.join(tmpdir(), "accordagents-command-home-"));
  t.after(async () => {
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
    await rm(home, { recursive: true, force: true });
  });

  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

  const versionsRoot = path.join(home, ".nvm", "versions", "node");
  const nodeBin = path.join(versionsRoot, "v20.10.0", "bin");
  const codexPath = path.join(nodeBin, "codex");
  await mkdir(nodeBin, { recursive: true });
  await writeFile(path.join(versionsRoot, ".DS_Store"), "");
  await writeFile(codexPath, "#!/bin/sh\nexit 0\n");
  await chmod(codexPath, 0o755);

  const env = commandEnvironment();
  assert.ok(env.PATH?.split(path.delimiter).includes(nodeBin));

  const command = await commandExists("codex");
  assert.equal(command.path, codexPath);
});

const stdioHoldingGrandchildScript = [
  "const { spawn } = require('node:child_process');",
  "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'inherit' });",
  "setTimeout(() => {}, 15000);"
].join("");

const windowsDescendantScript = [
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
  "writeFileSync(process.argv[1], String(helper.pid));",
  "setInterval(() => {}, 1000);"
].join("");

test("aborted run settles even when a grandchild keeps the stdio pipes open", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 300);
  // The direct Node child dies on cancellation while its grandchild inherits
  // the stdio pipes. Without releasing our pipe ends the promise would wait for
  // the grandchild to exit.
  await assert.rejects(
    runCommand(process.execPath, ["-e", stdioHoldingGrandchildScript], {
      timeoutMs: 30_000,
      killProcessGroup: true,
      primeLoginShellEnv: false,
      signal: controller.signal
    }),
    (error: unknown) => error instanceof CommandError && /cancelled/.test((error as CommandError).message)
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 5_000, `expected prompt cancellation, took ${elapsedMs}ms`);
});

test("timed-out run settles even when a grandchild keeps the stdio pipes open", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runCommand(process.execPath, ["-e", stdioHoldingGrandchildScript], {
      timeoutMs: 300,
      killProcessGroup: true,
      primeLoginShellEnv: false
    }),
    (error: unknown) => error instanceof CommandError && /timed out/.test((error as CommandError).message)
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 5_000, `expected prompt timeout, took ${elapsedMs}ms`);
});

test("timed-out process-group run leaves no helper process", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-process-group-"));
  const pidFile = path.join(root, "helper.pid");
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    runCommand("sh", ["-c", `sleep 15 & echo $! > ${JSON.stringify(pidFile)}; wait`], {
      timeoutMs: 300,
      killProcessGroup: true,
      primeLoginShellEnv: false
    }),
    (error: unknown) => error instanceof CommandError && error.result.timedOut
  );

  const helperPid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
  for (let attempt = 0; attempt < 20 && processExists(helperPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processExists(helperPid), false, `helper process ${helperPid} survived timeout`);
});

test("aborted Windows process-tree run leaves no descendant", async (t) => {
  if (process.platform !== "win32") {
    t.skip("taskkill process-tree behavior is only available on Windows");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-windows-tree-abort-"));
  const pidFile = path.join(root, "helper.pid");
  const controller = new AbortController();
  let helperPid: number | undefined;
  t.after(async () => {
    controller.abort();
    if (helperPid && processExists(helperPid)) {
      process.kill(helperPid, "SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  });

  const run = runCommand(process.execPath, ["-e", windowsDescendantScript, pidFile], {
    timeoutMs: 30_000,
    killProcessGroup: true,
    primeLoginShellEnv: false,
    signal: controller.signal
  });
  helperPid = await waitForPidFile(pidFile);
  controller.abort();
  await assert.rejects(
    run,
    (error: unknown) => error instanceof CommandError && /cancelled/.test(error.message)
  );
  await assertProcessStops(helperPid);
});

test("timed-out Windows process-tree run leaves no descendant", async (t) => {
  if (process.platform !== "win32") {
    t.skip("taskkill process-tree behavior is only available on Windows");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-windows-tree-timeout-"));
  const pidFile = path.join(root, "helper.pid");
  let helperPid: number | undefined;
  t.after(async () => {
    if (helperPid && processExists(helperPid)) {
      process.kill(helperPid, "SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  });

  const run = runCommand(process.execPath, ["-e", windowsDescendantScript, pidFile], {
    timeoutMs: 1_000,
    killProcessGroup: true,
    primeLoginShellEnv: false
  });
  helperPid = await waitForPidFile(pidFile);
  await assert.rejects(
    run,
    (error: unknown) => error instanceof CommandError && error.result.timedOut
  );
  await assertProcessStops(helperPid);
});

for (const extension of ["cmd", "bat"]) {
  test(`Windows .${extension} launchers preserve path-with-spaces arguments without command injection`, async (t) => {
    if (process.platform !== "win32") {
      t.skip("Windows batch launcher behavior is only available on Windows");
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), `accord agents ${extension} launcher `));
    const capturePath = path.join(root, "capture args.cjs");
    const outputPath = path.join(root, "captured args.json");
    const injectionMarker = path.join(root, "injected.txt");
    const launcherPath = path.join(root, `provider launcher.${extension}`);
    t.after(() => rm(root, { recursive: true, force: true }));

    await writeFile(
      capturePath,
      "require('node:fs').writeFileSync(process.env.ACCORD_AGENTS_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)), 'utf8');\n",
      "utf8"
    );
    await writeFile(
      launcherPath,
      "@echo off\r\n\"%ACCORD_AGENTS_TEST_NODE%\" \"%~dp0capture args.cjs\" %*\r\n",
      "utf8"
    );
    const args = [
      "repo path with spaces",
      `literal & echo injected>\"${injectionMarker}\"`,
      "100% complete",
      "quote\"inside"
    ];
    await runCommand(launcherPath, args, {
      env: {
        ACCORD_AGENTS_CAPTURE_PATH: outputPath,
        ACCORD_AGENTS_TEST_NODE: process.execPath
      },
      primeLoginShellEnv: false
    });

    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), args);
    await assert.rejects(readFile(injectionMarker, "utf8"), { code: "ENOENT" });
  });
}

test("runCommand treats timeoutMs 0 as no wall-clock deadline", async () => {
  const result = await runCommand(process.execPath, ["-e", "setTimeout(() => process.stdout.write('done'), 50);"], {
    timeoutMs: 0,
    allowNoTimeout: true,
    primeLoginShellEnv: false
  });
  assert.equal(result.stdout, "done");
  assert.equal(result.timedOut, false);
});

test("runCommand requires an explicit opt-in for an unbounded deadline", () => {
  assert.equal(resolveCommandTimeoutMs(0), 30_000);
  assert.equal(resolveCommandTimeoutMs(-1), 30_000);
  assert.equal(resolveCommandTimeoutMs(0, true), 0);
  assert.equal(resolveCommandTimeoutMs(-1, true), 30_000);
  assert.equal(resolveCommandTimeoutMs(250), 250);
});

test("aborted process-group run leaves no helper process", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-process-group-abort-"));
  const pidFile = path.join(root, "helper.pid");
  const controller = new AbortController();
  t.after(() => rm(root, { recursive: true, force: true }));
  setTimeout(() => controller.abort(), 300);

  await assert.rejects(
    runCommand("sh", ["-c", `sleep 15 & echo $! > ${JSON.stringify(pidFile)}; wait`], {
      timeoutMs: 30_000,
      killProcessGroup: true,
      primeLoginShellEnv: false,
      signal: controller.signal
    }),
    (error: unknown) => error instanceof CommandError && /cancelled/.test(error.message)
  );

  await assertProcessStops(Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10));
});

test("repeated bounded probes leave no helper processes", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-process-group-repeat-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (let index = 0; index < 3; index += 1) {
    const pidFile = path.join(root, `helper-${index}.pid`);
    await assert.rejects(
      runCommand("sh", ["-c", `sleep 15 & echo $! > ${JSON.stringify(pidFile)}; wait`], {
        timeoutMs: 150,
        killProcessGroup: true,
        primeLoginShellEnv: false
      }),
      (error: unknown) => error instanceof CommandError && error.result.timedOut
    );
    await assertProcessStops(Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10));
  }
});

test("timed-out process-group run force-kills a helper that ignores SIGTERM", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-process-group-stubborn-"));
  const pidFile = path.join(root, "helper.pid");
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";

  await assert.rejects(
    runCommand("sh", ["-c", `node -e ${JSON.stringify(helper)} & echo $! > ${JSON.stringify(pidFile)}; wait`], {
      timeoutMs: 300,
      killProcessGroup: true,
      primeLoginShellEnv: false
    }),
    (error: unknown) => error instanceof CommandError && error.result.timedOut
  );

  const helperPid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
  for (let attempt = 0; attempt < 50 && processExists(helperPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processExists(helperPid), false, `SIGTERM-resistant helper process ${helperPid} survived timeout`);
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function assertProcessStops(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 30 && processExists(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processExists(pid), false, `helper process ${pid} survived`);
}

async function waitForPidFile(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // The parent fixture has not written its helper pid yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fixture did not write helper pid to ${pidFile}`);
}
