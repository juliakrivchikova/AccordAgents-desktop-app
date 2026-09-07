import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { MachineChoiceExecutor, machineChoiceResultId } from "./chatActionNativeClaims";
import { ChatChoicePersistenceError } from "./chat";
import { StorageService } from "./storage";
import { ChatEventLogService } from "./chatEventLog";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { MachineChoiceResultBody } from "../../shared/machineLink";
import type { RespondToChatChoiceRequest } from "../../shared/types";
import type { ChatActionPayload } from "../../shared/chatActionEvents";

const CONVERSATION = "choice-chat";
const CHOICE = "choice-7";
const TARGET = `choice:${CHOICE}`;
const SOURCE = "m1";

/**
 * Answering a choice wakes a member that is waiting, and that can happen once.
 *
 * It used to be admitted by asking whether a receipt event existed, which is a
 * read and not a claim: two answers arriving together both continued the turn,
 * and a crash between continuing it and writing the receipt continued it again
 * on the next start. The desktop's own IPC answered directly *and* published
 * the canonical action, so the member's home ran it a second time.
 *
 * These drive the real executor against real SQLite. The chat is a faithful
 * stand-in for the guard contract ChatService implements: the answer is saved
 * before anything native is claimed, the claim happens inside `beforeApply`,
 * and a disk that refuses the save is a distinct failure from one that refuses
 * the claim.
 */
async function box(options: { failSave?: () => boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-choice-executor-"));
  const storage = new StorageService({ dbPath: path.join(dir, "state.sqlite3") });
  const eventLog = new ChatEventLogService(storage);
  const device = await eventLog.getOrCreateDeviceIdentity();
  const continued: string[] = [];
  const published: MachineChoiceResultBody[] = [];
  let saves = 0;

  const chat = {
    respondToChoice: async (
      request: RespondToChatChoiceRequest,
      _signal?: AbortSignal,
      _progress?: unknown,
      execution?: { decisionEventId: string; beforeApply(participantId: string): Promise<void> }
    ) => {
      // The order the real service uses: validate, save, then admit.
      if (options.failSave?.()) throw new ChatChoicePersistenceError("database or disk is full");
      saves += 1;
      await execution?.beforeApply("p1");
      continued.push(`${request.choiceId}:${request.selectedOptionId ?? ""}`);
      return {
        conversation: {
          id: CONVERSATION, kind: "chat", messages: [{
            id: SOURCE, role: "participant", participantId: "p1", content: "Which one?",
            createdAt: new Date().toISOString(), status: "done",
            metadata: { pendingChoice: { id: CHOICE, status: "selected", options: [], selectedOptionId: request.selectedOptionId } }
          }]
        },
        warnings: []
      } as never;
    }
  };

  const build = (settings: { runtimeId?: string; canApply?: () => boolean } = {}) => new MachineChoiceExecutor({
    storage, deviceId: device.originId, chat: chat as never,
    runtimeIdentity: async () => ({ runtimeId: settings.runtimeId ?? "runtime-a", pid: 4321, startedAt: "synthetic-start" }),
    ...(settings.canApply ? { canApply: settings.canApply } : {}),
    publish: async (body) => {
      published.push(body);
      await eventLog.appendLocalEvent({
        conversationId: body.conversationId, logScopeId: `choice:${body.choiceId}`,
        kind: body.type, eventId: machineChoiceResultId(body.decisionId), payload: body
      });
    }
  });

  /** A real signed answer, so the claim's SQL finds its event. */
  const answer = async (optionId: string) => {
    const { event } = await eventLog.appendLocalEvent({
      conversationId: CONVERSATION, logScopeId: "chat:actions", kind: "choice.answered",
      payload: { operationId: `choice:${CHOICE}:${optionId}`, targetKey: TARGET, stateId: optionId,
        detail: { sourceMessageId: SOURCE, selectedOptionId: optionId } }
    });
    return event as ChatEventEnvelope;
  };

  return {
    storage, eventLog, continued, published, build, answer,
    saves: () => saves,
    cleanup: async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  };
}

function payloadOf(event: ChatEventEnvelope): ChatActionPayload {
  return event.payload as ChatActionPayload;
}

test("two answers to the same choice continue the member once", async () => {
  const held = await box();
  try {
    const executor = held.build();
    const first = await held.answer("a");
    const second = await held.answer("b");
    const [one, two] = await Promise.all([
      executor.applyAction(first, payloadOf(first)),
      executor.applyAction(second, payloadOf(second))
    ]);
    assert.equal(held.continued.length, 1, `the member is continued once: ${JSON.stringify(held.continued)}`);
    const loser = [one, two].find((result) => !result.ok);
    assert.ok(loser, "the answer that lost says so rather than claiming it was carried out");
    assert.match(loser.error ?? "", /already been answered|not repeated|claimed this choice/);
  } finally { await held.cleanup(); }
});

test("a crash between continuing the member and writing the result does not continue it again", async () => {
  const held = await box();
  try {
    const answer = await held.answer("a");
    // A claim on disk with no result: exactly what a process that died inside
    // the continuation leaves behind.
    assert.equal(await held.storage.nativeCommands().claimTarget({
      runtimeId: "runtime-gone", pid: 999, startedAt: "gone",
      eventId: answer.eventId, conversationId: CONVERSATION, targetKey: TARGET, participantId: "p1"
    }), true);

    const result = await held.build().applyAction(answer, payloadOf(answer));
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true, "an unconfirmed continuation is reported as such, not as success");
    assert.deepEqual(held.continued, [], "and the member is not woken a second time");
  } finally { await held.cleanup(); }
});

test("the same signed answer redelivered after a restart is not carried out again", async () => {
  const held = await box();
  try {
    const answer = await held.answer("a");
    const first = await held.build().applyAction(answer, payloadOf(answer));
    assert.equal(first.ok, true);
    assert.deepEqual(held.continued, [`${CHOICE}:a`]);

    // A new runtime over the same disk, replaying the same event.
    const again = await held.build({ runtimeId: "runtime-b" }).applyAction(answer, payloadOf(answer));
    assert.equal(again.ok, true, "the stored result is returned rather than recomputed");
    assert.equal(held.continued.length, 1, "a restart replays the event, not the continuation");
    assert.equal(held.published.length, 1,
      "and the result is not published twice: the one already in the log is what the asker is owed");
  } finally { await held.cleanup(); }
});

test("a runtime that is shutting down keeps the answer instead of half-applying it", async () => {
  const held = await box();
  try {
    const answer = await held.answer("a");
    await assert.rejects(() => held.build({ canApply: () => false }).applyAction(answer, payloadOf(answer)),
      /remains queued/, "the answer is kept for a runtime that can carry it out");
    assert.deepEqual(held.continued, []);
    assert.equal(await held.storage.nativeCommands().targetEffect(CONVERSATION, TARGET), undefined,
      "and nothing was claimed on the way out");
  } finally { await held.cleanup(); }
});

test("a disk that cannot save the answer is a held answer, not a lost one", async () => {
  let broken = true;
  const held = await box({ failSave: () => broken });
  try {
    const answer = await held.answer("a");
    await assert.rejects(() => held.build().applyAction(answer, payloadOf(answer)), ChatChoicePersistenceError,
      "a save that failed is not turned into a terminal refusal of a real decision");
    assert.deepEqual(held.continued, []);
    assert.equal(await held.storage.nativeCommands().targetEffect(CONVERSATION, TARGET), undefined,
      "nothing is claimed for an answer that was never saved");
    assert.deepEqual(held.published, [], "and nothing is published about it either");

    broken = false;
    const recovered = await held.build().applyAction(answer, payloadOf(answer));
    assert.equal(recovered.ok, true);
    assert.deepEqual(held.continued, [`${CHOICE}:a`], "it is carried out once, when the disk allows it");
  } finally { await held.cleanup(); }
});

test("an answer with no source message is refused before anything is claimed", async () => {
  const held = await box();
  try {
    const { event } = await held.eventLog.appendLocalEvent({
      conversationId: CONVERSATION, logScopeId: "chat:actions", kind: "choice.answered",
      payload: { operationId: "choice:broken", targetKey: TARGET, stateId: "a", detail: {} }
    });
    // Rejected before any work: the guard is in applyAction itself, so it
    // throws on the way in rather than returning a failed result.
    await assert.rejects(async () => held.build().applyAction(event as ChatEventEnvelope,
      payloadOf(event as ChatEventEnvelope)), /invalid identities/);
    assert.equal(await held.storage.nativeCommands().targetEffect(CONVERSATION, TARGET), undefined);
  } finally { await held.cleanup(); }
});
