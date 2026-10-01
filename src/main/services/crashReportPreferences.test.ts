import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setHostPlatform } from "../platform";
import {
  CRASH_REPORTS_OFF_MARKER,
  CRASH_REPORT_CACHE_DIR,
  CRASH_REPORT_INSTALL_ID_FILE,
  discardCrashReportData,
  loadOrCreateCrashReportInstallId,
  readCrashReportsChoice,
  readCrashReportsEnabled,
  writeCrashReportsChoice
} from "./crashReportPreferences";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "accord-crash-reports-"));
  try {
    await run(dir);
  } finally {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

test("reports are on for a new profile and off once the User turned them off", async () => {
  await withTempDir(async (dir) => {
    assert.equal(readCrashReportsEnabled(dir, {}), true);
    writeCrashReportsChoice(dir, false);
    assert.equal(readCrashReportsEnabled(dir, {}), false);
    writeCrashReportsChoice(dir, true);
    assert.equal(readCrashReportsEnabled(dir, {}), true);
    // Turning on twice, or on a profile that never turned them off, is fine.
    writeCrashReportsChoice(dir, true);
    assert.equal(readCrashReportsEnabled(dir, {}), true);
  });
});

test("an unreadable profile keeps reports off rather than on", async () => {
  await withTempDir(async (dir) => {
    const locked = path.join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      assert.equal(readCrashReportsChoice(locked), false);
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

test("the environment can silence a QA or test instance", async () => {
  await withTempDir(async (dir) => {
    assert.equal(readCrashReportsEnabled(dir, { ACCORDAGENTS_CRASH_REPORTS: "0" }), false);
    assert.equal(readCrashReportsEnabled(dir, { ACCORDAGENTS_CRASH_REPORTS: "off" }), false);
    assert.equal(readCrashReportsEnabled(dir, { ACCORDAGENTS_CRASH_REPORTS: "1" }), true);
  });
});

test("what the SDK kept for later is discarded, and nothing else", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, CRASH_REPORT_CACHE_DIR, "queue"), { recursive: true });
    await writeFile(path.join(dir, CRASH_REPORT_CACHE_DIR, "queue", "queue-v2.json"), "[]");
    await writeFile(path.join(dir, "settings.json"), "{}");
    discardCrashReportData(dir);
    assert.equal(await exists(path.join(dir, CRASH_REPORT_CACHE_DIR)), false);
    assert.equal(await exists(path.join(dir, "settings.json")), true);
    discardCrashReportData(dir);
  });
});

test("the install id is created once and then reused", async () => {
  await withTempDir(async (dir) => {
    const first = loadOrCreateCrashReportInstallId(dir);
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(loadOrCreateCrashReportInstallId(dir), first);
    assert.equal((await readFile(path.join(dir, CRASH_REPORT_INSTALL_ID_FILE), "utf8")).trim(), first);
  });
});

test("a damaged install id is replaced, and an unwritable profile still gets an id", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, CRASH_REPORT_INSTALL_ID_FILE), "julia's laptop\n");
    assert.match(loadOrCreateCrashReportInstallId(dir), /^[0-9a-f-]{36}$/);
    const locked = path.join(dir, "locked");
    await mkdir(locked, { mode: 0o500 });
    assert.match(loadOrCreateCrashReportInstallId(locked), /^[0-9a-f-]{36}$/);
    await chmod(locked, 0o700);
  });
});

test("the window's preload looks for the same launch argument the main process passes", async () => {
  const root = process.cwd();
  const main = await readFile(path.join(root, "src/main/services/crashReporting.ts"), "utf8");
  const preload = await readFile(path.join(root, "src/preload/index.ts"), "utf8");
  const literal = main.match(/CRASH_REPORTS_ACTIVE_ARG = "([^"]+)"/)?.[1];
  assert.ok(literal);
  assert.ok(preload.includes(`CRASH_REPORTS_ACTIVE_ARG = "${literal}"`));
});

test("the Settings switch is what the next launch reads, and settings.json writes cannot undo it", async () => {
  await withTempDir(async (dir) => {
    const previous = process.env.ACCORDAGENTS_USER_DATA_DIR;
    process.env.ACCORDAGENTS_USER_DATA_DIR = dir;
    setHostPlatform(undefined);
    try {
      const { SettingsService } = await import("./settings");
      const settings = new SettingsService();
      assert.equal((await settings.getPublicSettings()).crashReports, true);
      assert.equal((await settings.setCrashReports(false)).crashReports, false);
      assert.equal(readCrashReportsEnabled(dir, {}), false);
      assert.equal(await exists(path.join(dir, CRASH_REPORTS_OFF_MARKER)), true);
      // Another settings write, or a build without this switch rewriting
      // settings.json, leaves the choice alone.
      await settings.setBetaUpdates(true);
      await writeFile(path.join(dir, "settings.json"), JSON.stringify({ roundLimitDefault: 1 }));
      assert.equal(readCrashReportsEnabled(dir, {}), false);
      assert.equal((await settings.setCrashReports(true)).crashReports, true);
      assert.equal(readCrashReportsEnabled(dir, {}), true);
    } finally {
      if (previous === undefined) delete process.env.ACCORDAGENTS_USER_DATA_DIR;
      else process.env.ACCORDAGENTS_USER_DATA_DIR = previous;
      setHostPlatform(undefined);
    }
  });
});
