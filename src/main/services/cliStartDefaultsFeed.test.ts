// A machine says what its CLIs start a new session in with its own config
// (src/shared/cliStartDefaults.ts) in its hello: at once what it last read,
// and once more when a read changes it.
import assert from "node:assert/strict";
import test from "node:test";

import type { CliStartDefaultsByKind } from "../../shared/cliStartDefaults";
import { CliStartDefaultsFeed } from "./cliStartDefaultsFeed";

test("a hello says the start defaults last read and greets again only when a read changes them", async () => {
  let clock = 0;
  const reads: Array<CliStartDefaultsByKind | undefined> = [
    { "codex-cli": { access: "auto-review", model: "gpt-5.6-luna", modelLabel: "GPT-5.6-Luna", reasoningEffort: "low" } },
    { "codex-cli": { access: "auto-review", model: "gpt-5.6-luna", modelLabel: "GPT-5.6-Luna", reasoningEffort: "low" } },
    { "codex-cli": { access: "read-only" } }
  ];
  let readCount = 0;
  const feed = new CliStartDefaultsFeed(async () => reads[readCount++], 1_000, () => clock);
  let changed = 0;
  // The first hello goes at once, before the CLIs have said.
  assert.equal(feed.take(() => { changed += 1; }), undefined);
  await feed.settled();
  assert.equal(changed, 1, "the read changed what was said: greet again");
  assert.deepEqual(feed.take(() => { changed += 1; }), reads[0]);
  await feed.settled();
  assert.equal(readCount, 1, "still fresh: not read again");
  clock = 2_000;
  assert.deepEqual(feed.take(() => { changed += 1; }), reads[0]);
  await feed.settled();
  assert.equal([readCount, changed].join(), "2,1", "read again, the same: no extra hello");
  clock = 4_000;
  feed.take(() => { changed += 1; });
  await feed.settled();
  assert.equal(changed, 2, "her config changed: greet again");
  assert.deepEqual(feed.take(() => undefined), reads[2]);
});

test("a read that fails keeps what was said and is tried again once stale", async () => {
  let clock = 0;
  let fail = true;
  const feed = new CliStartDefaultsFeed(async () => {
    if (fail) throw new Error("codex not signed in");
    return { "claude-code": { access: "manual" } };
  }, 1_000, () => clock);
  const errors: string[] = [];
  feed.take(() => assert.fail("nothing changed"), (error) => errors.push(String(error)));
  await feed.settled();
  assert.equal(errors.length, 1);
  fail = false;
  feed.take(() => assert.fail("not read again while fresh"));
  await feed.settled();
  clock = 2_000;
  let changed = false;
  feed.take(() => { changed = true; });
  await feed.settled();
  assert.equal(changed, true);
});
