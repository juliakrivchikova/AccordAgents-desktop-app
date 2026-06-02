import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatService } from "./chat";
import { StorageService } from "./storage";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { INTERRUPTED_RUN_WARNING } from "../../shared/warnings";
import type {
  ChatMessage,
  ChatImageAttachment,
  ChatParticipant,
  ChatParticipantSession,
  ChatRoleConfig,
  Conversation
} from "../../shared/types";

const NOW = "2026-05-19T12:00:00.000Z";
const ONE_BY_ONE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const ROLE: ChatRoleConfig = {
  id: "engineer",
  label: "Engineer",
  instructions: "Answer directly.",
  version: 1,
  appToolCapabilities: [],
  updatedAt: NOW
};

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

    const mentions = await service.validateRepoFileMentions(conversation, [
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

    const mentions = await service.validateRepoFileMentions(
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

  const blockedPrompt = service.buildPrompt(conversation, participant, session, triggerMessage, "/workspace", false, {
    includeRoleInstructions: false,
    agentMode: "default",
    permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), repoRead: false })
  });
  const allowedPrompt = service.buildPrompt(conversation, participant, session, triggerMessage, "/workspace", false, {
    includeRoleInstructions: false,
    agentMode: "default",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
  });

  assert.match(blockedPrompt, /Referenced repository files/);
  assert.match(blockedPrompt, /src\/chat\.ts/);
  assert.match(blockedPrompt, /repoRead is not granted/);
  assert.match(allowedPrompt, /You may read these\./);
});

test("buildPromptParts section sizes stay under baseline caps across envelope branches", () => {
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
  ) => service.buildPromptParts(conversation, participant, session, triggerMessage, "/workspace", false, {
    includeRoleInstructions,
    agentMode: "default",
    permissions
  }) as { prompt: string; sections: { staticEnvelope: number; dynamicHeader: number; trigger: number; mentions: number; currentRequest: number; total: number } };

  const slimRepoRead = build(conversationWithRepo, permGranted, false);
  const slimNoRepoRead = build(conversationWithRepo, permBlocked, false);
  const slimNoRepo = build(conversationNoRepo, permGranted, false);
  const fullRepoRead = build(conversationWithRepo, permGranted, true);
  const fullNoRepoRead = build(conversationWithRepo, permBlocked, true);

  // Per-section caps for slim envelope (resumed CLI session, no refresh).
  for (const [label, parts] of [
    ["slim repo+repoRead", slimRepoRead],
    ["slim repo+no-repoRead", slimNoRepoRead],
    ["slim no-repo", slimNoRepo]
  ] as const) {
    assert.equal(parts.sections.staticEnvelope, 0, `${label}: staticEnvelope should be empty on slim`);
    assert.ok(parts.sections.dynamicHeader < 1000, `${label}: dynamicHeader too large: ${parts.sections.dynamicHeader}`);
    assert.ok(parts.sections.trigger < 350, `${label}: trigger too large: ${parts.sections.trigger}`);
    assert.equal(parts.sections.mentions, 0, `${label}: mentions should be empty when no #file tokens`);
    assert.ok(parts.sections.currentRequest < 130, `${label}: currentRequest too large: ${parts.sections.currentRequest}`);
  }

  // Per-section caps for full envelope.
  for (const [label, parts] of [
    ["full repo+repoRead", fullRepoRead],
    ["full repo+no-repoRead", fullNoRepoRead]
  ] as const) {
    assert.equal(parts.sections.dynamicHeader, 0, `${label}: dynamicHeader is folded into staticEnvelope when role instructions are included`);
    assert.ok(parts.sections.staticEnvelope < 7200, `${label}: staticEnvelope too large: ${parts.sections.staticEnvelope}`);
    assert.ok(parts.sections.trigger < 350, `${label}: trigger too large: ${parts.sections.trigger}`);
    assert.ok(parts.sections.currentRequest < 130, `${label}: currentRequest too large: ${parts.sections.currentRequest}`);
  }

  // Total caps (carried over from v2; tighten deliberately if intentional growth happens).
  assert.ok(slimRepoRead.sections.total < 1100, `slim repo+repoRead total too large: ${slimRepoRead.sections.total}`);
  assert.ok(slimNoRepoRead.sections.total < 1500, `slim repo+no-repoRead total too large: ${slimNoRepoRead.sections.total}`);
  assert.ok(slimNoRepo.sections.total < 1500, `slim no-repo total too large: ${slimNoRepo.sections.total}`);
  assert.ok(fullRepoRead.sections.total < 7500, `full repo+repoRead total too large: ${fullRepoRead.sections.total}`);
  assert.ok(fullNoRepoRead.sections.total < 8000, `full repo+no-repoRead total too large: ${fullNoRepoRead.sections.total}`);
  assert.ok(slimRepoRead.sections.total * 4 < fullRepoRead.sections.total, "slim envelope should be at least 4x smaller than full");

  // Repo-read state appears once: on the Repository line (and the escalation line when blocked).
  assert.equal(/repo read /.test(slimRepoRead.prompt), false, "slim repo+repoRead should not say 'repo read' on the Permissions line");
  assert.match(slimRepoRead.prompt, /Repository: \/repo \(repoRead allowed\)/);
  assert.match(slimNoRepoRead.prompt, /Repository: \/repo \(repoRead blocked\)/);
  assert.match(slimNoRepoRead.prompt, /repoRead.*app_permissions_request_change/);
});

test("sendMessage clears running and emits terminal error when participant run fails", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], "/repo");
  const { service, storage } = testService({ conversations: [conversation] });
  const progress: Array<{ phase: string; message: string }> = [];
  (service as any).runParticipantBatch = async () => {
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

test("sendMessage persists image-only messages as metadata plus app-owned files", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-images-"));
  const participant = chatParticipant();
  const conversation = chatConversation([participant], "/repo");
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  serviceAny.attachmentPath = (_conversationId: string, storageKey: string) => path.join(tempRoot, storageKey);

  try {
    const result = await service.sendMessage({
      conversationId: conversation.id,
      runId: "image-run",
      content: "",
      imageAttachments: [{
        filename: "screenshot.png",
        mimeType: "image/png",
        dataBase64: ONE_BY_ONE_PNG_BASE64
      }]
    });

    const saved = await storage.getConversation(conversation.id);
    const userMessage = saved?.messages.find((message) => message.role === "user");
    const attachment = userMessage?.metadata?.imageAttachments?.[0];

    assert.equal(result.conversation.metadata.running, false);
    assert.equal(userMessage?.content, "");
    assert.equal(attachment?.filename, "screenshot.png");
    assert.equal(attachment?.mimeType, "image/png");
    assert.equal(attachment?.width, 1);
    assert.equal(attachment?.height, 1);
    assert.equal(attachment?.storageKey.startsWith("attachments/"), true);
    await stat(path.join(tempRoot, attachment?.storageKey ?? ""));

    const readBack = await service.readChatAttachment({
      conversationId: conversation.id,
      attachmentId: attachment?.id ?? ""
    });
    assert.equal(readBack.dataBase64, ONE_BY_ONE_PNG_BASE64);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("MCP attachment reads are bounded by the issued turn snapshot", async () => {
  const participant = chatParticipant();
  const visibleAttachment = chatImageAttachment("visible-image");
  const futureAttachment = chatImageAttachment("future-image");
  const conversation = chatConversation([participant], "/repo");
  conversation.messages.push(userMessage("visible-message", "Visible"));
  conversation.messages[0].metadata = {
    ...conversation.messages[0].metadata,
    imageAttachments: [visibleAttachment]
  };
  conversation.messages.push(userMessage("future-message", "Future"));
  conversation.messages[1].metadata = {
    ...conversation.messages[1].metadata,
    imageAttachments: [futureAttachment]
  };
  const { service } = testService({ conversations: [conversation] });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: [],
    snapshotMaxSequence: 0
  };

  const listed = await service.listChatAttachmentsForTool(actor as never, {});

  assert.deepEqual(
    ((listed.attachments as Array<{ attachment: { id: string } }>)).map((item) => item.attachment.id),
    [visibleAttachment.id]
  );
  await assert.rejects(
    () => service.readChatAttachmentForTool(actor as never, { attachmentId: futureAttachment.id }),
    /AttachmentReadDenied/
  );
});

test("respondToMentions clears running and emits terminal error when participant run fails", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({}, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  const sourceMessage = participantMessage(requester, "source-message", "@taylor please review");
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingMentions: [{
      targetParticipantId: target.id,
      targetHandle: target.handle,
      status: "pending"
    }]
  };
  conversation.messages.push(sourceMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const progress: Array<{ phase: string; message: string }> = [];
  (service as any).runParticipantBatch = async () => {
    throw new Error("mention exploded");
  };

  await assert.rejects(
    () => service.respondToMentions(
      {
        conversationId: conversation.id,
        runId: "mention-failure",
        sourceMessageId: sourceMessage.id,
        targetParticipantIds: [target.id],
        approve: true
      },
      undefined,
      (item) => progress.push({ phase: item.phase, message: item.message })
    ),
    /mention exploded/
  );

  const saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(progress.some((item) => item.phase === "error" && item.message === "mention exploded"), true);
});

test("respondToChoice clears running and emits terminal error when requester run fails", async () => {
  const requester = chatParticipant();
  const conversation = chatConversation([requester], "/repo");
  const sourceMessage = participantMessage(requester, "choice-message", "Choose an option.");
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Decision",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      status: "pending"
    }
  };
  conversation.messages.push(sourceMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const progress: Array<{ phase: string; message: string }> = [];
  (service as any).runParticipantTurnSerialized = async () => {
    throw new Error("choice exploded");
  };

  await assert.rejects(
    () => service.respondToChoice(
      {
        conversationId: conversation.id,
        runId: "choice-failure",
        sourceMessageId: sourceMessage.id,
        choiceId: "choice-1",
        selectedOptionId: "yes"
      },
      undefined,
      (item) => progress.push({ phase: item.phase, message: item.message })
    ),
    /choice exploded/
  );

  const saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(progress.some((item) => item.phase === "error" && item.message === "choice exploded"), true);
});

test("hydrateContextUsage clears inactive stale running state once", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId: "stale-run",
    warnings: [INTERRUPTED_RUN_WARNING, INTERRUPTED_RUN_WARNING]
  };
  const { service, storage } = testService({ conversations: [conversation] });

  const hydrated = await service.hydrateContextUsage(cloneConversation(conversation));
  const saved = await storage.getConversation(conversation.id);

  assert.equal(hydrated.metadata.running, false);
  assert.equal(hydrated.metadata.runId, undefined);
  assert.deepEqual(hydrated.metadata.warnings, [INTERRUPTED_RUN_WARNING]);
  assert.equal(saved?.metadata.running, false);
  assert.deepEqual(saved?.metadata.warnings, [INTERRUPTED_RUN_WARNING]);
});

test("stale recovery does not clear running while background runner is active", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;

  await serviceAny.beginChatRun(conversation, "origin-run");
  serviceAny.incrementBackgroundRunner(conversation.id);
  await serviceAny.endChatRun(conversation, "origin-run");

  let saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, true);
  assert.equal(saved?.metadata.runId, "origin-run");

  const recoveredCandidate = cloneConversation(saved as Conversation);
  assert.equal(serviceAny.recoverStaleChatRun(recoveredCandidate), false);
  assert.equal(recoveredCandidate.metadata.running, true);

  serviceAny.decrementBackgroundRunner(conversation.id);
  await serviceAny.tryClearRunningIfIdle(conversation.id);

  saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
});

test("tryClearRunningIfIdle waits for the chat run queue before clearing running", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = { ...conversation.metadata, running: true, runId: "origin-run" };
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let releaseRunQueue!: () => void;
  serviceAny.runQueues.set(conversation.id, new Promise<void>((resolve) => {
    releaseRunQueue = resolve;
  }));

  const clearing = serviceAny.tryClearRunningIfIdle(conversation.id);
  await Promise.resolve();

  let saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, true);
  assert.equal(saved?.metadata.runId, "origin-run");

  releaseRunQueue();
  await clearing;

  saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
});

test("endChatRun does not clear a newer run id", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = { ...conversation.metadata, running: true, runId: "newer-run" };
  const { service } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  serviceAny.activeRunIds.add("older-run");

  await serviceAny.endChatRun(conversation, "older-run");

  assert.equal(conversation.metadata.running, true);
  assert.equal(conversation.metadata.runId, "newer-run");
  assert.equal(serviceAny.activeRunIds.has("older-run"), false);
});

test("autoResumeParticipantRequest completes and clears running state", async () => {
  const requester = chatParticipant();
  const conversation = chatConversation([requester], "/repo");
  const requestMessage = participantRequestMessage(requester);
  conversation.messages.push(requestMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  serviceAny.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  serviceAny.runParticipantTurnSerialized = async () => [
    participantMessage(requester, "resume-reply", "Final required fixes are listed.")
  ];

  await serviceAny.autoResumeParticipantRequest(conversation.id, requestMessage.id);
  const saved = await storage.getConversation(conversation.id);
  const savedRequest = saved?.messages.find((message) => message.id === requestMessage.id);

  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(savedRequest?.metadata?.participantRequest?.status, "completed");
  assert.equal(savedRequest?.metadata?.participantRequest?.autoResumeMessageId, "resume-reply");
});

test("clearInterruptedRuns removes stale run id during startup cleanup", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId: "stale-run"
  };
  let saved: Conversation | undefined;
  const storage = Object.create(StorageService.prototype) as any;
  storage.queryJson = async () => [{ payloadJson: JSON.stringify(conversation) }];
  storage.saveConversation = async (next: Conversation) => {
    saved = cloneConversation(next);
  };

  await (storage as any).clearInterruptedRuns();

  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.deepEqual(saved?.metadata.warnings, [INTERRUPTED_RUN_WARNING]);
});

test("requestParticipantsFromTool does not wait on top-level run queue", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push(userMessage("trigger-message", "@drew ask Taylor"));
  const { service } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let releaseRunQueue!: () => void;
  serviceAny.runQueues.set(conversation.id, new Promise<void>((resolve) => {
    releaseRunQueue = resolve;
  }));

  try {
    const result = await withTimeout(
      service.requestParticipantsFromTool({
        conversationId: conversation.id,
        participantId: requester.id,
        roleConfigId: requester.roleConfigId,
        roleConfigVersion: ROLE.version,
        capabilities: [],
        triggerMessageId: "trigger-message",
        runId: "active-run"
      } as never, {
        requests: [{ target: "taylor", prompt: "Review this.", reason: "Need another opinion." }],
        timeoutMs: 50,
        resumeRequester: true
      }),
      250
    );
    assert.equal(result.status, "pending_approval");
  } finally {
    releaseRunQueue();
    serviceAny.runQueues.delete(conversation.id);
  }
});

function testService(options: { canRequestPermissions?: boolean; conversations?: Conversation[] } = {}): {
  service: ChatService;
  storage: {
    getConversation(id: string): Promise<Conversation | undefined>;
    saveConversation(conversation: Conversation): Promise<void>;
  };
} {
  const conversations = new Map((options.conversations ?? []).map((conversation) => [conversation.id, cloneConversation(conversation)]));
  const storage = {
    async getConversation(id: string): Promise<Conversation | undefined> {
      const conversation = conversations.get(id);
      return conversation ? cloneConversation(conversation) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      conversations.set(conversation.id, cloneConversation(conversation));
    }
  };
  const settings = {
    async getPublicSettings(): Promise<{ chatRoleConfigs: ChatRoleConfig[] }> {
      return { chatRoleConfigs: [ROLE] };
    }
  };
  const cliRunner = {
    async detectAgents(): Promise<[]> {
      return [];
    }
  };
  const debugLogs = {
    async write(): Promise<void> {
      return undefined;
    }
  };
  const appMcp = options.canRequestPermissions
    ? {
        issueToken: () => ({ url: "http://127.0.0.1:1/mcp", token: "token" })
      }
    : undefined;
  return {
    service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never, appMcp as never),
    storage
  };
}

function chatParticipant(
  permissionPatch: Partial<ReturnType<typeof defaultChatAgentPermissions>> = {},
  participantPatch: Partial<ChatParticipant> = {}
): ChatParticipant {
  return {
    id: "participant-1",
    handle: "drew",
    roleConfigId: ROLE.id,
    kind: "codex-cli",
    agentMode: "default",
    permissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      ...permissionPatch
    }),
    ...participantPatch
  };
}

function chatConversation(participants: ChatParticipant[], repoPath: string): Conversation {
  return {
    id: "conversation-1",
    title: "Test chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath,
    messages: [],
    findings: [],
    metadata: {
      participants,
      participantSessions: []
    }
  };
}

function userMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: NOW,
    status: "done",
    metadata: { threadId: id }
  };
}

function chatImageAttachment(id: string): ChatImageAttachment {
  return {
    id,
    filename: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 68,
    width: 1,
    height: 1,
    storageKey: `attachments/${id}.png`,
    createdAt: NOW
  };
}

function participantMessage(participant: ChatParticipant, id: string, content: string): ChatMessage {
  return {
    id,
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content,
    createdAt: NOW,
    status: "done",
    metadata: { threadId: id }
  };
}

function participantRequestMessage(requester: ChatParticipant): ChatMessage {
  return {
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    participantLabel: `@${requester.handle}`,
    content: "@taylor Review this.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "request-message",
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "mcp",
        resumeRequester: true,
        status: "answered",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: "trigger-message",
        items: [{
          targetParticipantId: "participant-2",
          targetHandle: "taylor",
          prompt: "Review this.",
          status: "answered",
          replyMessageId: "target-reply",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for operation.")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
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
