import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import {
  defaultChatAgentPermissions, effectiveChatAgentPermissionsForProvider, normalizeChatAgentPermissions
} from "../../shared/agentPermissions";
import type { ChatImageAttachment } from "../../shared/types";
import { chatConversation, chatParticipant, NOW, ROLE, testService, userMessage } from "./chat/test/mentionFixtures";

const ONE_BY_ONE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("sendMessage persists image-only messages as metadata plus app-owned files", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-images-"));
  const participant = chatParticipant();
  const conversation = chatConversation([participant], "/repo");
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  chatParts(serviceAny).attachments.attachmentPath = (_conversationId: string, storageKey: string) => path.join(tempRoot, storageKey);

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
  chatParts(serviceAny).attachments.attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
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
  chatParts(serviceAny).attachments.attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
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
  chatParts(serviceAny).attachments.attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
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
