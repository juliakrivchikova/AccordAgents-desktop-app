import assert from "node:assert/strict";
import test from "node:test";
import { mergeStoredChatMetadata } from "./chat/store/mergeStoredMetadata";
import type { AgentContextUsage, ChatParticipant, ChatParticipantSession } from "../../shared/types";
import { chatConversation, chatParticipant, cloneConversation, NOW, ROLE, testService } from "./chat/test/conversationFixtures";

test("addParticipant serializes concurrent roster additions without dropping a participant", async () => {
  const conversation = chatConversation({ title: "Roster chat" });
  const { service, storage } = testService([conversation]);

  await Promise.all([
    service.addParticipant({
      conversationId: conversation.id,
      participant: {
        handle: "taylor",
        roleConfigId: ROLE.id,
        kind: "claude-code"
      }
    }),
    service.addParticipant({
      conversationId: conversation.id,
      participant: {
        handle: "alex",
        roleConfigId: ROLE.id,
        kind: "codex-cli"
      }
    })
  ]);

  const saved = await storage.getConversation(conversation.id);
  const participants = (saved?.metadata.participants ?? []) as ChatParticipant[];
  assert.deepEqual(
    participants.map((participant) => participant.handle).sort(),
    ["alex", "drew", "taylor"]
  );
  assert.equal(saved?.messages.filter((message) => message.content === "Added @taylor to the chat.").length, 1);
  assert.equal(saved?.messages.filter((message) => message.content === "Added @alex to the chat.").length, 1);
});

test("syncSavedParticipantAvatar refreshes copied chat participant avatars", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat" })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.syncSavedParticipantAvatar(
    { handle: "drew", kind: "codex-cli" },
    { id: "saved-drew", handle: "drew", kind: "codex-cli", avatarId: "codex-logo" }
  );

  const saved = await storage.getConversation(conversation.id);
  const savedParticipants = (saved?.metadata.participants ?? []) as ChatParticipant[];
  const snapshotParticipants = (snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[];
  const participant = savedParticipants[0];
  assert.equal(participant?.avatarId, "codex-logo");
  assert.equal(participant?.participantConfigId, "saved-drew");
  assert.equal(saved?.updatedAt, NOW);
  assert.equal(saved?.messages.length, conversation.messages.length);
  assert.equal(snapshotParticipants[0]?.avatarId, "codex-logo");
});

test("syncSavedParticipantConfig refreshes copied chat participant behavior rules", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat", behaviorRuleIds: ["old-rule"] })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.syncSavedParticipantConfig(
    { handle: "drew", kind: "codex-cli" },
    {
      id: "saved-drew",
      handle: "drew",
      kind: "codex-cli",
      avatarId: "codex-logo",
      behaviorRuleIds: ["new-rule"]
    }
  );

  const saved = await storage.getConversation(conversation.id);
  const participant = ((saved?.metadata.participants ?? []) as ChatParticipant[])[0];
  const snapshotParticipant = ((snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[])[0];
  assert.equal(participant?.participantConfigId, "saved-drew");
  assert.equal(participant?.avatarId, "codex-logo");
  assert.deepEqual(participant?.behaviorRuleIds, ["new-rule"]);
  assert.deepEqual(snapshotParticipant?.behaviorRuleIds, ["new-rule"]);
});

test("syncSavedParticipantConfig does not legacy-match participants linked to another preset", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [
        chatParticipant({
          participantConfigId: "other-preset",
          avatarId: "codex-cat",
          behaviorRuleIds: ["other-rule"]
        })
      ],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.syncSavedParticipantConfig(
    { handle: "drew", kind: "codex-cli" },
    {
      id: "saved-drew",
      handle: "drew",
      kind: "codex-cli",
      avatarId: "codex-logo",
      behaviorRuleIds: ["new-rule"]
    }
  );

  const saved = await storage.getConversation(conversation.id);
  const participant = ((saved?.metadata.participants ?? []) as ChatParticipant[])[0];
  assert.equal(participant?.participantConfigId, "other-preset");
  assert.equal(participant?.avatarId, "codex-cat");
  assert.deepEqual(participant?.behaviorRuleIds, ["other-rule"]);
  assert.equal(snapshots.length, 0);
});

test("hydrateContextUsage refreshes copied participant avatars from saved settings", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat", behaviorRuleIds: ["old-rule"] })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation], {
    participantConfigs: [{
      id: "saved-drew",
      handle: "drew",
      roleConfigId: ROLE.id,
      kind: "codex-cli",
      avatarId: "codex-logo",
      behaviorRuleIds: ["new-rule"],
      updatedAt: NOW
    }]
  });

  const hydrated = await service.hydrateContextUsage(conversation);

  const saved = await storage.getConversation(conversation.id);
  const hydratedParticipants = (hydrated.metadata.participants ?? []) as ChatParticipant[];
  const savedParticipants = (saved?.metadata.participants ?? []) as ChatParticipant[];
  assert.equal(hydratedParticipants[0]?.avatarId, "codex-logo");
  assert.equal(savedParticipants[0]?.avatarId, "codex-logo");
  assert.equal(hydratedParticipants[0]?.participantConfigId, "saved-drew");
  assert.deepEqual(hydratedParticipants[0]?.behaviorRuleIds, ["new-rule"]);
  assert.deepEqual(savedParticipants[0]?.behaviorRuleIds, ["new-rule"]);
  assert.equal(saved?.updatedAt, NOW);
  assert.equal(((snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[])[0]?.avatarId, "codex-logo");
});

test("hydrateContextUsage refreshes stale stored context usage for existing sessions", async () => {
  const participant = chatParticipant({ model: "gpt-5.5" });
  const staleUsage: AgentContextUsage = {
    usedTokens: 26_000,
    contextWindowTokens: 258_000,
    percentage: 10,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:00:00.000Z",
    model: "gpt-5.5"
  };
  const freshUsage: AgentContextUsage = {
    usedTokens: 193_000,
    contextWindowTokens: 258_000,
    percentage: 75,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:01:00.000Z",
    model: "gpt-5.5"
  };
  const conversation = chatConversation({
    metadata: {
      participants: [participant],
      participantSessions: [chatSession(participant, "019ed183-1d77-7450-9070-6ea6f0b61aa7")],
      agentContextUsageByParticipant: {
        [participant.id]: staleUsage
      }
    }
  });
  const { service, storage } = testService([conversation], {
    contextUsageBySession: {
      "019ed183-1d77-7450-9070-6ea6f0b61aa7": freshUsage
    }
  });

  const hydrated = await service.hydrateContextUsage(conversation);
  const saved = await storage.getConversation(conversation.id);
  const hydratedUsage = hydrated.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage>;
  const savedUsage = saved?.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage> | undefined;

  assert.equal(hydratedUsage[participant.id]?.usedTokens, 193_000);
  assert.equal(savedUsage?.[participant.id]?.usedTokens, 193_000);
});

test("hydrateContextUsage reads each session log once instead of waiting for missing logs", async () => {
  // Opening a chat hydrates it. Old sessions' CLI logs are deleted by the CLI, and
  // retrying each of them made every open of a big chat take a second.
  const participant = chatParticipant({ model: "gpt-5.5" });
  const conversation = chatConversation({
    metadata: {
      participants: [participant],
      participantSessions: [chatSession(participant, "019ed183-1d77-7450-9070-6ea6f0b6dead")]
    }
  });
  const contextUsageRequests: Array<{ sessionId: string | undefined; waitForLog: boolean | undefined }> = [];
  const { service } = testService([conversation], { contextUsageRequests });

  await service.hydrateContextUsage(conversation);

  assert.deepEqual(contextUsageRequests, [{ sessionId: "019ed183-1d77-7450-9070-6ea6f0b6dead", waitForLog: false }]);
});

test("hydrateContextUsage does not overwrite newer stored context usage from a stale caller snapshot", async () => {
  const participant = chatParticipant({ model: "gpt-5.5" });
  const staleUsage: AgentContextUsage = {
    usedTokens: 26_000,
    contextWindowTokens: 258_000,
    percentage: 10,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:00:00.000Z",
    model: "gpt-5.5"
  };
  const newerStoredUsage: AgentContextUsage = {
    usedTokens: 193_000,
    contextWindowTokens: 258_000,
    percentage: 75,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:02:00.000Z",
    model: "gpt-5.5"
  };
  const staleLogUsage: AgentContextUsage = {
    usedTokens: 51_000,
    contextWindowTokens: 258_000,
    percentage: 20,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:01:00.000Z",
    model: "gpt-5.5"
  };
  const conversation = chatConversation({
    metadata: {
      participants: [participant],
      participantSessions: [chatSession(participant, "019ed183-1d77-7450-9070-6ea6f0b61aa7")],
      agentContextUsageByParticipant: {
        [participant.id]: staleUsage
      }
    }
  });
  const { service, storage } = testService([conversation], {
    contextUsageBySession: {
      "019ed183-1d77-7450-9070-6ea6f0b61aa7": staleLogUsage
    }
  });
  const storedConversation = cloneConversation(conversation);
  storedConversation.metadata.agentContextUsageByParticipant = {
    [participant.id]: newerStoredUsage
  };
  await storage.saveConversation(storedConversation);

  const hydrated = await service.hydrateContextUsage(conversation);
  const saved = await storage.getConversation(conversation.id);
  const hydratedUsage = hydrated.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage>;
  const savedUsage = saved?.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage> | undefined;

  assert.equal(hydratedUsage[participant.id]?.usedTokens, 193_000);
  assert.equal(savedUsage?.[participant.id]?.usedTokens, 193_000);
});

test("hydrateContextUsage preserves newer stored messages when syncing participant avatars", async () => {
  const staleConversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat" })],
      participantSessions: []
    }
  });
  const storedConversation = cloneConversation(staleConversation);
  storedConversation.messages.push({
    id: "message-2",
    role: "participant",
    participantId: "participant-1",
    participantLabel: "@drew",
    content: "Already saved.",
    createdAt: NOW,
    status: "done"
  });
  const { service, storage } = testService([storedConversation], {
    participantConfigs: [{
      id: "saved-drew",
      handle: "drew",
      roleConfigId: ROLE.id,
      kind: "codex-cli",
      avatarId: "codex-logo",
      updatedAt: NOW
    }]
  });

  const hydrated = await service.hydrateContextUsage(staleConversation);

  const saved = await storage.getConversation(staleConversation.id);
  assert.equal(saved?.messages.some((message) => message.id === "message-2"), true);
  assert.equal(hydrated.messages.some((message) => message.id === "message-2"), true);
  assert.equal(((saved?.metadata.participants ?? []) as ChatParticipant[])[0]?.avatarId, "codex-logo");
});

test("participant-session metadata merge preserves newer handles and respects newer intentional clears", () => {
  const { service } = testService([]);
  const merge = mergeStoredChatMetadata as (
    stored: Record<string, unknown>,
    current: Record<string, unknown>
  ) => Record<string, unknown>;
  const remoteSession = {
    sessionKey: "warm",
    sessionDir: "/worker/sessions/warm",
    worker: { host: "worker.example" },
    protocolVersion: 2,
    runtimeFingerprint: "fingerprint",
    updatedAt: "2026-07-10T00:00:02.000Z"
  };
  const stored = {
    participantId: "participant",
    sessionId: "session-id",
    remoteSession,
    updatedAt: "2026-07-10T00:00:02.000Z"
  };
  const stale = {
    participantId: "participant",
    sessionId: "",
    updatedAt: "2026-07-10T00:00:01.000Z"
  };
  const preserved = merge(
    { participantSessions: [stored] },
    { participantSessions: [stale] }
  ).participantSessions as Array<Record<string, unknown>>;
  assert.equal((preserved[0].remoteSession as { sessionKey: string }).sessionKey, "warm");
  assert.equal(preserved[0].sessionId, "session-id");

  const cleared = merge(
    { participantSessions: [stored] },
    { participantSessions: [{ ...stale, updatedAt: "2026-07-10T00:00:03.000Z", remoteSession: undefined }] }
  ).participantSessions as Array<Record<string, unknown>>;
  assert.equal(cleared[0].remoteSession, undefined);
  assert.equal(cleared[0].sessionId, "");
});

function chatSession(participant: ChatParticipant, sessionId: string): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: ROLE.version,
    participantKind: participant.kind,
    participantModel: participant.model,
    runtimeConfigVersion: 1,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    updatedAt: NOW
  };
}
