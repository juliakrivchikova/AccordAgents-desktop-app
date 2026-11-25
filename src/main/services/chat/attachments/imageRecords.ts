import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ChatAgentPermissions, ChatImageAttachment, ChatImageMimeType, ChatMessage, Conversation } from "../../../../shared/types";
import type { ChatAttachmentImportSource } from "./types";
import type { ChatAppMcpActor, ChatAttachmentImportSourceRoot } from "../types";

interface ChatAttachmentRecord {
  message: ChatMessage;
  sequence: number;
  attachment: ChatImageAttachment;
}

const CHAT_IMAGE_MIME_TYPES: ChatImageMimeType[] = ["image/png", "image/jpeg", "image/webp"];

export function imageAttachments(message: ChatMessage): ChatImageAttachment[] {
  const seen = new Set<string>();
  const attachments: ChatImageAttachment[] = [];
  for (const attachment of message.metadata?.imageAttachments ?? []) {
    if (!isStoredChatImageAttachment(attachment) || seen.has(attachment.id)) {
      continue;
    }
    seen.add(attachment.id);
    attachments.push(attachment);
  }
  return attachments;
}

export function chatImageAttachmentForTool(attachment: ChatImageAttachment): Omit<ChatImageAttachment, "storageKey" | "hubBlob"> {
  const { storageKey: _storageKey, hubBlob: _hubBlob, ...safeAttachment } = attachment;
  return safeAttachment;
}

export function visibleImageAttachmentRecords(conversation: Conversation, actor: ChatAppMcpActor): ChatAttachmentRecord[] {
  const records: ChatAttachmentRecord[] = [];
  conversation.messages.forEach((message, sequence) => {
    if (typeof actor.snapshotMaxSequence === "number" && sequence > actor.snapshotMaxSequence) {
      return;
    }
    for (const attachment of imageAttachments(message)) {
      records.push({ message, sequence, attachment });
    }
  });
  return records;
}

export function findImageAttachmentRecord(conversation: Conversation, attachmentId: string): ChatAttachmentRecord | undefined {
  const normalizedId = attachmentId.trim();
  for (const [sequence, message] of conversation.messages.entries()) {
    const attachment = imageAttachments(message).find((item) => item.id === normalizedId);
    if (attachment) {
      return { message, sequence, attachment };
    }
  }
  return undefined;
}

export async function chatAttachmentImportRoots(
  conversation: Conversation,
  runPermissions: ChatAgentPermissions
): Promise<Array<{ root: ChatAttachmentImportSourceRoot; rootPath: string; realPath: string }>> {
  const roots: Array<{ root: ChatAttachmentImportSourceRoot; rootPath: string; realPath: string }> = [];
  const addRoot = async (root: ChatAttachmentImportSourceRoot, rootPath: string | undefined): Promise<void> => {
    if (!rootPath) {
      return;
    }
    const normalizedRootPath = path.resolve(rootPath);
    const realRoot = await realpath(rootPath).catch(() => undefined);
    if (!realRoot || roots.some((item) => item.realPath === realRoot)) {
      return;
    }
    roots.push({ root, rootPath: normalizedRootPath, realPath: realRoot });
  };

  if (runPermissions.repoRead && conversation.repoPath) {
    await addRoot("repo", conversation.repoPath);
  }
  return roots;
}

export async function readFileWithMaxBytes(source: ChatAttachmentImportSource, maxBytes: number): Promise<Buffer> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(source.realPath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    throw new Error(
      `AttachmentImportDenied. Problem: sourcePath could not be opened safely. Cause: ${error instanceof Error ? error.message : String(error)}. Fix: pass a stable regular image file inside the selected repository.`
    );
  }

  try {
    const fileInfo = await file.stat();
    if (!fileInfo.isFile()) {
      throw new Error(
        "AttachmentImportDenied. Problem: sourcePath is not a regular file after opening. Cause: app_chat_send_message can import regular image files only. Fix: pass a PNG, JPEG, or WebP file."
      );
    }
    if (fileInfo.dev !== source.dev || fileInfo.ino !== source.ino) {
      throw new Error(
        "AttachmentImportDenied. Problem: sourcePath changed during import. Cause: the validated file is not the same file that would be read. Fix: retry with a stable image file inside the selected repository."
      );
    }
    if (fileInfo.size > maxBytes) {
      throw new Error(`ImageTooLarge. Problem: sourcePath is ${formatBytes(fileInfo.size)}. Cause: v1 accepts images up to ${formatBytes(maxBytes)}. Fix: crop or compress the image and try again.`);
    }

    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let totalBytes = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new Error(`ImageTooLarge. Problem: sourcePath grew beyond ${formatBytes(maxBytes)} while reading. Cause: the image file changed during import. Fix: retry with a stable file under the image size limit.`);
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }

    const afterInfo = await file.stat();
    if (afterInfo.dev !== source.dev || afterInfo.ino !== source.ino) {
      throw new Error(
        "AttachmentImportDenied. Problem: sourcePath changed during import. Cause: the validated file is not the same file that was read. Fix: retry with a stable image file inside the selected repository."
      );
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await file.close().catch(() => undefined);
  }
}

export function normalizeChatImageMimeType(value: string): ChatImageMimeType {
  const normalized = value.toLowerCase().trim();
  if (CHAT_IMAGE_MIME_TYPES.includes(normalized as ChatImageMimeType)) {
    return normalized as ChatImageMimeType;
  }
  throw new Error("UnsupportedImageType. Problem: this image type is not supported. Cause: v1 accepts PNG, JPEG, and WebP images only. Fix: paste or choose a PNG, JPEG, or WebP image.");
}

export function decodeImageInputBase64(value: string): Buffer {
  if (typeof value !== "string") {
    throw new Error("ImageDecodeFailed. Problem: image payload is invalid. Cause: the renderer did not send base64 image data. Fix: paste or choose the image again.");
  }
  const trimmed = value.trim();
  const withoutDataUrl = trimmed.replace(/^data:image\/(?:png|jpeg|jpg|webp);base64,/i, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(withoutDataUrl)) {
    throw new Error("ImageDecodeFailed. Problem: image payload is not valid base64. Cause: the pasted or selected image was not encoded correctly. Fix: paste or choose the image again.");
  }
  return Buffer.from(withoutDataUrl.replace(/\s/g, ""), "base64");
}

export function detectChatImageMimeType(bytes: Buffer): ChatImageMimeType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export function chatImageDimensions(bytes: Buffer, mimeType: ChatImageMimeType): { width: number; height: number } | undefined {
  if (mimeType === "image/png") {
    return pngImageDimensions(bytes);
  }
  if (mimeType === "image/jpeg") {
    return jpegImageDimensions(bytes);
  }
  return webpImageDimensions(bytes);
}

function pngImageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    return undefined;
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

function jpegImageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    if (offset + 2 > bytes.length) {
      break;
    }
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      break;
    }
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5)
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

function webpImageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const chunkType = bytes.length >= 16 ? bytes.subarray(12, 16).toString("ascii") : "";
  if (chunkType === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3)
    };
  }
  if (chunkType === "VP8 " && bytes.length >= 30) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff
    };
  }
  if (chunkType === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }
  return undefined;
}

export function normalizeChatImageFilename(filename: string | undefined, extension: string, index: number): string {
  const fallback = `image-${index + 1}.${extension}`;
  const base = typeof filename === "string" && filename.trim()
    ? path.basename(filename.trim()).replace(/[^\w .@()-]/g, "_").replace(/\s+/g, " ").slice(0, 120)
    : fallback;
  if (base.toLowerCase().endsWith(`.${extension}`) || (extension === "jpg" && base.toLowerCase().endsWith(".jpeg"))) {
    return base;
  }
  return `${base.replace(/\.[^.]+$/, "")}.${extension}`;
}

function isStoredChatImageAttachment(value: unknown): value is ChatImageAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<ChatImageAttachment>;
  return (
    typeof record.id === "string" &&
    typeof record.filename === "string" &&
    CHAT_IMAGE_MIME_TYPES.includes(record.mimeType as ChatImageMimeType) &&
    typeof record.sizeBytes === "number" &&
    typeof record.width === "number" &&
    typeof record.height === "number" &&
    typeof record.storageKey === "string" &&
    typeof record.createdAt === "string"
  );
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}
