#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
    fail(`Release tags must be created from main. Current branch: ${branch || "unknown"}.`);
  }
}

function ensureCleanWorktree() {
  const status = run("git", ["status", "--porcelain"]).trim();
  if (status) {
    fail("Release tags require a clean worktree.");
  }
}

function localTagExists(tagName) {
  try {
    run("git", ["rev-parse", "--verify", `refs/tags/${tagName}`]);
    return true;
  } catch {
    return false;
  }
}

function remoteTagExists(tagName) {
  return run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tagName}`]).trim().length > 0;
}

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const tagName = `v${version}`;

ensureMainBranch();
ensureCleanWorktree();

console.log("Pulling latest main.");
run("git", ["pull", "--ff-only", "origin", "main"], { stdio: "inherit" });
ensureCleanWorktree();

if (localTagExists(tagName) || remoteTagExists(tagName)) {
  fail(`Tag ${tagName} already exists.`);
}

console.log(`Creating ${tagName}.`);
run("git", ["tag", "-a", tagName, "-m", `Release ${tagName}`], { stdio: "inherit" });

console.log(`Pushing ${tagName}.`);
run("git", ["push", "origin", tagName], { stdio: "inherit" });

console.log(`Release tag ${tagName} was pushed.`);
console.log("Build signed macOS artifacts locally with npm run signed:mac-arm64, then upload them to the public release repository when it is ready.");
