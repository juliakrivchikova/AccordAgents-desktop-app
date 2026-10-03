import { execFileSync } from "node:child_process";

function ghApi(args) {
  return JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

// update.electronjs.org serves the first published release in GitHub's release list. GitHub orders
// that list by the date of each tag's commit and breaks ties by tag name as text, so while every tag
// pointed at one commit, v1.11.1-beta.9 stayed above v1.11.1-beta.10 and the feed never offered
// beta.10. Tagging each new release at a fresh empty commit keeps the newest release first.
export function createReleaseTargetCommit(releaseRepo, branch, tagName, { api = ghApi, warn = console.warn } = {}) {
  const headSha = api([`repos/${releaseRepo}/git/ref/heads/${branch}`]).object.sha;
  const treeSha = api([`repos/${releaseRepo}/git/commits/${headSha}`]).tree.sha;
  const commitSha = api([
    "--method",
    "POST",
    `repos/${releaseRepo}/git/commits`,
    "-f",
    `message=Release ${tagName}`,
    "-f",
    `tree=${treeSha}`,
    "-f",
    `parents[]=${headSha}`
  ]).sha;

  try {
    // Fast-forward only: a branch that moved meanwhile is left alone, and the tag still keeps the commit.
    api(["--method", "PATCH", `repos/${releaseRepo}/git/refs/heads/${branch}`, "-f", `sha=${commitSha}`]);
  } catch (error) {
    warn(`Could not move ${branch} in ${releaseRepo} to ${commitSha}; ${tagName} still targets it. ${error.message}`);
  }

  return commitSha;
}
