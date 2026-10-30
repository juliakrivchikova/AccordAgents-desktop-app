import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FILE_PREVIEW_TEXT_EDIT_LIMIT, parseCsv, utf8SafePrefixLength } from "../../shared/filePreview";
import type { FilePreviewChangedEvent } from "../../shared/types";
import { FilePreviewService, sha256 } from "./filePreview";
import { WorkspaceFileResolver } from "./workspaceFiles";

async function setup(options: { worktrees?: string[] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aa-file-preview-"));
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  const userData = path.join(root, "userData");
  await mkdir(repo, { recursive: true });
  await mkdir(outside, { recursive: true });
  const events: FilePreviewChangedEvent[] = [];
  const resolver = new WorkspaceFileResolver(async () => options.worktrees ?? []);
  const service = new FilePreviewService(
    { conversationRepoPath: async (id) => (id === "chat" ? { repoPath: repo } : undefined) },
    resolver,
    userData,
    (event) => events.push(event)
  );
  return { root, repo, outside, userData, service, events, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const waitFor = async (check: () => boolean, ms = 3_000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("a text file in the project reads whole and editable; outside the project read-only", async () => {
  const env = await setup();
  try {
    await writeFile(path.join(env.repo, "notes.md"), "# Hi\n");
    await writeFile(path.join(env.outside, "x.txt"), "outside\n");
    const inside = await env.service.read({ conversationId: "chat", path: "notes.md" });
    assert.equal(inside.kind, "markdown");
    assert.equal(inside.text, "# Hi\n");
    assert.equal(inside.editable, true);
    assert.equal(inside.hash, sha256(Buffer.from("# Hi\n")));
    const away = await env.service.read({ conversationId: "chat", path: path.join(env.outside, "x.txt") });
    assert.equal(away.insideWorkspace, false);
    assert.equal(away.editable, false);
    assert.match(away.readOnlyReason ?? "", /outside the project/);
  } finally {
    await env.cleanup();
  }
});

test("a file in a git worktree of the project counts as the project", async () => {
  const env = await setup();
  const worktree = path.join(env.root, "repo-feature");
  await mkdir(worktree);
  const { realpath } = await import("node:fs/promises");
  const withTree = await setup({ worktrees: [await realpath(worktree)] });
  try {
    // The second setup's chat points at its own repo; the worktree is listed for it.
    await writeFile(path.join(worktree, "a.ts"), "export {}\n");
    const preview = await withTree.service.read({ conversationId: "chat", path: path.join(worktree, "a.ts") });
    assert.equal(preview.insideWorkspace, true);
    assert.equal(preview.editable, true);
  } finally {
    await env.cleanup();
    await withTree.cleanup();
  }
});

test("binary content, a BOM, invalid UTF-8 and a large file are told apart", async () => {
  const env = await setup();
  try {
    await writeFile(path.join(env.repo, "blob.txt"), Buffer.from([0x61, 0x00, 0x62]));
    assert.equal((await env.service.read({ conversationId: "chat", path: "blob.txt" })).kind, "unsupported");

    await writeFile(path.join(env.repo, "bom.csv"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n")]));
    const bom = await env.service.read({ conversationId: "chat", path: "bom.csv" });
    assert.equal(bom.bom, true);
    assert.equal(bom.text, "a,b\n");

    await writeFile(path.join(env.repo, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const latin = await env.service.read({ conversationId: "chat", path: "latin.txt" });
    assert.equal(latin.utf8, false);
    assert.equal(latin.editable, false);

    const big = "é".repeat(FILE_PREVIEW_TEXT_EDIT_LIMIT / 2 + 10);
    await writeFile(path.join(env.repo, "big.log"), big);
    const large = await env.service.read({ conversationId: "chat", path: "big.log" });
    assert.equal(large.truncated, true);
    assert.equal(large.editable, false);
    // Cut on a character boundary: the shown text is valid UTF-8 and only é's.
    assert.equal(large.utf8, true);
    assert.match(large.text ?? "", /^é+$/);
  } finally {
    await env.cleanup();
  }
});

test("a save writes in place; a change on disk since the read is a conflict, never overwritten", async () => {
  const env = await setup();
  const file = path.join(env.repo, "a.txt");
  try {
    await writeFile(file, "one\n");
    const preview = await env.service.read({ conversationId: "chat", path: "a.txt" });
    const saved = await env.service.write({ conversationId: "chat", path: "a.txt", content: "two\n", baseHash: preview.hash });
    assert.equal(saved.ok, true);
    assert.equal(await readFile(file, "utf8"), "two\n");

    await writeFile(file, "agent\n");
    const stale = await env.service.write({ conversationId: "chat", path: "a.txt", content: "mine\n", baseHash: preview.hash });
    assert.deepEqual(stale, { ok: false, conflict: true, reason: "changed" });
    assert.equal(await readFile(file, "utf8"), "agent\n");

    await rm(file);
    const gone = await env.service.write({ conversationId: "chat", path: "a.txt", content: "mine\n", baseHash: sha256(Buffer.from("agent\n")) });
    assert.deepEqual(gone, { ok: false, conflict: true, reason: "deleted" });
  } finally {
    await env.cleanup();
  }
});

test("a save keeps a symlink a symlink and writes the BOM back", async () => {
  const env = await setup();
  try {
    const target = path.join(env.repo, "real.csv");
    await writeFile(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\n")]));
    await symlink(target, path.join(env.repo, "link.csv"));
    const preview = await env.service.read({ conversationId: "chat", path: "link.csv" });
    const saved = await env.service.write({ conversationId: "chat", path: "link.csv", content: "b\n", baseHash: preview.hash, bom: preview.bom });
    assert.equal(saved.ok, true);
    const { lstat } = await import("node:fs/promises");
    assert.equal((await lstat(path.join(env.repo, "link.csv"))).isSymbolicLink(), true);
    assert.deepEqual([...(await readFile(target))], [0xef, 0xbb, 0xbf, 0x62, 0x0a]);
  } finally {
    await env.cleanup();
  }
});

test("files outside the project and kinds the panel does not edit are refused", async () => {
  const env = await setup();
  try {
    await writeFile(path.join(env.outside, "x.txt"), "x");
    const away = await env.service.read({ conversationId: "chat", path: path.join(env.outside, "x.txt") });
    const result = await env.service.write({ conversationId: "chat", path: path.join(env.outside, "x.txt"), content: "y", baseHash: away.hash });
    assert.equal(result.ok, false);
    assert.equal(await readFile(path.join(env.outside, "x.txt"), "utf8"), "x");

    await writeFile(path.join(env.repo, "p.png"), Buffer.from([0x89, 0x50]));
    const image = await env.service.write({ conversationId: "chat", path: "p.png", content: "x", baseHash: sha256(Buffer.from([0x89, 0x50])) });
    assert.equal(image.ok, false);
  } finally {
    await env.cleanup();
  }
});

test("the protocol serves only what the panel was given, never dot files, never cross-origin", async () => {
  const env = await setup();
  try {
    await mkdir(path.join(env.repo, "site", "img"), { recursive: true });
    await writeFile(path.join(env.repo, "site", "index.html"), "<p>hi</p>");
    await writeFile(path.join(env.repo, "site", "img", "a.svg"), "<svg/>");
    await writeFile(path.join(env.repo, "site", ".env"), "SECRET=1");
    await writeFile(path.join(env.repo, "secret.txt"), "no");
    const page = await env.service.read({ conversationId: "chat", path: "site/index.html" });
    assert.equal(page.kind, "html");
    assert.ok(page.url?.startsWith("accord-file://"));
    const base = page.url!.slice(0, page.url!.lastIndexOf("/") + 1);

    const ok = await env.service.handleProtocolRequest(new Request(page.url!));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(ok.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(await ok.text(), "<p>hi</p>");
    assert.equal((await env.service.handleProtocolRequest(new Request(`${base}img/a.svg`))).status, 200);
    assert.equal((await env.service.handleProtocolRequest(new Request(`${base}.env`))).status, 404);
    assert.equal((await env.service.handleProtocolRequest(new Request(`${base}..%2Fsecret.txt`))).status, 404);
    assert.equal((await env.service.handleProtocolRequest(new Request("accord-file://not-a-token/index.html"))).status, 404);

    env.service.release(page.realPath);
    assert.equal((await env.service.handleProtocolRequest(new Request(page.url!))).status, 404);
  } finally {
    await env.cleanup();
  }
});

test("the watcher reports another program's change, not the panel's own save, and a deletion", async () => {
  const env = await setup();
  const file = path.join(env.repo, "w.txt");
  try {
    await writeFile(file, "a\n");
    const preview = await env.service.read({ conversationId: "chat", path: "w.txt" });
    await env.service.watch({ conversationId: "chat", path: "w.txt" });

    const saved = await env.service.write({ conversationId: "chat", path: "w.txt", content: "b\n", baseHash: preview.hash });
    assert.equal(saved.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(env.events.length, 0, "the panel's own save is not a change");

    // An agent replaces the file the usual way: write a temp file, rename it over.
    await writeFile(`${file}.tmp`, "c\n");
    await rename(`${file}.tmp`, file);
    await waitFor(() => env.events.some((event) => event.change === "changed"));
    assert.equal(env.events.find((event) => event.change === "changed")?.hash, sha256(Buffer.from("c\n")));

    await rm(file);
    await waitFor(() => env.events.some((event) => event.change === "deleted"));
  } finally {
    env.service.releaseAll();
    await env.cleanup();
  }
});

test("unsaved edits are kept in userData until cleared", async () => {
  const env = await setup();
  try {
    await env.service.saveUnsaved({ conversationId: "chat", path: "a.txt", realPath: "/x/a.txt", baseHash: "h", text: "draft", updatedAt: "" });
    const listed = await env.service.listUnsaved();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].text, "draft");
    assert.equal(listed[0].conversationId, "chat");
    await env.service.clearUnsaved("/x/a.txt");
    assert.equal((await env.service.listUnsaved()).length, 0);
  } finally {
    await env.cleanup();
  }
});

test("CSV parsing follows RFC 4180 and stops at the row limit", () => {
  const parsed = parseCsv("a,\"b,c\",\"say \"\"hi\"\"\"\r\n1,\"two\nlines\",3\n", ",");
  assert.deepEqual(parsed.rows, [["a", "b,c", "say \"hi\""], ["1", "two\nlines", "3"]]);
  const limited = parseCsv("x\ny\nz\n", ",", 2);
  assert.equal(limited.rows.length, 2);
  assert.equal(limited.truncated, true);
});

test("a UTF-8 cut never splits a character", () => {
  const bytes = Buffer.from("aé");
  assert.equal(utf8SafePrefixLength(bytes, 2), 1);
  assert.equal(utf8SafePrefixLength(bytes, 3), 3);
});

test("a real git worktree of the chat's repository is read from git", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(path.join(os.tmpdir(), "aa-worktree-"));
  try {
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=qa@example.invalid", "-c", "user.name=QA", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = path.join(root, "repo-task");
    git("worktree", "add", "-q", worktree);
    await writeFile(path.join(worktree, "x.ts"), "export {}\n");
    const resolver = new WorkspaceFileResolver();
    const inside = await resolver.resolve(repo, path.join(worktree, "x.ts"));
    assert.equal(inside.ok && inside.insideWorkspace, true);
    await writeFile(path.join(root, "loose.ts"), "x\n");
    const loose = await resolver.resolve(repo, path.join(root, "loose.ts"));
    assert.equal(loose.ok && loose.insideWorkspace, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
