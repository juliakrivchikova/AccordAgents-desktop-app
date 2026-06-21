#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const signedDir = path.join(rootDir, "signed");
const validTargets = new Set(["patch", "minor", "major"]);
const packageJsonPath = path.join(rootDir, "package.json");

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage: npm run release:<patch|minor|major> [-- options]

Creates a macOS arm64 release:
  1. bumps package.json/package-lock.json,
  2. commits and pushes the version bump to the source repo,
  3. tags the source repo at v<version>,
  4. builds signed/notarized DMG and signed ZIP artifacts,
  5. creates or updates a GitHub Release in the public release repo,
  6. checks update.electronjs.org for the ZIP asset.

Options:
  --repo owner/repo              Public GitHub release repo. Defaults to RELEASE_REPO or package.json config.releaseRepo.
  --branch name                  Source branch to release from. Defaults to origin HEAD, usually main.
  --draft                        Create a draft GitHub Release. Auto-update check is skipped.
  --prerelease                   Mark the GitHub Release as a prerelease. Auto-update check is skipped.
  --skip-update-check            Do not query update.electronjs.org after upload.
  --allow-private-release-repo   Allow publishing to a private release repo. Auto-updates will not work there.
  --dry-run                      Print the planned release without changing files or GitHub state.
  -h, --help                     Show this help.

Examples:
  gh auth switch --user <your-github-username>
  npm run release:patch
  npm run release:minor
`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: rootDir,
    env: process.env,
    encoding: options.encoding || "utf8",
    stdio: options.stdio || "pipe"
  });
}

function runInherited(command, args) {
  execFileSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit"
  });
}

function commandSucceeds(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    encoding: "utf8",
    stdio: "ignore"
  });
  return !result.error && result.status === 0;
}

function packageJson() {
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function configuredReleaseRepo() {
  const config = packageJson().config;
  if (config && typeof config.releaseRepo === "string") {
    return config.releaseRepo;
  }
  return "";
}

function parseGitHubRepo(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const shorthandMatch = text.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (shorthandMatch) {
    return `${shorthandMatch[1]}/${shorthandMatch[2]}`;
  }

  const githubMatch = text.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[#?].*)?$/);
  if (githubMatch) {
    return `${githubMatch[1]}/${githubMatch[2]}`;
  }

  return "";
}

function readOptionValue(args, index, optionName) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    fail(`Missing value for ${optionName}.`);
  }
  return value;
}

function parseArgs() {
  const options = {
    target: "current",
    releaseRepo: parseGitHubRepo(process.env.RELEASE_REPO || configuredReleaseRepo()),
    sourceBranch: process.env.RELEASE_BRANCH || "",
    draft: false,
    prerelease: false,
    skipUpdateCheck: false,
    allowPrivateReleaseRepo: false,
    dryRun: false
  };

  let positionalTarget = "";
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--repo") {
      options.releaseRepo = parseGitHubRepo(readOptionValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      options.releaseRepo = parseGitHubRepo(arg.slice("--repo=".length));
      continue;
    }
    if (arg === "--branch") {
      options.sourceBranch = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--branch=")) {
      options.sourceBranch = arg.slice("--branch=".length);
      continue;
    }
    if (arg === "--draft") {
      options.draft = true;
      continue;
    }
    if (arg === "--prerelease") {
      options.prerelease = true;
      continue;
    }
    if (arg === "--skip-update-check") {
      options.skipUpdateCheck = true;
      continue;
    }
    if (arg === "--allow-private-release-repo") {
      options.allowPrivateReleaseRepo = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`);
    }
    if (positionalTarget) {
      fail(`Unexpected extra release target: ${arg}`);
    }
    positionalTarget = arg;
  }

  if (positionalTarget) {
    options.target = positionalTarget;
  }
  if (!validTargets.has(options.target)) {
    fail(`Invalid release target: ${options.target}. Use patch, minor, or major.`);
  }
  if (!options.releaseRepo) {
    fail("Could not determine release repo. Set package.json config.releaseRepo, RELEASE_REPO, or pass --repo owner/repo.");
  }

  return options;
}

function requireCommand(command, args = ["--version"]) {
  if (!commandSucceeds(command, args)) {
    fail(`Required command is unavailable or failed: ${command}`);
  }
}

function originDefaultBranch() {
  try {
    const remote = run("git", ["remote", "show", "origin"]);
    const match = remote.match(/HEAD branch:\s*(\S+)/);
    if (match) {
      return match[1];
    }
  } catch {
    // Fall through to main.
  }
  return "main";
}

function ensureCleanWorktree() {
  const status = run("git", ["status", "--porcelain"]).trim();
  if (status) {
    fail("Release requires a clean worktree.");
  }
}

function ensureSourceBranch(sourceBranch) {
  const currentBranch = run("git", ["branch", "--show-current"]).trim();
  if (currentBranch !== sourceBranch) {
    fail(`Release must run from ${sourceBranch}. Current branch: ${currentBranch || "unknown"}.`);
  }
}

function releaseRepoInfo(releaseRepo) {
  const raw = run("gh", [
    "repo",
    "view",
    releaseRepo,
    "--json",
    "defaultBranchRef,isPrivate,url"
  ]);
  return JSON.parse(raw);
}

function currentVersion() {
  return packageJson().version;
}

function productName() {
  const currentPackageJson = packageJson();
  return currentPackageJson.productName || currentPackageJson.name;
}

function bumpVersion(target, sourceBranch) {
  const beforeVersion = currentVersion();
  console.log(`\n==> Bumping ${target} version from ${beforeVersion}`);
  runInherited("npm", ["version", target, "--no-git-tag-version"]);

  const afterVersion = currentVersion();
  runInherited("git", ["add", "package.json", "package-lock.json"]);
  runInherited("git", ["commit", "-m", `Bump version to ${afterVersion}`]);
  runInherited("git", ["push", "origin", `HEAD:${sourceBranch}`]);

  return afterVersion;
}

function localTagCommit(tagName) {
  try {
    return run("git", ["rev-list", "-n", "1", `refs/tags/${tagName}`]).trim();
  } catch {
    return "";
  }
}

function remoteTagExists(tagName) {
  return run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tagName}`]).trim().length > 0;
}

function ensureSourceTag(tagName) {
  const headCommit = run("git", ["rev-parse", "HEAD"]).trim();
  const localCommit = localTagCommit(tagName);
  const existsOnRemote = remoteTagExists(tagName);

  if (localCommit && localCommit !== headCommit) {
    fail(`Local tag ${tagName} points at ${localCommit}, not current HEAD ${headCommit}.`);
  }

  if (existsOnRemote) {
    if (!localCommit) {
      runInherited("git", ["fetch", "origin", "tag", tagName]);
    }
    const fetchedCommit = localTagCommit(tagName);
    if (fetchedCommit !== headCommit) {
      fail(`Remote tag ${tagName} points at ${fetchedCommit}, not current HEAD ${headCommit}.`);
    }
    console.log(`\n==> Source tag ${tagName} already exists on current HEAD`);
    return;
  }

  if (!localCommit) {
    console.log(`\n==> Creating source tag ${tagName}`);
    runInherited("git", ["tag", "-a", tagName, "-m", `Release ${tagName}`]);
  }

  console.log(`\n==> Pushing source tag ${tagName}`);
  runInherited("git", ["push", "origin", tagName]);
}

function requireFile(filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile() || statSync(filePath).size === 0) {
    fail(`Required release artifact is missing or empty: ${path.relative(rootDir, filePath)}`);
  }
  return filePath;
}

function releaseAssets(version) {
  const name = productName();
  const dmgPath = requireFile(path.join(signedDir, `${name}-${version}-arm64.dmg`));
  const dmgChecksumPath = requireFile(`${dmgPath}.sha256`);
  const zipPath = requireFile(path.join(signedDir, `${name}-${version}-darwin-arm64.zip`));
  const zipChecksumPath = requireFile(`${zipPath}.sha256`);
  return [dmgPath, dmgChecksumPath, zipPath, zipChecksumPath];
}

function releaseNotes(tagName, assets) {
  const checksumLines = assets
    .filter((assetPath) => assetPath.endsWith(".sha256"))
    .map((assetPath) => `- \`${readFileSync(assetPath, "utf8").trim()}\``)
    .join("\n");

  return `${productName()} ${tagName}

Artifacts:
- DMG: signed and notarized macOS Apple Silicon installer for direct download.
- ZIP: signed macOS Apple Silicon app archive for update.electronjs.org.

Checksums:
${checksumLines}
`;
}

function releaseExists(tagName, releaseRepo) {
  return commandSucceeds("gh", ["release", "view", tagName, "--repo", releaseRepo]);
}

function createOrUpdateGitHubRelease(options, tagName, releaseRepoTargetBranch, assets) {
  const title = `${productName()} ${tagName}`;
  const notes = releaseNotes(tagName, assets);

  if (releaseExists(tagName, options.releaseRepo)) {
    console.log(`\n==> Updating existing GitHub Release ${tagName} in ${options.releaseRepo}`);
    runInherited("gh", ["release", "upload", tagName, ...assets, "--repo", options.releaseRepo, "--clobber"]);
    runInherited("gh", ["release", "edit", tagName, "--repo", options.releaseRepo, "--title", title, "--notes", notes]);
    return;
  }

  console.log(`\n==> Creating GitHub Release ${tagName} in ${options.releaseRepo}`);
  const args = [
    "release",
    "create",
    tagName,
    ...assets,
    "--repo",
    options.releaseRepo,
    "--target",
    releaseRepoTargetBranch,
    "--title",
    title,
    "--notes",
    notes
  ];

  if (options.draft) {
    args.push("--draft");
  }
  if (options.prerelease) {
    args.push("--prerelease");
  }
  if (!options.draft && !options.prerelease) {
    args.push("--latest");
  }

  runInherited("gh", args);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function queryUpdateEndpoint(options, version, fromVersion) {
  const endpoint = `https://update.electronjs.org/${options.releaseRepo}/darwin-arm64/${fromVersion}`;
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": `${packageJson().name || "accordagents"}-release-check`
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Update check failed with HTTP ${response.status}: ${body.trim() || response.statusText}`);
  }

  const updateInfo = await response.json();
  if (!updateInfo || typeof updateInfo.url !== "string" || typeof updateInfo.name !== "string") {
    throw new Error(`Unexpected update response: ${JSON.stringify(updateInfo)}`);
  }
  if (!updateInfo.url.includes(".zip")) {
    throw new Error(`Update response did not point at a ZIP asset: ${updateInfo.url}`);
  }
  if (!`${updateInfo.name} ${updateInfo.url}`.includes(version)) {
    throw new Error(`Update response did not mention expected version ${version}: ${updateInfo.name} ${updateInfo.url}`);
  }

  return { endpoint, updateInfo };
}

async function checkUpdateEndpoint(options, version, fromVersion, releaseRepoIsPrivate) {
  if (options.skipUpdateCheck || options.draft || options.prerelease) {
    console.log("\n==> Skipping update.electronjs.org check");
    return;
  }
  if (releaseRepoIsPrivate) {
    console.log("\n==> Skipping update.electronjs.org check because the release repo is private");
    return;
  }

  console.log("\n==> Checking update.electronjs.org");
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const { endpoint, updateInfo } = await queryUpdateEndpoint(options, version, fromVersion);
      console.log(`Update endpoint: ${endpoint}`);
      console.log(`Release name: ${updateInfo.name}`);
      console.log(`Update ZIP: ${updateInfo.url}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 6) {
        console.warn("Update check failed; retrying in 10s.");
        await sleep(10_000);
      }
    }
  }

  throw lastError;
}

const options = parseArgs();
const sourceBranch = options.sourceBranch || originDefaultBranch();

if (options.dryRun) {
  console.log(`Release target: ${options.target}`);
  console.log(`Source branch: ${sourceBranch}`);
  console.log(`Release repo: ${options.releaseRepo}`);
  console.log(`Current version: ${currentVersion()}`);
  console.log("Build: npm run signed:mac-arm64");
  console.log(`GitHub Release state: ${options.draft ? "draft" : options.prerelease ? "prerelease" : "published"}`);
  process.exit(0);
}

requireCommand("git");
requireCommand("npm");
requireCommand("gh");

console.log(`\n==> Validating release repo ${options.releaseRepo}`);
const repoInfo = releaseRepoInfo(options.releaseRepo);
if (repoInfo.isPrivate && !options.allowPrivateReleaseRepo) {
  fail(`${options.releaseRepo} is private. update.electronjs.org requires a public GitHub release repo. Make it public or rerun with --allow-private-release-repo for a download-only release.`);
}
if (repoInfo.isPrivate) {
  console.warn(`${options.releaseRepo} is private; update.electronjs.org will not see this release.`);
}

console.log(`Release repo URL: ${repoInfo.url}`);

console.log(`\n==> Validating source branch ${sourceBranch}`);
ensureSourceBranch(sourceBranch);
ensureCleanWorktree();
runInherited("git", ["pull", "--ff-only", "origin", sourceBranch]);
ensureCleanWorktree();

const previousVersion = currentVersion();
const version = bumpVersion(options.target, sourceBranch);
const tagName = `v${version}`;
ensureSourceTag(tagName);

console.log("\n==> Building signed macOS arm64 artifacts");
runInherited("npm", ["run", "signed:mac-arm64"]);

const assets = releaseAssets(version);
createOrUpdateGitHubRelease(
  options,
  tagName,
  repoInfo.defaultBranchRef?.name || "main",
  assets
);
await checkUpdateEndpoint(options, version, previousVersion, repoInfo.isPrivate);

console.log(`\nRelease ${tagName} is ready in ${options.releaseRepo}.`);
