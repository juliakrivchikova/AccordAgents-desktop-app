import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { ChatImageAttachment, Conversation, ExportChatAttachmentRequest } from "../../../../shared/types";
import { CHAT_IMAGE_EXTENSION_BY_MIME } from "./constants";
import { isPathInside } from "../choices/mentions";
import { CHAT_CONTEXT_READ_DEFAULT_LIMIT } from "../constants";

export function normalizeChatAttachmentListRequest(raw: unknown): { messageId?: string; threadId?: string; limit: number } {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const messageId = typeof record.messageId === "string" && record.messageId.trim() ? record.messageId.trim() : undefined;
  const threadId = typeof record.threadId === "string" && record.threadId.trim() ? record.threadId.trim() : undefined;
  const rawLimit = typeof record.limit === "number" ? record.limit : CHAT_CONTEXT_READ_DEFAULT_LIMIT;
  return {
    messageId,
    threadId,
    limit: Math.min(100, Math.max(1, Math.floor(rawLimit)))
  };
}

export function normalizeChatAttachmentReadRequest(raw: unknown): { attachmentId: string } {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const attachmentId = typeof record.attachmentId === "string" ? record.attachmentId.trim() : "";
  if (!attachmentId) {
    throw new Error("AttachmentReadDenied. Problem: attachmentId is required. Cause: the read request did not include an attachmentId. Fix: call app_chat_list_attachments and pass one returned attachmentId.");
  }
  return { attachmentId };
}

export function normalizeChatAttachmentExportRequest(raw: unknown): ExportChatAttachmentRequest & { overwrite: boolean } {
  const attachment = normalizeChatAttachmentReadRequest(raw);
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const targetPath = normalizeChatAttachmentExportTargetPath(record.targetPath);
  if (!targetPath) {
    throw new Error(
      "AttachmentExportDenied. Problem: targetPath must be a repository-relative file path. Cause: the export request omitted targetPath, used an absolute path, used path traversal, or used an invalid path separator. Fix: pass a path like \"screenshots/image.png\"."
    );
  }
  return {
    attachmentId: attachment.attachmentId,
    targetPath,
    overwrite: record.overwrite === true
  };
}

function normalizeChatAttachmentExportTargetPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\\") || trimmed.startsWith("/") || trimmed.endsWith("/")) {
    return undefined;
  }
  if (trimmed.split("/").includes("..")) {
    return undefined;
  }
  const normalized = path.posix.normalize(trimmed);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) {
    return undefined;
  }
  return normalized;
}

export async function resolveAttachmentExportTarget(
  conversation: Conversation,
  attachment: ChatImageAttachment,
  request: ExportChatAttachmentRequest
): Promise<{ absolutePath: string; relativePath: string }> {
  if (!conversation.repoPath) {
    throw new Error(
      "AttachmentExportDenied. Problem: no repository is selected for this chat. Cause: attachment export only writes inside the selected repository. Fix: select a repository for the chat, then retry."
    );
  }
  validateAttachmentExportExtension(attachment, request.targetPath);
  let repoRealPath: string;
  try {
    repoRealPath = await realpath(conversation.repoPath);
  } catch {
    throw new Error(
      "AttachmentExportDenied. Problem: the selected repository could not be resolved. Cause: the repository path is missing or inaccessible. Fix: select an existing repository, then retry."
    );
  }
  const repoRoot = path.resolve(conversation.repoPath);
  const absolutePath = path.resolve(repoRoot, request.targetPath);
  if (!isPathInside(repoRoot, absolutePath)) {
    throw new Error(
      "AttachmentExportDenied. Problem: targetPath escapes the selected repository. Cause: the export path resolves outside the repository root. Fix: pass a repository-relative path inside the selected repository."
    );
  }

  const parentPath = path.dirname(absolutePath);
  let parentRealPath: string;
  try {
    parentRealPath = await realpath(parentPath);
  } catch {
    throw new Error(
      "AttachmentExportDenied. Problem: the target directory does not exist. Cause: attachment export v1 requires an existing parent directory. Fix: create the directory inside the repository, then retry."
    );
  }
  if (!isPathInside(repoRealPath, parentRealPath)) {
    throw new Error(
      "AttachmentExportDenied. Problem: targetPath escapes the selected repository. Cause: the target directory resolves through a symlink outside the repository. Fix: choose a real directory inside the repository."
    );
  }

  await assertAttachmentExportTargetWritable(absolutePath, request.targetPath, request.overwrite === true);
  return {
    absolutePath,
    relativePath: path.relative(repoRoot, absolutePath).split(path.sep).join(path.posix.sep)
  };
}

function validateAttachmentExportExtension(attachment: ChatImageAttachment, targetPath: string): void {
  const extension = path.posix.extname(targetPath).toLowerCase().replace(/^\./, "");
  const allowed = attachment.mimeType === "image/jpeg"
    ? ["jpg", "jpeg"]
    : [CHAT_IMAGE_EXTENSION_BY_MIME[attachment.mimeType]];
  if (!allowed.includes(extension)) {
    throw new Error(
      `AttachmentExportDenied. Problem: targetPath extension does not match the attachment type. Cause: ${attachment.mimeType} attachments must be written with ${allowed.map((item) => `.${item}`).join(" or ")}. Fix: choose a matching file extension.`
    );
  }
}

export async function assertAttachmentExportTargetWritable(absolutePath: string, targetPath: string, overwrite: boolean): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new Error(
      `AttachmentExportDenied. Problem: targetPath could not be inspected. Cause: ${error instanceof Error ? error.message : String(error)}. Fix: choose a writable file path inside the selected repository.`
    );
  }
  if (info.isSymbolicLink()) {
    throw new Error(
      "AttachmentExportDenied. Problem: targetPath points to a symlink. Cause: overwriting symlinks could escape the selected repository. Fix: choose a regular file path inside the selected repository."
    );
  }
  if (info.isDirectory()) {
    throw new Error(
      "AttachmentExportDenied. Problem: targetPath points to a directory. Cause: attachment export needs a file path, not a directory. Fix: include a filename such as \"image.png\"."
    );
  }
  if (!info.isFile()) {
    throw new Error(
      "AttachmentExportDenied. Problem: targetPath points to an unsupported filesystem entry. Cause: attachment export can only overwrite regular files. Fix: choose a regular file path inside the selected repository."
    );
  }
  if (!overwrite) {
    throw new Error(
      `AttachmentExportDenied. Problem: ${targetPath} already exists. Cause: overwrite was not enabled. Fix: choose a different targetPath or retry with overwrite set to true.`
    );
  }
}
