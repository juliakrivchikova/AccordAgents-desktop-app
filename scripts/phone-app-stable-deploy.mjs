import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// A stable release comes from main, which can be behind beta: the phone may already run a newer
// phone app from a beta, and deploying main's would take it off the phone. A merge can join two
// phone changes under one ASSET_VERSION, so the label alone cannot tell; the sources can.

const WORKER = "src/mobile/service-worker.js";
// What scripts/build-mobile-shell.mjs builds the phone app from.
const PHONE_APP_SOURCES = ["src/mobile", "src/shared", "src/renderer/assets", "scripts/build-mobile-shell.mjs"];

// Only the characters versions are made of: the served one reaches the run log, where a line
// starting with "::" is a workflow command.
export function assetVersion(text) {
  return /ASSET_VERSION = "([A-Za-z0-9._-]+)"/.exec(text ?? "")?.[1];
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function succeeds(cwd, args) {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

// deploy: the release has every phone change beta has, and knows the version the phone runs.
// keep: the phone may run something this release lacks. fail: the site could not be read.
export function phoneAppStableDeploy({ cwd = process.cwd(), served, head = "HEAD", beta = "refs/remotes/origin/beta" }) {
  const release = assetVersion(git(cwd, ["show", `${head}:${WORKER}`]));
  if (!served) {
    return { action: "fail", message: "Could not read the ASSET_VERSION the phone app's site serves, so this release cannot tell what the phone runs. Re-run this job once the site answers." };
  }
  if (!succeeds(cwd, ["rev-parse", "--verify", "--quiet", `${beta}^{commit}`])) {
    return { action: "fail", message: `Could not find beta (${beta}), so this release cannot tell whether beta has phone app changes it lacks.` };
  }
  // -m: a version can be made in a merge. --full-history: a merge that kept one side's version must
  // not hide the other side's commits.
  const known = served === release ||
    git(cwd, ["log", "-m", "--full-history", "-1", "--format=%H", `-SASSET_VERSION = "${served}"`, head, "--", WORKER]) !== "";
  if (!known) {
    return { action: "keep", message: `The phone runs ${served}, which this release does not have, so the phone keeps it. Deploy by hand from a commit that has both.` };
  }
  if (!succeeds(cwd, ["merge-base", "--is-ancestor", beta, head]) && !succeeds(cwd, ["diff", "--quiet", beta, head, "--", ...PHONE_APP_SOURCES])) {
    return { action: "keep", message: `beta has phone app changes this release does not have, and the phone may already run them, so it keeps ${served}. They reach the phone with the next beta.` };
  }
  return { action: "deploy", message: `The phone runs ${served}; deploying ${release}.` };
}

async function servedVersion(site) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${site}/service-worker.js?check=${Date.now()}`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(15_000)
      });
      if (response.ok) return assetVersion(await response.text());
      console.log(`${site}/service-worker.js answered ${response.status}.`);
    } catch (error) {
      console.log(`Could not reach ${site}: ${error.message}`);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return undefined;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const site = argument("--site");
  if (!site) {
    console.error("Usage: node scripts/phone-app-stable-deploy.mjs --site <url> [--beta <commit>]");
    process.exit(2);
  }
  const { action, message } = phoneAppStableDeploy({ served: await servedVersion(site), beta: argument("--beta") || undefined });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${action === "deploy"}\n`);
  // exitCode, not exit(): exiting while fetch still holds a socket crashes Node on Windows.
  process.exitCode = action === "fail" ? 1 : 0;
  console.log(action === "fail" ? `::error::${message}` : action === "keep" ? `::warning::${message}` : message);
}
