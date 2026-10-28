import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HubOpsClient } from "./hubOpsClient";
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
