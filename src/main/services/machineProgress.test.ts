import assert from "node:assert/strict";
import test from "node:test";
import { decodeMachineProgress, encodeMachineProgress, machineProgressEventId, type MachineProgressFrame } from "../../shared/machineProgress";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { ReviewProgress } from "../../shared/types";
import { MachineProgressSender } from "./machineProgressSender";

const progress = (content: string, sequence = 1): ReviewProgress => ({ runId: "run", phase: "debate", message: "Responding", createdAt: "2026-09-06T20:00:00Z",
  agentProgress: { participantId: "member", participantLabel: "Machine member", state: "running", messageId: "reply", partialContent: content,
    activityEvents: [{ id: "tool", sequence, kind: "command", label: "Command", status: sequence === 1 ? "started" : "completed", createdAt: "2026-09-06T20:00:00Z" }] } });

test("progress deltas grow with new text, preserve tool changes and reject missing bases", () => {
  let before: ReviewProgress | undefined;
  let reconstructed: ReviewProgress | undefined;
  let eventId: string | undefined;
  let bytes = 0, cumulativeBytes = 0;
  for (let i = 1; i <= 256; i++) {
    const next = progress("x".repeat(i * 4096), i < 128 ? 1 : 2);
    const frame = encodeMachineProgress(before, next, { conversationId: "chat", streamId: "stream", sequence: i, previousEventId: eventId });
    reconstructed = decodeMachineProgress(reconstructed, frame);
    assert.deepEqual(reconstructed, next);
    bytes += Buffer.byteLength(JSON.stringify(frame));
    cumulativeBytes += Buffer.byteLength(JSON.stringify(next));
    before = next;
    eventId = machineProgressEventId(frame);
  }
  assert.ok(bytes < 1_300_000, `${bytes} bytes for a 1 MiB answer`);
  assert.ok(cumulativeBytes > 130_000_000);
  assert.equal(reconstructed?.agentProgress?.activityEvents?.[0].status, "completed");
  const bad = encodeMachineProgress(before, progress("replacement"), { conversationId: "chat", streamId: "stream", sequence: 257, previousEventId: eventId });
  assert.throws(() => decodeMachineProgress(undefined, { ...bad, content: { retain: 2, append: "x" } }), /text base/);
  assert.throws(() => decodeMachineProgress(before, { ...bad, activity: { upserts: [], removedIds: [], order: ["missing"] } }), /activity base/);
});

test("sender retains a failed frame verbatim, coalesces only text and flushes state changes before terminal", async () => {
  const attempts: MachineProgressFrame[] = [];
  const durable: MachineProgressFrame[] = [];
  let fail = true, recovered = 0;
  const sender = new MachineProgressSender({ conversationId: "chat", publish: async frame => {
    attempts.push(structuredClone(frame)); return { eventId: machineProgressEventId(frame) } as ChatEventEnvelope;
  }, stored: async (_event, frame) => { if (fail) throw Error("SQLITE_FULL"); durable.push(frame); }, onError: () => undefined, onRecovered: () => { recovered++; } });
  try {
    sender.note(progress("first"));
    await assert.rejects(sender.flush(), /SQLITE_FULL/);
    sender.note(progress("first plus second"));
    sender.note(progress("first plus second plus third"));
    sender.note(progress("first plus second plus third", 2));
    fail = false;
    await sender.finish();
    assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(durable.length, 3);
    assert.equal(recovered, 1);
    let result: ReviewProgress | undefined;
    for (const frame of durable) result = decodeMachineProgress(result, frame);
    assert.equal(result?.agentProgress?.partialContent, "first plus second plus third");
    assert.equal(result?.agentProgress?.activityEvents?.[0].status, "completed");
    assert.equal(sender.hasPending(), false);
  } finally { sender.close(); }
});

test("a blocked writer retains tool transitions as deltas without quadratic answer copies", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let reconstructed: ReviewProgress | undefined;
  let observed = 0;
  const sender = new MachineProgressSender({ conversationId: "chat", publish: async frame => {
    await blocked;
    return { eventId: machineProgressEventId(frame) } as ChatEventEnvelope;
  }, stored: async (_event, frame) => { reconstructed = decodeMachineProgress(reconstructed, frame); observed++; },
  onError: () => undefined, onRecovered: () => undefined });
  try {
    sender.note(progress("x".repeat(4096), 1));
    const flushing = sender.flush();
    for (let i = 2; i <= 256; i++) sender.note(progress("x".repeat(i * 4096), i));
    const queuedBytes = Buffer.byteLength(JSON.stringify((sender as any).pending));
    assert.ok(queuedBytes < 1_500_000, `${queuedBytes} queued bytes for a 1 MiB answer while the writer is blocked`);
    release();
    await flushing;
    await sender.finish();
    assert.equal(observed, 256, "every observed tool change survives backpressure");
    assert.equal(reconstructed?.agentProgress?.partialContent?.length, 1_048_576);
    assert.equal(reconstructed?.agentProgress?.activityEvents?.[0].sequence, 256);
  } finally { release(); sender.close(); }
});
