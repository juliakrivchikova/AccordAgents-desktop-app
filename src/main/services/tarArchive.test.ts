import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { createGzip } from "node:zlib";
import { tarArchive, type TarEntry } from "./tarArchive";

test("what a Windows computer sends arrives whole: nested, long, non-ASCII and empty files, read by the system tar", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aa tar "));
  try {
    const source = path.join(root, "source");
    const longDir = `${"deep-folder-name-".repeat(6)}end`;
    const files: Record<string, Buffer> = {
      "README.md": Buffer.from("line one\r\nline two\r\n"),
      [`src/${longDir}/${"file-name-".repeat(8)}.ts`]: Buffer.from("export const long = true;\n"),
      "docs/заметки.md": Buffer.from("кириллица\n"),
      // Pax records of 99 and 101 bytes: the length that counts its own digits
      // gains a digit between them.
      [`ё${"a".repeat(86)}`]: Buffer.from("99\n"),
      [`ё${"a".repeat(87)}`]: Buffer.from("101\n"),
      "empty.txt": Buffer.alloc(0),
      "blob.bin": Buffer.from(Array.from({ length: 70_000 }, (_, index) => index % 251)),
      "gradlew": Buffer.from("#!/bin/sh\necho hi\n")
    };
    const entries: TarEntry[] = [{ path: "", kind: "directory", mode: 0o755, mtimeMs: Date.now() }];
    for (const directory of ["docs", "src", `src/${longDir}`]) {
      await mkdir(path.join(source, ...directory.split("/")), { recursive: true });
      entries.push({ path: directory, kind: "directory", mode: 0o755, mtimeMs: Date.now() });
    }
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(source, ...relative.split("/"));
      await writeFile(file, content);
      await utimes(file, new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 1)));
      entries.push({ path: relative, kind: "file", mode: relative === "gradlew" ? 0o755 : 0o644, mtimeMs: 0, size: content.length });
    }
    let counted = 0;
    await pipeline(tarArchive(source, entries, (bytes) => { counted += bytes; }), createGzip(), createWriteStream(path.join(root, "archive.tar.gz")));
    assert.equal(counted, Object.values(files).reduce((sum, content) => sum + content.length, 0));

    await mkdir(path.join(root, "output"));
    // Relative paths: GNU tar (Git Bash) reads "C:" in an absolute one as a host.
    execFileSync("tar", ["-xzf", "archive.tar.gz", "-C", "output"], { cwd: root });
    for (const [relative, content] of Object.entries(files)) {
      assert.deepEqual(await readFile(path.join(root, "output", ...relative.split("/"))), content, relative);
    }
    assert.equal((await stat(path.join(root, "output", "README.md"))).mtime.getTime(), Date.UTC(2026, 9, 1));
    if (process.platform !== "win32") {
      assert.equal((await stat(path.join(root, "output", "gradlew"))).mode & 0o777, 0o755);
      assert.equal((await stat(path.join(root, "output", "README.md"))).mode & 0o111, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file saved after the walk goes whole as it is when read, one deleted since is left out, a script is executable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aa tar changed "));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    // .git/index rewritten by git between the walk and the read.
    await writeFile(path.join(source, "index"), "rewritten and longer than when it was walked");
    await writeFile(path.join(source, "run.sh"), "#!/bin/sh\necho hi\n");
    const entries: TarEntry[] = [
      { path: "", kind: "directory", mode: 0o755, mtimeMs: Date.now() },
      { path: "index", kind: "file", mode: 0o644, mtimeMs: Date.now(), size: 12 },
      { path: "gone.txt", kind: "file", mode: 0o644, mtimeMs: Date.now(), size: 3 },
      { path: "run.sh", kind: "file", mode: 0o644, mtimeMs: Date.now(), size: 18 }
    ];
    await pipeline(tarArchive(source, entries), createGzip(), createWriteStream(path.join(root, "archive.tar.gz")));
    await mkdir(path.join(root, "output"));
    execFileSync("tar", ["-xzf", "archive.tar.gz", "-C", "output"], { cwd: root });
    assert.equal(await readFile(path.join(root, "output", "index"), "utf8"), "rewritten and longer than when it was walked");
    await assert.rejects(stat(path.join(root, "output", "gone.txt")));
    const listing = execFileSync("tar", ["-tvzf", "archive.tar.gz"], { cwd: root, encoding: "utf8" });
    assert.match(listing, /^-rwxr-xr-x .*run\.sh$/m, "a file that starts with #! is executable on Linux");
    assert.match(listing, /^-rw-r--r-- .*index$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
