import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "./command";
import { GitService } from "./git";

test("inspectRepo accepts existing folders that are not git repositories", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "accordagents-plain-folder-"));

  try {
    const service = new GitService();
    const info = await service.inspectRepo(repoPath);

    assert.equal(info.repoPath, repoPath);
    assert.equal(info.isRepo, false);
    assert.equal(info.error, undefined);
    assert.deepEqual(info.branches, []);
    assert.deepEqual(info.statusLines, []);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("inspectRepo returns a friendly error for missing folders", async () => {
  const repoPath = path.join(tmpdir(), `accordagents-missing-${Date.now()}`);
  const service = new GitService();
  const info = await service.inspectRepo(repoPath);

  assert.equal(info.repoPath, repoPath);
  assert.equal(info.isRepo, false);
  assert.equal(info.error, "Folder does not exist.");
  assert.deepEqual(info.branches, []);
  assert.deepEqual(info.statusLines, []);
});

test("inspectRepo still detects git repositories", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "accordagents-git-inspect-"));

  try {
    await runCommand("git", ["init"], { cwd: repoPath, timeoutMs: 8000 });
    await writeFile(path.join(repoPath, "readme.md"), "# Test\n", "utf8");

    const service = new GitService();
    const info = await service.inspectRepo(repoPath);

    assert.equal(info.repoPath, repoPath);
    assert.equal(info.isRepo, true);
    assert.equal(info.error, undefined);
    assert.deepEqual(info.statusLines, ["?? readme.md"]);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("inspectRepo does not execute a repository-local git.cmd on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("repository-local command shadowing is Windows-specific");
    return;
  }

  const repoPath = await mkdtemp(path.join(tmpdir(), "accordagents-git-hijack-"));
  try {
    await runCommand("git", ["init"], { cwd: repoPath, timeoutMs: 8000 });
    const markerPath = path.join(repoPath, "git-hijacker-executed.txt");
    await writeFile(
      path.join(repoPath, "git.cmd"),
      `@echo hijacked>"${markerPath}"\r\n@exit /b 1\r\n`,
      "utf8"
    );

    const info = await new GitService().inspectRepo(repoPath);

    assert.equal(info.isRepo, true);
    await assert.rejects(stat(markerPath), (error: unknown) => {
      return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    });
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("searchRepoFiles ranks basename matches and refreshes when index mtime is unknown", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "accordagents-git-files-"));

  try {
    await runCommand("git", ["init"], { cwd: repoPath, timeoutMs: 8000 });
    await mkdir(path.join(repoPath, "src/features/chat"), { recursive: true });
    await mkdir(path.join(repoPath, "docs"), { recursive: true });
    await writeFile(path.join(repoPath, "src/chat"), "chat\n", "utf8");
    await writeFile(path.join(repoPath, "src/chat-panel.ts"), "panel\n", "utf8");
    await writeFile(path.join(repoPath, "docs/my-chat-note.md"), "note\n", "utf8");
    await writeFile(path.join(repoPath, "src/features/chat/index.ts"), "index\n", "utf8");

    const service = new GitService();
    const ranked = await service.searchRepoFiles(repoPath, "chat", 10);

    assert.deepEqual(ranked.map((item) => item.path).slice(0, 4), [
      "src/chat",
      "src/chat-panel.ts",
      "docs/my-chat-note.md",
      "src/features/chat/index.ts"
    ]);

    await writeFile(path.join(repoPath, "beta.ts"), "beta\n", "utf8");

    assert.deepEqual(await service.searchRepoFiles(repoPath, "beta", 10), [{ path: "beta.ts" }]);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

async function repoWithTwoBranches(): Promise<string> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "accordagents-git-switch-"));
  const git = (args: string[]) => runCommand("git", ["-c", "user.email=qa@example.com", "-c", "user.name=QA", ...args], { cwd: repoPath, timeoutMs: 8000 });
  await git(["init", "-b", "main"]);
  await writeFile(path.join(repoPath, "notes.md"), "main\n", "utf8");
  await git(["add", "."]);
  await git(["commit", "-m", "main"]);
  await git(["switch", "-c", "feature"]);
  await writeFile(path.join(repoPath, "notes.md"), "feature\n", "utf8");
  await git(["commit", "-am", "feature"]);
  await git(["switch", "main"]);
  return repoPath;
}

test("switchBranch moves the folder to one of its own branches and refuses a name it does not have", async () => {
  const repoPath = await repoWithTwoBranches();
  try {
    const service = new GitService();
    const before = await service.inspectRepo(repoPath);
    assert.deepEqual(before.localBranches?.sort(), ["feature", "main"]);
    const after = await service.switchBranch(repoPath, "feature");
    assert.equal(after.currentBranch, "feature");
    await assert.rejects(service.switchBranch(repoPath, "--orphan"), /has no branch --orphan/);
    assert.equal((await service.inspectRepo(repoPath)).currentBranch, "feature");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("switchBranch keeps the branch and the uncommitted change when git refuses, with git's own words", async () => {
  const repoPath = await repoWithTwoBranches();
  try {
    await writeFile(path.join(repoPath, "notes.md"), "work in progress\n", "utf8");
    const service = new GitService();
    await assert.rejects(service.switchBranch(repoPath, "feature"), /would be overwritten/);
    const info = await service.inspectRepo(repoPath);
    assert.equal(info.currentBranch, "main");
    assert.deepEqual(info.statusLines, ["M notes.md"]);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
