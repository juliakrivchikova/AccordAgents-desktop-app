import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AwsDiskChangeResult, AwsDiskListing, AwsDiskReport, CloudRunWorkerSettings } from "../../shared/types";
import { AwsInstanceDiskService, type AwsInstanceDiskExec } from "./awsInstanceDisk";
import { awsInstanceDiskScript, type AwsInstanceDiskRequest } from "./awsInstanceDiskScript";
import { CommandError } from "./command";

const OWN = "accordagents-0123456789abcdef01234567";
const OTHER = "accordagents-fedcba9876543210fedcba98";
const tools = ["python3", "git", "du"].every((tool) => spawnSync("which", [tool]).status === 0);
const needsTools = tools ? {} : { skip: "python3, git and du are needed to run the instance script" };

function write(file: string, bytes = 4096): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=qa@example.com", "-c", "user.name=QA", ...args], { cwd, stdio: "ignore" });
}

function age(file: string, days: number): void {
  const when = new Date(Date.now() - days * 86_400_000);
  fs.utimesSync(file, when, when);
}

function repo(folder: string): string {
  fs.mkdirSync(folder, { recursive: true });
  git(folder, "init", "-q");
  fs.writeFileSync(path.join(folder, "README.md"), "x");
  git(folder, "add", ".");
  git(folder, "commit", "-qm", "init");
  return folder;
}

/** A project pushed to a remote: what makes a copy safe to delete. */
function pushedRepo(folder: string, remote: string): string {
  repo(folder);
  execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
  git(folder, "remote", "add", "origin", remote);
  git(folder, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(folder, "fetch", "-q", "origin");
  return folder;
}

/** A home folder laid out the way the app lays out the instance. */
function fixtureHome(t: TestContext): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aws-disk-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const own = path.join(home, OWN);
  for (const version of ["1.0.0-aaa", "1.1.0-bbb", "1.2.0-ccc"]) write(path.join(own, "releases", version, "runtime.cjs"), 64 * 1024);
  age(path.join(own, "releases", "1.0.0-aaa"), 3);
  age(path.join(own, "releases", "1.1.0-bbb"), 3);
  fs.symlinkSync(path.join(own, "releases", "1.2.0-ccc"), path.join(own, "current"));
  write(path.join(own, "agent-setup", "bundles", "abc", "node"), 128 * 1024);
  write(path.join(own, "home", ".codex", "auth.json"));
  write(path.join(own, "home", ".npm", "_cacache", "blob"), 32 * 1024);
  write(path.join(own, "enrollment.json"));
  const logs = path.join(home, ".accordagents", OWN, "debug-logs");
  write(path.join(logs, "2026-10-01.jsonl"), 256 * 1024);
  write(path.join(logs, "2026-10-08.jsonl"), 256 * 1024);
  age(path.join(logs, "2026-10-01.jsonl"), 3);
  write(path.join(home, ".accordagents", OWN, "accordagents.sqlite3"));
  write(path.join(home, OTHER, "releases", "9.9.9", "runtime.cjs"));
  write(path.join(home, "accordagents-review", "notes", "todo.md"));
  write(path.join(home, ".cache", "electron", "zip"), 16 * 1024);
  write(path.join(home, ".cache", "ms-playwright", "chrome", "bin"), 16 * 1024);
  write(path.join(home, ".cache", "huggingface", "token"), 64);
  write(path.join(home, ".cache", "huggingface", "hub", "model.bin"), 32 * 1024);
  write(path.join(home, ".ssh", "authorized_keys"));
  // Cloud run working files: a device's runs, its agent tools, mailbox runners.
  const device = path.join(home, ".accordagents", "remote-runs", "devices", "d1");
  write(path.join(device, "run-1", "out.log"));
  write(path.join(device, "agent-setup", "node"));
  write(path.join(home, "~", "runner", "out.log"));
  // Project copies: pushed and clean, with a member's worktree, with changes,
  // with a commit nobody pushed, and with a stash.
  const mirrors = path.join(own, "workspace", "mirrors");
  const remotes = path.join(home, ".remotes");
  pushedRepo(path.join(mirrors, "clean", "repo"), path.join(remotes, "clean.git"));
  pushedRepo(path.join(mirrors, "shared", "repo"), path.join(remotes, "shared.git"));
  git(path.join(mirrors, "shared", "repo"), "worktree", "add", "-q", path.join(mirrors, "shared", "wt-member"));
  pushedRepo(path.join(mirrors, "dirty", "repo"), path.join(remotes, "dirty.git"));
  fs.writeFileSync(path.join(mirrors, "dirty", "repo", "README.md"), "changed");
  pushedRepo(path.join(mirrors, "ahead", "repo"), path.join(remotes, "ahead.git"));
  fs.writeFileSync(path.join(mirrors, "ahead", "repo", "new.md"), "y");
  git(path.join(mirrors, "ahead", "repo"), "add", ".");
  git(path.join(mirrors, "ahead", "repo"), "commit", "-qm", "not pushed");
  pushedRepo(path.join(mirrors, "stashed", "repo"), path.join(remotes, "stashed.git"));
  fs.writeFileSync(path.join(mirrors, "stashed", "repo", "README.md"), "kept aside");
  git(path.join(mirrors, "stashed", "repo"), "stash", "-q");
  return home;
}

function runScript(home: string, mode: AwsInstanceDiskRequest["mode"], arg: unknown = "", env: Record<string, string> = {}, withWork?: Record<string, string[]>): any {
  const result = spawnSync("python3", ["-"], {
    input: awsInstanceDiskScript({ mode, arg, root: `~/${OWN}`, data: `~/.accordagents/${OWN}`, withWork }),
    env: { ...process.env, HOME: home, ...env },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
}

function locks(home: string, folder: string, env: Record<string, string> = {}): Record<string, string | null> {
  const listing = runScript(home, "list", folder, env) as AwsDiskListing & { ok: boolean };
  assert.equal(listing.ok, true, JSON.stringify(listing));
  return Object.fromEntries(listing.entries.map((entry) => [entry.name, entry.lock]));
}

function works(home: string, folder: string, env: Record<string, string> = {}): Record<string, string[]> {
  const listing = runScript(home, "list", folder, env) as AwsDiskListing & { ok: boolean };
  assert.equal(listing.ok, true, JSON.stringify(listing));
  return Object.fromEntries(listing.entries.map((entry) => [entry.name, entry.work ?? []]));
}

/** A process table with one process working in a folder, as /proc shows it. */
function procWith(t: TestContext, cwd: string): Record<string, string> {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "aws-disk-proc-"));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  fs.mkdirSync(path.join(proc, "4242"));
  fs.symlinkSync(cwd, path.join(proc, "4242", "cwd"));
  return { ACCORDAGENTS_DISK_PROC: proc };
}

test("the report measures every category and what each clean-up frees", needsTools, (t) => {
  const home = fixtureHome(t);
  const report = runScript(home, "report") as AwsDiskReport & { ok: boolean };
  assert.equal(report.ok, true);
  const byId = Object.fromEntries(report.categories.map((category) => [category.id, category]));
  assert.equal(byId["program-versions"].count, 3);
  assert.equal(byId["program-versions"].inUse, 1);
  assert.ok(byId["program-versions"].cleanableBytes! > 0 && byId["program-versions"].cleanableBytes! < byId["program-versions"].bytes);
  assert.equal(byId["program-logs"].files, 2);
  assert.ok(byId["program-logs"].cleanableBytes! >= 256 * 1024 && byId["program-logs"].cleanableBytes! < byId["program-logs"].bytes);
  // A folder that only looks like the program's is the User's, not a program.
  assert.equal(byId["other-programs"].count, 1);
  assert.deepEqual(byId["project-copies"].projects, ["ahead", "clean", "dirty", "shared", "stashed"]);
  // The browser for QA and a sign-in kept in the cache are not offered.
  assert.ok(byId.caches.cleanableBytes! < byId.caches.bytes);
});

test("listing marks what cannot be removed and why, and what each folder is", needsTools, (t) => {
  const home = fixtureHome(t);
  const top = runScript(home, "list", "") as AwsDiskListing;
  const lock = Object.fromEntries(top.entries.map((entry) => [entry.name, entry.lock]));
  const role = Object.fromEntries(top.entries.map((entry) => [entry.name, entry.role]));
  assert.equal(lock[".ssh"], "system");
  assert.equal(lock[OWN], "program");
  assert.equal(role[OWN], "program");
  // Not referenced by any running program or service: an old install.
  assert.equal(lock[OTHER], null);
  assert.equal(role[OTHER], "idle-program");
  assert.equal(lock["accordagents-review"], "system");
  assert.equal(role["accordagents-review"], undefined);
  assert.equal(role[".accordagents"], "program-data");
  assert.equal(role["~"], "mailbox-runners");
  const own = locks(home, path.join(home, OWN));
  assert.equal(own.home, "sign-ins");
  assert.equal(own["agent-setup"], "agent-tools");
  const releases = locks(home, path.join(home, OWN, "releases"));
  assert.equal(releases["1.2.0-ccc"], "running-version");
  assert.equal(releases["1.0.0-aaa"], null);
  const cache = locks(home, path.join(home, ".cache"));
  assert.equal(cache.electron, null);
  assert.equal(cache["ms-playwright"], "qa-browser");
  assert.equal(cache.huggingface, "sign-ins");
  assert.equal(locks(home, path.join(home, ".cache", "ms-playwright")).chrome, "qa-browser");
  const hub = locks(home, path.join(home, ".cache", "huggingface"));
  assert.equal(hub.token, "sign-ins");
  assert.equal(hub.hub, null);
  assert.equal(runScript(home, "list", "/etc").ok, false);
});

test("a project copy goes only as a whole, and is marked with the work a member would lose", needsTools, (t) => {
  const home = fixtureHome(t);
  const mirrors = path.join(home, OWN, "workspace", "mirrors");
  const copies = locks(home, mirrors);
  for (const name of ["clean", "shared", "dirty", "ahead", "stashed"]) assert.equal(copies[name], null, `${name} is not locked`);
  const work = works(home, mirrors);
  assert.deepEqual(work.clean, []);
  assert.deepEqual(work.shared, ["worktree"]);
  assert.deepEqual(work.dirty, ["changes"]);
  assert.deepEqual(work.ahead, ["unpushed"]);
  assert.deepEqual(work.stashed, ["changes"]);
  // Only a whole copy is offered with its work: its parts stay locked.
  const parts = locks(home, path.join(mirrors, "shared"));
  assert.equal(parts["wt-member"], "worktree");
  assert.equal(parts.repo, "worktree");
  assert.deepEqual(works(home, path.join(mirrors, "shared"))["wt-member"], []);
  // Inside a project nothing is offered on its own: not a folder, a file,
  // its .git folder, or a member's worktree's .git file.
  const inside = locks(home, path.join(mirrors, "clean", "repo"));
  assert.equal(inside[".git"], "repository");
  assert.equal(inside["README.md"], "repository");
  assert.equal(locks(home, path.join(mirrors, "shared", "wt-member"))[".git"], "repository");
  const result = runScript(home, "delete", [
    path.join(mirrors, "dirty", "repo", "README.md"),
    path.join(mirrors, "clean", "repo", ".git"),
    path.join(mirrors, "shared", "wt-member", ".git"),
    path.join(mirrors, "ahead"),
    path.join(mirrors, "stashed")
  ]) as AwsDiskChangeResult;
  assert.equal(result.removed, 0);
  assert.deepEqual(result.failed.map((failure) => failure.reason), ["repository", "repository", "repository", "unpushed", "changes"]);
  for (const kept of ["dirty/repo/README.md", "clean/repo/.git/HEAD", "shared/wt-member/.git", "ahead/repo/new.md"]) {
    assert.ok(fs.existsSync(path.join(mirrors, kept)), `${kept} must stay`);
  }
  execFileSync("git", ["-C", path.join(mirrors, "shared", "wt-member"), "status"], { stdio: "ignore" });
});

test("deleting re-checks every path on the instance and never removes a member's work", needsTools, (t) => {
  const home = fixtureHome(t);
  const mirrors = path.join(home, OWN, "workspace", "mirrors");
  const targets = [
    path.join(mirrors, "clean"),
    path.join(mirrors, "shared"),
    path.join(mirrors, "dirty"),
    path.join(mirrors, "shared", "wt-member"),
    path.join(home, OWN, "releases", "1.2.0-ccc"),
    path.join(home, OWN, "releases", "1.0.0-aaa"),
    path.join(home, ".ssh"),
    path.join(home, OWN, "releases", "..", "..", ".ssh", "authorized_keys"),
    "/etc/passwd"
  ];
  const result = runScript(home, "delete", targets) as AwsDiskChangeResult & { ok: boolean };
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);
  // The desktop forgets the removed project copies by these paths.
  assert.deepEqual([...(result.removedPaths ?? [])].sort(), [path.join(mirrors, "clean"), path.join(home, OWN, "releases", "1.0.0-aaa")].sort());
  assert.equal(fs.existsSync(path.join(mirrors, "clean")), false);
  assert.equal(fs.existsSync(path.join(home, OWN, "releases", "1.0.0-aaa")), false);
  for (const kept of [path.join(mirrors, "shared", "wt-member", "README.md"), path.join(mirrors, "dirty", "repo", "README.md"),
    path.join(home, OWN, "releases", "1.2.0-ccc", "runtime.cjs"), path.join(home, ".ssh", "authorized_keys")]) {
    assert.ok(fs.existsSync(kept), `${kept} must stay`);
  }
  const reasons = Object.fromEntries(result.failed.map((failure) => [path.relative(home, failure.path), failure.reason]));
  assert.equal(reasons[path.join(OWN, "workspace", "mirrors", "shared")], "worktree");
  assert.equal(reasons[path.join(OWN, "workspace", "mirrors", "dirty")], "changes");
  assert.equal(reasons[path.join(OWN, "releases", "1.2.0-ccc")], "running-version");
  assert.ok(result.space.availableBytes > 0);
});

test("a project copy with a member's work goes only when the User chose it with that work", needsTools, (t) => {
  const home = fixtureHome(t);
  const mirrors = path.join(home, OWN, "workspace", "mirrors");
  const chosen = ["shared", "dirty", "ahead", "stashed"].map((name) => path.join(mirrors, name));
  // A path the User chose without seeing work in it stays when work appeared
  // meanwhile; a chosen path elsewhere in the same request still goes.
  const partial = runScript(home, "delete", chosen, {}, { [chosen[0]]: ["worktree"], [chosen[2]]: ["unpushed"] }) as AwsDiskChangeResult;
  assert.equal(partial.removed, 2);
  assert.equal(fs.existsSync(chosen[0]), false);
  assert.equal(fs.existsSync(chosen[2]), false);
  assert.deepEqual(partial.failed.map((failure) => [path.basename(failure.path), failure.reason]), [["dirty", "changes"], ["stashed", "changes"]]);
  const rest = runScript(home, "delete", [chosen[1], chosen[3]], {}, { [chosen[1]]: ["changes"], [chosen[3]]: ["changes"] }) as AwsDiskChangeResult;
  assert.equal(rest.removed, 2);
  assert.deepEqual(rest.failed, []);
  assert.deepEqual(fs.readdirSync(mirrors), ["clean"]);
});

test("choosing a member's work never overrides a lock: in use, inside a project, the program's, not a whole copy", needsTools, (t) => {
  const home = fixtureHome(t);
  const mirrors = path.join(home, OWN, "workspace", "mirrors");
  const worktree = path.join(mirrors, "shared", "wt-member");
  const busy = procWith(t, worktree);
  assert.equal(locks(home, mirrors, busy).shared, "in-use");
  const targets = [path.join(mirrors, "shared"), path.join(mirrors, "dirty", "repo", "README.md"), path.join(home, OWN, "home"), worktree];
  const all = Object.fromEntries(targets.map((target) => [target, ["worktree", "changes", "unpushed"]]));
  const result = runScript(home, "delete", targets, busy, all) as AwsDiskChangeResult;
  assert.equal(result.removed, 0);
  assert.deepEqual(result.failed.map((failure) => failure.reason), ["in-use", "repository", "sign-ins", "in-use"]);
  // A member's worktree is never deleted on its own, only with its whole copy.
  const alone = runScript(home, "delete", [worktree], {}, { [worktree]: ["worktree", "changes", "unpushed"] }) as AwsDiskChangeResult;
  assert.deepEqual(alone.failed.map((failure) => failure.reason), ["worktree"]);
  assert.ok(fs.existsSync(path.join(worktree, "README.md")));
  // An idle other computer's program holding a project with changes stays locked, chosen or not.
  repo(path.join(home, OTHER, "workspace", "mirrors", "p", "repo"));
  fs.writeFileSync(path.join(home, OTHER, "workspace", "mirrors", "p", "repo", "README.md"), "changed");
  assert.equal(locks(home, "")[OTHER], "changes");
  const other = path.join(home, OTHER);
  assert.deepEqual((runScript(home, "delete", [other], {}, { [other]: ["changes"] }) as AwsDiskChangeResult).failed.map((failure) => failure.reason), ["changes"]);
  // Clean-ups never carry a choice: a cache holding a project with changes stays.
  repo(path.join(home, ".cache", "tool", "checkout"));
  fs.writeFileSync(path.join(home, ".cache", "tool", "checkout", "README.md"), "changed");
  const tool = path.join(home, ".cache", "tool");
  const caches = runScript(home, "clean", "caches", {}, { [tool]: ["changes"] }) as AwsDiskChangeResult;
  assert.deepEqual(caches.failed.map((failure) => [path.basename(failure.path), failure.reason]), [["tool", "changes"]]);
  assert.ok(fs.existsSync(path.join(home, ".cache", "tool", "checkout", "README.md")));
});

test("a copy whose project has a worktree outside it stays, so nobody's worktree breaks unseen", needsTools, (t) => {
  const home = fixtureHome(t);
  const mirrors = path.join(home, OWN, "workspace", "mirrors");
  const main = path.join(mirrors, "proj");
  const feature = path.join(mirrors, "proj-feature");
  pushedRepo(path.join(main, "repo"), path.join(home, ".remotes", "proj.git"));
  git(path.join(main, "repo"), "worktree", "add", "-q", "-b", "feature", path.join(feature, "wt"));
  fs.writeFileSync(path.join(feature, "wt", "work.md"), "in progress");
  assert.equal(locks(home, mirrors).proj, "worktree-elsewhere");
  assert.deepEqual(works(home, mirrors)["proj-feature"], ["worktree", "changes"]);
  const result = runScript(home, "delete", [main], {}, { [main]: ["worktree", "changes", "unpushed"] }) as AwsDiskChangeResult;
  assert.deepEqual(result.failed.map((failure) => failure.reason), ["worktree-elsewhere"]);
  execFileSync("git", ["-C", path.join(feature, "wt"), "status"], { stdio: "ignore" });
  // While a member works in that worktree, it stays too.
  assert.equal(locks(home, mirrors, procWith(t, path.join(feature, "wt"))).proj, "worktree-elsewhere");
  assert.equal(locks(home, mirrors, procWith(t, path.join(feature, "wt")))["proj-feature"], "in-use");
  // The copy holding the worktree goes when chosen with what it holds;
  // then the project no longer has a worktree anywhere and goes on its own.
  const wt = runScript(home, "delete", [feature], {}, { [feature]: ["worktree", "changes"] }) as AwsDiskChangeResult;
  assert.equal(wt.removed, 1);
  assert.equal(locks(home, mirrors).proj, null);
  assert.deepEqual(works(home, mirrors).proj, [], "a worktree whose folder is gone holds nothing");
  assert.equal((runScript(home, "delete", [main]) as AwsDiskChangeResult).removed, 1);
});

test("a copy goes only with every kind of work the User saw on it, and stays when git cannot read it", needsTools, (t) => {
  const home = fixtureHome(t);
  const mirrors = path.join(home, OWN, "workspace", "mirrors");
  const shared = path.join(mirrors, "shared");
  fs.writeFileSync(path.join(shared, "repo", "README.md"), "changed too");
  assert.deepEqual(works(home, mirrors).shared, ["worktree", "changes"], "every kind, not only the first");
  const ahead = path.join(mirrors, "ahead");
  // Work of a new kind appeared after the User looked: the copy stays.
  fs.writeFileSync(path.join(ahead, "repo", "README.md"), "changed after the listing");
  const result = runScript(home, "delete", [shared, ahead], {}, { [shared]: ["worktree", "changes"], [ahead]: ["unpushed"] }) as AwsDiskChangeResult;
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(shared), false);
  assert.deepEqual(result.failed.map((failure) => [path.basename(failure.path), failure.reason]), [["ahead", "changes"]]);
  // A project git cannot read is never offered.
  fs.writeFileSync(path.join(mirrors, "dirty", "repo", ".git", "HEAD"), "garbage");
  assert.equal(locks(home, mirrors).dirty, "unreadable");
  const dirty = path.join(mirrors, "dirty");
  assert.deepEqual((runScript(home, "delete", [dirty], {}, { [dirty]: ["changes"] }) as AwsDiskChangeResult).failed.map((failure) => failure.reason), ["unreadable"]);
});

test("commits on no branch and bare projects are shown; a worktree is not charged with its main project's stash", needsTools, (t) => {
  const home = fixtureHome(t);
  const mirrors = path.join(home, OWN, "workspace", "mirrors");
  // A detached HEAD with a commit no branch or remote has.
  const det = path.join(mirrors, "det");
  pushedRepo(path.join(det, "repo"), path.join(home, ".remotes", "det.git"));
  git(path.join(det, "repo"), "checkout", "-q", "--detach");
  fs.writeFileSync(path.join(det, "repo", "loose.md"), "y");
  git(path.join(det, "repo"), "add", ".");
  git(path.join(det, "repo"), "commit", "-qm", "on no branch");
  // A bare project is read, not refused.
  execFileSync("git", ["clone", "-q", "--bare", path.join(home, ".remotes", "det.git"), path.join(mirrors, "bare", "mirror.git")], { stdio: "ignore" });
  // A worktree in its own copy, whose main project then gets a stash.
  const main = path.join(mirrors, "main");
  pushedRepo(path.join(main, "repo"), path.join(home, ".remotes", "main.git"));
  git(path.join(main, "repo"), "worktree", "add", "-q", "-b", "topic", path.join(mirrors, "topic", "wt"));
  fs.writeFileSync(path.join(main, "repo", "README.md"), "set aside");
  git(path.join(main, "repo"), "stash", "-q");
  const listed = locks(home, mirrors);
  assert.equal(listed.det, null);
  assert.equal(listed.bare, null);
  assert.equal(listed.main, "worktree-elsewhere");
  const work = works(home, mirrors);
  assert.deepEqual(work.det, ["unpushed"]);
  assert.deepEqual(work.bare, ["unpushed"], "a bare clone has no remote branches to compare with");
  assert.deepEqual(work.topic, ["worktree"], "the stash and branches stay with the main project");
  assert.deepEqual((runScript(home, "delete", [det]) as AwsDiskChangeResult).failed.map((failure) => failure.reason), ["unpushed"]);
  const topic = path.join(mirrors, "topic");
  const result = runScript(home, "delete", [topic, path.join(mirrors, "bare")], {}, { [topic]: ["worktree"], [path.join(mirrors, "bare")]: ["unpushed"] }) as AwsDiskChangeResult;
  assert.equal(result.removed, 2);
  assert.equal(execFileSync("git", ["-C", path.join(main, "repo"), "stash", "list"], { encoding: "utf8" }).trim().length > 0, true);
});

test("a linked worktree is told from a submodule by where its .git file points", needsTools, (t) => {
  const home = fixtureHome(t);
  const mirrors = path.join(home, OWN, "workspace", "mirrors");
  // A project copy named "modules": its worktree's .git file mentions /modules/.
  pushedRepo(path.join(mirrors, "modules", "repo"), path.join(home, ".remotes", "modules.git"));
  git(path.join(mirrors, "modules", "repo"), "worktree", "add", "-q", "-b", "side", path.join(mirrors, "side", "wt"));
  fs.writeFileSync(path.join(mirrors, "side", "wt", "README.md"), "edited");
  assert.deepEqual(works(home, mirrors).side, ["worktree", "changes"]);
  assert.deepEqual((runScript(home, "delete", [path.join(mirrors, "side")]) as AwsDiskChangeResult).failed.map((failure) => failure.reason), ["worktree"]);
});

test("a link is judged and removed where it is, never where it points", needsTools, (t) => {
  const home = fixtureHome(t);
  // A link in a protected place to a cache stays, and so does the cache.
  fs.symlinkSync(path.join(home, ".cache", "electron"), path.join(home, ".ssh", "to-cache"));
  // A link in a cache to a protected place goes alone; its target stays.
  fs.symlinkSync(path.join(home, ".ssh"), path.join(home, ".cache", "to-ssh"));
  assert.equal(locks(home, path.join(home, ".ssh"))["to-cache"], "system");
  const result = runScript(home, "delete", [path.join(home, ".ssh", "to-cache"), path.join(home, ".cache", "to-ssh")]) as AwsDiskChangeResult;
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(path.join(home, ".cache", "to-ssh")), false);
  assert.ok(fs.existsSync(path.join(home, ".ssh", "authorized_keys")));
  assert.ok(fs.lstatSync(path.join(home, ".ssh", "to-cache")).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(home, ".cache", "electron", "zip")));
});

test("cloud run files: a device's runs may go, the device folder and its agent tools may not", needsTools, (t) => {
  const home = fixtureHome(t);
  const devices = locks(home, path.join(home, ".accordagents", "remote-runs", "devices"));
  assert.equal(devices.d1, "system");
  const device = locks(home, path.join(home, ".accordagents", "remote-runs", "devices", "d1"));
  assert.equal(device["run-1"], null);
  assert.equal(device["agent-setup"], "agent-tools");
  assert.equal(locks(home, path.join(home, "~")).runner, null);
  const result = runScript(home, "delete", [path.join(home, ".accordagents", "remote-runs", "devices", "d1", "run-1"), path.join(home, "~", "runner")]) as AwsDiskChangeResult;
  assert.equal(result.removed, 2);
});

test("what a running process uses, or works around, stays", needsTools, (t) => {
  const home = fixtureHome(t);
  const old = path.join(home, OWN, "releases", "1.0.0-aaa");
  assert.equal(locks(home, path.join(home, OWN, "releases"), procWith(t, old))["1.0.0-aaa"], "in-use");
  // Another computer's program that runs is that computer's.
  assert.equal(locks(home, "", procWith(t, path.join(home, OTHER, "releases", "9.9.9")))[OTHER], "other-program");
  // A process working in a run folder keeps everything in it.
  const run = path.join(home, ".accordagents", "remote-runs", "devices", "d1", "run-1");
  assert.equal(locks(home, run, procWith(t, run))["out.log"], "in-use");
  const busy = procWith(t, old);
  const versions = runScript(home, "clean", "program-versions", busy) as AwsDiskChangeResult;
  assert.equal(versions.failed.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(home, OWN, "releases")).sort(), ["1.0.0-aaa", "1.2.0-ccc"]);
});

test("a version staged in the last hour may be an update being installed", needsTools, (t) => {
  const home = fixtureHome(t);
  write(path.join(home, OWN, "releases", "1.3.0-ddd", "runtime.cjs"));
  assert.equal(locks(home, path.join(home, OWN, "releases"))["1.3.0-ddd"], "in-use");
  runScript(home, "clean", "program-versions");
  assert.deepEqual(fs.readdirSync(path.join(home, OWN, "releases")).sort(), ["1.2.0-ccc", "1.3.0-ddd"]);
});

test("clean-ups remove only what they promise", needsTools, (t) => {
  const home = fixtureHome(t);
  const logs = path.join(home, ".accordagents", OWN, "debug-logs");
  const versions = runScript(home, "clean", "program-versions") as AwsDiskChangeResult & { ok: boolean };
  assert.equal(versions.ok, true);
  assert.deepEqual(fs.readdirSync(path.join(home, OWN, "releases")), ["1.2.0-ccc"]);
  runScript(home, "clean", "program-logs");
  assert.deepEqual(fs.readdirSync(logs), ["2026-10-08.jsonl"]);
  const caches = runScript(home, "clean", "caches") as AwsDiskChangeResult;
  assert.deepEqual(caches.failed, []);
  assert.deepEqual(fs.readdirSync(path.join(home, ".cache")).sort(), ["huggingface", "ms-playwright"]);
  assert.deepEqual(fs.readdirSync(path.join(home, ".cache", "huggingface")), ["token"]);
  assert.deepEqual(fs.readdirSync(path.join(home, OWN, "home", ".npm")), []);
  assert.ok(fs.existsSync(path.join(home, OWN, "home", ".codex", "auth.json")));
  assert.equal(runScript(home, "clean", "everything").ok, false);
});

test("names with spaces, quotes and other alphabets list and delete as they are", needsTools, (t) => {
  const home = fixtureHome(t);
  const names = ["it's a dir", "проект ü", "a\"b"];
  for (const name of names) write(path.join(home, ".cache", name, "f"));
  const listed = (runScript(home, "list", path.join(home, ".cache")) as AwsDiskListing).entries.map((entry) => entry.name);
  for (const name of names) assert.ok(listed.includes(name), name);
  const result = runScript(home, "delete", names.map((name) => path.join(home, ".cache", name))) as AwsDiskChangeResult;
  assert.equal(result.removed, 3);
  for (const name of names) assert.equal(fs.existsSync(path.join(home, ".cache", name)), false);
});

test("a listing right after the report uses its sizes, and a delete updates them", needsTools, (t) => {
  const home = fixtureHome(t);
  runScript(home, "report");
  const size = (): number => (runScript(home, "list", path.join(home, OWN)) as AwsDiskListing).entries.find((entry) => entry.name === "releases")!.bytes;
  const before = size();
  const result = runScript(home, "delete", [path.join(home, OWN, "releases", "1.0.0-aaa")]) as AwsDiskChangeResult;
  assert.ok(result.freedBytes >= 64 * 1024);
  assert.equal(size(), before - result.freedBytes);
});

const worker: CloudRunWorkerSettings = { host: "203.0.113.5", user: "ubuntu", identityFile: "/k.pem", hostKeyAlias: "accordagents-i-1" } as CloudRunWorkerSettings;
const PROGRAM = { root: `~/${OWN}`, data: `~/.accordagents/${OWN}` };
const REPORT = (measuredAt = Date.now()): string => JSON.stringify({ ok: true, totalBytes: 10, usedBytes: 5, availableBytes: 5, categories: [], measuredAt });
const CHANGED = JSON.stringify({ ok: true, freedBytes: 1, failed: [], space: { totalBytes: 1, usedBytes: 1, availableBytes: 0 } });
const commandError = (result: Partial<CommandError["result"]>): CommandError =>
  new CommandError("ssh failed", { command: "ssh", args: [], stdout: "", stderr: "", exitCode: 255, timedOut: false, ...result });

function service(exec: AwsInstanceDiskExec, target: () => CloudRunWorkerSettings = () => worker): AwsInstanceDiskService {
  return new AwsInstanceDiskService({ worker: async () => target(), program: async () => PROGRAM, exec });
}
function modeOf(script: string): string {
  return JSON.parse(JSON.parse(script.split("\n")[1].replace(/^PAYLOAD = json\.loads\(/, "").replace(/\)$/, ""))).mode;
}

test("the service reuses a recent measurement and shares one in flight", async () => {
  let calls = 0;
  const disk = service(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return REPORT();
  });
  const [first, second] = await Promise.all([disk.report(), disk.report()]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  await disk.report();
  assert.equal(calls, 1);
  await disk.report({ refresh: true });
  assert.equal(calls, 2);
});

test("a measurement asked for before a change is neither shared after it nor kept", async () => {
  const order: string[] = [];
  let release!: () => void;
  const disk = service(async (_worker, _command, script) => {
    const mode = modeOf(script);
    order.push(mode);
    if (mode === "report" && order.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    return mode === "report" ? REPORT() : CHANGED;
  });
  const before = disk.report();
  await new Promise((resolve) => setImmediate(resolve));
  const cleaned = disk.clean("caches");
  const after = disk.report({ refresh: true });
  assert.notEqual(after, before);
  release();
  await Promise.all([before, cleaned, after]);
  assert.deepEqual(order, ["report", "clean", "report"]);
  // The fresh one is kept; nothing measures again.
  await disk.report();
  assert.equal(order.length, 3);
});

test("another instance is measured again, and a failed measurement does not stick", async () => {
  let host = "accordagents-i-1";
  let fail = true;
  let calls = 0;
  const disk = service(async () => {
    calls += 1;
    if (fail) { fail = false; throw commandError({ stderr: "Permission denied (publickey)." }); }
    return REPORT();
  }, () => ({ ...worker, hostKeyAlias: host }));
  await assert.rejects(disk.report(), /could not run the disk check: Permission denied/);
  await disk.report();
  host = "accordagents-i-2";
  await disk.report();
  assert.equal(calls, 3);
});

test("only a connection that failed to open is tried again; a pass that ran out of time is not", async () => {
  let calls = 0;
  const flaky = service(async () => {
    calls += 1;
    if (calls === 1) throw commandError({ stderr: "kex_exchange_identification: Connection closed by remote host" });
    return REPORT();
  });
  await flaky.report();
  assert.equal(calls, 2);
  for (const timeout of [{ timedOut: true }, { exitCode: 124 }]) {
    let tries = 0;
    const slow = service(async () => { tries += 1; throw commandError({ ...timeout, stderr: "Connection timed out" }); });
    await assert.rejects(slow.report(), /took too long/);
    assert.equal(tries, 1);
  }
  let changes = 0;
  const change = service(async () => { changes += 1; throw commandError({ stderr: "kex_exchange_identification: Connection reset" }); });
  await assert.rejects(change.clean("caches"));
  await assert.rejects(change.remove(["/home/ubuntu/.cache/x"]));
  assert.equal(changes, 2);
  const garbled = service(async () => "Traceback (most recent call last):");
  await assert.rejects(garbled.list(), /did not answer with its disk details/);
});

test("the request travels in the script, never on the command line, and the instance stops itself in time", async () => {
  const paths = Array.from({ length: 500 }, (_, index) => `/home/ubuntu/.cache/${"deep/".repeat(50)}item-${index}`);
  let seen: { command: string; script: string; timeoutMs: number } | undefined;
  const disk = service(async (_worker, command, script, timeoutMs) => { seen = { command, script, timeoutMs }; return CHANGED; });
  await disk.remove(paths, { [paths[7]]: ["worktree"] });
  assert.ok(seen);
  assert.ok(seen.command.length < 200);
  assert.match(seen.script, /\\"withWork\\":\{\\"[^}]*item-7\\":\[\\"worktree\\"\]\}/, "the chosen work travels with the paths");
  assert.doesNotMatch(seen.command, /\.cache/);
  assert.match(seen.command, /timeout -k 10 285 python3 -/);
  assert.ok(seen.script.includes("item-499"));
  assert.ok(JSON.stringify(paths).length > 128 * 1024, "larger than one command-line argument may be");
  assert.throws(() => disk.remove([...paths, "/home/ubuntu/one-more"]), /Choose the files/);
});

test("the service refuses malformed requests before reaching the instance", async () => {
  let calls = 0;
  const disk = service(async () => { calls += 1; return CHANGED; });
  assert.throws(() => disk.remove([]), /Choose the files/);
  assert.throws(() => disk.remove(["relative/path"]), /Choose the files/);
  assert.throws(() => disk.remove(["/home/ubuntu/a"], { "/home/ubuntu/b": ["worktree"] }), /Choose the files/, "work is chosen only with its path");
  assert.throws(() => disk.remove(["/home/ubuntu/a"], { "/home/ubuntu/a": ["everything" as never] }), /Choose the files/, "only known kinds of work");
  assert.throws(() => disk.remove(["/home/ubuntu/a"], { "/home/ubuntu/a": [] }), /Choose the files/, "a choice names the work it accepts");
  assert.throws(() => disk.clean("everything" as never), /Nothing to clean/);
  await disk.clean("caches");
  await disk.remove(["/home/ubuntu/.cache/electron"]);
  assert.equal(calls, 2);
});

test("an instance that refuses says so in words", async () => {
  const disk = service(async () => JSON.stringify({ ok: false, error: "not a folder in the home folder" }));
  await assert.rejects(disk.list("/etc"), /The instance refused: not a folder in the home folder\./);
});

test("a delete reports what it removed to the desktop before it is done, outside the instance queue, and a failure there is only logged", async () => {
  const told: string[][] = [];
  const logged: string[] = [];
  let fail = false;
  let release!: () => void;
  let hold = false;
  const disk = new AwsInstanceDiskService({
    worker: async () => worker,
    program: async () => PROGRAM,
    exec: async (_worker, _command, script) => modeOf(script) === "list"
      ? JSON.stringify({ ok: true, path: "/home/ubuntu", home: "/home/ubuntu", own: "/home/ubuntu/own", entries: [], truncated: 0 })
      : JSON.stringify({ ok: true, freedBytes: 9, removed: 1, removedPaths: ["/home/ubuntu/own/workspace/mirrors/app-0a62", 7, "relative"],
        failed: [], space: { totalBytes: 1, usedBytes: 1, availableBytes: 0 } }),
    log: (event) => { logged.push(event); },
    removed: async (paths) => {
      told.push(paths);
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      if (fail) throw new Error("settings unavailable");
    }
  });
  hold = true;
  let done = false;
  const removing = disk.remove(["/home/ubuntu/own/workspace/mirrors/app-0a62"]).then((result) => { done = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(told, [["/home/ubuntu/own/workspace/mirrors/app-0a62"]]);
  assert.equal(done, false, "not reported done before the desktop has forgotten the copy");
  await disk.list("@mirrors");
  release();
  assert.equal((await removing).removed, 1);
  hold = false;
  fail = true;
  await disk.remove(["/home/ubuntu/own/workspace/mirrors/app-0a62"]);
  assert.ok(logged.includes("aws.disk.forget-failed"));
});

test("listing a named folder that was never made answers with no entries and the free space", needsTools, (t) => {
  const home = fixtureHome(t);
  fs.rmSync(path.join(home, OWN, "workspace"), { recursive: true, force: true });
  const listing = runScript(home, "list", "@mirrors") as AwsDiskListing & { ok: boolean };
  assert.equal(listing.ok, true);
  assert.deepEqual(listing.entries, []);
  assert.ok((listing.space?.availableBytes ?? 0) > 0);
});
