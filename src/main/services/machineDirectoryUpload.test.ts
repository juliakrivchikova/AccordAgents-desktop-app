import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "./command";
import { uploadDirectoryThroughTar } from "./machineDirectoryUpload";

// The machine's half is bash, tar and rsync, run here in place of ssh.
const skip = (process.platform === "win32" || spawnSync("rsync", ["--version"]).status !== 0) && "needs bash, tar and rsync, as a machine has";
const OPTIONS = ["-az", "--delete", "--exclude=node_modules"];

async function machine(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "aa upload "));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function project(root: string): Promise<string> {
  const source = path.join(root, "project");
  await mkdir(path.join(source, "node_modules", "dep"), { recursive: true });
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "node_modules", "dep", "index.js"), "skipped\n");
  await writeFile(path.join(source, "src", "app.ts"), "export {};\n");
  await writeFile(path.join(source, "gradlew"), "#!/bin/sh\n", { mode: 0o644 });
  execFileSync("git", ["init", "-q"], { cwd: source });
  execFileSync("git", ["add", "gradlew", "src/app.ts"], { cwd: source });
  // Executable only in git, as every file is on Windows.
  execFileSync("git", ["update-index", "--chmod=+x", "gradlew"], { cwd: source });
  return source;
}

const upload = (source: string, destination: string) => uploadDirectoryThroughTar({
  sshArgs: [], target: "machine", localDir: source, remoteDir: destination, rsyncOptions: OPTIONS,
  skip: (_relativeDir, name) => name === "node_modules", timeoutMs: 60_000,
  ssh: (args, options) => runCommand("bash", ["-c", args[args.length - 1]], { ...options, env: { HOME: path.join(path.dirname(source), "home") } })
});

test("into an empty folder the files arrive as rsync would put them there, executable where git says so", { skip }, async (t) => {
  const root = await machine(t);
  const source = await project(root);
  const destination = path.join(root, "machine", "release");
  await upload(source, destination);
  assert.equal(await readFile(path.join(destination, "src", "app.ts"), "utf8"), "export {};\n");
  assert.equal((await stat(path.join(destination, "gradlew"))).mode & 0o777, 0o755);
  assert.equal((await stat(path.join(destination, "src", "app.ts"))).mode & 0o777, 0o644);
  await assert.rejects(stat(path.join(destination, "node_modules")), "what rsync excludes is never sent");
});

test("into a folder that holds files the machine's rsync applies the copy: stale files go, excluded ones stay, nothing is left staged", { skip }, async (t) => {
  const root = await machine(t);
  const source = await project(root);
  const destination = path.join(root, "machine", "release");
  await mkdir(path.join(destination, "node_modules", "installed"), { recursive: true });
  await writeFile(path.join(destination, "node_modules", "installed", "index.js"), "kept\n");
  await writeFile(path.join(destination, "stale.txt"), "from an earlier copy\n");
  await upload(source, destination);
  await assert.rejects(stat(path.join(destination, "stale.txt")));
  assert.equal(await readFile(path.join(destination, "node_modules", "installed", "index.js"), "utf8"), "kept\n");
  assert.equal(await readFile(path.join(destination, "src", "app.ts"), "utf8"), "export {};\n");
  assert.deepEqual(await readdir(path.join(root, "home", ".accordagents", "uploads")), []);
});

test("a file that cannot be read fails the copy with its own reason, and the folder is left as it was", { skip: skip || (process.getuid?.() === 0 && "root reads every file") }, async (t) => {
  const root = await machine(t);
  const source = await project(root);
  const destination = path.join(root, "machine", "release");
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "stale.txt"), "kept: the copy never applied\n");
  await chmod(path.join(source, "src", "app.ts"), 0o000);
  await assert.rejects(upload(source, destination), /EACCES/);
  assert.equal(await readFile(path.join(destination, "stale.txt"), "utf8"), "kept: the copy never applied\n");
  assert.deepEqual(await readdir(path.join(root, "home", ".accordagents", "uploads")), []);
});
