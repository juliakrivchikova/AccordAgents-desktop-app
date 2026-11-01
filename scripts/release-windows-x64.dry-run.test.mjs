import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mergeWindowsNotes, sourceTagFailure, validateWindowsUpdateResponse } from "./release-windows-x64.mjs";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-windows-x64.mjs");

// The script works on the package.json of the directory it runs in.
function dryRun(t, version, args) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "accordagents-windows-dry-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "accordagents",
    productName: "AccordAgents",
    version,
    config: { releaseRepo: "example/stable", betaReleaseRepo: "example/beta" }
  }));
  return spawnSync(process.execPath, [scriptPath, ...args, "--dry-run"], {
    cwd: dir,
    env: { ...process.env, RELEASE_REPO: "", UPDATE_FROM_VERSION: "" },
    encoding: "utf8"
  });
}

test("Windows package-only dry-run builds the unsigned app and publishes nothing", (t) => {
  const { status, stdout } = dryRun(t, "1.2.4-beta.1", ["--package-only"]);

  assert.equal(status, 0);
  assert.match(stdout, /Build: npm run package -- --platform=win32 --arch=x64 \(unsigned\)/);
  assert.match(stdout, /Publish: no/);
});

test("Windows publish-only dry-run publishes a stable version to the stable repo without building", (t) => {
  const { status, stdout } = dryRun(t, "1.2.3", ["--publish-only", "--skip-update-check"]);

  assert.equal(status, 0);
  assert.match(stdout, /Release repo: example\/stable/);
  assert.match(stdout, /Build: no \(publishes out[\\/]windows-release\)/);
  assert.match(stdout, /Publish: v1\.2\.3 in example\/stable/);
  assert.match(stdout, /Update check: skipped/);
});

// Windows apps follow only the stable feed, so a prerelease would reach nobody.
test("Windows publish-only refuses a prerelease", (t) => {
  const { status, stderr } = dryRun(t, "1.2.4-beta.1", ["--publish-only", "--skip-update-check"]);

  assert.equal(status, 1);
  assert.match(stderr, /Windows ships only with stable releases; 1\.2\.4-beta\.1 is a prerelease/);
});

test("Windows publish-only dry-run checks the RELEASES Squirrel reads", (t) => {
  const { stdout } = dryRun(t, "1.2.3", ["--publish-only", "--from-version", "1.2.2"]);

  // The bare feed URL answers with JSON that never names the package.
  assert.match(stdout, /Update check: enabled from 1\.2\.2 \(https:\/\/update\.electronjs\.org\/example\/stable\/win32-x64\/1\.2\.2\/RELEASES\)/);
});

const macNotes = "AccordAgents v1.2.3\n\nArtifacts:\n- DMG\n\nChecksums:\n- `abc  AccordAgents-1.2.3-arm64.dmg`\n";
const section = (line) => `<!-- windows-x64 -->\nWindows x64:\n- ${line}\n<!-- /windows-x64 -->`;
const windowsSection = section("`def  AccordAgents-1.2.3-win32-x64-Setup.exe`");
const handNote = "Known issue: added by hand.";

for (const [name, body, expected] of [
  ["appends the Windows section after the macOS notes", macNotes, `${macNotes.trimEnd()}\n\n${windowsSection}`],
  ["replaces the Windows section of an earlier run", `${macNotes}\n${section("stale")}\n`, `${macNotes.trimEnd()}\n\n${windowsSection}`],
  ["keeps what was added by hand below the Windows section", `${macNotes}\n${section("stale")}\n\n${handNote}\n`, `${macNotes.trimEnd()}\n\n${windowsSection}\n\n${handNote}`],
  ["writes only the Windows section into empty notes", "", windowsSection]
]) {
  test(`Windows release notes ${name}`, () => {
    assert.equal(mergeWindowsNotes(body, windowsSection), expected);
  });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function releaseCheckFixture({ createTag = true, advanceAfterTag = false, pushTag = false, retagAtHead = false } = {}) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "accordagents-windows-release-"));
  const repoDir = path.join(tempRoot, "repo");
  const remoteDir = path.join(tempRoot, "origin.git");
  git(tempRoot, ["init", "--bare", remoteDir]);
  git(tempRoot, ["init", repoDir]);
  git(repoDir, ["config", "user.name", "AccordAgents Test"]);
  git(repoDir, ["config", "user.email", "accordagents@example.invalid"]);
  git(repoDir, ["remote", "add", "origin", remoteDir]);
  writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "accordagents",
    version: "1.2.3",
    config: { releaseRepo: "example/accordagents" }
  }));
  git(repoDir, ["add", "package.json"]);
  git(repoDir, ["commit", "-m", "Initial"]);
  if (createTag) {
    git(repoDir, ["tag", "v1.2.3"]);
  }
  if (pushTag) {
    git(repoDir, ["push", "origin", "v1.2.3"]);
  }
  if (advanceAfterTag) {
    writeFileSync(path.join(repoDir, "next.txt"), "next\n");
    git(repoDir, ["add", "next.txt"]);
    git(repoDir, ["commit", "-m", "Advance"]);
  }
  if (retagAtHead) {
    git(repoDir, ["tag", "-f", "v1.2.3"]);
  }
  return repoDir;
}

function sourceTagCheck(t, fixtureOptions) {
  const repoDir = releaseCheckFixture(fixtureOptions);
  t.after(() => rmSync(path.dirname(repoDir), { recursive: true, force: true }));
  return sourceTagFailure("v1.2.3", repoDir);
}

test("Windows release accepts a source tag that matches HEAD locally and on origin", (t) => {
  assert.equal(sourceTagCheck(t, { pushTag: true }), "");
});

test("Windows release rejects a missing local source tag", (t) => {
  assert.match(
    sourceTagCheck(t, { createTag: false }),
    /Source tag v1\.2\.3 must exist before publishing/
  );
});

test("Windows release rejects a local source tag that does not point at HEAD", (t) => {
  assert.match(
    sourceTagCheck(t, { advanceAfterTag: true, pushTag: true }),
    /Local tag v1\.2\.3 points at .+, not current HEAD .+\./
  );
});

test("Windows release rejects a source tag missing from origin", (t) => {
  assert.match(
    sourceTagCheck(t, {}),
    /Source tag v1\.2\.3 must exist on origin/
  );
});

test("Windows release rejects a remote source tag that does not point at HEAD", (t) => {
  assert.match(
    sourceTagCheck(t, { pushTag: true, advanceAfterTag: true, retagAtHead: true }),
    /Remote tag v1\.2\.3 points at .+, not current HEAD .+\./
  );
});

test("Windows update verification rejects a stale release feed", () => {
  assert.throws(() => validateWindowsUpdateResponse({
    endpoint: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2/RELEASES",
    status: 200,
    statusText: "OK",
    url: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2/RELEASES",
    body: "ABC old-accordagents-1.2.2-full.nupkg 123"
  }, "1.2.3"), /did not mention expected version 1\.2\.3/);
});

test("Windows update verification accepts the expected NuGet package version", () => {
  assert.doesNotThrow(() => validateWindowsUpdateResponse({
    endpoint: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2/RELEASES",
    status: 200,
    statusText: "OK",
    url: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2/RELEASES",
    // The form update.electronjs.org serves (checked against a live feed on 2026-10-31).
    body: "﻿2A2B https://github.com/example/accordagents/releases/download/v1.2.3/accordagents-1.2.3-full.nupkg 123"
  }, "1.2.3"));
});

test("Windows update verification rejects a near-prefix package version", () => {
  assert.throws(() => validateWindowsUpdateResponse({
    endpoint: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2/RELEASES",
    status: 200,
    statusText: "OK",
    url: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2/RELEASES",
    body: "ABC accordagents-1.2.30-full.nupkg 123"
  }, "1.2.3"), /did not mention expected version 1\.2\.3/);
});
