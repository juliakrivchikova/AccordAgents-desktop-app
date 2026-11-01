#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReleaseAtFreshCommit, preflightReleaseRepo, verifyReleaseListing } from "./release-repo-target.mjs";

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
  console.log(`Usage: npm run release:windows-x64 -- --package-only | --publish-only [options]

The two halves of a Windows x64 release that run on GitHub
(.github/workflows/windows-release.yml). The signing between them runs on the
Windows PC that holds the certificate (npm run sign:windows-x64). Windows ships
only with stable releases.

  --package-only   Builds the unsigned app into out/<product>-win32-x64, checks its
                   archive and launches it with a throwaway profile.
  --publish-only   Publishes the signed files in out/windows-release to the GitHub
                   Release of the current version: the full NuGet package and
                   RELEASES first, then the Setup executable, with checksums and a
                   Windows section in the notes. A published installer is never
                   replaced. When the release does not exist yet, its tag goes on a
                   new empty commit on the release repo's default branch so the
                   update feed lists it first.

Options:
  --repo owner/repo              Public GitHub release repo. Defaults to package.json config.releaseRepo.
  --from-version version         Installed version used to verify the update endpoint.
  --skip-update-check            Do not query update.electronjs.org after upload.
  --allow-private-release-repo   Allow publishing to a private release repo. Auto-updates will not work there.
  --dry-run                      Print the planned step without changing files or GitHub state.
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
export function envWithoutGitHubTokens() {
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

export function parseGitHubRepo(value) {
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

function parseArgs(version) {
  const envRepo = process.env.RELEASE_REPO?.trim() || "";
  const options = {
    releaseRepo: envRepo ? parseGitHubRepo(envRepo) : "",
    fromVersion: process.env.UPDATE_FROM_VERSION?.trim() || "",
    skipUpdateCheck: false,
    allowPrivateReleaseRepo: false,
    packageOnly: false,
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
    if (arg === "--package-only") {
      options.packageOnly = true;
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

  if (options.packageOnly === options.publishOnly) {
    fail("Pass --package-only or --publish-only.");
  }
  if (options.packageOnly) {
    return options;
  }

  // Windows apps always follow the stable feed (resolveUpdateRepo), so a
  // prerelease would reach nobody.
  if (version.includes("-")) {
    fail(`Windows ships only with stable releases; ${version} is a prerelease.`);
  }
  if (!options.releaseRepo) {
    options.releaseRepo = parseGitHubRepo(packageJson().config?.releaseRepo);
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

export function productName() {
  const currentPackageJson = packageJson();
  return currentPackageJson.productName || currentPackageJson.name;
}

export function packagedAppDir() {
  return path.join(outDir, `${productName()}-win32-x64`);
}

// The packaged app is checked before it leaves the build machine: its archive
// holds the runtime files and nothing else, and it starts with a throwaway profile.
function checkPackagedApp() {
  console.log("\n==> Checking the packaged app");
  const env = envWithoutGitHubTokens();
  runInherited(process.execPath, [path.join(rootDir, ".agents", "skills", "release-beta", "scripts", "verify-release.mjs"), "packaged", packagedAppDir()], env);
  runInherited(process.execPath, [
    path.join(rootDir, "scripts", "smoke-launch-packaged-app.mjs"),
    packagedAppDir(),
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
export function prepareReleaseFiles(version) {
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
    // RELEASES gets one too, for the checks of the downloaded files only.
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
  const packageNames = existsSync(releaseDir)
    ? readdirSync(releaseDir).filter((name) => name.endsWith("-full.nupkg"))
    : [];
  if (packageNames.length !== 1) {
    fail(`${path.relative(rootDir, releaseDir)} must hold exactly one NuGet package.`);
  }
  const packagePath = path.join(releaseDir, packageNames[0]);
  const setupPath = path.join(releaseDir, installerName(version));
  return {
    update: [packagePath, `${packagePath}.sha256`, path.join(releaseDir, "RELEASES")].map(requireFile),
    installer: [setupPath, `${setupPath}.sha256`].map(requireFile)
  };
}

// Unsigned: the certificate's key never leaves the Windows PC, which signs the
// app this leaves in out/ (npm run sign:windows-x64).
function packageApp() {
  console.log("\n==> Building the unsigned Windows x64 app");
  runNpmInherited(["run", "package", "--", "--platform=win32", "--arch=x64"]);
  checkPackagedApp();
}

function windowsNotes(files) {
  const checksumLines = [...files.installer, ...files.update]
    .filter((filePath) => filePath.endsWith(".sha256"))
    .map((checksumPath) => `- \`${readFileSync(checksumPath, "utf8").trim()}\``)
    .join("\n");
  return `${windowsNotesStart}
Windows x64:
- Setup.exe: code-signed Windows x64 installer for direct download.
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
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function publish(options, version) {
  const tagName = `v${version}`;
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

  const files = releaseFiles(version);
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

async function main() {
  const version = packageJson().version;
  const options = parseArgs(version);

  if (options.dryRun) {
    console.log(`Version: ${version}`);
    if (options.packageOnly) {
      console.log("Build: npm run package -- --platform=win32 --arch=x64 (unsigned)");
      console.log("Publish: no (package only)");
      return;
    }
    console.log(`Release repo: ${options.releaseRepo}`);
    console.log(`Build: no (publishes ${path.relative(rootDir, releaseDir)})`);
    console.log(`Publish: v${version} in ${options.releaseRepo}`);
    console.log(`Update check: ${options.skipUpdateCheck ? "skipped" : `enabled from ${options.fromVersion} (${windowsUpdateFeedUrl(options.releaseRepo, options.fromVersion)})`}`);
    return;
  }

  if (options.packageOnly) {
    if (process.platform !== "win32") {
      fail("The Windows x64 app must be built on Windows.");
    }
    packageApp();
    console.log(`\nThe unsigned Windows x64 app for ${version} is in ${path.relative(rootDir, packagedAppDir())}; nothing was published.`);
    return;
  }

  await publish(options, version);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  await main();
}
