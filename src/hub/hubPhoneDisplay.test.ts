// A phone app of 1.11.12-beta.3 hid members' steps while its server said so
// (Settings → General → Show members’ actions). The switch is gone (the User,
// 2026-11-27): the server tells every such app to show them, at once.
import assert from "node:assert/strict";
import test from "node:test";
import { hub, pairPhone } from "./test/hubPhoneFixtures";

test("every changes answer tells an older phone app to show members' steps, and one that still hides them is answered at once", async (t) => {
  const h = await hub(t);
  const { client } = await pairPhone(h);
  type Changes = { instance: string; seq: number; conversationIds?: string[]; reset?: boolean; display?: { showMemberActions: boolean } };
  const first = await client.getJson<Changes>("/v1/phone/changes", { instance: "none", after: 0 });
  assert.equal(first.reset, true);
  assert.deepEqual(first.display, { showMemberActions: true }, "said even before any catalog");
  // A computer of 1.11.12-beta.3 with the switch off still publishes it: it
  // no longer counts.
  const catalog = { catalog: { version: 1, publishedAt: new Date().toISOString(), roles: {}, prompts: [], skills: [], avatars: {}, display: { showMemberActions: false } } };
  assert.equal((await h.call(h.owner, "PUT", "/v1/catalog", catalog)).status, 200);
  await h.settle();
  const hiddenAt = Date.now();
  const hiding = await client.getJson<Changes>("/v1/phone/changes", { instance: first.instance, after: first.seq, waitMs: 20_000, shown: "0" }, { timeoutMs: 30_000 });
  assert.ok(Date.now() - hiddenAt < 5_000, "an app still hiding them is not kept waiting");
  assert.deepEqual(hiding.display, { showMemberActions: true });
  assert.deepEqual(hiding.conversationIds, [], "no chat changed");
  const levelAt = Date.now();
  const level = await client.getJson<Changes>("/v1/phone/changes", { instance: first.instance, after: first.seq, waitMs: 1_500 }, { timeoutMs: 10_000 });
  assert.ok(Date.now() - levelAt >= 1_000, "a phone that shows them (or never had the switch) waits for news as before");
  assert.deepEqual(level.display, { showMemberActions: true });
});
