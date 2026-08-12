import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sourceTagFailure, validateWindowsUpdateResponse } from "./release-windows-x64.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function dryRun(args, env = {}) {
  return execFileSync(process.execPath, ["scripts/release-windows-x64.mjs", ...args, "--dry-run"], {
    cwd: rootDir,
    env: { ...process.env, RELEASE_REPO: "", ...env },
    encoding: "utf8"
  });
}

test("Windows release dry-run uses the beta update repository and Squirrel maker", () => {
  const output = dryRun(["--skip-update-check"]);

  assert.match(output, /Release channel: beta/);
  assert.match(output, /Release repo: juliakrivchikova\/AccordAgents-Beta-Releases/);
  assert.match(output, /Build: npm run make:win-x64/);
  assert.match(output, /Update check: skipped/);
});

test("Windows release dry-run accepts an explicit update verification version", () => {
  const output = dryRun(["--from-version", "1.10.0"]);

  assert.match(output, /Update check: enabled from 1\.10\.0/);
});

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
    endpoint: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2",
    status: 200,
    statusText: "OK",
    url: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2",
    body: "ABC old-accordagents-1.2.2-full.nupkg 123"
  }, "1.2.3"), /did not mention expected version 1\.2\.3/);
});

test("Windows update verification accepts the expected NuGet package version", () => {
  assert.doesNotThrow(() => validateWindowsUpdateResponse({
    endpoint: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2",
    status: 200,
    statusText: "OK",
    url: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2",
    body: "ABC accordagents-1.2.3-full.nupkg 123"
  }, "1.2.3"));
});

test("Windows update verification accepts Squirrel's normalized beta version", () => {
  assert.doesNotThrow(() => validateWindowsUpdateResponse({
    endpoint: "https://update.electronjs.org/example/accordagents/win32-x64/1.10.1-beta.2",
    status: 200,
    statusText: "OK",
    url: "https://update.electronjs.org/example/accordagents/win32-x64/1.10.1-beta.2",
    body: "ABC accordagents-1.10.1-beta3-full.nupkg 123"
  }, "1.10.1-beta.3"));
});

test("Windows update verification rejects a near-prefix normalized beta version", () => {
  assert.throws(() => validateWindowsUpdateResponse({
    endpoint: "https://update.electronjs.org/example/accordagents/win32-x64/1.10.1-beta.2",
    status: 200,
    statusText: "OK",
    url: "https://update.electronjs.org/example/accordagents/win32-x64/1.10.1-beta.2",
    body: "ABC accordagents-1.10.1-beta30-full.nupkg 123"
  }, "1.10.1-beta.3"), /did not mention expected version 1\.10\.1-beta\.3/);
});

test("Windows update verification rejects a near-prefix package version", () => {
  assert.throws(() => validateWindowsUpdateResponse({
    endpoint: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2",
    status: 200,
    statusText: "OK",
    url: "https://update.electronjs.org/example/accordagents/win32-x64/1.2.2",
    body: "ABC accordagents-1.2.30-full.nupkg 123"
  }, "1.2.3"), /did not mention expected version 1\.2\.3/);
});
