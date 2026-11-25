import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import type { ChatParticipant, ChatParticipantSession, Conversation } from "../../shared/types";
import { chatConversation, chatParticipant, holdChatRunLock, NOW, ROLE, testService } from "./chat/test/conversationFixtures";

test("setArchived archives a chat by stamping metadata and bumping updatedAt", async () => {
  const conversation = chatConversation({ title: "Archive me" });
  const { service, storage } = testService([conversation]);

  const saved = await service.setArchived({ conversationId: conversation.id, archived: true });

  assert.equal(saved?.metadata.archived, true);
  assert.equal(typeof saved?.metadata.archivedAt, "string");
  assert.notEqual(saved?.updatedAt, NOW);
  assert.equal(saved?.messages.length, conversation.messages.length);
  const stored = await storage.getConversation(conversation.id);
  assert.equal(stored?.metadata.archived, true);
  assert.equal(typeof stored?.metadata.archivedAt, "string");
});

test("archive and delete wait for this chat's native closure; a failed proof leaves the chat available", async () => {
  const conversation = chatConversation();
  const closed: string[] = [];
  let fail = true;
  const { service, storage } = testService([conversation], { closeSessions: async id => {
    closed.push(id);
    if (fail) throw new Error("native descendants still live");
  } });
  await assert.rejects(service.setArchived({ conversationId: conversation.id, archived: true }), /descendants still live/);
  assert.notEqual((await storage.getConversation(conversation.id))?.metadata.archived, true);
  fail = false;
  await service.setArchived({ conversationId: conversation.id, archived: true });
  fail = true;
  await assert.rejects(service.deleteConversation({ conversationId: conversation.id }), /descendants still live/);
  assert.ok(await storage.getConversation(conversation.id));
  assert.deepEqual(closed, [conversation.id, conversation.id, conversation.id]);
});

test("replicated archive waits for closure and an archived machine chat cannot start a member", async () => {
  const conversation = chatConversation({ metadata: { participants: [chatParticipant()] } });
  let release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  const { service, storage } = testService([conversation], { closeSessions: async () => { started(); await closed; } });
  let acknowledged = false;
  const applying = service.applyReplicatedConversation(conversation.id, existing => existing && ({ ...existing, metadata: { ...existing.metadata, archived: true } }))
    .then(() => { acknowledged = true; });
  await reached;
  assert.equal(acknowledged, false);
  assert.notEqual((await storage.getConversation(conversation.id))?.metadata.archived, true, "closure must precede publishing the archived state");
  const unarchive = service.setArchived({ conversationId: conversation.id, archived: false });
  release();
  await applying;
  await unarchive;
  assert.notEqual((await storage.getConversation(conversation.id))?.metadata.archived, true, "a later unarchive must wait for replicated closure and then win");
  const batch = chatParts(service).participantBatch as unknown as { runParticipantBatch(conversation: Conversation): Promise<void> };
  await assert.rejects(batch.runParticipantBatch({ ...conversation, metadata: { ...conversation.metadata, archived: true } }), /Unarchive/);
});

test("setArchived unarchiving removes both archived and archivedAt", async () => {
  const conversation = chatConversation({
    title: "Archived chat",
    metadata: { archived: true, archivedAt: NOW }
  });
  const { service, storage } = testService([conversation]);

  const saved = await service.setArchived({ conversationId: conversation.id, archived: false });

  assert.equal("archived" in (saved?.metadata ?? {}), false);
  assert.equal("archivedAt" in (saved?.metadata ?? {}), false);
  const stored = await storage.getConversation(conversation.id);
  assert.equal("archived" in (stored?.metadata ?? {}), false);
  assert.equal("archivedAt" in (stored?.metadata ?? {}), false);
});

test("setArchived is a no-op when the archived state already matches", async () => {
  const conversation = chatConversation({
    title: "Already archived",
    metadata: { archived: true, archivedAt: NOW }
  });
  const { service } = testService([conversation]);

  const saved = await service.setArchived({ conversationId: conversation.id, archived: true });

  assert.equal(saved?.metadata.archivedAt, NOW);
  assert.equal(saved?.updatedAt, NOW);
});

test("setArchived rejects non-chat conversations", async () => {
  const conversation = chatConversation({ title: "Review", kind: "code-review" });
  const { service } = testService([conversation]);

  await assert.rejects(
    () => service.setArchived({ conversationId: conversation.id, archived: true }),
    /Only chat conversations can be archived/
  );
});

test("setArchived rejects running chats", async () => {
  const conversation = chatConversation({
    title: "Running chat",
    metadata: { running: true }
  });
  const { service, storage } = testService([conversation]);

  await assert.rejects(
    () => service.setArchived({ conversationId: conversation.id, archived: true }),
    /cannot be archived while members are running/
  );
  assert.equal((await storage.getConversation(conversation.id))?.metadata.archived, undefined);
});

test("setArchived rejects when a chat run already owns the run queue", async () => {
  const conversation = chatConversation({ title: "Queued chat" });
  const { service, storage } = testService([conversation]);
  const releaseRun = await holdChatRunLock(service, conversation.id);

  try {
    await assert.rejects(
      () => service.setArchived({ conversationId: conversation.id, archived: true }),
      /cannot be archived while members are running/
    );
    assert.equal((await storage.getConversation(conversation.id))?.metadata.archived, undefined);
  } finally {
    await releaseRun();
  }
});

test("setArchived keeps a member's stored session so a later unarchive resumes it", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    metadata: {
      participants: [participant],
      participantSessions: [{
        participantId: participant.id,
        sessionId: "session-1",
        roleConfigId: ROLE.id,
        roleConfigVersion: ROLE.version,
        roleLabel: ROLE.label,
        roleInstructions: ROLE.instructions,
        updatedAt: NOW
      } satisfies ChatParticipantSession]
    }
  });
  const { service, storage } = testService([conversation]);

  await service.setArchived({ conversationId: conversation.id, archived: true });
  const saved = await storage.getConversation(conversation.id);
  const sessions = saved?.metadata.participantSessions as ChatParticipantSession[];
  assert.equal(saved?.metadata.archived, true);
  assert.equal(sessions[0]?.sessionId, "session-1");
});

test("deleteConversation requires archive and removes the chat from storage", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    metadata: {
      archived: true,
      participants: [participant],
      participantSessions: [{
        participantId: participant.id,
        sessionId: "session-1",
        roleConfigId: ROLE.id,
        roleConfigVersion: ROLE.version,
        roleLabel: ROLE.label,
        roleInstructions: ROLE.instructions,
        updatedAt: NOW
      } satisfies ChatParticipantSession]
    }
  });
  const { service, storage } = testService([conversation]);

  assert.equal(await service.deleteConversation({ conversationId: conversation.id }), true);
  assert.equal(await storage.getConversation(conversation.id), undefined);
});

test("deleteConversation rejects an unarchived chat", async () => {
  const conversation = chatConversation();
  const { service, storage } = testService([conversation]);
  await assert.rejects(
    () => service.deleteConversation({ conversationId: conversation.id }),
    /Archive the chat before deleting it permanently/
  );
  assert.ok(await storage.getConversation(conversation.id));
});

test("permanent deletion cannot be resurrected by an already queued stale mutation", async () => {
  const conversation = chatConversation({ metadata: { archived: true } });
  const { service, storage } = testService([conversation]);
  const stale = structuredClone(conversation);
  let release!: () => void;
  let entered!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const mutationEntered = new Promise<void>((resolve) => { entered = resolve; });
  const staleMutation = chatParts(service).store.withChatMutation(stale, async () => {
    entered();
    await blocker;
    stale.title = "resurrected";
    await chatParts(service).store.saveConversation(stale);
  }) as Promise<void>;
  await mutationEntered;

  const deletion = service.deleteConversation({ conversationId: conversation.id });
  for (let attempt = 0; attempt < 100 && !chatParts(service).deletion.deletedConversationIds.has(conversation.id); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  release();
  await assert.rejects(staleMutation, /permanently deleted/);
  assert.equal(await deletion, true);
  assert.equal(await storage.getConversation(conversation.id), undefined);
});

test("removeBehaviorRuleFromChatParticipants removes deleted behavior rules from copied chat participants", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ behaviorRuleIds: ["keep-rule", "deleted-rule"] })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.removeBehaviorRuleFromChatParticipants("deleted-rule");

  const saved = await storage.getConversation(conversation.id);
  const participant = ((saved?.metadata.participants ?? []) as ChatParticipant[])[0];
  const snapshotParticipant = ((snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[])[0];
  assert.deepEqual(participant?.behaviorRuleIds, ["keep-rule"]);
  assert.deepEqual(snapshotParticipant?.behaviorRuleIds, ["keep-rule"]);
});
