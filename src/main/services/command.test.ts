import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commandExists, commandEnvironment, parseLoginShellEnvOutput } from "./command";

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
