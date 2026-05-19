import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "./command";
import { GitService } from "./git";

test("searchRepoFiles ranks basename matches and refreshes when index mtime is unknown", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "ai-consensus-git-files-"));

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
