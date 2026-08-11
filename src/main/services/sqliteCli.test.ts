import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  BundledSqliteInstallationError,
  DAMAGED_SQLITE_INSTALLATION_MESSAGE,
  resolveSqliteExecutable,
  validateSqliteExecutable
} from "./sqliteCli";

test("resolveSqliteExecutable uses sqlite3 outside Windows", () => {
  assert.equal(resolveSqliteExecutable({ platform: "darwin", arch: "arm64" }), "sqlite3");
});

test("resolveSqliteExecutable resolves the unpackaged Windows runtime", () => {
  const appPath = "C:\\work\\AccordAgents";
  const expected = path.join(appPath, "assets", "sqlite", "win32-x64", "sqlite3.exe");

  assert.equal(resolveSqliteExecutable({
    platform: "win32",
    arch: "x64",
    appPath
  }), expected);
});

test("resolveSqliteExecutable resolves the packaged Windows runtime", () => {
  const resourcesPath = "C:\\Program Files\\AccordAgents\\resources";
  const expected = path.join(resourcesPath, "sqlite", "win32-x64", "sqlite3.exe");

  assert.equal(resolveSqliteExecutable({
    platform: "win32",
    arch: "x64",
    resourcesPath,
    isPackaged: true
  }), expected);
});

test("resolveSqliteExecutable does not inspect the bundle during module initialization", () => {
  assert.equal(
    resolveSqliteExecutable({ platform: "win32", arch: "arm64", appPath: "C:\\work\\AccordAgents" }),
    path.join("C:\\work\\AccordAgents", "assets", "sqlite", "win32-arm64", "sqlite3.exe")
  );
});

test("validateSqliteExecutable ignores the external macOS sqlite3 command", async () => {
  await validateSqliteExecutable({ executable: "sqlite3", platform: "darwin", arch: "arm64" });
});

test("validateSqliteExecutable reports a missing Windows bundle as a damaged installation", async () => {
  await assert.rejects(
    validateSqliteExecutable({
      executable: path.join(tmpdir(), "accordagents-missing-sqlite3.exe"),
      platform: "win32",
      arch: "x64"
    }),
    (error: unknown) =>
      error instanceof BundledSqliteInstallationError &&
      error.message.includes(DAMAGED_SQLITE_INSTALLATION_MESSAGE)
  );
});

test("validateSqliteExecutable reports a damaged Windows bundle and recommends reinstalling", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-damaged-sqlite-"));
  const executable = path.join(root, "sqlite3.exe");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(executable, "not sqlite");

  await assert.rejects(
    validateSqliteExecutable({ executable, platform: "win32", arch: "x64" }),
    (error: unknown) =>
      error instanceof BundledSqliteInstallationError &&
      /missing or damaged/.test(error.message) &&
      /Reinstall AccordAgents/.test(error.message)
  );
});
