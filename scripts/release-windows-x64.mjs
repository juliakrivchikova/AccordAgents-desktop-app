#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, "package.json");

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage: npm run release:windows-x64 -- [options]

Builds and publishes Squirrel.Windows x64 update assets for the current package version.
Run this after the corresponding source tag exists. It uses the same stable/beta
release repositories as the in-app updater and uploads the Setup executable,
full NuGet package, and RELEASES manifest required by update.electronjs.org.

Options:
  --repo owner/repo              Public GitHub release repo. Defaults to package.json config for this channel.
  --from-version version         Installed version used to verify the update endpoint.
  --skip-update-check            Do not query update.electronjs.org after upload.
  --allow-private-release-repo   Allow publishing to a private release repo. Auto-updates will not work there.
  --dry-run                      Print the planned release without changing files or GitHub state.
  -h, --help                     Show this help.
`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || rootDir,
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

function runNpmInherited(args) {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (!npmExecPath || !existsSync(npmExecPath)) {
    fail("Run the Windows release through npm so its CLI entry point can be launched safely.");
  }
  runInherited(process.execPath, [npmExecPath, ...args]);
}

function commandSucceeds(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "ignore"
  });
  return !result.error && result.status === 0;
}

function packageJson() {
  if (!existsSync(packageJsonPath)) {
    fail(`No package.json found in ${rootDir}. Run the Windows release from the repository root.`);
  }
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function parseGitHubRepo(value) {
  const text = String(value || "").trim();
  const shorthandMatch = text.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (shorthandMatch) {
    return `${shorthandMatch[1]}/${shorthandMatch[2]}`;
  }

  const githubMatch = text.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[#?].*)?$/);
  return githubMatch ? `${githubMatch[1]}/${githubMatch[2]}` : "";
}

function readOptionValue(args, index, optionName) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    fail(`Missing value for ${optionName}.`);
  }
  return value;
}

function isBetaVersion(version) {
  return /-beta\.\d+$/.test(version);
}

function configuredReleaseRepo(version) {
  const config = packageJson().config || {};
  return isBetaVersion(version) ? config.betaReleaseRepo || "" : config.releaseRepo || "";
}

function parseArgs(version) {
  const envRepo = process.env.RELEASE_REPO?.trim() || "";
  const options = {
    releaseRepo: envRepo ? parseGitHubRepo(envRepo) : "",
    fromVersion: process.env.UPDATE_FROM_VERSION?.trim() || "",
    skipUpdateCheck: false,
    allowPrivateReleaseRepo: false,
    dryRun: false
  };

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
    if (arg === "--from-version") {
      options.fromVersion = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--from-version=")) {
      options.fromVersion = arg.slice("--from-version=".length);
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
    fail(`Unknown option: ${arg}`);
  }

  if (!options.releaseRepo) {
    options.releaseRepo = parseGitHubRepo(configuredReleaseRepo(version));
  }
  if (!options.releaseRepo) {
    fail("Could not determine the release repository. Set package.json config, RELEASE_REPO, or pass --repo owner/repo.");
  }
  if (!options.skipUpdateCheck && !options.fromVersion) {
    fail("Pass --from-version <installed-version> or --skip-update-check.");
  }

  return options;
}

function requireCommand(command, args = ["--version"]) {
  if (!commandSucceeds(command, args)) {
    fail(`Required command is unavailable or failed: ${command}`);
  }
}

function localTagCommit(tagName, cwd) {
  try {
    return run("git", ["rev-list", "-n", "1", `refs/tags/${tagName}`], { cwd }).trim();
  } catch {
    return "";
  }
}

function remoteTagCommit(tagName, cwd) {
  const output = run("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tagName}`,
    `refs/tags/${tagName}^{}`
  ], { cwd }).trim();
  if (!output) {
    return "";
  }
  const refs = new Map(output.split(/\r?\n/).map((line) => {
    const [commit, ref] = line.trim().split(/\s+/, 2);
    return [ref, commit];
  }));
  return refs.get(`refs/tags/${tagName}^{}`) || refs.get(`refs/tags/${tagName}`) || "";
}

export function sourceTagFailure(tagName, cwd = rootDir) {
  const headCommit = run("git", ["rev-parse", "HEAD"], { cwd }).trim();
  const localCommit = localTagCommit(tagName, cwd);
  if (!localCommit) {
    return `Source tag ${tagName} must exist before publishing Windows update artifacts.`;
  }
  if (localCommit !== headCommit) {
    return `Local tag ${tagName} points at ${localCommit}, not current HEAD ${headCommit}.`;
  }

  const remoteCommit = remoteTagCommit(tagName, cwd);
  if (!remoteCommit) {
    return `Source tag ${tagName} must exist on origin before publishing Windows update artifacts.`;
  }
  if (remoteCommit !== headCommit) {
    return `Remote tag ${tagName} points at ${remoteCommit}, not current HEAD ${headCommit}.`;
  }
  return "";
}

function verifySourceTag(tagName) {
  const message = sourceTagFailure(tagName);
  if (message) {
    fail(message);
  }
}

function requireFile(filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile() || statSync(filePath).size === 0) {
    fail(`Required release artifact is missing or empty: ${path.relative(rootDir, filePath)}`);
  }
  return filePath;
}

function releaseAssets() {
  const assetDir = path.join(rootDir, "out", "make", "squirrel.windows", "x64");
  const names = readdirSync(assetDir);
  const setupName = names.find((name) => name.endsWith(" Setup.exe"));
  const packageName = names.find((name) => name.endsWith("-full.nupkg"));
  if (!setupName || !packageName) {
    fail("Squirrel.Windows output must include a Setup executable and full NuGet package.");
  }
  return [
    requireFile(path.join(assetDir, setupName)),
    requireFile(path.join(assetDir, packageName)),
    requireFile(path.join(assetDir, "RELEASES"))
  ];
}

function releaseExists(tagName, releaseRepo) {
  return commandSucceeds("gh", ["release", "view", tagName, "--repo", releaseRepo]);
}

function releaseRepoInfo(releaseRepo) {
  return JSON.parse(run("gh", ["repo", "view", releaseRepo, "--json", "defaultBranchRef,isPrivate,url"]));
}

function createOrUpdateRelease(options, tagName, defaultBranch, assets) {
  if (releaseExists(tagName, options.releaseRepo)) {
    runInherited("gh", ["release", "upload", tagName, ...assets, "--repo", options.releaseRepo, "--clobber"]);
    return;
  }

  runInherited("gh", [
    "release",
    "create",
    tagName,
    ...assets,
    "--repo",
    options.releaseRepo,
    "--target",
    defaultBranch,
    "--title",
    `AccordAgents ${tagName}`,
    "--notes",
    "Windows x64 Squirrel update artifacts."
  ]);
}

export function validateWindowsUpdateResponse({ endpoint, status, statusText, url, body }, version) {
  if (status < 200 || status >= 300) {
    throw new Error(`Windows update check failed for ${endpoint}: HTTP ${status} ${body.trim() || statusText}`);
  }
  const updateEvidence = `${url} ${body}`;
  // Squirrel's NuGet package version removes the dot before a numeric beta
  // suffix (for example 1.10.1-beta.3 becomes 1.10.1-beta3).
  const squirrelVersion = version.replace(/-beta\.(\d+)$/i, "-beta$1");
  const escapedVersion = squirrelVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expectedPackage = new RegExp(`(?:^|[/\\s])[^/\\s]*-${escapedVersion}-full\\.nupkg(?:$|[?#\\s])`, "i");
  if (!expectedPackage.test(updateEvidence)) {
    throw new Error(`Windows update response did not mention expected version ${version}: ${updateEvidence.trim()}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryUpdateEndpoint(options, version) {
  const endpoint = `https://update.electronjs.org/${options.releaseRepo}/win32-x64/${options.fromVersion}`;
  const response = await fetch(endpoint, {
    headers: { "User-Agent": `${packageJson().name || "accordagents"}-release-check` }
  });
  const body = await response.text();
  validateWindowsUpdateResponse({
    endpoint,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    body
  }, version);
  return endpoint;
}

async function checkUpdateEndpoint(options, version, releaseRepoIsPrivate) {
  if (options.skipUpdateCheck || releaseRepoIsPrivate) {
    console.log("\n==> Skipping update.electronjs.org check");
    return;
  }

  console.log("\n==> Checking update.electronjs.org");
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const endpoint = await queryUpdateEndpoint(options, version);
      console.log(`Windows update endpoint: ${endpoint}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 6) {
        console.warn("Windows update check failed; retrying in 10s.");
        await sleep(10_000);
      }
    }
  }
  throw lastError;
}

async function main() {
  const version = packageJson().version;
  const options = parseArgs(version);
  const tagName = `v${version}`;

  if (options.dryRun) {
    console.log(`Release channel: ${isBetaVersion(version) ? "beta" : "stable"}`);
    console.log(`Release repo: ${options.releaseRepo}`);
    console.log(`Version: ${version}`);
    console.log("Build: npm run make:win-x64");
    console.log(`Update check: ${options.skipUpdateCheck ? "skipped" : `enabled from ${options.fromVersion}`}`);
    return;
  }

  if (process.platform !== "win32") {
    fail("Windows x64 release artifacts must be built on Windows.");
  }

  requireCommand("git");
  verifySourceTag(tagName);
  requireCommand("gh");
  if (run("git", ["status", "--porcelain"]).trim()) {
    fail("Windows release requires a clean worktree.");
  }

  const repoInfo = releaseRepoInfo(options.releaseRepo);
  if (repoInfo.isPrivate && !options.allowPrivateReleaseRepo) {
    fail(`${options.releaseRepo} is private. update.electronjs.org requires a public GitHub release repo.`);
  }

  console.log("\n==> Building Windows x64 update artifacts");
  runNpmInherited(["run", "make:win-x64"]);
  const assets = releaseAssets();
  createOrUpdateRelease(options, tagName, repoInfo.defaultBranchRef?.name || "main", assets);
  await checkUpdateEndpoint(options, version, repoInfo.isPrivate);

  console.log(`\nWindows update artifacts for ${tagName} are ready in ${options.releaseRepo}.`);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  await main();
}
