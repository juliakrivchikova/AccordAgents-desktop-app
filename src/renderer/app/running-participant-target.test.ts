import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage, ChatParticipant, ChatRunningMessageTarget, Conversation } from "../../shared/types";
import { runningParticipantTarget } from "./running-participant-target";

const taylor: ChatParticipant = { id: "taylor", handle: "taylor", roleConfigId: "engineer", kind: "claude-code" };

function pending(id: string, createdAt: string, runId: string): ChatMessage {
  return { id, role: "participant", participantId: "taylor", content: "", createdAt, status: "pending", metadata: { runId } };
}

function chat(messages: ChatMessage[]): Conversation {
  return {
    id: "chat",
    title: "chat",
    kind: "chat",
    createdAt: "2026-10-31T20:00:00.000Z",
    updatedAt: "2026-10-31T20:00:00.000Z",
    messages,
    findings: [],
    metadata: { participants: [taylor] }
  };
}

function withStorage(answer: () => Promise<ChatRunningMessageTarget | undefined>): string[] {
  const calls: string[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    consensus: {
      findRunningParticipantMessage: async (conversationId: string, participantId: string) => {
        calls.push(`${conversationId}:${participantId}`);
        return answer();
      }
    }
  };
  return calls;
}

test("the whole chat's answer wins, even when the open page shows the member idle", async () => {
  const calls = withStorage(async () => ({ messageId: "far-turn", threadRootId: "root" }));
  assert.deepEqual(await runningParticipantTarget(chat([]), "taylor"), { messageId: "far-turn", threadRootId: "root" });
  assert.deepEqual(calls, ["chat:taylor"]);
});

test("a member the whole chat does not show running has no turn to open", async () => {
  withStorage(async () => undefined);
  const page = chat([pending("page-turn", "2026-10-31T20:00:01.000Z", "run-1")]);
  assert.equal(await runningParticipantTarget(page, "taylor"), undefined);
});

test("when the whole-chat read fails, the open page answers", async () => {
  withStorage(async () => {
    throw new Error("sqlite failed");
  });
  const page = chat([pending("page-turn", "2026-10-31T20:00:01.000Z", "run-1")]);
  assert.deepEqual(await runningParticipantTarget(page, "taylor"), { messageId: "page-turn" });
});
