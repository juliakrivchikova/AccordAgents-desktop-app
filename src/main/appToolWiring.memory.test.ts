import assert from "node:assert/strict";
import test from "node:test";
import { wireMemoryToolHandler } from "./appToolWiring";

type Handler = (actor: { conversationId: string; participantId: string }, toolName: string, request: unknown) => Promise<unknown>;

function wired(answer: { ok: boolean }, onNoteWritten: () => void): Handler {
  let handler: Handler | undefined;
  const appMcp = { setMemoryToolHandler: (next: Handler) => { handler = next; } };
  const chat = { setMemoryAccess: () => undefined };
  const access = { memory: async () => answer };
  wireMemoryToolHandler(appMcp as never, chat as never, () => access as never, onNoteWritten);
  return handler as Handler;
}

const actor = { conversationId: "c1", participantId: "p1" };

test("usage: a member's note is told only when a write succeeds, and a failing observer changes nothing", async () => {
  let written = 0;
  const ok = wired({ ok: true }, () => { written += 1; });
  await ok(actor, "app_memory_archive", { noteId: "n1" });
  assert.equal(written, 0, "archiving a note is not writing one");
  assert.deepEqual(await ok(actor, "app_memory_write", { title: "t", body: "b", kind: "status", scope: "chat" }), { ok: true });
  assert.equal(written, 1);

  const refused = wired({ ok: false }, () => { written += 1; });
  await refused(actor, "app_memory_write", { title: "t", body: "b" });
  assert.equal(written, 1, "a refused write is not a note");

  const throwing = wired({ ok: true }, () => { throw new Error("observer broke"); });
  assert.deepEqual(await throwing(actor, "app_memory_write", { title: "t", body: "b" }), { ok: true });
});
