import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createReleaseAtFreshCommit, createReleaseTargetCommit, preflightReleaseRepo, verifyReleaseListing } from "./release-repo-target.mjs";

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
    if (key === `GET ${repo}/releases?per_page=100`) {
      assert.ok(args.includes("--jq"), "the full release list can outgrow the output buffer");
      return state.releases;
    }
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

test("creates the release at the fresh commit, after the preflight", () => {
  const { api, gh, calls, ghCalls } = fakeGitHub();

  assert.equal(createReleaseAtFreshCommit({ releaseRepo: repo, branch: "main", tagName: tag, releaseArgs: ["a.zip", "--repo", repo, "--latest"] }, { api, gh, ...quiet() }), "fresh-sha");
  assert.deepEqual(ghCalls, [["release", "create", tag, "a.zip", "--repo", repo, "--latest", "--target", "fresh-sha"]]);
  assert.deepEqual(calls[0], [`repos/${repo}`]);

  const taken = fakeGitHub();
  taken.state.tags[tag] = "old-sha";
  assert.throws(() => createReleaseAtFreshCommit({ releaseRepo: repo, branch: "main", tagName: tag, releaseArgs: [] }, { api: taken.api, gh: taken.gh, ...quiet() }), /already exists/);
  assert.equal(taken.ghCalls.length, 0);
  assert.ok(!taken.calls.some((args) => args.includes("POST")), "no commit for a taken tag");
});

function publish(github) {
  createReleaseAtFreshCommit({ releaseRepo: repo, branch: "main", tagName: tag, releaseArgs: [] }, { api: github.api, gh: github.gh, ...quiet() });
}

const noWait = { wait: async () => {} };

test("a published release on its fresh commit at the head of the list passes", async () => {
  const github = fakeGitHub();
  publish(github);
  // Drafts and tags the feed ignores may sit above it.
  github.state.releases.unshift({ tag_name: "v1.9.5-beta.12", draft: true, prerelease: false }, { tag_name: "nightly", draft: false, prerelease: false });

  assert.equal(await verifyReleaseListing({ releaseRepo: repo, tagName: tag, targetCommit: "fresh-sha", checkOrder: true }, { api: github.api, ...noWait }), "");
});

test("reports a release that landed on another commit or behind an older release", async () => {
  const existingTag = fakeGitHub();
  publish(existingTag);
  existingTag.state.tags[tag] = "old-sha";
  assert.equal(
    await verifyReleaseListing({ releaseRepo: repo, tagName: tag, targetCommit: "fresh-sha", checkOrder: true }, { api: existingTag.api, ...noWait }),
    "tag v1.11.1-beta.10 points at old-sha, not fresh-sha"
  );

  const hidden = fakeGitHub();
  publish(hidden);
  hidden.state.releases.push(hidden.state.releases.shift());
  assert.equal(
    await verifyReleaseListing({ releaseRepo: repo, tagName: tag, targetCommit: "fresh-sha", checkOrder: true }, { api: hidden.api, ...noWait }),
    "owner/releases lists v1.11.1-beta.9 first, so the update feed would not offer v1.11.1-beta.10"
  );
});

test("retries a list that is briefly stale or unreadable and never throws", async () => {
  let reads = 0;
  const github = fakeGitHub({
    [`GET ${repo}/releases?per_page=100`]: (_args, state) => {
      reads += 1;
      if (reads === 1) throw new Error("HTTP 502");
      return reads === 2 ? state.releases.slice(1) : state.releases;
    }
  });
  publish(github);
  const waits = [];

  assert.equal(
    await verifyReleaseListing({ releaseRepo: repo, tagName: tag, targetCommit: "fresh-sha", checkOrder: true }, { api: github.api, wait: async (ms) => waits.push(ms) }),
    ""
  );
  assert.deepEqual(waits, [5000, 5000]);

  const broken = fakeGitHub({
    [`GET ${repo}/releases?per_page=100`]: () => {
      throw new Error("HTTP 502");
    }
  });
  publish(broken);
  assert.equal(
    await verifyReleaseListing({ releaseRepo: repo, tagName: tag, targetCommit: "fresh-sha", checkOrder: true }, { api: broken.api, ...noWait }),
    "the release list could not be read: HTTP 502"
  );
});

test("a prerelease is checked for its tag but not against the feed", async () => {
  const github = fakeGitHub({ [`GET ${repo}/releases?per_page=100`]: assert.fail });
  publish(github);

  assert.equal(await verifyReleaseListing({ releaseRepo: repo, tagName: tag, targetCommit: "fresh-sha", checkOrder: false }, { api: github.api, ...noWait }), "");
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
