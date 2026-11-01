#!/usr/bin/env node

// Signs the Windows x64 app a "Windows release" run built
// (.github/workflows/windows-release.yml), on the PC where SimplySign Desktop
// holds a session for the Certum certificate. It downloads the unsigned app,
// signs its files, packs and signs the Squirrel installer, checks every
// signature, puts the files in a draft release of the source repository and
// lets the run's Publish job go on. That job installs and checks them on a
// clean GitHub machine before anything is published.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { envWithoutGitHubTokens, packagedAppDir, parseGitHubRepo, prepareReleaseFiles } from "./release-windows-x64.mjs";

const rootDir = process.cwd();
const require = createRequire(import.meta.url);
const hookModulePath = path.join(rootDir, "scripts", "windows-sign-file.cjs");
const workflowName = "Windows release";
const buildJobName = "Build";
const publishJobName = "Publish";

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage:
  npm run sign:windows-x64 -- --run <run id> [--repo owner/repo]
  npm run sign:windows-x64 -- --check <app folder> <Setup.exe>

--run signs the app that run's Build job kept. Run it from a clean checkout of
the commit the run built, after npm ci, with SimplySign Desktop signed in. The
signed files go to the draft release windows-signed-<run id> of the source
repository (default: package.json repository); then the run's Publish job is
approved, or re-run when it already ran without them.

--check only checks the signatures of an app folder and its installer.
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

// One PowerShell call reads the status and signer of every file.
function readSignatures(files) {
  const listDir = mkdtempSync(path.join(os.tmpdir(), "accordagents-signatures-"));
  try {
    const listPath = path.join(listDir, "files.txt");
    writeFileSync(listPath, files.join("\n"));
    const script = `$result = @(Get-Content -LiteralPath '${listPath}' -Encoding UTF8 | ForEach-Object {
  $signature = Get-AuthenticodeSignature -LiteralPath $_
  [pscustomobject]@{ path = $_; status = [string]$signature.Status; thumbprint = $signature.SignerCertificate.Thumbprint }
}); ConvertTo-Json -InputObject $result -Compress`;
    return JSON.parse(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]));
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

function checkSignatures(appDir, setupPath) {
  const name = packageJson().productName || packageJson().name;
  const ours = [path.join(appDir, `${name}.exe`), setupPath];
  const problems = signatureProblems(readSignatures([...binaries(appDir), setupPath]), {
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
  return JSON.parse(run("gh", ["run", "view", runId, "--repo", repo, "--json", "workflowName,jobs,url"]));
}

function downloadBuildInfo(repo, runId) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "accordagents-build-info-"));
  try {
    run("gh", ["run", "download", runId, "--repo", repo, "--name", "windows-build-info", "--dir", dir]);
    return JSON.parse(readFileSync(path.join(dir, "build.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function uploadDraft(repo, runId, runUrl, files) {
  const draft = `windows-signed-${runId}`;
  const exists = spawnSync("gh", ["release", "view", draft, "--repo", repo], { stdio: "ignore" }).status === 0;
  if (exists) {
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

// The Publish job waits in the windows-signing environment until it is
// approved; where the environment has no reviewers it has already failed for
// want of the draft, and is re-run instead.
function continueRun(repo, runId) {
  const pending = JSON.parse(run("gh", ["api", `repos/${repo}/actions/runs/${runId}/pending_deployments`]));
  if (pending.length > 0) {
    const args = ["api", "--method", "POST", `repos/${repo}/actions/runs/${runId}/pending_deployments`,
      "-f", "state=approved", "-f", "comment=Signed on the Windows PC."];
    for (const { environment } of pending) {
      args.push("-F", `environment_ids[]=${environment.id}`);
    }
    run("gh", args);
    console.log(`Approved the ${publishJobName} job.`);
    return;
  }
  const publishJob = viewRun(repo, runId).jobs.find((job) => job.name === publishJobName);
  if (publishJob?.status === "completed" && publishJob.conclusion !== "success") {
    runInherited("gh", ["run", "rerun", runId, "--repo", repo, "--failed"]);
    console.log(`Re-ran the ${publishJobName} job, which ran before the files were signed.`);
  }
}

async function signRun(runId, repo) {
  if (process.platform !== "win32") {
    fail("Windows files are signed on Windows.");
  }
  const thumbprint = certificateThumbprint();
  const runInfo = viewRun(repo, runId);
  if (runInfo.workflowName !== workflowName) {
    fail(`Run ${runId} of ${repo} is a "${runInfo.workflowName}" run, not "${workflowName}".`);
  }
  const build = runInfo.jobs.find((job) => job.name === buildJobName);
  if (build?.conclusion !== "success") {
    fail(`The run's ${buildJobName} job has not succeeded (${build ? `${build.status} ${build.conclusion}` : "missing"}): ${runInfo.url}`);
  }

  // Squirrel takes the package's name, version and description from this
  // checkout, so it must be the commit the run built.
  const info = downloadBuildInfo(repo, runId);
  const head = run("git", ["rev-parse", "HEAD"]).trim();
  if (info.commit !== head) {
    fail(`Run ${runId} built ${info.commit}; check out that commit first (this checkout is at ${head}).`);
  }
  if (run("git", ["status", "--porcelain"]).trim()) {
    fail("Sign from a clean checkout.");
  }

  const appDir = packagedAppDir();
  rmSync(path.dirname(appDir), { recursive: true, force: true });
  console.log(`==> Downloading the unsigned app of ${runInfo.url}`);
  run("gh", ["run", "download", runId, "--repo", repo, "--name", "windows-unsigned-app", "--dir", appDir]);

  console.log("\n==> Signing the app");
  process.env.WINDOWS_SIGN_CERT_SHA1 = thumbprint;
  const mainExe = path.join(appDir, `${packageJson().productName || packageJson().name}.exe`);
  try {
    require(hookModulePath)(mainExe);
  } catch {
    fail("Signing failed. Open SimplySign Desktop, sign in with the code from its phone app, and run this again.");
  }
  const { sign } = await import("@electron/windows-sign");
  await sign({ appDirectory: appDir, hookModulePath });

  console.log("\n==> Packing and signing the installer");
  runInherited(process.execPath, [
    require.resolve("@electron-forge/cli/dist/electron-forge.js"),
    "make", "--skip-package", "--platform=win32", "--arch=x64"
  ], { ...envWithoutGitHubTokens(), WINDOWS_SIGN_CERT_SHA1: thumbprint });
  const files = prepareReleaseFiles(info.version);

  console.log("\n==> Checking the signatures");
  checkSignatures(appDir, files.installer[0]);

  console.log("\n==> Handing the signed files to the run");
  const draft = uploadDraft(repo, runId, runInfo.url, [...files.update, ...files.installer]);
  continueRun(repo, runId);
  console.log(`\nThe signed files are in the draft ${draft} of ${repo}; the run goes on: ${runInfo.url}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }
  if (args[0] === "--check" && args.length === 3) {
    checkSignatures(path.resolve(args[1]), path.resolve(args[2]));
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
