import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRepoFile } from "./repoFile";

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
