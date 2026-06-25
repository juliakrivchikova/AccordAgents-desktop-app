import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalFileOpenerService } from "./localFileOpener";
import type { Conversation, LocalFileOpenAction } from "../../shared/types";
import type { IntellijLauncher, IntellijOpenRequest, IntellijOpenResult } from "./intellijLauncher";

async function makeWorkspace(): Promise<{ repo: string; filePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "accord-local-opener-"));
  const repo = path.join(root, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  const filePath = path.join(repo, "src", "main.ts");
  await writeFile(filePath, "export {}\n", "utf8");
  return { repo, filePath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function conversation(repoPath: string): Conversation {
  return {
    id: "conversation-1",
    title: "Chat",
    kind: "chat",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    repoPath,
    messages: [],
    findings: [],
    metadata: {}
  };
}

function serviceWithDeps(options: {
  repoPath: string;
  savedAction?: LocalFileOpenAction;
  intellijResult: IntellijOpenResult;
  openPathResult?: string;
}) {
  const openPaths: string[] = [];
  const intellijRequests: IntellijOpenRequest[] = [];
  const intellijLauncher: IntellijLauncher = {
    clearCache: () => undefined,
    openFile: async (request) => {
      intellijRequests.push(request);
      return options.intellijResult;
    }
  };
  const service = new LocalFileOpenerService(
    {
      getConversation: async () => conversation(options.repoPath)
    } as any,
    {
      getRepoFileOpenAction: async () => options.savedAction
    } as any,
    {
      intellijLauncher,
      shell: {
        openPath: async (filePath) => {
          openPaths.push(filePath);
          return options.openPathResult ?? "";
        },
        showItemInFolder: () => undefined
      }
    }
  );
  return { service, openPaths, intellijRequests };
}

test("openLocalFile opens explicit IntelliJ action with line navigation support", async () => {
  const { repo, cleanup } = await makeWorkspace();
  try {
    const { service, openPaths, intellijRequests } = serviceWithDeps({
      repoPath: repo,
      intellijResult: { opened: true, lineNavigationSupported: true }
    });

    const result = await service.openLocalFile({
      conversationId: "conversation-1",
      path: "src/main.ts",
      line: 7,
      column: 2,
      action: "intellij-idea"
    });

    assert.equal(result.action, "intellij-idea");
    assert.equal(result.lineNavigationSupported, true);
    assert.deepEqual(openPaths, []);
    assert.equal(intellijRequests.length, 1);
    assert.equal(intellijRequests[0]?.line, 7);
    assert.equal(intellijRequests[0]?.column, 2);
  } finally {
    await cleanup();
  }
});

test("openLocalFile falls back to default app when saved IntelliJ preference cannot launch", async () => {
  const { repo, filePath, cleanup } = await makeWorkspace();
  try {
    const { service, openPaths } = serviceWithDeps({
      repoPath: repo,
      savedAction: "intellij-idea",
      intellijResult: { opened: false, message: "IntelliJ IDEA launcher was not found." }
    });

    const result = await service.openLocalFile({
      conversationId: "conversation-1",
      path: "src/main.ts",
      line: 7
    });

    assert.equal(result.action, "open");
    assert.equal(result.lineNavigationSupported, false);
    assert.match(result.fallbackMessage ?? "", /Opened with the default app instead/);
    assert.deepEqual(openPaths, [filePath]);
  } finally {
    await cleanup();
  }
});

test("openLocalFile does not fall back silently when explicit IntelliJ action fails", async () => {
  const { repo, cleanup } = await makeWorkspace();
  try {
    const { service, openPaths } = serviceWithDeps({
      repoPath: repo,
      intellijResult: { opened: false, message: "IntelliJ IDEA launcher was not found." }
    });

    await assert.rejects(
      () => service.openLocalFile({
        conversationId: "conversation-1",
        path: "src/main.ts",
        action: "intellij-idea"
      }),
      /IntelliJ IDEA launcher was not found/
    );
    assert.deepEqual(openPaths, []);
  } finally {
    await cleanup();
  }
});
