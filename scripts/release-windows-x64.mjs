#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReleaseAtFreshCommit, preflightReleaseRepo, verifyReleaseListing } from "./release-repo-target.mjs";
import squirrel from "./squirrel-version.cjs";

const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, "package.json");
const outDir = path.join(rootDir, "out");
// The built files under the names they are published with, and their checksums.
const releaseDir = path.join(outDir, "windows-release");
// The Windows section of the release notes sits between these markers, so a
// re-run replaces exactly that section.
const windowsNotesStart = "<!-- windows-x64 -->";
const windowsNotesEnd = "<!-- /windows-x64 -->";

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage: npm run release:windows-x64 -- [options]

Builds, launch-checks and publishes the unsigned Squirrel.Windows x64 assets for the
current package version. Run this after the corresponding source tag exists. It uses
the same stable/beta release repositories as the in-app updater and uploads the Setup
executable, the full NuGet package and the RELEASES manifest required by
update.electronjs.org, with checksums for the first two. A release that already
exists (the macOS build published it) only gets these files added, the installer
last, and never has a published installer replaced. When it has to create the
GitHub Release, the tag goes on a new empty commit on the release repo's default
branch so the update feed lists it first.

Options:
  --repo owner/repo              Public GitHub release repo. Defaults to package.json config for this channel.
  --from-version version         Installed version used to verify the update endpoint.
  --skip-update-check            Do not query update.electronjs.org after upload.
  --allow-private-release-repo   Allow publishing to a private release repo. Auto-updates will not work there.
  --build-only                   Build, check and prepare the files in out/windows-release without publishing.
  --publish-only                 Publish the files a --build-only run prepared, without building.
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

function runInherited(command, args, env = process.env) {
  execFileSync(command, args, {
    cwd: rootDir,
    env,
    stdio: "inherit"
  });
}

// The build runs every dependency's code; it needs no GitHub credentials.
function envWithoutGitHubTokens() {
  const { GH_TOKEN, GITHUB_TOKEN, SOURCE_PUSH_TOKEN, ...env } = process.env;
  return env;
}

function runNpmInherited(args) {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (!npmExecPath || !existsSync(npmExecPath)) {
    fail("Run the Windows release through npm so its CLI entry point can be launched safely.");
  }
  runInherited(process.execPath, [npmExecPath, ...args], envWithoutGitHubTokens());
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
    buildOnly: false,
    publishOnly: false,
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
    if (arg === "--build-only") {
      options.buildOnly = true;
      continue;
    }
    if (arg === "--publish-only") {
      options.publishOnly = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    fail(`Unknown option: ${arg}`);
  }

  if (options.buildOnly && options.publishOnly) {
    fail("Pass --build-only or --publish-only, not both.");
  }

  if (!options.releaseRepo) {
    options.releaseRepo = parseGitHubRepo(configuredReleaseRepo(version));
  }
  if (!options.releaseRepo) {
    fail("Could not determine the release repository. Set package.json config, RELEASE_REPO, or pass --repo owner/repo.");
  }
  if (!options.buildOnly && !options.skipUpdateCheck && !options.fromVersion) {
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

function productName() {
  const currentPackageJson = packageJson();
  return currentPackageJson.productName || currentPackageJson.name;
}

// The packaged app is checked before anything is published: its archive holds
// the runtime files and nothing else, and it starts with a throwaway profile.
function checkPackagedApp() {
  const appDir = path.join(outDir, `${productName()}-win32-x64`);
  console.log("\n==> Checking the packaged app");
  const env = envWithoutGitHubTokens();
  runInherited(process.execPath, [path.join(rootDir, ".agents", "skills", "release-beta", "scripts", "verify-release.mjs"), "packaged", appDir], env);
  runInherited(process.execPath, [
    path.join(rootDir, "scripts", "smoke-launch-packaged-app.mjs"),
    appDir,
    "--screenshot",
    path.join(outDir, "launch", "windows.png"),
    "--log",
    path.join(outDir, "launch", "windows.log")
  ], env);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

// GitHub turns the space in Squirrel's "<name>-<version> Setup.exe" into a dot,
// so the installer is published under a name without one. The NuGet package and
// RELEASES keep their names: RELEASES refers to the package by name.
function prepareReleaseFiles(version) {
  const makeDir = path.join(outDir, "make", "squirrel.windows", "x64");
  const names = readdirSync(makeDir);
  const setupName = names.find((name) => name.endsWith(" Setup.exe"));
  const packageName = names.find((name) => name.endsWith("-full.nupkg"));
  if (!setupName || !packageName) {
    fail("Squirrel.Windows output must include a Setup executable and full NuGet package.");
  }

  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });
  const copy = (name, publishedName) => {
    const target = path.join(releaseDir, publishedName);
    copyFileSync(requireFile(path.join(makeDir, name)), target);
    return target;
  };
  const writeChecksum = (filePath) => {
    const checksumPath = `${filePath}.sha256`;
    writeFileSync(checksumPath, `${sha256(filePath)}  ${path.basename(filePath)}\n`);
    return checksumPath;
  };

  for (const filePath of [copy(setupName, installerName(version)), copy(packageName, packageName), copy("RELEASES", "RELEASES")]) {
    // RELEASES gets one too, for the check of the published download only.
    writeChecksum(filePath);
  }
  return releaseFiles(version);
}

function installerName(version) {
  return `${productName()}-${version}-win32-x64-Setup.exe`;
}

// The prepared files in the two groups they are published in: update.electronjs.org
// serves a release to Windows once it carries an .exe or a *-win32-x64* file and
// then reads RELEASES from it, so the installer goes up after the update files.
function releaseFiles(version) {
  const packageName = existsSync(releaseDir)
    ? readdirSync(releaseDir).find((name) => name.endsWith(`-${squirrel.squirrelPackageVersion(version)}-full.nupkg`))
    : undefined;
  if (!packageName) {
    fail(`${path.relative(rootDir, releaseDir)} has no NuGet package for ${version}; run with --build-only first.`);
  }
  const packagePath = path.join(releaseDir, packageName);
  const setupPath = path.join(releaseDir, installerName(version));
  return {
    update: [packagePath, `${packagePath}.sha256`, path.join(releaseDir, "RELEASES")].map(requireFile),
    installer: [setupPath, `${setupPath}.sha256`].map(requireFile)
  };
}

function buildAndPrepare(version) {
  console.log("\n==> Building Windows x64 update artifacts");
  runNpmInherited(["run", "make:win-x64"]);
  checkPackagedApp();
  return prepareReleaseFiles(version);
}

function windowsNotes(files) {
  const checksumLines = [...files.installer, ...files.update]
    .filter((filePath) => filePath.endsWith(".sha256"))
    .map((checksumPath) => `- \`${readFileSync(checksumPath, "utf8").trim()}\``)
    .join("\n");
  return `${windowsNotesStart}
Windows x64:
- Setup.exe: Windows x64 installer for direct download. It is not code-signed yet, so Windows may ask to confirm it before the first run.
- NuGet package and RELEASES: Squirrel update files for update.electronjs.org.

Checksums:
${checksumLines}
${windowsNotesEnd}`;
}

function releaseExists(tagName, releaseRepo) {
  return commandSucceeds("gh", ["release", "view", tagName, "--repo", releaseRepo]);
}

function releaseRepoInfo(releaseRepo) {
  return JSON.parse(run("gh", ["repo", "view", releaseRepo, "--json", "defaultBranchRef,isPrivate,url"]));
}

// The macOS build wrote the notes; Windows adds its own section after them, and
// a re-run replaces that section, between its markers, instead of adding another.
export function mergeWindowsNotes(body, notes) {
  const start = body.indexOf(windowsNotesStart);
  const end = start === -1 ? -1 : body.indexOf(windowsNotesEnd, start);
  if (end === -1) {
    const kept = body.trimEnd();
    return kept ? `${kept}\n\n${notes}` : notes;
  }
  const before = body.slice(0, start).trimEnd();
  const after = body.slice(end + windowsNotesEnd.length).trim();
  return [before, notes, after].filter(Boolean).join("\n\n");
}

function addWindowsNotes(tagName, releaseRepo, notes) {
  const body = run("gh", ["release", "view", tagName, "--repo", releaseRepo, "--json", "body", "--jq", ".body"]);
  runInherited("gh", ["release", "edit", tagName, "--repo", releaseRepo, "--notes", mergeWindowsNotes(body, notes)]);
}

function publishedAssetNames(tagName, releaseRepo) {
  return run("gh", ["release", "view", tagName, "--repo", releaseRepo, "--json", "assets", "--jq", ".assets[].name"])
    .split(/\r?\n/)
    .filter(Boolean);
}

function createOrUpdateRelease(options, tagName, defaultBranch, files, notes) {
  if (releaseExists(tagName, options.releaseRepo)) {
    const installer = path.basename(files.installer[0]);
    // Once the installer is up, Windows users may be updating to these files;
    // a rebuild is never byte-identical, so it must not replace them.
    if (publishedAssetNames(tagName, options.releaseRepo).includes(installer)) {
      fail(`${tagName} in ${options.releaseRepo} already has ${installer}, so its Windows files are not replaced.
If they must be rebuilt, remove the Windows files from the release by hand first.`);
    }
    runInherited("gh", ["release", "upload", tagName, ...files.update, "--repo", options.releaseRepo, "--clobber"]);
    runInherited("gh", ["release", "upload", tagName, ...files.installer, "--repo", options.releaseRepo, "--clobber"]);
    addWindowsNotes(tagName, options.releaseRepo, notes);
    return;
  }

  try {
    return createReleaseAtFreshCommit(
      {
        releaseRepo: options.releaseRepo,
        branch: defaultBranch,
        tagName,
        // gh uploads to a draft and publishes it after the last file.
        releaseArgs: [
          ...files.update,
          ...files.installer,
          "--repo",
          options.releaseRepo,
          "--title",
          `${productName()} ${tagName}`,
          "--notes",
          notes
        ]
      },
      { gh: (args) => runInherited("gh", args) }
    );
  } catch (error) {
    fail(`Publishing ${tagName} to ${options.releaseRepo} failed: ${error.message}
Fix the cause and rerun; when the release exists the script only uploads to it.`);
  }
}

export function validateWindowsUpdateResponse({ endpoint, status, statusText, url, body }, version) {
  if (status < 200 || status >= 300) {
    throw new Error(`Windows update check failed for ${endpoint}: HTTP ${status} ${body.trim() || statusText}`);
  }
  const updateEvidence = `${url} ${body}`;
  // The NuGet package carries Squirrel's form of the version (1.10.1-beta.3
  // becomes 1.10.1-beta003, see squirrel-version.cjs).
  const escapedVersion = squirrel.squirrelPackageVersion(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expectedPackage = new RegExp(`(?:^|[/\\s])[^/\\s]*-${escapedVersion}-full\\.nupkg(?:$|[?#\\s])`, "i");
  if (!expectedPackage.test(updateEvidence)) {
    throw new Error(`Windows update response did not mention expected version ${version}: ${updateEvidence.trim()}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Squirrel asks the feed for RELEASES; the feed URL alone answers with a JSON
// link to the installer, which never names the NuGet package.
export function windowsUpdateFeedUrl(releaseRepo, fromVersion) {
  return `https://update.electronjs.org/${releaseRepo}/win32-x64/${fromVersion}/RELEASES`;
}

async function queryUpdateEndpoint(options, version) {
  const endpoint = windowsUpdateFeedUrl(options.releaseRepo, options.fromVersion);
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
    console.log(`Squirrel package version: ${squirrel.squirrelPackageVersion(version)}`);
    console.log(`Build: ${options.publishOnly ? `no (publishes ${path.relative(rootDir, releaseDir)})` : "npm run make:win-x64"}`);
    console.log(`Publish: ${options.buildOnly ? "no (build only)" : `${tagName} in ${options.releaseRepo}`}`);
    console.log(`Update check: ${options.buildOnly || options.skipUpdateCheck ? "skipped" : `enabled from ${options.fromVersion} (${windowsUpdateFeedUrl(options.releaseRepo, options.fromVersion)})`}`);
    return;
  }

  if (!options.publishOnly && process.platform !== "win32") {
    fail("Windows x64 release artifacts must be built on Windows.");
  }

  if (options.buildOnly) {
    buildAndPrepare(version);
    console.log(`\nWindows x64 files for ${version} are ready in ${path.relative(rootDir, releaseDir)}; nothing was published.`);
    return;
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

  const defaultBranch = repoInfo.defaultBranchRef?.name || "main";
  if (!releaseExists(tagName, options.releaseRepo)) {
    try {
      preflightReleaseRepo(options.releaseRepo, defaultBranch, tagName);
    } catch (error) {
      fail(error.message);
    }
  }

  const files = options.publishOnly ? releaseFiles(version) : buildAndPrepare(version);
  const targetCommit = createOrUpdateRelease(options, tagName, defaultBranch, files, windowsNotes(files));
  const listingProblem = targetCommit
    ? await verifyReleaseListing({ releaseRepo: options.releaseRepo, tagName, targetCommit, checkOrder: true })
    : "";
  if (listingProblem) {
    console.warn(`\n${tagName} is published in ${options.releaseRepo}, but ${listingProblem}.`);
  }
  let updateCheckError = null;
  try {
    await checkUpdateEndpoint(options, version, repoInfo.isPrivate);
  } catch (error) {
    updateCheckError = error;
  }
  if (listingProblem) {
    fail(`${tagName} is published, but ${listingProblem}.${updateCheckError ? `\nUpdate check: ${updateCheckError.message}` : ""}`);
  }
  if (updateCheckError) {
    throw updateCheckError;
  }

  console.log(`\nWindows update artifacts for ${tagName} are ready in ${options.releaseRepo}.`);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  await main();
}
