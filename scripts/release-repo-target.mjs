import { execFileSync } from "node:child_process";

function ghApi(args) {
  return JSON.parse(
    execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
  );
}

function ghInherited(args) {
  execFileSync("gh", args, { stdio: "inherit" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// update.electronjs.org serves the first published release in GitHub's release list. GitHub orders
// that list by the date of each tag's commit and breaks ties by version, comparing a prerelease
// suffix as text, so while every tag pointed at one commit, v1.11.1-beta.9 stayed above
// v1.11.1-beta.10 and the feed never offered beta.10. Tagging each new release at a fresh empty
// commit keeps the newest release first.

function releaseTagCommit(releaseRepo, tagName, api) {
  const refs = api([`repos/${releaseRepo}/git/matching-refs/tags/${tagName}`]);
  const ref = refs.find((candidate) => candidate.ref === `refs/tags/${tagName}`);
  return ref ? ref.object.sha : "";
}

// GitHub ignores the release target when the tag already exists, so such a release would keep the
// old commit date and stay hidden from the feed.
export function preflightReleaseRepo(releaseRepo, branch, tagName, { api = ghApi } = {}) {
  if (!api([`repos/${releaseRepo}`]).permissions?.push) {
    throw new Error(`The current GitHub account cannot push to ${releaseRepo}.`);
  }
  api([`repos/${releaseRepo}/git/ref/heads/${branch}`]);
  const existing = releaseTagCommit(releaseRepo, tagName, api);
  if (existing) {
    throw new Error(
      `Tag ${tagName} already exists in ${releaseRepo} at ${existing}; a release on it would stay hidden from the update feed. Release another version, or remove that tag from ${releaseRepo} if no release uses it.`
    );
  }
}

export function createReleaseTargetCommit(releaseRepo, branch, tagName, { api = ghApi, warn = console.warn } = {}) {
  const headSha = api([`repos/${releaseRepo}/git/ref/heads/${branch}`]).object.sha;
  const treeSha = api([`repos/${releaseRepo}/git/commits/${headSha}`]).tree.sha;
  const commit = api([
    "--method",
    "POST",
    `repos/${releaseRepo}/git/commits`,
    "-f",
    `message=Release ${tagName}`,
    "-f",
    `tree=${treeSha}`,
    "-f",
    `parents[]=${headSha}`
  ]);
  if (commit.parents?.[0]?.sha !== headSha) {
    throw new Error(`New commit ${commit.sha} in ${releaseRepo} does not descend from ${branch} at ${headSha}.`);
  }

  try {
    // Fast-forward only: a branch that moved meanwhile is left alone; the release tag is created at the commit anyway.
    api(["--method", "PATCH", `repos/${releaseRepo}/git/refs/heads/${branch}`, "-f", `sha=${commit.sha}`]);
  } catch (error) {
    warn(`Could not move ${branch} in ${releaseRepo} to ${commit.sha}; ${tagName} will be created at it anyway. ${error.message}`);
  }

  return commit.sha;
}

// releaseArgs are the `gh release create` arguments after the tag name, without --target.
export function createReleaseAtFreshCommit(
  { releaseRepo, branch, tagName, releaseArgs },
  { api = ghApi, gh = ghInherited, log = console.log, warn = console.warn } = {}
) {
  preflightReleaseRepo(releaseRepo, branch, tagName, { api });
  const targetCommit = createReleaseTargetCommit(releaseRepo, branch, tagName, { api, warn });
  log(`Release tag target: ${targetCommit}`);
  gh(["release", "create", tagName, ...releaseArgs, "--target", targetCommit]);
  return targetCommit;
}

const semverTag = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function releaseListingProblem(releaseRepo, tagName, targetCommit, checkOrder, api) {
  const taggedCommit = releaseTagCommit(releaseRepo, tagName, api);
  if (taggedCommit !== targetCommit) {
    return `tag ${tagName} points at ${taggedCommit || "nothing"}, not ${targetCommit}`;
  }
  if (!checkOrder) {
    return "";
  }
  // The same list update.electronjs.org reads; --jq keeps the body small however many assets releases carry.
  const releases = api([`repos/${releaseRepo}/releases?per_page=100`, "--jq", "[.[] | {tag_name, draft, prerelease}]"]);
  const first = releases.find((release) => !release.draft && !release.prerelease && semverTag.test(release.tag_name));
  return first?.tag_name === tagName ? "" : `${releaseRepo} lists ${first?.tag_name || "no release"} first, so the update feed would not offer ${tagName}`;
}

// Returns "" when the published release sits on its fresh commit and, if checkOrder, heads the release
// list; otherwise a description of what is still wrong after a few attempts. It never throws, because
// the release is already published by the time this runs.
export async function verifyReleaseListing(
  { releaseRepo, tagName, targetCommit, checkOrder },
  { api = ghApi, wait = sleep, attempts = 4, delayMs = 5_000 } = {}
) {
  let problem = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      problem = releaseListingProblem(releaseRepo, tagName, targetCommit, checkOrder, api);
    } catch (error) {
      problem = `the release could not be checked: ${error.message.trim()}`;
    }
    if (!problem) {
      return "";
    }
    if (attempt < attempts) {
      await wait(delayMs);
    }
  }
  return problem;
}
