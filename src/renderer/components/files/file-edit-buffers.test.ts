import assert from "node:assert/strict";
import test from "node:test";

import type { UnsavedFileEdit, WriteFilePreviewRequest, WriteFilePreviewResult } from "../../../shared/types";
import { FileEditBufferStore } from "./file-edit-buffers";

/** A fake bridge: records writes and keeps the userData copies in a map. */
function bridge(write: (request: WriteFilePreviewRequest) => Promise<WriteFilePreviewResult>) {
  const kept = new Map<string, UnsavedFileEdit>();
  const writes: WriteFilePreviewRequest[] = [];
  (globalThis as { window?: unknown }).window = {
    consensus: {
      writeFilePreview: async (request: WriteFilePreviewRequest) => {
        writes.push(request);
        return write(request);
      },
      saveUnsavedFileEdit: async (edit: UnsavedFileEdit) => { kept.set(edit.realPath, edit); },
      clearUnsavedFileEdit: async (realPath: string) => { kept.delete(realPath); }
    }
  };
  return { kept, writes };
}

// Each test uses its own path: a copy timer left by one test must not land in another's bridge.
function seed(store: FileEditBufferStore, realPath: string, text = "x", baseHash = "h0") {
  return store.open({ conversationId: "c", path: realPath.slice(1), realPath, baseHash, text, bom: false });
}

test("text typed while a save runs stays unsaved, and the next save starts from the new disk content", async () => {
  let release!: () => void;
  const { kept, writes } = bridge(async () => {
    if (writes.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    return { ok: true, hash: `h${writes.length}`, mtimeMs: 0, size: 0 };
  });
  const store = new FileEditBufferStore();
  seed(store, "/t1.txt");
  store.edit("/t1.txt", "y");
  const first = store.save("/t1.txt");
  await new Promise((resolve) => setTimeout(resolve, 0));
  store.edit("/t1.txt", "yz");
  const second = store.save("/t1.txt");
  release();
  await first;
  await second;
  assert.equal(writes[1].baseHash, "h1");
  assert.equal(writes[1].content, "yz");
  assert.equal(store.get("/t1.txt")?.dirty, false);
  assert.equal(kept.size, 0, "a saved text leaves no copy behind");
});

test("a conflict is kept as a copy and never written by a flush", async () => {
  const { kept, writes } = bridge(async () => ({ ok: true, hash: "h1", mtimeMs: 0, size: 0 }));
  const store = new FileEditBufferStore();
  seed(store, "/t2.txt");
  store.edit("/t2.txt", "mine");
  store.markConflict("/t2.txt", "changed");
  await store.flushAll();
  assert.equal(writes.length, 0);
  assert.equal(kept.get("/t2.txt")?.text, "mine");
});

test("a flush keeps a copy before it saves, and saves what it can", async () => {
  const order: string[] = [];
  (globalThis as { window?: unknown }).window = {
    consensus: {
      writeFilePreview: async () => { order.push("write"); return { ok: true, hash: "h1", mtimeMs: 0, size: 0 }; },
      saveUnsavedFileEdit: async () => { order.push("copy"); },
      clearUnsavedFileEdit: async () => { order.push("clear"); }
    }
  };
  const store = new FileEditBufferStore();
  seed(store, "/t3.txt");
  store.edit("/t3.txt", "y");
  await store.flushAll();
  assert.deepEqual(order, ["copy", "write", "clear"]);
});

test("edits restored from an earlier session are not written until the User saves them", async () => {
  const { kept, writes } = bridge(async () => ({ ok: true, hash: "h1", mtimeMs: 0, size: 0 }));
  const store = new FileEditBufferStore();
  store.restore({ conversationId: "c", path: "a.txt", realPath: "/t4.txt", baseHash: "h0", text: "old draft", updatedAt: "" });
  await store.flushAll();
  assert.equal(writes.length, 0);
  assert.equal(kept.get("/t4.txt")?.text, "old draft");
  const outcome = await store.save("/t4.txt");
  assert.equal(outcome.status, "saved");
  assert.equal(writes.length, 1);
});

test("reopening a file while this panel's own save is in flight is not a conflict", async () => {
  let release!: () => void;
  bridge(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { ok: true, hash: "h1", mtimeMs: 0, size: 0 };
  });
  const store = new FileEditBufferStore();
  seed(store, "/t5.txt");
  store.edit("/t5.txt", "y");
  const saving = store.save("/t5.txt");
  await new Promise((resolve) => setTimeout(resolve, 0));
  store.edit("/t5.txt", "yz");
  // The new panel read the file after the write reached the disk.
  const reopened = seed(store, "/t5.txt", "y", "h1");
  assert.equal(reopened.conflict, undefined);
  release();
  await saving;
  assert.equal(store.get("/t5.txt")?.conflict, undefined);
});

test("a dirty buffer opened over a different disk content is a conflict", () => {
  bridge(async () => ({ ok: true, hash: "h1", mtimeMs: 0, size: 0 }));
  const store = new FileEditBufferStore();
  seed(store, "/t6.txt");
  store.edit("/t6.txt", "mine");
  const reopened = seed(store, "/t6.txt", "agent", "h9");
  assert.equal(reopened.conflict, "changed");
  assert.equal(reopened.text, "mine");
});

test("a conflict found by a save nobody is looking at is reported", async () => {
  bridge(async () => ({ ok: false, conflict: true, reason: "changed" }));
  const store = new FileEditBufferStore();
  const reported: string[] = [];
  store.onBackgroundConflict((buffer) => reported.push(buffer.realPath));
  seed(store, "/t7.txt");
  const detach = store.attach("/t7.txt");
  store.edit("/t7.txt", "y");
  await store.save("/t7.txt");
  assert.deepEqual(reported, [], "a shown file shows its own banner");
  detach();
  store.rebase("/t7.txt", "h0");
  await store.save("/t7.txt");
  assert.deepEqual(reported, ["/t7.txt"]);
});

test("discard drops the text and its copy; a clean file nobody shows is forgotten", async () => {
  const { kept } = bridge(async () => ({ ok: true, hash: "h1", mtimeMs: 0, size: 0 }));
  const store = new FileEditBufferStore();
  seed(store, "/t8.txt");
  store.edit("/t8.txt", "y");
  store.markConflict("/t8.txt", "changed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(kept.size, 1);
  await store.discard("/t8.txt");
  assert.equal(store.get("/t8.txt"), undefined);
  assert.equal(kept.size, 0);
  seed(store, "/t8.txt");
  store.forget("/t8.txt");
  assert.equal(store.get("/t8.txt"), undefined);
});
