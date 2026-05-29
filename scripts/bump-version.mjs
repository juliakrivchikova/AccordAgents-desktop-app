#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const versionType = process.argv[2] || "patch";
const validVersionTypes = new Set(["patch", "minor", "major"]);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio || "pipe"
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function ensureMainBranch() {
  const branch = run("git", ["branch", "--show-current"]).trim();
  if (branch !== "main") {
    fail(`Version bumps must run from main. Current branch: ${branch || "unknown"}.`);
  }
}

function ensureCleanWorktree() {
  const status = run("git", ["status", "--porcelain"]).trim();
  if (status) {
    fail("Version bumps require a clean worktree.");
  }
}

function packageVersion() {
  return JSON.parse(readFileSync("package.json", "utf8")).version;
}

if (!validVersionTypes.has(versionType)) {
  fail(`Invalid version type: ${versionType}. Use patch, minor, or major.`);
}

ensureMainBranch();
ensureCleanWorktree();

const currentVersion = packageVersion();
console.log(`Bumping ${versionType} version from ${currentVersion}.`);

run("npm", ["version", versionType, "--no-git-tag-version"], { stdio: "inherit" });

const nextVersion = packageVersion();
run("git", ["add", "package.json", "package-lock.json"], { stdio: "inherit" });
run("git", ["commit", "-m", `Bump version to ${nextVersion}`], { stdio: "inherit" });
run("git", ["push", "origin", "main"], { stdio: "inherit" });

console.log(`Version ${nextVersion} was committed and pushed to main.`);
console.log("Run npm run signed:mac-arm64 to build local release artifacts, then npm run tag-release to create the release tag.");
