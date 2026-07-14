import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandError, commandExists, commandEnvironment, parseLoginShellEnvOutput, runCommand } from "./command";

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

test("aborted run settles even when a grandchild keeps the stdio pipes open", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 300);
  // `sh` dies on SIGTERM but both `sleep`s survive it and inherit the stdio
  // pipes; without releasing our pipe ends the promise would settle only when
  // the sleeps exit (~15s).
  await assert.rejects(
    runCommand("sh", ["-c", "sleep 15 & sleep 15"], {
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
    runCommand("sh", ["-c", "sleep 15 & sleep 15"], {
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
