// Settings → General → Show members’ actions (the User, 2026-11-27): the
// computer publishes it in the composer catalog, the server hands it to the
// phone with every changes answer.
import assert from "node:assert/strict";
import test from "node:test";
import { hub, pairPhone } from "./test/hubPhoneFixtures";

test("the computer's Show members' actions reaches the phone with every changes answer, and changing it ends a phone's wait at once", async (t) => {
  const h = await hub(t);
  const { client } = await pairPhone(h);
  const catalog = (display?: { showMemberActions: boolean }) => ({ catalog: { version: 1, publishedAt: new Date().toISOString(), roles: {}, prompts: [], skills: [], avatars: {}, ...(display ? { display } : {}) } });
  type Changes = { instance: string; seq: number; conversationIds?: string[]; display?: { showMemberActions: boolean } };
  const before = await client.getJson<Changes>("/v1/phone/changes", { instance: "none", after: 0 });
  assert.equal(before.display, undefined, "no catalog yet: the phone keeps its own");
  assert.equal((await h.call(h.owner, "PUT", "/v1/catalog", catalog({ showMemberActions: false }))).status, 200);
  await h.settle();
  const off = await client.getJson<Changes>("/v1/phone/changes", { instance: "none", after: 0 });
  assert.deepEqual(off.display, { showMemberActions: false });
  const started = Date.now();
  // It says what it draws by: answered at once whether the publication
  // below lands before its wait begins or during it.
  const waiting = client.getJson<Changes>("/v1/phone/changes", { instance: off.instance, after: off.seq, waitMs: 20_000, shown: "0" }, { timeoutMs: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await h.call(h.owner, "PUT", "/v1/catalog", catalog({ showMemberActions: true }))).status, 200);
  const woken = await waiting;
  assert.ok(Date.now() - started < 5_000, "answered at once, not at the end of its wait");
  assert.deepEqual(woken.display, { showMemberActions: true });
  assert.deepEqual(woken.conversationIds, [], "no chat changed");
  // Published again unchanged (another setting was saved): a wait goes on.
  const still = client.getJson<Changes>("/v1/phone/changes", { instance: woken.instance, after: woken.seq, waitMs: 1_500 }, { timeoutMs: 10_000 });
  const again = Date.now();
  assert.equal((await h.call(h.owner, "PUT", "/v1/catalog", catalog({ showMemberActions: true }))).status, 200);
  await still;
  assert.ok(Date.now() - again >= 1_000, "an unchanged setting is no news");
  // A phone still drawing by the other setting (it was told one read just
  // before a publication) is answered at once, not after a wait for news.
  const behindAt = Date.now();
  const behind = await client.getJson<Changes>("/v1/phone/changes", { instance: woken.instance, after: woken.seq, waitMs: 20_000, shown: "0" }, { timeoutMs: 30_000 });
  assert.ok(Date.now() - behindAt < 5_000, "a phone behind the setting is not kept waiting");
  assert.deepEqual(behind.display, { showMemberActions: true });
  const level = client.getJson<Changes>("/v1/phone/changes", { instance: woken.instance, after: woken.seq, waitMs: 1_500, shown: "1" }, { timeoutMs: 10_000 });
  const levelAt = Date.now();
  await level;
  assert.ok(Date.now() - levelAt >= 1_000, "one drawing by the same setting waits for news as before");
  // A computer from before has no such setting: the phone shows members'
  // actions, as the CLIs do, rather than keep a setting nobody can change.
  assert.equal((await h.call(h.owner, "PUT", "/v1/catalog", catalog({ showMemberActions: false }))).status, 200);
  assert.equal((await h.call(h.owner, "PUT", "/v1/catalog", catalog())).status, 200);
  await h.settle();
  assert.deepEqual((await client.getJson<Changes>("/v1/phone/changes", { instance: "none", after: 0 })).display, { showMemberActions: true });
});
