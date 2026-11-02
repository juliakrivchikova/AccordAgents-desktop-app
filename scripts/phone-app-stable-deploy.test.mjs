import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { phoneAppStableDeploy } from "./phone-app-stable-deploy.mjs";

const script = path.join(import.meta.dirname, "phone-app-stable-deploy.mjs");

// main and beta as the release flow keeps them. Two phone changes f and g reach beta, whose merge
// of g keeps g's version for both, as merge 3046fce did; main takes only g.
function releaseRepo() {
  const cwd = mkdtempSync(path.join(tmpdir(), "phone-app-stable-deploy-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (message, files) => {
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(cwd, file), text);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const worker = (version) => ({ "src/mobile/service-worker.js": `const ASSET_VERSION = "${version}";\n` });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "core.autocrlf", "false");
  mkdirSync(path.join(cwd, "src/mobile"), { recursive: true });
  commit("v1", { ...worker("v1"), "src/mobile/f.js": "f1\n", "src/mobile/g.js": "g1\n" });
  git("branch", "beta");
  git("switch", "-q", "-c", "f");
  commit("f", { ...worker("vF"), "src/mobile/f.js": "f2\n" });
  git("switch", "-q", "-c", "g", "main");
  commit("g", { ...worker("vG"), "src/mobile/g.js": "g2\n" });
  git("switch", "-q", "beta");
  git("merge", "-q", "--no-ff", "-m", "Merge f", "f");
  git("merge", "-q", "--no-ff", "-X", "theirs", "-m", "Merge g", "g");
  git("switch", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "Merge g", "g");
  const mainWithG = commit("Bump version", { "package.json": "1\n" });
  git("merge", "-q", "--no-ff", "-m", "Merge beta", "beta");
  const mainWithBeta = commit("Bump version", { "package.json": "2\n" });
  git("update-ref", "refs/remotes/origin/beta", "beta");
  return { cwd, git, commit, mainWithG, mainWithBeta };
}

test("a stable release deploys the phone app only when that cannot take a newer one off the phone", (t) => {
  const repo = releaseRepo();
  t.after(() => rmSync(repo.cwd, { recursive: true, force: true }));
  const cases = [
    { name: "main has all of beta", head: repo.mainWithBeta, served: "vG", action: "deploy" },
    { name: "the phone runs a version main replaced", head: repo.mainWithBeta, served: "v1", action: "deploy" },
    { name: "the phone runs beta's vG, which also carries f, and main has only g", head: repo.mainWithG, served: "vG", action: "keep" },
    { name: "the phone runs a hand deploy from a branch main never got", head: repo.mainWithBeta, served: "vUnmerged", action: "keep" },
    { name: "the site could not be read", head: repo.mainWithBeta, served: undefined, action: "fail" },
    { name: "beta cannot be found", head: repo.mainWithBeta, served: "vG", beta: "refs/remotes/origin/gone", action: "fail" }
  ];
  for (const { name, head, served, beta, action } of cases) {
    assert.equal(phoneAppStableDeploy({ cwd: repo.cwd, served, head, beta }).action, action, name);
  }

  // A version made while resolving a merge is still this release's.
  repo.git("switch", "-q", "-c", "h", repo.mainWithBeta);
  repo.commit("h", { "src/mobile/service-worker.js": 'const ASSET_VERSION = "vH";\n' });
  repo.git("switch", "-q", "main");
  repo.commit("m", { "src/mobile/service-worker.js": 'const ASSET_VERSION = "vM";\n' });
  assert.throws(() => repo.git("merge", "-q", "--no-ff", "-m", "Merge h", "h"));
  repo.commit("Merge h", { "src/mobile/service-worker.js": 'const ASSET_VERSION = "vMerged";\n' });
  const later = repo.commit("Next", { "src/mobile/service-worker.js": 'const ASSET_VERSION = "vNext";\n' });
  repo.git("update-ref", "refs/remotes/origin/beta", later);
  assert.equal(phoneAppStableDeploy({ cwd: repo.cwd, served: "vMerged", head: later }).action, "deploy", "the phone runs a version made in a merge");

  // beta moving on after main was cut costs nothing unless it moves the phone app.
  repo.git("switch", "-q", "beta");
  repo.commit("Docs", { "README.md": "docs\n" });
  repo.git("update-ref", "refs/remotes/origin/beta", "beta");
  assert.equal(phoneAppStableDeploy({ cwd: repo.cwd, served: "vG", head: repo.mainWithBeta }).action, "deploy", "beta moved past main without phone changes");
  repo.commit("Phone", { "src/mobile/g.js": "g3\n" });
  repo.git("update-ref", "refs/remotes/origin/beta", "beta");
  assert.equal(phoneAppStableDeploy({ cwd: repo.cwd, served: "vG", head: repo.mainWithBeta }).action, "keep", "beta moved past main with a phone change");
});

test("the workflow deploys only on an explicit deploy=true", async (t) => {
  const repo = releaseRepo();
  let served = "vG";
  const server = createServer((request, response) => {
    if (served === "down") {
      response.writeHead(503).end();
      return;
    }
    response.end(`const ASSET_VERSION = "${served}";\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    rmSync(repo.cwd, { recursive: true, force: true });
  });
  const site = `http://127.0.0.1:${server.address().port}`;
  const run = async (head) => {
    repo.git("checkout", "-q", "--detach", head);
    const output = path.join(repo.cwd, `output-${Math.random()}`);
    writeFileSync(output, "");
    const result = await promisify(execFile)(process.execPath, [script, "--site", site], { cwd: repo.cwd, env: { ...process.env, GITHUB_OUTPUT: output } })
      .then(({ stdout }) => ({ code: 0, stdout }), (error) => ({ code: error.code, stdout: error.stdout }));
    return { ...result, output: readFileSync(output, "utf8") };
  };

  assert.deepEqual(await run(repo.mainWithBeta).then(({ code, output }) => ({ code, output })), { code: 0, output: "deploy=true\n" });
  const kept = await run(repo.mainWithG);
  assert.deepEqual({ code: kept.code, output: kept.output }, { code: 0, output: "deploy=false\n" });
  assert.match(kept.stdout, /^::warning::/m);
  served = "down";
  assert.deepEqual(await run(repo.mainWithBeta).then(({ code, output }) => ({ code, output })), { code: 1, output: "deploy=false\n" });
});
