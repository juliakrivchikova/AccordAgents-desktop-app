#!/usr/bin/env node

// Signs the Windows x64 app a "Windows release" run built
// (.github/workflows/windows-release.yml), on the PC where SimplySign Desktop
// holds a session for the Certum certificate. It downloads the unsigned app,
// signs its files, packs and signs the Squirrel installer, checks every
// signature, puts the files in a draft release of the source repository and
// lets the run's Publish job go on. That job installs and checks them on a
// clean GitHub machine before anything is published.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { envWithoutGitHubTokens, packagedAppDir, parseGitHubRepo, prepareReleaseFiles, productName } from "./release-windows-x64.mjs";

const rootDir = process.cwd();
const require = createRequire(import.meta.url);
const hookModulePath = path.join(rootDir, "scripts", "windows-sign-file.cjs");
const workflowPath = ".github/workflows/windows-release.yml";
const buildJobName = "Build";
const publishJobName = "Publish";
const signingEnvironment = "windows-signing";

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage:
  npm run sign:windows-x64 -- --run <run id> [--repo owner/repo]
  npm run sign:windows-x64 -- --check <Setup.exe> [<app folder> [<file>...]]

--run signs the app that run's Build job kept. Run it from a clean checkout of
the commit the run built (the release tag), after npm ci, with SimplySign
Desktop signed in and the GitHub CLI signed in as a reviewer of the
windows-signing environment. The signed files go to the draft release
windows-signed-<run id> of the source repository (default: package.json
repository); then the run's Publish job is approved, or re-run when it already
ran without them.

--check only checks the signatures of an installer and, if given, an app folder
and more files that must carry the release certificate.
`);
}

function run(command, args) {
  return execFileSync(command, args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function runInherited(command, args, env = process.env) {
  execFileSync(command, args, { cwd: rootDir, env, stdio: "inherit" });
}

function packageJson() {
  return JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
}

function certificateThumbprint() {
  const thumbprint = packageJson().config?.windowsSignCertSha1 || "";
  if (!/^[0-9A-F]{40}$/i.test(thumbprint)) {
    fail("package.json config.windowsSignCertSha1 must be the SHA1 thumbprint of the Windows signing certificate.");
  }
  return thumbprint.toUpperCase();
}

function binaries(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:exe|dll|node)$/i.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

// One PowerShell call reads the status and signer of every file. The list goes
// through a file named in the environment, so no path is quoted into the script.
// Windows PowerShell serializes a line Get-Content read as an object with its
// source file, hence [string].
export function readSignatures(files) {
  const listDir = mkdtempSync(path.join(os.tmpdir(), "accordagents-signatures-"));
  try {
    const listPath = path.join(listDir, "files.txt");
    writeFileSync(listPath, files.join("\n"));
    const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$result = @(Get-Content -LiteralPath $env:ACCORDAGENTS_SIGNATURE_LIST -Encoding UTF8 | ForEach-Object {
  $signature = Get-AuthenticodeSignature -LiteralPath $_
  [pscustomobject]@{ path = [string]$_; status = [string]$signature.Status; thumbprint = $signature.SignerCertificate.Thumbprint }
}); ConvertTo-Json -InputObject $result -Compress`;
    return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      cwd: rootDir,
      env: { ...process.env, ACCORDAGENTS_SIGNATURE_LIST: listPath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    }));
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
}

// Every binary carries a valid signature, ours or the one its own publisher
// gave it (Microsoft's ConPTY and d3dcompiler), except the files the hook keeps
// unsigned, which must stay unsigned. The files in `ours` carry our signature.
export function signatureProblems(entries, { thumbprint, ours, keptUnsigned }) {
  const problems = [];
  for (const entry of entries) {
    if (keptUnsigned.some((suffix) => entry.path.endsWith(suffix))) {
      if (entry.status !== "NotSigned") {
        problems.push(`${entry.path} must stay unsigned, but its signature is ${entry.status}.`);
      }
      continue;
    }
    if (entry.status !== "Valid") {
      problems.push(`${entry.path} has no valid signature (${entry.status}).`);
      continue;
    }
    if (ours.includes(entry.path) && entry.thumbprint?.toUpperCase() !== thumbprint) {
      problems.push(`${entry.path} is signed by ${entry.thumbprint}, not by the release certificate ${thumbprint}.`);
    }
  }
  for (const file of ours) {
    if (!entries.some((entry) => entry.path === file)) {
      problems.push(`${file} is missing.`);
    }
  }
  return problems;
}

// `others` are more files that must carry our signature, such as the Update.exe
// and the launcher Squirrel installs next to the app's folder.
function checkSignatures(setupPath, appDir, others = []) {
  const ours = [...(appDir ? [path.join(appDir, `${productName()}.exe`)] : []), setupPath, ...others];
  const problems = signatureProblems(readSignatures([...(appDir ? binaries(appDir) : []), setupPath, ...others]), {
    thumbprint: certificateThumbprint(),
    ours,
    keptUnsigned: require(hookModulePath).keptUnsigned
  });
  if (problems.length > 0) {
    fail(`Signature check failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
  console.log(`Signatures check out: ${ours.map((file) => path.basename(file)).join(" and ")} carry the release certificate.`);
}

function viewRun(repo, runId) {
  return JSON.parse(run("gh", ["run", "view", runId, "--repo", repo, "--json", "jobs,url"]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadArtifact(repo, runId, name, dir) {
  try {
    run("gh", ["run", "download", runId, "--repo", repo, "--name", name, "--dir", dir]);
  } catch {
    fail(`Could not download ${name} of run ${runId}. A run keeps its build for 30 days; after that, start a new Windows release run.`);
  }
}

function downloadBuildInfo(repo, runId) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "accordagents-build-info-"));
  try {
    downloadArtifact(repo, runId, "windows-build-info", dir);
    return JSON.parse(readFileSync(path.join(dir, "build.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function pendingSignings(repo, runId) {
  return JSON.parse(run("gh", ["api", `repos/${repo}/actions/runs/${runId}/pending_deployments`]))
    .filter(({ environment }) => environment.name === signingEnvironment);
}

// GitHub lets several drafts share a tag name, and gh picks one of them.
function draftIds(repo, draft) {
  return JSON.parse(run("gh", ["api", `repos/${repo}/releases?per_page=100`, "--jq",
    `[.[] | select(.draft and .tag_name == "${draft}") | .id]`]));
}

function uploadDraft(repo, runId, runUrl, files) {
  const draft = `windows-signed-${runId}`;
  const ids = draftIds(repo, draft);
  if (ids.length > 1) {
    fail(`${repo} has ${ids.length} drafts named ${draft}; remove all but one and run this again.`);
  }
  if (ids.length === 1) {
    runInherited("gh", ["release", "upload", draft, ...files, "--repo", repo, "--clobber"]);
  } else {
    runInherited("gh", [
      "release", "create", draft, ...files,
      "--repo", repo,
      "--draft",
      "--title", `Signed Windows x64 files of run ${runId}`,
      "--notes", `Signed for ${runUrl}. Its Publish job publishes these files and removes this draft.`
    ]);
  }
  return draft;
}

function approve(repo, runId, runUrl, pending) {
  const args = ["api", "--method", "POST", `repos/${repo}/actions/runs/${runId}/pending_deployments`,
    "-f", "state=approved", "-f", "comment=Signed on the Windows PC."];
  for (const { environment } of pending) {
    args.push("-F", `environment_ids[]=${environment.id}`);
  }
  try {
    run("gh", args);
  } catch {
    fail(`The signed files are uploaded, but approving the ${publishJobName} job failed.
Approve it in GitHub (Review deployments) as a reviewer of ${signingEnvironment}: ${runUrl}`);
  }
  console.log(`Approved the ${publishJobName} job.`);
}

// The Publish job waits in the windows-signing environment until it is
// approved. It has already failed for want of the draft where the environment
// has no reviewers, or where it was approved before the files were signed; a
// re-run then waits at the environment again.
async function continueRun(repo, runId, runUrl) {
  const pending = pendingSignings(repo, runId);
  if (pending.length > 0) {
    approve(repo, runId, runUrl, pending);
    return;
  }
  const publishJob = viewRun(repo, runId).jobs.find((job) => job.name === publishJobName);
  if (publishJob?.status !== "completed" || publishJob.conclusion === "success") {
    console.log(`The ${publishJobName} job is ${publishJob?.status ?? "missing"}; if it fails without the signed files, run this again.`);
    return;
  }
  runInherited("gh", ["run", "rerun", runId, "--repo", repo, "--failed"]);
  console.log(`Re-ran the ${publishJobName} job, which ran before the files were signed.`);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(10_000);
    const waiting = pendingSignings(repo, runId);
    if (waiting.length > 0) {
      approve(repo, runId, runUrl, waiting);
      return;
    }
    if (viewRun(repo, runId).jobs.find((job) => job.name === publishJobName)?.status === "in_progress") {
      return;
    }
  }
  console.log(`The re-run ${publishJobName} job has not started yet; approve it in GitHub if it waits for review: ${runUrl}`);
}

async function signRun(runId, repo) {
  if (process.platform !== "win32") {
    fail("Windows files are signed on Windows.");
  }
  const thumbprint = certificateThumbprint();

  // Everything that can refuse is asked before the certificate signs
  // anything. It signs whatever the run built, so only a run of this
  // repository's own workflow file started by hand qualifies, and a release
  // only from main, where the Release workflow starts it.
  const meta = JSON.parse(run("gh", ["api", `repos/${repo}/actions/runs/${runId}`, "--jq", "{path, event, head_branch}"]));
  if (meta.path !== workflowPath || meta.event !== "workflow_dispatch") {
    fail(`Run ${runId} of ${repo} is a ${meta.event} run of ${meta.path || "an unknown workflow"}, not a run of ${workflowPath} started by hand.`);
  }
  const runInfo = viewRun(repo, runId);
  const build = runInfo.jobs.find((job) => job.name === buildJobName);
  if (build?.conclusion !== "success") {
    fail(`The run's ${buildJobName} job has not succeeded (${build ? `${build.status} ${build.conclusion}` : "missing"}): ${runInfo.url}`);
  }
  if (runInfo.jobs.find((job) => job.name === publishJobName)?.conclusion === "success") {
    fail(`The run's ${publishJobName} job has already succeeded; there is nothing to sign: ${runInfo.url}`);
  }
  if (run("gh", ["api", `repos/${repo}`, "--jq", ".permissions.push"]).trim() !== "true") {
    fail(`This GitHub account cannot write to ${repo}, where the signed files go. Sign in as the User (gh auth login) and run this again.`);
  }
  if (pendingSignings(repo, runId).some((deployment) => !deployment.current_user_can_approve)) {
    fail(`This GitHub account is not a reviewer of ${signingEnvironment}, so it could not let the run go on. Sign in as the User (gh auth login) and run this again.`);
  }

  // Squirrel takes the package's name, version and description from this
  // checkout, so it must be the commit the run built: for a release, the one
  // its tag names here, not only the one the run says it built.
  const info = downloadBuildInfo(repo, runId);
  const head = run("git", ["rev-parse", "HEAD"]).trim();
  if (info.commit !== head) {
    fail(`Run ${runId} built ${info.commit}; check out that commit first (this checkout is at ${head}).`);
  }
  if (info.tag) {
    if (meta.head_branch !== "main") {
      fail(`Run ${runId} builds the release ${info.tag} but was started from ${meta.head_branch}, not main.`);
    }
    const tagged = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${info.tag}^{commit}`], { cwd: rootDir, encoding: "utf8" }).stdout.trim();
    if (tagged !== head) {
      fail(`Run ${runId} built ${info.tag}, but the tag ${info.tag} here ${tagged ? `names ${tagged}` : "is missing"}, not ${head}.`);
    }
  } else {
    console.log(`Run ${runId} is a trial build of ${meta.head_branch} at ${head}: its files are checked and installed, never published.`);
  }
  if (run("git", ["status", "--porcelain"]).trim()) {
    fail("Sign from a clean checkout.");
  }

  // Signing starts from an empty out/: forge packs whatever app it finds
  // there. The artifact holds the app's folder itself.
  const outDir = path.join(rootDir, "out");
  const appDir = packagedAppDir();
  const mainExe = path.join(appDir, `${productName()}.exe`);
  rmSync(outDir, { recursive: true, force: true });
  console.log(`==> Downloading the unsigned app of ${runInfo.url}`);
  downloadArtifact(repo, runId, "windows-unsigned-app", outDir);
  if (!existsSync(mainExe)) {
    fail(`The run's unsigned app has no ${path.relative(rootDir, mainExe)}.`);
  }
  // signtool cannot open a file whose path is longer than Windows' 260
  // characters, and the installer build nests the app a little deeper.
  const longest = binaries(appDir).reduce((found, file) => (file.length > found.length ? file : found), "");
  if (longest.length > 230) {
    fail(`${longest} is ${longest.length} characters long, too long for signtool. Clone the repository into a shorter folder, such as C:\\src\\AccordAgents-release, and run this again.`);
  }

  // windows-sign only logs a failed hook, and Squirrel then packs the file as
  // it is, so the hook also lists what it could not sign.
  const failureDir = mkdtempSync(path.join(os.tmpdir(), "accordagents-sign-failures-"));
  const failureLog = path.join(failureDir, "failures.txt");
  writeFileSync(failureLog, "");
  Object.assign(process.env, { WINDOWS_SIGN_CERT_SHA1: thumbprint, WINDOWS_SIGN_FAILURES: failureLog });
  try {
    console.log("\n==> Signing the app");
    // The app's own executable first: a closed SimplySign session stops here.
    try {
      require(hookModulePath)(mainExe);
    } catch {
      fail("Signing failed, with signtool's error above. If SimplySign Desktop is not signed in, sign in with the code from its phone app and run this again.");
    }
    const { sign } = await import("@electron/windows-sign");
    await sign({ appDirectory: appDir, hookModulePath });

    console.log("\n==> Packing and signing the installer");
    runInherited(process.execPath, [
      require.resolve("@electron-forge/cli/dist/electron-forge.js"),
      "make", "--skip-package", "--platform=win32", "--arch=x64"
    ], envWithoutGitHubTokens());
    const unsigned = readFileSync(failureLog, "utf8").split("\n").filter(Boolean);
    if (unsigned.length > 0) {
      fail(`These files could not be signed (signtool's errors are above):\n${unsigned.map((file) => `- ${file}`).join("\n")}`);
    }
  } finally {
    rmSync(failureDir, { recursive: true, force: true });
  }
  const files = prepareReleaseFiles(info.version);

  console.log("\n==> Checking the signatures");
  checkSignatures(files.installer[0], appDir);

  console.log("\n==> Handing the signed files to the run");
  // RELEASES.sha256 goes along for the Publish job's checks only; it is never published.
  const releasesChecksum = `${files.update.find((file) => path.basename(file) === "RELEASES")}.sha256`;
  const draft = uploadDraft(repo, runId, runInfo.url, [...files.update, ...files.installer, releasesChecksum]);
  await continueRun(repo, runId, runInfo.url);
  console.log(`\nThe signed files are in the draft ${draft} of ${repo}; the run goes on: ${runInfo.url}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }
  if (args[0] === "--check" && args.length >= 2) {
    const [setup, appDir, ...others] = args.slice(1).map((arg) => path.resolve(arg));
    checkSignatures(setup, appDir, others);
    return;
  }
  const runIndex = args.indexOf("--run");
  const repoIndex = args.indexOf("--repo");
  const runId = runIndex === -1 ? "" : args[runIndex + 1] || "";
  const repo = repoIndex === -1 ? parseGitHubRepo(packageJson().repository) : parseGitHubRepo(args[repoIndex + 1]);
  if (!/^\d+$/.test(runId) || !repo) {
    printHelp();
    process.exit(1);
  }
  await signRun(runId, repo);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  await main();
}
