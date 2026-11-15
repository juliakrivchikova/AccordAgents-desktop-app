import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HUB_OP_TAKEN_BACK, HubOpsClient } from "./hubOpsClient";
import { StorageService } from "./storage";
import type { HubOp } from "../../shared/hubOps";

test("a chat's move to the server settles only its content; its turns, cards and documents are still sent", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-ops-client-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new StorageService({ dbPath: path.join(dir, "device.sqlite3") });
  const store = storage.hubClientOps();
  const client = new HubOpsClient({
    store,
    cursor: { get: async () => undefined, set: async () => undefined },
    client: () => undefined,
    apply: async () => undefined,
    resync: async () => 0,
    log: () => undefined
  });
  const at = new Date().toISOString();
  const ops: HubOp[] = [
    { opId: "op-message", kind: "message.create", conversationId: "chat-1", message: { id: "m1", role: "user", content: "hi", createdAt: at } },
    { opId: "op-turn", kind: "turn.claim", conversationId: "chat-1", runId: "turn-m1-p1", messageId: "m1", participantId: "p1" },
    { opId: "op-card", kind: "card.answer", conversationId: "chat-1", cardId: "card-1", answer: { approve: true } },
    { opId: "op-doc", kind: "artifact.create", conversationId: "chat-1" } as unknown as HubOp
  ];
  await store.enqueue(ops, at);
  await client.settleMoved("chat-1");
  const left = (await store.forConversation("chat-1")).map((row) => row.opId);
  assert.deepEqual(left, ["op-turn", "op-card", "op-doc"], "only the chat's own content was in the move");
  assert.equal((await store.get("op-message"))?.status, "accepted");
});

test("stopping the client does not wait for a feed read it never needed to start", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-ops-client-stop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new StorageService({ dbPath: path.join(dir, "device.sqlite3") });
  let feedCalls = 0;
  const fakeClient = { feed: async (_after: number, waitMs: number, signal?: AbortSignal) => {
    feedCalls += 1;
    await new Promise<void>((resolve) => { const timer = setTimeout(resolve, waitMs); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }); });
    return { entries: [], head: 0, more: false };
  } };
  const client = new HubOpsClient({
    store: storage.hubClientOps(),
    cursor: { get: async () => "0", set: async () => undefined },
    client: () => fakeClient as never,
    apply: async () => undefined,
    resync: async () => 0,
    log: () => undefined
  });
  client.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = Date.now();
  await client.stop();
  assert.ok(Date.now() - started < 5_000, `stopped in ${Date.now() - started} ms`);
  assert.ok(feedCalls >= 1);
});

test("an operation too large for the server is refused here with its reason and never holds back the ones after it; answered ones are cleared away", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-ops-client-large-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new StorageService({ dbPath: path.join(dir, "device.sqlite3") });
  const store = storage.hubClientOps();
  const sent: string[][] = [];
  const fakeClient = {
    writeOps: async (ops: HubOp[]) => {
      sent.push(ops.map((op) => op.opId));
      return { results: ops.map((op, index) => ({ opId: op.opId, status: "accepted", seq: index + 1 })), head: ops.length };
    },
    feed: async (_after: number, waitMs: number, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, waitMs); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }); });
      return { entries: [], head: 0, more: false };
    }
  };
  const answered: Array<{ opId: string; status: string; reason?: string }> = [];
  const client = new HubOpsClient({
    store,
    cursor: { get: async () => "0", set: async () => undefined },
    client: () => fakeClient as never,
    apply: async () => undefined,
    resync: async () => 0,
    onAnswered: (row, outcome) => answered.push({ opId: row.opId, status: outcome.status, ...(outcome.status === "rejected" ? { reason: outcome.reason } : {}) }),
    log: () => undefined
  });
  t.after(() => client.stop());
  const at = new Date().toISOString();
  // Cyrillic text: more bytes than characters (the server counts bytes).
  const huge = "ж".repeat(2_200_000);
  await store.enqueue([
    { opId: "op-huge", kind: "message.create", conversationId: "chat-1", message: { id: "m-huge", role: "user", content: huge, createdAt: at } },
    { opId: "op-next", kind: "message.create", conversationId: "chat-1", message: { id: "m-next", role: "user", content: "next", createdAt: at } }
  ], at);
  client.start();
  const deadline = Date.now() + 10_000;
  while (answered.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(answered.map((item) => [item.opId, item.status]), [["op-huge", "rejected"], ["op-next", "accepted"]]);
  assert.equal(answered[0].reason, "The operation is too large.");
  assert.deepEqual(sent, [["op-next"]], "the large one was never sent");
  assert.equal((await store.failures())[0]?.reason, "The operation is too large.", "it is in the failure log (Д12)");
  // A week later the answered ones go.
  await store.prune(Date.now() + 8 * 24 * 60 * 60_000);
  assert.equal(await store.get("op-next"), undefined);
});

test("an operation taken back while a request carried it is answered when that request fails, so nobody waits for it forever", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-ops-client-taken-back-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new StorageService({ dbPath: path.join(dir, "device.sqlite3") });
  const store = storage.hubClientOps();
  let failRequest: (() => void) | undefined;
  const fakeClient = {
    writeOps: () => new Promise((_resolve, reject) => { failRequest = () => reject(new Error("socket hang up")); }),
    feed: async (_after: number, waitMs: number, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, waitMs); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }); });
      return { entries: [], head: 0, more: false };
    }
  };
  const client = new HubOpsClient({
    store,
    cursor: { get: async () => "0", set: async () => undefined },
    client: () => fakeClient as never,
    apply: async () => undefined,
    resync: async () => 0,
    log: () => undefined
  });
  t.after(() => client.stop());
  const at = new Date().toISOString();
  await store.enqueue([{ opId: "op-claim", kind: "turn.claim", conversationId: "chat-1", runId: "turn-m1-p1", messageId: "m1", participantId: "p1" }], at);
  client.start();
  const deadline = Date.now() + 5_000;
  while (!failRequest && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(failRequest, "the request is on its way");
  assert.deepEqual(await client.withdraw("op-claim"), { status: "in-flight" });
  const answer = client.waitFor("op-claim");
  failRequest!();
  assert.deepEqual(await answer, { status: "rejected", reason: HUB_OP_TAKEN_BACK });
  assert.equal(await store.get("op-claim"), undefined, "never sent again");
});

test("pictures go up before a batch is claimed: an operation taken back meanwhile is never sent, and a failed put counts no attempt", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-ops-client-pictures-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new StorageService({ dbPath: path.join(dir, "device.sqlite3") });
  const store = storage.hubClientOps();
  const written: string[] = [];
  const fakeClient = {
    writeOps: async (ops: HubOp[]) => {
      written.push(...ops.map((op) => op.opId));
      return { results: ops.map((op, index) => ({ opId: op.opId, status: "accepted", seq: index + 1 })) };
    },
    // The feed's long wait, as the server holds it (an answer at once would
    // spin the reader).
    feed: async (_after: number, waitMs: number, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, waitMs); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }); });
      return { entries: [], head: 0, more: false };
    }
  };
  let release!: () => void;
  let puts = 0;
  let fail = true;
  const client = new HubOpsClient({
    store,
    cursor: { get: async () => "0", set: async () => undefined },
    client: () => fakeClient as never,
    apply: async () => undefined,
    resync: async () => 0,
    beforeSend: async (ops) => {
      if (!ops.some((op) => op.kind === "message.create") || puts > 0) return false;
      if (fail) {
        fail = false;
        throw new Error("A picture could not be put on your server: the connection was lost.");
      }
      // A slow put: the writer of the other operation takes it back meanwhile.
      await new Promise<void>((resolve) => { release = resolve; });
      puts += 1;
      return true;
    },
    log: () => undefined
  });
  const at = new Date().toISOString();
  await store.enqueue([
    { opId: "op-picture", kind: "message.create", conversationId: "chat-1", message: { id: "m1", role: "user", content: "", createdAt: at } },
    { opId: "op-doc", kind: "artifact.create", conversationId: "chat-1" } as unknown as HubOp
  ], at);
  client.start();
  t.after(() => client.stop());
  await until(async () => (await store.get("op-picture"))?.lastError !== undefined);
  assert.equal((await store.get("op-picture"))?.attempts, 0, "nothing carried it: no attempt");
  assert.deepEqual(written, []);
  client.nudge();
  await until(async () => typeof release === "function");
  const taken = await client.withdraw("op-doc");
  assert.deepEqual(taken, { status: "withdrawn", attempted: false }, "not claimed while its batch's pictures go up");
  release();
  await until(async () => written.length > 0);
  assert.deepEqual(written, ["op-picture"], "the operation taken back is never sent");
});

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a paused reader leaves what the server placed meanwhile unread, waits for a batch being applied, and reads on when resumed", async (t) => {
  // A machine stopping after idle pauses it: work the server places then must
  // stay unread there, so the server starts the machine again for it.
  const dir = await mkdtemp(path.join(tmpdir(), "accord-ops-client-pause-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new StorageService({ dbPath: path.join(dir, "device.sqlite3") });
  const placed: number[] = [];
  let arrived: (() => void) | undefined;
  const fakeClient = { feed: async (after: number, waitMs: number, signal?: AbortSignal) => {
    const ready = () => placed.filter((seq) => seq > after);
    if (ready().length === 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(waitMs, 5_000));
        arrived = () => { clearTimeout(timer); resolve(); };
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
      });
    }
    return { entries: ready().map((seq) => ({ seq })), head: Math.max(0, ...placed), more: false };
  } };
  let cursor = "0";
  const applied: number[] = [];
  let slow: Promise<void> | undefined;
  let applyStarted: (() => void) | undefined;
  const client = new HubOpsClient({
    store: storage.hubClientOps(),
    cursor: { get: async () => cursor, set: async (value) => { cursor = value; } },
    client: () => fakeClient as never,
    apply: async (entries) => {
      applyStarted?.();
      if (slow) await slow;
      applied.push(...entries.map((entry) => entry.seq));
    },
    resync: async () => 0,
    log: () => undefined
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check());
  };
  const place = (seq: number) => { placed.push(seq); arrived?.(); };
  t.after(() => client.stop());
  client.start();
  place(1);
  await until(() => cursor === "1");

  const resume = await client.pauseReading();
  place(2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(applied, [1], "placed while paused: not read");
  assert.equal(cursor, "1", "its place stays before it, so the server counts it unread");
  resume();
  await until(() => cursor === "2");
  assert.deepEqual(applied, [1, 2]);

  // A batch being applied as the pause comes is finished first.
  let release!: () => void;
  slow = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { applyStarted = resolve; });
  place(3);
  await started;
  let pausedNow = false;
  const pausing = client.pauseReading().then((resumeAgain) => { pausedNow = true; return resumeAgain; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pausedNow, false, "the pause waits for the batch in hand");
  release();
  const resumeAgain = await pausing;
  assert.deepEqual(applied, [1, 2, 3]);
  slow = undefined;
  place(4);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!applied.includes(4));
  resumeAgain();
  await until(() => applied.includes(4));
});
