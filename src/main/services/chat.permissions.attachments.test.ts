import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  APP_CHAT_EXPORT_ATTACHMENT_TOOL, APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL, APP_CHAT_LIST_ATTACHMENTS_TOOL,
  APP_CHAT_READ_ATTACHMENT_TOOL, APP_CHAT_REACT_TOOL, APP_CHAT_SET_TITLE_TOOL, APP_TOOL_PERMISSION_TOOL, AppMcpService
} from "./appMcp";
import { toolsForActor } from "./appMcp/protocol";
import { chatParts } from "./chat/test/chatParts";
import { readFileWithMaxBytes } from "./chat/attachments/imageRecords";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import {
  chatConversation, chatParticipant, inferredRequestMessages, NOW, participantRequestActor, ROLE, testService
} from "./chat/test/permissionFixtures";

const ONE_BY_ONE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("app_chat_send_message imports image attachments and exposes them in the same run", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-send-image-"));
  const repoPath = path.join(tempRoot, "repo");
  const storageRoot = path.join(tempRoot, "storage");
  await mkdir(path.join(repoPath, "assets"), { recursive: true });
  const sourcePath = path.join(repoPath, "assets", "shot.png");
  await writeFile(sourcePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.repoPath = repoPath;
  const { service, storage } = testService({ conversation });
  chatParts(service).attachments.attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "send-image-run-1",
    runPermissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      repoRead: true
    })
  };

  try {
    const sent = await service.sendChatMessageFromTool(actor, {
      content: "",
      parentMessageId: "user-message",
      attachments: [{
        kind: "image",
        sourcePath: "assets/shot.png",
        filename: "qa-shot.png",
        mimeType: "image/png"
      }]
    });

    assert.equal(sent.ok, true);
    assert.equal(sent.sequence, 1);
    assert.equal(actor.snapshotMaxSequence, 1);
    assert.equal((sent.imageAttachments as Array<{ sourceRoot: string }>)[0].sourceRoot, "repo");
    const message = storage.current.messages[1];
    const attachment = message.metadata.imageAttachments[0];
    assert.equal(message.role, "participant");
    assert.equal(message.content, "");
    assert.equal(attachment.filename, "qa-shot.png");
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.width, 1);
    assert.equal(attachment.height, 1);
    await stat(path.join(storageRoot, attachment.storageKey));

    const listed = await service.listChatAttachmentsForTool(actor, { messageId: sent.messageId });
    assert.deepEqual(
      (listed.attachments as Array<{ attachment: { id: string } }>).map((item) => item.attachment.id),
      [attachment.id]
    );
    const readBack = await service.readChatAttachmentForTool(actor, { attachmentId: attachment.id });
    assert.equal(readBack.dataBase64, ONE_BY_ONE_PNG_BASE64);

    const reacted = await service.reactToMessageFromTool(actor, {
      messageId: sent.messageId as string,
      emoji: "✅"
    });
    assert.equal(reacted.status, "added");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("app_chat_send_message keeps a visible post and attachment when inference throws", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-send-image-inference-error-"));
  const repoPath = path.join(tempRoot, "repo");
  const storageRoot = path.join(tempRoot, "storage");
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(repoPath, "shot.png"), Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
  const requester = chatParticipant("codex-cli", { requestParticipants: "allow", repoRead: true });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  conversation.repoPath = repoPath;
  const { service, storage } = testService({ conversation });
  chatParts(service).attachments.attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  chatParts(service).inferredRequests.createImplicitParticipantRequestApproval = async () => {
    throw new Error("forced inference failure");
  };

  try {
    const sent = await service.sendChatMessageFromTool({
      ...participantRequestActor(requester),
      runId: "inference-error-run",
      turnSegmentId: "inference-error-segment",
      runPermissions: normalizeChatAgentPermissions({
        ...defaultChatAgentPermissions(),
        repoRead: true
      })
    }, {
      content: "@drew inspect the attached image.",
      attachments: [{ kind: "image", sourcePath: "shot.png" }]
    });

    assert.equal(sent.ok, true);
    assert.equal(storage.current.messages[1].content, "@drew inspect the attached image.");
    const attachment = storage.current.messages[1].metadata.imageAttachments[0];
    await stat(path.join(storageRoot, attachment.storageKey));
    assert.equal(inferredRequestMessages(storage.current).length, 0);
    assert.match(
      storage.current.metadata.warnings?.[0] ?? "",
      /inferred-request processing failed/i
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("app_chat_send_message rejects unsafe image import sources", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-send-image-denied-"));
  const repoPath = path.join(tempRoot, "repo");
  const outsidePath = path.join(tempRoot, "outside.png");
  const storageRoot = path.join(tempRoot, "storage");
  await mkdir(path.join(repoPath, "assets"), { recursive: true });
  await writeFile(path.join(repoPath, "assets", "not-image.txt"), "not an image", "utf8");
  await writeFile(path.join(repoPath, "assets", "shot.png"), Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
  await writeFile(outsidePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
  await symlink(outsidePath, path.join(repoPath, "assets", "outside-link.png"));

  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.repoPath = repoPath;
  const { service, storage } = testService({ conversation });
  chatParts(service).attachments.attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "send-image-denied-run",
    runPermissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      repoRead: true
    })
  };

  try {
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "outside",
        attachments: [{ kind: "image", sourcePath: outsidePath }]
      }),
      /outside allowed roots/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool({
        ...actor,
        runId: "send-image-denied-temp-run",
        runPermissions: normalizeChatAgentPermissions({
          ...defaultChatAgentPermissions(),
          repoRead: false,
          workspaceWrite: true,
          shell: { enabled: true, rules: [] }
        })
      }, {
        content: "temp root",
        attachments: [{ kind: "image", sourcePath: outsidePath }]
      }),
      /no allowed image import roots/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "symlink",
        attachments: [{ kind: "image", sourcePath: "assets/outside-link.png" }]
      }),
      /symlink/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "directory",
        attachments: [{ kind: "image", sourcePath: "assets" }]
      }),
      /directory/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "missing",
        attachments: [{ kind: "image", sourcePath: "assets/missing.png" }]
      }),
      /could not be inspected/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "not image",
        attachments: [{ kind: "image", sourcePath: "assets/not-image.txt" }]
      }),
      /UnsupportedImageType/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "mime mismatch",
        attachments: [{ kind: "image", sourcePath: "assets/shot.png", mimeType: "image/jpeg" }]
      }),
      /UnsupportedImageType/
    );

    assert.equal(storage.current.messages.length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("app_chat_send_message pins imported image file identity while reading", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-send-image-identity-"));
  const repoPath = path.join(tempRoot, "repo");
  const sourcePath = path.join(repoPath, "shot.png");
  const outsidePath = path.join(tempRoot, "outside.png");
  await mkdir(repoPath, { recursive: true });
  await writeFile(sourcePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
  await writeFile(outsidePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.repoPath = repoPath;
  const { service } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "send-image-identity-run",
    runPermissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      repoRead: true
    })
  };
  const serviceAny = service as any;

  try {
    const source = await chatParts(serviceAny).attachments.resolveChatAttachmentImportSource(conversation, actor, "shot.png");
    await assert.rejects(
      () => readFileWithMaxBytes({ ...source, ino: source.ino + 1 }, 10 * 1024 * 1024),
      /changed during import/
    );

    await rm(sourcePath, { force: true });
    await symlink(outsidePath, sourcePath);
    await assert.rejects(
      () => readFileWithMaxBytes(source, 10 * 1024 * 1024),
      /could not be opened safely|changed during import/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("app_chat_send_message rolls back imported images on later validation failure", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-send-image-rollback-"));
  const repoPath = path.join(tempRoot, "repo");
  const storageRoot = path.join(tempRoot, "storage");
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(repoPath, "shot.png"), Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.repoPath = repoPath;
  const { service } = testService({ conversation });
  chatParts(service).attachments.attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "send-image-rollback-run",
    runPermissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      repoRead: true
    })
  };

  try {
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "will fail",
        threadId: "ghost-thread",
        attachments: [{ kind: "image", sourcePath: "shot.png" }]
      }),
      /ChatSendMessageDenied/
    );
    const entries = await readdir(path.join(storageRoot, "attachments")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    assert.deepEqual(entries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("app_chat_send_message enforces a per-run imported image byte cap", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-send-image-cap-"));
  const repoPath = path.join(tempRoot, "repo");
  const storageRoot = path.join(tempRoot, "storage");
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(repoPath, "shot.png"), Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.repoPath = repoPath;
  const { service, storage } = testService({ conversation });
  chatParts(service).attachments.attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "send-image-cap-run",
    runPermissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      repoRead: true
    })
  };
  chatParts(service).chatPostTools.appSendMessageImageBytesByRun.set(actor.runId, (5 * 10 * 1024 * 1024) - 1);

  try {
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "over cap",
        attachments: [{ kind: "image", sourcePath: "shot.png" }]
      }),
      /too many image bytes/
    );
    assert.equal(storage.current.messages.length, 1);
    const entries = await readdir(path.join(storageRoot, "attachments")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    assert.deepEqual(entries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("app MCP advertises attachment and reaction tools to chat participants", () => {
  const appMcp = new AppMcpService();
  const tools = toolsForActor({
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    capabilities: []
  }) as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] }; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
  const listTool = tools.find((tool) => tool.name === APP_CHAT_LIST_ATTACHMENTS_TOOL);
  const readTool = tools.find((tool) => tool.name === APP_CHAT_READ_ATTACHMENT_TOOL);
  const reactionTool = tools.find((tool) => tool.name === APP_CHAT_REACT_TOOL);
  const participantActivityTool = tools.find((tool) => tool.name === APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL);
  const exportTool = tools.find((tool) => tool.name === APP_CHAT_EXPORT_ATTACHMENT_TOOL);
  const titleTool = tools.find((tool) => tool.name === APP_CHAT_SET_TITLE_TOOL);
  const toolPermissionTool = tools.find((tool) => tool.name === APP_TOOL_PERMISSION_TOOL);

  assert.ok(listTool);
  assert.equal(listTool.annotations?.readOnlyHint, true);
  assert.equal(listTool.annotations?.destructiveHint, false);
  assert.ok(listTool.inputSchema?.properties?.messageId);
  assert.ok(listTool.inputSchema?.properties?.threadId);
  assert.ok(listTool.inputSchema?.properties?.limit);
  assert.ok(readTool);
  assert.equal(readTool.annotations?.readOnlyHint, true);
  assert.equal(readTool.annotations?.destructiveHint, false);
  assert.ok(readTool.inputSchema?.properties?.attachmentId);
  assert.deepEqual(readTool.inputSchema?.required, ["attachmentId"]);
  assert.ok(reactionTool);
  assert.ok(participantActivityTool);
  assert.equal(participantActivityTool.annotations?.readOnlyHint, true);
  assert.equal(participantActivityTool.annotations?.destructiveHint, false);
  assert.deepEqual(participantActivityTool.inputSchema?.properties, {});
  assert.ok(reactionTool.inputSchema?.properties?.messageId);
  assert.ok(reactionTool.inputSchema?.properties?.emoji);
  assert.ok(exportTool);
  assert.equal(exportTool.annotations?.readOnlyHint, false);
  assert.equal(exportTool.annotations?.destructiveHint, true);
  assert.ok(exportTool.inputSchema?.properties?.attachmentId);
  assert.ok(exportTool.inputSchema?.properties?.targetPath);
  assert.ok(titleTool);
  assert.equal(titleTool.annotations?.readOnlyHint, false);
  assert.ok(titleTool.inputSchema?.properties?.title);
  assert.ok(toolPermissionTool);
  assert.ok(toolPermissionTool.inputSchema?.properties?.tool_use_id);
  assert.ok(toolPermissionTool.inputSchema?.properties?.toolUseId);
});

test("a picture a machine does not hold is fetched from the desktop that owns the chat", async () => {
  // The defect: conversation replication carries an attachment's metadata but
  // never its file, and the machine link had no notion of attachments at all
  // (zero references). A member running in the cloud could therefore see that
  // the User attached a picture and could never read it: every read failed
  // with AttachmentMissing, telling the User to resend an image that was not
  // lost. The bytes now come from the desktop on demand.
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const attachment = {
    id: "attachment-1", filename: "shot.png", mimeType: "image/png",
    sizeBytes: 3, width: 1, height: 1,
    storageKey: `attachments/${randomUUID()}.png`, createdAt: NOW
  };
  conversation.messages.push({
    id: "user-picture", role: "user", content: "Look at this.", status: "done", createdAt: NOW,
    metadata: { imageAttachments: [attachment] }
  } as any);
  const { service } = testService({ conversation });
  const asked: Array<{ conversationId: string; attachmentId: string }> = [];
  const bytes = Buffer.from("PNG").toString("base64");
  service.setMachineLink({
    fetchAttachment: async (conversationId: string, attachmentId: string) => {
      asked.push({ conversationId, attachmentId });
      return { dataBase64: bytes };
    }
  } as any);
  const read = await service.readChatAttachment({ conversationId: conversation.id, attachmentId: attachment.id });
  assert.equal(read.dataBase64, bytes, "the member must receive the picture the desktop holds");
  assert.deepEqual(asked, [{ conversationId: conversation.id, attachmentId: attachment.id }]);
});

test("a picture on the User's server that the server cannot give now is reported as unavailable, not as one to resend", async () => {
  // The computer reads a picture a cloud member made from the User's server;
  // when the server cannot answer, the picture is not lost.
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const attachment = {
    id: "attachment-3", filename: "shot.png", mimeType: "image/png",
    sizeBytes: 3, width: 1, height: 1,
    storageKey: `attachments/${randomUUID()}.png`, createdAt: NOW,
    hubBlob: { type: "device.event.blob", blobHash: `sha256:${"a".repeat(64)}`, byteLength: 3, fragments: 1 }
  };
  conversation.messages.push({
    id: "machine-picture", role: "participant", content: "Mockup.", status: "done", createdAt: NOW,
    metadata: { imageAttachments: [attachment] }
  } as any);
  const { service } = testService({ conversation });
  service.setHubBlobReader(async () => { throw new Error("socket hang up"); });
  await assert.rejects(
    service.readChatAttachment({ conversationId: conversation.id, attachmentId: attachment.id }),
    (error: Error) => /AttachmentUnavailable/.test(error.message)
      && error.message.includes("socket hang up")
      && error.message.includes("do not ask for a resend")
  );
});

test("a picture the owner cannot supply is reported as unavailable with the reason, not as empty bytes", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const attachment = {
    id: "attachment-2", filename: "shot.png", mimeType: "image/png",
    sizeBytes: 3, width: 1, height: 1,
    storageKey: `attachments/${randomUUID()}.png`, createdAt: NOW
  };
  conversation.messages.push({
    id: "user-picture-2", role: "user", content: "Look at this.", status: "done", createdAt: NOW,
    metadata: { imageAttachments: [attachment] }
  } as any);
  const { service } = testService({ conversation });
  service.setMachineLink({
    fetchAttachment: async () => { throw new Error("The desktop did not answer with this picture in time."); }
  } as any);
  // The desktop was asked and could not supply it: the picture is not lost,
  // so the member is told what happened rather than to ask for a resend.
  await assert.rejects(
    service.readChatAttachment({ conversationId: conversation.id, attachmentId: attachment.id }),
    (error: Error) => /AttachmentUnavailable/.test(error.message)
      && error.message.includes("The desktop did not answer with this picture in time.")
      && error.message.includes("do not ask for a resend")
  );
});
