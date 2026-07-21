import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
