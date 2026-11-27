import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { validateRepoFileMentions } from "./chat/choices/mentions";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type {
  ChatAppToolApproval, ChatMessage, ChatParticipant, ChatParticipantSession, ChatSkillMention, Conversation
} from "../../shared/types";
import {
  chatConversation, chatParticipant, NOW, participantRequestApproval, participantRequestItem, participantRequestMessageWithItems,
  ROLE, testService, userMessage, waitFor
} from "./chat/test/mentionFixtures";

test("validateRepoFileMentions keeps safe repo-relative files and rejects unsafe paths", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-repo-files-"));
  const repoPath = path.join(tempRoot, "repo");
  const outsidePath = path.join(tempRoot, "outside.txt");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await writeFile(path.join(repoPath, "src/chat.ts"), "export const value = 1;\n", "utf8");
  await writeFile(outsidePath, "secret\n", "utf8");
  await symlink(outsidePath, path.join(repoPath, "src/outside-link"));

  try {
    const service = testService().service as any;
    const conversation = chatConversation([chatParticipant()], repoPath);
    const warnings: string[] = [];

    const mentions = await validateRepoFileMentions(conversation, [
      { path: "src/chat.ts" },
      { path: "../outside.txt" },
      { path: "/tmp/outside.txt" },
      { path: "src" },
      { path: "src/outside-link" }
    ], warnings);

    assert.deepEqual(mentions, [{ path: "src/chat.ts" }]);
    assert.equal(warnings.some((warning) => warning.includes("path is invalid")), true);
    assert.equal(warnings.some((warning) => warning.includes("path is a directory")), true);
    assert.equal(warnings.some((warning) => warning.includes("path escapes repository")), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validateRepoFileMentions extracts manually typed repo file tokens", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-repo-file-tokens-"));
  const repoPath = path.join(tempRoot, "repo");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await mkdir(path.join(repoPath, "docs"), { recursive: true });
  await writeFile(path.join(repoPath, "src/chat.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(repoPath, "docs/readme.md"), "# Docs\n", "utf8");

  try {
    const service = testService().service as any;
    const conversation = chatConversation([chatParticipant()], repoPath);
    const warnings: string[] = [];

    const mentions = await validateRepoFileMentions(
      conversation,
      [{ path: "src/chat.ts" }],
      warnings,
      [
        "Inspect #src/chat.ts and #docs/readme.md.",
        "Keep list marker #1 as prose.",
        "```",
        "#src/ignored.ts",
        "```"
      ].join("\n")
    );

    assert.deepEqual(mentions, [{ path: "src/chat.ts" }, { path: "docs/readme.md" }]);
    assert.equal(warnings.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("buildPrompt adds repo file guidance based on repoRead permission", () => {
  const participant = chatParticipant({ repoRead: false });
  const conversation = chatConversation([participant], "/repo");
  const triggerMessage = {
    id: "message-1",
    role: "user" as const,
    content: "Please inspect #src/chat.ts",
    createdAt: NOW,
    status: "done" as const,
    metadata: {
      threadId: "message-1",
      repoFileMentions: [{ path: "src/chat.ts" }]
    }
  };
  conversation.messages.push(triggerMessage);
  const service = testService({ canRequestPermissions: true }).service as any;
  const session = chatSession(participant);

  const blockedPrompt = chatParts(service).turnPrompt.buildPrompt(conversation, participant, session, triggerMessage, "/workspace", false, {
    includeRoleInstructions: false,
    agentMode: "default",
    permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), repoRead: false })
  });
  const allowedPrompt = chatParts(service).turnPrompt.buildPrompt(conversation, participant, session, triggerMessage, "/workspace", false, {
    includeRoleInstructions: false,
    agentMode: "default",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
  });

  assert.match(blockedPrompt, /Referenced repository files/);
  assert.match(blockedPrompt, /src\/chat\.ts/);
  assert.match(blockedPrompt, /repoRead is not granted/);
  assert.match(allowedPrompt, /You may read these\./);
});

test("buildPromptParts: a resumed session's message is User's text alone; its instructions come whole only when it must be told them again", () => {
  const participant = chatParticipant();
  const conversationWithRepo = chatConversation([participant], "/repo");
  const conversationNoRepo = chatConversation([participant], "");
  const triggerMessage: ChatMessage = {
    id: "trigger-1",
    role: "user",
    content: "Short trigger.",
    createdAt: NOW,
    status: "done",
    metadata: { threadId: "trigger-1" }
  };
  conversationWithRepo.messages.push(triggerMessage);
  conversationNoRepo.messages.push(triggerMessage);
  const service = testService({ canRequestPermissions: true }).service as any;
  const session = chatSession(participant);
  const permGranted = normalizeChatAgentPermissions(defaultChatAgentPermissions());
  const permBlocked = normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), repoRead: false });

  const build = (
    conversation: Conversation,
    permissions: ReturnType<typeof normalizeChatAgentPermissions>,
    includeRoleInstructions: boolean
  ) => chatParts(service).turnPrompt.buildPromptParts(conversation, participant, session, triggerMessage, "/workspace", false, {
    includeRoleInstructions,
    agentMode: "default",
    permissions
  }) as { prompt: string; sections: { staticEnvelope: number; accessNote: number; promptContext: number; trigger: number; mentions: number; total: number } };

  for (const [label, parts] of [
    ["repo+repoRead", build(conversationWithRepo, permGranted, false)],
    ["repo+no-repoRead", build(conversationWithRepo, permBlocked, false)],
    ["no-repo", build(conversationNoRepo, permGranted, false)]
  ] as const) {
    assert.equal(parts.prompt, "Short trigger.", `${label}: exactly what User typed`);
    assert.equal(parts.sections.total, "Short trigger.".length, label);
    assert.equal(parts.sections.staticEnvelope, 0, label);
  }

  // A session told its instructions again (a role change, a session made
  // before they moved into the CLI's instructions): once, whole, then her text.
  const fullRepoRead = build(conversationWithRepo, permGranted, true);
  const fullNoRepoRead = build(conversationWithRepo, permBlocked, true);
  for (const parts of [fullRepoRead, fullNoRepoRead]) {
    assert.ok(parts.prompt.endsWith("\n\nShort trigger."));
    // 14,500: the nonce blocks are explained once (beta.4 review); 15,000
    // with the standing rule for urgent alerts (the User, 2026-11-27).
    assert.ok(parts.sections.staticEnvelope < 15000, `staticEnvelope too large: ${parts.sections.staticEnvelope}`);
  }
  assert.match(fullRepoRead.prompt, /Repository: \/repo \(repoRead allowed\)/);
  assert.match(fullNoRepoRead.prompt, /Repository: \/repo \(repoRead blocked\)/);
  assert.match(fullNoRepoRead.prompt, /repoRead.*app_permissions_request_change/);
});

test("the session's instructions say once who acts on a message naming several members, and how to write a handle", () => {
  const drew = chatParticipant({}, { id: "participant-drew", handle: "drew" });
  const taylor = chatParticipant({}, { id: "participant-taylor", handle: "taylor" });
  const conversation = chatConversation([drew, taylor], "/repo");
  const triggerMessage = userMessage("trigger-1", "@drew @taylor what do you both think?");
  conversation.messages.push(triggerMessage);
  const service = testService({ canRequestPermissions: true }).service as any;
  const access = { agentMode: "default", permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions()) };
  const prompt = chatParts(service).turnPrompt.buildPrompt(conversation, drew, chatSession(drew), triggerMessage, "/workspace", false, {
    includeRoleInstructions: false,
    ...access
  }) as string;
  assert.equal(prompt, "@drew @taylor what do you both think?", "the message as typed, nothing around it");

  const instructions = chatParts(service).memberSessions.sessionInstructions(conversation, drew, chatSession(drew), access, "/workspace") as string;
  assert.match(instructions, /When one message mentions several members, act on it only if you are its direct addressee or it is a request addressed to you; otherwise reply only "Noted"\./);
  assert.match(instructions, /Writing another participant's handle:/);
  assert.match(instructions, /is a request for that participant to run, not a reference to them/);
  assert.match(instructions, /use their plain name or wrap the handle in backticks/);
  assert.match(instructions, /Your access now/);
  assert.match(instructions, /Repository: \/repo \(repoRead allowed\)/);
});

test("a message's files and selected skills follow its text, one short line each", () => {
  const drew = chatParticipant({}, { id: "participant-drew", handle: "drew" });
  const taylor = chatParticipant({}, { id: "participant-taylor", handle: "taylor" });
  const conversation = chatConversation([drew, taylor], "/repo");
  const triggerMessage = userMessage("trigger-1", "@drew inspect @src/foo.ts with /qa.");
  triggerMessage.metadata = {
    ...triggerMessage.metadata,
    repoFileMentions: [{ path: "src/foo.ts" }],
    skillMentions: [skillMention()]
  };
  conversation.messages.push(triggerMessage);
  const service = testService({ canRequestPermissions: true }).service as any;
  const prompt = chatParts(service).turnPrompt.buildPrompt(conversation, drew, chatSession(drew), triggerMessage, "/workspace", false, {
    includeRoleInstructions: false,
    agentMode: "default",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
  }) as string;

  assert.ok(prompt.startsWith("@drew inspect @src/foo.ts with /qa.\n\n"));
  assert.match(prompt, /^Selected skill: .+\(skill name: /m);
  assert.match(prompt, /Referenced repository files/);
  assert.doesNotMatch(prompt, /mandatory workflows|Final status for a selected-skill turn/, "how a skill runs is in the instructions");
});

test("sendMessage clears running and emits terminal error when participant run fails", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], "/repo");
  const { service, storage } = testService({ conversations: [conversation] });
  const progress: Array<{ phase: string; message: string }> = [];
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tmpdir();
  chatParts(service).turnQueue.runParticipantTurnSerialized = async () => {
    throw new Error("participant exploded");
  };

  // Fire-and-track: the send resolves after ingest; the participant batch failure is surfaced
  // through progress and the conversation snapshot, not by rejecting the send call.
  const result = await service.sendMessage(
    { conversationId: conversation.id, runId: "run-failure", content: "@drew implement" },
    undefined,
    (item) => progress.push({ phase: item.phase, message: item.message })
  );
  assert.ok(result.conversation);

  await waitFor(() => progress.some((item) => item.phase === "error" && item.message === "participant exploded"));

  const saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(progress.some((item) => item.phase === "error" && item.message === "participant exploded"), true);
});

test("run-scoped approval cleanup denies approval and interrupts linked request item", () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  const requestMessage = participantRequestMessageWithItems(requester, [
    participantRequestItem(target, "pending_approval")
  ]);
  conversation.messages.push(requestMessage);
  conversation.metadata = {
    ...conversation.metadata,
    pendingAppToolApprovals: [participantRequestApproval(requester, target, requestMessage, "approval-run")]
  };
  const { service } = testService({ conversations: [conversation] });

  const changed = chatParts(service).approvalDecisions.markPendingAppToolApprovalsForRunTerminal(
    conversation,
    "approval-run",
    "Run stopped."
  );

  assert.equal(changed, true);
  assert.equal((conversation.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0]?.status, "denied");
  assert.equal(conversation.messages[0]?.metadata?.participantRequest?.status, "interrupted");
  assert.equal(conversation.messages[0]?.metadata?.participantRequest?.items[0]?.status, "interrupted");
});

function skillMention(): ChatSkillMention {
  return {
    skillId: "skill-1",
    displayName: "/qa",
    frontmatterName: "qa",
    contentHash: "hash-a",
    capabilityState: "invocable",
    variants: [{
      providerKind: "codex-cli",
      scope: "personal",
      rootKind: "personal",
      sourceKey: "source",
      frontmatterName: "qa",
      contentHash: "hash-a",
      capabilityState: "invocable"
    }]
  };
}

function chatSession(participant: ChatParticipant): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId: "",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ["permissions.request"],
    updatedAt: NOW
  };
}
