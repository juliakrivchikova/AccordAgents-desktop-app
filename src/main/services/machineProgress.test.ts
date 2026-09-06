import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { decodeMachineProgress, encodeMachineProgress, machineProgressEventId, type MachineProgressFrame } from "../../shared/machineProgress";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { ChatMessage, Conversation, ReviewProgress } from "../../shared/types";
import { StorageService } from "./storage";
import { ChatEventLogService } from "./chatEventLog";
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

test("progress survives restart without rewriting a large chat; failed frame commits retry atomically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "machine-progress-"));
  const dbPath = path.join(dir, "state.sqlite3");
  const storage = new StorageService({ dbPath });
  const log = new ChatEventLogService(storage);
  await storage.init();
  const sql = (text: string): Promise<void> => (storage as any).runSql(text);
  try {
    const messages: ChatMessage[] = Array.from({ length: 14_000 }, (_, i) => ({ id: `m${i}`, role: "user", content: "x".repeat(2900), createdAt: "2026-09-06T20:00:00Z" }));
    messages.push({ id: "reply", role: "participant", participantId: "member", content: "", status: "pending", metadata: { runId: "run" }, createdAt: "2026-09-06T20:00:00Z" });
    const conversation: Conversation = { id: "chat", kind: "chat", title: "Large progress", metadata: {}, messages, findings: [], createdAt: "2026-09-06T20:00:00Z", updatedAt: "2026-09-06T20:00:00Z" };
    await storage.saveConversation(conversation);
    // No frame is allowed to write the chat or any of its 14,001 message rows.
    await sql(`create trigger prohibit_chat_update before update on conversations begin select raise(abort,'chat rewrite'); end;
      create trigger prohibit_message_update before update on conversation_messages begin select raise(abort,'message rewrite'); end;`);
    let previous: ReviewProgress | undefined, previousEventId: string | undefined;
    const append = async (next: ReviewProgress, sequence: number) => {
      const frame = encodeMachineProgress(previous, next, { conversationId: "chat", streamId: "stream", sequence, previousEventId });
      const payload = await storage.deviceEventBlobs().prepare(frame);
      const { event } = await log.appendLocalEvent({ conversationId: "chat", logScopeId: "progress", kind: frame.type, eventId: machineProgressEventId(frame), payload });
      return { event, frame, next };
    };
    const first = await append(progress("Partial output"), 1);
    await storage.machineProgress().apply(first.event, first.frame); previous = first.next; previousEventId = first.event.eventId;
    const second = await append(progress("Partial output followed by more text", 2), 2);
    await sql("create trigger full_progress before update on machine_progress_heads begin select raise(abort,'SQLITE_FULL'); end;");
    await assert.rejects(storage.machineProgress().apply(second.event, second.frame));
    const failed = await new StorageService({ dbPath }).openConversation("chat", 10);
    assert.equal(failed?.conversation.messages.at(-1)?.content, "Partial output");
    await sql("drop trigger full_progress;");
    await storage.machineProgress().apply(second.event, second.frame); previous = second.next; previousEventId = second.event.eventId;
    assert.equal(await storage.machineProgress().apply(second.event, second.frame), undefined);
    const finished = await append({ runId: "run", phase: "done", message: "Finished", createdAt: "2026-09-06T20:00:01Z" }, 3);
    await storage.machineProgress().apply(finished.event, finished.frame);
    const restarted = new StorageService({ dbPath });
    const opened = await restarted.openConversation("chat", 10);
    assert.equal(opened?.conversation.messages.at(-1)?.content, "Partial output followed by more text");
    assert.equal(opened?.conversation.messages.at(-1)?.metadata?.activityEvents?.[0].status, "completed");
    await restarted.machineProgress().close("run");
    assert.equal(await restarted.machineProgress().apply(second.event, second.frame), undefined);
    const finalMessages = [{ ...messages.at(-1)!, status: "done" as const, content: "Final provider answer" }];
    assert.deepEqual(await restarted.machineProgress().overlay("chat", finalMessages), finalMessages);
  } finally { await rm(dir, { recursive: true, force: true }); }
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

test("machine startup recovers published local progress before native-run recovery", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "machine-progress-recovery-"));
  try {
    const dbPath = path.join(dir, "state.sqlite3");
    const storage = new StorageService({ dbPath });
    const log = new ChatEventLogService(storage);
    const identity = await log.getOrCreateDeviceIdentity();
    let before: ReviewProgress | undefined, previousEventId: string | undefined;
    for (let sequence = 1; sequence <= 2; sequence++) {
      const next = progress(sequence === 1 ? "Stored before the crash" : "Stored before the crash, including the final fragment", sequence);
      const frame = encodeMachineProgress(before, next, { conversationId: "chat", streamId: "stream", sequence, previousEventId });
      const { event } = await log.appendLocalEvent({ conversationId: "chat", logScopeId: "progress", kind: frame.type,
        eventId: machineProgressEventId(frame), payload: frame });
      if (sequence === 1) await storage.machineProgress().apply(event, frame);
      // The second publish committed, but the process died before apply().
      before = next; previousEventId = event.eventId;
    }
    const restarted = new StorageService({ dbPath });
    const row: ChatMessage = { id: "reply", role: "participant", participantId: "member", status: "pending", content: "",
      metadata: { runId: "run" }, createdAt: "2026-09-06T20:00:00Z" };
    await restarted.machineProgress().recoverLocal("another-device");
    assert.equal((await restarted.machineProgress().overlay("chat", [row]))[0].content, "Stored before the crash");
    await restarted.machineProgress().recoverLocal(identity.originId);
    assert.equal((await restarted.machineProgress().overlay("chat", [row]))[0].content, before?.agentProgress?.partialContent);
    await restarted.machineProgress().recoverLocal(identity.originId);
    assert.equal((await restarted.machineProgress().overlay("chat", [row]))[0].metadata?.activityEvents?.[0].status, "completed");
    for (const status of ["failed", "interrupted", "unconfirmed"]) {
      const messages = await restarted.machineProgress().retainPartialForOutcome({ runId: "run", participantId: "member", status, messages: [] });
      assert.equal(messages[0].content, before?.agentProgress?.partialContent, `${status} keeps the stored partial reply`);
    }
    assert.deepEqual(await restarted.machineProgress().retainPartialForOutcome({ runId: "run", participantId: "member", status: "completed", messages: [] }), []);
    assert.deepEqual(await restarted.machineProgress().retainPartialForOutcome({ runId: "run", participantId: "another-member", status: "failed", messages: [] }), []);
    const native = [{ ...row, status: "error" as const, content: "Actual provider outcome" }];
    assert.deepEqual(await restarted.machineProgress().retainPartialForOutcome({ runId: "run", participantId: "member", status: "failed", messages: native }), native);
  } finally { await rm(dir, { recursive: true, force: true }); }
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
