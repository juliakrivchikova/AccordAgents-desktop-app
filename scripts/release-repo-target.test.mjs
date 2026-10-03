import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createReleaseTargetCommit } from "./release-repo-target.mjs";

const repo = "owner/releases";

function fakeApi(overrides = {}) {
  const calls = [];
  const api = (args) => {
    calls.push(args);
    const endpoint = args.find((arg) => arg.startsWith("repos/")).slice("repos/".length);
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    const key = `${method} ${endpoint}`;
    if (overrides[key]) {
      return overrides[key](args);
    }
    if (key === `GET ${repo}/git/ref/heads/main`) return { object: { sha: "head-sha" } };
    if (key === `GET ${repo}/git/commits/head-sha`) return { tree: { sha: "tree-sha" } };
    if (key === `POST ${repo}/git/commits`) return { sha: "fresh-sha" };
    if (key === `PATCH ${repo}/git/refs/heads/main`) return { object: { sha: "fresh-sha" } };
    throw new Error(`Unexpected gh api call: ${key}`);
  };
  return { api, calls };
}

test("creates an empty commit on the branch head and fast-forwards the branch to it", () => {
  const { api, calls } = fakeApi();
  const warnings = [];

  const sha = createReleaseTargetCommit(repo, "main", "v1.11.1-beta.11", { api, warn: (message) => warnings.push(message) });

  assert.equal(sha, "fresh-sha");
  assert.deepEqual(calls, [
    [`repos/${repo}/git/ref/heads/main`],
    [`repos/${repo}/git/commits/head-sha`],
    [
      "--method",
      "POST",
      `repos/${repo}/git/commits`,
      "-f",
      "message=Release v1.11.1-beta.11",
      "-f",
      "tree=tree-sha",
      "-f",
      "parents[]=head-sha"
    ],
    ["--method", "PATCH", `repos/${repo}/git/refs/heads/main`, "-f", "sha=fresh-sha"]
  ]);
  assert.ok(!calls.flat().includes("force=true"), "the branch must only fast-forward");
  assert.deepEqual(warnings, []);
});

test("still targets the fresh commit when the branch cannot be fast-forwarded", () => {
  const { api } = fakeApi({
    [`PATCH ${repo}/git/refs/heads/main`]: () => {
      throw new Error("Update is not a fast forward");
    }
  });
  const warnings = [];

  const sha = createReleaseTargetCommit(repo, "main", "v1.11.1-beta.11", { api, warn: (message) => warnings.push(message) });

  assert.equal(sha, "fresh-sha");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not move main in owner\/releases to fresh-sha; v1\.11\.1-beta\.11 still targets it\. Update is not a fast forward/);
});

test("fails before any release is created when the commit cannot be made", () => {
  const { api, calls } = fakeApi({
    [`POST ${repo}/git/commits`]: () => {
      throw new Error("HTTP 403");
    }
  });

  assert.throws(() => createReleaseTargetCommit(repo, "main", "v1.11.1-beta.11", { api, warn: () => {} }), /HTTP 403/);
  assert.equal(calls.length, 3, "the branch is not touched after a failed commit");
});

test("the default runner passes the arguments to gh api and parses its JSON", () => {
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
  "api --method POST repos/${repo}/git/commits "*) echo '{"sha":"fresh-sha"}' ;;
  "api --method PATCH repos/${repo}/git/refs/heads/main -f sha=fresh-sha") echo '{"object":{"sha":"fresh-sha"}}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`
  );
  chmodSync(ghPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  try {
    assert.equal(createReleaseTargetCommit(repo, "main", "v1.11.1-beta.11", { warn: assert.fail }), "fresh-sha");
    assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n"), [
      `api repos/${repo}/git/ref/heads/main`,
      `api repos/${repo}/git/commits/head-sha`,
      `api --method POST repos/${repo}/git/commits -f message=Release v1.11.1-beta.11 -f tree=tree-sha -f parents[]=head-sha`,
      `api --method PATCH repos/${repo}/git/refs/heads/main -f sha=fresh-sha`
    ]);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
