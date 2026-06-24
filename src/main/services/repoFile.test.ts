import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveLocalFile, resolveRepoFile } from "./repoFile";

async function makeRepo(): Promise<{ repo: string; outside: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "accord-repofile-"));
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(repo, "src", "main.ts"), "export {}\n", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
  return { repo, outside, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("resolveRepoFile resolves a repo-relative regular file", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const result = await resolveRepoFile(repo, "src/main.ts");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.absolutePath, path.join(repo, "src", "main.ts"));
  } finally {
    await cleanup();
  }
});

test("resolveRepoFile resolves an absolute path inside the repo", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const result = await resolveRepoFile(repo, path.join(repo, "src", "main.ts"));
    assert.equal(result.ok, true);
  } finally {
    await cleanup();
  }
});

test("resolveRepoFile resolves a real absolute path when the selected repo path is a symlink", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const repoLink = path.join(path.dirname(repo), "repo-link");
    await symlink(repo, repoLink, "dir");
    const realFilePath = await realpath(path.join(repo, "src", "main.ts"));
    const result = await resolveRepoFile(repoLink, realFilePath);
    assert.equal(result.ok, true);
  } finally {
    await cleanup();
  }
});

test("resolveRepoFile rejects a parent-traversal escape", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const result = await resolveRepoFile(repo, "../outside/secret.txt");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "outside-repo");
  } finally {
    await cleanup();
  }
});

test("resolveRepoFile rejects an absolute path outside the repo", async () => {
  const { repo, outside, cleanup } = await makeRepo();
  try {
    const result = await resolveRepoFile(repo, path.join(outside, "secret.txt"));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "outside-repo");
  } finally {
    await cleanup();
  }
});

test("resolveRepoFile rejects a symlink that escapes the repo", async () => {
  const { repo, outside, cleanup } = await makeRepo();
  try {
    await symlink(path.join(outside, "secret.txt"), path.join(repo, "src", "escape.txt"));
    const result = await resolveRepoFile(repo, "src/escape.txt");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "outside-repo");
  } finally {
    await cleanup();
  }
});

test("resolveRepoFile rejects a directory", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const result = await resolveRepoFile(repo, "src");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "directory");
  } finally {
    await cleanup();
  }
});

test("resolveRepoFile reports a missing file", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const result = await resolveRepoFile(repo, "src/missing.ts");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "not-found");
  } finally {
    await cleanup();
  }
});

test("resolveRepoFile rejects an invalid path", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const result = await resolveRepoFile(repo, "   ");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "invalid-path");
  } finally {
    await cleanup();
  }
});

test("resolveRepoFile reports a missing repo", async () => {
  const result = await resolveRepoFile("", "src/main.ts");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "repo-missing");
});

test("resolveLocalFile resolves an absolute file outside the repo", async () => {
  const { outside, cleanup } = await makeRepo();
  try {
    const outsideFile = path.join(outside, "secret.txt");
    const result = await resolveLocalFile(undefined, outsideFile);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.absolutePath, outsideFile);
    assert.equal(result.ok && result.insideWorkspace, false);
  } finally {
    await cleanup();
  }
});

test("resolveLocalFile resolves relative paths inside the selected workspace", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const result = await resolveLocalFile(repo, "src/main.ts");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.absolutePath, path.join(repo, "src", "main.ts"));
    assert.equal(result.ok && result.insideWorkspace, true);
  } finally {
    await cleanup();
  }
});

test("resolveLocalFile resolves parent-relative paths outside the selected workspace", async () => {
  const { repo, outside, cleanup } = await makeRepo();
  try {
    const result = await resolveLocalFile(repo, "../outside/secret.txt");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.absolutePath, path.join(outside, "secret.txt"));
    assert.equal(result.ok && result.insideWorkspace, false);
  } finally {
    await cleanup();
  }
});

test("resolveLocalFile requires a selected workspace for relative paths", async () => {
  const result = await resolveLocalFile(undefined, "src/main.ts");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "base-missing");
});

test("resolveLocalFile rejects NUL paths", async () => {
  const result = await resolveLocalFile(undefined, "/tmp/a\0b");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "invalid-path");
});

test("resolveLocalFile reports non-regular files", async () => {
  const result = await resolveLocalFile(undefined, "/dev/null");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "not-regular-file");
});

test("resolveLocalFile classifies symlink escapes as outside the selected workspace", async () => {
  const { repo, outside, cleanup } = await makeRepo();
  try {
    await symlink(path.join(outside, "secret.txt"), path.join(repo, "src", "escape.txt"));
    const result = await resolveLocalFile(repo, "src/escape.txt");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.absolutePath, path.join(repo, "src", "escape.txt"));
    assert.equal(result.ok && result.insideWorkspace, false);
    assert.equal(result.ok && result.realPath, await realpath(path.join(outside, "secret.txt")));
  } finally {
    await cleanup();
  }
});

test("resolveLocalFile rejects directories and missing files", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const directory = await resolveLocalFile(repo, "src");
    assert.equal(directory.ok, false);
    assert.equal(directory.ok === false && directory.reason, "directory");

    const missing = await resolveLocalFile(repo, "src/missing.ts");
    assert.equal(missing.ok, false);
    assert.equal(missing.ok === false && missing.reason, "not-found");
  } finally {
    await cleanup();
  }
});
