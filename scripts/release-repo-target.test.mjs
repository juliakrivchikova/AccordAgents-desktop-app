import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createReleaseAtFreshCommit, createReleaseTargetCommit, preflightReleaseRepo } from "./release-repo-target.mjs";

const repo = "owner/releases";
const tag = "v1.11.1-beta.10";

// A fake GitHub: the releases repo holds beta.1 and beta.9 on one commit, as the real beta repo did.
function fakeGitHub(overrides = {}) {
  const state = {
    tags: { "v1.11.1-beta.1": "old-sha", "v1.11.1-beta.9": "old-sha" },
    releases: [
      { tag_name: "v1.11.1-beta.9", draft: false, prerelease: false },
      { tag_name: "v1.11.1-beta.1", draft: false, prerelease: false }
    ]
  };
  const calls = [];
  const api = (args) => {
    calls.push(args);
    const endpoint = args.find((arg) => arg.startsWith("repos/")).slice("repos/".length);
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    const key = `${method} ${endpoint}`;
    if (overrides[key]) {
      return overrides[key](args, state);
    }
    if (key === `GET ${repo}`) return { permissions: { push: true } };
    if (key === `GET ${repo}/git/ref/heads/main`) return { object: { sha: "head-sha" } };
    if (key === `GET ${repo}/git/commits/head-sha`) return { tree: { sha: "tree-sha" } };
    if (key === `POST ${repo}/git/commits`) return { sha: "fresh-sha", parents: [{ sha: "head-sha" }] };
    if (key === `PATCH ${repo}/git/refs/heads/main`) return { object: { sha: "fresh-sha" } };
    if (key.startsWith(`GET ${repo}/git/matching-refs/tags/`)) {
      const prefix = key.slice(`GET ${repo}/git/matching-refs/tags/`.length);
      return Object.entries(state.tags)
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, sha]) => ({ ref: `refs/tags/${name}`, object: { sha } }));
    }
    if (key === `GET ${repo}/releases?per_page=100`) return state.releases;
    throw new Error(`Unexpected gh api call: ${key}`);
  };
  const ghCalls = [];
  // Like GitHub with the real ordering: the fresh commit is newer, so the new release lists first.
  const gh = (args) => {
    ghCalls.push(args);
    const tagName = args[2];
    const target = args[args.indexOf("--target") + 1];
    if (!args.includes("--draft")) {
      state.tags[tagName] ??= target;
    }
    const release = { tag_name: tagName, draft: args.includes("--draft"), prerelease: args.includes("--prerelease") };
    state.releases = state.tags[tagName] === "fresh-sha" ? [release, ...state.releases] : [...state.releases, release];
  };
  return { api, gh, calls, ghCalls, state };
}

function quiet() {
  return { log: () => {}, warn: assert.fail };
}

test("creates an empty commit on the branch head and fast-forwards the branch to it", () => {
  const { api, calls } = fakeGitHub();

  assert.equal(createReleaseTargetCommit(repo, "main", tag, { api, warn: assert.fail }), "fresh-sha");
  assert.deepEqual(calls, [
    [`repos/${repo}/git/ref/heads/main`],
    [`repos/${repo}/git/commits/head-sha`],
    ["--method", "POST", `repos/${repo}/git/commits`, "-f", `message=Release ${tag}`, "-f", "tree=tree-sha", "-f", "parents[]=head-sha"],
    ["--method", "PATCH", `repos/${repo}/git/refs/heads/main`, "-f", "sha=fresh-sha"]
  ]);
  assert.ok(!calls.flat().includes("force=true"), "the branch must only fast-forward");
});

test("still targets the fresh commit when the branch cannot be fast-forwarded", () => {
  const { api } = fakeGitHub({
    [`PATCH ${repo}/git/refs/heads/main`]: () => {
      throw new Error("Update is not a fast forward");
    }
  });
  const warnings = [];

  assert.equal(createReleaseTargetCommit(repo, "main", tag, { api, warn: (message) => warnings.push(message) }), "fresh-sha");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not move main in owner\/releases to fresh-sha; v1\.11\.1-beta\.10 will be created at it anyway\. Update is not a fast forward/);
});

test("does not touch the branch when the commit cannot be made or does not descend from it", () => {
  for (const response of [
    () => {
      throw new Error("HTTP 403");
    },
    () => ({ sha: "root-sha", parents: [] })
  ]) {
    const { api, calls } = fakeGitHub({ [`POST ${repo}/git/commits`]: response });
    assert.throws(() => createReleaseTargetCommit(repo, "main", tag, { api, warn: assert.fail }), /HTTP 403|does not descend from main at head-sha/);
    assert.equal(calls.length, 3);
  }
});

test("preflight refuses a tag that already exists or a repo it cannot push to", () => {
  const taken = fakeGitHub();
  taken.state.tags[tag] = "old-sha";
  assert.throws(() => preflightReleaseRepo(repo, "main", tag, { api: taken.api }), /Tag v1\.11\.1-beta\.10 already exists in owner\/releases at old-sha/);

  const readOnly = fakeGitHub({ [`GET ${repo}`]: () => ({ permissions: { push: false } }) });
  assert.throws(() => preflightReleaseRepo(repo, "main", tag, { api: readOnly.api }), /cannot push to owner\/releases/);

  // v1.11.1-beta.1 matches the v1.11.1-beta.10 prefix; only an exact tag counts.
  const free = fakeGitHub();
  preflightReleaseRepo(repo, "main", tag, { api: free.api });
  assert.deepEqual(free.calls.at(-1), [`repos/${repo}/git/matching-refs/tags/${tag}`]);
});

test("creates the release at the fresh commit and checks that the feed lists it first", () => {
  const { api, gh, ghCalls, state } = fakeGitHub();

  assert.equal(createReleaseAtFreshCommit({ releaseRepo: repo, branch: "main", tagName: tag, releaseArgs: ["a.zip", "--repo", repo, "--latest"] }, { api, gh, ...quiet() }), "fresh-sha");
  assert.deepEqual(ghCalls, [["release", "create", tag, "a.zip", "--repo", repo, "--latest", "--target", "fresh-sha"]]);
  assert.equal(state.releases[0].tag_name, tag);
});

test("fails loudly when the release lands on another commit or behind an older release", () => {
  const existingTag = fakeGitHub({
    [`GET ${repo}/git/matching-refs/tags/${tag}`]: (_args, state) =>
      state.releases.some((release) => release.tag_name === tag) ? [{ ref: `refs/tags/${tag}`, object: { sha: "old-sha" } }] : []
  });
  assert.throws(
    () => createReleaseAtFreshCommit({ releaseRepo: repo, branch: "main", tagName: tag, releaseArgs: [] }, { api: existingTag.api, gh: existingTag.gh, ...quiet() }),
    /Tag v1\.11\.1-beta\.10 in owner\/releases points at old-sha, not fresh-sha/
  );

  const hidden = fakeGitHub({ [`GET ${repo}/releases?per_page=100`]: (_args, state) => [...state.releases.slice(1), state.releases[0]] });
  assert.throws(
    () => createReleaseAtFreshCommit({ releaseRepo: repo, branch: "main", tagName: tag, releaseArgs: [] }, { api: hidden.api, gh: hidden.gh, ...quiet() }),
    /owner\/releases lists v1\.11\.1-beta\.9 before v1\.11\.1-beta\.10, so the update feed will not offer v1\.11\.1-beta\.10/
  );
});

test("a draft is not checked for a tag and a prerelease is not checked against the feed", () => {
  const draft = fakeGitHub();
  createReleaseAtFreshCommit({ releaseRepo: repo, branch: "main", tagName: tag, releaseArgs: ["--draft"], draft: true }, { api: draft.api, gh: draft.gh, ...quiet() });
  assert.equal(draft.calls.filter((args) => args[0].includes("matching-refs")).length, 1, "only the preflight looks up the tag");

  const prerelease = fakeGitHub({ [`GET ${repo}/releases?per_page=100`]: assert.fail });
  createReleaseAtFreshCommit(
    { releaseRepo: repo, branch: "main", tagName: tag, releaseArgs: ["--prerelease"], prerelease: true },
    { api: prerelease.api, gh: prerelease.gh, ...quiet() }
  );
});

test("the default runner passes the arguments to gh api and parses its JSON", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-repo-target-"));
  const logPath = path.join(dir, "calls.log");
  const ghPath = path.join(dir, "gh");
  writeFileSync(
    ghPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${logPath}"
case "$*" in
  "api repos/${repo}/git/ref/heads/main") echo '{"object":{"sha":"head-sha"}}' ;;
  "api repos/${repo}/git/commits/head-sha") echo '{"tree":{"sha":"tree-sha"}}' ;;
  "api --method POST repos/${repo}/git/commits "*) echo '{"sha":"fresh-sha","parents":[{"sha":"head-sha"}]}' ;;
  "api --method PATCH repos/${repo}/git/refs/heads/main -f sha=fresh-sha") echo '{"object":{"sha":"fresh-sha"}}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`
  );
  chmodSync(ghPath, 0o755);
  const originalPath = process.env.PATH;
  // Only the fake: a missing shim must never fall through to the real gh.
  process.env.PATH = dir;
  try {
    assert.equal(createReleaseTargetCommit(repo, "main", tag, { warn: assert.fail }), "fresh-sha");
    assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n"), [
      `api repos/${repo}/git/ref/heads/main`,
      `api repos/${repo}/git/commits/head-sha`,
      `api --method POST repos/${repo}/git/commits -f message=Release ${tag} -f tree=tree-sha -f parents[]=head-sha`,
      `api --method PATCH repos/${repo}/git/refs/heads/main -f sha=fresh-sha`
    ]);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
