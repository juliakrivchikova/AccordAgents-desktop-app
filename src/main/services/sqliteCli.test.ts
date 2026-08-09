import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveSqliteExecutable } from "./sqliteCli";

test("resolveSqliteExecutable uses sqlite3 outside Windows", () => {
  assert.equal(resolveSqliteExecutable({ platform: "darwin", arch: "arm64" }), "sqlite3");
});

test("resolveSqliteExecutable resolves the unpackaged Windows runtime", () => {
  const appPath = "C:\\work\\AccordAgents";
  const expected = path.join(appPath, "assets", "sqlite", "win32-x64", "sqlite3.exe");

  assert.equal(resolveSqliteExecutable({
    platform: "win32",
    arch: "x64",
    appPath,
    existsSync: (filePath) => filePath === expected
  }), expected);
});

test("resolveSqliteExecutable resolves the packaged Windows runtime", () => {
  const resourcesPath = "C:\\Program Files\\AccordAgents\\resources";
  const expected = path.join(resourcesPath, "sqlite", "win32-x64", "sqlite3.exe");

  assert.equal(resolveSqliteExecutable({
    platform: "win32",
    arch: "x64",
    resourcesPath,
    isPackaged: true,
    existsSync: (filePath) => filePath === expected
  }), expected);
});

test("resolveSqliteExecutable rejects unsupported Windows architectures", () => {
  assert.throws(
    () => resolveSqliteExecutable({ platform: "win32", arch: "arm64" }),
    /Windows x64 only; received arm64/
  );
});

test("resolveSqliteExecutable rejects a missing bundled executable", () => {
  assert.throws(
    () => resolveSqliteExecutable({
      platform: "win32",
      arch: "x64",
      appPath: "C:\\work\\AccordAgents",
      existsSync: () => false
    }),
    /Bundled SQLite executable is missing/
  );
});
