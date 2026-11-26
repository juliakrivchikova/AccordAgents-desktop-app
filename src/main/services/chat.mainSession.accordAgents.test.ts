import assert from "node:assert/strict";
import test from "node:test";

import { accordLaunchCardForMessage } from "../../shared/accordLaunchCard";
import type { ChatMessage, ChatParticipantSession, Conversation } from "../../shared/types";
import {
  accordSkills, GENERIC_ROLE, mainSession, mainSessionChat, member, participantsOf, testService, waitFor
} from "./chat/test/mainSessionFixtures";

// Reported 2026-11-26: Codex was in the side panel's Agents list, yet Accord
// asked for "at least two members". An Accord the User starts may name an
// Agents-list CLI with no member yet; the member is made as the main
// session's member for a delegated task, then the Accord starts with it.

const REPO = "/work/app";

function chatWithAgents(extra: ReturnType<typeof member>[] = []): Conversation {
  const conversation = mainSessionChat([mainSession("claude-code"), ...extra], {
    subagentProviders: { entries: [{ kind: "codex-cli", model: "gpt-6.2-astra", reasoningEffort: "high" }] }
  });
  return { ...conversation, repoPath: REPO };
}

test("an Accord with an Agents-list CLI makes its member as for a delegated task, then asks the facilitator with it", async () => {
  const { service, storage, runs } = testService({ conversation: chatWithAgents(), userSkills: accordSkills() });
  const started = await service.startAccord({
    conversationId: "conversation-1",
    facilitatorParticipantId: "main-id",
    targetParticipantIds: [],
    targetProviderKinds: ["codex-cli"],
    subject: "Pick the database."
  });

  const added = participantsOf(storage.current).filter((participant) => participant.id !== "main-id");
  assert.equal(added.length, 1, "one member for the CLI");
  const [codex] = added;
  assert.equal(codex.kind, "codex-cli");
  assert.equal(codex.model, "gpt-6.2-astra", "the model set for it in the Agents list");
  assert.equal(codex.reasoningEffort, "high", "and its effort");
  assert.equal(codex.roleConfigId, GENERIC_ROLE.id);
  assert.equal(codex.delegatedByParticipantId, "main-id", "held to the main session, as a delegated member is");
  const sessions = storage.current.metadata.participantSessions as ChatParticipantSession[];
  assert.ok(sessions.some((session) => session.participantId === codex.id), "with its own new CLI session");

  const launch = storage.current.messages.find((message: ChatMessage) => message.id === started.sourceMessageId)!;
  assert.equal(launch.role, "user", "the User's launch");
  assert.deepEqual(accordLaunchCardForMessage(launch), { facilitator: "main", members: [codex.handle], subject: "Pick the database." });
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.role === "system" && message.content === `Added @${codex.handle} to the chat for the Accord.`));
  assert.equal(storage.current.metadata.appToolApprovals, undefined, "no member request of the main session's is recorded: the User added it");
  await waitFor(() => runs.some((run) => run.participant.id === "main-id" && run.prompt.includes("/accord")));
});

test("a launch that is refused adds nobody, and a CLI that has a member by now is not added again", async () => {
  const noSubject = testService({ conversation: chatWithAgents(), userSkills: accordSkills() });
  await assert.rejects(noSubject.service.startAccord({
    conversationId: "conversation-1", facilitatorParticipantId: "main-id", targetParticipantIds: [], targetProviderKinds: ["codex-cli"], subject: "  "
  }), /Accord subject is required/);
  assert.equal(participantsOf(noSubject.storage.current).length, 1);

  const codexMember = member("codex-id", "codex", { delegatedByParticipantId: "main-id" });
  const taken = testService({ conversation: chatWithAgents([codexMember]), userSkills: accordSkills() });
  await assert.rejects(taken.service.startAccord({
    conversationId: "conversation-1", facilitatorParticipantId: "main-id", targetParticipantIds: [], targetProviderKinds: ["codex-cli"], subject: "Pick it."
  }), /Codex is not in this chat's Agents list, or it has a member here already/);
  assert.deepEqual(participantsOf(taken.storage.current).map((participant) => participant.id), ["main-id", "codex-id"]);
  assert.equal(taken.storage.current.messages.length, 1, "no launch");
});
