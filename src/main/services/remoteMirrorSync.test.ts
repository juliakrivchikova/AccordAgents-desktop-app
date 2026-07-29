import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMirrorUpSyncRsyncArgs,
  parseLastRsyncProgressPercent,
  planWorkerMirrorReclaim,
  type WorkerMirrorContainerSnapshot
} from "./remoteMirrorSync";

test("openrsync per-file progress yields a monotonic aggregate, not a 0->100 loop", () => {
  // openrsync (macOS default) has no --info=progress2; each transferred file
  // prints its own `100%` byte line plus `to-check=<done>/<total>`.
  const lines = [
    "./\n",
    "f1.bin\n         204800 100%   42.83MB/s   00:00:00 (xfer#1, to-check=1/8)\n",
    "f2.bin\n         204800 100%   43.36MB/s   00:00:00 (xfer#2, to-check=2/8)\n",
    "f3.bin\n         204800 100%   43.67MB/s   00:00:00 (xfer#3, to-check=3/8)\n",
    "f4.bin\n         204800 100%   43.64MB/s   00:00:00 (xfer#4, to-check=4/8)\n",
    "f5.bin\n         204800 100%   43.83MB/s   00:00:00 (xfer#5, to-check=5/8)\n",
    "sub/g.bin\n      204800 100%   42.70MB/s   00:00:00 (xfer#6, to-check=7/8)\n"
  ];
  let buffer = "";
  let last = -1;
  const seen: number[] = [];
  for (const line of lines) {
    buffer += line;
    const percent = parseLastRsyncProgressPercent(buffer);
    if (percent !== undefined) {
      assert.ok(percent >= last, `percent must never decrease (was ${last}, got ${percent})`);
      last = percent;
      seen.push(percent);
    }
  }
  // Aggregate climbs toward 100 and never resets to 0 mid-transfer.
  assert.deepEqual(seen, [12, 25, 37, 50, 62, 87]);
});

test("GNU rsync to-chk (remaining) is converted to done-based aggregate", () => {
  // GNU rsync (incl. --info=progress2) counts files REMAINING down to zero.
  assert.equal(parseLastRsyncProgressPercent("1,048,576  50%  1.2MB/s (xfr#1, to-chk=6/8)"), 25);
  assert.equal(parseLastRsyncProgressPercent("2,097,152 100%  1.2MB/s (xfr#8, to-chk=0/8)"), 100);
});

test("falls back to the byte percent only when no file-count token is present", () => {
  assert.equal(parseLastRsyncProgressPercent("      204800  73%   10MB/s   0:00:01"), 73);
  assert.equal(parseLastRsyncProgressPercent("no progress here"), undefined);
});

test("ignores a malformed total instead of emitting NaN", () => {
  assert.equal(parseLastRsyncProgressPercent("f.bin (xfer#1, to-check=1/0)"), undefined);
});

test("up-sync rsync argv pairs --delete with the git-state protect filters (P0-2)", () => {
  // A changed-fingerprint resync runs rsync with --delete. The protect filters
  // must be part of that same argv, before the source/destination, so remote-only
  // .git worktree/objects/refs state is never deleted by the delete pass.
  const args = buildMirrorUpSyncRsyncArgs({
    progressArgs: ["--info=progress2"],
    rshCommand: "ssh -i /keys/id",
    source: "/local/project/",
    destination: "worker:/srv/mirrors/app-1234/repo/"
  });
  assert.ok(args.includes("--delete"), "delete pass must be present for the guarantee to matter");
  for (const filter of [
    "--filter=P .git/worktrees/***",
    "--filter=P .git/objects/***",
    "--filter=P .git/refs/***",
    "--filter=P .git/packed-refs"
  ]) {
    const filterIndex = args.indexOf(filter);
    assert.ok(filterIndex >= 0, `missing protect filter: ${filter}`);
    // Protect rules only take effect if they precede the transfer paths.
    assert.ok(filterIndex < args.indexOf("/local/project/"), `${filter} must precede the source path`);
  }
  // The protect filters must sit after --delete so rsync sees them as protection.
  assert.ok(args.indexOf("--delete") < args.indexOf("--filter=P .git/worktrees/***"));
});

function container(overrides: Partial<WorkerMirrorContainerSnapshot> & { path: string }): WorkerMirrorContainerSnapshot {
  return {
    hasRepoSubdir: false,
    hasDirectGitDir: false,
    worktrees: [],
    ...overrides
  };
}

test("worker mirror reclaim drops old-layout mirrors and orphaned worktrees, keeps active + registered (P1-8)", () => {
  const root = "/srv/worker/mirrors";
  const activeSlug = `${root}/active-app`;
  const idleSlug = `${root}/idle-app`;
  const oldLayoutSlug = `${root}/legacy-app`;
  const unknownSlug = `${root}/mystery-app`;

  const plan = planWorkerMirrorReclaim(
    [
      // Active mirror: nothing under it may be reclaimed, even an orphan worktree.
      container({
        path: activeSlug,
        hasRepoSubdir: true,
        worktrees: [
          { path: `${activeSlug}/feature`, isWorktree: true, registered: true },
          { path: `${activeSlug}/half-removed`, isWorktree: true, registered: false }
        ]
      }),
      // Idle current-layout mirror: keep repo + registered worktree + scratch dir,
      // reclaim only the orphaned (unregistered) linked worktree.
      container({
        path: idleSlug,
        hasRepoSubdir: true,
        worktrees: [
          { path: `${idleSlug}/live`, isWorktree: true, registered: true },
          { path: `${idleSlug}/stale`, isWorktree: true, registered: false },
          { path: `${idleSlug}/scratch`, isWorktree: false, registered: false }
        ]
      }),
      // Pre-`/repo` old-layout container: whole thing is dead storage.
      container({ path: oldLayoutSlug, hasRepoSubdir: false, hasDirectGitDir: true }),
      // Unknown shape (no repo, no direct .git): left untouched.
      container({ path: unknownSlug })
    ],
    new Set<string>([`${activeSlug}/repo`])
  );

  assert.deepEqual(plan.reclaim, [`${idleSlug}/stale`, `${oldLayoutSlug}`].sort());
  // Active mirror repo, its worktrees (both), registered/scratch idle paths, and
  // the unknown container are all preserved.
  for (const kept of [
    `${activeSlug}/repo`,
    `${activeSlug}/feature`,
    `${activeSlug}/half-removed`,
    `${idleSlug}/repo`,
    `${idleSlug}/live`,
    `${idleSlug}/scratch`,
    unknownSlug
  ]) {
    assert.ok(plan.preserve.includes(kept), `expected to preserve ${kept}`);
  }
  assert.ok(!plan.reclaim.includes(`${activeSlug}/half-removed`), "active mirror worktree must never be reclaimed");
});
