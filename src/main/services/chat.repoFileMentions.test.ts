import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatService } from "./chat";
import { StorageService } from "./storage";
import { defaultChatAgentPermissions, effectiveChatAgentPermissionsForProvider, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { normalizeInferredParticipantRequestThreads } from "../../shared/chatParticipantRequestThreads";
import { INTERRUPTED_RUN_WARNING } from "../../shared/warnings";
import type {
  ChatAppToolApproval,
  ChatAppToolApprovalPolicy,
  ChatMessage,
  ChatImageAttachment,
  ChatParticipant,
  ChatParticipantRequestStatus,
  ChatParticipantSession,
  ChatRoleConfig,
  ChatSkillMention,
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
    // Bumped from 7450 when app_chat_send_message was added to the static chat MCP tool
    // instructions, then again when its guidance was expanded to prevent misuse (use only
    // for mid-turn visibility). Intentional growth; keep tightening any further bloat.
    assert.ok(parts.sections.staticEnvelope < 7750, `${label}: staticEnvelope too large: ${parts.sections.staticEnvelope}`);
    assert.ok(parts.sections.trigger < 350, `${label}: trigger too large: ${parts.sections.trigger}`);
    assert.ok(parts.sections.currentRequest < 130, `${label}: currentRequest too large: ${parts.sections.currentRequest}`);
  }

  // Total caps (carried over from v2; tighten deliberately if intentional growth happens).
  assert.ok(slimRepoRead.sections.total < 1100, `slim repo+repoRead total too large: ${slimRepoRead.sections.total}`);
  assert.ok(slimNoRepoRead.sections.total < 1500, `slim repo+no-repoRead total too large: ${slimNoRepoRead.sections.total}`);
  assert.ok(slimNoRepo.sections.total < 1500, `slim no-repo total too large: ${slimNoRepo.sections.total}`);
  assert.ok(fullRepoRead.sections.total < 7850, `full repo+repoRead total too large: ${fullRepoRead.sections.total}`);
  assert.ok(fullNoRepoRead.sections.total < 8000, `full repo+no-repoRead total too large: ${fullNoRepoRead.sections.total}`);
  assert.ok(slimRepoRead.sections.total * 4 < fullRepoRead.sections.total, "slim envelope should be at least 4x smaller than full");

  // Repo-read state appears once: on the Repository line (and the escalation line when blocked).
  assert.equal(/repo read /.test(slimRepoRead.prompt), false, "slim repo+repoRead should not say 'repo read' on the Permissions line");
  assert.match(slimRepoRead.prompt, /Repository: \/repo \(repoRead allowed\)/);
  assert.match(slimNoRepoRead.prompt, /Repository: \/repo \(repoRead blocked\)/);
  assert.match(slimNoRepoRead.prompt, /repoRead.*app_permissions_request_change/);
});

test("buildPrompt adds addressee guidance for multiple resolved participant mentions", () => {
  const drew = chatParticipant({}, { id: "participant-drew", handle: "drew" });
  const taylor = chatParticipant({}, { id: "participant-taylor", handle: "taylor" });
  const conversation = chatConversation([drew, taylor], "/repo");
  const triggerMessage = userMessage("trigger-1", "@drew @taylor what do you both think?");
  conversation.messages.push(triggerMessage);
  const service = testService({ canRequestPermissions: true }).service as any;
  const prompt = service.buildPrompt(conversation, drew, chatSession(drew), triggerMessage, "/workspace", false, {
    includeRoleInstructions: false,
    agentMode: "default",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
  }) as string;

  assert.match(prompt, /First determine who the message is addressed to\./);
  assert.match(prompt, /my handle is the primary\/direct addressee/);
  assert.match(prompt, /app context says this is a participant request addressed to me/);
  assert.match(prompt, /Reply only "Noted" if/);
  assert.match(prompt, /even if my handle appears inside the requested action/);
});

test("buildPrompt addressee guidance ignores non-participant mentions and selected skills", () => {
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
  const prompt = service.buildPrompt(conversation, drew, chatSession(drew), triggerMessage, "/workspace", false, {
    includeRoleInstructions: false,
    agentMode: "default",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
  }) as string;

  assert.doesNotMatch(prompt, /First determine who the message is addressed to\./);
  assert.match(prompt, /Referenced repository files/);
  assert.match(prompt, /Selected skills for this turn/);
});

test("sendMessage clears running and emits terminal error when participant run fails", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], "/repo");
  const { service, storage } = testService({ conversations: [conversation] });
  const progress: Array<{ phase: string; message: string }> = [];
  (service as any).ensureHistoryFiles = async () => tmpdir();
  (service as any).runParticipantTurnSerialized = async () => {
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

    assert.notEqual(result.conversation.metadata.running, true);
    assert.notEqual(saved?.metadata.running, true);
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

test("MCP attachment export writes byte-identical files with run-scoped effective write permission", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-attachment-export-"));
  const repoPath = path.join(tempRoot, "repo");
  const storageRoot = path.join(tempRoot, "storage");
  const participant = chatParticipant({ workspaceWrite: false }, { agentMode: "auto" });
  const attachment = chatImageAttachment("export-image");
  const conversation = chatConversation([participant], repoPath);
  conversation.messages.push(userMessage("message-1", "Image"));
  conversation.messages[0].metadata = {
    ...conversation.messages[0].metadata,
    imageAttachments: [attachment]
  };
  const { service } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  serviceAny.attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  await mkdir(path.join(repoPath, "exports"), { recursive: true });
  await mkdir(path.dirname(path.join(storageRoot, attachment.storageKey)), { recursive: true });
  const bytes = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
  await writeFile(path.join(storageRoot, attachment.storageKey), bytes);
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: [],
    snapshotMaxSequence: 0,
    runPermissions: effectiveChatAgentPermissionsForProvider(participant.kind, "auto", normalizeChatAgentPermissions(participant.permissions))
  };

  try {
    const result = await service.exportChatAttachmentForTool(actor as never, {
      attachmentId: attachment.id,
      targetPath: "exports/copied.png"
    });
    assert.equal(result.targetPath, "exports/copied.png");
    assert.equal(result.sizeBytes, bytes.length);
    assert.deepEqual(await readFile(path.join(repoPath, "exports/copied.png")), bytes);

    await assert.rejects(
      () => service.exportChatAttachmentForTool(actor as never, { attachmentId: attachment.id, targetPath: "exports/copied.png" }),
      /already exists/
    );

    const replacement = Buffer.from("replacement");
    await writeFile(path.join(storageRoot, attachment.storageKey), replacement);
    const overwriteResult = await service.exportChatAttachmentForTool(actor as never, {
      attachmentId: attachment.id,
      targetPath: "exports/copied.png",
      overwrite: true
    });
    assert.equal(overwriteResult.overwrite, true);
    assert.deepEqual(await readFile(path.join(repoPath, "exports/copied.png")), replacement);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("MCP attachment export denies missing write permission, no repo, and invisible attachments", async () => {
  const participant = chatParticipant({ workspaceWrite: false });
  const visibleAttachment = chatImageAttachment("visible-export");
  const futureAttachment = chatImageAttachment("future-export");
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
  const noRepoConversation = chatConversation([participant], "");
  noRepoConversation.id = "conversation-no-repo";
  noRepoConversation.messages.push(userMessage("no-repo-message", "Image"));
  noRepoConversation.messages[0].metadata = {
    ...noRepoConversation.messages[0].metadata,
    imageAttachments: [visibleAttachment]
  };
  const { service } = testService({ conversations: [conversation, noRepoConversation] });
  const deniedActor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: [],
    snapshotMaxSequence: 0,
    runPermissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), workspaceWrite: false })
  };
  const writeActor = {
    ...deniedActor,
    runPermissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), workspaceWrite: true })
  };

  await assert.rejects(
    () => service.exportChatAttachmentForTool(deniedActor as never, { attachmentId: visibleAttachment.id, targetPath: "exports/visible-export.png" }),
    /workspaceWrite is not granted/
  );
  await assert.rejects(
    () => service.exportChatAttachmentForTool(writeActor as never, { attachmentId: futureAttachment.id, targetPath: "exports/future-export.png" }),
    /not visible/
  );
  await assert.rejects(
    () => service.exportChatAttachmentForTool({ ...writeActor, conversationId: noRepoConversation.id } as never, { attachmentId: visibleAttachment.id, targetPath: "exports/visible-export.png" }),
    /no repository/
  );
});

test("MCP attachment export rejects unsafe destination paths", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-attachment-export-paths-"));
  const repoPath = path.join(tempRoot, "repo");
  const outsidePath = path.join(tempRoot, "outside");
  const storageRoot = path.join(tempRoot, "storage");
  const participant = chatParticipant({ workspaceWrite: true });
  const attachment = chatImageAttachment("safe-export");
  const conversation = chatConversation([participant], repoPath);
  conversation.messages.push(userMessage("message-1", "Image"));
  conversation.messages[0].metadata = {
    ...conversation.messages[0].metadata,
    imageAttachments: [attachment]
  };
  const { service } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  serviceAny.attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  await mkdir(path.join(repoPath, "exports"), { recursive: true });
  await mkdir(outsidePath, { recursive: true });
  await mkdir(path.dirname(path.join(storageRoot, attachment.storageKey)), { recursive: true });
  await writeFile(path.join(storageRoot, attachment.storageKey), Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
  await mkdir(path.join(repoPath, "exports/dir.png"));
  await writeFile(path.join(outsidePath, "outside.png"), "outside", "utf8");
  await symlink(path.join(outsidePath, "outside.png"), path.join(repoPath, "exports/link.png"));
  await symlink(outsidePath, path.join(repoPath, "exports/outside-dir"));
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: [],
    snapshotMaxSequence: 0,
    runPermissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), workspaceWrite: true })
  };

  try {
    for (const targetPath of ["/tmp/absolute.png", "../escape.png", "missing-parent/file.png"]) {
      await assert.rejects(
        () => service.exportChatAttachmentForTool(actor as never, { attachmentId: attachment.id, targetPath }),
        /AttachmentExportDenied/
      );
    }
    await assert.rejects(
      () => service.exportChatAttachmentForTool(actor as never, { attachmentId: attachment.id, targetPath: "exports/dir.png" }),
      /directory/
    );
    await assert.rejects(
      () => service.exportChatAttachmentForTool(actor as never, { attachmentId: attachment.id, targetPath: "exports/link.png", overwrite: true }),
      /symlink/
    );
    await assert.rejects(
      () => service.exportChatAttachmentForTool(actor as never, { attachmentId: attachment.id, targetPath: "exports/outside-dir/copied.png" }),
      /symlink outside/
    );
    await assert.rejects(
      () => service.exportChatAttachmentForTool(actor as never, { attachmentId: attachment.id, targetPath: "exports/wrong.jpg" }),
      /extension/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("MCP attachment export reports missing app-owned bytes", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-attachment-export-missing-"));
  const repoPath = path.join(tempRoot, "repo");
  const storageRoot = path.join(tempRoot, "storage");
  const participant = chatParticipant({ workspaceWrite: true });
  const attachment = chatImageAttachment("missing-export");
  const conversation = chatConversation([participant], repoPath);
  conversation.messages.push(userMessage("message-1", "Image"));
  conversation.messages[0].metadata = {
    ...conversation.messages[0].metadata,
    imageAttachments: [attachment]
  };
  const { service } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  serviceAny.attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  await mkdir(path.join(repoPath, "exports"), { recursive: true });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: [],
    snapshotMaxSequence: 0,
    runPermissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), workspaceWrite: true })
  };

  try {
    await assert.rejects(
      () => service.exportChatAttachmentForTool(actor as never, { attachmentId: attachment.id, targetPath: "exports/missing-export.png" }),
      /AttachmentMissing/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("respondToMentions returns after ingest and emits terminal error when participant run fails", async () => {
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

  await service.respondToMentions(
    {
      conversationId: conversation.id,
      runId: "mention-failure",
      sourceMessageId: sourceMessage.id,
      targetParticipantIds: [target.id],
      approve: true
    },
    undefined,
    (item) => progress.push({ phase: item.phase, message: item.message })
  );
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.metadata.running === false &&
      progress.some((item) => item.phase === "error" && item.message === "mention exploded");
  });

  const saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(progress.some((item) => item.phase === "error" && item.message === "mention exploded"), true);
});

test("respondToChoice returns after ingest and emits terminal error when requester run fails", async () => {
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

  await service.respondToChoice(
    {
      conversationId: conversation.id,
      runId: "choice-failure",
      sourceMessageId: sourceMessage.id,
      choiceId: "choice-1",
      selectedOptionId: "yes"
    },
    undefined,
    (item) => progress.push({ phase: item.phase, message: item.message })
  );
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.metadata.running === false &&
      progress.some((item) => item.phase === "error" && item.message === "choice exploded");
  });

  const saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(progress.some((item) => item.phase === "error" && item.message === "choice exploded"), true);
});

test("respondToChoice releases chat run queue while requester turn continues", async () => {
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
  const serviceAny = service as any;
  let runStarted = false;
  let choiceTriggerMessage: ChatMessage | undefined;
  let releaseRun!: () => void;
  const runCanFinish = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  serviceAny.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  serviceAny.runParticipantTurnSerialized = async (
    _conversation: Conversation,
    _requester: ChatParticipant,
    triggerMessage: ChatMessage
  ) => {
    runStarted = true;
    choiceTriggerMessage = triggerMessage;
    await runCanFinish;
    return [participantMessage(requester, "choice-reply", "Choice handled.")];
  };

  await withTimeout(
    service.respondToChoice({
      conversationId: conversation.id,
      runId: "choice-run",
      sourceMessageId: sourceMessage.id,
      choiceId: "choice-1",
      selectedOptionId: "yes"
    }),
    250
  );
  await waitFor(() => runStarted);

  assert.equal(serviceAny.runQueues.has(conversation.id), false);
  const savedDuringRun = await storage.getConversation(conversation.id);
  assert.equal(savedDuringRun?.metadata.running, true);
  const savedSelectionMessage = savedDuringRun?.messages.find((message) =>
    message.role === "user" &&
    message.metadata?.sourceMessageId === sourceMessage.id
  );
  assert.ok(savedSelectionMessage);
  assert.equal(savedSelectionMessage.metadata?.hiddenFromTimeline, true);
  assert.equal(savedSelectionMessage.metadata?.threadId, sourceMessage.metadata?.threadId);
  assert.equal(savedSelectionMessage.metadata?.parentMessageId, sourceMessage.id);
  assert.equal(savedSelectionMessage.metadata?.chatThreadRootId, sourceMessage.id);
  assert.match(savedSelectionMessage.content, /^Choice selected for @drew\./);
  assert.match(savedSelectionMessage.content, /Choice: Decision/);
  assert.match(savedSelectionMessage.content, /Question: Proceed\?/);
  assert.match(savedSelectionMessage.content, /Selected option: Yes/);
  assert.ok(choiceTriggerMessage);
  assert.equal(choiceTriggerMessage.id, savedSelectionMessage.id);
  assert.equal(choiceTriggerMessage.content, savedSelectionMessage.content);
  assert.equal(choiceTriggerMessage.metadata?.hiddenFromTimeline, true);

  releaseRun();
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.metadata.running === false &&
      saved.messages.some((message) => message.content === "Choice handled.");
  });
});

test("respondToChoice can cancel without returning control to requester", async () => {
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
      recommendedOptionId: "yes",
      status: "pending"
    }
  };
  conversation.messages.push(sourceMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let requesterRan = false;
  serviceAny.runParticipantTurnSerialized = async () => {
    requesterRan = true;
    return [participantMessage(requester, "choice-reply", "Choice handled.")];
  };

  const result = await service.respondToChoice({
    conversationId: conversation.id,
    runId: "choice-cancel",
    sourceMessageId: sourceMessage.id,
    choiceId: "choice-1",
    cancel: true
  });

  assert.equal(requesterRan, false);
  assert.notEqual(result.conversation.metadata.running, true);
  const saved = await storage.getConversation(conversation.id);
  assert.notEqual(saved?.metadata.running, true);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(saved?.messages.length, 1);
  assert.equal(saved?.messages[0]?.metadata?.pendingChoice?.status, "cancelled");
  assert.equal(saved?.messages[0]?.metadata?.pendingChoice?.selectedOptionId, undefined);
  assert.ok(saved?.messages[0]?.metadata?.pendingChoice?.cancelledAt);
});

test("respondToChoice waits for persisted ingest and rejects duplicate choice answers", async () => {
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
  const serviceAny = service as any;
  let releaseRun!: () => void;
  const runCanFinish = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  serviceAny.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  serviceAny.runParticipantTurnSerialized = async () => {
    await runCanFinish;
    return [participantMessage(requester, "choice-reply", "Choice handled.")];
  };

  const originalSave = storage.saveConversation.bind(storage);
  let releaseFirstSave!: () => void;
  let firstSaveStarted = false;
  let blockFirstSave = true;
  const firstSaveCanFinish = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  storage.saveConversation = async (savedConversation: Conversation): Promise<void> => {
    await originalSave(savedConversation);
    if (!blockFirstSave) {
      return;
    }
    blockFirstSave = false;
    firstSaveStarted = true;
    await firstSaveCanFinish;
  };

  const first = service.respondToChoice({
    conversationId: conversation.id,
    runId: "choice-run",
    sourceMessageId: sourceMessage.id,
    choiceId: "choice-1",
    selectedOptionId: "yes"
  });
  await waitFor(() => firstSaveStarted);

  let firstResolved = false;
  void first.then(() => {
    firstResolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(firstResolved, false);

  releaseFirstSave();
  await first;

  await assert.rejects(
    () => service.respondToChoice({
      conversationId: conversation.id,
      runId: "choice-run-duplicate",
      sourceMessageId: sourceMessage.id,
      choiceId: "choice-1",
      selectedOptionId: "yes"
    }),
    /Choice request has already been answered/
  );

  releaseRun();
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.metadata.running === false &&
      saved.messages.some((message) => message.content === "Choice handled.");
  });
});

test("respondToMentions waits for persisted ingest and rejects duplicate approvals", async () => {
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
  const serviceAny = service as any;
  let releaseBatch!: () => void;
  const batchCanFinish = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  serviceAny.runParticipantBatch = async () => {
    await batchCanFinish;
  };

  const originalSave = storage.saveConversation.bind(storage);
  let releaseFirstSave!: () => void;
  let firstSaveStarted = false;
  let blockFirstSave = true;
  const firstSaveCanFinish = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  storage.saveConversation = async (savedConversation: Conversation): Promise<void> => {
    await originalSave(savedConversation);
    if (!blockFirstSave) {
      return;
    }
    blockFirstSave = false;
    firstSaveStarted = true;
    await firstSaveCanFinish;
  };

  const first = service.respondToMentions({
    conversationId: conversation.id,
    runId: "mention-run",
    sourceMessageId: sourceMessage.id,
    targetParticipantIds: [target.id],
    approve: true
  });
  await waitFor(() => firstSaveStarted);

  let firstResolved = false;
  void first.then(() => {
    firstResolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(firstResolved, false);

  releaseFirstSave();
  await first;

  await assert.rejects(
    () => service.respondToMentions({
      conversationId: conversation.id,
      runId: "mention-run-duplicate",
      sourceMessageId: sourceMessage.id,
      targetParticipantIds: [target.id],
      approve: true
    }),
    /Select at least one pending mention/
  );

  releaseBatch();
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    const savedSource = saved?.messages.find((message) => message.id === sourceMessage.id);
    return saved?.metadata.running === false &&
      savedSource?.metadata?.pendingMentions?.[0]?.status === "approved";
  });
});

test("respondToMentions keeps parent run cancellable after fast return", async () => {
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
  const serviceAny = service as any;
  let batchStarted = false;
  let batchSignal: AbortSignal | undefined;
  let releaseBatch!: () => void;
  const batchCanFinish = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  serviceAny.runParticipantBatch = async (
    _conversation: Conversation,
    _participants: ChatParticipant[],
    _triggerMessage: ChatMessage,
    _runId: string,
    signal: AbortSignal | undefined
  ) => {
    batchSignal = signal;
    batchStarted = true;
    await batchCanFinish;
  };

  await service.respondToMentions({
    conversationId: conversation.id,
    runId: "mention-parent-run",
    sourceMessageId: sourceMessage.id,
    targetParticipantIds: [target.id],
    approve: true
  });

  assert.equal(service.cancelRun("mention-parent-run"), true);
  await waitFor(() => batchStarted);
  assert.equal(batchSignal?.aborted, true);

  releaseBatch();
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.metadata.running === false &&
      !serviceAny.chatRunControllers.has("mention-parent-run");
  });
});

test("hydrateContextUsage clears inactive stale running state without warning when no pending turn was lost", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId: "stale-run"
  };
  const { service, storage } = testService({ conversations: [conversation] });

  const hydrated = await service.hydrateContextUsage(cloneConversation(conversation));
  const saved = await storage.getConversation(conversation.id);

  assert.equal(hydrated.metadata.running, false);
  assert.equal(hydrated.metadata.runId, undefined);
  assert.deepEqual(hydrated.metadata.warnings ?? [], []);
  assert.equal(saved?.metadata.running, false);
  assert.deepEqual(saved?.metadata.warnings ?? [], []);
});

test("hydrateContextUsage warns when stale recovery marks a pending participant turn interrupted", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], "/repo");
  const pending = participantMessage(participant, "pending-reply", "");
  pending.status = "pending";
  pending.metadata = { ...pending.metadata, runId: "stale-run" };
  conversation.messages.push(pending);
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId: "stale-run",
    warnings: [INTERRUPTED_RUN_WARNING, INTERRUPTED_RUN_WARNING]
  };
  const { service, storage } = testService({ conversations: [conversation] });

  const hydrated = await service.hydrateContextUsage(cloneConversation(conversation));
  const saved = await storage.getConversation(conversation.id);
  const hydratedReply = hydrated.messages.find((message) => message.id === pending.id);
  const savedReply = saved?.messages.find((message) => message.id === pending.id);

  assert.equal(hydrated.metadata.running, false);
  assert.deepEqual(hydrated.metadata.warnings, [INTERRUPTED_RUN_WARNING]);
  assert.equal(hydratedReply?.status, "error");
  assert.equal(hydratedReply?.content, "Interrupted before completion.");
  assert.equal(Boolean(hydratedReply?.metadata?.staleRunRecovery), true);
  assert.equal(saved?.metadata.running, false);
  assert.deepEqual(saved?.metadata.warnings, [INTERRUPTED_RUN_WARNING]);
  assert.equal(savedReply?.status, "error");
});

test("dismissConversationWarnings removes persisted chat metadata warnings", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    warnings: [INTERRUPTED_RUN_WARNING, "Other warning", INTERRUPTED_RUN_WARNING]
  };
  const { service, storage } = testService({ conversations: [conversation] });

  const updated = await service.dismissConversationWarnings({
    conversationId: conversation.id,
    warnings: [INTERRUPTED_RUN_WARNING]
  });
  const saved = await storage.getConversation(conversation.id);

  assert.deepEqual(updated?.metadata.warnings, ["Other warning"]);
  assert.deepEqual(saved?.metadata.warnings, ["Other warning"]);
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
  assert.equal(saved?.metadata.runId, undefined);

  const recoveredCandidate = cloneConversation(saved as Conversation);
  assert.equal(serviceAny.recoverStaleChatRun(recoveredCandidate), false);
  assert.equal(recoveredCandidate.metadata.running, true);
  assert.equal(recoveredCandidate.metadata.runId, undefined);

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
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    const savedRequest = saved?.messages.find((message) => message.id === requestMessage.id);
    return saved?.metadata.running === false &&
      savedRequest?.metadata?.participantRequest?.status === "completed";
  });
  const saved = await storage.getConversation(conversation.id);
  const savedRequest = saved?.messages.find((message) => message.id === requestMessage.id);

  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(savedRequest?.metadata?.participantRequest?.status, "completed");
  assert.equal(savedRequest?.metadata?.participantRequest?.autoResumeMessageId, "resume-reply");
});

test("clearInterruptedRuns clears stale run metadata without warning when no pending turn was lost", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId: "stale-run"
  };
  let saved: Conversation | undefined;
  const storage = Object.create(StorageService.prototype) as any;
  storage.queryJson = async (sql: string) => {
    assert.match(sql, /select id from conversations/);
    assert.doesNotMatch(sql, /payload_json as payloadJson/);
    return [{ id: conversation.id }];
  };
  storage.queryText = async () => JSON.stringify(conversation);
  storage.saveConversation = async (next: Conversation) => {
    saved = cloneConversation(next);
  };

  await (storage as any).clearInterruptedRuns();

  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.deepEqual(saved?.metadata.warnings, []);
});

test("clearInterruptedRuns preserves interrupted warning when startup cleanup finds a pending turn", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], "/repo");
  const pending = participantMessage(participant, "pending-reply", "");
  pending.status = "pending";
  pending.metadata = { ...pending.metadata, runId: "stale-run" };
  conversation.messages.push(pending);
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId: "stale-run"
  };
  let saved: Conversation | undefined;
  const storage = Object.create(StorageService.prototype) as any;
  storage.queryJson = async (sql: string) => {
    assert.match(sql, /select id from conversations/);
    assert.doesNotMatch(sql, /payload_json as payloadJson/);
    return [{ id: conversation.id }];
  };
  storage.queryText = async () => JSON.stringify(conversation);
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
        capabilities: ["participants.request"],
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

test("requestParticipantsFromTool reports running without approvalRequired while target is active", async () => {
  const requester = chatParticipant({ requestParticipants: "allow" });
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push(userMessage("trigger-message", "@drew ask Taylor"));
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let releaseTarget!: () => void;
  const targetCanFinish = new Promise<void>((resolve) => {
    releaseTarget = resolve;
  });
  serviceAny.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  serviceAny.refreshStoredChatState = async () => undefined;
  serviceAny.runParticipantTurnSerialized = async () => {
    await targetCanFinish;
    return [participantMessage(target, "target-reply", "Reviewed.")];
  };

  const result = await withTimeout(
    service.requestParticipantsFromTool({
      conversationId: conversation.id,
      participantId: requester.id,
      roleConfigId: requester.roleConfigId,
      roleConfigVersion: ROLE.version,
      capabilities: ["participants.request"],
      triggerMessageId: "trigger-message",
      runId: "active-run"
    } as never, {
      requests: [{ target: "taylor", prompt: "Review this.", reason: "Need another opinion." }],
      timeoutMs: 10,
      resumeRequester: false
    }),
    250
  );

  assert.equal(result.status, "running");
  assert.equal(result.approvalRequired, false);

  releaseTarget();
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.messages.some((message) => message.id === "target-reply") === true;
  });
});

test("denying one participant request approval terminalizes only matching items", async () => {
  const requester = chatParticipant();
  const taylor = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const casey = chatParticipant({ repoRead: true }, { id: "participant-3", handle: "casey" });
  const conversation = chatConversation([requester, taylor, casey], "/repo");
  const requestMessage = participantRequestMessageWithItems(requester, [
    participantRequestItem(taylor, "pending_approval"),
    participantRequestItem(casey, "pending_approval")
  ]);
  conversation.messages.push(requestMessage);
  conversation.metadata = {
    ...conversation.metadata,
    pendingAppToolApprovals: [participantRequestApproval(requester, taylor, requestMessage, "approval-run")]
  };
  const { service, storage } = testService({ conversations: [conversation] });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: "approval-taylor",
    approve: false
  });

  const saved = await storage.getConversation(conversation.id);
  const batch = saved?.messages.find((message) => message.id === requestMessage.id)?.metadata?.participantRequest;
  const taylorItem = batch?.items.find((item) => item.targetParticipantId === taylor.id);
  const caseyItem = batch?.items.find((item) => item.targetParticipantId === casey.id);

  assert.equal(taylorItem?.status, "denied");
  assert.equal(caseyItem?.status, "pending_approval");
  assert.equal(batch?.status, "pending_approval");
});

test("participantRequestStatusForTool interrupts orphaned pending approvals", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  const requestMessage = participantRequestMessageWithItems(requester, [
    participantRequestItem(target, "pending_approval")
  ]);
  conversation.messages.push(requestMessage);
  const { service, storage } = testService({ conversations: [conversation] });

  const result = await service.participantRequestStatusForTool({
    conversationId: conversation.id,
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: []
  } as never, { requestId: "batch-1" });

  const saved = await storage.getConversation(conversation.id);
  const batch = saved?.messages.find((message) => message.id === requestMessage.id)?.metadata?.participantRequest;
  assert.equal((result.requests as Array<{ status: string }>)[0]?.status, "interrupted");
  assert.equal(batch?.status, "interrupted");
  assert.equal(batch?.items[0]?.status, "interrupted");
});

test("superseded participant turn closes older pending interactions for that participant", () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  const choiceMessage = participantMessage(requester, "choice-message", "Choose.");
  choiceMessage.metadata = {
    ...choiceMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Decision",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      status: "pending"
    },
    pendingMentions: [{
      targetParticipantId: target.id,
      targetHandle: target.handle,
      status: "pending"
    }]
  };
  const requestMessage = participantRequestMessageWithItems(requester, [
    participantRequestItem(target, "running")
  ]);
  conversation.messages.push(choiceMessage, requestMessage);
  const { service } = testService({ conversations: [conversation] });

  (service as any).resolveSupersededParticipantInteractions(conversation, requester.id);

  assert.equal(choiceMessage.metadata?.pendingChoice?.status, "cancelled");
  assert.equal(choiceMessage.metadata?.pendingMentions?.[0]?.status, "rejected");
  assert.equal(requestMessage.metadata?.participantRequest?.status, "interrupted");
  assert.equal(requestMessage.metadata?.participantRequest?.items[0]?.status, "interrupted");
});

test("stale chat metadata merge cannot resurrect terminal pending states", () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const storedMessage = participantRequestMessageWithItems(requester, [
    participantRequestItem(target, "pending_approval", "2026-05-19T12:02:00.000Z")
  ]);
  const storedBatch = storedMessage.metadata?.participantRequest;
  assert.ok(storedBatch);
  const storedItem = storedBatch.items[0];
  assert.ok(storedItem);
  storedMessage.metadata = {
    ...storedMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Decision",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      status: "pending"
    }
  };
  const currentMessage = JSON.parse(JSON.stringify(storedMessage)) as ChatMessage;
  currentMessage.metadata = {
    ...currentMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Decision",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      status: "cancelled",
      cancelledAt: "2026-05-19T12:01:00.000Z"
    },
    participantRequest: {
      ...storedBatch,
      status: "denied",
      updatedAt: "2026-05-19T12:01:00.000Z",
      items: [{
        ...storedItem,
        status: "denied",
        updatedAt: "2026-05-19T12:01:00.000Z"
      }]
    }
  };
  const storedApproval: ChatAppToolApproval = {
    ...participantRequestApproval(requester, target, storedMessage, "approval-run"),
    updatedAt: "2026-05-19T12:02:00.000Z"
  };
  const currentApproval: ChatAppToolApproval = {
    ...storedApproval,
    status: "denied",
    updatedAt: "2026-05-19T12:01:00.000Z"
  };
  const { service } = testService();
  const serviceAny = service as any;

  const mergedMessages = serviceAny.mergeStoredChatMessages([storedMessage], [currentMessage]) as ChatMessage[];
  const mergedMetadata = serviceAny.mergeStoredChatMetadata(
    { pendingAppToolApprovals: [storedApproval] },
    { pendingAppToolApprovals: [currentApproval] }
  );

  assert.equal(mergedMessages[0]?.metadata?.pendingChoice?.status, "cancelled");
  assert.equal(mergedMessages[0]?.metadata?.participantRequest?.status, "denied");
  assert.equal(mergedMessages[0]?.metadata?.participantRequest?.items[0]?.status, "denied");
  assert.equal((mergedMetadata.pendingAppToolApprovals as ChatAppToolApproval[])[0]?.status, "denied");
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

  const changed = (service as any).markPendingAppToolApprovalsForRunTerminal(
    conversation,
    "approval-run",
    "Run stopped."
  );

  assert.equal(changed, true);
  assert.equal((conversation.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0]?.status, "denied");
  assert.equal(conversation.messages[0]?.metadata?.participantRequest?.status, "interrupted");
  assert.equal(conversation.messages[0]?.metadata?.participantRequest?.items[0]?.status, "interrupted");
});

test("requestParticipantsFromTool keeps nested participant request as its own visual thread root", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push({
    ...userMessage("thread-reply", "@drew ask Taylor"),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "outer-root",
      chatThreadRootId: "outer-root"
    }
  });
  const snapshots: Conversation[] = [];
  const { service, storage } = testService({
    conversations: [conversation],
    onSnapshot: (snapshot) => snapshots.push(snapshot)
  });

  const result = await service.requestParticipantsFromTool({
    conversationId: conversation.id,
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: ["participants.request"],
    triggerMessageId: "thread-reply",
    triggerThreadId: "outer-thread",
    triggerParentMessageId: "outer-root",
    triggerChatThreadRootId: "outer-root",
    runId: "active-run"
  } as never, {
    requests: [{ target: "taylor", prompt: "Review this.", reason: "Need another opinion." }],
    timeoutMs: 50,
    resumeRequester: true
  });

  const saved = await storage.getConversation(conversation.id);
  const requestMessage = saved?.messages.find((message) => message.metadata?.participantRequest);

  assert.equal(result.status, "pending_approval");
  assert.ok(requestMessage);
  assert.equal(requestMessage.metadata?.threadId, "outer-thread");
  assert.equal(requestMessage.metadata?.parentMessageId, "thread-reply");
  assert.equal(requestMessage.metadata?.sourceMessageId, "thread-reply");
  assert.equal(requestMessage.metadata?.chatThreadRootId, undefined);
  assert.equal(
    snapshots.some((snapshot) => snapshot.messages.some((message) => message.metadata?.participantRequest?.id === requestMessage.metadata?.participantRequest?.id)),
    true
  );
});

test("requestParticipantsFromTool roots running recipient replies under the request message", async () => {
  const requester = chatParticipant({ requestParticipants: "allow" });
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push({
    ...userMessage("thread-reply", "@drew ask Taylor"),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "outer-root",
      chatThreadRootId: "outer-root"
    }
  });
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let capturedTrigger: ChatMessage | undefined;
  serviceAny.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  serviceAny.refreshStoredChatState = async () => undefined;
  serviceAny.runParticipantTurnSerialized = async (
    _conversation: Conversation,
    participant: ChatParticipant,
    trigger: ChatMessage
  ) => {
    capturedTrigger = trigger;
    return [{
      ...participantMessage(participant, "target-reply", "Reviewed."),
      metadata: {
        threadId: trigger.metadata?.threadId ?? trigger.id,
        parentMessageId: trigger.id,
        chatThreadRootId: trigger.metadata?.chatThreadRootId,
        sourceMessageId: trigger.id
      }
    }];
  };

  const result = await service.requestParticipantsFromTool({
    conversationId: conversation.id,
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: ["participants.request"],
    triggerMessageId: "thread-reply",
    triggerThreadId: "outer-thread",
    triggerParentMessageId: "outer-root",
    triggerChatThreadRootId: "outer-root",
    runId: "active-run"
  } as never, {
    requests: [{ target: "taylor", prompt: "Review this.", reason: "Need another opinion." }],
    timeoutMs: 50,
    resumeRequester: false
  });

  const saved = await storage.getConversation(conversation.id);
  const requestMessage = saved?.messages.find((message) => message.metadata?.participantRequest);
  const targetReply = saved?.messages.find((message) => message.id === "target-reply");

  assert.equal(result.status, "completed");
  assert.ok(requestMessage);
  assert.equal(requestMessage.metadata?.chatThreadRootId, undefined);
  assert.equal(capturedTrigger?.id, requestMessage.id);
  assert.equal(capturedTrigger?.metadata?.chatThreadRootId, requestMessage.id);
  assert.equal(targetReply?.metadata?.threadId, "outer-thread");
  assert.equal(targetReply?.metadata?.parentMessageId, requestMessage.id);
  assert.equal(targetReply?.metadata?.chatThreadRootId, requestMessage.id);
});

test("inferred participant request carrier is hidden and rooted to the source visual root", () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  const source = {
    ...participantMessage(requester, "source-message", "Taylor should check this. @taylor please verify."),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "outer-root",
      chatThreadRootId: "outer-root"
    }
  };
  const { service } = testService({ conversations: [conversation] });

  (service as any).appendParticipantTurnMessages(conversation, requester, [source]);

  const requestMessage = conversation.messages.find((message) => message.metadata?.participantRequest);
  const batch = requestMessage?.metadata?.participantRequest;
  assert.ok(requestMessage);
  assert.equal(batch?.source, "inferred");
  assert.equal(batch?.triggerMessageId, "source-message");
  assert.equal(requestMessage.metadata?.hiddenFromTimeline, true);
  assert.equal(requestMessage.metadata?.threadId, "outer-thread");
  assert.equal(requestMessage.metadata?.parentMessageId, "source-message");
  assert.equal(requestMessage.metadata?.sourceMessageId, "source-message");
  assert.equal(requestMessage.metadata?.chatThreadRootId, "outer-root");
});

test("legacy accord launch metadata does not suppress inferred participant requests", () => {
  const facilitator = chatParticipant({}, { id: "facilitator", handle: "facilitator" });
  const requester = chatParticipant({}, { id: "requester", handle: "drew" });
  const target = chatParticipant({ repoRead: true }, { id: "target", handle: "taylor" });
  const conversation = chatConversation([facilitator, requester, target], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    accordLaunch: {
      id: "accord-launch",
      facilitatorId: facilitator.id,
      targetIds: [requester.id, target.id],
      requiredApproverIds: [facilitator.id, requester.id, target.id],
      runId: "accord-run",
      expiresAt: "2099-01-01T00:00:00.000Z"
    }
  };
  const { service } = testService({ conversations: [conversation] });

  (service as any).appendParticipantTurnMessages(conversation, requester, [
    participantMessage(requester, "source-message", "@taylor please verify this accord concern.")
  ]);

  const requestMessage = conversation.messages.find((message) => message.metadata?.participantRequest);
  assert.ok(requestMessage);
  assert.equal(requestMessage.metadata?.participantRequest?.source, "inferred");
  assert.equal(requestMessage.metadata?.participantRequest?.requesterParticipantId, requester.id);
});

test("legacy manual accord metadata does not suppress inferred participant requests", () => {
  const facilitator = chatParticipant({}, { id: "facilitator", handle: "facilitator" });
  const requester = chatParticipant({}, { id: "requester", handle: "drew" });
  const target = chatParticipant({ repoRead: true }, { id: "target", handle: "taylor" });
  const conversation = chatConversation([facilitator, requester, target], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    accordRun: { facilitatorId: facilitator.id, expiresAt: "2099-01-01T00:00:00.000Z" }
  };
  const { service } = testService({ conversations: [conversation] });

  (service as any).appendParticipantTurnMessages(conversation, requester, [
    participantMessage(requester, "source-message", "@taylor please verify this accord concern.")
  ]);

  const requestMessage = conversation.messages.find((message) => message.metadata?.participantRequest);
  assert.ok(requestMessage);
  assert.equal(requestMessage.metadata?.participantRequest?.source, "inferred");
  assert.equal(requestMessage.metadata?.participantRequest?.requesterParticipantId, requester.id);
});

test("runParticipantRequest roots inferred recipient replies under the source visual root", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push({
    ...participantMessage(requester, "source-message", "Taylor should check this. @taylor please verify."),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "outer-root",
      chatThreadRootId: "outer-root"
    }
  }, {
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    participantLabel: `@${requester.handle}`,
    content: "@taylor Review this.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "source-message",
      sourceMessageId: "source-message",
      chatThreadRootId: "outer-root",
      hiddenFromTimeline: true,
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "inferred",
        resumeRequester: false,
        status: "running",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: "source-message",
        items: [{
          targetParticipantId: target.id,
          targetHandle: target.handle,
          prompt: "Review this.",
          status: "running",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  });
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let capturedTrigger: ChatMessage | undefined;
  serviceAny.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  serviceAny.refreshStoredChatState = async () => undefined;
  serviceAny.runParticipantTurnSerialized = async (
    _conversation: Conversation,
    participant: ChatParticipant,
    trigger: ChatMessage
  ) => {
    capturedTrigger = trigger;
    return [{
      ...participantMessage(participant, "target-reply", "Reviewed."),
      metadata: {
        threadId: trigger.metadata?.threadId ?? trigger.id,
        parentMessageId: trigger.id,
        chatThreadRootId: trigger.metadata?.chatThreadRootId,
        sourceMessageId: trigger.id
      }
    }];
  };

  await serviceAny.runParticipantRequest(conversation.id, "request-message", "run-1", 1);

  const saved = await storage.getConversation(conversation.id);
  const targetReply = saved?.messages.find((message) => message.id === "target-reply");
  const requestBatch = saved?.messages.find((message) => message.id === "request-message")?.metadata?.participantRequest;
  assert.equal(capturedTrigger?.id, "request-message");
  assert.equal(capturedTrigger?.metadata?.chatThreadRootId, "outer-root");
  assert.equal(targetReply?.metadata?.threadId, "outer-thread");
  assert.equal(targetReply?.metadata?.parentMessageId, "request-message");
  assert.equal(targetReply?.metadata?.chatThreadRootId, "outer-root");
  assert.equal(targetReply?.metadata?.sourceMessageId, "request-message");
  assert.equal(requestBatch?.status, "answered");
  assert.equal(requestBatch?.items[0].replyMessageId, "target-reply");
});

test("normalizeInferredParticipantRequestThreads hides legacy carriers and reroots descendants", () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push({
    ...participantMessage(requester, "source-message", "Taylor should check this. @taylor please verify."),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "outer-root",
      chatThreadRootId: "outer-root"
    }
  }, {
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    participantLabel: `@${requester.handle}`,
    content: "@taylor Review this.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "source-message",
      sourceMessageId: "source-message",
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "inferred",
        resumeRequester: true,
        status: "answered",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: "source-message",
        items: [{
          targetParticipantId: target.id,
          targetHandle: target.handle,
          prompt: "Review this.",
          status: "answered",
          replyMessageId: "target-reply",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  }, {
    ...participantMessage(target, "target-reply", "Reviewed."),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "request-message",
      chatThreadRootId: "request-message",
      sourceMessageId: "request-message"
    }
  }, {
    id: "resume-message",
    role: "system",
    content: "Auto-resumed Drew after participant request.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "request-message",
      chatThreadRootId: "request-message",
      sourceMessageId: "request-message"
    }
  });

  const changed = normalizeInferredParticipantRequestThreads(conversation);

  const requestMessage = conversation.messages.find((message) => message.id === "request-message");
  const targetReply = conversation.messages.find((message) => message.id === "target-reply");
  const resumeMessage = conversation.messages.find((message) => message.id === "resume-message");
  assert.equal(changed, true);
  assert.equal(requestMessage?.metadata?.hiddenFromTimeline, true);
  assert.equal(requestMessage?.metadata?.chatThreadRootId, "outer-root");
  assert.equal(targetReply?.metadata?.chatThreadRootId, "outer-root");
  assert.equal(resumeMessage?.metadata?.chatThreadRootId, "outer-root");
});

function testService(options: { canRequestPermissions?: boolean; conversations?: Conversation[]; onSnapshot?: (conversation: Conversation) => void } = {}): {
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
    service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never, appMcp as never, options.onSnapshot),
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

function participantRequestPolicy(requester: ChatParticipant, target: ChatParticipant): ChatAppToolApprovalPolicy {
  return {
    id: "participant-request-policy",
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    toolName: "app_chat_request_participants",
    capability: "participants.request",
    targetParticipantId: target.id,
    scope: "chat",
    createdAt: NOW,
    updatedAt: NOW
  };
}

function participantRequestApproval(
  requester: ChatParticipant,
  target: ChatParticipant,
  requestMessage: ChatMessage,
  runId: string
): ChatAppToolApproval {
  const batch = requestMessage.metadata?.participantRequest;
  assert.ok(batch);
  return {
    id: `approval-${target.handle}`,
    conversationId: "conversation-1",
    requesterParticipantId: requester.id,
    requesterHandle: requester.handle,
    requesterRoleConfigId: requester.roleConfigId,
    toolName: "app_chat_request_participants",
    capability: "participants.request",
    status: "pending",
    request: {
      requests: [{
        target: target.handle,
        prompt: "Review this."
      }],
      resumeRequester: true,
      source: "mcp",
      requestMessageId: requestMessage.id,
      batchId: batch.id
    },
    summary: `Ask @${target.handle}`,
    createdAt: NOW,
    updatedAt: NOW,
    resumeContext: {
      runId,
      triggerMessageId: "trigger-message",
      participantRequestBatchId: batch.id
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

function participantRequestItem(
  target: ChatParticipant,
  status: ChatParticipantRequestStatus,
  updatedAt = NOW
) {
  return {
    targetParticipantId: target.id,
    targetHandle: target.handle,
    prompt: "Review this.",
    status,
    createdAt: NOW,
    updatedAt
  };
}

function participantRequestMessageWithItems(
  requester: ChatParticipant,
  items: ReturnType<typeof participantRequestItem>[]
): ChatMessage {
  return {
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    participantLabel: `@${requester.handle}`,
    content: items.map((item) => `@${item.targetHandle} ${item.prompt}`).join("\n"),
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
        status: items.some((item) => item.status === "pending_approval")
          ? "pending_approval"
          : items.some((item) => item.status === "running")
            ? "running"
            : items[0]?.status ?? "completed",
        depth: 1,
        createdAt: NOW,
        updatedAt: items.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, NOW),
        triggerMessageId: "trigger-message",
        items
      }
    }
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
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
